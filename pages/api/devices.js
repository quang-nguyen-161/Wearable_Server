// pages/api/devices.js
// Returns only devices whose name contains "node" (case-insensitive).
// Online status is determined by checking the last telemetry timestamp —
// if no data received within OFFLINE_THRESHOLD_MS, device is marked offline.

import { tbGet } from "../../lib/thingsboard";

const GATEWAY_ID = process.env.TB_DEVICE_ID;

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!GATEWAY_ID) return res.status(500).json({ error: "TB_DEVICE_ID not set", devices: [] });

  try {
    // ── 1. Get device list ──────────────────────────────────────────────
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
      .filter(r => r?.to?.entityType === "DEVICE")
      .map(r => r.to.id);

    let allDevices = [];

    if (childIds.length > 0) {
      const infos = await Promise.all(
        childIds.map(id => tbGet(`/api/device/${id}`).catch(() => null))
      );
      allDevices = infos.filter(Boolean).map(d => ({
        id: d.id.id, name: d.name, label: d.label || null,
      }));
    } else {
      const all = await tbGet("/api/tenant/devices", { pageSize: 100, page: 0 });
      allDevices = (all?.data || [])
        .filter(d => d.id.id !== GATEWAY_ID)
        .map(d => ({ id: d.id.id, name: d.name, label: d.label || null }));
    }

    // Filter to node devices only
    const nodeDevices = allDevices.filter(d =>
      d.name.toLowerCase().includes("node")
    );

    // ── 2. Check device activity via the gateway's own 'connected' attr ─
    // TB's built-in active/lastConnectTime/lastDisconnectTime tracking for
    // gateway sub-devices is unreliable (active can stay stuck true, and
    // connect/disconnect timestamps can arrive out of order). The gateway
    // instead sets its own 'connected' SERVER_SCOPE attribute (via REST,
    // tenant-authenticated) reflecting the real BLE link state — use that
    // directly, defaulting to offline.

    const devicesWithStatus = await Promise.all(
      nodeDevices.map(async (device) => {
        try {
          const attrs = await tbGet(
            `/api/plugins/telemetry/DEVICE/${device.id}/values/attributes/SERVER_SCOPE`,
            { keys: "connected,patientName" }
          );

          // TB returns array: [{ key, value, lastUpdateTs }]
          const map = {};
          for (const item of attrs || []) map[item.key] = item.value;

          return {
            ...device,
            patientName:         map.patientName || null,
            displayName:         map.patientName || device.name,
            online:              map.connected === true || map.connected === "true",
          };
        } catch (_) {
          return { ...device, online: false };
        }
      })
    );

    const devices = devicesWithStatus.sort((a, b) => a.name.localeCompare(b.name));
    return res.status(200).json({ devices });

  } catch (err) {
    console.error("[devices]", err.message);
    return res.status(500).json({ error: err.message, devices: [] });
  }
}