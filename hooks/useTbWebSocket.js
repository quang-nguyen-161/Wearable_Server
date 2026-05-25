// hooks/useTbWebSocket.js
// Batches incoming WebSocket messages and flushes to state at 30fps (every ~33ms)
// so the chart renders smoothly instead of thrashing on every individual point.

import { useEffect, useRef, useState, useCallback } from "react";

const TB_WS_URL   = process.env.NEXT_PUBLIC_TB_WS_URL;
const MAX_POINTS  = 500;   // rolling buffer size per signal
const FLUSH_MS    = 33;    // ~30fps render rate

export function useTbWebSocket(deviceId, tbToken) {
  const wsRef       = useRef(null);
  const activeRef   = useRef(false);
  const flushRef    = useRef(null);

  // Pending buffers — accumulate between flushes, never trigger renders directly
  const pendingEcg    = useRef([]);
  const pendingPpg    = useRef([]);
  const pendingVitals = useRef({});

  const [vitals,     setVitals]     = useState({});
  const [ecgData,    setEcgData]    = useState([]);
  const [ppgData,    setPpgData]    = useState([]);
  const [connected,  setConnected]  = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);

  // ── Flush pending data to React state at 30fps ──────────────────────
  const startFlushLoop = useCallback(() => {
    if (flushRef.current) return;
    flushRef.current = setInterval(() => {
      // Vitals
      if (Object.keys(pendingVitals.current).length > 0) {
        const snap = { ...pendingVitals.current };
        pendingVitals.current = {};
        setVitals(prev => ({ ...prev, ...snap }));
        setLastUpdate(new Date());
      }

      // ECG
      if (pendingEcg.current.length > 0) {
        const pts = pendingEcg.current.splice(0);
        setEcgData(prev => {
          const next = [...prev, ...pts];
          return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next;
        });
      }

      // PPG
      if (pendingPpg.current.length > 0) {
        const pts = pendingPpg.current.splice(0);
        setPpgData(prev => {
          const next = [...prev, ...pts];
          return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next;
        });
      }
    }, FLUSH_MS);
  }, []);

  const stopFlushLoop = useCallback(() => {
    if (flushRef.current) {
      clearInterval(flushRef.current);
      flushRef.current = null;
    }
  }, []);

  // ── Parse incoming TB message into pending buffers ──────────────────
  const handleMessage = useCallback((event) => {
    try {
      const msg  = JSON.parse(event.data);
      if (msg.errorCode && msg.errorCode !== 0) {
        console.error("[WS] TB error:", msg.errorMsg);
        return;
      }

      const data = msg.data || msg.latestValues;
      if (!data) return;

      // Vitals — keep latest value only
      for (const key of ["heartRate", "spo2", "temperature"]) {
        const entries = data[key];
        if (entries?.length) {
          const [ts, val] = entries[entries.length - 1];
          pendingVitals.current[key] = { value: parseFloat(val), ts };
        }
      }

      // ECG / PPG — accumulate ALL points from this message
      for (const [ts, val] of (data.ecg || [])) {
        pendingEcg.current.push({ ts, value: parseFloat(val) });
      }
      for (const [ts, val] of (data.ppg || [])) {
        pendingPpg.current.push({ ts, value: parseFloat(val) });
      }

    } catch (err) {
      console.error("[WS] Parse error:", err.message);
    }
  }, []);

  // ── Connect / disconnect ────────────────────────────────────────────
  useEffect(() => {
    if (!deviceId || !tbToken || !TB_WS_URL) {
      console.warn("[WS] Missing:", { deviceId: !!deviceId, token: !!tbToken, url: !!TB_WS_URL });
      return;
    }
    if (activeRef.current) return;
    activeRef.current = true;

    // Reset all state and buffers
    setVitals({});
    setEcgData([]);
    setPpgData([]);
    pendingEcg.current    = [];
    pendingPpg.current    = [];
    pendingVitals.current = {};

    console.log("[WS] Connecting to device:", deviceId);
    const ws = new WebSocket(`${TB_WS_URL}?token=${tbToken}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      console.log("[WS] ✅ Connected");

      ws.send(JSON.stringify({
        tsSubCmds: [{
          entityType: "DEVICE",
          entityId:   deviceId,
          scope:      "LATEST_TELEMETRY",
          cmdId:      10,
        }],
        historyCmds: [],
        attrSubCmds: [],
      }));

      startFlushLoop();
      console.log("[WS] Subscribed + flush loop started @", FLUSH_MS + "ms");
    };

    ws.onmessage = handleMessage;
    ws.onerror   = (e) => console.error("[WS] Error:", e);
    ws.onclose   = (e) => {
      setConnected(false);
      activeRef.current = false;
      stopFlushLoop();
      console.warn("[WS] Closed:", e.code, e.reason || "");
    };

    return () => {
      activeRef.current = false;
      stopFlushLoop();
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, "cleanup");
    };
  }, [deviceId, tbToken, handleMessage, startFlushLoop, stopFlushLoop]);

  return { vitals, ecgData, ppgData, connected, lastUpdate };
}