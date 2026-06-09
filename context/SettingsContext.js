// context/SettingsContext.js
// Global settings store — loads per-device settings from ThingsBoard once and
// caches them so every page/component can read vitalInterval, thresholds, etc.
// Settings page calls updateSettings() after a save so consumers see the new
// values immediately without a round-trip.

import { createContext, useContext, useRef, useState, useCallback } from "react";
import { useTbAuth } from "./TbAuthContext";
import { getDeviceAttributes } from "../lib/tbBrowserClient";

export const DEFAULT_THRESHOLDS = {
  ppgHeartRate: { normalMin: 60,   normalMax: 100,  warnMin: 50,   warnMax: 120,  dangerMin: 40,   dangerMax: 130  },
  ecgHeartRate: { normalMin: 60,   normalMax: 100,  warnMin: 50,   warnMax: 120,  dangerMin: 40,   dangerMax: 130  },
  spo2:         { normalMin: 95,   normalMax: 100,  warnMin: 90,   warnMax: 100,  dangerMin: 88,   dangerMax: 100  },
  temperature:  { normalMin: 36.1, normalMax: 37.2, warnMin: 35.5, warnMax: 38.5, dangerMin: 35.0, dangerMax: 39.5 },
};

export const DEFAULT_SETTINGS = {
  vitalInterval:     1000,
  ecgSampleFreq:     250,
  ecgPacketInterval: 20,
  ppgSampleFreq:     100,
  ppgRedLedMa:       6,
  ppgIrLedMa:        6,
  thresholds:        DEFAULT_THRESHOLDS,
};

export const SettingsContext = createContext(null);

// ── Provider ──────────────────────────────────────────────────────────────────
export function SettingsProvider({ children }) {
  const { token } = useTbAuth();
  const cacheRef = useRef({});          // deviceId → settings (avoids stale-closure guard)
  const [cache, setCache] = useState({}); // same data, but triggers re-renders

  const _writeCache = useCallback((deviceId, settings) => {
    cacheRef.current[deviceId] = settings;
    setCache(prev => ({ ...prev, [deviceId]: settings }));
  }, []);

  // Load settings for a device (no-op if already cached)
  const loadSettings = useCallback(async (deviceId) => {
    if (!deviceId || cacheRef.current[deviceId] || !token) return;
    try {
      const a = await getDeviceAttributes(token, deviceId);

      const settings = {
        vitalInterval:     a.vitalInterval     ?? DEFAULT_SETTINGS.vitalInterval,
        ecgSampleFreq:     a.ecgSampleFreq     ?? DEFAULT_SETTINGS.ecgSampleFreq,
        ecgPacketInterval: a.ecgPacketInterval ?? DEFAULT_SETTINGS.ecgPacketInterval,
        ppgSampleFreq:     a.ppgSampleFreq     ?? DEFAULT_SETTINGS.ppgSampleFreq,
        ppgRedLedMa:       a.ppgRedLedMa       ?? DEFAULT_SETTINGS.ppgRedLedMa,
        ppgIrLedMa:        a.ppgIrLedMa        ?? DEFAULT_SETTINGS.ppgIrLedMa,
        thresholds: {
          ppgHeartRate: {
            normalMin: a.ppgHr_normalMin ?? DEFAULT_THRESHOLDS.ppgHeartRate.normalMin,
            normalMax: a.ppgHr_normalMax ?? DEFAULT_THRESHOLDS.ppgHeartRate.normalMax,
            warnMin:   a.ppgHr_warnMin   ?? DEFAULT_THRESHOLDS.ppgHeartRate.warnMin,
            warnMax:   a.ppgHr_warnMax   ?? DEFAULT_THRESHOLDS.ppgHeartRate.warnMax,
            dangerMin: a.ppgHr_dangerMin ?? DEFAULT_THRESHOLDS.ppgHeartRate.dangerMin,
            dangerMax: a.ppgHr_dangerMax ?? DEFAULT_THRESHOLDS.ppgHeartRate.dangerMax,
          },
          ecgHeartRate: {
            normalMin: a.ecgHr_normalMin ?? DEFAULT_THRESHOLDS.ecgHeartRate.normalMin,
            normalMax: a.ecgHr_normalMax ?? DEFAULT_THRESHOLDS.ecgHeartRate.normalMax,
            warnMin:   a.ecgHr_warnMin   ?? DEFAULT_THRESHOLDS.ecgHeartRate.warnMin,
            warnMax:   a.ecgHr_warnMax   ?? DEFAULT_THRESHOLDS.ecgHeartRate.warnMax,
            dangerMin: a.ecgHr_dangerMin ?? DEFAULT_THRESHOLDS.ecgHeartRate.dangerMin,
            dangerMax: a.ecgHr_dangerMax ?? DEFAULT_THRESHOLDS.ecgHeartRate.dangerMax,
          },
          spo2: {
            normalMin: a.spo2_normalMin ?? DEFAULT_THRESHOLDS.spo2.normalMin,
            normalMax: a.spo2_normalMax ?? DEFAULT_THRESHOLDS.spo2.normalMax,
            warnMin:   a.spo2_warnMin   ?? DEFAULT_THRESHOLDS.spo2.warnMin,
            warnMax:   a.spo2_warnMax   ?? DEFAULT_THRESHOLDS.spo2.warnMax,
            dangerMin: a.spo2_dangerMin ?? DEFAULT_THRESHOLDS.spo2.dangerMin,
            dangerMax: a.spo2_dangerMax ?? DEFAULT_THRESHOLDS.spo2.dangerMax,
          },
          temperature: {
            normalMin: a.temp_normalMin ?? DEFAULT_THRESHOLDS.temperature.normalMin,
            normalMax: a.temp_normalMax ?? DEFAULT_THRESHOLDS.temperature.normalMax,
            warnMin:   a.temp_warnMin   ?? DEFAULT_THRESHOLDS.temperature.warnMin,
            warnMax:   a.temp_warnMax   ?? DEFAULT_THRESHOLDS.temperature.warnMax,
            dangerMin: a.temp_dangerMin ?? DEFAULT_THRESHOLDS.temperature.dangerMin,
            dangerMax: a.temp_dangerMax ?? DEFAULT_THRESHOLDS.temperature.dangerMax,
          },
        },
      };

      _writeCache(deviceId, settings);
    } catch (e) {
      console.error("[SettingsContext] loadSettings failed:", e);
    }
  }, [_writeCache]);

  // Push new settings into cache (call this after a successful TB save)
  const updateSettings = useCallback((deviceId, settings) => {
    if (!deviceId) return;
    _writeCache(deviceId, settings);
  }, [_writeCache]);

  // Read cached settings (returns defaults if not yet loaded)
  const getSettings = useCallback((deviceId) => {
    return (deviceId && cache[deviceId]) ? cache[deviceId] : DEFAULT_SETTINGS;
  }, [cache]);

  return (
    <SettingsContext.Provider value={{ loadSettings, updateSettings, getSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useSettings(deviceId) {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be inside SettingsProvider");
  // Destructure stable refs so the wrappers below don't recreate on every render
  const { loadSettings: load, updateSettings: update, getSettings: get } = ctx;
  return {
    settings:       get(deviceId),
    loadSettings:   useCallback(() => load(deviceId), [load, deviceId]),
    updateSettings: useCallback((s) => update(deviceId, s), [update, deviceId]),
  };
}
