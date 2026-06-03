#!/usr/bin/env node
/**
 * scripts/test-ws-stream.js
 *
 * Streams ECG to local ThingsBoard using two WebSocket paths:
 *
 *  SEND  → MQTT over WebSocket (ws://localhost:8083/mqtt)
 *          Falls back to MQTT TCP (mqtt://localhost:1883) if WS unavailable
 *
 *  RECV  → TB WebSocket subscription API (ws://localhost:9090/api/ws/...)
 *          Same path the browser dashboard uses for live ECG graph
 *
 * Run:  node scripts/test-ws-stream.js
 */

'use strict';

const mqtt      = require('mqtt');
const WebSocket = require('ws');

// ── Config ────────────────────────────────────────────────────────────────────
const TB_HTTP    = 'http://localhost:9090';
const TB_WS      = 'ws://localhost:9090';
const TB_USER    = 'tenant@thingsboard.org';
const TB_PASS    = 'tenant';

const NODES = [
  { name: 'Node1', token: '2Mm6LaNzXrqK7nZD6pe4', id: '6399a020-5f54-11f1-85bc-217f640bf259', phaseOffset:   0, hr: 67, spo2: 98.3, temp: 36.4 },
  { name: 'Node4', token: '1NJjM0LrK0tsI1tBGRgR', id: '6c2a36f0-5f59-11f1-b44f-fd250e4f8e15', phaseOffset:  67, hr: 75, spo2: 98.1, temp: 36.8 },
  { name: 'Node6', token: 'hs2rbllYaJotola0CEAy', id: '6c3bea30-5f59-11f1-b44f-fd250e4f8e15', phaseOffset: 133, hr: 65, spo2: 97.8, temp: 36.4 },
];

const SAMPLE_RATE_HZ   = 250;
const BATCH_SIZE       = 50;         // samples per packet (matches firmware)
const WAVE_INTERVAL_MS = 200;        // 1 packet every 200ms
const VITAL_INTERVAL_MS = 5000;
const TOPIC            = 'v1/devices/me/telemetry';

// ── ECG signal generator (PQRST waveform) ────────────────────────────────────
const sampleCounters = {};
NODES.forEach(n => sampleCounters[n.name] = 0);

function ecgSample(i, offset) {
  const phase = ((i + offset) % 200) / 200;
  const d = (phase - 0.5) * 20;
  return Math.round(2048 + 2000 * Math.exp(-(d * d)) + (Math.random() - 0.5) * 40);
}

// ── ASCII sparkline for terminal ECG preview ──────────────────────────────────
function sparkline(samples) {
  const min  = Math.min(...samples);
  const max  = Math.max(...samples);
  const bars = ' ▁▂▃▄▅▆▇█';
  return samples
    .filter((_, i) => i % 2 === 0)           // downsample to fit terminal
    .map(v => bars[Math.round((v - min) / (max - min + 1) * 8)])
    .join('');
}

// ── TB auth ───────────────────────────────────────────────────────────────────
async function getJwt() {
  const res = await fetch(`${TB_HTTP}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: TB_USER, password: TB_PASS }),
  });
  return (await res.json()).token;
}

// ── MQTT client factory — tries WS first, falls back to TCP ──────────────────
function createMqttClient(token, label) {
  return new Promise((resolve) => {
    // Attempt 1: MQTT over WebSocket
    const wsClient = mqtt.connect('ws://localhost:8083/mqtt', {
      username: token, password: '', protocolVersion: 4,
      reconnectPeriod: 0, connectTimeout: 3000,
    });

    const wsTimeout = setTimeout(() => {
      wsClient.end(true);
      // Fallback: MQTT TCP
      const tcpClient = mqtt.connect('mqtt://localhost:1883', {
        username: token, password: '', protocolVersion: 4,
        reconnectPeriod: 0,
      });
      tcpClient.on('connect', () => {
        console.log(`[${label}] Connected via MQTT TCP (WS unavailable on port 8083)`);
        resolve({ client: tcpClient, transport: 'MQTT-TCP' });
      });
      tcpClient.on('error', (e) => console.error(`[${label}] TCP error: ${e.message}`));
    }, 3000);

    wsClient.on('connect', () => {
      clearTimeout(wsTimeout);
      console.log(`[${label}] Connected via MQTT over WebSocket`);
      resolve({ client: wsClient, transport: 'MQTT-WS' });
    });
    wsClient.on('error', () => {}); // suppress, handled by timeout
  });
}

// ── TB WebSocket subscription (receive side) ──────────────────────────────────
function openTbSubscription(jwt, deviceIds) {
  const ws = new WebSocket(`${TB_WS}/api/ws/plugins/telemetry?token=${jwt}`);
  const stats = {};  // deviceId → { count, lastLatency }

  ws.on('open', () => {
    const cmds = deviceIds.map((id, i) => ({
      entityType: 'DEVICE', entityId: id,
      scope: 'LATEST_TELEMETRY', cmdId: i + 10,
    }));
    ws.send(JSON.stringify({ tsSubCmds: cmds, historyCmds: [], attrSubCmds: [] }));
  });

  ws.on('message', (raw) => {
    const msg  = JSON.parse(raw);
    const data = msg?.data;
    if (!data?.ecg_batch) return;

    const sub  = msg.subscriptionId;
    const node = NODES[sub - 10];
    if (!node) return;

    if (!stats[node.name]) stats[node.name] = { count: 0 };
    stats[node.name].count++;

    // Parse batch and render sparkline
    try {
      const raw_val = Array.isArray(data.ecg_batch)
        ? data.ecg_batch[0][1]
        : data.ecg_batch;
      const samples = JSON.parse(raw_val);
      const spark   = sparkline(samples.slice(0, 40));
      const count   = stats[node.name].count;
      process.stdout.write(`\r[${node.name}] #${String(count).padStart(4)}  ${spark}  `);
    } catch {}
  });

  ws.on('error', (e) => console.error('[WS-SUB] error:', e.message));
  return { ws, stats };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  ECG WebSocket Stream — Local ThingsBoard                ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  TB      : ${TB_HTTP}`);
  console.log(`  Nodes   : ${NODES.map(n => n.name).join(', ')}`);
  console.log(`  ECG     : ${BATCH_SIZE} samples @ ${SAMPLE_RATE_HZ}Hz every ${WAVE_INTERVAL_MS}ms`);
  console.log(`  Vitals  : every ${VITAL_INTERVAL_MS / 1000}s\n`);

  // Auth
  const jwt = await getJwt();
  console.log('[Auth] JWT obtained');

  // Open TB WS subscription (receive)
  const deviceIds = NODES.map(n => n.id);
  const { ws: subWs, stats } = openTbSubscription(jwt, deviceIds);
  console.log('[Sub]  Subscribed to ECG batches for all nodes');

  // Connect each node's MQTT client
  const clients = {};
  for (const node of NODES) {
    const { client, transport } = await createMqttClient(node.token, node.name);
    clients[node.name] = { client, transport };
  }

  const transports = [...new Set(Object.values(clients).map(c => c.transport))];
  console.log(`\n[Ready] Send transport: ${transports.join(', ')}`);
  console.log('[Ready] Streaming ECG — Press Ctrl+C to stop\n');

  // ── Waveform loop per node ──
  NODES.forEach((node, i) => {
    setTimeout(() => {
      setInterval(() => {
        const base    = sampleCounters[node.name];
        const samples = Array.from({ length: BATCH_SIZE }, (_, j) =>
          ecgSample(base + j, node.phaseOffset)
        );
        sampleCounters[node.name] += BATCH_SIZE;

        const payload = JSON.stringify({ ecg_batch: JSON.stringify(samples) });
        clients[node.name].client.publish(TOPIC, payload, { qos: 0 });
      }, WAVE_INTERVAL_MS);
    }, i * 67); // stagger nodes by 67ms
  });

  // ── Vitals loop ──
  const publishVitals = () => {
    NODES.forEach(node => {
      node.hr   = Math.max(50,   Math.min(110,  node.hr   + (Math.random() - 0.5) * 2));
      node.spo2 = Math.max(93,   Math.min(100,  node.spo2 + (Math.random() - 0.5) * 0.3));
      node.temp = Math.max(36.0, Math.min(37.8, node.temp + (Math.random() - 0.5) * 0.1));

      const payload = JSON.stringify({
        ecgHeartRate: +node.hr.toFixed(1),
        ppgHeartRate: +(node.hr - 1 + (Math.random() - 0.5)).toFixed(1),
        spo2:         +node.spo2.toFixed(1),
        temperature:  +node.temp.toFixed(1),
      });
      clients[node.name].client.publish(TOPIC, payload, { qos: 0 });
    });
  };
  publishVitals();
  setInterval(publishVitals, VITAL_INTERVAL_MS);

  // ── Summary on exit ──
  process.on('SIGINT', () => {
    console.log('\n\n[Summary]');
    NODES.forEach(n => {
      const received = stats[n.name]?.count ?? 0;
      const sent     = Math.floor(sampleCounters[n.name] / BATCH_SIZE);
      console.log(`  ${n.name}  sent=${sent}  received=${received}  drop=${sent - received}`);
    });
    process.exit(0);
  });
}

main().catch(e => { console.error(e.message); process.exit(1); });
