#!/usr/bin/env node
/**
 * scripts/test-mqtt-tb.js
 *
 * Tests MQTT connectivity to a self-hosted ThingsBoard server.
 * Uses the TB Gateway MQTT API — one connection publishes telemetry
 * for multiple leaf devices (Node4, Node5, Node6).
 *
 * Topic:   v1/gateway/telemetry
 * Auth:    TB_GATEWAY_ACCESS_TOKEN as MQTT username (no password)
 * Format:  { "DeviceName": [{ "ts": epochMs, "values": { key: value } }] }
 *
 * Run: node --env-file=.env.local scripts/test-mqtt-tb.js
 * Or:  node scripts/test-mqtt-tb.js  (reads .env.local automatically below)
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
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch { /* file not found — rely on shell env */ }
}
loadEnv('.env.local');
loadEnv('../.env.local');

// ── Config ────────────────────────────────────────────────────────────────
const TB_BASE_URL   = (process.env.TB_BASE_URL || '').replace(/\/$/, '');
const ACCESS_TOKEN  = process.env.TB_GATEWAY_ACCESS_TOKEN || '';
const PUBLISH_INTERVAL_MS = 5000;

if (!TB_BASE_URL || !ACCESS_TOKEN) {
  console.error('ERROR: TB_BASE_URL and TB_GATEWAY_ACCESS_TOKEN must be set in .env.local');
  process.exit(1);
}

const TB_HOST = TB_BASE_URL.replace(/^https?:\/\//, '');

// Broker resolution order:
//   TB_MQTT_BROKER env  →  override everything (e.g. "mqtt://192.168.1.10:1883")
//   TB_MQTT_PORT=1883   →  plain TCP  mqtt://host:PORT
//   TB_MQTT_PORT=8883   →  TLS        mqtts://host:PORT
//   (default)           →  WebSocket  wss://host/mqtt  (works through Cloudflare on 443)
let BROKER;
if (process.env.TB_MQTT_BROKER) {
  BROKER = process.env.TB_MQTT_BROKER;
} else if (process.env.TB_MQTT_PORT) {
  const port = parseInt(process.env.TB_MQTT_PORT, 10);
  const scheme = port === 8883 ? 'mqtts' : 'mqtt';
  BROKER = `${scheme}://${TB_HOST}:${port}`;
} else {
  // Default: MQTT over WebSocket on 443 — the only path that works through Cloudflare
  BROKER = `wss://${TB_HOST}/mqtt`;
}

const NODES = [
  { name: 'Node4', hrBase: 72.0, spo2Base: 98.2, tempBase: 36.6 },
  { name: 'Node5', hrBase: 85.0, spo2Base: 96.5, tempBase: 37.1 },
  { name: 'Node6', hrBase: 65.0, spo2Base: 97.8, tempBase: 36.4 },
];

// ── Connect ───────────────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║         Health Monitor — MQTT Gateway Test               ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log(`Broker : ${BROKER}`);
console.log(`Token  : ${ACCESS_TOKEN.slice(0, 6)}${'*'.repeat(ACCESS_TOKEN.length - 6)}`);
console.log(`Nodes  : ${NODES.map(n => n.name).join(', ')}`);
console.log(`Interval: ${PUBLISH_INTERVAL_MS / 1000}s\n`);

const client = mqtt.connect(BROKER, {
  username:      ACCESS_TOKEN,
  password:      '',
  clientId:      `tb-test-${Date.now()}`,
  keepalive:     30,
  reconnectPeriod: 3000,
  connectTimeout: 10000,
});

client.on('connect', () => {
  console.log('[MQTT] Connected ✓');
  publishAll(); // publish immediately on connect
  setInterval(publishAll, PUBLISH_INTERVAL_MS);
});

client.on('reconnect', () => console.log('[MQTT] Reconnecting...'));
client.on('error',     (err) => console.error('[MQTT] Error:', err.message));
client.on('offline',   () => console.warn('[MQTT] Offline'));
client.on('close',     () => console.warn('[MQTT] Connection closed'));

// ── Publish ───────────────────────────────────────────────────────────────
let publishCount = 0;

function publishAll() {
  publishCount++;
  const ts = Date.now();
  const t  = new Date().toLocaleTimeString();

  // Drift vitals slightly each round
  for (const node of NODES) {
    node.hrBase   = clamp(node.hrBase   + rand(2),   50,  110);
    node.spo2Base = clamp(node.spo2Base + rand(0.3),  93,  100);
    node.tempBase = clamp(node.tempBase + rand(0.1), 36.0, 37.8);
  }

  // TB Gateway telemetry format: one message, all nodes
  const payload = {};
  for (const node of NODES) {
    payload[node.name] = [{
      ts,
      values: {
        ecgHeartRate: round1(node.hrBase),
        ppgHeartRate: round1(node.hrBase - 1 + rand(1)),
        spo2:         round1(node.spo2Base),
        temperature:  round1(node.tempBase),
      },
    }];
  }

  client.publish(
    'v1/gateway/telemetry',
    JSON.stringify(payload),
    { qos: 1 },
    (err) => {
      if (err) {
        console.error(`[Publish #${publishCount}] FAILED:`, err.message);
      } else {
        console.log(`[Publish #${publishCount}] ${t}`);
        for (const node of NODES) {
          const v = payload[node.name][0].values;
          console.log(
            `  ${node.name.padEnd(6)} ECG-HR:${String(v.ecgHeartRate).padStart(5)}` +
            `  PPG-HR:${String(v.ppgHeartRate).padStart(5)}` +
            `  SpO2:${v.spo2}  Temp:${v.temperature}`
          );
        }
      }
    }
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────
const rand  = (scale) => (Math.random() - 0.5) * scale;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = (v) => +v.toFixed(1);

// ── Graceful shutdown ─────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n[MQTT] Disconnecting...');
  client.end(false, {}, () => {
    console.log('[MQTT] Disconnected. Bye.');
    process.exit(0);
  });
});
