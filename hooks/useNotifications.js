// hooks/useNotifications.js
// Browser push notifications + sound alarm for critical vitals.
// Requests permission once, then fires a notification whenever
// a node crosses a critical threshold.

import { useEffect, useRef, useCallback } from "react";
import { DEFAULT_THRESHOLDS } from "../context/SettingsContext";

const FALLBACK_META = {
  ppgHeartRate: { label: "PPG Heart Rate", unit: "bpm" },
  ecgHeartRate: { label: "ECG Heart Rate", unit: "bpm" },
  spo2:         { label: "SpO₂",           unit: "%"   },
  temperature:  { label: "Temperature",    unit: "°C"  },
};

// Simple beep using Web Audio API — no file needed
function beep(frequency = 880, duration = 400, volume = 0.3) {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration / 1000);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration / 1000);
  } catch (_) {}
}

export function useNotifications(deviceName, vitals, enabled = true, thresholds = DEFAULT_THRESHOLDS) {
  const lastAlerted  = useRef({});
  const permissionRef = useRef(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().then(p => { permissionRef.current = p; });
    } else if ("Notification" in window) {
      permissionRef.current = Notification.permission;
    }
  }, [enabled]);

  const checkAlerts = useCallback(() => {
    if (!enabled || !vitals || !deviceName) return;
    const now = Date.now();

    for (const key of Object.keys(FALLBACK_META)) {
      const t   = thresholds[key] ?? DEFAULT_THRESHOLDS[key];
      const meta = FALLBACK_META[key];
      const val = vitals[key]?.value;
      if (val == null) continue;

      const isDangerous = val < t.dangerMin || val > t.dangerMax;
      if (!isDangerous) { delete lastAlerted.current[key]; continue; }

      if (lastAlerted.current[key] && now - lastAlerted.current[key] < 30_000) continue;
      lastAlerted.current[key] = now;

      const direction = val < t.dangerMin ? "LOW" : "HIGH";
      const message   = `${deviceName}: ${meta.label} ${direction} — ${val.toFixed(1)} ${meta.unit}`;

      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("⚠ VITALSYNC ALERT", {
          body: message,
          icon: "/favicon.ico",
          tag:  `${deviceName}-${key}`,
          requireInteraction: true,
        });
      }

      beep(880, 200, 0.4);
      setTimeout(() => beep(880, 200, 0.4), 300);
    }
  }, [vitals, deviceName, enabled, thresholds]);

  useEffect(() => {
    checkAlerts();
  }, [checkAlerts]);
}