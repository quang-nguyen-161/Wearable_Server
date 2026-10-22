// pages/api/auth/token.js
// Returns a scoped JWT for browser telemetry subscriptions without leaking tenant-admin privileges.

import { createSignedJwt } from "../../../lib/server/auth.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  try {
    // Issue a short-lived, read-only client token scoped to CUSTOMER_USER (2 min cache)
    const token = createSignedJwt({
      sub: "browser-client",
      tenantId: process.env.TB_TENANT_ID || "tenant-default",
      scopes: ["CUSTOMER_USER"],
      exp: Math.floor(Date.now() / 1000) + 120,
    });

    res.setHeader("Cache-Control", "private, max-age=120");
    return res.status(200).json({ token });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}