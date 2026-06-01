#!/usr/bin/env node
/**
 * scripts/test-direct-stream.js
 *
 * Simulates firmware that unbatches ECG and posts directly to ThingsBoard:
 *
 *   ECG  → POST /api/v1/{deviceToken}/telemetry
 *          Body: [{ ts, values: { ecg } }, ...N samples]
 *
 *   Vitals → same endpoint, single entry:
 *          [{ ts, values: { ecgHeartRate, ppgHeartRate, spo2, temperature } }]
 *
 * No Vercel ingest proxy — data goes straight to ThingsBoard.
 * Does NOT require the Next.js dev server.
 *
 * Run:  node --env-file=.env.local scripts/test-direct-stream.js
 */

'use strict';

const fs = require('fs');

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
  } catch { /* no .env.local */ }
}
loadEnv('.env.local');
loadEnv('../.env.local');

// ── Config ────────────────────────────────────────────────────────────────

const TB_URL      = (process.env.TB_BASE_URL || '').replace(/\/$/, '');
const TB_USER     = process.env.TB_USERNAME  || '';
const TB_PASS     = process.env.TB_PASSWORD  || '';

const SAMPLE_RATE_HZ   = 250;  // ADC rate
const BATCH_SIZE       = 50;   // samples per POST
const WAVE_INTERVAL_MS = 200;  // POST every 200ms (50 samples × 4ms)
const VITAL_INTERVAL_MS  = 5000;

// Node configs — names must match ThingsBoard device names
const NODES = [
  { name: 'Node1', hrBase: 67.0, spo2Base: 98.3, tempBase: 36.4, phaseOffset:   0 },
  { name: 'Node4', hrBase: 75.0, spo2Base: 98.1, tempBase: 36.8, phaseOffset:  67 },
  { name: 'Node6', hrBase: 65.0, spo2Base: 97.8, tempBase: 36.4, phaseOffset: 133 },
];

// ── Signal generator ──────────────────────────────────────────────────────

const sampleIdx = {};
NODES.forEach(n => sampleIdx[n.name] = 0);

function ecgSample(i, offset) {
  const phase = ((i + offset) % 200) / 200;
  const d = (phase - 0.5) * 20;
  return Math.round(2048 + 2000 * Math.exp(-(d * d)) + (Math.random() - 0.5) * 40);
}


// ── ThingsBoard auth + device token resolution ────────────────────────────

let jwtToken = null;
const deviceTokens = {}; // name → access token

async function login() {
  const res = await fetch(`${TB_URL}/api/auth/login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ username: TB_USER, password: TB_PASS }),
  });
  if (!res.ok) throw new Error(`Login failed (${res.status})`);
  const { token } = await res.json();
  jwtToken = token;
  console.log('[Auth] Logged in to ThingsBoard');
}

async function resolveDeviceTokens() {
  const res = await fetch(`${TB_URL}/api/tenant/devices?pageSize=100&page=0`, {
    headers: { 'X-Authorization': `Bearer ${jwtToken}` },
  });
  const { data = [] } = await res.json();

  for (const node of NODES) {
    const device = data.find(d => d.name === node.name);
    if (!device) { console.warn(`[Init] Device "${node.name}" not found in ThingsBoard`); continue; }

    const credRes = await fetch(`${TB_URL}/api/device/${device.id.id}/credentials`, {
      headers: { 'X-Authorization': `Bearer ${jwtToken}` },
    });
    const creds = await credRes.json();
    deviceTokens[node.name] = creds.credentialsId;
    console.log(`[Init] ${node.name} → token resolved`);
  }
}

// ── Post telemetry directly to ThingsBoard device API ────────────────────

async function postTelemetry(deviceName, payload) {
  const token = deviceTokens[deviceName];
  if (!token) return;

  const res = await fetch(`${TB_URL}/api/v1/${token}/telemetry`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`[${deviceName}] POST failed (${res.status}): ${text.slice(0, 120)}`);
  }
  return { status: res.status, body: text };
}

// ── Waveform loop ─────────────────────────────────────────────────────────

function startWaveformLoop(node, delayMs) {
  let count = 0;
  setTimeout(() => {
    setInterval(async () => {
      const base    = sampleIdx[node.name];
      const samples = Array.from({ length: BATCH_SIZE }, (_, i) => ecgSample(base + i, node.phaseOffset));
      sampleIdx[node.name] += BATCH_SIZE;
      count++;

      await postTelemetry(node.name, { ecg_batch: JSON.stringify(samples) });

      if (count % 10 === 0) {
        const t = new Date().toLocaleTimeString();
        console.log(`[${node.name}] ${t} — wave #${count} | ${count * BATCH_SIZE} ECG samples sent`);
      }
    }, WAVE_INTERVAL_MS);
  }, delayMs);
}

// ── Vitals loop ───────────────────────────────────────────────────────────

async function publishVitals() {
  const t = new Date().toLocaleTimeString();
  for (const node of NODES) {
    node.hrBase   = Math.max(50,   Math.min(110,  node.hrBase   + (Math.random() - 0.5) * 2));
    node.spo2Base = Math.max(93,   Math.min(100,  node.spo2Base + (Math.random() - 0.5) * 0.3));
    node.tempBase = Math.max(36.0, Math.min(37.8, node.tempBase + (Math.random() - 0.5) * 0.1));

    const ecgHr = +node.hrBase.toFixed(1);
    const ppgHr = +(node.hrBase - 1 + (Math.random() - 0.5)).toFixed(1);

    await postTelemetry(node.name, [{
      ts:     Date.now(),
      values: {
        ecgHeartRate: ecgHr,
        ppgHeartRate: ppgHr,
        spo2:         +node.spo2Base.toFixed(1),
        temperature:  +node.tempBase.toFixed(1),
      },
    }]);

    console.log(`[Vitals] ${t}  ${node.name}  ECG-HR:${String(ecgHr).padStart(5)}  PPG-HR:${String(ppgHr).padStart(5)}  SpO2:${+node.spo2Base.toFixed(1)}  Temp:${+node.tempBase.toFixed(1)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  Health Monitor — Direct TB Stream (unbatched ECG)        ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log(`TB    → ${TB_URL}`);
  console.log(`Nodes → ${NODES.map(n => n.name).join(', ')}`);
  console.log(`ECG   → ${BATCH_SIZE} samples @ ${SAMPLE_RATE_HZ}Hz, POST every ${WAVE_INTERVAL_MS}ms`);
  console.log(`Vital → every ${VITAL_INTERVAL_MS / 1000}s`);
  console.log('Press Ctrl+C to stop\n');

  if (!TB_URL || !TB_USER || !TB_PASS) {
    console.error('ERROR: TB_BASE_URL, TB_USERNAME, TB_PASSWORD must be set in .env.local');
    process.exit(1);
  }

  await login();
  await resolveDeviceTokens();

  const resolved = Object.keys(deviceTokens);
  if (resolved.length === 0) {
    console.error('ERROR: No node devices found. Check device names match ThingsBoard.');
    process.exit(1);
  }
  console.log(`\n[Ready] Streaming for: ${resolved.join(', ')}\n`);

  // ── Diagnostic: verify first POST reaches ThingsBoard ──
  const firstNode = NODES.find(n => deviceTokens[n.name]);
  if (firstNode) {
    const r = await postTelemetry(firstNode.name, { _ping: 1 });
    console.log(`[Diag] Test POST to ${firstNode.name} → HTTP ${r?.status}  body: "${r?.body?.slice(0, 80)}"`);
  }

  // Immediate first vital push
  await publishVitals();
  setInterval(publishVitals, VITAL_INTERVAL_MS);

  // Stagger waveform loops 200ms apart per node
  NODES.filter(n => deviceTokens[n.name]).forEach((node, i) => startWaveformLoop(node, i * 200));
}

main().catch(err => { console.error(err.message); process.exit(1); });
