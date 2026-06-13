// components/VitalCard.js
import { useEffect, useState } from "react";

/**
 * Determines status and percentage within range for a vital.
 */
function getVitalStatus(value, min, max, warnMin, warnMax, dangerMin, dangerMax) {
  if (value === null || value === undefined) return "normal";
  if (value < dangerMin || value > dangerMax) return "dangerous";
  if (value < warnMin   || value > warnMax)   return "dangerous";
  if (value < min       || value > max)        return "warning";
  return "normal";
}

const STATUS_LABELS = {
  normal:    "NORMAL",
  warning:   "WARNING",
  dangerous: "DANGEROUS",
  nodata:    "NO DATA",
  offline:   "OFFLINE",
};

export default function VitalCard({
  label,
  icon,
  value,
  unit,
  color = "cyan",
  min,
  max,
  warnMin,
  warnMax,
  dangerMin,
  dangerMax,
  loading = false,
  offline = false,
  animDelay = 0,
  onSelect,
}) {
  const [displayValue, setDisplayValue] = useState(null);
  const [prevValue, setPrevValue] = useState(null);
  const [confirmedStatus, setConfirmedStatus] = useState("nodata");
  const [streak, setStreak] = useState({ status: null, count: 0 });

  useEffect(() => {
    if (value !== null && value !== undefined) {
      setPrevValue(displayValue);
      setDisplayValue(value);
    } else {
      setDisplayValue(null);
    }
  }, [value]);

  const _warnMin   = warnMin   ?? min   - (max - min) * 0.25;
  const _warnMax   = warnMax   ?? max   + (max - min) * 0.25;
  const _dangerMin = dangerMin ?? min   - (max - min) * 0.5;
  const _dangerMax = dangerMax ?? max   + (max - min) * 0.5;

  // Device offline → show "––" instead of the last received value.
  const effectiveValue = offline ? null : displayValue;

  // No reading available (param never reported, or device offline) → neutral status, never an alert.
  const hasValue = effectiveValue !== null && effectiveValue !== undefined;
  const rawStatus = hasValue
    ? getVitalStatus(effectiveValue, min, max, _warnMin, _warnMax, _dangerMin, _dangerMax)
    : (offline ? "offline" : "nodata");

  // Require 5 consecutive readings of "warning"/"dangerous" before surfacing it,
  // so a single noisy/outlier sample doesn't flip the badge.
  const REQUIRED_STREAK = 5;
  useEffect(() => {
    if (rawStatus === "warning" || rawStatus === "dangerous") {
      setStreak(prev => {
        const count = prev.status === rawStatus ? prev.count + 1 : 1;
        if (count >= REQUIRED_STREAK) setConfirmedStatus(rawStatus);
        return { status: rawStatus, count };
      });
    } else {
      setStreak({ status: null, count: 0 });
      setConfirmedStatus(rawStatus);
    }
  }, [rawStatus]);

  const status = confirmedStatus;
  const isAlert = hasValue && status === "dangerous";

  return (
    <div
      className={`vital-card color-${color} ${isAlert ? "alert" : ""}`}
      style={{ animationDelay: `${animDelay}ms` }}
      onClick={() => onSelect && onSelect(label)}
      role="button"
      tabIndex={0}
      aria-label={`${label}: ${effectiveValue ?? "loading"} ${unit}`}
    >
      <div className="card-header">
        <span className="card-icon">{icon}</span>
        {isAlert && <span className="card-alert-badge">⚠ Alert</span>}
      </div>

      <div className="card-label">{label}</div>

      <div className="card-value-row">
        <span className={`card-value${loading && effectiveValue === null ? " loading" : ""}`}>
          {loading && effectiveValue === null ? "––" : effectiveValue ?? "––"}
        </span>
        <span className="card-unit">{unit}</span>
      </div>

      <span className={`card-status ${status}`}>{STATUS_LABELS[status]}</span>
    </div>
  );
}
