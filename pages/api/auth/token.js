// pages/api/auth/token.js
// Returns a short-lived TB JWT for the browser WebSocket connection.
// The browser needs a token to open wss://thingsboard.cloud/api/ws/...
// We issue it server-side so credentials stay in .env.local

import { getTbToken } from "../../../lib/thingsboard";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  try {
    const token = await getTbToken();
    // Cache 2 minutes — browser will re-fetch if WS reconnects
    res.setHeader("Cache-Control", "private, max-age=120");
    return res.status(200).json({ token });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}