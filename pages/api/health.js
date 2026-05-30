// pages/api/health.js
// Diagnostic endpoint — confirms which TB instance the server is talking to
// and whether credentials are valid. Safe to call; never modifies data.
// GET /api/health

import { getTbToken, tbGet } from "../../lib/thingsboard";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();

  const TB_BASE_URL   = process.env.TB_BASE_URL   || "(not set)";
  const TB_USERNAME   = process.env.TB_USERNAME   || "(not set)";
  const TB_DEVICE_ID  = process.env.TB_DEVICE_ID  || "(not set)";
  const TB_WS_URL     = process.env.NEXT_PUBLIC_TB_WS_URL || "(not set)";
  const GW_TOKEN      = process.env.TB_GATEWAY_ACCESS_TOKEN ? "set" : "(not set)";

  let authOk   = false;
  let authErr  = null;
  let tbInfo   = null;
  let gatewayOk = false;
  let gatewayName = null;
  let gatewayErr  = null;

  // 1. Try to get a JWT token from TB
  try {
    await getTbToken();
    authOk = true;
  } catch (e) {
    authErr = e.message;
  }

  // 2. Confirm we're talking to the right TB instance (fetch /api/system/info)
  if (authOk) {
    try {
      tbInfo = await tbGet("/api/system/info");
    } catch (_) {
      // CE community edition may not expose this endpoint
    }
  }

  // 3. Confirm the gateway device exists in this TB instance
  if (authOk && TB_DEVICE_ID !== "(not set)") {
    try {
      const dev = await tbGet(`/api/device/${TB_DEVICE_ID}`);
      gatewayOk   = true;
      gatewayName = dev?.name || null;
    } catch (e) {
      gatewayErr = e.message;
    }
  }

  return res.status(200).json({
    env: {
      TB_BASE_URL,
      TB_USERNAME,
      TB_DEVICE_ID,
      NEXT_PUBLIC_TB_WS_URL: TB_WS_URL,
      TB_GATEWAY_ACCESS_TOKEN: GW_TOKEN,
    },
    auth: { ok: authOk, error: authErr },
    tbInfo: tbInfo ? { edition: tbInfo.edition, version: tbInfo.version } : null,
    gateway: { ok: gatewayOk, name: gatewayName, error: gatewayErr },
    timestamp: new Date().toISOString(),
  });
}
