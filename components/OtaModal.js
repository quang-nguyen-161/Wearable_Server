// components/OtaModal.js
// OTA via ESP32 → UART → nRF52832 Central → BLE DFU → nRF52832 Peripheral node

import { useState, useEffect, useRef } from "react";
import { useTbAuth } from "../context/TbAuthContext";

const STATUS_META = {
  idle:     { color:"#94a3b8", icon:"○", label:"Ready"    },
  started:  { color:"#00c8ff", icon:"◌", label:"Starting" },
  flashing: { color:"#f59e0b", icon:"◉", label:"Flashing" },
  complete: { color:"#22c55e", icon:"✓", label:"Complete" },
  failed:   { color:"#ef4444", icon:"✕", label:"Failed"   },
};

export default function OtaModal({ devices, onClose }) {
  const { token } = useTbAuth();
  const [selectedDevice, setSelectedDevice] = useState(devices[0] || null);
  const [binFile,        setBinFile]        = useState(null);
  const [binUrl,         setBinUrl]         = useState("");
  const [uploading,      setUploading]      = useState(false);
  const [triggering,     setTriggering]     = useState(false);
  const [nodeStatus,     setNodeStatus]     = useState(null);
  const [log,            setLog]            = useState([]);
  const pollRef = useRef(null);
  const logRef  = useRef(null);

  const addLog = (msg, type="info") =>
    setLog(p => [...p.slice(-99), { ts: new Date().toLocaleTimeString(), msg, type }]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);
  useEffect(() => {
    const fn = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn); return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  const pollStatus = async () => {
    if (!selectedDevice) return;
    const authHeaders = token ? { "x-tb-token": token } : {};
    try {
      const res  = await fetch(`/api/telemetry/latest?deviceId=${selectedDevice.id}`, { headers: authHeaders });
      const json = await res.json();
      const d    = json.data || {};
      if (!d.otaStatus) return;
      const s = { status: d.otaStatus.value, message: d.otaMessage?.value||"", progress: d.otaProgress?.value||0 };
      setNodeStatus(s);
      if (s.status==="complete"||s.status==="failed") {
        clearInterval(pollRef.current);
        addLog(`${s.status.toUpperCase()}: ${s.message}`, s.status==="failed"?"error":"success");
      }
    } catch(_) {}
  };

  const handleUpload = async () => {
    if (!binFile) return;
    setUploading(true);
    addLog(`Uploading ${binFile.name} (${(binFile.size/1024).toFixed(1)} KB)...`);
    try {
      const form = new FormData();
      form.append("firmware", binFile);
      const res  = await fetch("/api/ota/upload", { method:"POST", body:form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setBinUrl(json.url);
      addLog(`✅ Uploaded → ${json.url}`, "success");
    } catch(e) {
      addLog(`❌ ${e.message}`, "error");
    } finally {
      setUploading(false);
    }
  };

  const handleTrigger = async () => {
    if (!binUrl || !selectedDevice) return;
    setTriggering(true);
    const nodeIdx = devices.findIndex(d => d.id === selectedDevice.id);
    addLog(`Sending RPC to ESP32 gateway → Central → ${selectedDevice.patientName ? `${selectedDevice.patientName} (${selectedDevice.name})` : selectedDevice.name} via BLE DFU`);
    try {
      const res  = await fetch("/api/ota/trigger", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ nodeName: selectedDevice.name, firmwareBinUrl: binUrl, nodeIdx }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      addLog(`✅ ESP32 received RPC — flashing in progress`);
      setNodeStatus({ status:"started", message:"Waiting for ESP32...", progress:0 });
      pollRef.current = setInterval(pollStatus, 2000);
    } catch(e) {
      addLog(`❌ ${e.message}`, "error");
    } finally {
      setTriggering(false);
    }
  };

  const sm   = STATUS_META[nodeStatus?.status || "idle"];
  const busy = nodeStatus?.status==="flashing"||nodeStatus?.status==="started";

  return (
    <div onClick={e => { if(e.target===e.currentTarget) onClose(); }}
      style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",
        display:"flex",alignItems:"center",justifyContent:"center",
        zIndex:1000,padding:16,backdropFilter:"blur(3px)" }}>
      <div style={{ background:"var(--bg-card,#fff)",borderRadius:16,
        border:"0.5px solid var(--border,#e2e8f0)",width:"100%",maxWidth:560,
        maxHeight:"92vh",overflowY:"auto",animation:"ota-in .18s ease" }}>
        <style>{`@keyframes ota-in{from{opacity:0;transform:scale(.96) translateY(6px)}to{opacity:1;transform:scale(1) translateY(0)}}`}</style>

        {/* Header */}
        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",
          padding:"14px 20px",borderBottom:"0.5px solid var(--border,#e2e8f0)",
          position:"sticky",top:0,background:"var(--bg-card,#fff)",zIndex:2 }}>
          <div style={{ display:"flex",alignItems:"center",gap:10 }}>
            <div style={{ width:36,height:36,borderRadius:8,background:"rgba(0,200,255,0.1)",
              display:"flex",alignItems:"center",justifyContent:"center",fontSize:18 }}>📡</div>
            <div>
              <div style={{ fontSize:15,fontWeight:700,color:"var(--text-primary,#1e293b)" }}>OTA Firmware Update</div>
              <div style={{ fontSize:11,color:"var(--text-muted,#94a3b8)" }}>
                Dashboard → TB RPC → ESP32 → UART → nRF52 Central → BLE DFU → Node
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{ fontSize:22,background:"none",border:"none",
            cursor:"pointer",color:"var(--text-muted,#94a3b8)",padding:"4px 8px",
            borderRadius:6,fontFamily:"inherit" }}>×</button>
        </div>

        <div style={{ padding:"16px 20px",display:"flex",flexDirection:"column",gap:14 }}>

          {/* Flow diagram */}
          <div style={{ display:"flex",alignItems:"center",gap:6,
            padding:"8px 12px",borderRadius:8,background:"rgba(0,200,255,0.05)",
            border:"1px solid rgba(0,200,255,0.15)",fontSize:11,
            color:"var(--text-muted,#64748b)",flexWrap:"wrap" }}>
            <span>🖥️ Dashboard</span><span style={{color:"#00c8ff"}}>→</span>
            <span>☁️ ThingsBoard RPC</span><span style={{color:"#00c8ff"}}>→</span>
            <span>📶 ESP32</span><span style={{color:"#00c8ff"}}>→</span>
            <span>🔌 UART</span><span style={{color:"#00c8ff"}}>→</span>
            <span>📡 nRF52 Central</span><span style={{color:"#00c8ff"}}>→</span>
            <span>📻 BLE DFU</span><span style={{color:"#00c8ff"}}>→</span>
            <span style={{fontWeight:700,color:"#00c8ff"}}>🎯 {selectedDevice?.patientName || selectedDevice?.name || "Node"}</span>
          </div>

          {/* Node selector */}
          <div>
            <div style={L}>TARGET NODE</div>
            <div style={{ display:"flex",gap:8,flexWrap:"wrap",marginTop:8 }}>
              {devices.map((d,i) => (
                <button key={d.id} onClick={() => setSelectedDevice(d)} style={{
                  padding:"6px 14px",borderRadius:20,fontWeight:600,fontSize:12,
                  border:`1.5px solid ${selectedDevice?.id===d.id?"#00c8ff":"var(--border,#e2e8f0)"}`,
                  background:selectedDevice?.id===d.id?"rgba(0,200,255,0.08)":"transparent",
                  color:selectedDevice?.id===d.id?"#00c8ff":"var(--text-primary,#1e293b)",
                  cursor:"pointer",fontFamily:"inherit",
                  display:"flex",flexDirection:"column",alignItems:"center",gap:1,
                }}>
                  <span>{d.online?"🟢":"🔴"} {d.patientName || d.name} <span style={{fontSize:10,opacity:.6}}>idx:{i}</span></span>
                  {d.patientName && <span style={{fontSize:9,opacity:.5,fontWeight:400}}>{d.name}</span>}
                </button>
              ))}
            </div>
          </div>

          {/* File upload */}
          <div style={{ background:"var(--bg-void,#f8fafc)",borderRadius:10,
            padding:"14px 16px",border:"0.5px solid var(--border,#e2e8f0)" }}>
            <div style={L}>FIRMWARE BINARY (.bin)</div>
            <div style={{ fontSize:11,color:"var(--text-muted,#94a3b8)",margin:"4px 0 10px" }}>
              Compiled nRF52832 app binary — from your SES/GCC/PlatformIO build output
            </div>
            <div style={{ display:"flex",gap:8,alignItems:"center" }}>
              <input type="file" accept=".bin" onChange={e => setBinFile(e.target.files[0])}
                style={{ flex:1,fontSize:11,padding:"5px 6px",borderRadius:6,
                  border:"0.5px solid var(--border,#e2e8f0)",background:"var(--bg-card,#fff)",
                  color:"var(--text-primary,#1e293b)",fontFamily:"inherit" }} />
              <button onClick={handleUpload} disabled={!binFile||uploading} style={{
                padding:"7px 16px",borderRadius:8,border:"none",
                background:binFile&&!uploading?"#00c8ff":"#94a3b8",
                color:"#fff",fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:"inherit",
                opacity:uploading?.7:1 }}>
                {uploading?"UPLOADING...":"⬆ UPLOAD"}
              </button>
            </div>
            {binUrl && <div style={{ marginTop:6,fontSize:11,color:"#22c55e" }}>✓ Ready to flash</div>}
          </div>

          {/* Status */}
          {nodeStatus && (
            <div style={{ padding:"12px 16px",borderRadius:10,
              border:`1px solid ${sm.color}30`,background:`${sm.color}08` }}>
              <div style={{ display:"flex",alignItems:"center",gap:10 }}>
                <span style={{ fontSize:18,color:sm.color }}>{sm.icon}</span>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:12,fontWeight:700,color:sm.color,letterSpacing:"0.06em" }}>{sm.label}</div>
                  <div style={{ fontSize:11,color:"var(--text-muted,#64748b)",marginTop:2 }}>{nodeStatus.message}</div>
                </div>
                {nodeStatus.progress>0&&<span style={{ fontWeight:700,color:sm.color,fontSize:16 }}>{nodeStatus.progress}%</span>}
              </div>
              {busy&&(
                <div style={{ marginTop:8,height:4,borderRadius:2,background:"var(--border,#e2e8f0)" }}>
                  <div style={{ height:"100%",borderRadius:2,background:sm.color,
                    width:`${nodeStatus.progress}%`,transition:"width 0.4s" }}/>
                </div>
              )}
            </div>
          )}

          {/* Trigger */}
          <button onClick={handleTrigger} disabled={!binUrl||!selectedDevice||triggering||busy} style={{
            padding:"11px",borderRadius:10,border:"none",
            background:binUrl&&!busy?"#00c8ff":"#94a3b8",
            color:"#fff",fontWeight:700,fontSize:13,letterSpacing:"0.06em",
            cursor:binUrl&&!busy?"pointer":"not-allowed",fontFamily:"inherit",
            opacity:triggering?.7:1 }}>
            {triggering?"SENDING...":`🚀 FLASH ${selectedDevice?.patientName || selectedDevice?.name || "node"} via BLE DFU`}
          </button>

          {/* Log */}
          {log.length>0&&(
            <div>
              <div style={L}>LOG</div>
              <div ref={logRef} style={{ marginTop:6,padding:"10px 12px",borderRadius:8,
                background:"#0f172a",fontFamily:"monospace",fontSize:11,lineHeight:1.7,
                maxHeight:140,overflowY:"auto",border:"0.5px solid #1e293b" }}>
                {log.map((l,i)=>(
                  <div key={i} style={{ color:l.type==="error"?"#ef4444":l.type==="success"?"#22c55e":"#94a3b8" }}>
                    <span style={{ color:"#475569",marginRight:8 }}>{l.ts}</span>{l.msg}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Note */}
          <div style={{ padding:"10px 14px",borderRadius:8,
            background:"rgba(245,158,11,0.05)",border:"1px solid rgba(245,158,11,0.2)",
            fontSize:11,color:"var(--text-muted,#64748b)",lineHeight:1.6 }}>
            <strong style={{ color:"#f59e0b" }}>Requirements:</strong><br/>
            • nRF52832 peripheral must have <strong>Buttonless BLE DFU bootloader</strong> flashed<br/>
            • nRF52832 central firmware must have OTA pass-through code from <code>nrf52_central_ota.c</code><br/>
            • ESP32 must be running <code>esp32_uart_gateway.ino</code> connected to central via UART<br/>
            • Node index in central's <code>NODE_ADDRS[]</code> must match the node order in this list
          </div>
        </div>
      </div>
    </div>
  );
}

const L = { fontSize:10,fontWeight:700,letterSpacing:"0.1em",color:"var(--text-muted,#94a3b8)" };