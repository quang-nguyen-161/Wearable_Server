// pages/index.js
import { useState, useEffect, useCallback, useRef } from "react";
import Head from "next/head";
import VitalCard from "../components/VitalCard";
import TrendChart from "../components/TrendChart";
import { useTbWebSocket } from "../hooks/useTbWebSocket";

/* ── Vital definitions ─────────────────────────────────────────────── */
const VITALS = [
  {
    key: "heartRate",
    label: "HEART RATE",
    icon: "♥",
    unit: "bpm",
    color: "cyan",
    min: 60, max: 100,
    critMin: 40, critMax: 130,
  },
  {
    key: "spo2",
    label: "SpO₂",
    icon: "💧",
    unit: "%",
    color: "green",
    min: 95, max: 100,
    critMin: 88, critMax: 100,
  },
  {
    key: "temperature",
    label: "TEMPERATURE",
    icon: "🌡",
    unit: "°C",
    color: "amber",
    min: 36.1, max: 37.2,
    critMin: 35.0, critMax: 39.5,
  },
];

/* ── Main component ─────────────────────────────────────────────────── */
export default function Dashboard() {
  /* Device list */
  const [devices,          setDevices]          = useState([]);
  const [devicesLoading,   setDevicesLoading]   = useState(true);
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);
  const [patient,          setPatient]          = useState(null);
  const [error,            setError]            = useState(null);
  const [theme,            setTheme]            = useState("light");
  const [tbToken,          setTbToken]          = useState(null);
  const [deviceAlerts,     setDeviceAlerts]     = useState({});

  /* ── Fetch TB token for WebSocket ── */
  useEffect(() => {
    fetch("/api/auth/token")
      .then((r) => r.json())
      .then((j) => setTbToken(j.token))
      .catch((e) => console.error("Token fetch error:", e));
  }, []);

  /* ── WebSocket: real-time vitals + ECG/PPG for selected node ── */
  const {
    vitals,
    ecgData,
    ppgData,
    connected,
    lastUpdate,
  } = useTbWebSocket(selectedDeviceId, tbToken);

  /* ── Track per-device alerts from live vitals ── */
  useEffect(() => {
    if (!selectedDeviceId || !vitals) return;
    const hr   = vitals?.heartRate?.value;
    const spo2 = vitals?.spo2?.value;
    const temp = vitals?.temperature?.value;
    const hasAlert =
      (hr   != null && (hr < 40 || hr > 130))   ||
      (spo2 != null && spo2 < 88)                ||
      (temp != null && (temp < 35.0 || temp > 39.5));
    setDeviceAlerts((prev) => ({ ...prev, [selectedDeviceId]: hasAlert }));
  }, [vitals, selectedDeviceId]);

  /* ── Fetch device list ── */
  const fetchDevices = useCallback(async () => {
    setDevicesLoading(true);
    try {
      const res  = await fetch("/api/devices");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const list = json.devices || [];
      setDevices(list);
      if (list.length > 0 && !selectedDeviceId) setSelectedDeviceId(list[0].id);
    } catch (err) {
      console.error("Device list fetch error:", err);
      setError(err.message);
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  /* ── Fetch patient info (still HTTP — changes rarely) ── */
  const fetchPatient = useCallback(async (deviceId) => {
    if (!deviceId) return;
    try {
      const res  = await fetch(`/api/patient?deviceId=${deviceId}`);
      if (!res.ok) { setPatient(null); return; }
      const json = await res.json();
      setPatient(json.info || null);
    } catch (_) { setPatient(null); }
  }, []);

  /* ── Init ── */
  useEffect(() => {
    const savedTheme = localStorage.getItem("theme") || "light";
    setTheme(savedTheme);
    document.documentElement.setAttribute("data-theme", savedTheme);
    fetchDevices();
  }, []);

  /* ── On device change: fetch patient (WS handles vitals/signals) ── */
  useEffect(() => {
    if (!selectedDeviceId) return;
    setPatient(null);
    setError(null);
    fetchPatient(selectedDeviceId);
  }, [selectedDeviceId]);

  /* ── Theme toggle ── */
  const toggleTheme = () => {
    const newTheme = theme === "light" ? "dark" : "light";
    setTheme(newTheme);
    localStorage.setItem("theme", newTheme);
    document.documentElement.setAttribute("data-theme", newTheme);
  };

  /* ── Helpers ── */
  const getValue = (key) => vitals[key]?.value ?? null;

  const formatTime = (date) =>
    date ? date.toLocaleTimeString("en-US", {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }) : "—";

  const selectedDevice = devices.find((d) => d.id === selectedDeviceId);

  /* ── Render ── */
  return (
    <>
      <Head>
        <title>HealthMonitor — Live Dashboard</title>
        <meta name="description" content="Real-time health monitoring dashboard" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link
          rel="icon"
          href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>♥</text></svg>"
        />
      </Head>

      <div className="app-shell">
        {/* ── Header ── */}
        <header className="header">
          <div className="header-brand">
            <div className="brand-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path
                  d="M3 12h3l3-9 3 18 3-9h3"
                  stroke="#00c8ff"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div>
              <div className="brand-name">VITALSYNC</div>
              <div className="brand-sub">HEALTH MONITORING SYSTEM</div>
            </div>
          </div>

          <div className="header-right">
            <div className="status-badge">
              <span className={`status-dot ${connected ? "" : "offline"}`} />
              {connected ? "LIVE" : "OFFLINE"}
            </div>
            <span className="last-update">UPDATED {formatTime(lastUpdate)}</span>
            <button
              className="theme-toggle-btn"
              onClick={toggleTheme}
              title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
            >
              {theme === "light" ? "🌙" : "☀️"}
            </button>
            <button
              className="refresh-btn"
              onClick={fetchDevices}
            >
              ⟳ REFRESH
            </button>
          </div>
        </header>

        {/* ── Device Selector ── */}
        <div className="device-selector-bar">
          <div className="device-selector-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="5" y="2" width="14" height="20" rx="2" />
              <line x1="12" y1="18" x2="12" y2="18" strokeLinecap="round" strokeWidth="3" />
            </svg>
            DEVICES
          </div>

          <div className="device-list">
            {devicesLoading ? (
              <div className="device-skeleton-row">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="device-card-skeleton" />
                ))}
              </div>
            ) : devices.length === 0 ? (
              <div className="no-devices">No devices found. Check /api/devices.</div>
            ) : (
              devices.map((device) => {
                const isSelected = device.id === selectedDeviceId;
                const hasAlert = deviceAlerts[device.id];
                return (
                  <button
                    key={device.id}
                    className={`device-card ${isSelected ? "device-card--active" : ""} ${hasAlert ? "device-card--alert" : ""}`}
                    onClick={() => setSelectedDeviceId(device.id)}
                    title={device.label || device.name}
                  >
                    <div className="device-card-top">
                      <span className="device-icon">
                        {hasAlert ? "⚠" : "📡"}
                      </span>
                      {hasAlert && <span className="alert-dot" />}
                    </div>
                    <div className="device-card-name">{device.name || device.id}</div>
                    {device.label && (
                      <div className="device-card-sub">{device.label}</div>
                    )}
                    <div className={`device-online-pill ${device.online === false ? "offline" : ""}`}>
                      {device.online === false ? "OFFLINE" : "LIVE"}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* ── Patient bar ── */}
        {patient && (
          <div className="patient-bar">
            <div className="patient-avatar">🧑‍⚕️</div>
            <div className="patient-info">
              <div className="patient-name">{patient.patientName || "Patient"}</div>
              <div className="patient-meta">
                ID: {patient.patientId || "N/A"} &nbsp;|&nbsp;
                Ward: {patient.ward || "N/A"} &nbsp;|&nbsp;
                Physician: {patient.physician || "N/A"}
              </div>
            </div>
            <div className="patient-attrs">
              {[
                ["AGE", patient.age ? `${patient.age} yr` : "—"],
                ["GENDER", patient.gender || "—"],
                ["BLOOD", patient.bloodType || "—"],
                ["WEIGHT", patient.weight ? `${patient.weight} kg` : "—"],
              ].map(([lbl, val]) => (
                <div className="attr-item" key={lbl}>
                  <span className="attr-label">{lbl}</span>
                  <span className="attr-value">{val}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Selected device header ── */}
        {selectedDevice && (
          <div className="active-device-banner">
            <span className="active-device-icon">📡</span>
            <span className="active-device-name">
              {selectedDevice.name || selectedDevice.id}
            </span>
            {selectedDevice.label && (
              <span className="active-device-label">— {selectedDevice.label}</span>
            )}
            <span className="active-device-id">ID: {selectedDevice.id}</span>
          </div>
        )}

        {/* ── Main grid ── */}
        <main className="dashboard-grid">
          {/* Error banner */}
          {error && (
            <div className="error-banner">
              <span>⚠</span>
              <span>
                CONNECTION ERROR: {error}. Check your ThingsBoard credentials
                and device ID in .env.local
              </span>
            </div>
          )}

          {/* No device selected */}
          {!selectedDeviceId && !devicesLoading && (
            <div className="no-selection">
              <div className="no-selection-icon">📡</div>
              <div className="no-selection-text">Select a device to view its vitals</div>
            </div>
          )}

          {/* Vital cards */}
          {selectedDeviceId &&
            VITALS.map((v, i) => (
              <VitalCard
                key={`${selectedDeviceId}-${v.key}`}
                label={v.label}
                icon={v.icon}
                unit={v.unit}
                color={v.color}
                min={v.min}
                max={v.max}
                critMin={v.critMin}
                critMax={v.critMax}
                value={getValue(v.key)}
                loading={!connected && !getValue(v.key)}
                animDelay={i * 60}
              />
            ))}

          {/* ECG Signal */}
          {selectedDeviceId && (
            <div className="chart-section">
              <div className="chart-header">
                <span className="chart-title">ECG SIGNAL</span>
                <span className="chart-subtitle">(Live · WebSocket)</span>
              </div>
              <TrendChart series={ecgData} metricKey="ecg" loading={false} />
            </div>
          )}

          {/* PPG Signal */}
          {selectedDeviceId && (
            <div className="chart-section">
              <div className="chart-header">
                <span className="chart-title">PPG SIGNAL</span>
                <span className="chart-subtitle">(Live · WebSocket)</span>
              </div>
              <TrendChart series={ppgData} metricKey="ppg" loading={false} />
            </div>
          )}
        </main>
      </div>

      {/* ── Device Selector Styles ── */}
      <style jsx>{`
        /* ── Light mode base ── */
        .device-selector-bar {
          display: flex;
          align-items: flex-start;
          gap: 16px;
          padding: 14px 24px;
          background: #f5f7fa;
          border-bottom: 1px solid #e2e8f0;
          transition: background 0.2s, border-color 0.2s;
        }

        .device-selector-label {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.12em;
          color: #94a3b8;
          white-space: nowrap;
          padding-top: 10px;
        }

        .device-list {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          flex: 1;
        }

        .device-card {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 3px;
          padding: 10px 14px;
          min-width: 100px;
          border-radius: 10px;
          border: 1.5px solid #e2e8f0;
          background: #ffffff;
          color: #1e293b;
          cursor: pointer;
          transition: background 0.2s, border-color 0.2s, box-shadow 0.18s, transform 0.18s;
          font-family: inherit;
        }

        .device-card:hover {
          border-color: #00c8ff;
          box-shadow: 0 0 0 3px rgba(0, 200, 255, 0.12);
          transform: translateY(-1px);
        }

        .device-card--active {
          border-color: #00c8ff;
          background: rgba(0, 200, 255, 0.07);
          box-shadow: 0 0 0 3px rgba(0, 200, 255, 0.18);
        }

        .device-card--alert {
          border-color: #ef4444;
          background: rgba(239, 68, 68, 0.05);
        }

        .device-card--alert:hover,
        .device-card--alert.device-card--active {
          border-color: #ef4444;
          box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.15);
        }

        .device-card-top {
          position: relative;
          font-size: 18px;
          line-height: 1;
        }

        .alert-dot {
          position: absolute;
          top: -2px;
          right: -4px;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #ef4444;
          animation: pulse-alert 1.2s ease-in-out infinite;
        }

        @keyframes pulse-alert {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.5; transform: scale(1.4); }
        }

        .device-card-name {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.05em;
          color: #1e293b;
          text-align: center;
          transition: color 0.2s;
        }

        .device-card-sub {
          font-size: 9px;
          color: #94a3b8;
          text-align: center;
          letter-spacing: 0.04em;
        }

        .device-online-pill {
          font-size: 8px;
          font-weight: 700;
          letter-spacing: 0.08em;
          color: #22c55e;
          background: rgba(34, 197, 94, 0.12);
          border-radius: 20px;
          padding: 2px 6px;
          margin-top: 2px;
          transition: background 0.2s;
        }

        .device-online-pill.offline {
          color: #94a3b8;
          background: rgba(148, 163, 184, 0.12);
        }

        .device-skeleton-row { display: flex; gap: 10px; }

        .device-card-skeleton {
          width: 100px;
          height: 80px;
          border-radius: 10px;
          background: linear-gradient(90deg, #e2e8f0 25%, #f1f5f9 50%, #e2e8f0 75%);
          background-size: 200% 100%;
          animation: shimmer 1.2s infinite;
        }

        @keyframes shimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }

        .no-devices { font-size: 12px; color: #94a3b8; padding: 8px 0; }

        .active-device-banner {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 24px;
          background: rgba(0, 200, 255, 0.05);
          border-bottom: 1px solid rgba(0, 200, 255, 0.15);
          font-size: 12px;
          transition: background 0.2s;
        }

        .active-device-icon { font-size: 14px; }

        .active-device-name {
          font-weight: 700;
          letter-spacing: 0.06em;
          color: #1e293b;
          transition: color 0.2s;
        }

        .active-device-label { color: #94a3b8; }

        .active-device-id {
          margin-left: auto;
          font-size: 10px;
          letter-spacing: 0.08em;
          color: #94a3b8;
          font-family: monospace;
        }

        .no-selection {
          grid-column: 1 / -1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          padding: 64px 24px;
          opacity: 0.5;
        }

        .no-selection-icon { font-size: 40px; }

        .no-selection-text {
          font-size: 13px;
          letter-spacing: 0.08em;
          color: #94a3b8;
          font-weight: 600;
        }

        /* ── Dark mode overrides ── */
        :global([data-theme="dark"]) .device-selector-bar {
          background: #0f172a;
          border-bottom-color: #1e293b;
        }

        :global([data-theme="dark"]) .device-selector-label {
          color: #475569;
        }

        :global([data-theme="dark"]) .device-card {
          background: #1e293b;
          border-color: #334155;
          color: #e2e8f0;
        }

        :global([data-theme="dark"]) .device-card:hover {
          border-color: #00c8ff;
          background: #1e293b;
          box-shadow: 0 0 0 3px rgba(0, 200, 255, 0.15);
        }

        :global([data-theme="dark"]) .device-card--active {
          background: rgba(0, 200, 255, 0.1);
          border-color: #00c8ff;
          box-shadow: 0 0 0 3px rgba(0, 200, 255, 0.2);
        }

        :global([data-theme="dark"]) .device-card--alert {
          background: rgba(239, 68, 68, 0.08);
          border-color: #ef4444;
        }

        :global([data-theme="dark"]) .device-card-name {
          color: #e2e8f0;
        }

        :global([data-theme="dark"]) .device-card-sub {
          color: #64748b;
        }

        :global([data-theme="dark"]) .device-online-pill {
          color: #4ade80;
          background: rgba(74, 222, 128, 0.12);
        }

        :global([data-theme="dark"]) .device-online-pill.offline {
          color: #475569;
          background: rgba(71, 85, 105, 0.15);
        }

        :global([data-theme="dark"]) .device-card-skeleton {
          background: linear-gradient(90deg, #1e293b 25%, #263347 50%, #1e293b 75%);
          background-size: 200% 100%;
        }

        :global([data-theme="dark"]) .active-device-banner {
          background: rgba(0, 200, 255, 0.04);
          border-bottom-color: rgba(0, 200, 255, 0.12);
        }

        :global([data-theme="dark"]) .active-device-name {
          color: #e2e8f0;
        }

        :global([data-theme="dark"]) .active-device-label,
        :global([data-theme="dark"]) .active-device-id {
          color: #475569;
        }

        :global([data-theme="dark"]) .no-devices {
          color: #475569;
        }

        :global([data-theme="dark"]) .no-selection-text {
          color: #475569;
        }
      `}</style>
    </>
  );
}