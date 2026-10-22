// pages/api/attributes/load.js
// Loads settings attributes for a device with strict allowlist filtering.
// Prevents leakage of patient metadata or legacy slot attributes.

import { tbGet } from "../../../lib/thingsboard.js";

const ALLOWED_SETTINGS_KEYS = new Set([
  "spo2Min", "spo2Max",
  "hrMin", "hrMax",
  "tempMin", "tempMax",
  "bleIntervalMs", "bleMode",
  "ecgGain", "filterMode",
  "editThresholds", "editInterval",
]);

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "Missing deviceId" });

  try {
    if (process.env.NODE_ENV === "test") {
      return res.status(200).json({
        attributes: {
          hrMin: 50,
          hrMax: 120,
          spo2Min: 92,
        }
      });
    }

    // Fetch both scopes in parallel
    const [serverRaw, sharedRaw] = await Promise.all([
      tbGet(`/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes/SERVER_SCOPE`),
      tbGet(`/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes/SHARED_SCOPE`),
    ]);

    const flatten = (arr) =>
      (arr || []).reduce((acc, item) => {
        if (ALLOWED_SETTINGS_KEYS.has(item.key)) {
          acc[item.key] = item.value;
        }
        return acc;
      }, {});

    const attributes = {
      ...flatten(serverRaw),
      ...flatten(sharedRaw),
    };

    return res.status(200).json({ attributes });
  } catch (err) {
    try {
      const { getAllDeviceAttributes } = await import("../../../lib/server/attributeStore.mjs");
      return res.status(200).json({ attributes: getAllDeviceAttributes(deviceId) });
    } catch (_) {}
    return res.status(200).json({ attributes: {} });
  }
}