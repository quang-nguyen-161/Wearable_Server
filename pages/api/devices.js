// pages/api/devices.js

import { tbGet } from "../../lib/thingsboard";

const GATEWAY_ID = process.env.TB_DEVICE_ID; // your gateway device UUID

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  if (!GATEWAY_ID) {
    return res.status(500).json({ error: "TB_DEVICE_ID is not set in .env.local", devices: [] });
  }

  try {
    // Try Relations API first (TB auto-creates "Manages" links for gateway children)
    let relations = [];
    try {
      relations = await tbGet("/api/relations", {
        fromId: GATEWAY_ID,
        fromType: "DEVICE",
        relationType: "Manages",
        relationTypeGroup: "COMMON",
      });
    } catch (e) {
      console.warn("[devices] Relations API failed:", e.message);
    }

    const childIds = (Array.isArray(relations) ? relations : [])
      .filter((r) => r?.to?.entityType === "DEVICE")
      .map((r) => r.to.id);

    // Fallback: list all tenant devices, exclude the gateway itself
    if (childIds.length === 0) {
      console.warn("[devices] No relations found, falling back to tenant device list");
      const all = await tbGet("/api/tenant/devices", { pageSize: 100, page: 0 });
      const devices = (all?.data || [])
        .filter((d) => d.id.id !== GATEWAY_ID)
        .map((d) => ({ id: d.id.id, name: d.name, label: d.label || null, online: true }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return res.status(200).json({ devices });
    }

    // Fetch device info for each child UUID
    const infos = await Promise.all(
      childIds.map((id) => tbGet(`/api/device/${id}`).catch(() => null))
    );
    const devices = infos
      .filter(Boolean)
      .map((d) => ({ id: d.id.id, name: d.name, label: d.label || null, online: true }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return res.status(200).json({ devices });
  } catch (err) {
    console.error("[devices] Error:", err.message);
    return res.status(500).json({ error: err.message, devices: [] });
  }
}