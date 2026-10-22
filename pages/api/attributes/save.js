// pages/api/attributes/save.js
// Saves attributes to a ThingsBoard device.
// SERVER_SCOPE → thresholds (read by dashboard)
// SHARED_SCOPE → interval (read by node firmware via TB attribute subscription)

import { getTbToken } from "../../../lib/thingsboard.js";

const TB_URL = process.env.TB_BASE_URL?.replace(/\/$/, "");

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { deviceId, scope = "SERVER_SCOPE", attributes } = req.body;

  if (!deviceId)   return res.status(400).json({ error: "Missing deviceId" });
  if (!attributes || typeof attributes !== "object") return res.status(400).json({ error: "Missing attributes" });

  // Guard against bypassing assignment transaction in SERVER_SCOPE.
  // In SHARED_SCOPE, patientName is permitted as a mirrored firmware downlink cache.
  const PROHIBITED_KEYS = scope === 'SHARED_SCOPE'
    ? ['connected', 'patientId', 'status']
    : ['connected', 'patientName', 'patientId', 'status'];
  for (const k of PROHIBITED_KEYS) {
    if (attributes[k] !== undefined) {
      return res.status(422).json({
        error: {
          code: 'UNPROCESSABLE_ENTITY',
          message: `Modifying "${k}" via attributes is prohibited. Use /api/v1/assignments for patient assignments.`,
        }
      });
    }
  }

  try {
    if (TB_URL && !TB_URL.includes("your-tb-host")) {
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

      if (r.ok) {
        return res.status(200).json({ ok: true });
      }
    }
  } catch (err) {
    console.warn("[attributes/save] TB unreachable, saving to local store:", err.message);
  }

  // Persist locally in dev / offline mode
  try {
    const { setDeviceAttributes } = await import("../../../lib/server/attributeStore.mjs");
    setDeviceAttributes(deviceId, scope, attributes);
    return res.status(200).json({ ok: true, source: "local" });
  } catch (err) {
    console.error("[attributes/save]", err.message);
    return res.status(500).json({ error: err.message });
  }
}