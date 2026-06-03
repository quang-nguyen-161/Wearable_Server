#!/usr/bin/env node
/**
 * scripts/test-direct-stream.js
 *
 * Simulates the ESP32 firmware streaming ECG waveforms and vitals
 * directly to ThingsBoard via MQTT gateway API.
 *
 * Topic:  v1/gateway/telemetry
 * Auth:   TB_GATEWAY_ACCESS_TOKEN as MQTT username
 * Format: { "NodeName": [{ "ts": epochMs, "values": { key: value } }] }
 *
 * ECG   → ecg_batch JSON string, 50 samples every 200ms per node
 * Vitals → ecgHeartRate / ppgHeartRate / spo2 / temperature every 5s
 *
 * No HTTP, no Vercel proxy, no per-node tokens needed.
 *
 * Run: node scripts/test-direct-stream.js
 *  or: node --env-file=.env.local scripts/test-direct-stream.js
 */

'use strict';

const mqtt = require('mqtt');
const fs   = require('fs');

// ── Load .env.local ───────────────────────────────────────────────────────
function loadEnv(filePath) {
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim();
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch { /* no .env.local */ }
}
loadEnv('.env.local');
loadEnv('../.env.local');

// ── Config ────────────────────────────────────────────────────────────────
const BROKER       = process.env.TB_MQTT_BROKER || 'mqtt://103.116.39.179:1883';
const ACCESS_TOKEN = process.env.TB_GATEWAY_ACCESS_TOKEN || '';

const SAMPLE_RATE_HZ     = 250;
const BATCH_SIZE         = 50;
const WAVE_INTERVAL_MS   = 200;   // 50 samples × 4ms = 200ms per batch
const VITAL_INTERVAL_MS  = 5000;

const NODES = [
  { name: 'Node1', hrBase: 67.0, spo2Base: 98.3, tempBase: 36.4, phaseOffset:   0 },
  { name: 'Node4', hrBase: 75.0, spo2Base: 98.1, tempBase: 36.8, phaseOffset:  67 },
  { name: 'Node6', hrBase: 65.0, spo2Base: 97.8, tempBase: 36.4, phaseOffset: 133 },
];

if (!ACCESS_TOKEN) {
  console.error('ERROR: TB_GATEWAY_ACCESS_TOKEN must be set in .env.local');
  process.exit(1);
}

// ── Signal generator ──────────────────────────────────────────────────────

const sampleIdx = {};
NODES.forEach(n => sampleIdx[n.name] = 0);

function ecgSample(i, offset) {
  const phase = ((i + offset) % 200) / 200;
  const d = (phase - 0.5) * 20;
  return Math.round(2048 + 2000 * Math.exp(-(d * d)) + (Math.random() - 0.5) * 40);
}

// ── MQTT connect ──────────────────────────────────────────────────────────

console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║  Health Monitor — MQTT Direct Stream                      ║');
console.log('╚═══════════════════════════════════════════════════════════╝');
console.log(`Broker : ${BROKER}`);
console.log(`Nodes  : ${NODES.map(n => n.name).join(', ')}`);
console.log(`ECG    : ${BATCH_SIZE} samples @ ${SAMPLE_RATE_HZ}Hz, every ${WAVE_INTERVAL_MS}ms`);
console.log(`Vitals : every ${VITAL_INTERVAL_MS / 1000}s`);
console.log('Press Ctrl+C to stop\n');

const client = mqtt.connect(BROKER, {
  username:        ACCESS_TOKEN,
  password:        '',
  clientId:        `test-direct-${Date.now()}`,
  keepalive:       30,
  reconnectPeriod: 3000,
  connectTimeout:  10000,
});

client.on('connect', () => {
  console.log('[MQTT] Connected ✓\n');
  startAll();
});
client.on('reconnect', () => console.log('[MQTT] Reconnecting...'));
client.on('error',     e  => console.error('[MQTT] Error:', e.message));
client.on('offline',   () => console.warn('[MQTT] Offline'));

// ── Publish helpers ───────────────────────────────────────────────────────

function publish(payload) {
  client.publish('v1/gateway/telemetry', JSON.stringify(payload), { qos: 0 });
}

// ── Waveform loop — staggered 200ms apart per node ────────────────────────

function startWaveformLoop(node, delayMs) {
  let count = 0;
  setTimeout(() => {
    setInterval(() => {
      const base    = sampleIdx[node.name];
      const samples = Array.from({ length: BATCH_SIZE },
        (_, i) => ecgSample(base + i, node.phaseOffset));
      sampleIdx[node.name] += BATCH_SIZE;
      count++;

      publish({
        [node.name]: [{
          ts:     Date.now(),
          values: { ecg_batch: JSON.stringify(samples) },
        }],
      });

      if (count % 25 === 0) {  // log every 5s
        console.log(`[${node.name}] wave #${count} | ${count * BATCH_SIZE} samples`);
      }
    }, WAVE_INTERVAL_MS);
  }, delayMs);
}

// ── Vitals loop ───────────────────────────────────────────────────────────

function publishVitals() {
  const t = new Date().toLocaleTimeString();
  const ts = Date.now();
  const payload = {};

  for (const node of NODES) {
    node.hrBase   = clamp(node.hrBase   + rand(2),   50,  110);
    node.spo2Base = clamp(node.spo2Base + rand(0.3),  93,  100);
    node.tempBase = clamp(node.tempBase + rand(0.1), 36.0, 37.8);

    const ecgHr = round1(node.hrBase);
    const ppgHr = round1(node.hrBase - 1 + rand(1));

    payload[node.name] = [{
      ts,
      values: {
        ecgHeartRate: ecgHr,
        ppgHeartRate: ppgHr,
        spo2:         round1(node.spo2Base),
        temperature:  round1(node.tempBase),
      },
    }];

    console.log(
      `[Vitals] ${t}  ${node.name.padEnd(6)}` +
      `  ECG-HR:${String(ecgHr).padStart(5)}` +
      `  PPG-HR:${String(ppgHr).padStart(5)}` +
      `  SpO2:${round1(node.spo2Base)}  Temp:${round1(node.tempBase)}`
    );
  }

  publish(payload);
}

// ── Start all loops ───────────────────────────────────────────────────────

function startAll() {
  publishVitals();
  setInterval(publishVitals, VITAL_INTERVAL_MS);
  NODES.forEach((node, i) => startWaveformLoop(node, i * WAVE_INTERVAL_MS));
}

// ── Helpers ───────────────────────────────────────────────────────────────

const rand   = scale => (Math.random() - 0.5) * scale;
const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = v => +v.toFixed(1);

process.on('SIGINT', () => {
  client.end(false, {}, () => { console.log('\n[MQTT] Disconnected.'); process.exit(0); });
});
