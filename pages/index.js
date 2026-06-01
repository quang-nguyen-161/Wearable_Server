// pages/index.js
import { useState, useEffect, useCallback, useRef } from "react";
import Head from "next/head";
import VitalCard from "../components/VitalCard";
import TrendChart from "../components/TrendChart";
import { useTbWebSocket } from "../hooks/useTbWebSocket";

import NodeDetailModal from "../components/NodeDetailModal";
import VitalHistoryModal from "../components/VitalHistoryModal";
import OverviewGrid from "../components/OverviewGrid";
import PrintModal from "../components/PrintModal";
import OtaModal from "../components/OtaModal";
import { useNotifications } from "../hooks/useNotifications";
import { useTrends } from "../hooks/useTrends";
import { useSettings } from "../context/SettingsContext";
import { useTbAuth } from "../context/TbAuthContext";
import { getDevices, getPatientInfo, saveDeviceAttributes, createDevice, addDeviceRelation, deleteDevice, GATEWAY_ID } from "../lib/tbBrowserClient";

/* ── Vital definitions ─────────────────────────────────────────────── */
const VITALS = [
  {
    key: "ppgHeartRate",
    label: "PPG HEART RATE",
    icon: "❤️",
    unit: "bpm",
    color: "cyan",
    min: 60, max: 100,
    warnMin: 50,  warnMax: 120,
    dangerMin: 40, dangerMax: 130,
  },
  {
    key: "ecgHeartRate",
    label: "ECG HEART RATE",
    icon: "💓",
    unit: "bpm",
    color: "cyan",
    min: 60, max: 100,
    warnMin: 50,  warnMax: 120,
    dangerMin: 40, dangerMax: 130,
  },
  {
    key: "spo2",
    label: "SpO₂",
    icon: "🩸",
    unit: "%",
    color: "green",
    min: 95, max: 100,
    warnMin: 90,  warnMax: 100,
    dangerMin: 88, dangerMax: 100,
  },
  {
    key: "temperature",
    label: "TEMPERATURE",
    icon: "🌡️",
    unit: "°C",
    color: "amber",
    min: 36.1, max: 37.2,
    warnMin: 35.5, warnMax: 38.5,
    dangerMin: 35.0, dangerMax: 39.5,
  },
];

/* ── Signal Modal ────────────────────────────────────────────────────────── */
const SIGNAL_META = {
  ecg: { label: "ECG SIGNAL", color: "#FF96B7", unit: "µV" },
  ppg: { label: "PPG SIGNAL", color: "#70AD47", unit: "a.u." },
};

const SIGNAL_WINDOWS = [
  { label: "3s",  value: 3  },
  { label: "5s",  value: 5  },
  { label: "10s", value: 10 },
  { label: "30s", value: 30 },
  { label: "60s", value: 60 },
];

function SignalModal({ signalKey, series, onClose }) {
  const meta = SIGNAL_META[signalKey];
  const [windowSec, setWindowSec] = useState(10);

  useEffect(() => {
    const fn = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  // Filter series to selected time window
  const cutoff      = Date.now() - windowSec * 1000;
  const displayData = (series || []).filter(d => d.ts >= cutoff);
  const pointCount  = displayData.length;
  const effectiveHz = pointCount > 0 && windowSec > 0
    ? Math.round(pointCount / windowSec)
    : 0;

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: 16,
        backdropFilter: "blur(3px)",
      }}
    >
      <div style={{
        background: "var(--bg-card, #fff)",
        borderRadius: 16,
        border: `1.5px solid ${meta.color}30`,
        width: "100%", maxWidth: 900,
        maxHeight: "90vh", overflowY: "auto",
        animation: "sm-in .18s ease",
        boxShadow: `0 0 40px ${meta.color}18`,
      }}>
        <style>{`@keyframes sm-in{from{opacity:0;transform:scale(.97) translateY(6px)}to{opacity:1;transform:scale(1) translateY(0)}}`}</style>

        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 20px",
          borderBottom: `1px solid ${meta.color}20`,
          position: "sticky", top: 0,
          background: "var(--bg-card, #fff)", zIndex: 2,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8,
              background: `${meta.color}15`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 16, color: meta.color, fontWeight: 700,
            }}>〜</div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.06em", color: "var(--text-primary, #1e293b)" }}>
                {meta.label}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted, #94a3b8)", marginTop: 2 }}>
                Live · WebSocket · {pointCount} pts · ~{effectiveHz} Hz
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{
            fontSize: 22, background: "none", border: "none",
            cursor: "pointer", color: "var(--text-muted, #94a3b8)",
            padding: "4px 8px", borderRadius: 6, fontFamily: "inherit",
          }}>×</button>
        </div>

        {/* Interval selector */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "12px 20px",
          borderBottom: `1px solid ${meta.color}15`,
          flexWrap: "wrap",
        }}>
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: "0.1em",
            color: "var(--text-muted, #94a3b8)", marginRight: 4,
          }}>DISPLAY WINDOW</span>

          <div style={{
            display: "flex", gap: 4,
            background: "var(--bg-void, #f1f5f9)",
            borderRadius: 8, padding: 3,
          }}>
            {SIGNAL_WINDOWS.map(w => (
              <button
                key={w.label}
                onClick={() => setWindowSec(w.value)}
                style={{
                  fontSize: 11, fontWeight: 700, padding: "5px 12px",
                  borderRadius: 6, border: "none", cursor: "pointer",
                  fontFamily: "inherit",
                  background: windowSec === w.value
                    ? "var(--bg-card, #fff)"
                    : "transparent",
                  color: windowSec === w.value
                    ? meta.color
                    : "var(--text-muted, #94a3b8)",
                  boxShadow: windowSec === w.value
                    ? "0 1px 4px rgba(0,0,0,0.1)"
                    : "none",
                  transition: "all 0.15s",
                }}
              >{w.label}</button>
            ))}
          </div>

          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted, #94a3b8)" }}>
            Showing last <strong style={{ color: meta.color }}>{windowSec}s</strong> · {pointCount} samples
          </span>
        </div>

        {/* Large chart */}
        <div style={{ padding: "16px 20px 24px" }}>
          <TrendChart
            series={displayData}
            metricKey={signalKey}
            loading={false}
          />
        </div>
      </div>
    </div>
  );
}

/* ── Overview Modal ──────────────────────────────────────────────────────── */
function OverviewModal({ devices, vitalsMap, selectedDeviceId, onSelectDevice, onClose }) {
  useEffect(() => {
    const fn = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: 16,
        backdropFilter: "blur(3px)",
      }}
    >
      <div style={{
        background: "var(--bg-card, #fff)",
        borderRadius: 16,
        border: "0.5px solid var(--border, #e2e8f0)",
        width: "100%", maxWidth: 900,
        maxHeight: "90vh", overflowY: "auto",
        animation: "ov-in .18s ease",
      }}>
        <style>{`@keyframes ov-in{from{opacity:0;transform:scale(.96) translateY(6px)}to{opacity:1;transform:scale(1) translateY(0)}}`}</style>

        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 20px",
          borderBottom: "0.5px solid var(--border, #e2e8f0)",
          position: "sticky", top: 0,
          background: "var(--bg-card, #fff)", zIndex: 2,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8,
              background: "rgba(0,200,255,0.1)",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18,
            }}>⊞</div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary, #1e293b)" }}>Overview</div>
              <div style={{ fontSize: 11, color: "var(--text-muted, #94a3b8)" }}>
                All nodes — live vitals snapshot · {devices.length} node{devices.length !== 1 ? "s" : ""}
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{
            fontSize: 22, background: "none", border: "none",
            cursor: "pointer", color: "var(--text-muted, #94a3b8)",
            padding: "4px 8px", borderRadius: 6, fontFamily: "inherit",
          }}>×</button>
        </div>

        {/* Grid */}
        <OverviewGrid
          devices={devices}
          vitalsMap={vitalsMap}
          selectedDeviceId={selectedDeviceId}
          onSelectDevice={(id) => { onSelectDevice(id); onClose(); }}
        />
      </div>
    </div>
  );
}

/* ── Patient Modal ────────────────────────────────────────────────────────── */
function PatientModal({ patient, deviceId, onClose, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);

  // Editable form state — mirrors all TB attributes
  const [form, setForm] = useState({
    patientName:    patient.patientName    || "",
    patientId:      patient.patientId      || "",
    ward:           patient.ward           || "",
    physician:      patient.physician      || "",
    age:            patient.age            || "",
    gender:         patient.gender         || "",
    bloodType:      patient.bloodType      || "",
    weight:         patient.weight         || "",
    hospitalPhone:  patient.hospitalPhone  || "",
    physicianPhone: patient.physicianPhone || "",
    familyPhone:    patient.familyPhone    || "",
  });

  useEffect(() => {
    const fn = e => {
      if (e.key === "Escape") {
        if (editing) setEditing(false);
        else onClose();
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose, editing]);

  const set = (key, val) => setForm(prev => ({ ...prev, [key]: val }));

  const { token: patientSaveToken } = useTbAuth();
  const handleSave = async () => {
    if (!deviceId) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      await saveDeviceAttributes(patientSaveToken, deviceId, "SERVER_SCOPE", {
        patientName:    form.patientName,
        patientId:      form.patientId,
        ward:           form.ward,
        physician:      form.physician,
        age:            form.age ? Number(form.age) : null,
        gender:         form.gender,
        bloodType:      form.bloodType,
        weight:         form.weight ? Number(form.weight) : null,
        hospitalPhone:  form.hospitalPhone,
        physicianPhone: form.physicianPhone,
        familyPhone:    form.familyPhone,
      });
      setSaveMsg({ type: "ok", text: "Saved to ThingsBoard ✓" });
      setEditing(false);
      onSaved(form); // update parent state so bar refreshes
    } catch (e) {
      setSaveMsg({ type: "err", text: e.message });
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(null), 3000);
    }
  };

  const FIXED_EMERGENCY = [
    { label: "Emergency", number: "113", icon: "🚨" },
    { label: "Ambulance", number: "115", icon: "🚑" },
  ];

  const inputStyle = (editing) => ({
    width: "100%", boxSizing: "border-box",
    padding: "7px 10px",
    borderRadius: 7,
    border: editing
      ? "1px solid #00c8ff"
      : "0.5px solid var(--border, #e2e8f0)",
    background: editing
      ? "var(--bg-card, #fff)"
      : "var(--bg-void, #f8fafc)",
    color: "var(--text-primary, #1e293b)",
    fontSize: 14, fontWeight: 600,
    fontFamily: "inherit",
    outline: "none",
    transition: "border 0.15s, background 0.15s",
  });

  const INFO_FIELDS = [
    { key: "patientName",  label: "Patient Name",  type: "text"   },
    { key: "patientId",    label: "Patient ID",    type: "text"   },
    { key: "ward",         label: "Ward",          type: "text"   },
    { key: "physician",    label: "Physician",     type: "text"   },
    { key: "age",          label: "Age",           type: "number" },
    { key: "gender",       label: "Gender",        type: "text",
      options: ["", "Male", "Female", "Other"] },
    { key: "bloodType",    label: "Blood Type",    type: "text",
      options: ["", "A+", "A−", "B+", "B−", "O+", "O−", "AB+", "AB−"] },
    { key: "weight",       label: "Weight (kg)",   type: "number" },
  ];

  const PHONE_FIELDS = [
    { key: "hospitalPhone",  label: "Hospital Reception", icon: "🏥" },
    { key: "physicianPhone", label: "Physician",          icon: "👨‍⚕️" },
    { key: "familyPhone",    label: "Family Contact",     icon: "👨‍👩‍👧" },
  ];

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: 16,
        backdropFilter: "blur(3px)",
      }}
    >
      <div style={{
        background: "var(--bg-card, #fff)",
        borderRadius: 16,
        border: "0.5px solid var(--border, #e2e8f0)",
        width: "100%", maxWidth: 560,
        maxHeight: "92vh", overflowY: "auto",
        animation: "pm-in .18s ease",
      }}>
        <style>{`@keyframes pm-in{from{opacity:0;transform:scale(.96) translateY(6px)}to{opacity:1;transform:scale(1) translateY(0)}}`}</style>

        {/* ── Header ── */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 20px",
          borderBottom: "0.5px solid var(--border, #e2e8f0)",
          position: "sticky", top: 0,
          background: "var(--bg-card, #fff)",
          zIndex: 2,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{
              width: 44, height: 44, borderRadius: "50%",
              background: "var(--bg-void, #f1f5f9)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 22,
            }}>🧑‍⚕️</div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary, #1e293b)" }}>
                {form.patientName || "Patient"}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted, #94a3b8)", marginTop: 2 }}>
                ID: {form.patientId || "N/A"} · Ward: {form.ward || "N/A"}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {!editing ? (
              <button onClick={() => setEditing(true)} style={{
                fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
                padding: "7px 14px", borderRadius: 8,
                border: "1px solid var(--border, #e2e8f0)",
                background: "var(--bg-void, #f8fafc)",
                color: "var(--text-primary, #1e293b)",
                cursor: "pointer", fontFamily: "inherit",
              }}>✏ EDIT</button>
            ) : (
              <>
                <button onClick={() => { setEditing(false); setForm({
                  patientName: patient.patientName || "", patientId: patient.patientId || "",
                  ward: patient.ward || "", physician: patient.physician || "",
                  age: patient.age || "", gender: patient.gender || "",
                  bloodType: patient.bloodType || "", weight: patient.weight || "",
                  hospitalPhone: patient.hospitalPhone || "",
                  physicianPhone: patient.physicianPhone || "",
                  familyPhone: patient.familyPhone || "",
                }); }} style={{
                  fontSize: 11, fontWeight: 700, padding: "7px 14px",
                  borderRadius: 8, border: "1px solid var(--border, #e2e8f0)",
                  background: "none", color: "var(--text-muted, #94a3b8)",
                  cursor: "pointer", fontFamily: "inherit",
                }}>CANCEL</button>
                <button onClick={handleSave} disabled={saving} style={{
                  fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
                  padding: "7px 16px", borderRadius: 8,
                  border: "none", background: "#00c8ff", color: "#fff",
                  cursor: saving ? "not-allowed" : "pointer",
                  opacity: saving ? 0.7 : 1, fontFamily: "inherit",
                }}>{saving ? "SAVING…" : "SAVE"}</button>
              </>
            )}
            <button onClick={onClose} style={{
              fontSize: 22, background: "none", border: "none",
              cursor: "pointer", color: "var(--text-muted, #94a3b8)",
              padding: "4px 8px", borderRadius: 6, fontFamily: "inherit",
            }}>×</button>
          </div>
        </div>

        {/* Save message */}
        {saveMsg && (
          <div style={{
            margin: "0 20px", padding: "8px 14px", borderRadius: 8,
            marginTop: 12,
            background: saveMsg.type === "ok" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
            color: saveMsg.type === "ok" ? "#22c55e" : "#ef4444",
            fontSize: 12, fontWeight: 600,
          }}>{saveMsg.text}</div>
        )}

        {/* ── Patient Info Fields ── */}
        <div style={{ padding: "16px 20px", borderBottom: "0.5px solid var(--border, #e2e8f0)" }}>
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: "0.1em",
            color: "var(--text-muted, #94a3b8)", marginBottom: 12,
            display: "flex", alignItems: "center", gap: 8,
          }}>
            PATIENT INFORMATION
            {editing && <span style={{ color: "#00c8ff", fontWeight: 600 }}>— editing</span>}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {INFO_FIELDS.map(({ key, label, type, options }) => (
              <div key={key} style={{
                background: "var(--bg-void, #f8fafc)",
                borderRadius: 8, padding: "10px 12px",
                border: editing ? "1px solid rgba(0,200,255,0.2)" : "0.5px solid var(--border, #e2e8f0)",
                transition: "border 0.15s",
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-muted, #94a3b8)", marginBottom: 6 }}>
                  {label.toUpperCase()}
                </div>
                {editing ? (
                  options ? (
                    <select value={form[key]} onChange={e => set(key, e.target.value)}
                      style={{ ...inputStyle(true), padding: "6px 8px" }}>
                      {options.map(o => <option key={o} value={o}>{o || "—"}</option>)}
                    </select>
                  ) : (
                    <input type={type} value={form[key]}
                      onChange={e => set(key, e.target.value)}
                      placeholder={`Enter ${label.toLowerCase()}`}
                      style={inputStyle(true)} />
                  )
                ) : (
                  <div style={{ fontSize: 14, fontWeight: 600, color: form[key] ? "var(--text-primary, #1e293b)" : "var(--text-muted, #94a3b8)" }}>
                    {form[key] || "—"}
                    {key === "age" && form[key] ? " yr" : ""}
                    {key === "weight" && form[key] ? " kg" : ""}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ── Emergency Contacts ── */}
        <div style={{ padding: "16px 20px 20px" }}>
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: "0.1em",
            color: "#ef4444", marginBottom: 12,
            display: "flex", alignItems: "center", gap: 6,
          }}>🚨 EMERGENCY CONTACTS</div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>

            {/* Fixed system numbers */}
            {FIXED_EMERGENCY.map(({ label, number, icon }) => (
              <div key={label} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                background: "var(--bg-void, #f8fafc)",
                borderRadius: 10, padding: "12px 16px",
                border: "0.5px solid var(--border, #e2e8f0)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 20 }}>{icon}</span>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary, #1e293b)" }}>{label}</div>
                    <div style={{ fontSize: 13, color: "#64748b", fontFamily: "monospace", marginTop: 2 }}>{number}</div>
                  </div>
                </div>
                <a href={`tel:${number}`} style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 36, height: 36, borderRadius: "50%",
                  background: "rgba(239,68,68,0.1)", color: "#ef4444",
                  textDecoration: "none", fontSize: 16,
                }}>📞</a>
              </div>
            ))}

            {/* Editable phone fields */}
            {PHONE_FIELDS.map(({ key, label, icon }) => (
              <div key={key} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                background: "var(--bg-void, #f8fafc)",
                borderRadius: 10, padding: "12px 16px",
                border: editing ? "1px solid rgba(0,200,255,0.2)" : "0.5px solid var(--border, #e2e8f0)",
                transition: "border 0.15s",
                gap: 10,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
                  <span style={{ fontSize: 20 }}>{icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary, #1e293b)", marginBottom: 4 }}>{label}</div>
                    {editing ? (
                      <input
                        type="tel"
                        value={form[key]}
                        onChange={e => set(key, e.target.value)}
                        placeholder="Enter phone number"
                        style={{ ...inputStyle(true), fontSize: 13 }}
                      />
                    ) : (
                      <div style={{ fontSize: 13, color: form[key] ? "#64748b" : "var(--text-muted, #94a3b8)", fontFamily: "monospace" }}>
                        {form[key] || "— not set"}
                      </div>
                    )}
                  </div>
                </div>
                {!editing && form[key] && (
                  <a href={`tel:${form[key]}`} style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 36, height: 36, borderRadius: "50%",
                    background: "rgba(239,68,68,0.1)", color: "#ef4444",
                    textDecoration: "none", fontSize: 16, flexShrink: 0,
                  }}>📞</a>
                )}
              </div>
            ))}
          </div>

          {!editing && (
            <div style={{ marginTop: 12, fontSize: 11, color: "var(--text-muted, #94a3b8)", textAlign: "center" }}>
              Click <strong>✏ EDIT</strong> to update patient info and phone numbers
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Add Node Modal ─────────────────────────────────────────────────── */
function AddNodeModal({ onClose, onCreated, token, gatewayId }) {
  const [name,   setName]   = useState("");
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState(null);

  useEffect(() => {
    const fn = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setMsg({ type: "err", text: "Node name is required." }); return; }
    if (!trimmed.toLowerCase().includes("node")) {
      setMsg({ type: "err", text: 'Name must contain "node" (e.g. Node7, NodeBed3).' }); return;
    }
    setSaving(true);
    setMsg(null);
    try {
      await createDevice(token, trimmed);
      setMsg({ type: "ok", text: `"${trimmed}" created ✓` });
      setTimeout(() => { onCreated(); onClose(); }, 800);
    } catch (e) {
      setMsg({ type: "err", text: e.message });
      setSaving(false);
    }
  };

  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: 16, backdropFilter: "blur(3px)" }}>
      <div style={{ background: "var(--bg-card,#fff)", borderRadius: 16,
        border: "0.5px solid var(--border,#e2e8f0)", width: "100%", maxWidth: 460,
        animation: "ota-in .18s ease" }}
        onClick={e => e.stopPropagation()}>
        <style>{`@keyframes ota-in{from{opacity:0;transform:scale(.96) translateY(6px)}to{opacity:1;transform:scale(1) translateY(0)}}`}</style>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 20px", borderBottom: "0.5px solid var(--border,#e2e8f0)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(91,155,213,0.12)",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>📡</div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary,#1e293b)" }}>Add New Node</div>
              <div style={{ fontSize: 11, color: "var(--text-muted,#94a3b8)" }}>Create a new device in ThingsBoard</div>
            </div>
          </div>
          <button onClick={onClose} style={{ fontSize: 22, background: "none", border: "none",
            cursor: "pointer", color: "var(--text-muted,#94a3b8)", padding: "4px 8px",
            borderRadius: 6, fontFamily: "inherit" }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: "16px 20px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted,#64748b)",
              letterSpacing: "0.06em", marginBottom: 8 }}>DEVICE NAME</div>
            <input
              autoFocus
              type="text"
              placeholder="e.g. Node7, NodeBed3, NodeICU"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleCreate(); }}
              style={{ width: "100%", boxSizing: "border-box",
                padding: "9px 12px", borderRadius: 8,
                border: "1.5px solid var(--border,#e2e8f0)",
                background: "var(--bg-void,#f8fafc)",
                color: "var(--text-primary,#1e293b)",
                fontSize: 14, fontWeight: 600, outline: "none", fontFamily: "inherit" }}
            />
            <div style={{ fontSize: 11, color: "var(--text-muted,#94a3b8)", marginTop: 6 }}>
              Name must contain <strong>node</strong> to appear in the dashboard.
            </div>
          </div>

          {msg && (
            <div style={{ padding: "8px 12px", borderRadius: 8, fontSize: 13,
              background: msg.type === "ok" ? "#d1fae5" : "#fee2e2",
              color:      msg.type === "ok" ? "#065f46" : "#991b1b" }}>
              {msg.text}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button onClick={onClose}
              style={{ padding: "8px 18px", borderRadius: 8,
                border: "1px solid var(--border,#e2e8f0)", background: "none",
                cursor: "pointer", fontSize: 13, color: "var(--text-primary,#1e293b)", fontFamily: "inherit" }}>
              Cancel
            </button>
            <button onClick={handleCreate} disabled={saving}
              style={{ padding: "8px 22px", borderRadius: 8, border: "none",
                background: saving ? "#94a3b8" : "#5B9BD5",
                color: "#fff", fontWeight: 700, cursor: saving ? "not-allowed" : "pointer",
                fontSize: 13, fontFamily: "inherit" }}>
              {saving ? "Creating…" : "Create Node"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

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
  const [modalDevice,      setModalDevice]      = useState(null);
  const [vitalModal,       setVitalModal]       = useState(null);
  const [patientModal,     setPatientModal]     = useState(false);
  const [signalModal,      setSignalModal]      = useState(null);
  const [printModal,       setPrintModal]       = useState(false);
  const [otaModal,         setOtaModal]         = useState(false);
  const [overviewModal,    setOverviewModal]    = useState(false);
  const [vitalsMap,        setVitalsMap]        = useState({}); // { [deviceId]: vitals }
  const [notificationsOn,  setNotificationsOn]  = useState(true);
  const [addNodeModal,     setAddNodeModal]     = useState(false);

  /* ── TB token for WebSocket — use browser login token directly ── */
  const { token: tbAuthToken, logout } = useTbAuth();
  useEffect(() => {
    if (tbAuthToken) setTbToken(tbAuthToken);
  }, [tbAuthToken]);

  /* ── Per-device settings (thresholds, vitalInterval, ecgSampleFreq) ── */
  const { settings, loadSettings } = useSettings(selectedDeviceId);
  useEffect(() => { loadSettings(); }, [selectedDeviceId, loadSettings]);

  /* ── WebSocket: real-time vitals + ECG/PPG for selected node ── */
  const {
    vitals,
    ecgData,
    lastBatchTs,
    connected,
    lastUpdate,
  } = useTbWebSocket(selectedDeviceId, tbToken, settings.ecgSampleFreq);

  /* ── No-signal detection (CoAP waveform batches) ── */
  // Timeout = 3× vitalInterval so we don't cry wolf when the interval is long
  const [noSignal, setNoSignal] = useState(false);
  useEffect(() => {
    if (!lastBatchTs) return;
    setNoSignal(false);
    const timeout = Math.max(settings.vitalInterval * 3, 10000);
    const timer = setTimeout(() => setNoSignal(true), timeout);
    return () => clearTimeout(timer);
  }, [lastBatchTs, settings.vitalInterval]);

  /* ── Trend arrows for current node ── */
  const trends = useTrends(vitals);

  /* ── Push notifications + sound for selected node ── */
  const selectedDevice = devices.find(d => d.id === selectedDeviceId);
  useNotifications(selectedDevice?.name, vitals, notificationsOn, settings.thresholds);

  /* ── Sync vitals into vitalsMap for OverviewGrid ── */
  useEffect(() => {
    if (!selectedDeviceId || !vitals) return;
    setVitalsMap(prev => ({ ...prev, [selectedDeviceId]: vitals }));
  }, [vitals, selectedDeviceId]);

  /* ── Track per-device alerts from live vitals ── */
  useEffect(() => {
    if (!selectedDeviceId || !vitals) return;
    const { thresholds } = settings;
    const ppgHr = vitals?.ppgHeartRate?.value;
    const ecgHr = vitals?.ecgHeartRate?.value;
    const spo2  = vitals?.spo2?.value;
    const temp  = vitals?.temperature?.value;
    const hasAlert =
      (ppgHr != null && (ppgHr < thresholds.ppgHeartRate.dangerMin || ppgHr > thresholds.ppgHeartRate.dangerMax)) ||
      (ecgHr != null && (ecgHr < thresholds.ecgHeartRate.dangerMin || ecgHr > thresholds.ecgHeartRate.dangerMax)) ||
      (spo2  != null && (spo2  < thresholds.spo2.dangerMin         || spo2  > thresholds.spo2.dangerMax))         ||
      (temp  != null && (temp  < thresholds.temperature.dangerMin  || temp  > thresholds.temperature.dangerMax));
    setDeviceAlerts((prev) => ({ ...prev, [selectedDeviceId]: hasAlert }));
  }, [vitals, selectedDeviceId, settings]);

  /* ── Fetch device list ── */
  const fetchDevices = useCallback(async () => {
    if (!tbAuthToken) return;
    setDevicesLoading(true);
    try {
      const list = await getDevices(tbAuthToken);
      setDevices(list);
      if (list.length > 0 && !selectedDeviceId) setSelectedDeviceId(list[0].id);
    } catch (err) {
      console.error("Device list fetch error:", err);
      setError(err.message);
    } finally {
      setDevicesLoading(false);
    }
  }, [tbAuthToken]);

  /* ── Delete a node device ── */
  const handleDeleteNode = useCallback(async (deviceId, deviceName) => {
    if (!window.confirm(`Delete "${deviceName}" from ThingsBoard?\n\nThis is permanent — all telemetry history will be lost.`)) return;
    try {
      await deleteDevice(tbAuthToken, deviceId);
      if (selectedDeviceId === deviceId) setSelectedDeviceId(null);
      await fetchDevices();
    } catch (e) {
      alert(`Failed to delete: ${e.message}`);
    }
  }, [tbAuthToken, selectedDeviceId, fetchDevices]);

  /* ── Fetch patient info ── */
  const fetchPatient = useCallback(async (deviceId) => {
    if (!deviceId || !tbAuthToken) return;
    try {
      const info = await getPatientInfo(tbAuthToken, deviceId);
      setPatient(info ?? null);
    } catch (_) { setPatient(null); }
  }, [tbAuthToken]);

  /* ── Init ── */
  useEffect(() => {
    const savedTheme = localStorage.getItem("theme") || "light";
    setTheme(savedTheme);
    document.documentElement.setAttribute("data-theme", savedTheme);
  }, []);

  useEffect(() => {
    if (tbAuthToken) fetchDevices();
  }, [tbAuthToken, fetchDevices]);

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
        {/* ── Sidebar ── */}
        <aside className="sidebar">
          <div className="sidebar-brand">
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
              <div className="brand-name">WearableDev</div>
              <div className="brand-sub">HEALTH MONITOR</div>
            </div>
          </div>

          <nav className="sidebar-nav">
            <div className="sidebar-section-label">FEATURES</div>

            <button
              className="nav-item"
              onClick={() => setOverviewModal(true)}
            >
              <span className="nav-icon">⊞</span>
              <span className="nav-label">Overview</span>
            </button>

            <button
              className={`nav-item${!notificationsOn ? " nav-item--muted" : ""}`}
              onClick={() => setNotificationsOn(v => !v)}
            >
              <span className="nav-icon">{notificationsOn ? "🔔" : "🔕"}</span>
              <span className="nav-label">Alerts</span>
              {!notificationsOn && <span className="nav-badge">MUTED</span>}
            </button>

            <button
              className="nav-item"
              onClick={() => setOtaModal(true)}
            >
              <span className="nav-icon">⬆️</span>
              <span className="nav-label">OTA Update</span>
            </button>

            <button
              className="nav-item"
              onClick={() => setPrintModal(true)}
            >
              <span className="nav-icon">🖨️</span>
              <span className="nav-label">Print / Export</span>
            </button>

            <a
              href={selectedDeviceId ? `/settings?deviceId=${selectedDeviceId}` : "/settings"}
              className="nav-item"
            >
              <span className="nav-icon">⚙</span>
              <span className="nav-label">Settings</span>
            </a>
          </nav>

          <div className="sidebar-bottom">
            <div className="sidebar-status">
              <span className={`status-dot ${connected ? "" : "offline"}`} />
              <span className="sidebar-status-text">{connected ? "LIVE" : "OFFLINE"}</span>
            </div>
            {lastUpdate && (
              <div className="sidebar-last-update">Updated {formatTime(lastUpdate)}</div>
            )}
            <button
              className="nav-item"
              onClick={toggleTheme}
              title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
            >
              <span className="nav-icon">{theme === "light" ? "🌙" : "☀️"}</span>
              <span className="nav-label">{theme === "light" ? "Dark Mode" : "Light Mode"}</span>
            </button>
            <button
              className="refresh-btn"
              style={{ margin: "4px 2px 0" }}
              onClick={fetchDevices}
            >
              ⟳ REFRESH
            </button>
            <button
              className="refresh-btn"
              style={{ margin: "2px 2px 0", opacity: 0.7 }}
              onClick={logout}
            >
              ⏻ SIGN OUT
            </button>
          </div>
        </aside>

        {/* ── Main content ── */}
        <div className="main-content">
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
                  <div key={device.id} className="device-card-wrapper">
                    <button
                      className={`device-card ${isSelected ? "device-card--active" : ""} ${hasAlert ? "device-card--alert" : ""}`}
                      onClick={() => setSelectedDeviceId(device.id)}
                      title={device.name}
                    >
                      <div className="device-card-top">
                        <span className="device-icon">
                          {hasAlert ? "⚠" : "📡"}
                        </span>
                        {hasAlert && <span className="alert-dot" />}
                      </div>
                      <div className="device-card-name">
                        {device.patientName || device.name}
                      </div>
                      <div className="device-card-sub">{device.name}</div>
                      <div className={`device-online-pill ${device.online === false ? "offline" : ""}`}>
                        {device.online === false ? "OFFLINE" : "LIVE"}
                      </div>
                    </button>
                    <button
                      className="device-detail-btn"
                      onClick={(e) => { e.stopPropagation(); setModalDevice(device); }}
                      title="View history"
                    >
                      ⤢
                    </button>
                    <button
                      className="device-detail-btn"
                      onClick={(e) => { e.stopPropagation(); handleDeleteNode(device.id, device.name); }}
                      title="Delete node"
                      style={{ top: 26, color: "#e53e3e", background: "rgba(229,62,62,0.12)" }}
                    >
                      ✕
                    </button>
                  </div>
                );
              })
            )}
          </div>
          <button
            className="add-node-btn"
            onClick={() => setAddNodeModal(true)}
            title="Add new node"
          >
            + Node
          </button>
        </div>

        {/* ── Patient bar ── */}
        {patient && (
          <div
            className="patient-bar patient-bar--clickable"
            onClick={() => setPatientModal(true)}
            title="Click to view full patient info"
          >
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
            <div className="patient-expand-hint">▸ VIEW</div>
          </div>
        )}

        {/* ── Selected device header ── */}
        {selectedDevice && (
          <div className="active-device-banner">
            <span className="active-device-icon">📡</span>
            <span className="active-device-name">
              {selectedDevice.patientName || selectedDevice.name}
            </span>
            <span className="active-device-label">— {selectedDevice.name}</span>
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
            VITALS.map((v, i) => {
              const trend = trends[v.key];
              const trendIcon  = trend === "up" ? "↑" : trend === "down" ? "↓" : null;
              const trendColor = trend === "up" ? "#ef4444" : trend === "down" ? "#3b82f6" : null;
              const t = settings.thresholds[v.key];
              return (
                <div
                  key={`${selectedDeviceId}-${v.key}`}
                  onClick={() => setVitalModal({ vitalKey: v.key })}
                  style={{ cursor: "pointer", position: "relative" }}
                  title="Click to view history"
                >
                  {trendIcon && (
                    <div style={{
                      position: "absolute", top: 10, right: 12,
                      fontSize: 18, fontWeight: 700,
                      color: trendColor, zIndex: 2,
                      lineHeight: 1, pointerEvents: "none",
                    }}>{trendIcon}</div>
                  )}
                  <VitalCard
                    label={v.label}
                    icon={v.icon}
                    unit={v.unit}
                    color={v.color}
                    min={t?.normalMin ?? v.min}
                    max={t?.normalMax ?? v.max}
                    warnMin={t?.warnMin ?? v.warnMin}
                    warnMax={t?.warnMax ?? v.warnMax}
                    dangerMin={t?.dangerMin ?? v.dangerMin}
                    dangerMax={t?.dangerMax ?? v.dangerMax}
                    value={getValue(v.key)}
                    loading={!connected && !getValue(v.key)}
                    animDelay={i * 60}
                  />
                </div>
              );
            })}

          {/* ECG Signal — live HTTPS waveform, each sample timestamped */}
          {selectedDeviceId && (
            <div className="chart-section chart-section--clickable" onClick={() => setSignalModal({ key: "ecg" })}>
              <div className="chart-header">
                <span className="chart-title">ECG SIGNAL</span>
                <span className="chart-subtitle">(Live · {settings.ecgSampleFreq}Hz · pkt {settings.ecgPacketInterval}ms)</span>
                <span className="chart-badge" style={{ color: noSignal ? "var(--amber)" : "var(--green)" }}>
                  {noSignal ? "NO SIGNAL" : "LIVE"}
                </span>
                <span className="chart-expand-hint">⤢ EXPAND</span>
              </div>
              <TrendChart
                series={ecgData}
                metricKey="ecg"
                loading={false}
                isLiveWaveform={true}
                stroke="var(--green)"
                sampleFreqHz={settings.ecgSampleFreq}
              />
            </div>
          )}

        </main>
        </div>{/* end main-content */}
      </div>

      {/* ── Node detail modal ── */}
      {modalDevice && (
        <NodeDetailModal
          device={modalDevice}
          vitals={modalDevice.id === selectedDeviceId ? vitals : {}}
          onClose={() => setModalDevice(null)}
        />
      )}

      {/* ── Vital history modal ── */}
      {vitalModal && selectedDeviceId && (
        <VitalHistoryModal
          vitalKey={vitalModal.vitalKey}
          deviceId={selectedDeviceId}
          currentValue={getValue(vitalModal.vitalKey)}
          onClose={() => setVitalModal(null)}
        />
      )}

      {/* ── Overview modal ── */}
      {overviewModal && (
        <OverviewModal
          devices={devices}
          vitalsMap={vitalsMap}
          selectedDeviceId={selectedDeviceId}
          onSelectDevice={setSelectedDeviceId}
          onClose={() => setOverviewModal(false)}
        />
      )}

      {/* ── Signal modal (ECG / PPG expanded with interval control) ── */}
      {signalModal && (
        <SignalModal
          signalKey={signalModal.key}
          series={ecgData}
          onClose={() => setSignalModal(null)}
        />
      )}

      {/* ── Add Node modal ── */}
      {addNodeModal && (
        <AddNodeModal
          token={tbAuthToken}
          gatewayId={GATEWAY_ID}
          onClose={() => setAddNodeModal(false)}
          onCreated={fetchDevices}
        />
      )}

      {/* ── Patient info modal ── */}
      {patientModal && patient && (
        <PatientModal
          patient={patient}
          deviceId={selectedDeviceId}
          onClose={() => setPatientModal(false)}
          onSaved={(updated) => {
            setPatient(prev => ({ ...prev, ...updated }));
            setDevices(prev => prev.map(d =>
              d.id === selectedDeviceId
                ? { ...d, patientName: updated.patientName || null, displayName: updated.patientName || d.name }
                : d
            ));
          }}
        />
      )}

      {/* ── OTA firmware update modal ── */}
      {otaModal && (
        <OtaModal
          devices={devices}
          onClose={() => setOtaModal(false)}
        />
      )}

      {/* ── Print / Export modal ── */}
      {printModal && (
        <PrintModal
          devices={devices}
          onClose={() => setPrintModal(false)}
        />
      )}

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

        .add-node-btn {
          flex-shrink: 0;
          align-self: center;
          padding: 6px 14px;
          border-radius: 8px;
          border: 1.5px dashed var(--border, #cbd5e1);
          background: none;
          color: var(--text-muted, #64748b);
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          white-space: nowrap;
          transition: border-color 0.15s, color 0.15s, background 0.15s;
        }
        .add-node-btn:hover {
          border-color: var(--cyan, #5B9BD5);
          color: var(--cyan, #5B9BD5);
          background: rgba(91,155,213,0.06);
        }

        .patient-bar--clickable {
          cursor: pointer;
          transition: background 0.15s, box-shadow 0.15s;
        }
        .patient-bar--clickable:hover {
          background: var(--surface-hover, rgba(0,200,255,0.03));
          box-shadow: inset 0 0 0 1px rgba(0,200,255,0.2);
        }
        .patient-expand-hint {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.1em;
          color: #00c8ff;
          opacity: 0;
          transition: opacity 0.15s;
          white-space: nowrap;
          margin-left: 8px;
        }
        .patient-bar--clickable:hover .patient-expand-hint {
          opacity: 1;
        }

        .chart-section--clickable {
          cursor: pointer;
          transition: box-shadow 0.15s, border-color 0.15s;
        }
        .chart-section--clickable:hover {
          box-shadow: 0 0 0 1.5px rgba(0,200,255,0.25);
        }
        .chart-expand-hint {
          margin-left: auto;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.08em;
          color: #00c8ff;
          opacity: 0;
          transition: opacity 0.15s;
        }
        .chart-section--clickable:hover .chart-expand-hint {
          opacity: 1;
        }

        .settings-btn {
          font-size: 16px;
          line-height: 1;
          padding: 6px 8px;
          border-radius: 8px;
          text-decoration: none;
          color: var(--text-muted, #94a3b8);
          transition: background 0.15s;
        }
        .settings-btn:hover { background: var(--surface-2, #f1f5f9); }

        .device-card-wrapper {
          position: relative;
          display: inline-flex;
          flex-direction: column;
          align-items: center;
        }

        .device-detail-btn {
          position: absolute;
          top: 4px;
          right: 4px;
          width: 18px;
          height: 18px;
          font-size: 12px;
          line-height: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(0,200,255,0.12);
          border: none;
          border-radius: 4px;
          color: #00c8ff;
          cursor: pointer;
          opacity: 0;
          transition: opacity 0.15s;
          font-family: inherit;
        }

        .device-card-wrapper:hover .device-detail-btn {
          opacity: 1;
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