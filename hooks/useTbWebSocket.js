// hooks/useTbWebSocket.js
// Architecture v2 Server-Mediated Live Telemetry Hook.
// Replaces direct browser-to-TB WSS with server-mediated cursor polling (every 1s)
// and smooth 60fps render loop with automatic 5s Freshness Window timeout.
// Preserves exact return shape: { vitals, ecgData, lastBatchTs, connected, lastUpdate }.

import { useEffect, useRef, useState, useCallback } from "react";
import { parseWaveformBatch } from "../lib/thingsboard";
import { mergeVitalsMonotonic } from "../lib/mergeVitals.mjs";

const FLUSH_MS = 16;              // ~60fps render rate
const POLL_INTERVAL_MS = 1000;    // Poll server-mediated API every 1s
const FRESHNESS_TIMEOUT_MS = 5000;// Automatic stale detection after 5s
const INITIAL_SKEW_MS = 20000;    // Tolerance for PC vs SNTP clock skew on initial mount

export function useTbWebSocket(deviceId, tbToken, ecgSampleFreq = 250) {
  const sampleIntervalMsRef = useRef(Math.round(1000 / ecgSampleFreq));
  const maxPointsRef        = useRef(Math.min(20000, Math.max(1500, ecgSampleFreq * 65)));

  useEffect(() => {
    sampleIntervalMsRef.current = Math.round(1000 / ecgSampleFreq);
    maxPointsRef.current        = Math.min(20000, Math.max(1500, ecgSampleFreq * 65));
  }, [ecgSampleFreq]);

  const activeRef       = useRef(false);
  const flushRef        = useRef(null);
  const pollTimerRef    = useRef(null);
  const abortCtrlRef    = useRef(null);

  // Pending buffers — accumulate between flushes, never trigger renders directly
  const pendingEcg      = useRef([]);
  const pendingVitals   = useRef({});
  const lastBatchTsRef  = useRef(null);
  const lastActivityRef = useRef(0);
  const lastPollSuccessLocalTimeRef = useRef(0);
  const requestGenRef   = useRef(0);

  const [vitals,      setVitals]      = useState({});
  const [ecgData,     setEcgData]     = useState([]);
  const [lastBatchTs, setLastBatchTs] = useState(null);
  const [connected,   setConnected]   = useState(false);
  const [lastUpdate,  setLastUpdate]  = useState(null);

  // ── Flush pending data to React state at 60fps ──────────────────────
  const startFlushLoop = useCallback(() => {
    if (flushRef.current) return;
    flushRef.current = setInterval(() => {
      // 1. Freshness window check: if no fresh sample within FRESHNESS_TIMEOUT_MS of local polling, mark disconnected
      const now = Date.now();
      if (lastPollSuccessLocalTimeRef.current > 0 && (now - lastPollSuccessLocalTimeRef.current) >= FRESHNESS_TIMEOUT_MS) {
        setConnected(false);
      }

      // 2. Vitals flush with monotonic timestamp guard
      if (Object.keys(pendingVitals.current).length > 0) {
        const snap = { ...pendingVitals.current };
        pendingVitals.current = {};
        setVitals(prev => mergeVitalsMonotonic(prev, snap));
        setLastUpdate(new Date());
      }

      // 3. ECG flush
      if (pendingEcg.current.length > 0) {
        const pts = pendingEcg.current.splice(0).sort((a, b) => a.ts - b.ts);
        const cap = maxPointsRef.current;
        setEcgData(prev => {
          const lastTs = prev.length ? prev[prev.length - 1].ts : 0;
          const fresh = pts.filter(p => p.ts > lastTs);
          if (fresh.length === 0) return prev;
          const next = [...prev, ...fresh];
          return next.length > cap ? next.slice(-cap) : next;
        });
      }

      // 4. lastBatchTs flush
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

  // ── Server-mediated polling loop (1 Hz) ─────────────────────────────
  const pollTelemetry = useCallback(async (targetDeviceId) => {
    if (!activeRef.current) return;
    const reqGen = ++requestGenRef.current;

    try {
      abortCtrlRef.current = new AbortController();
      const res = await fetch(`/api/telemetry/latest?deviceId=${encodeURIComponent(targetDeviceId)}`, {
        signal: abortCtrlRef.current.signal,
        headers: tbToken ? { "x-tb-token": tbToken } : {},
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const json = await res.json();
      if (!activeRef.current || reqGen !== requestGenRef.current) return;

      const data = json.data || {};
      const now = Date.now();

      let hasRecentSample = false;

      // Extract vitals: support both { value, ts } object and array-of-tuples [[ts, val]]
      for (const key of ["ppgHeartRate", "ecgHeartRate", "spo2", "temperature", "battery"]) {
        const item = data[key];
        if (!item) continue;
        let ts, val;
        if (Array.isArray(item) && item.length > 0) {
          if (Array.isArray(item[0])) {
            [ts, val] = item[0];
          } else if (typeof item[0] === "object" && item[0] !== null) {
            ts = item[0].ts;
            val = item[0].value;
          }
        } else if (typeof item === "object" && item !== null) {
          ts = item.ts;
          val = item.value;
        }

        if (ts !== undefined && val !== undefined) {
          const numVal = parseFloat(val);
          const tsNum = Number(ts);
          if (!isNaN(numVal) && !isNaN(tsNum)) {
            pendingVitals.current = mergeVitalsMonotonic(pendingVitals.current, {
              [key]: { value: numVal, ts: tsNum }
            });
            // Passive freshness: sample is genuinely fresh or advancing in real time
            const skewMs = Math.abs(now - tsNum);
            const isFresh = skewMs <= INITIAL_SKEW_MS;
            const isAdvancing = lastActivityRef.current > 0 && tsNum > lastActivityRef.current;
            if (isFresh || isAdvancing) {
              hasRecentSample = true;
            }
            lastActivityRef.current = Math.max(lastActivityRef.current, tsNum);
          }
        }
      }

      // Extract ECG batch: support { value, ts } object or [{ ts, value }] array
      let ecgRaw = null;
      let batchTs = null;
      const ecgItem = data["ecg_batch"];
      if (ecgItem) {
        if (Array.isArray(ecgItem) && ecgItem.length > 0) {
          const first = ecgItem[0];
          if (Array.isArray(first)) {
            batchTs = first[0];
            ecgRaw = first[1];
          } else if (typeof first === "object" && first !== null) {
            batchTs = first.ts;
            ecgRaw = first.value;
          }
        } else if (typeof ecgItem === "object" && ecgItem !== null) {
          batchTs = ecgItem.ts;
          ecgRaw = ecgItem.value;
        }
      }

      if (ecgRaw && batchTs !== null && batchTs !== undefined) {
        const tsNum = Number(batchTs);
        if (!isNaN(tsNum)) {
          // Avoid re-processing the exact same batch if timestamp hasn't advanced
          if (tsNum !== lastBatchTsRef.current) {
            lastBatchTsRef.current = tsNum;
            const ecgSamples = parseWaveformBatch(ecgRaw, tsNum, sampleIntervalMsRef.current);
            for (const pt of ecgSamples) {
              pendingEcg.current.push(pt);
            }
          }
          const isFresh = Math.abs(now - tsNum) <= INITIAL_SKEW_MS;
          const isAdvancing = lastActivityRef.current > 0 && tsNum > lastActivityRef.current;
          if (isFresh || isAdvancing) {
            hasRecentSample = true;
          }
          lastActivityRef.current = Math.max(lastActivityRef.current, tsNum);
        }
      }

      if (hasRecentSample) {
        lastPollSuccessLocalTimeRef.current = Date.now();
        setConnected(true);
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        console.warn("[live-polling] Poll error:", err.message);
      }
    }
  }, [tbToken]);

  useEffect(() => {
    if (!deviceId) return;

    activeRef.current = true;

    // Reset all state and buffers on device or patient change
    setVitals({});
    setEcgData([]);
    setLastBatchTs(null);
    setConnected(false);
    pendingEcg.current     = [];
    pendingVitals.current  = {};
    lastBatchTsRef.current = null;
    lastActivityRef.current = 0;

    startFlushLoop();

    // Initial fetch
    pollTelemetry(deviceId);

    // Schedule 1 Hz polling
    pollTimerRef.current = setInterval(() => {
      pollTelemetry(deviceId);
    }, POLL_INTERVAL_MS);

    return () => {
      activeRef.current = false;
      stopFlushLoop();
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (abortCtrlRef.current) {
        abortCtrlRef.current.abort();
      }
    };
  }, [deviceId, pollTelemetry, startFlushLoop, stopFlushLoop]);

  return { vitals, ecgData, lastBatchTs, connected, lastUpdate };
}
