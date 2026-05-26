// pages/settings.js
import { useState, useEffect } from "react";
import Head from "next/head";
import { useRouter } from "next/router";

const DEFAULT_VITALS = [
  { key: "heartRate",   label: "HEART RATE",   unit: "bpm", min: 60,   max: 100,  critMin: 40,   critMax: 130  },
  { key: "spo2",        label: "SpO₂",          unit: "%",   min: 95,   max: 100,  critMin: 88,   critMax: 100  },
  { key: "temperature", label: "TEMPERATURE",   unit: "°C",  min: 36.1, max: 37.2, critMin: 35.0, critMax: 39.5 },
];

const DEFAULT_INTERVAL = 10; // seconds

export default function Settings() {
  const router = useRouter();
  const [thresholds, setThresholds] = useState(DEFAULT_VITALS);
  const [interval, setIntervalSec] = useState(DEFAULT_INTERVAL);
  const [saved, setSaved] = useState(false);

  // Load saved settings
  useEffect(() => {
    const savedThresholds = localStorage.getItem("vitalThresholds");
    const savedInterval   = localStorage.getItem("refreshInterval");
    if (savedThresholds) setThresholds(JSON.parse(savedThresholds));
    if (savedInterval)   setIntervalSec(Number(savedInterval));
  }, []);

  const handleThresholdChange = (key, field, value) => {
    setThresholds((prev) =>
      prev.map((v) => v.key === key ? { ...v, [field]: Number(value) } : v)
    );
  };

  const handleSave = () => {
    localStorage.setItem("vitalThresholds", JSON.stringify(thresholds));
    localStorage.setItem("refreshInterval", String(interval));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    setThresholds(DEFAULT_VITALS);
    setIntervalSec(DEFAULT_INTERVAL);
  };

  return (
    <>
      <Head><title>Settings — VitalSync</title></Head>
      <div className="settings-shell">

        {/* Header */}
        <header className="settings-header">
          <button className="back-btn" onClick={() => router.push("/")}>← BACK</button>
          <div className="settings-title">⚙ SETTINGS</div>
        </header>

        <main className="settings-main">

          {/* Vital Thresholds */}
          <section className="settings-section">
            <h2 className="section-title">VITAL THRESHOLDS</h2>
            <p className="section-desc">Set normal and critical alert ranges for each vital sign.</p>

            {thresholds.map((v) => (
              <div key={v.key} className="threshold-card">
                <div className="threshold-title">{v.label} <span className="unit-badge">{v.unit}</span></div>
                <div className="threshold-row">
                  <label>Normal Min</label>
                  <input type="number" value={v.min} step="0.1"
                    onChange={(e) => handleThresholdChange(v.key, "min", e.target.value)} />
                  <label>Normal Max</label>
                  <input type="number" value={v.max} step="0.1"
                    onChange={(e) => handleThresholdChange(v.key, "max", e.target.value)} />
                </div>
                <div className="threshold-row critical">
                  <label>Critical Min</label>
                  <input type="number" value={v.critMin} step="0.1"
                    onChange={(e) => handleThresholdChange(v.key, "critMin", e.target.value)} />
                  <label>Critical Max</label>
                  <input type="number" value={v.critMax} step="0.1"
                    onChange={(e) => handleThresholdChange(v.key, "critMax", e.target.value)} />
                </div>
              </div>
            ))}
          </section>

          {/* Refresh Interval */}
          <section className="settings-section">
            <h2 className="section-title">REFRESH INTERVAL</h2>
            <p className="section-desc">How often the dashboard polls for new data (seconds).</p>
            <div className="interval-row">
              <input type="range" min="5" max="60" step="5" value={interval}
                onChange={(e) => setIntervalSec(Number(e.target.value))} />
              <span className="interval-value">{interval}s</span>
            </div>
            <div className="interval-presets">
              {[5, 10, 15, 30, 60].map((s) => (
                <button key={s}
                  className={`preset-btn ${interval === s ? "active" : ""}`}
                  onClick={() => setIntervalSec(s)}
                >{s}s</button>
              ))}
            </div>
          </section>

          {/* Actions */}
          <div className="settings-actions">
            <button className="reset-btn" onClick={handleReset}>RESET DEFAULTS</button>
            <button className="save-btn" onClick={handleSave}>
              {saved ? "✓ SAVED!" : "SAVE SETTINGS"}
            </button>
          </div>
        </main>
      </div>

      <style jsx>{`
        .settings-shell { min-height: 100vh; background: var(--bg-void, #f8f9fa); font-family: 'Inter', sans-serif; }
        .settings-header { display: flex; align-items: center; gap: 16px; padding: 14px 24px;
          background: #fff; border-bottom: 1px solid #e2e8f0; }
        .back-btn { background: none; border: 1.5px solid #e2e8f0; border-radius: 8px;
          padding: 6px 14px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
          cursor: pointer; color: #64748b; transition: all 0.15s; }
        .back-btn:hover { border-color: #00c8ff; color: #00c8ff; }
        .settings-title { font-size: 15px; font-weight: 800; letter-spacing: 0.1em; color: #1e293b; }
        .settings-main { max-width: 680px; margin: 32px auto; padding: 0 24px; display: flex; flex-direction: column; gap: 24px; }
        .settings-section { background: #fff; border-radius: 14px; border: 1px solid #e2e8f0; padding: 24px; }
        .section-title { font-size: 11px; font-weight: 800; letter-spacing: 0.12em; color: #64748b; margin: 0 0 4px; }
        .section-desc { font-size: 12px; color: #94a3b8; margin: 0 0 20px; }
        .threshold-card { border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
        .threshold-title { font-size: 12px; font-weight: 700; letter-spacing: 0.08em; color: #1e293b; margin-bottom: 10px; }
        .unit-badge { background: #f1f5f9; color: #64748b; border-radius: 4px; padding: 1px 6px; font-size: 10px; margin-left: 6px; }
        .threshold-row { display: grid; grid-template-columns: 90px 1fr 90px 1fr; gap: 8px; align-items: center; margin-bottom: 8px; }
        .threshold-row label { font-size: 10px; font-weight: 600; color: #64748b; letter-spacing: 0.05em; }
        .threshold-row.critical label { color: #ef4444; }
        .threshold-row input { border: 1.5px solid #e2e8f0; border-radius: 6px; padding: 5px 8px;
          font-size: 13px; font-family: monospace; color: #1e293b; outline: none; transition: border-color 0.15s; }
        .threshold-row input:focus { border-color: #00c8ff; }
        .threshold-row.critical input:focus { border-color: #ef4444; }
        .interval-row { display: flex; align-items: center; gap: 16px; margin-bottom: 12px; }
        .interval-row input[type=range] { flex: 1; accent-color: #00c8ff; }
        .interval-value { font-size: 20px; font-weight: 800; color: #00c8ff; min-width: 40px; }
        .interval-presets { display: flex; gap: 8px; flex-wrap: wrap; }
        .preset-btn { border: 1.5px solid #e2e8f0; background: #fff; border-radius: 8px;
          padding: 5px 14px; font-size: 11px; font-weight: 700; cursor: pointer; transition: all 0.15s; }
        .preset-btn:hover { border-color: #00c8ff; color: #00c8ff; }
        .preset-btn.active { border-color: #00c8ff; background: rgba(0,200,255,0.08); color: #00c8ff; }
        .settings-actions { display: flex; gap: 12px; justify-content: flex-end; }
        .reset-btn { border: 1.5px solid #e2e8f0; background: #fff; border-radius: 8px;
          padding: 8px 20px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; cursor: pointer; color: #64748b; }
        .save-btn { border: none; background: #00c8ff; color: #fff; border-radius: 8px;
          padding: 8px 24px; font-size: 11px; font-weight: 800; letter-spacing: 0.08em; cursor: pointer; transition: background 0.15s; }
        .save-btn:hover { background: #00a8d8; }
      `}</style>
    </>
  );
}