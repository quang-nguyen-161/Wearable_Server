// pages/settings.js
// Per-node settings page.
// - Vital thresholds → saved as SERVER_SCOPE attributes on the selected node device
// - BLE interval    → saved as SHARED_SCOPE attribute (firmware subscribes to this)

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import Link from "next/link";

// ── Defaults ────────────────────────────────────────────────────────────────
const DEFAULT_THRESHOLDS = {
  heartRate:   { normalMin: 60,   normalMax: 100,  critMin: 40,   critMax: 130  },
  spo2:        { normalMin: 95,   normalMax: 100,  critMin: 88,   critMax: 100  },
  temperature: { normalMin: 36.1, normalMax: 37.2, critMin: 35.0, critMax: 39.5 },
};

const VITAL_LABELS = {
  heartRate:   { label: "HEART RATE",  unit: "bpm" },
  spo2:        { label: "SpO₂",        unit: "%"   },
  temperature: { label: "TEMPERATURE", unit: "°C"  },
};

const DEFAULT_INTERVAL = 1000; // ms — BLE peripheral notify interval

// ── Settings page ────────────────────────────────────────────────────────────
export default function Settings() {
  const router = useRouter();

  const [devices,          setDevices]          = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);
  const [thresholds,       setThresholds]       = useState(DEFAULT_THRESHOLDS);
  const [bleInterval,      setBleInterval]      = useState(DEFAULT_INTERVAL);
  const [loading,          setLoading]          = useState(false);
  const [saving,           setSaving]           = useState(false);
  const [saveMsg,          setSaveMsg]          = useState(null); // { type: "ok"|"err", text }
  const [theme,            setTheme]            = useState("light");

  // ── Theme ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const t = localStorage.getItem("theme") || "light";
    setTheme(t);
    document.documentElement.setAttribute("data-theme", t);
  }, []);

  // ── Load device list ───────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/devices")
      .then(r => r.json())
      .then(j => {
        const list = j.devices || [];
        setDevices(list);
        // Pre-select from query param or first device
        const qId = router.query.deviceId;
        setSelectedDeviceId(qId && list.find(d => d.id === qId) ? qId : list[0]?.id ?? null);
      })
      .catch(console.error);
  }, [router.query.deviceId]);

  // ── Load existing attributes when device changes ────────────────────────
  const loadAttributes = useCallback(async (deviceId) => {
    if (!deviceId) return;
    setLoading(true);
    try {
      const res  = await fetch(`/api/attributes/load?deviceId=${deviceId}`);
      const json = await res.json();
      const a    = json.attributes || {};

      setThresholds({
        heartRate: {
          normalMin: a.hr_normalMin  ?? DEFAULT_THRESHOLDS.heartRate.normalMin,
          normalMax: a.hr_normalMax  ?? DEFAULT_THRESHOLDS.heartRate.normalMax,
          critMin:   a.hr_critMin    ?? DEFAULT_THRESHOLDS.heartRate.critMin,
          critMax:   a.hr_critMax    ?? DEFAULT_THRESHOLDS.heartRate.critMax,
        },
        spo2: {
          normalMin: a.spo2_normalMin ?? DEFAULT_THRESHOLDS.spo2.normalMin,
          normalMax: a.spo2_normalMax ?? DEFAULT_THRESHOLDS.spo2.normalMax,
          critMin:   a.spo2_critMin   ?? DEFAULT_THRESHOLDS.spo2.critMin,
          critMax:   a.spo2_critMax   ?? DEFAULT_THRESHOLDS.spo2.critMax,
        },
        temperature: {
          normalMin: a.temp_normalMin ?? DEFAULT_THRESHOLDS.temperature.normalMin,
          normalMax: a.temp_normalMax ?? DEFAULT_THRESHOLDS.temperature.normalMax,
          critMin:   a.temp_critMin   ?? DEFAULT_THRESHOLDS.temperature.critMin,
          critMax:   a.temp_critMax   ?? DEFAULT_THRESHOLDS.temperature.critMax,
        },
      });
      setBleInterval(a.bleInterval ?? DEFAULT_INTERVAL);
    } catch (e) {
      console.error("Load attributes:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedDeviceId) loadAttributes(selectedDeviceId);
  }, [selectedDeviceId, loadAttributes]);

  // ── Save ───────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!selectedDeviceId) return;
    setSaving(true);
    setSaveMsg(null);

    // Flatten thresholds into TB attribute keys
    const serverAttrs = {
      hr_normalMin:   thresholds.heartRate.normalMin,
      hr_normalMax:   thresholds.heartRate.normalMax,
      hr_critMin:     thresholds.heartRate.critMin,
      hr_critMax:     thresholds.heartRate.critMax,
      spo2_normalMin: thresholds.spo2.normalMin,
      spo2_normalMax: thresholds.spo2.normalMax,
      spo2_critMin:   thresholds.spo2.critMin,
      spo2_critMax:   thresholds.spo2.critMax,
      temp_normalMin: thresholds.temperature.normalMin,
      temp_normalMax: thresholds.temperature.normalMax,
      temp_critMin:   thresholds.temperature.critMin,
      temp_critMax:   thresholds.temperature.critMax,
    };

    try {
      // 1. Save thresholds as SERVER_SCOPE (dashboard reads these)
      const r1 = await fetch("/api/attributes/save", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          deviceId:   selectedDeviceId,
          scope:      "SERVER_SCOPE",
          attributes: serverAttrs,
        }),
      });

      // 2. Save BLE interval as SHARED_SCOPE (firmware subscribes to this)
      const r2 = await fetch("/api/attributes/save", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          deviceId:   selectedDeviceId,
          scope:      "SHARED_SCOPE",
          attributes: { bleInterval },
        }),
      });

      if (!r1.ok || !r2.ok) throw new Error("Save failed");
      setSaveMsg({ type: "ok", text: "Settings saved to ThingsBoard ✓" });
    } catch (e) {
      setSaveMsg({ type: "err", text: `Error: ${e.message}` });
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(null), 4000);
    }
  };

  // ── Reset defaults ─────────────────────────────────────────────────────
  const handleReset = () => {
    setThresholds(DEFAULT_THRESHOLDS);
    setBleInterval(DEFAULT_INTERVAL);
  };

  // ── Threshold field helper ─────────────────────────────────────────────
  const setField = (vital, field, raw) => {
    const val = parseFloat(raw);
    if (isNaN(val)) return;
    setThresholds(prev => ({
      ...prev,
      [vital]: { ...prev[vital], [field]: val },
    }));
  };

  const selectedDevice = devices.find(d => d.id === selectedDeviceId);

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <>
      <Head>
        <title>Settings — VitalSync</title>
      </Head>

      <div className="settings-shell">

        {/* ── Top bar ── */}
        <div className="settings-topbar">
          <Link href="/" className="back-btn">← BACK</Link>
          <div className="settings-title">⚙ SETTINGS</div>
        </div>

        <div className="settings-body">

          {/* ── Device selector ── */}
          <section className="settings-section">
            <div className="section-title">NODE DEVICE</div>
            <div className="section-sub">Settings are saved per node. Select the node to configure.</div>
            <div className="device-select-row">
              {devices.map(d => (
                <button
                  key={d.id}
                  className={`device-pill ${selectedDeviceId === d.id ? "device-pill--active" : ""}`}
                  onClick={() => setSelectedDeviceId(d.id)}
                >
                  📡 {d.name}
                </button>
              ))}
            </div>
            {selectedDevice && (
              <div className="device-id-label">
                Editing: <span className="mono">{selectedDevice.name}</span>
                <span className="mono muted"> ({selectedDevice.id})</span>
              </div>
            )}
            {loading && <div className="loading-label">Loading saved settings…</div>}
          </section>

          {/* ── Vital thresholds ── */}
          <section className="settings-section">
            <div className="section-title">VITAL THRESHOLDS</div>
            <div className="section-sub">
              Saved as Server attributes on this node in ThingsBoard. Used by the dashboard to color-code vitals.
            </div>

            {Object.entries(thresholds).map(([vital, vals]) => {
              const meta = VITAL_LABELS[vital];
              return (
                <div className="threshold-card" key={vital}>
                  <div className="threshold-card-header">
                    <span className="threshold-vital-name">{meta.label}</span>
                    <span className="threshold-unit">{meta.unit}</span>
                  </div>
                  <div className="threshold-grid">
                    <label className="threshold-field">
                      <span>Normal Min</span>
                      <input type="number" step="0.1"
                        value={vals.normalMin}
                        onChange={e => setField(vital, "normalMin", e.target.value)} />
                    </label>
                    <label className="threshold-field">
                      <span>Normal Max</span>
                      <input type="number" step="0.1"
                        value={vals.normalMax}
                        onChange={e => setField(vital, "normalMax", e.target.value)} />
                    </label>
                    <label className="threshold-field critical">
                      <span>Critical Min</span>
                      <input type="number" step="0.1"
                        value={vals.critMin}
                        onChange={e => setField(vital, "critMin", e.target.value)} />
                    </label>
                    <label className="threshold-field critical">
                      <span>Critical Max</span>
                      <input type="number" step="0.1"
                        value={vals.critMax}
                        onChange={e => setField(vital, "critMax", e.target.value)} />
                    </label>
                  </div>
                </div>
              );
            })}
          </section>

          {/* ── BLE interval ── */}
          <section className="settings-section">
            <div className="section-title">BLE NOTIFY INTERVAL</div>
            <div className="section-sub">
              Saved as a Shared attribute on this node. The node firmware reads this value and sets how frequently the BLE peripheral sends notifications to the gateway. Lower = more frequent data updates.
            </div>
            <div className="interval-row">
              <input
                type="range"
                min={100} max={5000} step={100}
                value={bleInterval}
                onChange={e => setBleInterval(Number(e.target.value))}
                className="interval-slider"
              />
              <span className="interval-value">{bleInterval} ms</span>
            </div>
            <div className="interval-presets">
              {[100, 250, 500, 1000, 2000, 5000].map(ms => (
                <button
                  key={ms}
                  className={`preset-btn ${bleInterval === ms ? "preset-btn--active" : ""}`}
                  onClick={() => setBleInterval(ms)}
                >
                  {ms < 1000 ? `${ms}ms` : `${ms/1000}s`}
                </button>
              ))}
            </div>
            <div className="interval-hint">
              ↓ Lower interval = more frequent BLE notifications = smoother live data, higher power consumption on the peripheral node.
            </div>
          </section>

          {/* ── Actions ── */}
          <div className="settings-actions">
            {saveMsg && (
              <div className={`save-msg ${saveMsg.type === "ok" ? "save-msg--ok" : "save-msg--err"}`}>
                {saveMsg.text}
              </div>
            )}
            <button className="btn-reset" onClick={handleReset}>RESET DEFAULTS</button>
            <button
              className="btn-save"
              onClick={handleSave}
              disabled={saving || !selectedDeviceId || loading}
            >
              {saving ? "SAVING…" : "SAVE TO THINGSBOARD"}
            </button>
          </div>

        </div>
      </div>

      <style jsx>{`
        .settings-shell {
          min-height: 100vh;
          background: var(--bg-void, #f8f9fa);
          color: var(--text-primary, #2c3e50);
          font-family: inherit;
        }

        .settings-topbar {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 14px 32px;
          background: var(--bg-card, #fff);
          border-bottom: 1px solid var(--border, #e2e8f0);
        }

        .back-btn {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.08em;
          color: var(--text-muted, #94a3b8);
          text-decoration: none;
          padding: 6px 12px;
          border-radius: 6px;
          border: 1px solid var(--border, #e2e8f0);
          transition: background 0.15s;
        }
        .back-btn:hover { background: var(--bg-void, #f1f5f9); }

        .settings-title {
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.1em;
          color: var(--text-primary, #2c3e50);
        }

        .settings-body {
          max-width: 680px;
          margin: 32px auto;
          padding: 0 16px 64px;
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        .settings-section {
          background: var(--bg-card, #fff);
          border-radius: 14px;
          border: 1px solid var(--border, #e2e8f0);
          padding: 22px 24px;
        }

        .section-title {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.12em;
          color: var(--text-primary, #2c3e50);
          margin-bottom: 4px;
        }

        .section-sub {
          font-size: 12px;
          color: var(--text-muted, #94a3b8);
          margin-bottom: 16px;
          line-height: 1.5;
        }

        /* Device pills */
        .device-select-row {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-bottom: 10px;
        }
        .device-pill {
          font-size: 12px;
          font-weight: 600;
          padding: 6px 14px;
          border-radius: 20px;
          border: 1.5px solid var(--border, #e2e8f0);
          background: var(--bg-void, #f8f9fa);
          color: var(--text-primary, #2c3e50);
          cursor: pointer;
          transition: all 0.15s;
          font-family: inherit;
        }
        .device-pill--active {
          border-color: #00c8ff;
          background: rgba(0,200,255,0.08);
          color: #00c8ff;
        }
        .device-id-label {
          font-size: 11px;
          color: var(--text-muted, #94a3b8);
          margin-top: 4px;
        }
        .mono { font-family: monospace; }
        .muted { opacity: 0.6; }
        .loading-label { font-size: 12px; color: #00c8ff; margin-top: 8px; }

        /* Threshold cards */
        .threshold-card {
          border: 1px solid var(--border, #e2e8f0);
          border-radius: 10px;
          padding: 14px 16px;
          margin-bottom: 12px;
        }
        .threshold-card:last-child { margin-bottom: 0; }

        .threshold-card-header {
          display: flex;
          align-items: baseline;
          gap: 8px;
          margin-bottom: 12px;
        }
        .threshold-vital-name {
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.06em;
          color: var(--text-primary, #2c3e50);
        }
        .threshold-unit {
          font-size: 11px;
          color: var(--text-muted, #94a3b8);
        }

        .threshold-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }

        .threshold-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .threshold-field span {
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.06em;
          color: var(--text-muted, #94a3b8);
        }
        .threshold-field.critical span { color: #ef4444; }
        .threshold-field input {
          padding: 7px 10px;
          border-radius: 7px;
          border: 1px solid var(--border, #e2e8f0);
          background: var(--bg-void, #f8f9fa);
          color: var(--text-primary, #2c3e50);
          font-size: 13px;
          font-family: inherit;
          width: 100%;
          box-sizing: border-box;
        }
        .threshold-field.critical input { border-color: rgba(239,68,68,0.3); }
        .threshold-field input:focus {
          outline: none;
          border-color: #00c8ff;
          box-shadow: 0 0 0 2px rgba(0,200,255,0.12);
        }

        /* Interval */
        .interval-row {
          display: flex;
          align-items: center;
          gap: 14px;
          margin-bottom: 12px;
        }
        .interval-slider {
          flex: 1;
          accent-color: #00c8ff;
          height: 4px;
        }
        .interval-value {
          font-size: 18px;
          font-weight: 700;
          color: #00c8ff;
          min-width: 60px;
          text-align: right;
        }
        .interval-presets {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
          margin-bottom: 10px;
        }
        .preset-btn {
          font-size: 11px;
          font-weight: 600;
          padding: 4px 10px;
          border-radius: 6px;
          border: 1px solid var(--border, #e2e8f0);
          background: var(--bg-void, #f8f9fa);
          color: var(--text-muted, #94a3b8);
          cursor: pointer;
          font-family: inherit;
          transition: all 0.15s;
        }
        .preset-btn--active {
          border-color: #00c8ff;
          background: rgba(0,200,255,0.08);
          color: #00c8ff;
        }
        .interval-hint {
          font-size: 11px;
          color: var(--text-muted, #94a3b8);
          line-height: 1.5;
        }

        /* Actions */
        .settings-actions {
          display: flex;
          align-items: center;
          gap: 12px;
          justify-content: flex-end;
          flex-wrap: wrap;
        }
        .save-msg {
          font-size: 12px;
          font-weight: 600;
          padding: 8px 14px;
          border-radius: 8px;
          margin-right: auto;
        }
        .save-msg--ok  { background: rgba(34,197,94,0.1);  color: #22c55e; }
        .save-msg--err { background: rgba(239,68,68,0.1);  color: #ef4444; }

        .btn-reset {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.08em;
          padding: 10px 18px;
          border-radius: 8px;
          border: 1px solid var(--border, #e2e8f0);
          background: var(--bg-void, #f8f9fa);
          color: var(--text-muted, #94a3b8);
          cursor: pointer;
          font-family: inherit;
        }
        .btn-save {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.08em;
          padding: 10px 22px;
          border-radius: 8px;
          border: none;
          background: #00c8ff;
          color: #fff;
          cursor: pointer;
          font-family: inherit;
          transition: opacity 0.15s;
        }
        .btn-save:disabled { opacity: 0.5; cursor: not-allowed; }

        /* Dark mode */
        :global([data-theme="dark"]) .settings-section {
          background: #1e293b;
          border-color: #334155;
        }
        :global([data-theme="dark"]) .settings-topbar {
          background: #1e293b;
          border-bottom-color: #334155;
        }
        :global([data-theme="dark"]) .threshold-card {
          border-color: #334155;
        }
        :global([data-theme="dark"]) .threshold-field input {
          background: #0f172a;
          border-color: #334155;
          color: #e2e8f0;
        }
        :global([data-theme="dark"]) .device-pill {
          background: #0f172a;
          border-color: #334155;
          color: #e2e8f0;
        }
        :global([data-theme="dark"]) .btn-reset {
          background: #0f172a;
          border-color: #334155;
          color: #64748b;
        }
        :global([data-theme="dark"]) .preset-btn {
          background: #0f172a;
          border-color: #334155;
          color: #64748b;
        }
      `}</style>
    </>
  );
}