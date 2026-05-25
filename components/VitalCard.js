// components/VitalCard.js
import { useEffect, useState } from "react";

/**
 * Determines status and percentage within range for a vital.
 */
function getVitalStatus(value, min, max, critMin, critMax) {
  if (value === null || value === undefined) return { status: "normal", pct: 0 };
  const pct = Math.min(100, Math.max(0, ((value - critMin) / (critMax - critMin)) * 100));
  if (value < critMin || value > critMax) return { status: "critical", pct };
  if (value < min || value > max) return { status: "warning", pct };
  return { status: "normal", pct };
}

const STATUS_LABELS = {
  normal: "NORMAL",
  warning: "CAUTION",
  critical: "ALERT",
};

export default function VitalCard({
  label,
  icon,
  value,
  unit,
  color = "cyan",
  min,
  max,
  critMin,
  critMax,
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

  const { status, pct } = getVitalStatus(
    displayValue,
    min,
    max,
    critMin ?? min - (max - min) * 0.3,
    critMax ?? max + (max - min) * 0.3
  );

  const isAlert = status === "critical";

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

      <div className="card-range">
        <div className="range-bar-bg">
          <div
            className="range-bar-fill"
            style={{ width: `${loading ? 0 : pct}%` }}
          />
        </div>
        <span className="range-pct">{Math.round(pct)}%</span>
      </div>

      <span className={`card-status ${status}`}>{STATUS_LABELS[status]}</span>
    </div>
  );
}
