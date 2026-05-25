// pages/api/patient.js

import { getPatientInfo } from "../../lib/thingsboard";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const deviceId = req.query.deviceId || process.env.TB_DEVICE_ID || null;
  if (!deviceId) return res.status(400).json({ error: "Missing deviceId", info: null });

  try {
    const info = await getPatientInfo(deviceId);
    return res.status(200).json({ info });
  } catch (err) {
    console.error("[patient] Error:", err.message);
    return res.status(200).json({ info: null, warning: err.message });
  }
}