// pages/settings.js
// Per-node settings page.
// - Vital thresholds    → saved as SERVER_SCOPE attributes on the selected node device
// - vitalInterval       → saved as SHARED_SCOPE (firmware: how often vitals are reported)
// - ecgSampleFreq       → saved as SHARED_SCOPE (firmware: ADC sampling rate in Hz)
// - ecgPacketInterval   → saved as SHARED_SCOPE (firmware: ECG packet send interval in ms)
// - ppgSampleFreq       → saved as SHARED_SCOPE (firmware: MAX30102 sample rate in Hz)
// - ppgRedLedMa         → saved as SHARED_SCOPE (firmware: red LED drive current in mA)
// - ppgIrLedMa          → saved as SHARED_SCOPE (firmware: IR LED drive current in mA)

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import Link from "next/link";
import { useSettings } from "../context/SettingsContext";
import { useTbAuth } from "../context/TbAuthContext";
import { getDevices, getDeviceAttributes, saveDeviceAttributes } from "../lib/tbBrowserClient";

// ── Defaults ────────────────────────────────────────────────────────────────
const DEFAULT_THRESHOLDS = {
  ppgHeartRate: { normalMin: 60,   normalMax: 100,  warnMin: 50,  warnMax: 120, dangerMin: 40,   dangerMax: 130  },
  ecgHeartRate: { normalMin: 60,   normalMax: 100,  warnMin: 50,  warnMax: 120, dangerMin: 40,   dangerMax: 130  },
  spo2:         { normalMin: 95,   normalMax: 100,  warnMin: 90,  warnMax: 100, dangerMin: 88,   dangerMax: 100  },
  temperature:  { normalMin: 36.1, normalMax: 37.2, warnMin: 35.5,warnMax: 38.5,dangerMin: 35.0, dangerMax: 39.5 },
};

const VITAL_LABELS = {
  ppgHeartRate: { label: "PPG HEART RATE", unit: "bpm" },
  ecgHeartRate: { label: "ECG HEART RATE", unit: "bpm" },
  spo2:         { label: "SpO₂",           unit: "%"   },
  temperature:  { label: "TEMPERATURE",    unit: "°C"  },
};

const DEFAULT_VITAL_INTERVAL      = 1000; // ms — how often vitals are reported
const DEFAULT_ECG_SAMPLE_FREQ     = 250;  // Hz — ADC sampling rate
const DEFAULT_ECG_PACKET_INTERVAL = 500;  // ms — how often ECG packets are sent
const DEFAULT_PPG_SAMPLE_FREQ     = 100;  // Hz — MAX30102 sample rate
const DEFAULT_PPG_RED_LED_MA      = 6;    // mA — red LED drive current
const DEFAULT_PPG_IR_LED_MA       = 6;    // mA — IR LED drive current

const ECG_FREQ_PRESETS = [100, 250, 500, 750, 1000];
const PPG_FREQ_OPTIONS = [50, 100, 200, 400, 800, 1000];

// ── Settings page ────────────────────────────────────────────────────────────
export default function Settings() {
  const router = useRouter();
  const { token } = useTbAuth();

  const [devices,            setDevices]            = useState([]);
  const [selectedDeviceId,   setSelectedDeviceId]   = useState(null);
  const { updateSettings }                          = useSettings(selectedDeviceId);
  const [thresholds,         setThresholds]         = useState(DEFAULT_THRESHOLDS);
  const [vitalInterval,      setVitalInterval]      = useState(DEFAULT_VITAL_INTERVAL);
  const [ecgSampleFreq,      setEcgSampleFreq]      = useState(DEFAULT_ECG_SAMPLE_FREQ);
  const [ecgPacketInterval,  setEcgPacketInterval]  = useState(DEFAULT_ECG_PACKET_INTERVAL);
  const [ppgSampleFreq,      setPpgSampleFreq]      = useState(DEFAULT_PPG_SAMPLE_FREQ);
  const [ppgRedLedMa,        setPpgRedLedMa]        = useState(DEFAULT_PPG_RED_LED_MA);
  const [ppgIrLedMa,         setPpgIrLedMa]         = useState(DEFAULT_PPG_IR_LED_MA);
  const [loading,            setLoading]            = useState(false);
  const [saving,             setSaving]             = useState(false);
  const [saveMsg,            setSaveMsg]            = useState(null); // { type: "ok"|"err", text }
  const [theme,              setTheme]              = useState("light");

  // ── Theme ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const t = localStorage.getItem("theme") || "light";
    setTheme(t);
    document.documentElement.setAttribute("data-theme", t);
  }, []);

  // ── Load device list ───────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    getDevices(token)
      .then(list => {
        setDevices(list);
        const qId = router.query.deviceId;
        setSelectedDeviceId(qId && list.find(d => d.id === qId) ? qId : list[0]?.id ?? null);
      })
      .catch(console.error);
  }, [token, router.query.deviceId]);

  // ── Load existing attributes when device changes ────────────────────────
  const loadAttributes = useCallback(async (deviceId) => {
    if (!deviceId || !token) return;
    setLoading(true);
    try {
      const a = await getDeviceAttributes(token, deviceId);

      setThresholds({
        ppgHeartRate: {
          normalMin:  a.ppgHr_normalMin ?? DEFAULT_THRESHOLDS.ppgHeartRate.normalMin,
          normalMax:  a.ppgHr_normalMax ?? DEFAULT_THRESHOLDS.ppgHeartRate.normalMax,
          warnMin:    a.ppgHr_warnMin   ?? DEFAULT_THRESHOLDS.ppgHeartRate.warnMin,
          warnMax:    a.ppgHr_warnMax   ?? DEFAULT_THRESHOLDS.ppgHeartRate.warnMax,
          dangerMin:  a.ppgHr_dangerMin ?? DEFAULT_THRESHOLDS.ppgHeartRate.dangerMin,
          dangerMax:  a.ppgHr_dangerMax ?? DEFAULT_THRESHOLDS.ppgHeartRate.dangerMax,
        },
        ecgHeartRate: {
          normalMin:  a.ecgHr_normalMin ?? DEFAULT_THRESHOLDS.ecgHeartRate.normalMin,
          normalMax:  a.ecgHr_normalMax ?? DEFAULT_THRESHOLDS.ecgHeartRate.normalMax,
          warnMin:    a.ecgHr_warnMin   ?? DEFAULT_THRESHOLDS.ecgHeartRate.warnMin,
          warnMax:    a.ecgHr_warnMax   ?? DEFAULT_THRESHOLDS.ecgHeartRate.warnMax,
          dangerMin:  a.ecgHr_dangerMin ?? DEFAULT_THRESHOLDS.ecgHeartRate.dangerMin,
          dangerMax:  a.ecgHr_dangerMax ?? DEFAULT_THRESHOLDS.ecgHeartRate.dangerMax,
        },
        spo2: {
          normalMin:  a.spo2_normalMin  ?? DEFAULT_THRESHOLDS.spo2.normalMin,
          normalMax:  a.spo2_normalMax  ?? DEFAULT_THRESHOLDS.spo2.normalMax,
          warnMin:    a.spo2_warnMin    ?? DEFAULT_THRESHOLDS.spo2.warnMin,
          warnMax:    a.spo2_warnMax    ?? DEFAULT_THRESHOLDS.spo2.warnMax,
          dangerMin:  a.spo2_dangerMin  ?? DEFAULT_THRESHOLDS.spo2.dangerMin,
          dangerMax:  a.spo2_dangerMax  ?? DEFAULT_THRESHOLDS.spo2.dangerMax,
        },
        temperature: {
          normalMin:  a.temp_normalMin  ?? DEFAULT_THRESHOLDS.temperature.normalMin,
          normalMax:  a.temp_normalMax  ?? DEFAULT_THRESHOLDS.temperature.normalMax,
          warnMin:    a.temp_warnMin    ?? DEFAULT_THRESHOLDS.temperature.warnMin,
          warnMax:    a.temp_warnMax    ?? DEFAULT_THRESHOLDS.temperature.warnMax,
          dangerMin:  a.temp_dangerMin  ?? DEFAULT_THRESHOLDS.temperature.dangerMin,
          dangerMax:  a.temp_dangerMax  ?? DEFAULT_THRESHOLDS.temperature.dangerMax,
        },
      });
      setVitalInterval(a.vitalInterval ?? DEFAULT_VITAL_INTERVAL);
      setEcgSampleFreq(a.ecgSampleFreq ?? DEFAULT_ECG_SAMPLE_FREQ);
      setEcgPacketInterval(a.ecgPacketInterval ?? DEFAULT_ECG_PACKET_INTERVAL);
      setPpgSampleFreq(a.ppgSampleFreq ?? DEFAULT_PPG_SAMPLE_FREQ);
      setPpgRedLedMa(a.ppgRedLedMa ?? DEFAULT_PPG_RED_LED_MA);
      setPpgIrLedMa(a.ppgIrLedMa ?? DEFAULT_PPG_IR_LED_MA);
    } catch (e) {
      console.error("Load attributes:", e);
    } finally {
      setLoading(false);
    }
  }, [token]);

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
      ppgHr_normalMin: thresholds.ppgHeartRate.normalMin,
      ppgHr_normalMax: thresholds.ppgHeartRate.normalMax,
      ppgHr_warnMin:   thresholds.ppgHeartRate.warnMin,
      ppgHr_warnMax:   thresholds.ppgHeartRate.warnMax,
      ppgHr_dangerMin: thresholds.ppgHeartRate.dangerMin,
      ppgHr_dangerMax: thresholds.ppgHeartRate.dangerMax,
      ecgHr_normalMin: thresholds.ecgHeartRate.normalMin,
      ecgHr_normalMax: thresholds.ecgHeartRate.normalMax,
      ecgHr_warnMin:   thresholds.ecgHeartRate.warnMin,
      ecgHr_warnMax:   thresholds.ecgHeartRate.warnMax,
      ecgHr_dangerMin: thresholds.ecgHeartRate.dangerMin,
      ecgHr_dangerMax: thresholds.ecgHeartRate.dangerMax,
      spo2_normalMin:  thresholds.spo2.normalMin,
      spo2_normalMax:  thresholds.spo2.normalMax,
      spo2_warnMin:    thresholds.spo2.warnMin,
      spo2_warnMax:    thresholds.spo2.warnMax,
      spo2_dangerMin:  thresholds.spo2.dangerMin,
      spo2_dangerMax:  thresholds.spo2.dangerMax,
      temp_normalMin:  thresholds.temperature.normalMin,
      temp_normalMax:  thresholds.temperature.normalMax,
      temp_warnMin:    thresholds.temperature.warnMin,
      temp_warnMax:    thresholds.temperature.warnMax,
      temp_dangerMin:  thresholds.temperature.dangerMin,
      temp_dangerMax:  thresholds.temperature.dangerMax,
    };

    try {
      await Promise.all([
        saveDeviceAttributes(token, selectedDeviceId, "SERVER_SCOPE", serverAttrs),
        saveDeviceAttributes(token, selectedDeviceId, "SHARED_SCOPE", { vitalInterval, ecgSampleFreq, ecgPacketInterval, ppgSampleFreq, ppgRedLedMa, ppgIrLedMa }),
      ]);
      updateSettings({ vitalInterval, ecgSampleFreq, ecgPacketInterval, ppgSampleFreq, ppgRedLedMa, ppgIrLedMa, thresholds });

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
    setVitalInterval(DEFAULT_VITAL_INTERVAL);
    setEcgSampleFreq(DEFAULT_ECG_SAMPLE_FREQ);
    setEcgPacketInterval(DEFAULT_ECG_PACKET_INTERVAL);
    setPpgSampleFreq(DEFAULT_PPG_SAMPLE_FREQ);
    setPpgRedLedMa(DEFAULT_PPG_RED_LED_MA);
    setPpgIrLedMa(DEFAULT_PPG_IR_LED_MA);
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
        <title>Settings — WearableDev</title>
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
                  style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}
                >
                  <span>📡 {d.patientName || d.name}</span>
                  {d.patientName && <span style={{ fontSize:"0.7em", opacity:0.6, fontWeight:400 }}>{d.name}</span>}
                </button>
              ))}
            </div>
            {selectedDevice && (
              <div className="device-id-label">
                Editing: <span className="mono">{selectedDevice.patientName ? `${selectedDevice.patientName} — ` : ""}{selectedDevice.name}</span>
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
                  <div className="threshold-tiers">
                    <div className="tier-group tier-normal">
                      <div className="tier-label">🟢 NORMAL</div>
                      <div className="tier-fields">
                        <label className="threshold-field normal">
                          <span>Min</span>
                          <input type="number" step="0.1"
                            value={vals.normalMin}
                            onChange={e => setField(vital, "normalMin", e.target.value)} />
                        </label>
                        <label className="threshold-field normal">
                          <span>Max</span>
                          <input type="number" step="0.1"
                            value={vals.normalMax}
                            onChange={e => setField(vital, "normalMax", e.target.value)} />
                        </label>
                      </div>
                    </div>
                    <div className="tier-group tier-warning">
                      <div className="tier-label">🟡 WARNING</div>
                      <div className="tier-fields">
                        <label className="threshold-field warning">
                          <span>Min</span>
                          <input type="number" step="0.1"
                            value={vals.warnMin}
                            onChange={e => setField(vital, "warnMin", e.target.value)} />
                        </label>
                        <label className="threshold-field warning">
                          <span>Max</span>
                          <input type="number" step="0.1"
                            value={vals.warnMax}
                            onChange={e => setField(vital, "warnMax", e.target.value)} />
                        </label>
                      </div>
                    </div>
                    <div className="tier-group tier-danger">
                      <div className="tier-label">🔴 DANGEROUS</div>
                      <div className="tier-fields">
                        <label className="threshold-field danger">
                          <span>Min</span>
                          <input type="number" step="0.1"
                            value={vals.dangerMin}
                            onChange={e => setField(vital, "dangerMin", e.target.value)} />
                        </label>
                        <label className="threshold-field danger">
                          <span>Max</span>
                          <input type="number" step="0.1"
                            value={vals.dangerMax}
                            onChange={e => setField(vital, "dangerMax", e.target.value)} />
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </section>

          {/* ── Vital interval ── */}
          <section className="settings-section">
            <div className="section-title">VITAL INTERVAL</div>
            <div className="section-sub">
              Saved as a Shared attribute. Controls how frequently the node reports vital signs (HR, SpO₂, temperature) to the gateway. Lower = more frequent updates, higher power consumption.
            </div>
            <div className="interval-row">
              <input
                type="range"
                min={1000} max={30000} step={1000}
                value={vitalInterval}
                onChange={e => setVitalInterval(Number(e.target.value))}
                className="interval-slider"
              />
              <span className="interval-value">{vitalInterval >= 1000 ? `${vitalInterval/1000}s` : `${vitalInterval}ms`}</span>
            </div>
            <div className="interval-presets">
              {[1000, 2000, 5000, 10000, 15000, 30000].map(ms => (
                <button
                  key={ms}
                  className={`preset-btn ${vitalInterval === ms ? "preset-btn--active" : ""}`}
                  onClick={() => setVitalInterval(ms)}
                >
                  {ms < 1000 ? `${ms}ms` : `${ms/1000}s`}
                </button>
              ))}
            </div>
          </section>

          {/* ── ECG settings ── */}
          <section className="settings-section">
            <div className="section-title">ECG SETTINGS</div>
            <div className="section-sub">
              Saved as Shared attributes. The firmware reads these values to configure ECG acquisition and streaming behaviour.
            </div>

            {/* ECG sample frequency */}
            <div className="ecg-field-group">
              <div className="ecg-field-label">
                SAMPLE FREQUENCY
                <span className="ecg-field-unit">Hz</span>
              </div>
              <div className="ecg-field-sub">ADC sampling rate for the ECG signal. Higher rate captures more detail but increases data volume.</div>
              <div className="interval-row">
                <input
                  type="range"
                  min={50} max={1000} step={50}
                  value={ecgSampleFreq}
                  onChange={e => setEcgSampleFreq(Number(e.target.value))}
                  className="interval-slider"
                />
                <span className="interval-value">{ecgSampleFreq} Hz</span>
              </div>
              <div className="interval-presets">
                {ECG_FREQ_PRESETS.map(hz => (
                  <button
                    key={hz}
                    className={`preset-btn ${ecgSampleFreq === hz ? "preset-btn--active" : ""}`}
                    onClick={() => setEcgSampleFreq(hz)}
                  >
                    {hz} Hz
                  </button>
                ))}
              </div>
            </div>

            {/* ECG packet send interval */}
            <div className="ecg-field-group">
              <div className="ecg-field-label">
                PACKET SEND INTERVAL
                <span className="ecg-field-unit">ms</span>
              </div>
              <div className="ecg-field-sub">How often accumulated ECG samples are sent as a packet. Lower = lower latency, more packets per second.</div>
              <div className="interval-row">
                <input
                  type="range"
                  min={50} max={2000} step={50}
                  value={ecgPacketInterval}
                  onChange={e => setEcgPacketInterval(Number(e.target.value))}
                  className="interval-slider"
                />
                <span className="interval-value">{ecgPacketInterval >= 1000 ? `${ecgPacketInterval/1000}s` : `${ecgPacketInterval}ms`}</span>
              </div>
              <div className="interval-presets">
                {[50, 100, 200, 500, 1000, 2000].map(ms => (
                  <button
                    key={ms}
                    className={`preset-btn ${ecgPacketInterval === ms ? "preset-btn--active" : ""}`}
                    onClick={() => setEcgPacketInterval(ms)}
                  >
                    {ms < 1000 ? `${ms}ms` : `${ms/1000}s`}
                  </button>
                ))}
              </div>
              <div className="interval-hint">
                Samples per packet = {ecgSampleFreq} Hz × {ecgPacketInterval} ms / 1000 = <strong>{Math.round(ecgSampleFreq * ecgPacketInterval / 1000)} samples</strong>
              </div>
            </div>
          </section>

          {/* ── PPG settings ── */}
          <section className="settings-section">
            <div className="section-title">PPG SETTINGS</div>
            <div className="section-sub">
              Saved as Shared attributes. Controls the MAX30102 sensor: photodetector sampling rate and LED drive currents for SpO₂ and heart rate acquisition.
            </div>

            {/* PPG sample frequency */}
            <div className="ecg-field-group">
              <div className="ecg-field-label">
                SAMPLE FREQUENCY
                <span className="ecg-field-unit">Hz</span>
              </div>
              <div className="ecg-field-sub">Photodetector sampling rate. Higher rates improve signal quality but increase power consumption.</div>
              <div className="interval-row">
                <input
                  type="range"
                  min={0} max={PPG_FREQ_OPTIONS.length - 1} step={1}
                  value={PPG_FREQ_OPTIONS.indexOf(ppgSampleFreq) === -1 ? 1 : PPG_FREQ_OPTIONS.indexOf(ppgSampleFreq)}
                  onChange={e => setPpgSampleFreq(PPG_FREQ_OPTIONS[Number(e.target.value)])}
                  className="interval-slider"
                />
                <span className="interval-value">{ppgSampleFreq} Hz</span>
              </div>
              <div className="interval-presets">
                {PPG_FREQ_OPTIONS.map(hz => (
                  <button
                    key={hz}
                    className={`preset-btn ${ppgSampleFreq === hz ? "preset-btn--active" : ""}`}
                    onClick={() => setPpgSampleFreq(hz)}
                  >
                    {hz} Hz
                  </button>
                ))}
              </div>
            </div>

            {/* Red LED current */}
            <div className="ecg-field-group">
              <div className="ecg-field-label">
                RED LED CURRENT
                <span className="ecg-field-unit">mA</span>
              </div>
              <div className="ecg-field-sub">Drive current for the red LED (660 nm). Higher current improves signal through thicker or darker tissue.</div>
              <div className="interval-row">
                <input
                  type="range"
                  min={0} max={51} step={1}
                  value={ppgRedLedMa}
                  onChange={e => setPpgRedLedMa(Number(e.target.value))}
                  className="interval-slider interval-slider--red"
                />
                <span className="interval-value interval-value--red">{ppgRedLedMa} mA</span>
              </div>
              <div className="interval-presets">
                {[3, 6, 12, 25, 51].map(ma => (
                  <button
                    key={ma}
                    className={`preset-btn ${ppgRedLedMa === ma ? "preset-btn--active preset-btn--red" : ""}`}
                    onClick={() => setPpgRedLedMa(ma)}
                  >
                    {ma} mA
                  </button>
                ))}
              </div>
            </div>

            {/* IR LED current */}
            <div className="ecg-field-group">
              <div className="ecg-field-label">
                IR LED CURRENT
                <span className="ecg-field-unit">mA</span>
              </div>
              <div className="ecg-field-sub">Drive current for the infrared LED (880 nm). Used alongside the red LED for SpO₂ ratio calculation.</div>
              <div className="interval-row">
                <input
                  type="range"
                  min={0} max={51} step={1}
                  value={ppgIrLedMa}
                  onChange={e => setPpgIrLedMa(Number(e.target.value))}
                  className="interval-slider interval-slider--ir"
                />
                <span className="interval-value interval-value--ir">{ppgIrLedMa} mA</span>
              </div>
              <div className="interval-presets">
                {[3, 6, 12, 25, 51].map(ma => (
                  <button
                    key={ma}
                    className={`preset-btn ${ppgIrLedMa === ma ? "preset-btn--active preset-btn--ir" : ""}`}
                    onClick={() => setPpgIrLedMa(ma)}
                  >
                    {ma} mA
                  </button>
                ))}
              </div>
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

        .threshold-tiers {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 10px;
        }
        @media (max-width: 560px) {
          .threshold-tiers { grid-template-columns: 1fr; }
        }
        .tier-group {
          border-radius: 8px;
          padding: 10px 12px;
        }
        .tier-normal  { background: rgba(34,197,94,0.06);  border: 1px solid rgba(34,197,94,0.22);  }
        .tier-warning { background: rgba(245,158,11,0.06); border: 1px solid rgba(245,158,11,0.22); }
        .tier-danger  { background: rgba(239,68,68,0.06);  border: 1px solid rgba(239,68,68,0.22);  }
        .tier-label {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.08em;
          margin-bottom: 8px;
          color: var(--text-primary, #2c3e50);
        }
        .tier-fields {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .threshold-field {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .threshold-field span {
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.06em;
          color: var(--text-muted, #94a3b8);
        }
        .threshold-field.normal span  { color: #22c55e; }
        .threshold-field.warning span { color: #f59e0b; }
        .threshold-field.danger span  { color: #ef4444; }
        .threshold-field input {
          padding: 6px 10px;
          border-radius: 6px;
          border: 1px solid var(--border, #e2e8f0);
          background: var(--bg-card, #fff);
          color: var(--text-primary, #2c3e50);
          font-size: 13px;
          font-family: inherit;
          width: 100%;
          box-sizing: border-box;
        }
        .threshold-field.normal input  { border-color: rgba(34,197,94,0.35); }
        .threshold-field.warning input { border-color: rgba(245,158,11,0.35); }
        .threshold-field.danger input  { border-color: rgba(239,68,68,0.35); }
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
        .interval-slider--red  { accent-color: #ef4444; }
        .interval-slider--ir   { accent-color: #8b5cf6; }
        .interval-value--red   { color: #ef4444; }
        .interval-value--ir    { color: #8b5cf6; }
        .preset-btn--red { border-color: #ef4444; background: rgba(239,68,68,0.08); color: #ef4444; }
        .preset-btn--ir  { border-color: #8b5cf6; background: rgba(139,92,246,0.08); color: #8b5cf6; }

        /* ECG settings */
        .ecg-field-group {
          border: 1px solid var(--border, #e2e8f0);
          border-radius: 10px;
          padding: 14px 16px;
          margin-bottom: 12px;
        }
        .ecg-field-group:last-child { margin-bottom: 0; }
        .ecg-field-label {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.08em;
          color: var(--text-primary, #2c3e50);
          margin-bottom: 4px;
          display: flex;
          align-items: baseline;
          gap: 6px;
        }
        .ecg-field-unit {
          font-size: 10px;
          font-weight: 400;
          color: var(--text-muted, #94a3b8);
          letter-spacing: 0;
        }
        .ecg-field-sub {
          font-size: 11px;
          color: var(--text-muted, #94a3b8);
          margin-bottom: 10px;
          line-height: 1.4;
        }
        .ecg-value-display {
          font-size: 18px;
          font-weight: 700;
          color: #00c8ff;
          margin-top: 8px;
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
        :global([data-theme="dark"]) .ecg-field-group {
          border-color: #334155;
        }
      `}</style>
    </>
  );
}