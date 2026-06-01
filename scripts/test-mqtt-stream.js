#!/usr/bin/env node
/**
 * scripts/test-mqtt-stream.js
 *
 * Simulates ESP32 dual-stream over pure MQTT:
 *
 *   ECG waveform  → ecg_batch JSON string  (every WAVE_INTERVAL_MS per node)
 *   Vitals        → ecgHeartRate / ppgHeartRate / spo2 / temperature (every VITAL_INTERVAL_MS)
 *
 * Both go via ThingsBoard gateway MQTT API → v1/gateway/telemetry
 * No Next.js server required — data goes directly to ThingsBoard.
 *
 * Run:  node scripts/test-mqtt-stream.js
 *  or:  node --env-file=.env.local scripts/test-mqtt-stream.js
 */

'use strict';

const mqtt = require('mqtt');
const fs   = require('fs');

// ── Load .env.local ───────────────────────────────────────────────────────
function loadEnv(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch { /* no .env.local — rely on shell env */ }
}
loadEnv('.env.local');

// ── Config ────────────────────────────────────────────────────────────────

const TB_BASE_URL     = (process.env.TB_BASE_URL || 'https://c7.hust-2slab.org').replace(/^https?:\/\//, '');
const MQTT_HOST       = process.env.MQTT_HOST || TB_BASE_URL;
const MQTT_PORT       = parseInt(process.env.MQTT_PORT || '1883', 10);
const GATEWAY_TOKEN   = process.env.TB_GATEWAY_ACCESS_TOKEN || '';

const GATEWAY_TOPIC   = 'v1/gateway/telemetry';

const BATCH_SIZE         = 50;    // ECG samples per publish
const SAMPLE_INTERVAL_MS = 4;     // 4ms/sample = 250Hz
const WAVE_INTERVAL_MS   = 1000;  // publish waveform every 1s per node
const VITAL_INTERVAL_MS  = 15000; // publish vitals every 15s

const NODES = [
  { name: 'Node4', hrBase: 72.0, spo2Base: 98.2, tempBase: 36.6, phaseOffset:   0 },
  { name: 'Node5', hrBase: 85.0, spo2Base: 96.5, tempBase: 37.1, phaseOffset:  67 },
  { name: 'Node6', hrBase: 65.0, spo2Base: 97.8, tempBase: 36.4, phaseOffset: 133 },
];

const sampleIdx = {};
NODES.forEach(n => sampleIdx[n.name] = 0);

// ── Signal generators ─────────────────────────────────────────────────────

function ecgSample(i, offset) {
  const phase = ((i + offset) % 200) / 200;
  const d = (phase - 0.5) * 20;
  return Math.round(2048 + 2000 * Math.exp(-(d * d)) + (Math.random() - 0.5) * 40);
}

// ── MQTT publish helpers ──────────────────────────────────────────────────

let client = null;

function publish(payload) {
  if (!client?.connected) return;
  client.publish(GATEWAY_TOPIC, JSON.stringify(payload), { qos: 0 }, (err) => {
    if (err) console.error('[MQTT] publish error:', err.message);
  });
}

function publishWaveform(node) {
  const base = sampleIdx[node.name];
  const ecg  = Array.from({ length: BATCH_SIZE }, (_, i) => ecgSample(base + i, node.phaseOffset));
  sampleIdx[node.name] += BATCH_SIZE;

  publish({
    [node.name]: [{
      ts:     Date.now(),
      values: { ecg_batch: JSON.stringify(ecg) },
    }],
  });
}

function publishVitals() {
  const t = new Date().toLocaleTimeString();
  for (const node of NODES) {
    node.hrBase   = Math.max(50,   Math.min(110,  node.hrBase   + (Math.random() - 0.5) * 2));
    node.spo2Base = Math.max(93,   Math.min(100,  node.spo2Base + (Math.random() - 0.5) * 0.3));
    node.tempBase = Math.max(36.0, Math.min(37.8, node.tempBase + (Math.random() - 0.5) * 0.1));

    const ecgHr = +node.hrBase.toFixed(1);
    const ppgHr = +(node.hrBase - 1 + (Math.random() - 0.5)).toFixed(1);

    publish({
      [node.name]: [{
        ts:     Date.now(),
        values: {
          ecgHeartRate: ecgHr,
          ppgHeartRate: ppgHr,
          spo2:         +node.spo2Base.toFixed(1),
          temperature:  +node.tempBase.toFixed(1),
        },
      }],
    });

    console.log(`[Vitals] ${t}  ${node.name}  ECG-HR:${String(ecgHr).padStart(5)}  PPG-HR:${String(ppgHr).padStart(5)}  SpO2:${+node.spo2Base.toFixed(1)}  Temp:${+node.tempBase.toFixed(1)}`);
  }
}

// ── Start waveform loops (staggered per node) ─────────────────────────────

function startWaveformLoop(node, delayMs) {
  let count = 0;
  setTimeout(() => {
    setInterval(() => {
      publishWaveform(node);
      count++;
      if (count % 5 === 0) {
        const t = new Date().toLocaleTimeString();
        console.log(`[${node.name}] ${t} — wave #${count} | ${count * BATCH_SIZE} ECG samples`);
      }
    }, WAVE_INTERVAL_MS);
  }, delayMs);
}

// ── Connect ───────────────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  Health Monitor — MQTT Stream (3 nodes, 250Hz ECG)       ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log(`MQTT  → mqtt://${MQTT_HOST}:${MQTT_PORT}`);
console.log(`Topic → ${GATEWAY_TOPIC}`);
console.log(`Nodes → ${NODES.map(n => n.name).join(', ')}`);
console.log(`ECG   → ${BATCH_SIZE} samples × ${SAMPLE_INTERVAL_MS}ms = ${BATCH_SIZE * SAMPLE_INTERVAL_MS}ms per batch`);
console.log(`Vital → every ${VITAL_INTERVAL_MS / 1000}s`);
console.log('Press Ctrl+C to stop\n');

if (!GATEWAY_TOKEN) {
  console.error('ERROR: TB_GATEWAY_ACCESS_TOKEN not set in .env.local');
  process.exit(1);
}

client = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
  username:    GATEWAY_TOKEN,
  password:    '',
  clientId:    `test-stream-${Date.now()}`,
  reconnectPeriod: 3000,
  connectTimeout: 10000,
});

client.on('connect', () => {
  console.log(`[MQTT] Connected to ${MQTT_HOST}:${MQTT_PORT}\n`);

  // Immediate first vital publish
  publishVitals();
  setInterval(publishVitals, VITAL_INTERVAL_MS);

  // Stagger waveform loops 333ms apart
  NODES.forEach((node, i) => startWaveformLoop(node, i * 333));
});

client.on('error',      err  => console.error('[MQTT] Error:', err.message));
client.on('close',      ()   => console.warn('[MQTT] Connection closed'));
client.on('reconnect',  ()   => console.log('[MQTT] Reconnecting...'));
