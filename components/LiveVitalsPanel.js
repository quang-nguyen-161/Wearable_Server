// components/LiveVitalsPanel.js
// Dedicated component managing the 1s freshness tick for live vital cards (Task 5)
// Prevents root Dashboard and ECG Canvas chart re-renders every 1,000ms.

import React, { useState, useEffect, useRef } from "react";
import VitalCard from "./VitalCard";
import { getFreshVitalValue, evaluateDeviceAlert } from "../lib/vitalsFreshness.mjs";

export default function LiveVitalsPanel({
  selectedDeviceId,
  vitals,
  trends = {},
  settings,
  connected,
  selectedDevice,
  vitalsDef = [],
  onOpenVitalModal,
  onAlertChange,
}) {
  // Local 1-second clock isolated to this sub-tree
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Alert tracking: evaluate with current clock, but ONLY call parent onAlertChange when status changes
  const prevAlertRef = useRef(false);
  useEffect(() => {
    if (!selectedDeviceId || !vitals || !onAlertChange) return;

    const hasAlert = evaluateDeviceAlert(
      vitals,
      settings?.thresholds,
      selectedDevice?.online !== false,
      now,
      settings?.vitalInterval
    );

    if (prevAlertRef.current !== hasAlert) {
      prevAlertRef.current = hasAlert;
      onAlertChange(selectedDeviceId, hasAlert);
    }
  }, [selectedDeviceId, vitals, selectedDevice?.online, settings?.thresholds, settings?.vitalInterval, now, onAlertChange]);

  // Reset alert tracking ref when device changes
  useEffect(() => {
    prevAlertRef.current = false;
  }, [selectedDeviceId]);

  if (!selectedDeviceId) return null;

  return (
    <>
      {vitalsDef.map((v, i) => {
        const trend = trends[v.key];
        const trendIcon = trend === "up" ? "↑" : trend === "down" ? "↓" : null;
        const trendColor = trend === "up" ? "#ef4444" : trend === "down" ? "#3b82f6" : null;
        const t = settings?.thresholds?.[v.key];
        const freshVal = getFreshVitalValue(vitals?.[v.key], now, settings?.vitalInterval);

        return (
          <div
            key={`${selectedDeviceId}-${v.key}`}
            onClick={() => onOpenVitalModal && onOpenVitalModal({ vitalKey: v.key })}
            style={{ cursor: "pointer", position: "relative" }}
            title="Click to view history"
          >
            {trendIcon && (
              <div
                style={{
                  position: "absolute",
                  top: 10,
                  right: 12,
                  fontSize: 18,
                  fontWeight: 700,
                  color: trendColor,
                  zIndex: 2,
                  lineHeight: 1,
                  pointerEvents: "none",
                }}
              >
                {trendIcon}
              </div>
            )}
            <VitalCard
              label={v.label}
              icon={v.icon}
              unit={v.unit}
              color={v.color}
              min={t?.normalMin ?? v.min}
              max={t?.normalMax ?? v.max}
              warnMin={t?.warnMin ?? v.warnMin}
              warnMax={t?.warnMax ?? v.warnMax}
              dangerMin={t?.dangerMin ?? v.dangerMin}
              dangerMax={t?.dangerMax ?? v.dangerMax}
              value={freshVal}
              loading={!connected && freshVal === null}
              offline={selectedDevice?.online === false}
              animDelay={i * 60}
            />
          </div>
        );
      })}
    </>
  );
}
