// pages/api/telemetry/latest.js

import { getLatestTelemetry } from "../../../lib/thingsboard";

const VITAL_KEYS = ["heartRate", "spo2", "temperature"];

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const deviceId = req.query.deviceId || process.env.TB_DEVICE_ID || null;
  if (!deviceId) return res.status(400).json({ error: "Missing deviceId", data: {} });

  try {
    const data = await getLatestTelemetry(deviceId, VITAL_KEYS);
    return res.status(200).json({ data });
  } catch (err) {
    console.error("[telemetry/latest] Error:", err.message);
    return res.status(500).json({ error: err.message, data: {} });
  }
}