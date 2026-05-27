// pages/api/attributes/load.js
// Loads SERVER_SCOPE + SHARED_SCOPE attributes for a device.
// Used by settings page to pre-fill saved thresholds and BLE interval.

import { tbGet } from "../../../lib/thingsboard";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: "Missing deviceId" });

  try {
    // Fetch both scopes in parallel
    const [serverRaw, sharedRaw] = await Promise.all([
      tbGet(`/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes/SERVER_SCOPE`),
      tbGet(`/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes/SHARED_SCOPE`),
    ]);

    // TB returns array: [{ key, value, lastUpdateTs }]
    const flatten = (arr) =>
      (arr || []).reduce((acc, item) => ({ ...acc, [item.key]: item.value }), {});

    const attributes = {
      ...flatten(serverRaw),
      ...flatten(sharedRaw),
    };

    return res.status(200).json({ attributes });
  } catch (err) {
    console.error("[attributes/load]", err.message);
    // Return empty attributes so settings page shows defaults
    return res.status(200).json({ attributes: {} });
  }
}