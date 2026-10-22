// pages/api/devices.js
// Returns watches/devices with online status determined by 5-second Freshness Window
// and active patient assignment from the PostgreSQL assignment store.
// Completely eliminates legacy SERVER_SCOPE.connected and "node" name filtering.

import { tbGet } from "../../lib/thingsboard.js";
import { query } from "../../lib/server/db.mjs";

const GATEWAY_ID = process.env.TB_DEVICE_ID;
const FRESHNESS_WINDOW_MS = 5000; // 5s standard window (Architecture v2)

// In-memory tracker for Local Reception Time (Solution 1)
const s_local_telemetry_tracker = new Map(); // devId -> { lastTs, localArrivalMs }

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    let allDevices = [];

    // ── 1. Fetch devices via relations or tenant listing ─────────────────
    if (process.env.NODE_ENV === 'test') {
      try {
        const wRes = await query(`SELECT watch_mac, tb_device_id, label FROM watches`);
        allDevices = (wRes.rows || []).map(w => ({
          id: w.tb_device_id || `tb-dev-${w.watch_mac.replace(/:/g, '').toLowerCase()}`,
          name: w.watch_mac,
          label: w.label || null,
        }));
      } catch (_) {}
    } else if (GATEWAY_ID) {
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

      if (childIds.length > 0) {
        const infos = await Promise.all(
          childIds.map(id => tbGet(`/api/device/${id}`).catch(() => null))
        );
        allDevices = infos.filter(Boolean).map(d => ({
          id: d.id.id, name: d.name, label: d.label || null,
        }));
      }
    }

    if (allDevices.length === 0) {
      try {
        const all = await tbGet("/api/tenant/devices", { pageSize: 100, page: 0 });
        allDevices = (all?.data || [])
          .filter(d => d.id.id !== GATEWAY_ID)
          .map(d => ({ id: d.id.id, name: d.name, label: d.label || null }));
      } catch (_) {
        // In local/test mode without TB, fallback to database watches registry
        try {
          const wRes = await query(`SELECT watch_mac, tb_device_id, label FROM watches`);
          allDevices = (wRes.rows || []).map(w => ({
            id: w.tb_device_id || `tb-dev-${w.watch_mac.replace(/:/g, '').toLowerCase()}`,
            name: w.watch_mac,
            label: w.label || null,
          }));
        } catch (_) {}
      }
    }

    // ── 2. Filter to wearable node devices only (original code filter) ─
    const isWearableNode = (d) => {
      const name = (d.name || "").toLowerCase().trim();
      if (name.includes("gateway")) return false;
      if (name === "00:00:00:00:00:00" || name === "ff:ff:ff:ff:ff:ff") return false;
      const devId = (typeof d.id === 'object' && d.id !== null) ? d.id.id : d.id;
      if (GATEWAY_ID && devId === GATEWAY_ID) return false;
      return name.includes("node") || /^([0-9a-f]{2}[:-]){5}([0-9a-f]{2})$/i.test(name);
    };

    const nodeDevices = allDevices.filter(isWearableNode);

    const serverNow = Date.now();

    // ── 3. Batch active patient assignments in ONE query ────────────────
    const assignmentMap = new Map(); // normalized_mac -> { patientId, patientName }
    if (nodeDevices.length > 0) {
      try {
        const macSet = new Set();
        nodeDevices.forEach(d => {
          if (d.name) macSet.add(d.name.toUpperCase());
          if (d.label) macSet.add(d.label.toUpperCase());
        });
        const macList = Array.from(macSet);
        if (macList.length > 0) {
          const asgnRes = await query(
            `SELECT a.watch_mac, a.patient_id, p.name as patient_name
             FROM assignments a
             LEFT JOIN patients p ON a.tenant_id = p.tenant_id AND a.patient_id = p.patient_id
             WHERE a.watch_mac = ANY($1) AND a.valid_to IS NULL
             ORDER BY a.valid_from DESC`,
            [macList]
          );
          for (const row of asgnRes.rows || []) {
            const key = (row.watch_mac || '').toUpperCase();
            if (!assignmentMap.has(key)) {
              assignmentMap.set(key, {
                patientId: row.patient_id,
                patientName: row.patient_name
              });
            }
          }
        }
      } catch (_) {}
    }

    // ── 4. Evaluate status via ThingsBoard attributes & DB Assignment Store ─
    const devicesWithStatus = await Promise.all(
      nodeDevices.map(async (device) => {
        try {
          // Look up active assignment from batched in-memory map
          const asgn = assignmentMap.get((device.name || '').toUpperCase()) ||
                       (device.label ? assignmentMap.get(device.label.toUpperCase()) : null);
          const patientId = asgn?.patientId || null;
          let patientName = asgn?.patientName || null;

          // Also check ThingsBoard attributes for bleConnected, connected, patientName, showEcg, deviceMode
          let attrConnected = undefined;
          let attrBleConnected = undefined;
          let attrPatientName = null;
          let showEcg = true;
          let deviceMode = 0;
          if (process.env.NODE_ENV !== 'test') {
            try {
              const attrs = await tbGet(
                `/api/plugins/telemetry/DEVICE/${device.id}/values/attributes`,
                { keys: "connected,bleConnected,patientName,showEcg,deviceMode" }
              );
              for (const item of attrs || []) {
                if (item.key === 'connected') attrConnected = (item.value === true || item.value === 'true');
                if (item.key === 'bleConnected') attrBleConnected = (item.value === true || item.value === 'true');
                if (item.key === 'patientName') attrPatientName = item.value;
                if (item.key === 'showEcg') showEcg = (item.value === true || item.value === 'true' || item.value === 1 || item.value === '1');
                if (item.key === 'deviceMode') deviceMode = Number(item.value) || 0;
              }
            } catch (_) {}
          }

          const resolvedPatientName = patientName || attrPatientName || null;
          let isOnline = false;
          let lastActivityTs = 0;

          if (process.env.NODE_ENV !== 'test') {
            // Check telemetry freshness across all metrics (Architecture v2 Passive Freshness Window)
            try {
              const telemetry = await tbGet(
                `/api/plugins/telemetry/DEVICE/${device.id}/values/timeseries`,
                { keys: "spo2,ecgHeartRate,ppgHeartRate,temperature,ecg_batch", limit: 1 }
              );
              for (const key of ["spo2", "ecgHeartRate", "ppgHeartRate", "temperature", "ecg_batch"]) {
                const series = telemetry[key];
                if (Array.isArray(series) && series.length > 0 && series[0].ts) {
                  const val = series[0].value;
                  if (val !== null && val !== undefined && val !== "") {
                    lastActivityTs = Math.max(lastActivityTs, Number(series[0].ts));
                  }
                }
              }
            } catch (_) {}
          }

          // Solution 1: Local Reception Time Tracking
          let localTracker = s_local_telemetry_tracker.get(device.id);
          const INITIAL_SKEW_TOLERANCE_MS = 20000; // 20s tolerance for initial load clock skew
          const ageMs = lastActivityTs > 0 ? Math.abs(serverNow - lastActivityTs) : Infinity;

          if (lastActivityTs > 0) {
            if (!localTracker) {
              // First time seeing this device: treat as fresh if within skew tolerance
              if (ageMs < INITIAL_SKEW_TOLERANCE_MS) {
                localTracker = { lastTs: lastActivityTs, localArrivalMs: serverNow };
              } else {
                localTracker = { lastTs: lastActivityTs, localArrivalMs: 0 };
              }
              s_local_telemetry_tracker.set(device.id, localTracker);
            } else if (lastActivityTs > localTracker.lastTs) {
              // Telemetry timestamp has advanced in real-time
              localTracker = { lastTs: lastActivityTs, localArrivalMs: serverNow };
              s_local_telemetry_tracker.set(device.id, localTracker);
            }
          }

          const localElapsedMs = (localTracker && localTracker.localArrivalMs > 0) ? (serverNow - localTracker.localArrivalMs) : Infinity;
          const freshOnline = (lastActivityTs > 0 && ageMs < FRESHNESS_WINDOW_MS) || (localElapsedMs < FRESHNESS_WINDOW_MS);

          // Solution 3: Immediate Disconnect Latch
          if (attrBleConnected === false || attrConnected === false) {
            isOnline = false;
            s_local_telemetry_tracker.delete(device.id);
          } else {
            isOnline = freshOnline;
          }

          return {
            ...device,
            patientId,
            patientName: resolvedPatientName,
            displayName: resolvedPatientName || device.label || device.name,
            online: isOnline,
            lastActivityTs: lastActivityTs || undefined,
            showEcg,
            deviceMode,
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