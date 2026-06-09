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
  animDelay = 0,
  onSelect,
}) {
  const [displayValue, setDisplayValue] = useState(null);
  const [prevValue, setPrevValue] = useState(null);

  useEffect(() => {
    if (value !== null && value !== undefined) {
      setPrevValue(displayValue);
      setDisplayValue(value);
    }
  }, [value]);

  const _warnMin   = warnMin   ?? min   - (max - min) * 0.25;
  const _warnMax   = warnMax   ?? max   + (max - min) * 0.25;
  const _dangerMin = dangerMin ?? min   - (max - min) * 0.5;
  const _dangerMax = dangerMax ?? max   + (max - min) * 0.5;
  const status = getVitalStatus(displayValue, min, max, _warnMin, _warnMax, _dangerMin, _dangerMax);

  const isAlert = status === "dangerous";

  return (
    <div
      className={`vital-card color-${color} ${isAlert ? "alert" : ""}`}
      style={{ animationDelay: `${animDelay}ms` }}
      onClick={() => onSelect && onSelect(label)}
      role="button"
      tabIndex={0}
      aria-label={`${label}: ${displayValue ?? "loading"} ${unit}`}
    >
      <div className="card-header">
        <span className="card-icon">{icon}</span>
        {isAlert && <span className="card-alert-badge">⚠ Alert</span>}
      </div>

      <div className="card-label">{label}</div>

      <div className="card-value-row">
        <span className={`card-value${loading && displayValue === null ? " loading" : ""}`}>
          {loading && displayValue === null ? "––" : displayValue ?? "––"}
        </span>
        <span className="card-unit">{unit}</span>
      </div>

      <span className={`card-status ${status}`}>{STATUS_LABELS[status]}</span>
    </div>
  );
}
