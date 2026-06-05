// components/NodeDetailModal.js
// Popup modal showing full vitals + ECG/PPG history for a selected node.
// Fetches historical data from /api/telemetry/history when opened.

import { useState, useEffect } from "react";
import { useTbAuth } from "../context/TbAuthContext";
import { getDeviceAttributes, saveDeviceAttributes } from "../lib/tbBrowserClient";

const VITALS_CONFIG = [
  { key: "ppgHeartRate", label: "PPG HEART RATE", unit: "bpm", color: "#5B9BD5", min: 60,   max: 100,  warnMin: 50,  warnMax: 120, dangerMin: 40,  dangerMax: 130  },
  { key: "ecgHeartRate", label: "ECG HEART RATE", unit: "bpm", color: "#00c8ff", min: 60,   max: 100,  warnMin: 50,  warnMax: 120, dangerMin: 40,  dangerMax: 130  },
  { key: "spo2",         label: "SPO₂",           unit: "%",   color: "#22c55e", min: 95,   max: 100,  warnMin: 90,  warnMax: 100, dangerMin: 88,  dangerMax: 100  },
  { key: "temperature",  label: "TEMP",           unit: "°C",  color: "#f59e0b", min: 36.1, max: 37.2, warnMin: 35.5,warnMax: 38.5,dangerMin: 35.0,dangerMax: 39.5 },
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
  const { token } = useTbAuth();
  const [bleAddr,       setBleAddr]       = useState("");
  const [bleInput,      setBleInput]      = useState("");
  const [bleEditing,    setBleEditing]    = useState(false);
  const [bleSaving,     setBleSaving]     = useState(false);
  const [bleSaved,      setBleSaved]      = useState(false);

  // Load BLE address from ThingsBoard SHARED_SCOPE attributes
  useEffect(() => {
    if (!device?.id || !token) return;
    getDeviceAttributes(token, device.id)
      .then(attrs => {
        const addr = attrs.bleAddress || "";
        setBleAddr(addr);
        setBleInput(addr);
      })
      .catch(() => {});
  }, [device?.id, token]);

  const saveBleAddr = async () => {
    const trimmed = bleInput.trim().toLowerCase();
    if (!trimmed) return;
    setBleSaving(true);
    try {
      await saveDeviceAttributes(token, device.id, "SHARED_SCOPE", { bleAddress: trimmed });
      setBleAddr(trimmed);
      setBleEditing(false);
      setBleSaved(true);
      setTimeout(() => setBleSaved(false), 2000);
    } catch (e) {
      console.error("Save BLE address:", e);
    } finally {
      setBleSaving(false);
    }
  };

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
              <div className="modal-device-name">{device.patientName || device.name}</div>
              <div className="modal-device-id">{device.name} · {device.id}</div>
              <div className="modal-ble-row">
                <span className="ble-label">BLE</span>
                {bleEditing ? (
                  <>
                    <input
                      className="ble-input"
                      value={bleInput}
                      onChange={e => setBleInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") saveBleAddr();
                        if (e.key === "Escape") { setBleEditing(false); setBleInput(bleAddr); }
                      }}
                      placeholder="xx:xx:xx:xx:xx:xx"
                      spellCheck={false}
                      autoFocus
                    />
                    <button className="ble-btn ble-btn--save" onClick={saveBleAddr} disabled={bleSaving}>
                      {bleSaving ? "…" : "Save"}
                    </button>
                    <button className="ble-btn ble-btn--cancel" onClick={() => { setBleEditing(false); setBleInput(bleAddr); }}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <span className="ble-addr">{bleAddr || "not set"}</span>
                    {bleSaved && <span className="ble-saved">Saved</span>}
                    <button className="ble-btn ble-btn--edit" onClick={() => { setBleEditing(true); setBleInput(bleAddr); }}>
                      Edit
                    </button>
                  </>
                )}
              </div>
            </div>
            <span className="modal-live-pill">LIVE</span>
          </div>
          <div className="modal-header-right">
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
                  {val != null ? val.toFixed(v.key === "ppgHeartRate" || v.key === "ecgHeartRate" ? 0 : 1) : "—"}
                  <span className="modal-vital-unit">{v.unit}</span>
                </div>
                <div className="modal-vital-status" style={{ color: getStatusColor(status) }}>
                  ● {status}
                </div>
              </div>
            );
          })}
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

        .modal-ble-row {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-top: 4px;
        }

        .ble-label {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.08em;
          color: var(--text-muted, #94a3b8);
          background: var(--surface-2, #f1f5f9);
          border-radius: 4px;
          padding: 1px 5px;
        }

        .ble-addr {
          font-size: 11px;
          font-family: monospace;
          color: var(--text-muted, #94a3b8);
        }

        .ble-input {
          font-size: 11px;
          font-family: monospace;
          padding: 2px 6px;
          border-radius: 5px;
          border: 1px solid #5B9BD5;
          outline: none;
          background: var(--card-bg, #fff);
          color: var(--text, #1e293b);
          width: 150px;
        }

        .ble-btn {
          font-size: 10px;
          font-weight: 600;
          padding: 2px 8px;
          border-radius: 5px;
          border: 1px solid transparent;
          cursor: pointer;
          font-family: inherit;
          transition: all 0.15s;
        }

        .ble-btn--edit {
          color: #5B9BD5;
          background: transparent;
          border-color: #5B9BD5;
        }
        .ble-btn--edit:hover { background: rgba(91,155,213,0.1); }

        .ble-btn--save {
          color: #fff;
          background: #22c55e;
          border-color: #22c55e;
        }
        .ble-btn--save:disabled { opacity: 0.6; cursor: not-allowed; }

        .ble-btn--cancel {
          color: var(--text-muted, #94a3b8);
          background: transparent;
          border-color: var(--border, #e2e8f0);
        }

        .ble-saved {
          font-size: 10px;
          font-weight: 600;
          color: #22c55e;
          letter-spacing: 0.06em;
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
          padding: 16px 20px 20px;
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

        /* Dark mode */
        :global([data-theme="dark"]) .modal-box {
          background: #1e293b;
          border-color: #334155;
        }
        :global([data-theme="dark"]) .modal-header {
          border-color: #334155;
        }
        :global([data-theme="dark"]) .modal-device-name { color: #e2e8f0; }
        :global([data-theme="dark"]) .ble-label { background: #0f172a; }
        :global([data-theme="dark"]) .ble-input { background: #0f172a; color: #e2e8f0; border-color: #5B9BD5; }
        :global([data-theme="dark"]) .modal-vital-card {
          background: #0f172a;
          border-color: #334155;
        }
        :global([data-theme="dark"]) .modal-close:hover { background: #334155; }
      `}</style>
    </div>
  );
}