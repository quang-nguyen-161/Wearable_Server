// components/OverviewGrid.js
// Shows all nodes in a compact grid — each card shows 3 vitals + alert status.
// Click a node card to navigate to it in the main dashboard.

import { DEFAULT_THRESHOLDS } from "../context/SettingsContext";

const VITAL_META = {
  ppgHeartRate: { label: "PPG HR", unit: "bpm", color: "#5B9BD5" },
  ecgHeartRate: { label: "ECG HR", unit: "bpm", color: "#00c8ff" },
  spo2:         { label: "SpO₂",   unit: "%",   color: "#70AD47" },
  temperature:  { label: "Temp",   unit: "°C",  color: "#FFC000" },
};

function getStatus(key, value, thresholds) {
  const t = thresholds?.[key] ?? DEFAULT_THRESHOLDS[key];
  if (!t || value == null) return "none";
  if (value < t.dangerMin || value > t.dangerMax) return "dangerous";
  if (value < t.warnMin   || value > t.warnMax)   return "dangerous";
  if (value < t.normalMin || value > t.normalMax)  return "warning";
  return "normal";
}

function StatusDot({ status }) {
  const colors = { dangerous: "#ef4444", warning: "#f59e0b", normal: "#22c55e", none: "#cbd5e1" };
  return (
    <span style={{
      display: "inline-block", width: 8, height: 8, borderRadius: "50%",
      background: colors[status] || "#cbd5e1",
      boxShadow: status === "critical" ? `0 0 6px ${colors.critical}` : "none",
    }} />
  );
}

export default function OverviewGrid({ devices, vitalsMap, onSelectDevice, selectedDeviceId, settingsMap }) {
  if (!devices?.length) return null;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
      gap: 12, padding: "16px 24px",
      borderBottom: "1px solid var(--border, #e2e8f0)",
      background: "var(--bg-void, #f8f9fa)",
    }}>
      {devices.map(device => {
        const vitals     = vitalsMap[device.id] || {};
        const isSelected = device.id === selectedDeviceId;
        const thresholds = settingsMap?.[device.id]?.thresholds;
        const vitalInterval = settingsMap?.[device.id]?.vitalInterval;
        const staleMs = Math.max((vitalInterval || 0) * 3, 10000);

        // A vital is "stale" (sensor/mode stopped reporting it) → treat as no reading.
        const getVal = (key) => {
          const entry = vitals[key];
          if (!entry || entry.value == null) return null;
          if (Date.now() - entry.ts > staleMs) return null;
          return entry.value;
        };

        // Overall alert level
        const statuses = Object.keys(DEFAULT_THRESHOLDS).map(key =>
          getStatus(key, device.online ? getVal(key) : null, thresholds)
        );
        const hasAlert     = statuses.includes("dangerous") || statuses.includes("warning");
        const hasDangerous = statuses.includes("dangerous");

        return (
          <button
            key={device.id}
            onClick={() => onSelectDevice(device.id)}
            style={{
              background: isSelected
                ? "rgba(0,200,255,0.07)"
                : "var(--bg-card, #fff)",
              border: `1.5px solid ${hasDangerous ? "#ef4444" : isSelected ? "#00c8ff" : "var(--border, #e2e8f0)"}`,
              borderRadius: 12, padding: "12px 14px",
              cursor: "pointer", textAlign: "left",
              fontFamily: "inherit",
              transition: "all 0.15s",
              boxShadow: hasDangerous ? "0 0 0 3px rgba(239,68,68,0.12)" :
                         isSelected  ? "0 0 0 3px rgba(0,200,255,0.15)" : "none",
            }}
          >
            {/* Node header */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom: 10 }}>
              <div style={{ display:"flex", alignItems:"center", gap: 6 }}>
                <span style={{ fontSize: 14 }}>📡</span>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, letterSpacing:"0.04em",
                    color: isSelected ? "#00c8ff" : "var(--text-primary, #1e293b)" }}>
                    {device.patientName || device.name}
                  </div>
                  {device.patientName && (
                    <div style={{ fontSize: 9, color: "var(--text-muted, #94a3b8)", marginTop: 1, letterSpacing:"0.03em" }}>
                      {device.name}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display:"flex", alignItems:"center", gap: 5 }}>
                {hasDangerous && (
                  <span style={{ fontSize: 9, fontWeight: 700, color: "#ef4444",
                    background: "rgba(239,68,68,0.1)", borderRadius: 4, padding: "2px 5px",
                    letterSpacing: "0.06em", animation: "blink 1s ease infinite" }}>
                    ALERT
                  </span>
                )}
                <span style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: "0.08em",
                  color: device.online ? "#22c55e" : "#94a3b8",
                  background: device.online ? "rgba(34,197,94,0.1)" : "rgba(148,163,184,0.1)",
                  borderRadius: 10, padding: "2px 6px",
                }}>
                  {device.online ? "LIVE" : "OFFLINE"}
                </span>
              </div>
            </div>

            {/* Vitals row — 2×2 grid for 4 vitals */}
            <div style={{ display:"grid", gridTemplateColumns:"repeat(2,1fr)", gap: 6 }}>
              {Object.entries(VITAL_META).map(([key, meta]) => {
                const val    = device.online ? getVal(key) : null;
                const status = getStatus(key, val, thresholds);
                return (
                  <div key={key} style={{
                    background: "var(--bg-void, #f8fafc)",
                    borderRadius: 7, padding: "6px 8px",
                    border: "0.5px solid var(--border, #e2e8f0)",
                  }}>
                    <div style={{ fontSize: 9, color: "var(--text-muted, #94a3b8)",
                      fontWeight: 600, letterSpacing:"0.06em", marginBottom: 3,
                      display:"flex", alignItems:"center", gap: 3 }}>
                      <StatusDot status={status} />
                      {meta.label}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: meta.color, lineHeight: 1 }}>
                      {val != null ? val.toFixed(key === "ppgHeartRate" || key === "ecgHeartRate" ? 0 : 1) : "—"}
                      <span style={{ fontSize: 9, fontWeight: 400, marginLeft: 2,
                        color: "var(--text-muted, #94a3b8)" }}>{meta.unit}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </button>
        );
      })}
      <style>{`
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.4} }
      `}</style>
    </div>
  );
}