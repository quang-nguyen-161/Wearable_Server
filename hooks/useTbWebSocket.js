// hooks/useTbWebSocket.js
// Batches incoming WebSocket messages and flushes to state at 30fps (every ~33ms)
// so the chart renders smoothly instead of thrashing on every individual point.

import { useEffect, useRef, useState, useCallback } from "react";
import { parseWaveformBatch } from "../lib/thingsboard";

const TB_WS_URL = process.env.NEXT_PUBLIC_TB_WS_URL;
const FLUSH_MS  = 16;    // ~60fps render rate

export function useTbWebSocket(deviceId, tbToken, ecgSampleFreq = 250) {
  // Updated whenever ecgSampleFreq prop changes — refs keep handleMessage/flushLoop stable
  const sampleIntervalMsRef = useRef(Math.round(1000 / ecgSampleFreq));
  // Buffer 65s so the 60s display window always has data; cap at 20k to avoid memory pressure
  const maxPointsRef        = useRef(Math.min(20000, Math.max(1500, ecgSampleFreq * 65)));
  useEffect(() => {
    sampleIntervalMsRef.current = Math.round(1000 / ecgSampleFreq);
    maxPointsRef.current        = Math.min(20000, Math.max(1500, ecgSampleFreq * 65));
  }, [ecgSampleFreq]);

  const wsRef       = useRef(null);
  const activeRef   = useRef(false);
  const flushRef    = useRef(null);

  // Pending buffers — accumulate between flushes, never trigger renders directly
  const pendingEcg      = useRef([]);
  const pendingVitals   = useRef({});
  const lastBatchTsRef  = useRef(null); // updated when any ECG data arrives

  const [vitals,      setVitals]      = useState({});
  const [ecgData,     setEcgData]     = useState([]);
  const [lastBatchTs, setLastBatchTs] = useState(null);
  const [connected,   setConnected]   = useState(false);
  const [lastUpdate,  setLastUpdate]  = useState(null);

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
        const pts = pendingEcg.current.splice(0).sort((a, b) => a.ts - b.ts);
        const cap = maxPointsRef.current;
        setEcgData(prev => {
          const lastTs = prev.length ? prev[prev.length - 1].ts : 0;
          // Drop any points older than or equal to last known timestamp (avoid overlaps)
          const fresh = pts.filter(p => p.ts > lastTs);
          if (fresh.length === 0) return prev;
          const next = [...prev, ...fresh];
          return next.length > cap ? next.slice(-cap) : next;
        });
      }

      // lastBatchTs — flush to state so noSignal logic in index.js can detect stale signal
      if (lastBatchTsRef.current !== null) {
        setLastBatchTs(lastBatchTsRef.current);
        lastBatchTsRef.current = null;
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
      for (const key of ["ppgHeartRate", "ecgHeartRate", "spo2", "temperature"]) {
        const entries = data[key];
        if (entries?.length) {
          const [ts, val] = entries[entries.length - 1];
          pendingVitals.current[key] = { value: parseFloat(val), ts };
        }
      }

      // ECG — individual timestamped points posted directly from firmware
      const ecgPts = data["ecg"] || [];
      for (const [ts, val] of ecgPts) pendingEcg.current.push({ ts, value: parseFloat(val) });
      if (ecgPts.length > 0) lastBatchTsRef.current = Date.now();

      // ecg_batch — JSON-string array from HTTPS POST
      const ecgEntry = data["ecg_batch"]?.[0];
      if (ecgEntry) {
        const batchTs    = ecgEntry?.[0] ?? Date.now();
        const ecgRaw     = ecgEntry?.[1] ?? ecgEntry?.value;
        const ecgSamples = parseWaveformBatch(ecgRaw, batchTs, sampleIntervalMsRef.current);
        for (const pt of ecgSamples) pendingEcg.current.push(pt);
        lastBatchTsRef.current = Date.now();
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
    setLastBatchTs(null);
    pendingEcg.current    = [];
    pendingVitals.current = {};
    lastBatchTsRef.current = null;

    console.log("[WS] Connecting to device:", deviceId);
    const ws = new WebSocket(`${TB_WS_URL}?token=${tbToken}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      console.log("[WS] Connected");

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

  return { vitals, ecgData, lastBatchTs, connected, lastUpdate };
}
