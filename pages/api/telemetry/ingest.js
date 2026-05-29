// pages/api/telemetry/ingest.js
//
// Receives raw batches from devices, decodes each sample with 4ms-spaced
// timestamps, and posts to ThingsBoard via the admin timeseries API.
// Auto-creates the leaf device by name if it doesn't exist on the server.
//
// POST /api/telemetry/ingest
// Body: {
//   deviceName: "Node1",
//   ts:         1234567890123,   // optional; server uses Date.now() if absent
//   ecg_batch:  "[v0,v1,...,v49]",
//   ppg_batch:  "[v0,v1,...,v49]",
// }
// Returns: { ok: true, device: "Node1", points: 50 }

import { getTbToken } from "../../../lib/thingsboard";

const TB_URL = process.env.TB_BASE_URL?.replace(/\/$/, "");

// In-memory device name → TB UUID cache (refreshed every 5 min)
let deviceCache = {};
let cacheTs     = 0;

async function resolveDeviceId(jwtToken, name) {
  if (Date.now() - cacheTs > 300_000) {
    const res  = await fetch(`${TB_URL}/api/tenant/devices?pageSize=100&page=0`, {
      headers: { "X-Authorization": `Bearer ${jwtToken}` },
    });
    const json = await res.json();
    deviceCache = {};
    for (const d of (json.data || [])) deviceCache[d.name] = d.id.id;
    cacheTs = Date.now();
  }

  if (deviceCache[name]) return deviceCache[name];

  // Device not found on this server — create it automatically
  const res = await fetch(`${TB_URL}/api/device`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "X-Authorization": `Bearer ${jwtToken}` },
    body:    JSON.stringify({ name, type: "default" }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create device "${name}" (${res.status}): ${text.slice(0, 200)}`);
  }
  const device = await res.json();
  deviceCache[name] = device.id.id;
  console.log(`[ingest] Auto-created device "${name}" → ${device.id.id}`);
  return device.id.id;
}

async function postTimeseries(jwtToken, deviceId, telemetry) {
  const res = await fetch(
    `${TB_URL}/api/plugins/telemetry/DEVICE/${deviceId}/timeseries/ANY`,
    {
      method:  "POST",
      headers: {
        "Content-Type":    "application/json",
        "X-Authorization": `Bearer ${jwtToken}`,
      },
      body: JSON.stringify(telemetry),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TB ${res.status}: ${text.slice(0, 200)}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { deviceName, ts, ecg_batch, ppg_batch } = req.body ?? {};

  if (!deviceName)              return res.status(400).json({ error: "deviceName required" });
  if (!ecg_batch && !ppg_batch) return res.status(400).json({ error: "ecg_batch or ppg_batch required" });

  try {
    const jwtToken = await getTbToken();
    const deviceId = await resolveDeviceId(jwtToken, deviceName);

    const batchTs = ts ?? Date.now();
    const ecg = ecg_batch ? JSON.parse(ecg_batch) : [];
    const ppg = ppg_batch ? JSON.parse(ppg_batch) : [];
    const n   = Math.max(ecg.length, ppg.length);

    if (n === 0) return res.status(400).json({ error: "Empty batch" });

    // Reconstruct per-sample timestamps: last sample = batchTs, step back 4ms each (~250Hz)
    const telemetry = Array.from({ length: n }, (_, i) => {
      const sampleTs = batchTs - (n - 1 - i) * 4;
      const values   = {};
      if (i < ecg.length) values.ecg = ecg[i];
      if (i < ppg.length) values.ppg = ppg[i];
      return { ts: sampleTs, values };
    });

    await postTimeseries(jwtToken, deviceId, telemetry);

    return res.status(200).json({ ok: true, device: deviceName, points: n });

  } catch (err) {
    console.error("[ingest]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
