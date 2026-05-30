#!/usr/bin/env node
/**
 * scripts/test-http-stream.js
 *
 * Simulates ESP32 dual-protocol streaming:
 *
 *   HTTPS → POST /api/telemetry/ingest  (our Next.js server)
 *           Body: { deviceName, ts, ecg_batch: "[...]", ppg_batch: "[...]" }
 *           Server decodes batch → posts {ts, values:{ecg,ppg}} per sample to TB
 *           Each sample timestamp = batchTs - (n-1-i)*4ms  (250Hz / 4ms apart)
 *
 *   MQTT  → ecgHeartRate / ppgHeartRate / spo2 / temperature  (gateway API, every 15s)
 *
 * Requires the Next.js dev server to be running: npm run dev
 *
 * Run: node scripts/test-http-stream.js
 *  or: node --env-file=.env.local scripts/test-http-stream.js
 */

'use strict';

const http = require('http');
const fs   = require('fs');

// ── Load .env.local if present ────────────────────────────────────────────
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
  } catch { /* .env.local not found — rely on shell env */ }
}
loadEnv('.env.local');

// ── Config ────────────────────────────────────────────────────────────────

const SERVER_HOST    = 'localhost';
const SERVER_PORT    = 3000;
const INGEST_PATH    = '/api/telemetry/ingest';

const TB_BASE_URL = process.env.TB_BASE_URL || '';

const BATCH_SIZE         = 250;   // samples per POST
const SAMPLE_INTERVAL_MS = 4;     // 4ms per sample = 250Hz
const WAVE_INTERVAL_MS   = 1000;  // post every 1s per node (staggered → ~3 req/sec total)
const VITAL_INTERVAL_MS  = 15000;

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

function ppgSample(i, offset) {
  const phase = ((i + offset) % 200) / 200;
  return Math.round(2048 + 800 * Math.sin(2 * Math.PI * phase) + (Math.random() - 0.5) * 20);
}

// ── POST to our ingest endpoint ───────────────────────────────────────────

function postIngest(body) {
  const raw = JSON.stringify(body);
  const req = http.request({
    hostname: SERVER_HOST,
    port:     SERVER_PORT,
    path:     INGEST_PATH,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) },
  }, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      if (res.statusCode >= 300) {
        console.error(`[Ingest] ${res.statusCode}: ${data.slice(0, 120)}`);
      }
    });
  });
  req.on('error', err => console.error('[Ingest] error:', err.message));
  req.write(raw);
  req.end();
}

// ── Vitals via HTTP ingest (no MQTT needed) ───────────────────────────────

function publishVitals() {
  const t = new Date().toLocaleTimeString();
  for (const node of NODES) {
    node.hrBase   = Math.max(50,   Math.min(110,  node.hrBase   + (Math.random() - 0.5) * 2));
    node.spo2Base = Math.max(93,   Math.min(100,  node.spo2Base + (Math.random() - 0.5) * 0.3));
    node.tempBase = Math.max(36.0, Math.min(37.8, node.tempBase + (Math.random() - 0.5) * 0.1));
    const ecgHr = +node.hrBase.toFixed(1);
    const ppgHr = +(node.hrBase - 1 + (Math.random() - 0.5)).toFixed(1);
    postIngest({
      deviceName:   node.name,
      ecgHeartRate: ecgHr,
      ppgHeartRate: ppgHr,
      spo2:         +node.spo2Base.toFixed(1),
      temperature:  +node.tempBase.toFixed(1),
    });
    console.log(`[Vitals] ${t}  ${node.name}  ECG-HR:${String(ecgHr).padStart(5)}  PPG-HR:${String(ppgHr).padStart(5)}  SpO2:${+node.spo2Base.toFixed(1)}  Temp:${+node.tempBase.toFixed(1)}`);
  }
}

setInterval(publishVitals, VITAL_INTERVAL_MS);

// ── Per-node waveform — staggered 333ms apart ─────────────────────────────

function startNode(node, delayMs) {
  let waveCount = 0;

  setTimeout(() => {
    setInterval(() => {
      const base = sampleIdx[node.name];
      const ecg  = Array.from({ length: BATCH_SIZE }, (_, i) => ecgSample(base + i, node.phaseOffset));
      const ppg  = Array.from({ length: BATCH_SIZE }, (_, i) => ppgSample(base + i, node.phaseOffset));
      sampleIdx[node.name] += BATCH_SIZE;
      waveCount++;

      postIngest({
        deviceName: node.name,
        ts:         Date.now(),
        ecg_batch:  JSON.stringify(ecg),
        ppg_batch:  JSON.stringify(ppg),
      });

      if (waveCount % 5 === 0) {
        const t = new Date().toLocaleTimeString();
        console.log(`[${node.name}] ${t} — wave #${waveCount} | ${waveCount * BATCH_SIZE} samples`);
      }
    }, WAVE_INTERVAL_MS);
  }, delayMs);
}

// ── Start ─────────────────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║  Health Monitor — Server-Decoded Stream (3 nodes, 250Hz)║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log(`HTTP  → http://${SERVER_HOST}:${SERVER_PORT}${INGEST_PATH}`);
console.log(`        Waveform: ${BATCH_SIZE} samples × ${SAMPLE_INTERVAL_MS}ms = ${BATCH_SIZE * SAMPLE_INTERVAL_MS}ms per batch`);
console.log(`        Vitals: every ${VITAL_INTERVAL_MS / 1000}s (via same HTTP endpoint)`);
console.log();
console.log('Requires: npm run dev  (Next.js server on port 3000)');
console.log(`Verify:   ${TB_BASE_URL || 'https://c7.hust-2slab.org'} → Node1/Node2/Node3 → Latest Telemetry`);
console.log('Press Ctrl+C to stop\n');

NODES.forEach((node, i) => startNode(node, i * 333));
