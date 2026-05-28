// pages/api/ota/trigger.js
// Sends OTA RPC to ESP32 gateway with separate .bin and .dat URLs.
// ESP32 downloads both, resets nRF52832, and flashes via UART Serial DFU.

import { getTbToken } from "../../../lib/thingsboard";

const TB_URL     = process.env.TB_BASE_URL?.replace(/\/$/, "");
const GATEWAY_ID = process.env.TB_DEVICE_ID;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { nodeName, firmwareBinUrl, nodeIdx = 0 } = req.body;

  if (!nodeName || !firmwareBinUrl) {
    return res.status(400).json({ error: "Missing nodeName or firmwareBinUrl" });
  }

  try {
    const token = await getTbToken();
    const host  = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;

    const absbin  = firmwareBinUrl.startsWith("http") ? firmwareBinUrl : `${host}${firmwareBinUrl}`;
    const absinit = initPktUrl.startsWith("http")     ? initPktUrl     : `${host}${initPktUrl}`;

    // Send one-way RPC to gateway device
    const rpcRes = await fetch(
      `${TB_URL}/api/plugins/rpc/oneway/${GATEWAY_ID}`,
      {
        method: "POST",
        headers: {
          "Content-Type":    "application/json",
          "X-Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          method:  "triggerOTA",
          params:  { nodeName, firmwareBinUrl: absbin, nodeIdx },
          timeout: 30000,
        }),
      }
    );

    if (!rpcRes.ok) {
      const text = await rpcRes.text();
      throw new Error(`TB RPC failed (${rpcRes.status}): ${text}`);
    }

    res.status(200).json({ success: true, nodeName });
  } catch (err) {
    console.error("[ota/trigger]", err.message);
    res.status(500).json({ error: err.message });
  }
}