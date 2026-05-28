// components/NodeDetailModal.js
// Popup modal showing full vitals + ECG/PPG history for a selected node.
// Fetches historical data from /api/telemetry/history when opened.

import { useState, useEffect, useCallback } from "react";
import TrendChart from "./TrendChart";

const TIME_RANGES = [
  { label: "15 min", hours: 0.25 },
  { label: "1 hour", hours: 1 },
  { label: "6 hours", hours: 6 },
  { label: "24 hours", hours: 24 },
];

const VITALS_CONFIG = [
  { key: "heartRate",   label: "HEART RATE", unit: "bpm", color: "#00c8ff", min: 60,   max: 100,  warnMin: 50,  warnMax: 120, dangerMin: 40,  dangerMax: 130  },
  { key: "spo2",        label: "SPO₂",       unit: "%",   color: "#22c55e", min: 95,   max: 100,  warnMin: 90,  warnMax: 100, dangerMin: 88,  dangerMax: 100  },
  { key: "temperature", label: "TEMP",       unit: "°C",  color: "#f59e0b", min: 36.1, max: 37.2, warnMin: 35.5,warnMax: 38.5,dangerMin: 35.0,dangerMax: 39.5 },
];

function getStatus(key, value) {
  const v = VITALS_CONFIG.find(c => c.key === key);
  if (!v || value == null) return "—";
  if (value < v.dangerMin || value > v.dangerMax) return "DANGEROUS";
  if (value < v.warnMin   || value > v.warnMax)   return "DANGEROUS";
  if (value < v.min       || value > v.max)        return "WARNING";
  return "NORMAL";
}

function getStatusColor(status) {
  if (status === "CRITICAL") return "#ef4444";
  if (status === "WARNING")  return "#f59e0b";
  return "#22c55e";
}

export default function NodeDetailModal({ device, vitals, onClose }) {
  const [rangeIdx,      setRangeIdx]      = useState(1); // default 1 hour
  const [ecgHistory,    setEcgHistory]    = useState([]);
  const [ppgHistory,    setPpgHistory]    = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [activeTab,     setActiveTab]     = useState("ecg");

  const fetchHistory = useCallback(async (hours) => {
    if (!device?.id) return;
    setHistoryLoading(true);
    try {
      const [ecgRes, ppgRes] = await Promise.all([
        fetch(`/api/telemetry/history?deviceId=${device.id}&key=ecg&hours=${hours}&limit=2000`),
        fetch(`/api/telemetry/history?deviceId=${device.id}&key=ppg&hours=${hours}&limit=2000`),
      ]);
      if (ecgRes.ok) setEcgHistory((await ecgRes.json()).series || []);
      if (ppgRes.ok) setPpgHistory((await ppgRes.json()).series || []);
    } catch (e) {
      console.error("History fetch error:", e);
    } finally {
      setHistoryLoading(false);
    }
  }, [device?.id]);

  useEffect(() => {
    fetchHistory(TIME_RANGES[rangeIdx].hours);
  }, [rangeIdx, fetchHistory]);

  // Close on backdrop click
  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (!device) return null;

  return (
    <div className="modal-backdrop" onClick={handleBackdrop}>
      <div className="modal-box">

        {/* ── Header ── */}
        <div className="modal-header">
          <div className="modal-title-group">
            <span className="modal-icon">📡</span>
            <div>
              <div className="modal-device-name">{device.displayName || device.name}</div>
              <div className="modal-device-id">{device.name} · {device.id}</div>
            </div>
            <span className="modal-live-pill">LIVE</span>
          </div>
          <div className="modal-header-right">
            <div className="range-tabs">
              {TIME_RANGES.map((r, i) => (
                <button
                  key={r.label}
                  className={`range-tab ${rangeIdx === i ? "range-tab--active" : ""}`}
                  onClick={() => setRangeIdx(i)}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        {/* ── Vital cards ── */}
        <div className="modal-vitals">
          {VITALS_CONFIG.map(v => {
            const val    = vitals[v.key]?.value;
            const status = getStatus(v.key, val);
            return (
              <div className="modal-vital-card" key={v.key}>
                <div className="modal-vital-label">{v.label}</div>
                <div className="modal-vital-value" style={{ color: v.color }}>
                  {val != null ? val.toFixed(v.key === "heartRate" ? 0 : 1) : "—"}
                  <span className="modal-vital-unit">{v.unit}</span>
                </div>
                <div className="modal-vital-status" style={{ color: getStatusColor(status) }}>
                  ● {status}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Signal tabs ── */}
        <div className="modal-signal-tabs">
          <button
            className={`signal-tab ${activeTab === "ecg" ? "signal-tab--active" : ""}`}
            onClick={() => setActiveTab("ecg")}
          >
            ECG Signal
          </button>
          <button
            className={`signal-tab ${activeTab === "ppg" ? "signal-tab--active" : ""}`}
            onClick={() => setActiveTab("ppg")}
          >
            PPG Signal
          </button>
          <span className="signal-range-label">{TIME_RANGES[rangeIdx].label} history</span>
        </div>

        {/* ── Chart ── */}
        <div className="modal-chart">
          <TrendChart
            series={activeTab === "ecg" ? ecgHistory : ppgHistory}
            metricKey={activeTab}
            loading={historyLoading}
          />
        </div>

      </div>

      <style jsx>{`
        .modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.55);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          padding: 16px;
          backdrop-filter: blur(2px);
        }

        .modal-box {
          background: var(--card-bg, #fff);
          border-radius: 16px;
          border: 1px solid var(--border, #e2e8f0);
          width: 100%;
          max-width: 780px;
          max-height: 90vh;
          overflow-y: auto;
          animation: modal-in 0.18s ease;
        }

        @keyframes modal-in {
          from { opacity: 0; transform: scale(0.96) translateY(8px); }
          to   { opacity: 1; transform: scale(1)    translateY(0);   }
        }

        .modal-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border, #e2e8f0);
          gap: 12px;
          flex-wrap: wrap;
        }

        .modal-title-group {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .modal-icon { font-size: 20px; }

        .modal-device-name {
          font-size: 15px;
          font-weight: 700;
          letter-spacing: 0.04em;
          color: var(--text, #1e293b);
        }

        .modal-device-id {
          font-size: 11px;
          color: var(--text-muted, #94a3b8);
          font-family: monospace;
        }

        .modal-live-pill {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.08em;
          color: #22c55e;
          background: rgba(34, 197, 94, 0.12);
          border-radius: 20px;
          padding: 3px 8px;
        }

        .modal-header-right {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .range-tabs {
          display: flex;
          gap: 4px;
          background: var(--surface-2, #f1f5f9);
          border-radius: 8px;
          padding: 3px;
        }

        .range-tab {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.04em;
          padding: 4px 10px;
          border-radius: 6px;
          border: none;
          background: transparent;
          color: var(--text-muted, #94a3b8);
          cursor: pointer;
          transition: all 0.15s;
          font-family: inherit;
        }

        .range-tab--active {
          background: var(--card-bg, #fff);
          color: var(--text, #1e293b);
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }

        .modal-close {
          font-size: 22px;
          line-height: 1;
          background: none;
          border: none;
          cursor: pointer;
          color: var(--text-muted, #94a3b8);
          padding: 4px 6px;
          border-radius: 6px;
          transition: background 0.15s;
          font-family: inherit;
        }

        .modal-close:hover { background: var(--surface-2, #f1f5f9); }

        .modal-vitals {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 12px;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border, #e2e8f0);
        }

        .modal-vital-card {
          background: var(--surface-2, #f8fafc);
          border-radius: 10px;
          padding: 14px 16px;
          border: 1px solid var(--border, #e2e8f0);
        }

        .modal-vital-label {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.1em;
          color: var(--text-muted, #94a3b8);
          margin-bottom: 6px;
        }

        .modal-vital-value {
          font-size: 26px;
          font-weight: 700;
          line-height: 1;
          margin-bottom: 6px;
        }

        .modal-vital-unit {
          font-size: 13px;
          font-weight: 400;
          opacity: 0.7;
          margin-left: 2px;
        }

        .modal-vital-status {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.08em;
        }

        .modal-signal-tabs {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 12px 20px 0;
        }

        .signal-tab {
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.04em;
          padding: 6px 14px;
          border-radius: 8px 8px 0 0;
          border: 1px solid transparent;
          border-bottom: none;
          background: transparent;
          color: var(--text-muted, #94a3b8);
          cursor: pointer;
          transition: all 0.15s;
          font-family: inherit;
        }

        .signal-tab--active {
          background: var(--card-bg, #fff);
          border-color: var(--border, #e2e8f0);
          color: var(--text, #1e293b);
        }

        .signal-range-label {
          margin-left: auto;
          font-size: 10px;
          letter-spacing: 0.08em;
          color: var(--text-muted, #94a3b8);
          font-weight: 600;
          padding-right: 4px;
        }

        .modal-chart {
          padding: 0 20px 20px;
          border-top: 1px solid var(--border, #e2e8f0);
          min-height: 200px;
        }

        /* Dark mode */
        :global([data-theme="dark"]) .modal-box {
          background: #1e293b;
          border-color: #334155;
        }
        :global([data-theme="dark"]) .modal-header,
        :global([data-theme="dark"]) .modal-vitals,
        :global([data-theme="dark"]) .modal-chart {
          border-color: #334155;
        }
        :global([data-theme="dark"]) .modal-device-name { color: #e2e8f0; }
        :global([data-theme="dark"]) .modal-vital-card {
          background: #0f172a;
          border-color: #334155;
        }
        :global([data-theme="dark"]) .range-tabs { background: #0f172a; }
        :global([data-theme="dark"]) .range-tab--active { background: #1e293b; color: #e2e8f0; }
        :global([data-theme="dark"]) .signal-tab--active {
          background: #1e293b;
          border-color: #334155;
          color: #e2e8f0;
        }
        :global([data-theme="dark"]) .modal-close:hover { background: #334155; }
      `}</style>
    </div>
  );
}