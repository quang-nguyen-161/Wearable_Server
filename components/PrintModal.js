// components/PrintModal.js
import { useState, useEffect, useCallback } from "react";
import { exportCsv } from "../lib/exportCsv";

const VITAL_META = {
  ppgHeartRate: { label: "PPG Heart Rate", unit: "bpm", color: "#5B9BD5" },
  ecgHeartRate: { label: "ECG Heart Rate", unit: "bpm", color: "#00c8ff" },
  spo2:         { label: "SpO₂",           unit: "%",   color: "#70AD47" },
  temperature:  { label: "Temperature",    unit: "°C",  color: "#FFC000" },
};

function getStatus(key, value) {
  const THRESHOLDS = {
    ppgHeartRate: { normalMin:60,   normalMax:100,  warnMin:50,  warnMax:120, dangerMin:40,   dangerMax:130  },
    ecgHeartRate: { normalMin:60,   normalMax:100,  warnMin:50,  warnMax:120, dangerMin:40,   dangerMax:130  },
    spo2:         { normalMin:95,   normalMax:100,  warnMin:90,  warnMax:100, dangerMin:88,   dangerMax:100  },
    temperature:  { normalMin:36.1, normalMax:37.2, warnMin:35.5,warnMax:38.5,dangerMin:35.0, dangerMax:39.5 },
  };
  const t = THRESHOLDS[key];
  if (!t || value == null) return "—";
  if (value < t.dangerMin || value > t.dangerMax) return "DANGEROUS";
  if (value < t.warnMin   || value > t.warnMax)   return "DANGEROUS";
  if (value < t.normalMin || value > t.normalMax)  return "WARNING";
  return "NORMAL";
}

function toInputVal(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDateRange(start, end) {
  const fmt = ts => new Date(ts).toLocaleString("en-US", {
    month:"short", day:"numeric", year:"numeric",
    hour:"2-digit", minute:"2-digit",
  });
  return `${fmt(start)} — ${fmt(end)}`;
}

export default function PrintModal({ devices, onClose }) {
  // ── State ──────────────────────────────────────────────────────────────
  const [selectedDeviceId, setSelectedDeviceId] = useState(devices[0]?.id || null);
  const [patient,   setPatient]   = useState(null);
  const [startTs,   setStartTs]   = useState(Date.now() - 3600_000);
  const [endTs,     setEndTs]     = useState(Date.now());
  const [include,   setInclude]   = useState({ ppgHeartRate:true, ecgHeartRate:true, spo2:true, temperature:true, ecg:true, ppg:false });
  const [data,      setData]      = useState({});   // { ppgHeartRate: [{ts,value}], ... }
  const [loading,   setLoading]   = useState(false);
  const [csvLoading,setCsvLoading]= useState(false);
  const [fetched,   setFetched]   = useState(false);

  const PRESETS = [
    { label:"1 hr",    ms: 3600_000      },
    { label:"6 hr",    ms: 6*3600_000    },
    { label:"24 hr",   ms: 24*3600_000   },
    { label:"3 days",  ms: 72*3600_000   },
    { label:"7 days",  ms: 168*3600_000  },
  ];

  // ── Load patient when device changes ───────────────────────────────────
  useEffect(() => {
    if (!selectedDeviceId) return;
    setPatient(null);
    setFetched(false);
    fetch(`/api/patient?deviceId=${selectedDeviceId}`)
      .then(r => r.json())
      .then(j => setPatient(j.info || null))
      .catch(() => {});
  }, [selectedDeviceId]);

  // ── Fetch history data ─────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    if (!selectedDeviceId) return;
    setLoading(true);
    const hours = (endTs - startTs) / 3600_000;
    const keys  = Object.entries(include).filter(([,v]) => v).map(([k]) => k);

    try {
      const results = await Promise.all(
        keys.map(key =>
          fetch(`/api/telemetry/history?deviceId=${selectedDeviceId}&key=${key}&hours=${hours.toFixed(4)}&limit=5000`)
            .then(r => r.json())
            .then(j => [key, (j.series || []).filter(p => p.ts >= startTs && p.ts <= endTs)])
        )
      );
      setData(Object.fromEntries(results));
      setFetched(true);
    } catch (e) {
      console.error("Print fetch error:", e);
    } finally {
      setLoading(false);
    }
  }, [selectedDeviceId, startTs, endTs, include]);

  // ── Escape key ─────────────────────────────────────────────────────────
  useEffect(() => {
    const fn = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  // ── Stats helper ───────────────────────────────────────────────────────
  function stats(series) {
    if (!series?.length) return { avg:"—", min:"—", max:"—", count:0 };
    const vals = series.map(p => p.value);
    return {
      avg:   (vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(1),
      min:   Math.min(...vals).toFixed(1),
      max:   Math.max(...vals).toFixed(1),
      count: vals.length,
    };
  }

  // ── Print ──────────────────────────────────────────────────────────────
  const handlePrint = () => window.print();

  // ── CSV Export ─────────────────────────────────────────────────────────
  const handleCsvExport = async () => {
    setCsvLoading(true);
    const keys = Object.entries(include).filter(([,v]) => v).map(([k]) => k);
    await exportCsv({
      deviceId:    selectedDeviceId,
      deviceName:  selectedDevice?.name,
      patientName: patient?.patientName,
      keys, startTs, endTs,
    });
    setCsvLoading(false);
  };

  const selectedDevice = devices.find(d => d.id === selectedDeviceId);

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── Print CSS injected globally ── */}
      <style>{`
        @media print {
          body > * { display: none !important; }
          #print-report { display: block !important; }
          #print-report { position: fixed; inset: 0; background: white; z-index: 99999; padding: 0; }
          .print-page { padding: 24mm 20mm; font-family: Arial, sans-serif; }
          .no-print { display: none !important; }
        }
        #print-report { display: none; }
      `}</style>

      {/* ── Modal backdrop ── */}
      <div
        onClick={e => { if (e.target === e.currentTarget) onClose(); }}
        style={{
          position:"fixed", inset:0, background:"rgba(0,0,0,0.55)",
          display:"flex", alignItems:"center", justifyContent:"center",
          zIndex:1000, padding:16, backdropFilter:"blur(2px)",
        }}
      >
        <div style={{
          background:"var(--bg-card,#fff)", borderRadius:16,
          border:"0.5px solid var(--border,#e2e8f0)",
          width:"100%", maxWidth:620, maxHeight:"92vh", overflowY:"auto",
          animation:"pr-in .18s ease",
        }}>
          <style>{`@keyframes pr-in{from{opacity:0;transform:scale(.96) translateY(8px)}to{opacity:1;transform:scale(1) translateY(0)}}`}</style>

          {/* Header */}
          <div style={{
            display:"flex", alignItems:"center", justifyContent:"space-between",
            padding:"14px 20px", borderBottom:"0.5px solid var(--border,#e2e8f0)",
            position:"sticky", top:0, background:"var(--bg-card,#fff)", zIndex:2,
          }}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <div style={{ width:36, height:36, borderRadius:8, background:"rgba(0,200,255,0.1)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>🖨️</div>
              <div>
                <div style={{ fontSize:15, fontWeight:700, color:"var(--text-primary,#1e293b)" }}>Print Report</div>
                <div style={{ fontSize:11, color:"var(--text-muted,#94a3b8)" }}>Select patient, date range and data to include</div>
              </div>
            </div>
            <button onClick={onClose} style={{ fontSize:22, background:"none", border:"none", cursor:"pointer", color:"var(--text-muted,#94a3b8)", padding:"4px 8px", borderRadius:6, fontFamily:"inherit" }}>×</button>
          </div>

          <div style={{ padding:"16px 20px", display:"flex", flexDirection:"column", gap:16 }}>

            {/* ── Patient / Device selector ── */}
            <div>
              <div style={labelStyle}>PATIENT / NODE</div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginTop:8 }}>
                {devices.map(d => (
                  <button key={d.id} onClick={() => setSelectedDeviceId(d.id)} style={{
                    padding:"7px 14px", borderRadius:20,
                    border:`1.5px solid ${selectedDeviceId===d.id ? "#00c8ff" : "var(--border,#e2e8f0)"}`,
                    background: selectedDeviceId===d.id ? "rgba(0,200,255,0.08)" : "var(--bg-void,#f8fafc)",
                    color: selectedDeviceId===d.id ? "#00c8ff" : "var(--text-primary,#1e293b)",
                    fontWeight:600, fontSize:12, cursor:"pointer", fontFamily:"inherit",
                    display:"flex", flexDirection:"column", alignItems:"center", gap:1,
                  }}>
                    <span>📡 {d.patientName || d.name}</span>
                    {d.patientName && <span style={{ fontSize:9, opacity:0.6, fontWeight:400 }}>{d.name}</span>}
                  </button>
                ))}
              </div>
              {patient && (
                <div style={{ marginTop:10, padding:"10px 14px", background:"var(--bg-void,#f8fafc)", borderRadius:8, border:"0.5px solid var(--border,#e2e8f0)", fontSize:12 }}>
                  <div style={{ fontWeight:700, color:"var(--text-primary,#1e293b)", marginBottom:4 }}>{patient.patientName || "Patient"}</div>
                  <div style={{ color:"var(--text-muted,#64748b)", display:"flex", flexWrap:"wrap", gap:"4px 16px" }}>
                    {patient.patientId && <span>ID: {patient.patientId}</span>}
                    {patient.ward      && <span>Ward: {patient.ward}</span>}
                    {patient.physician && <span>Dr. {patient.physician}</span>}
                    {patient.age       && <span>Age: {patient.age}</span>}
                    {patient.bloodType && <span>Blood: {patient.bloodType}</span>}
                  </div>
                </div>
              )}
            </div>

            {/* ── Date range ── */}
            <div>
              <div style={labelStyle}>DATE RANGE</div>
              <div style={{ display:"flex", gap:4, marginTop:8, flexWrap:"wrap",
                background:"var(--bg-void,#f1f5f9)", borderRadius:8, padding:3, width:"fit-content" }}>
                {PRESETS.map(p => (
                  <button key={p.label} onClick={() => { const n=Date.now(); setStartTs(n-p.ms); setEndTs(n); setFetched(false); }} style={{
                    fontSize:11, fontWeight:600, padding:"4px 10px", borderRadius:6,
                    border:"none", cursor:"pointer", fontFamily:"inherit",
                    background: Math.abs((endTs-startTs)-p.ms)<5000 ? "var(--bg-card,#fff)" : "transparent",
                    color: Math.abs((endTs-startTs)-p.ms)<5000 ? "var(--text-primary,#1e293b)" : "var(--text-muted,#94a3b8)",
                    boxShadow: Math.abs((endTs-startTs)-p.ms)<5000 ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                  }}>{p.label}</button>
                ))}
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:10, fontSize:12, color:"var(--text-muted,#94a3b8)", flexWrap:"wrap" }}>
                <span>From</span>
                <input type="datetime-local" value={toInputVal(startTs)}
                  onChange={e => { setStartTs(new Date(e.target.value).getTime()); setFetched(false); }}
                  style={inputStyle} />
                <span>To</span>
                <input type="datetime-local" value={toInputVal(endTs)}
                  onChange={e => { setEndTs(new Date(e.target.value).getTime()); setFetched(false); }}
                  style={inputStyle} />
              </div>
            </div>

            {/* ── Include toggles ── */}
            <div>
              <div style={labelStyle}>INCLUDE IN REPORT</div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginTop:8 }}>
                {[
                  { key:"ppgHeartRate", label:"PPG Heart Rate", icon:"❤️" },
                  { key:"ecgHeartRate", label:"ECG Heart Rate", icon:"💓" },
                  { key:"spo2",         label:"SpO₂",           icon:"💧" },
                  { key:"temperature",  label:"Temperature",    icon:"🌡" },
                  { key:"ecg",          label:"ECG Signal",     icon:"〜" },
                  { key:"ppg",          label:"PPG Signal",     icon:"〜" },
                ].map(({ key, label, icon }) => (
                  <button key={key} onClick={() => { setInclude(prev => ({...prev, [key]:!prev[key]})); setFetched(false); }} style={{
                    display:"flex", alignItems:"center", gap:6,
                    padding:"6px 12px", borderRadius:20,
                    border:`1.5px solid ${include[key] ? "#00c8ff" : "var(--border,#e2e8f0)"}`,
                    background: include[key] ? "rgba(0,200,255,0.08)" : "transparent",
                    color: include[key] ? "#00c8ff" : "var(--text-muted,#94a3b8)",
                    fontWeight:600, fontSize:11, cursor:"pointer", fontFamily:"inherit",
                  }}>
                    <span>{icon}</span> {label}
                    {include[key] && <span style={{ fontSize:10 }}>✓</span>}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Actions ── */}
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end", paddingTop:4 }}>
              <button onClick={fetchData} disabled={loading} style={{
                padding:"9px 20px", borderRadius:8, border:"0.5px solid var(--border,#e2e8f0)",
                background:"var(--bg-void,#f8fafc)", color:"var(--text-primary,#1e293b)",
                fontWeight:700, fontSize:11, letterSpacing:"0.06em", cursor:"pointer", fontFamily:"inherit",
                opacity: loading ? 0.6 : 1,
              }}>{loading ? "LOADING..." : "FETCH DATA"}</button>
              <button onClick={handleCsvExport} disabled={csvLoading || !selectedDeviceId} style={{
                padding:"9px 20px", borderRadius:8,
                border:"1.5px solid #22c55e",
                background: "rgba(34,197,94,0.08)", color:"#22c55e",
                fontWeight:700, fontSize:11, letterSpacing:"0.06em",
                cursor: selectedDeviceId ? "pointer" : "not-allowed",
                opacity: csvLoading ? 0.6 : 1, fontFamily:"inherit",
              }}>{csvLoading ? "⏳ EXPORTING..." : "⬇ CSV"}</button>
              <button onClick={handlePrint} disabled={!fetched} style={{
                padding:"9px 22px", borderRadius:8, border:"none",
                background: fetched ? "#00c8ff" : "#94a3b8",
                color:"#fff", fontWeight:700, fontSize:11, letterSpacing:"0.06em",
                cursor: fetched ? "pointer" : "not-allowed", fontFamily:"inherit",
              }}>🖨️ PRINT</button>
            </div>

            {/* ── Preview ── */}
            {fetched && (
              <div style={{ borderTop:"0.5px solid var(--border,#e2e8f0)", paddingTop:14 }}>
                <div style={labelStyle}>DATA PREVIEW</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:10 }}>
                  {Object.entries(data).map(([key, series]) => {
                    const s = stats(series);
                    const meta = VITAL_META[key] || { label: key, unit:"", color:"#94a3b8" };
                    return (
                      <div key={key} style={{ background:"var(--bg-void,#f8fafc)", borderRadius:8, padding:"10px 12px", border:"0.5px solid var(--border,#e2e8f0)" }}>
                        <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.08em", color:"var(--text-muted,#94a3b8)", marginBottom:6 }}>{meta.label.toUpperCase()}</div>
                        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:4, fontSize:12 }}>
                          <div><span style={{ color:"var(--text-muted,#94a3b8)" }}>Avg </span><span style={{ fontWeight:700, color:meta.color }}>{s.avg} {meta.unit}</span></div>
                          <div><span style={{ color:"var(--text-muted,#94a3b8)" }}>Min </span><span style={{ fontWeight:700 }}>{s.min}</span></div>
                          <div><span style={{ color:"var(--text-muted,#94a3b8)" }}>Max </span><span style={{ fontWeight:700 }}>{s.max}</span></div>
                          <div><span style={{ color:"var(--text-muted,#94a3b8)" }}>Pts </span><span style={{ fontWeight:700 }}>{s.count.toLocaleString()}</span></div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Printable report (hidden until print) ── */}
      <div id="print-report">
        <div className="print-page">
          {/* Report header */}
          <div style={{ borderBottom:"2px solid #00c8ff", paddingBottom:12, marginBottom:20, display:"flex", justifyContent:"space-between", alignItems:"flex-end" }}>
            <div>
              <div style={{ fontSize:22, fontWeight:700, color:"#00c8ff", letterSpacing:"0.06em" }}>VITALSYNC</div>
              <div style={{ fontSize:11, color:"#64748b", marginTop:2 }}>Health Monitoring System — Patient Report</div>
            </div>
            <div style={{ fontSize:11, color:"#64748b", textAlign:"right" }}>
              <div>Printed: {new Date().toLocaleString()}</div>
              <div>Device: {selectedDevice?.patientName ? `${selectedDevice.patientName} (${selectedDevice.name})` : (selectedDevice?.name || "—")}</div>
            </div>
          </div>

          {/* Patient info */}
          {patient && (
            <div style={{ background:"#f8fafc", borderRadius:8, padding:"12px 16px", marginBottom:20, border:"1px solid #e2e8f0" }}>
              <div style={{ fontSize:12, fontWeight:700, letterSpacing:"0.08em", color:"#64748b", marginBottom:10 }}>PATIENT INFORMATION</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10 }}>
                {[
                  ["Name",       patient.patientName],
                  ["Patient ID", patient.patientId],
                  ["Ward",       patient.ward],
                  ["Physician",  patient.physician],
                  ["Age",        patient.age ? `${patient.age} yr` : null],
                  ["Gender",     patient.gender],
                  ["Blood Type", patient.bloodType],
                  ["Weight",     patient.weight ? `${patient.weight} kg` : null],
                ].map(([lbl, val]) => val ? (
                  <div key={lbl}>
                    <div style={{ fontSize:9, fontWeight:700, letterSpacing:"0.1em", color:"#94a3b8" }}>{lbl.toUpperCase()}</div>
                    <div style={{ fontSize:13, fontWeight:600, color:"#1e293b", marginTop:2 }}>{val}</div>
                  </div>
                ) : null)}
              </div>
            </div>
          )}

          {/* Date range */}
          <div style={{ fontSize:11, color:"#64748b", marginBottom:20 }}>
            <strong>Report Period:</strong> {fmtDateRange(startTs, endTs)}
          </div>

          {/* Vital stats table */}
          {Object.keys(data).some(k => ["ppgHeartRate","ecgHeartRate","spo2","temperature"].includes(k)) && (
            <div style={{ marginBottom:24 }}>
              <div style={{ fontSize:12, fontWeight:700, letterSpacing:"0.08em", color:"#64748b", marginBottom:10 }}>VITAL SIGNS SUMMARY</div>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                <thead>
                  <tr style={{ background:"#f1f5f9" }}>
                    {["Vital","Unit","Avg","Min","Max","Data Points","Status (Avg)"].map(h => (
                      <th key={h} style={{ padding:"8px 10px", textAlign:"left", fontSize:10, fontWeight:700, letterSpacing:"0.06em", color:"#64748b", border:"1px solid #e2e8f0" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {["ppgHeartRate","ecgHeartRate","spo2","temperature"].map(key => {
                    const series = data[key];
                    if (!series) return null;
                    const s    = stats(series);
                    const meta = VITAL_META[key];
                    const st   = getStatus(key, parseFloat(s.avg));
                    const stColor = st==="CRITICAL"?"#ef4444":st==="WARNING"?"#f59e0b":"#22c55e";
                    return (
                      <tr key={key}>
                        <td style={{ padding:"8px 10px", fontWeight:600, border:"1px solid #e2e8f0" }}>{meta.label}</td>
                        <td style={{ padding:"8px 10px", color:"#64748b", border:"1px solid #e2e8f0" }}>{meta.unit}</td>
                        <td style={{ padding:"8px 10px", fontWeight:700, color:meta.color, border:"1px solid #e2e8f0" }}>{s.avg}</td>
                        <td style={{ padding:"8px 10px", border:"1px solid #e2e8f0" }}>{s.min}</td>
                        <td style={{ padding:"8px 10px", border:"1px solid #e2e8f0" }}>{s.max}</td>
                        <td style={{ padding:"8px 10px", border:"1px solid #e2e8f0" }}>{s.count.toLocaleString()}</td>
                        <td style={{ padding:"8px 10px", fontWeight:700, color:stColor, border:"1px solid #e2e8f0" }}>● {st}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ECG / PPG summary */}
          {(data.ecg || data.ppg) && (
            <div style={{ marginBottom:24 }}>
              <div style={{ fontSize:12, fontWeight:700, letterSpacing:"0.08em", color:"#64748b", marginBottom:10 }}>SIGNAL DATA SUMMARY</div>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                <thead>
                  <tr style={{ background:"#f1f5f9" }}>
                    {["Signal","Unit","Avg","Min","Max","Data Points"].map(h => (
                      <th key={h} style={{ padding:"8px 10px", textAlign:"left", fontSize:10, fontWeight:700, letterSpacing:"0.06em", color:"#64748b", border:"1px solid #e2e8f0" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { key:"ecg", label:"ECG Signal", unit:"µV",    color:"#FF96B7" },
                    { key:"ppg", label:"PPG Signal", unit:"a.u.",  color:"#70AD47" },
                  ].map(({ key, label, unit, color }) => {
                    const series = data[key];
                    if (!series) return null;
                    const s = stats(series);
                    return (
                      <tr key={key}>
                        <td style={{ padding:"8px 10px", fontWeight:600, border:"1px solid #e2e8f0" }}>{label}</td>
                        <td style={{ padding:"8px 10px", color:"#64748b", border:"1px solid #e2e8f0" }}>{unit}</td>
                        <td style={{ padding:"8px 10px", fontWeight:700, color, border:"1px solid #e2e8f0" }}>{s.avg}</td>
                        <td style={{ padding:"8px 10px", border:"1px solid #e2e8f0" }}>{s.min}</td>
                        <td style={{ padding:"8px 10px", border:"1px solid #e2e8f0" }}>{s.max}</td>
                        <td style={{ padding:"8px 10px", border:"1px solid #e2e8f0" }}>{s.count.toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Footer */}
          <div style={{ borderTop:"1px solid #e2e8f0", paddingTop:10, marginTop:20, fontSize:10, color:"#94a3b8", display:"flex", justifyContent:"space-between" }}>
            <span>VitalSync Health Monitoring System</span>
            <span>This report is generated automatically and should be reviewed by a qualified physician.</span>
          </div>
        </div>
      </div>
    </>
  );
}

const labelStyle = {
  fontSize:10, fontWeight:700, letterSpacing:"0.1em", color:"var(--text-muted,#94a3b8)",
};

const inputStyle = {
  fontSize:12, padding:"5px 8px", borderRadius:6,
  border:"0.5px solid var(--border,#e2e8f0)",
  background:"var(--bg-card,#fff)", color:"var(--text-primary,#1e293b)",
  fontFamily:"inherit",
};