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
| `0xCD` | `CMD_PPG_CFG` | 6 | `[sampleFreqLo][sampleFreqHi][redMa][irMa]` (uint16 LE + 2 × uint8) |
| `0xCC` | `CMD_VITAL_CFG` | 4 | `[intervalLo][intervalHi]` (uint16 LE, ms) |
| `0xCE` | `CMD_THR` | **32** | see expanded layout below |

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

### CMD_THR  `0xCE`  — vital thresholds (all 3 tiers)

**32 bytes total** — 3 tiers (normal / warning / dangerous) × 4 vitals × min+max.  
Temperature is encoded as `uint16 LE × 10` to preserve 0.1 °C resolution.

```
[0]   0xCE
[1]   node_id
[2]   ppgHr_normalMin   [3]  ppgHr_normalMax    (uint8 bpm)
[4]   ppgHr_warnMin     [5]  ppgHr_warnMax
[6]   ppgHr_dangerMin   [7]  ppgHr_dangerMax
[8]   ecgHr_normalMin   [9]  ecgHr_normalMax    (uint8 bpm)
[10]  ecgHr_warnMin     [11] ecgHr_warnMax
[12]  ecgHr_dangerMin   [13] ecgHr_dangerMax
[14]  spo2_normalMin    [15] spo2_normalMax      (uint8 %)
[16]  spo2_warnMin      [17] spo2_warnMax
[18]  spo2_dangerMin    [19] spo2_dangerMax
[20-21] temp_normalMin  [22-23] temp_normalMax   (uint16 LE ×10, e.g. 361 = 36.1°C)
[24-25] temp_warnMin    [26-27] temp_warnMax
[28-29] temp_dangerMin  [30-31] temp_dangerMax
```

```python
# gateway.py — NodeState.build_threshold_payload()
struct.pack('<BB18B6H',
    CMD_THR, node_id,
    ppgHr_normalMin, ppgHr_normalMax, ppgHr_warnMin, ppgHr_warnMax, ppgHr_dangerMin, ppgHr_dangerMax,
    ecgHr_normalMin, ecgHr_normalMax, ecgHr_warnMin, ecgHr_warnMax, ecgHr_dangerMin, ecgHr_dangerMax,
    spo2_normalMin,  spo2_normalMax,  spo2_warnMin,  spo2_warnMax,  spo2_dangerMin,  spo2_dangerMax,
    temp_normalMin,  temp_normalMax,  temp_warnMin,  temp_warnMax,  temp_dangerMin,  temp_dangerMax,
    # temp values stored ×10: 36.1°C → 361
)
```
```c
// nRF52832 RX handler (cmd.c)
if (data[0] == 0xCE && data[1] == my_node_id) {
    g_thr_ppg_norm_min = data[2];  g_thr_ppg_norm_max = data[3];
    g_thr_ppg_warn_min = data[4];  g_thr_ppg_warn_max = data[5];
    g_thr_ppg_dang_min = data[6];  g_thr_ppg_dang_max = data[7];
    g_thr_ecg_norm_min = data[8];  g_thr_ecg_norm_max = data[9];
    g_thr_ecg_warn_min = data[10]; g_thr_ecg_warn_max = data[11];
    g_thr_ecg_dang_min = data[12]; g_thr_ecg_dang_max = data[13];
    g_thr_spo2_norm_min= data[14]; g_thr_spo2_norm_max= data[15];
    g_thr_spo2_warn_min= data[16]; g_thr_spo2_warn_max= data[17];
    g_thr_spo2_dang_min= data[18]; g_thr_spo2_dang_max= data[19];
    g_thr_temp_norm_min= (uint16_t)(data[20] | (data[21]<<8));
    g_thr_temp_norm_max= (uint16_t)(data[22] | (data[23]<<8));
    g_thr_temp_warn_min= (uint16_t)(data[24] | (data[25]<<8));
    g_thr_temp_warn_max= (uint16_t)(data[26] | (data[27]<<8));
    g_thr_temp_dang_min= (uint16_t)(data[28] | (data[29]<<8));
    g_thr_temp_dang_max= (uint16_t)(data[30] | (data[31]<<8));
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
| `CMD_THR (0xCE)` | 32 | `[0xCE][node_id][18×uint8 PPG/ECG/SpO2 norm/warn/dang min+max][6×uint16LE temp×10]` |
| `CMD_PPG_CFG (0xCD)` | 6 | `[0xCD][node_id][sampleFreqLo][sampleFreqHi][redMa][irMa]` |
| `CMD_VITAL_CFG (0xCC)` | 4 | `[0xCC][node_id][intervalLo][intervalHi]` |

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

Written by the dashboard (`pages/settings.js`). Read by gateways and the dashboard to configure the device.

The complete uplink payload (all keys saved on every settings save):

```json
{
  "vitalInterval": 1000,
  "ecgSampleFreq": 250, "ecgPacketInterval": 500,
  "ppgSampleFreq": 100, "ppgRedLedMa": 6, "ppgIrLedMa": 6,
  "ppgHr_normalMin": 60,  "ppgHr_normalMax": 100,
  "ppgHr_warnMin":   50,  "ppgHr_warnMax":  120,
  "ppgHr_dangerMin": 40,  "ppgHr_dangerMax": 130,
  "ecgHr_normalMin": 60,  "ecgHr_normalMax": 100,
  "ecgHr_warnMin":   50,  "ecgHr_warnMax":  120,
  "ecgHr_dangerMin": 40,  "ecgHr_dangerMax": 130,
  "spo2_normalMin":  95,  "spo2_normalMax":  100,
  "spo2_warnMin":    90,  "spo2_warnMax":    100,
  "spo2_dangerMin":  88,  "spo2_dangerMax":  100,
  "temp_normalMin":  36.1,"temp_normalMax":  37.2,
  "temp_warnMin":    35.5,"temp_warnMax":    38.5,
  "temp_dangerMin":  35.0,"temp_dangerMax":  39.5
}
```

### Key reference

| Key | Default | Description | gateway.py | main.cpp |
|---|---|---|---|---|
| `bleAddress` | from `.env.local` | nRF52832 BLE MAC | reconnect | — |
| `vitalInterval` | `1000` ms | How often the node reports vitals | — | configures timer |
| `ecgSampleFreq` | `250` Hz | ADC sampling rate | — | `CMD_ECG_CFG` |
| `ecgPacketInterval` | `500` ms | BLE notify interval | — | `CMD_ECG_CFG` |
| `ppgSampleFreq` | `100` Hz | MAX30102 sample rate | — | configures sensor |
| `ppgRedLedMa` | `6` mA | Red LED drive current | — | configures sensor |
| `ppgIrLedMa` | `6` mA | IR LED drive current | — | configures sensor |
| `ppgHr_normalMin/Max` | 60 / 100 bpm | PPG HR normal band | `CMD_THR` bytes 2–3 | `CMD_THR` |
| `ppgHr_warnMin/Max` | 50 / 120 bpm | PPG HR warning band | `CMD_THR` bytes 4–5 | `CMD_THR` |
| `ppgHr_dangerMin/Max` | 40 / 130 bpm | PPG HR danger band | `CMD_THR` bytes 6–7 | `CMD_THR` |
| `ecgHr_normalMin/Max` | 60 / 100 bpm | ECG HR normal band | `CMD_THR` bytes 8–9 | `CMD_THR` |
| `ecgHr_warnMin/Max` | 50 / 120 bpm | ECG HR warning band | `CMD_THR` bytes 10–11 | `CMD_THR` |
| `ecgHr_dangerMin/Max` | 40 / 130 bpm | ECG HR danger band | `CMD_THR` bytes 12–13 | `CMD_THR` |
| `spo2_normalMin/Max` | 95 / 100 % | SpO₂ normal band | `CMD_THR` bytes 14–15 | `CMD_THR` |
| `spo2_warnMin/Max` | 90 / 100 % | SpO₂ warning band | `CMD_THR` bytes 16–17 | `CMD_THR` |
| `spo2_dangerMin/Max` | 88 / 100 % | SpO₂ danger band | `CMD_THR` bytes 18–19 | `CMD_THR` |
| `temp_normalMin/Max` | 36.1 / 37.2 °C | Temp normal band (→ ×10: 361/372) | `CMD_THR` bytes 20–23 | `CMD_THR` |
| `temp_warnMin/Max` | 35.5 / 38.5 °C | Temp warning band (→ ×10: 355/385) | `CMD_THR` bytes 24–27 | `CMD_THR` |
| `temp_dangerMin/Max` | 35.0 / 39.5 °C | Temp danger band (→ ×10: 350/395) | `CMD_THR` bytes 28–31 | `CMD_THR` |

> All 24 threshold keys are forwarded by `gateway.py` via a single `CMD_THR` write on every push.  
> Temperature is stored in TB as float (°C) and packed as `uint16 LE × 10` in the BLE frame — `round(v * 10)` in the gateway, divide by 10 in firmware.

### How gateway.py receives attribute changes

On MQTT connect:
1. Sends `v1/gateway/connect` for each node so TB routes attribute pushes to this gateway.
2. Requests current values for `bleAddress` + 7 warn threshold keys:
```python
{"id": <req_id>, "device": "Node1", "client": false, "key": "ppgHr_warnMin"}
```

TB pushes live changes whenever the settings page saves to `v1/gateway/attributes`:
```json
{"device": "Node1", "data": {"ppgHr_warnMin": 45, "temp_warnMax": 39, ...}}
```

`mqtt_on_message` routes the update to the correct `NodeState` by device name, updates in-memory thresholds, and enqueues a `CMD_THR` BLE write. The push always triggers a BLE write (no stale-value suppression).

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
