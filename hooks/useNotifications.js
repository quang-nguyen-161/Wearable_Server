// hooks/useNotifications.js
// Browser push notifications + sound alarm for critical vitals.
// Requests permission once, then fires a notification whenever
// a node crosses a critical threshold.

import { useEffect, useRef, useCallback } from "react";

const THRESHOLDS = {
  heartRate:   { dangerMin:40,  dangerMax:130, label:"Heart Rate",   unit:"bpm" },
  spo2:        { dangerMin:88,  dangerMax:100, label:"SpO₂",         unit:"%"   },
  temperature: { dangerMin:35,  dangerMax:39.5,label:"Temperature",  unit:"°C"  },
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

export function useNotifications(deviceName, vitals, enabled = true) {
  const lastAlerted  = useRef({});   // { key: lastTs } — debounce per key
  const permissionRef = useRef(null);

  // Request permission on mount
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

    for (const [key, t] of Object.entries(THRESHOLDS)) {
      const val = vitals[key]?.value;
      if (val == null) continue;

      const isDangerous = val < t.dangerMin || val > t.dangerMax;
      if (!isDangerous) { delete lastAlerted.current[key]; continue; }

      // Debounce: only alert once per 30 seconds per key
      if (lastAlerted.current[key] && now - lastAlerted.current[key] < 30_000) continue;
      lastAlerted.current[key] = now;

      const direction = val < t.dangerMin ? "LOW" : "HIGH";
      const message   = `${deviceName}: ${t.label} ${direction} — ${val.toFixed(1)} ${t.unit}`;

      // Browser notification
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("⚠ VITALSYNC ALERT", {
          body: message,
          icon: "/favicon.ico",
          tag:  `${deviceName}-${key}`,  // replace previous same-key notification
          requireInteraction: true,
        });
      }

      // Audio beep — two short beeps for critical
      beep(880, 200, 0.4);
      setTimeout(() => beep(880, 200, 0.4), 300);
    }
  }, [vitals, deviceName, enabled]);

  useEffect(() => {
    checkAlerts();
  }, [checkAlerts]);
}