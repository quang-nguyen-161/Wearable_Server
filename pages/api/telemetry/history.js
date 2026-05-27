// pages/api/telemetry/history.js
// Fetches time-series history for any telemetry key.
// ECG/PPG are stored natively as individual records per sample —
// no unpacking needed, TB stores each {ts, values} entry separately.

import { getTelemetryHistory } from "../../../lib/thingsboard";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const deviceId = req.query.deviceId || process.env.TB_DEVICE_ID || null;
  const key      = req.query.key;
  const hours    = parseFloat(req.query.hours) || 1;
  const limit    = parseInt(req.query.limit)   || 5000;

  if (!deviceId) return res.status(400).json({ error: "Missing deviceId", series: [] });
  if (!key)      return res.status(400).json({ error: "Missing key",      series: [] });

  try {
    const series = await getTelemetryHistory(deviceId, key, hours, limit);
    return res.status(200).json({ series });
  } catch (err) {
    console.error("[telemetry/history]", err.message);
    return res.status(500).json({ error: err.message, series: [] });
  }
}