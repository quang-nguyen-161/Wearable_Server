# Payload & Config Reference

Cross-platform contract for the HealthMonitor pipeline.
`gateway.py` and `main.cpp` are the two canonical gateway implementations — all payload formats must match between them.

---

## 1. System architecture

The system has two parallel gateway paths. Both publish to the same ThingsBoard instance.

```
┌─────────────────────────────────────────────────────────────────┐
│  PATH A — Python gateway  (scripts/gateway.py)                  │
│                                                                  │
│  nRF52832 node(s)  ──BLE notify──►  gateway.py  ──MQTT──►  TB   │
│  nRF52832 node(s)  ◄──BLE write──  gateway.py  ◄──MQTT──   TB   │
│                                                                  │
│  • One thread per node, one shared MQTT connection               │
│  • Subscribes to TB SHARED_SCOPE attribute pushes               │
│  • Writes config/threshold cmds directly to BLE RX char         │
│  • BLE address & node_id managed from the dashboard             │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  PATH B — ESP32 firmware  (firmware/src/main.cpp)               │
│                                                                  │
│  nRF52832 node(s)  ──BLE──►  nRF52832 central                   │
│                                    │  UART 115200 baud           │
│                                    ▼                             │
│                                  ESP32  ──MQTT──►  TB            │
│                                  ESP32  ◄──HTTPS── TB            │
│                                    │  UART                       │
│                                    ▼                             │
│                             nRF52832 central ──BLE write──► node │
│                                                                  │
│  • Polls TB SHARED_SCOPE every 3 s via HTTPS per-node token     │
│  • Sends config via UART TYPE 0x03 / 0x04 to nRF central        │
│  • nRF central forwards BLE write to the target node            │
└─────────────────────────────────────────────────────────────────┘

                        ThingsBoard  (103.116.39.179 / c7.hust-2slab.org)
                              │  WebSocket + REST
                              ▼
                     Next.js dashboard  (wearable-server.vercel.app)
```

---

## 2. MQTT telemetry

Both gateways publish to the same broker and topic.

| Platform | Transport | Topic | Auth |
|---|---|---|---|
| `gateway.py` | MQTT TCP | `v1/gateway/telemetry` | username = `TB_GATEWAY_ACCESS_TOKEN` |
| `main.cpp` (ESP32) | MQTT TCP | `v1/gateway/telemetry` | username = `TB_GATEWAY_TOKEN` |
| `test-*.js` scripts | MQTT TCP | `v1/gateway/telemetry` | username = `TB_GATEWAY_ACCESS_TOKEN` |

---

## 3. ECG waveform payload

```json
{
  "NodeName": [
    {
      "ts": 1700000000000,
      "values": {
        "ecg_batch": "[v0,v1,v2,...,v49]",
        "node_id": 0
      }
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `NodeName` | string key | ThingsBoard device name, e.g. `"Node1"` |
| `ts` | integer | Unix epoch milliseconds |
| `ecg_batch` | **JSON-encoded string** | Array of `int16` samples; the array is serialised as a string |
| `node_id` | integer | 0-based index; identifies the source device for multi-node setups |

### `gateway.py`
```python
# on_notify callback
samples = list(struct.unpack_from(f'<{PACKET_SAMPLES}h', data))
publish_q.put_nowait((node.name, node.node_id, samples))

# publish_worker thread
node_name, node_id, samples = publish_q.get()
payload = { node_name: [{ 'ts': int(time.time()*1000),
                           'values': {'ecg_batch': json.dumps(samples), 'node_id': node_id} }] }
mqtt.publish('v1/gateway/telemetry', json.dumps(payload))
```

### `main.cpp` (ESP32)
```cpp
// UART RX: 50 × int16_t LE → nodeBatch[idx][]
snprintf(payload, ..., "{\"%s\":[{\"ts\":%llu,\"values\":{\"ecg_batch\":\"[", name, ts);
for (int i = 0; i < BATCH_SIZE; i++) { ... snprintf("%d", nodeBatch[idx][i]); }
snprintf(payload, ..., "]\",\"node_id\":%d}}]}", idx);
mqttClient.publish("v1/gateway/telemetry", payload, len);
```

---

## 4. Vitals payload

Published by `main.cpp` only (via UART TYPE 0x02 from nRF central).

```json
{
  "NodeName": [
    {
      "ts": 1700000000000,
      "values": {
        "ecgHeartRate":  87.8,
        "ppgHeartRate":  86.6,
        "spo2":          98.2,
        "temperature":   36.8,
        "node_id":       0
      }
    }
  ]
}
```

| Key | Unit | Type | Notes |
|---|---|---|---|
| `ecgHeartRate` | bpm | float, 1 decimal | — |
| `ppgHeartRate` | bpm | float, 1 decimal | — |
| `spo2` | % | float, 1 decimal | — |
| `temperature` | °C | float, 1 decimal | — |
| `node_id` | — | integer | 0-based index; identifies the source device for multi-node setups |

```cpp
// main.cpp — publishVitalPacket()
snprintf(payload, ...,
  "{\"%s\":[{\"ts\":%llu,\"values\":{"
  "\"ecgHeartRate\":%.1f,\"ppgHeartRate\":%.1f,"
  "\"spo2\":%.1f,\"temperature\":%.1f,\"node_id\":%d}}]}",
  name, ts, nodeHr[i], nodePpgHr[i], nodeSpo2[i], nodeTemp[i], idx);
mqttClient.publish("v1/gateway/telemetry", payload, len);
```

---

## 5. BLE UUIDs  (nRF52832 peripheral)

| UUID | Direction | Description |
|---|---|---|
| `6e401400-b5a3-f393-e0a9-e50e24dcca9e` | — | Primary service |
| `6e401401-b5a3-f393-e0a9-e50e24dcca9e` | node → gateway (notify) | ECG / PPG data TX |
| `6e401402-b5a3-f393-e0a9-e50e24dcca9e` | gateway → node (write) | Config / command RX |

---

## 6. BLE command sequence  (gateway → node)

All downlink commands share a common two-byte header before any payload:

```
[CMD]  [NODE_ID]  [...payload bytes]
 1 B     1 B          N bytes
```

| Byte | Field | Notes |
|---|---|---|
| `CMD` | Command type | `0xA0` / `0xCF` / `0xCE` (see table) |
| `NODE_ID` | uint8, 0-based | Assigned by gateway on connect; node validates before applying |
| `...payload` | N bytes | Command-specific; see layouts below |

### Command table

| CMD | Name | Total bytes | Payload after `[CMD][NODE_ID]` |
|---|---|---|---|
| `0xA0` | `CMD_ACK` | 6 | `[addr_b2][addr_b3][addr_b4][addr_b5][node_id]` — last 4 bytes of BLE MAC + assigned ID |
| `0xCF` | `CMD_ECG_CFG` | 6 | `[freq_lo][freq_hi][interval_lo][interval_hi]` (2 × uint16 LE) |
| `0xCE` | `CMD_THR` | 9 | `[ppgHrMin][ppgHrMax][ecgHrMin][ecgHrMax][spo2Min][tempMin][tempMax]` (7 × uint8) |

### CMD_ACK  `0xA0`  — connect acknowledgement

Sent once by the gateway immediately after BLE connection.  
The node can cross-check the embedded address against its own BLE MAC to confirm
the ACK is meant for it, then stores `node_id` for validating all subsequent commands.

```
[0xA0][addr_b2][addr_b3][addr_b4][addr_b5][node_id]   ← 6 bytes
        └── last 4 bytes of the 6-byte BLE MAC ──┘
```

```python
# gateway.py — NodeState.build_ack_payload()
addr_bytes = bytes(int(b, 16) for b in self.get_address().split(':'))
struct.pack('<6B', 0xA0, *addr_bytes[2:], node_id)
```
```c
// nRF52832 RX handler
if (data[0] == 0xA0 && len >= 6) {
    // optional: verify data[1..4] matches own BLE address bytes 2-5
    my_node_id = data[5];
}
```

### CMD_ECG_CFG  `0xCF`  — ECG sampling config

```
[0xCF][node_id][freq_lo][freq_hi][interval_lo][interval_hi]
```

| Byte(s) | Field | Example |
|---|---|---|
| 0 | `0xCF` | — |
| 1 | `node_id` | `0x00` |
| 2–3 | `freq_hz` uint16 LE | `0xFA 0x00` = 250 Hz |
| 4–5 | `interval_ms` uint16 LE | `0xC8 0x00` = 200 ms |

```python
# gateway.py
struct.pack('<2B2H', CMD_ECG_CFG, node_id, freq_hz, interval_ms)
```
```cpp
// main.cpp — sendUartConfig() → wraps in UART TYPE 0x03
uint8_t data[6] = { 0xCF, node_id,
  (uint8_t)(freq & 0xFF), (uint8_t)(freq >> 8),
  (uint8_t)(interval & 0xFF), (uint8_t)(interval >> 8) };
```
```c
// nRF52832 RX handler
if (data[0] == 0xCF && data[1] == my_node_id) {
    uint16_t freq_hz     = data[2] | ((uint16_t)data[3] << 8);
    uint16_t interval_ms = data[4] | ((uint16_t)data[5] << 8);
    // reconfigure SAADC timer and batch size
}
```

### CMD_THR  `0xCE`  — vital warning thresholds

```
[0xCE][node_id][ppgHrMin][ppgHrMax][ecgHrMin][ecgHrMax][spo2Min][tempMin][tempMax]
```

| Byte | Field | Unit | Example |
|---|---|---|---|
| 0 | `0xCE` | — | — |
| 1 | `node_id` | — | `0x01` |
| 2 | `ppgHr_warnMin` | bpm | `50` |
| 3 | `ppgHr_warnMax` | bpm | `120` |
| 4 | `ecgHr_warnMin` | bpm | `50` |
| 5 | `ecgHr_warnMax` | bpm | `120` |
| 6 | `spo2_warnMin` | % | `90` |
| 7 | `temp_warnMin` | °C | `35` |
| 8 | `temp_warnMax` | °C | `38` |

All values fit in `uint8_t` (max 255). Temperature in whole °C.

```python
# gateway.py — NodeState.build_threshold_payload()
struct.pack('<9B', CMD_THR, node_id,
    ppgHr_warnMin, ppgHr_warnMax,
    ecgHr_warnMin, ecgHr_warnMax,
    spo2_warnMin,
    temp_warnMin,  temp_warnMax)
```
```c
// nRF52832 RX handler
if (data[0] == 0xCE && data[1] == my_node_id) {
    uint8_t ppg_hr_min = data[2];  uint8_t ppg_hr_max = data[3];
    uint8_t ecg_hr_min = data[4];  uint8_t ecg_hr_max = data[5];
    uint8_t spo2_min   = data[6];
    uint8_t temp_min   = data[7];  uint8_t temp_max   = data[8];
    // update alert thresholds
}
```

---

## 7. BLE write commands  (gateway.py → nRF52832 peripheral)  — Path A only

Written directly to the RX characteristic (`6e401402-b5a3-f393-e0a9-e50e24dcca9e`) via
`peripheral.write_request()`. No transport framing — raw bytes only.

| CMD | Total bytes | Byte layout |
|---|---|---|
| `CMD_ACK (0xA0)` | 6 | `[0xA0][addr_b2][addr_b3][addr_b4][addr_b5][node_id]` |
| `CMD_ECG_CFG (0xCF)` | 6 | `[0xCF][node_id][freq_lo][freq_hi][interval_lo][interval_hi]` |
| `CMD_THR (0xCE)` | 9 | `[0xCE][node_id][ppgHrMin][ppgHrMax][ecgHrMin][ecgHrMax][spo2Min][tempMin][tempMax]` |

`addr_b2..b5` = bytes at index 2–5 of the node's 6-byte BLE MAC address.  
The nRF52832 peripheral verifies `addr_b2..b5` against its own MAC before accepting `node_id`.

---

## 8. UART binary framing  (ESP32 ↔ nRF52832 central)  — Path B only

```
[0xAA][0x55][TYPE][NAME_LEN][NAME...][LEN_LO][LEN_HI][DATA...][XOR_CHK]
```

| Byte(s) | Field | Notes |
|---|---|---|
| `0xAA 0x55` | Magic | Start-of-frame |
| `TYPE` | Packet type | See table |
| `NAME_LEN` | 1 byte | Length of ASCII node name |
| `NAME...` | `NAME_LEN` bytes | e.g. `Node1` |
| `LEN_LO LEN_HI` | 2 bytes LE | DATA length in bytes |
| `DATA...` | `LEN` bytes | Type-specific (same BLE command bytes) |
| `XOR_CHK` | 1 byte | XOR of all bytes from `TYPE` through last `DATA` byte |

| TYPE | Direction | DATA | Description |
|---|---|---|---|
| `0x01` | nRF→ESP32 | 100 bytes: 50 × `int16_t` LE | ECG batch |
| `0x02` | nRF→ESP32 | 16 bytes: 4 × `float` LE (ecgHr, ppgHr, spo2, temp) | Vitals |
| `0x03` | ESP32→nRF | 6 bytes: `CMD_ECG_CFG` frame | ECG config → forwarded to BLE RX char |
| `0x04` | ESP32→nRF | 9 bytes: `CMD_THR` frame | Thresholds → forwarded to BLE RX char |
| `0x05` | ESP32→nRF | 6 bytes: `CMD_ACK` frame | Connect ACK → forwarded to BLE RX char |

The nRF52832 central forwards the DATA bytes of TYPE 0x03 / 0x04 / 0x05 directly to the target node's RX characteristic, matched by the NAME field.  
The DATA bytes are **identical** to the raw BLE write payloads in section 7 — Path A and Path B deliver the same bytes to the nRF52832 peripheral, ensuring full command parity.

---

## 9. ThingsBoard shared attributes  (SHARED_SCOPE per node)

Written by the dashboard (`pages/settings.js`). Read by both gateways to configure the device.

| Key | Type | Default | Description | Forwarded as |
|---|---|---|---|---|
| `bleAddress` | string | from `.env.local` | nRF52832 BLE MAC address | triggers reconnect |
| `ecgSampleFreq` | integer | `250` | ECG ADC sample rate (Hz) | `CMD_ECG_CFG` |
| `ecgPacketInterval` | integer | `200` | BLE notify interval (ms) | `CMD_ECG_CFG` |
| `ppgHr_warnMin` | integer | `50` | PPG HR warning lower bound (bpm) | `CMD_THR` byte 2 |
| `ppgHr_warnMax` | integer | `120` | PPG HR warning upper bound (bpm) | `CMD_THR` byte 3 |
| `ecgHr_warnMin` | integer | `50` | ECG HR warning lower bound (bpm) | `CMD_THR` byte 4 |
| `ecgHr_warnMax` | integer | `120` | ECG HR warning upper bound (bpm) | `CMD_THR` byte 5 |
| `spo2_warnMin` | integer | `90` | SpO₂ warning lower bound (%) | `CMD_THR` byte 6 |
| `temp_warnMin` | integer | `35` | Temperature warning lower bound (°C) | `CMD_THR` byte 7 |
| `temp_warnMax` | integer | `38` | Temperature warning upper bound (°C) | `CMD_THR` byte 8 |

### How gateway.py receives attribute changes

On MQTT connect, `gateway.py` requests all shared keys for every node:
```python
# publishes to v1/gateway/attributes/request for each key
{"id": <req_id>, "device": "Node1", "client": false, "key": "ppgHr_warnMin"}
```

TB pushes live changes to `v1/gateway/attributes`:
```json
{"device": "Node1", "data": {"ppgHr_warnMin": 45, "temp_warnMax": 39}}
```

The `mqtt_on_message` handler routes the update to the correct `NodeState` by device name,
rebuilds the threshold payload, and enqueues it on that node's `cmd_q` for the BLE worker thread to write.

### How main.cpp receives attribute changes

`configSyncTask` polls every 3 s via HTTPS using the per-node device access token:
```
GET /api/v1/{node_token}/attributes?sharedKeys=ecgSampleFreq,ecgPacketInterval,...
```
On change, sends a UART TYPE 0x03 / 0x04 frame to the nRF52832 central.

---

## 9. gateway.py multi-node config

```
NODE_LIST=Node1:e5:39:e6:e4:d1:e8,Node2:aa:bb:cc:dd:ee:ff
```

- Each entry is `NodeName:BLE_ADDR`. Split on the first `:` only (MAC has its own colons).
- `node_id` is assigned by position: `Node1` → 0, `Node2` → 1, …
- IDs are stable as long as `NODE_LIST` order is stable.
- Falls back to `TB_NODE_NAME` + `BLE_ADDRESS` if `NODE_LIST` is not set.

One BLE worker thread per node; all share one MQTT connection and one `publish_q`.
A `_scan_lock` ensures only one thread calls `adapter.scan_for()` at a time.

---

## 10. Batch timing reference

| Parameter | Value | Source |
|---|---|---|
| Sample rate | 250 Hz | `ecgSampleFreq` (default) |
| Batch size | 50 samples | `PACKET_SAMPLES` / `BATCH_SIZE` |
| Packet interval | 200 ms | `ecgPacketInterval` (default) |
| BLE payload | 100 bytes (50 × int16) | — |
| MQTT payload | ~500 bytes (JSON overhead) | — |

`batch_size = floor(freq_hz × interval_ms / 1000)` — all platforms must honour this.
