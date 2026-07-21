// components/PatientModal.js
// Modal for viewing / editing patient info + emergency contacts for a node.
// Saves the full record to ThingsBoard SERVER_SCOPE, and mirrors patientName
// into SHARED_SCOPE so the ESP32 gateway can read it without a JWT.

import { useState, useEffect } from "react";
import { useTbAuth } from "../context/TbAuthContext";
import { saveDeviceAttributes } from "../lib/tbBrowserClient";

export default function PatientModal({ patient, deviceId, onClose, onSaved }) {
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
      // Mirror patientName into SHARED_SCOPE so the ESP32 gateway can read it
      // without a JWT (SERVER_SCOPE requires auth). SERVER_SCOPE stays the
      // source of truth for the full patient record; this is just a
      // read-only copy of the one field firmware needs.
      await saveDeviceAttributes(patientSaveToken, deviceId, "SHARED_SCOPE", {
        patientName: form.patientName,
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