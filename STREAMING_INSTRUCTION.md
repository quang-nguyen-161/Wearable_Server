# STREAMING INSTRUCTION: Direct-to-ThingsBoard (ECG + Vitals)

> **Purpose:** Reference for the firmware streaming pipeline.
> Firmware posts ECG samples and vitals directly to ThingsBoard — no Vercel proxy needed.

---

## What already exists (do NOT recreate)

- `lib/thingsboard.js` — JWT auth + token cache (2hr TTL)
- `hooks/useTbWebSocket.js` — ThingsBoard WebSocket subscription hook
- `hooks/useNotifications.js` — Browser alerts + audio for criticals
- `hooks/useTrends.js` — Rolling trend arrows per vital
- `pages/api/telemetry/latest.js` — Proxies TB REST for latest values
- `pages/api/telemetry/history.js` — Proxies TB REST for historical range
- `components/VitalCard.js` — Card for HR / SpO2 / Temperature
- `components/TrendChart.js` — Recharts waveform chart
- `firmware/src/main.cpp` — ESP32 firmware (PlatformIO, Arduino framework)
- `scripts/test-mqtt-stream.js` — Node.js MQTT simulator

---

## Streaming pipeline overview

| Stream | Protocol | Data | Rate | Delivery |
|---|---|---|---|---|
| ECG waveform | **Direct to TB** (MQTT or device REST) | individual `ecg` samples | 100–250 Hz | Best-effort |
| Vital parameters | **MQTT gateway** → ThingsBoard | `ecgHeartRate`, `ppgHeartRate`, `spo2`, `temperature` | Every 1–30s | QoS 0 |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  ESP32 Device                                                │
│                                                              │
│  analogRead() @ 100–250Hz                                    │
│     │                                                        │
│     ├── unbatch & timestamp each sample                      │
│     │       │                           every vitalInterval  │
│     ▼       ▼                                   │            │
│  sendEcgSamples()                      sendVitals()         │
│       │                                        │             │
│  POST /api/v1/{token}/telemetry        MQTT gateway          │
│  [{ts, values:{ecg}}]                  v1/gateway/telemetry  │
└───────────────────┬────────────────────────────┬─────────────┘
                    │                            │
                    ▼                            ▼
        ┌───────────────────────────────────────────────┐
        │              ThingsBoard                       │
        │  Stores ecg + vitals as time-series            │
        │  WebSocket API → pushes to dashboard           │
        └───────────────────────┬───────────────────────┘
                                │ wss://
        ┌───────────────────────────────────────────────┐
        │   HealthMonitor Dashboard                      │
        │   useTbWebSocket ──▶ live ECG + vitals         │
        └───────────────────────────────────────────────┘
```

---

## Part 1 — ThingsBoard Configuration

### 1A — Device access token (for ECG direct post)

Each node device needs its own access token:

`Entities → Devices → Node1 → Manage Credentials → copy Access Token`

The ESP32 uses this token to post telemetry directly:
```
POST https://<TB_HOST>/api/v1/{ACCESS_TOKEN}/telemetry
Content-Type: application/json
Body: [{ "ts": 1716854400000, "values": { "ecg": 2048 } }, ...]
```

### 1B — MQTT Gateway Device (for vitals)

`Entities → Devices → + Add Device`
- Name: `wearable-gateway`
- Enable **Is gateway**: ON

Get access token: `Entities → Devices → wearable-gateway → Manage Credentials`

Paste into `firmware/src/main.cpp` → `GATEWAY_TOKEN`.

**MQTT gateway vitals format:**
```json
{
  "Node1": [{
    "ts": 1716854400000,
    "values": { "ecgHeartRate": 72.0, "ppgHeartRate": 71.0, "spo2": 98.5, "temperature": 36.6 }
  }]
}
```

### 1C — Alarm Rules

| Name | Condition | Severity |
|---|---|---|
| HIGH_ECG_HEART_RATE | ecgHeartRate > 130 | Critical |
| LOW_ECG_HEART_RATE  | ecgHeartRate < 40  | Critical |
| CRITICAL_LOW_SPO2   | spo2 < 88          | Critical |
| HIGH_TEMP           | temperature > 39.5 | Critical |
| LOW_TEMP            | temperature < 35   | Critical |

---

## Part 2 — ESP32 Firmware

### 2A — Configuration block

```cpp
const char* WIFI_SSID     = "YOUR_SSID";
const char* WIFI_PASSWORD = "YOUR_PASSWORD";

// ECG direct post — use each node's own device access token
const char* TB_HOST       = "c7.hust-2slab.org";
const char* DEVICE_TOKEN  = "YOUR_NODE_DEVICE_TOKEN";

// MQTT gateway — for vitals
const char* MQTT_HOST     = "c7.hust-2slab.org";
const int   MQTT_PORT     = 1883;
const char* GATEWAY_TOKEN = "YOUR_GATEWAY_ACCESS_TOKEN";
const char* GATEWAY_TOPIC = "v1/gateway/telemetry";

const char* NODE_NAME     = "Node1";

#define SAMPLE_RATE_HZ      250
#define VITAL_INTERVAL_MS   5000
```

### 2B — ECG direct post (firmware unbatches)

Firmware assigns per-sample timestamps before posting:
```cpp
// sampleTs = now - (n-1-i) * (1000 / SAMPLE_RATE_HZ) ms
String buildTelemetry(int* samples, int n, unsigned long batchTs) {
  String body = "[";
  for (int i = 0; i < n; i++) {
    unsigned long ts = batchTs - (n - 1 - i) * (1000 / SAMPLE_RATE_HZ);
    body += "{\"ts\":" + String(ts) + ",\"values\":{\"ecg\":" + String(samples[i]) + "}}";
    if (i < n - 1) body += ",";
  }
  return body + "]";
}
```

Post to ThingsBoard:
```cpp
POST https://<TB_HOST>/api/v1/<DEVICE_TOKEN>/telemetry
Content-Type: application/json
[{"ts":1716854400000,"values":{"ecg":2048}},...]
```

---

## Part 3 — Test Script

Run the MQTT simulator (requires `.env.local` with `TB_GATEWAY_ACCESS_TOKEN`):

```bash
node scripts/test-mqtt-stream.js
# or
node --env-file=.env.local scripts/test-mqtt-stream.js
```

The script publishes ECG batches and vitals for Node4/Node5/Node6 via MQTT gateway.

> **Note:** MQTT ports (1883, 8883, 8083) must be accessible from your machine.
> If blocked by firewall, run from inside the same network as the TB server.

---

## Part 4 — Tuning Parameters

| Parameter | File | Variable |
|---|---|---|
| Sample rate (Hz) | `firmware/src/main.cpp` | `SAMPLE_RATE_HZ` |
| Sample rate (Hz) | `scripts/test-mqtt-stream.js` | `SAMPLE_INTERVAL_MS = 1000/Hz` |
| Batch size | `firmware/src/main.cpp` | `BATCH_SIZE` |
| Vital interval | `firmware/src/main.cpp` | `VITAL_INTERVAL_MS` |
| Vital interval | `scripts/test-mqtt-stream.js` | `VITAL_INTERVAL_MS` |

---

## Part 5 — Critical Rules

| Rule | Reason |
|---|---|
| `isAnimationActive={false}` on live waveform charts | Animation at high Hz crashes browser tab |
| `mqtt.loop()` called every loop iteration | MQTT disconnects if not called |
| `micros()` for sampling timing | `delay()` drifts and blocks MQTT |
| Per-sample timestamp spacing must match `1000/Hz` ms | Wrong spacing = incorrect time-series in TB |
| All secrets in `.env.local` / Vercel env vars | Never hardcode credentials |
| `wss://` not `ws://` in production | Plain WS blocked on HTTPS pages |

---

## Deployment Checklist

```
Vercel environment variables:
  ✓ TB_BASE_URL
  ✓ TB_USERNAME
  ✓ TB_PASSWORD
  ✓ TB_DEVICE_ID
  ✓ NEXT_PUBLIC_TB_BASE_URL
  ✓ NEXT_PUBLIC_TB_DEVICE_ID
  ✓ NEXT_PUBLIC_TB_WS_URL

Firmware:
  ✓ DEVICE_TOKEN set per node
  ✓ GATEWAY_TOKEN set for vitals MQTT
  ✓ NODE_NAME matches ThingsBoard device name
  ✓ ecgHeartRate, ppgHeartRate, spo2, temperature visible in TB Latest Telemetry
  ✓ ecg visible as time-series in TB
```
