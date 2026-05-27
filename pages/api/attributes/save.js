// pages/api/attributes/save.js
// Saves attributes to a ThingsBoard device.
// SERVER_SCOPE → thresholds (read by dashboard)
// SHARED_SCOPE → interval (read by node firmware via TB attribute subscription)

import { getTbToken } from "../../../lib/thingsboard";

const TB_URL = process.env.TB_BASE_URL?.replace(/\/$/, "");

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { deviceId, scope = "SERVER_SCOPE", attributes } = req.body;

  if (!deviceId)   return res.status(400).json({ error: "Missing deviceId" });
  if (!attributes) return res.status(400).json({ error: "Missing attributes" });

  try {
    const token = await getTbToken();

    const r = await fetch(
      `${TB_URL}/api/plugins/telemetry/DEVICE/${deviceId}/attributes/${scope}`,
      {
        method:  "POST",
        headers: {
          "Content-Type":    "application/json",
          "X-Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify(attributes),
      }
    );

    if (!r.ok) {
      const text = await r.text();
      throw new Error(`TB POST attributes failed (${r.status}): ${text}`);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[attributes/save]", err.message);
    return res.status(500).json({ error: err.message });
  }
}