// simulate-nodes.js
// Simulates 3 sensor nodes pushing realistic health data to ThingsBoard via MQTT.
// Each node has slightly different baseline vitals and drift patterns.
// Run: node simulate-nodes.js

const mqtt = require("mqtt");

const GATEWAY_TOKEN = "kouqwqlqiccuev82k6f0";
const TB_HOST       = "mqtt://thingsboard.cloud";
const INTERVAL_MS   = 100; // 10 points/sec — fast enough for smooth ECG/PPG // push every 500ms — fast enough to see live ECG/PPG

// ── Node baseline profiles ─────────────────────────────────────────────────
const NODES = {
  Node1: {
    heartRate:   { base: 72,   drift: 8,    min: 55,  max: 110 },
    spo2:        { base: 98.5, drift: 1.5,  min: 94,  max: 100 },
    temperature: { base: 36.6, drift: 0.4,  min: 36,  max: 37.5 },
    ecgPhase:    0,
    ppgPhase:    0,
  },
  Node2: {
    heartRate:   { base: 88,   drift: 12,   min: 60,  max: 120 },
    spo2:        { base: 97.2, drift: 2,    min: 93,  max: 100 },
    temperature: { base: 37.1, drift: 0.5,  min: 36.5, max: 38.5 },
    ecgPhase:    1.2,
    ppgPhase:    0.8,
  },
  Node3: {
    heartRate:   { base: 65,   drift: 6,    min: 50,  max: 95 },
    spo2:        { base: 99.0, drift: 1,    min: 95,  max: 100 },
    temperature: { base: 36.3, drift: 0.3,  min: 35.8, max: 37.0 },
    ecgPhase:    2.4,
    ppgPhase:    1.6,
  },
};

// ── Waveform generators ────────────────────────────────────────────────────

// Realistic ECG: P wave + QRS complex + T wave
function ecgSample(phase) {
  const t = phase % (2 * Math.PI);
  // P wave
  const p = 0.15 * Math.exp(-Math.pow((t - 0.8), 2) / 0.04);
  // QRS complex
  const q = -0.1 * Math.exp(-Math.pow((t - 1.4), 2) / 0.002);
  const r =  1.0 * Math.exp(-Math.pow((t - 1.57), 2) / 0.001);
  const s = -0.3 * Math.exp(-Math.pow((t - 1.7), 2) / 0.002);
  // T wave
  const tw = 0.3 * Math.exp(-Math.pow((t - 2.5), 2) / 0.1);
  // Noise
  const noise = (Math.random() - 0.5) * 0.02;
  return parseFloat((p + q + r + s + tw + noise).toFixed(4));
}

// PPG: smooth sine-like pulse wave
function ppgSample(phase) {
  const t = phase % (2 * Math.PI);
  const systolic  = 0.8 * Math.exp(-Math.pow((t - 1.2), 2) / 0.08);
  const dicrotic  = 0.2 * Math.exp(-Math.pow((t - 2.2), 2) / 0.06);
  const noise     = (Math.random() - 0.5) * 0.01;
  return parseFloat(Math.max(0, systolic + dicrotic + noise).toFixed(4));
}

// Slowly drifting vital (random walk clamped to range)
function driftValue(current, profile) {
  const step = (Math.random() - 0.5) * profile.drift * 0.05;
  const next = current + step;
  return parseFloat(Math.min(profile.max, Math.max(profile.min, next)).toFixed(1));
}

// ── State ──────────────────────────────────────────────────────────────────
const state = {};
for (const [name, profile] of Object.entries(NODES)) {
  state[name] = {
    heartRate:   profile.heartRate.base,
    spo2:        profile.spo2.base,
    temperature: profile.temperature.base,
    ecgPhase:    profile.ecgPhase,
    ppgPhase:    profile.ppgPhase,
  };
}

// Phase increment per tick based on interval and ~1Hz heart rate base
const ECG_SPEED = (2 * Math.PI) / (1000 / INTERVAL_MS * 0.8); // ~0.8s per cycle
const PPG_SPEED = (2 * Math.PI) / (1000 / INTERVAL_MS * 0.9);

let tickCount = 0;

// ── MQTT ───────────────────────────────────────────────────────────────────
const client = mqtt.connect(TB_HOST, {
  username: GATEWAY_TOKEN,
  clean: true,
  reconnectPeriod: 3000,
});

client.on("connect", () => {
  console.log("✅ Connected to ThingsBoard\n");

  // Register all nodes first
  const connectPayload = JSON.stringify(
    Object.fromEntries(Object.keys(NODES).map((n) => [n, { type: "default" }]))
  );
  client.publish("v1/gateway/connect", connectPayload, {}, (err) => {
    if (err) return console.error("❌ Register error:", err.message);
    console.log(`📡 Registered: ${Object.keys(NODES).join(", ")}`);
    console.log(`🔄 Pushing telemetry every ${INTERVAL_MS}ms...\n`);
    startSimulation();
  });
});

// ── Simulation loop ────────────────────────────────────────────────────────
function startSimulation() {
  setInterval(() => {
    const now     = Date.now();
    const payload = {};
    tickCount++;

    for (const [name, profile] of Object.entries(NODES)) {
      const s = state[name];

      // Update waveform phases
      s.ecgPhase += ECG_SPEED;
      s.ppgPhase += PPG_SPEED;

      // Drift vitals slowly (update every ~2s = 4 ticks at 500ms)
      if (tickCount % 4 === 0) {
        s.heartRate   = driftValue(s.heartRate,   profile.heartRate);
        s.spo2        = driftValue(s.spo2,        profile.spo2);
        s.temperature = driftValue(s.temperature, profile.temperature);
      }

      payload[name] = [{
        ts: now,
        values: {
          heartRate:   s.heartRate,
          spo2:        s.spo2,
          temperature: s.temperature,
          ecg:         ecgSample(s.ecgPhase),
          ppg:         ppgSample(s.ppgPhase),
        },
      }];
    }

    client.publish("v1/gateway/telemetry", JSON.stringify(payload), {}, (err) => {
      if (err) console.error("❌ Publish error:", err.message);
    });

    // Log summary every 2s
    if (tickCount % 4 === 0) {
      console.clear();
      console.log(`🕐 ${new Date().toLocaleTimeString()}  |  tick #${tickCount}\n`);
      for (const [name, s] of Object.entries(state)) {
        console.log(
          `  ${name}  HR: ${s.heartRate} bpm  SpO₂: ${s.spo2}%  Temp: ${s.temperature}°C`
        );
      }
      console.log("\n[Ctrl+C to stop]");
    }
  }, INTERVAL_MS);
}

client.on("error",   (err) => console.error("❌ MQTT error:", err.message));
client.on("offline", ()    => console.warn("⚠️  Offline, reconnecting..."));

process.on("SIGINT", () => {
  console.log("\n👋 Stopping simulation...");
  client.end(true, () => process.exit(0));
});