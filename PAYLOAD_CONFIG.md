# Payload & Config Reference

Cross-platform contract for the HealthMonitor pipeline.
**`gateway.py` (wearable_claude) is the canonical reference** — all other components must match it.

---

## System overview

```
nRF52832 peripheral (ECG node)
    │  BLE notify  (50 × int16, 100 bytes, every 200 ms)
    ▼
nRF52832 central (aggregator)
    │  UART (115200 baud, framed binary)
    ▼
ESP32  (firmware/src/main.cpp)
    │  MQTT  →  v1/gateway/telemetry
    ▼
ThingsBoard  (103.116.39.179 / c7.hust-2slab.org)
    │  WebSocket + REST
    ▼
Next.js dashboard  (wearable-server.vercel.app)
```

---

## 1. MQTT / HTTP telemetry topic & auth

| Platform | Transport | Topic / URL | Auth |
|---|---|---|---|
| `main.cpp` (ESP32) | MQTT TCP | `v1/gateway/telemetry` | username = `TB_GATEWAY_TOKEN` |
| `test-direct-stream.js` | MQTT TCP | `v1/gateway/telemetry` | username = `TB_GATEWAY_ACCESS_TOKEN` |
| `gateway.py` (HTTP) | HTTPS POST | `/api/v1/{device_token}/telemetry` | token in URL path |

---

## 2. ECG waveform payload  ← canonical

**Reference: `gateway.py` `post_worker()`**

```json
{
  "NodeName": [
    {
      "ts": 1700000000000,
      "values": {
        "ecg_batch": "[v0,v1,v2,...,v49]"
      }
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `NodeName` | string key | ThingsBoard device name, e.g. `"Node1"` |
| `ts` | integer | Unix epoch **milliseconds** |
| `ecg_batch` | **JSON-encoded string** | Array of `int16` samples; the whole array is serialised as a string |

### Per-platform implementation

#### `gateway.py` (reference)
```python
# on_notify — receives bytes from BLE
samples = list(struct.unpack_from(f"<{n_samples}h", data))
post_q.put_nowait(samples)

# post_worker — HTTP POST
combined = []
for b in batch_items:
    combined.extend(b)
body = {"ecg_batch": json.dumps(combined)}
session.post(f"{TB_URL}/api/v1/{device_token}/telemetry", json=body)
```

#### `main.cpp` (ESP32, MQTT)
```cpp
// UART RX: 50 × int16_t LE → nodeBatch[idx][]
// publish:
snprintf(payload, ..., "{\"%s\":[{\"ts\":%llu,\"values\":{\"ecg_batch\":\"[", name, ts);
for (int i = 0; i < BATCH_SIZE; i++) { ... snprintf("%d", nodeBatch[idx][i]); }
snprintf(payload, ... "]\"}}]}");
mqttClient.publish("v1/gateway/telemetry", payload, len);
```

#### `test-direct-stream.js`
```js
publish({
  [node.name]: [{
    ts:     Date.now(),
    values: { ecg_batch: JSON.stringify(samples) },   // ← string, not array
  }],
});
```

---

## 3. Vitals payload  ← canonical

**Reference: `gateway.py` — not directly published, but the key names are set by `main.cpp`**

```json
{
  "NodeName": [
    {
      "ts": 1700000000000,
      "values": {
        "ecgHeartRate":  87.8,
        "ppgHeartRate":  86.6,
        "spo2":          98.2,
        "temperature":   36.8
      }
    }
  ]
}
```

| Key | Unit | Type |
|---|---|---|
| `ecgHeartRate` | bpm | float, 1 decimal |
| `ppgHeartRate` | bpm | float, 1 decimal |
| `spo2` | % | float, 1 decimal |
| `temperature` | °C | float, 1 decimal |

### Per-platform implementation

#### `main.cpp` (ESP32)
```cpp
// UART RX: 4 × float LE → nodeHr, nodePpgHr, nodeSpo2, nodeTemp
snprintf(payload, ...,
  "{\"%s\":[{\"ts\":%llu,\"values\":{"
  "\"ecgHeartRate\":%.1f,\"ppgHeartRate\":%.1f,"
  "\"spo2\":%.1f,\"temperature\":%.1f}}]}",
  name, ts, nodeHr[i], nodePpgHr[i], nodeSpo2[i], nodeTemp[i]);
mqttClient.publish("v1/gateway/telemetry", payload, len);
```

#### `test-direct-stream.js`
```js
payload[node.name] = [{
  ts,
  values: {
    ecgHeartRate: ecgHr,
    ppgHeartRate: ppgHr,
    spo2:         round1(node.spo2Base),
    temperature:  round1(node.tempBase),
  },
}];
```

#### `gateway.py`
`gateway.py` publishes ECG only; vitals come from `main.cpp` (UART TYPE 0x02).

---

## 4. UART binary framing  (ESP32 ↔ nRF52832 central)

```
[0xAA][0x55][TYPE][NAME_LEN][NAME...][LEN_LO][LEN_HI][DATA...][XOR_CHK]
```

| Byte(s) | Field | Notes |
|---|---|---|
| `0xAA 0x55` | Magic | Start-of-frame |
| `TYPE` | Packet type | See table below |
| `NAME_LEN` | 1 byte | Length of the node name string |
| `NAME...` | `NAME_LEN` bytes | ASCII device name, e.g. `Node6` |
| `LEN_LO LEN_HI` | 2 bytes LE | Data payload length in bytes |
| `DATA...` | `LEN` bytes | Type-specific payload |
| `XOR_CHK` | 1 byte | XOR of all bytes from `TYPE` through last `DATA` byte |

### Packet types

| TYPE | Direction | DATA | Description |
|---|---|---|---|
| `0x01` | nRF→ESP32 | 50 × `int16_t` LE (100 bytes) | ECG batch |
| `0x02` | nRF→ESP32 | 4 × `float` LE (16 bytes): ecgHr, ppgHr, spo2, temp | Vitals |
| `0x03` | ESP32→nRF | 5 bytes: `[0xCF][freq_lo][freq_hi][interval_lo][interval_hi]` | ECG config |

### TYPE 0x03 DATA layout (ECG config)

```
Byte 0   : 0xCF  (ECG_CFG_CMD — matches gateway.py ECG_CFG_CMD)
Bytes 1–2: freq_hz    as uint16_t LE  (e.g. 0xFA 0x00 = 250)
Bytes 3–4: interval_ms as uint16_t LE (e.g. 0xC8 0x00 = 200)
```

The nRF52832 central receives TYPE 0x03 and forwards the 5-byte DATA directly
to the BLE node's RX characteristic (`6e401402-b5a3-f393-e0a9-e50e24dcca9e`).

---

## 5. ECG config (ThingsBoard shared attributes)

**Reference: `gateway.py` `fetch_ecg_settings()` / `send_ecg_config()`**

### ThingsBoard attribute keys

| Key | Type | Default | Description |
|---|---|---|---|
| `ecgSampleFreq` | integer | `250` | Sampling frequency in Hz |
| `ecgPacketInterval` | integer | `200` | BLE notify interval in ms (= batch_size / freq × 1000) |

### Config polling — per-platform

| Platform | Method | Interval | On change |
|---|---|---|---|
| `gateway.py` | `GET /api/v1/{token}/attributes?sharedKeys=…` | 3 s | BLE `write_request` to RX char |
| `main.cpp` (ESP32) | Same endpoint via `adminClient` (HTTPS) | 3 s (`CONFIG_SYNC_MS`) | UART TYPE 0x03 packet to nRF central |
| Dashboard (Next.js) | ThingsBoard shared-attribute write UI | On user action | Picked up by gateway at next poll |

### Config packet encoding (same on all platforms)

```python
# gateway.py
data = struct.pack('<BHH', 0xCF, freq_hz, interval_ms)  # 5 bytes
peripheral.write_request(SERVICE_UUID, RX_CHAR_UUID, data)
```

```cpp
// main.cpp — sendUartConfig()
uint8_t data[5] = { 0xCF,
  (uint8_t)(freq & 0xFF), (uint8_t)(freq >> 8),
  (uint8_t)(interval & 0xFF), (uint8_t)(interval >> 8) };
// wrapped in UART frame TYPE 0x03
```

The nRF52832 node interprets the 5-byte packet in its BLE RX handler:
```c
// main.c (nRF52832)
if (data[0] == 0xCF) {
  uint16_t freq_hz     = data[1] | ((uint16_t)data[2] << 8);
  uint16_t interval_ms = data[3] | ((uint16_t)data[4] << 8);
  // reconfigure SAADC timer and batch size
}
```

---

## 6. BLE UUIDs (nRF52832 ↔ nRF52832 central)

| UUID | Direction | Description |
|---|---|---|
| `6e401400-b5a3-f393-e0a9-e50e24dcca9e` | — | Primary service |
| `6e401401-b5a3-f393-e0a9-e50e24dcca9e` | node→central (notify) | ECG / PPG TX |
| `6e401402-b5a3-f393-e0a9-e50e24dcca9e` | central→node (write) | Config RX |

---

## 7. Batch timing reference

| Parameter | Value | Source |
|---|---|---|
| Sample rate | 250 Hz | `ecgSampleFreq` (default) |
| Batch size | 50 samples | `BATCH_SIZE` in main.cpp |
| Packet interval | 200 ms | `ecgPacketInterval` (default) |
| Samples per packet | 50 × int16 = 100 bytes BLE payload | |
| MQTT payload size | ~500 bytes (JSON + base overhead) | |

`batch_size = floor(freq_hz × interval_ms / 1000)` — all platforms must honour this.
