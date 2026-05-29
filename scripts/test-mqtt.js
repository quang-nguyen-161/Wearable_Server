// simulate-nodes.js
// ECG/PPG strategy:
//   - Each batch of 20 samples is published as a JSON-encoded array
//     stored in a SINGLE telemetry key "ecgBatch" / "ppgBatch"
//   - Each entry in the array has its own timestamp
//   - The dashboard reads these batches and unpacks them client-side
//   - This avoids TB rate limits and aggregation destroying the waveform
//
// Vitals (HR, SpO2, Temp) are published normally as individual keys.
//
// Run: node simulate-nodes.js

const mqtt = require("mqtt");

const GATEWAY_TOKEN     = "4o51ajerynq34mtosc26";
const TB_HOST           = "mqtt://c7.hust-2slab.org";
const SAMPLES_PER_BATCH = 5;    // samples per publish
const PUBLISH_INTERVAL  = 100;  // ms — TB Cloud free tier needs ≥100ms between publishes
const SAMPLE_INTERVAL   = PUBLISH_INTERVAL / SAMPLES_PER_BATCH; // 20ms = 50Hz effective

// ── Node profiles ────────────────────────────────────────────────────────
const NODES = {
  Node1: { hr: { base:72, drift:8, min:55, max:110 }, spo2: { base:98.5, drift:1.5, min:94, max:100 }, temp: { base:36.6, drift:0.4, min:36, max:37.5 }, ecgPhase:0,   ppgPhase:0   },
  Node2: { hr: { base:88, drift:12,min:60, max:120 }, spo2: { base:97.2, drift:2,   min:93, max:100 }, temp: { base:37.1, drift:0.5, min:36.5,max:38.5}, ecgPhase:1.2, ppgPhase:0.8 },
  Node3: { hr: { base:65, drift:6, min:50, max:95  }, spo2: { base:99.0, drift:1,   min:95, max:100 }, temp: { base:36.3, drift:0.3, min:35.8,max:37  }, ecgPhase:2.4, ppgPhase:1.6 },
};

function ecgSample(phase) {
  const t = phase % (2 * Math.PI);
  return parseFloat((
    0.15 * Math.exp(-Math.pow(t-0.8,  2)/0.04)  +
   -0.10 * Math.exp(-Math.pow(t-1.4,  2)/0.002) +
    1.00 * Math.exp(-Math.pow(t-1.57, 2)/0.001) +
   -0.30 * Math.exp(-Math.pow(t-1.7,  2)/0.002) +
    0.30 * Math.exp(-Math.pow(t-2.5,  2)/0.1)   +
    (Math.random()-0.5)*0.02
  ).toFixed(4));
}

function ppgSample(phase) {
  const t = phase % (2 * Math.PI);
  return parseFloat(Math.max(0,
    0.8 * Math.exp(-Math.pow(t-1.2, 2)/0.08) +
    0.2 * Math.exp(-Math.pow(t-2.2, 2)/0.06) +
    (Math.random()-0.5)*0.01
  ).toFixed(4));
}

function drift(v, p) {
  return parseFloat(Math.min(p.max, Math.max(p.min, v + (Math.random()-0.5)*p.drift*0.05)).toFixed(1));
}

const ECG_SPEED = (2*Math.PI) / (1000/SAMPLE_INTERVAL*0.8);
const PPG_SPEED = (2*Math.PI) / (1000/SAMPLE_INTERVAL*0.9);

const state = {};
for (const [n, p] of Object.entries(NODES)) {
  state[n] = { hr: p.hr.base, spo2: p.spo2.base, temp: p.temp.base, ecgPhase: p.ecgPhase, ppgPhase: p.ppgPhase };
}

let tick = 0;

const client = mqtt.connect(TB_HOST, { username: GATEWAY_TOKEN, clean: true, reconnectPeriod: 3000 });

client.on("connect", () => {
  console.log("✅ Connected\n");
  client.publish(
    "v1/gateway/connect",
    JSON.stringify(Object.fromEntries(Object.keys(NODES).map(n => [n, { type:"default" }]))),
    {},
    () => {
      console.log(`📡 Registered: ${Object.keys(NODES).join(", ")}`);
      console.log(`🔄 ${SAMPLES_PER_BATCH} samples/batch, ${PUBLISH_INTERVAL}ms interval, ${1000/SAMPLE_INTERVAL}Hz effective\n`);
      startLoop();
    }
  );
});

function startLoop() {
  setInterval(() => {
    tick++;
    const payload = {};
    const now = Date.now();

    for (const [nodeName, profile] of Object.entries(NODES)) {
      const s = state[nodeName];

      // Drift vitals every ~1s (every 10 ticks at 100ms)
      if (tick % 10 === 0) {
        s.hr   = drift(s.hr,   profile.hr);
        s.spo2 = drift(s.spo2, profile.spo2);
        s.temp = drift(s.temp, profile.temp);
      }

      // Build samples array in native TB Gateway format:
      // [{ts, values: {ecg, ppg}}, {ts, values: {ecg, ppg}}, ...]
      // TB stores each entry as a separate time-series record.
      const samples = [];

      for (let i = 0; i < SAMPLES_PER_BATCH; i++) {
        const ts = now - (SAMPLES_PER_BATCH - 1 - i) * SAMPLE_INTERVAL;
        s.ecgPhase += ECG_SPEED;
        s.ppgPhase += PPG_SPEED;

        const entry = {
          ts,
          values: {
            ecg: ecgSample(s.ecgPhase),
            ppg: ppgSample(s.ppgPhase),
          },
        };

        // Attach vitals only to the first sample of each batch
        if (i === 0) {
          entry.values.heartRate   = s.hr;
          entry.values.spo2        = s.spo2;
          entry.values.temperature = s.temp;
        }

        samples.push(entry);
      }

      payload[nodeName] = samples;
    }

    client.publish("v1/gateway/telemetry", JSON.stringify(payload), {}, (err) => {
      if (err) console.error("❌ Publish error:", err.message);
    });

    if (tick % 10 === 0) {
      console.clear();
      console.log(`🕐 ${new Date().toLocaleTimeString()}  tick #${tick}\n`);
      for (const [n, s] of Object.entries(state)) {
        console.log(`  ${n}  HR: ${s.hr} bpm  SpO₂: ${s.spo2}%  Temp: ${s.temp}°C`);
      }
      console.log("\n[Ctrl+C to stop]");
    }
  }, PUBLISH_INTERVAL);
}

client.on("error",   e => console.error("❌", e.message));
client.on("offline", () => console.warn("⚠️  Reconnecting..."));
process.on("SIGINT", () => { client.end(true, () => process.exit(0)); });