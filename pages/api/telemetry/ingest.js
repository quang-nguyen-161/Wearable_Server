// pages/api/telemetry/ingest.js
//
// Receives raw batches from devices, decodes each sample with 4ms-spaced
// timestamps, and posts to ThingsBoard via the admin timeseries API.
// Auto-creates the leaf device by name if it doesn't exist on the server.
//
// POST /api/telemetry/ingest
// Body: {
//   deviceName:    "Node1",
//   ts:            1234567890123,   // optional; server uses Date.now() if absent
//   ecg_batch:     "[v0,v1,...,v49]",  // optional
//   ppg_batch:     "[v0,v1,...,v49]",  // optional
//   ecgHeartRate:  72.5,               // optional vitals (ECG-derived HR)
//   ppgHeartRate:  71.0,               // optional vitals (PPG-derived HR)
//   heartRate:     72.5,               // legacy alias → stored as ppgHeartRate
//   spo2:          98.2,
//   temperature:   36.6,
// }
// Returns: { ok: true, device: "Node1", points: 50 }

import { getTbToken } from "../../../lib/thingsboard";

const TB_URL = process.env.TB_BASE_URL?.replace(/\/$/, "");

// Cache: device name → { id, token }  (refreshed every 5 min)
let deviceCache = {};
let cacheTs     = 0;

async function resolveDevice(jwtToken, name) {
  if (Date.now() - cacheTs > 300_000) {
    const res  = await fetch(`${TB_URL}/api/tenant/devices?pageSize=100&page=0`, {
      headers: { "X-Authorization": `Bearer ${jwtToken}` },
    });
    const json = await res.json();
    for (const d of (json.data || [])) {
      deviceCache[d.name] = { ...deviceCache[d.name], id: d.id.id };
    }
    cacheTs = Date.now();
  }

  if (deviceCache[name]?.token) return deviceCache[name];

  let id = deviceCache[name]?.id;

  if (!id) {
    // Auto-create the device
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
    id = device.id.id;
    console.log(`[ingest] Auto-created device "${name}" → ${id}`);
  }

  // Fetch the device's own access token so TB marks it active on each POST
  const credRes = await fetch(`${TB_URL}/api/device/${id}/credentials`, {
    headers: { "X-Authorization": `Bearer ${jwtToken}` },
  });
  if (!credRes.ok) throw new Error(`Could not fetch credentials for device ${id}`);
  const creds = await credRes.json();
  const token = creds.credentialsId;

  deviceCache[name] = { id, token };
  return deviceCache[name];
}

const TELEMETRY_CHUNK = 50; // TB Cloud rejects large batches; keep ≤50 pts per request

async function postTimeseries(deviceToken, telemetry) {
  for (let i = 0; i < telemetry.length; i += TELEMETRY_CHUNK) {
    const chunk = telemetry.slice(i, i + TELEMETRY_CHUNK);
    const res = await fetch(`${TB_URL}/api/v1/${deviceToken}/telemetry`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(chunk),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`TB device API ${res.status}: ${text.slice(0, 200)}`);
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const {
    deviceName, ts, ecg_batch, ppg_batch,
    ecgHeartRate, spo2, temperature,
    ppgHeartRate: ppgHrDirect,
    heartRate: heartRateLegacy,   // legacy key — stored as ppgHeartRate
  } = req.body ?? {};

  const ppgHeartRate = ppgHrDirect ?? heartRateLegacy; // prefer explicit key

  if (!deviceName) return res.status(400).json({ error: "deviceName required" });

  const hasWaveform = ecg_batch || ppg_batch;
  const hasVitals   = ecgHeartRate != null || ppgHeartRate != null || spo2 != null || temperature != null;
  if (!hasWaveform && !hasVitals) {
    return res.status(400).json({ error: "at least one of ecg_batch, ppg_batch, or vitals required" });
  }

  try {
    // Use forwarded TB token from client (bypasses Cloudflare) or fall back to server auth
    const jwtToken = req.headers['x-tb-token'] || await getTbToken();
    const { token: deviceToken } = await resolveDevice(jwtToken, deviceName);

    const batchTs  = ts ?? Date.now();
    const telemetry = [];

    // Waveform samples — per-sample timestamps 4ms apart (~250Hz)
    if (hasWaveform) {
      const ecg = ecg_batch ? JSON.parse(ecg_batch) : [];
      const ppg = ppg_batch ? JSON.parse(ppg_batch) : [];
      const n   = Math.max(ecg.length, ppg.length);
      if (n > 0) {
        for (let i = 0; i < n; i++) {
          const sampleTs = batchTs - (n - 1 - i) * 4;
          const values   = {};
          if (i < ecg.length) values.ecg = ecg[i];
          if (i < ppg.length) values.ppg = ppg[i];
          telemetry.push({ ts: sampleTs, values });
        }
      }

      // Also store ecg_batch as-is so WebSocket LATEST_TELEMETRY delivers
      // all 50 samples at once to the dashboard for live waveform rendering
      const batchValues = {};
      if (ecg_batch) batchValues.ecg_batch = ecg_batch;
      if (ppg_batch) batchValues.ppg_batch = ppg_batch;
      if (Object.keys(batchValues).length > 0)
        telemetry.push({ ts: batchTs, values: batchValues });
    }

    // Vitals — single timestamped entry at batchTs
    if (hasVitals) {
      const values = {};
      if (ecgHeartRate != null) values.ecgHeartRate = ecgHeartRate;
      if (ppgHeartRate != null) values.ppgHeartRate = ppgHeartRate;
      if (spo2         != null) values.spo2         = spo2;
      if (temperature  != null) values.temperature  = temperature;
      telemetry.push({ ts: batchTs, values });
    }

    if (telemetry.length === 0) return res.status(400).json({ error: "Empty payload" });

    // Post via device HTTP API — TB marks the device active on each request
    await postTimeseries(deviceToken, telemetry);

    return res.status(200).json({ ok: true, device: deviceName, points: telemetry.length });

  } catch (err) {
    console.error("[ingest]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
