// components/VitalHistoryModal.js
import { useState, useEffect, useCallback, useRef } from "react";
import { getTelemetryHistory } from "../lib/tbBrowserClient";

const VITAL_META = {
  ppgHeartRate: { label: "PPG Heart Rate", unit: "bpm", normalMin: 60,   normalMax: 100,  warnMin: 50,  warnMax: 120, dangerMin: 40,   dangerMax: 130  },
  ecgHeartRate: { label: "ECG Heart Rate", unit: "bpm", normalMin: 60,   normalMax: 100,  warnMin: 50,  warnMax: 120, dangerMin: 40,   dangerMax: 130  },
  spo2:         { label: "SpO₂",           unit: "%",   normalMin: 95,   normalMax: 100,  warnMin: 90,  warnMax: 100, dangerMin: 88,   dangerMax: 100  },
  temperature:  { label: "Temperature",    unit: "°C",  normalMin: 36.1, normalMax: 37.2, warnMin: 35.5,warnMax: 38.5,dangerMin: 35.0, dangerMax: 39.5 },
};

function getColor(meta, v) {
  if (v == null) return "#94a3b8";
  if (v < meta.dangerMin || v > meta.dangerMax) return "#ef4444";
  if (v < meta.warnMin   || v > meta.warnMax)   return "#ef4444";
  if (v < meta.normalMin || v > meta.normalMax)  return "#f59e0b";
  return "#22c55e";
}

function getStatus(meta, v) {
  if (v == null) return null;
  if (v < meta.dangerMin || v > meta.dangerMax) return "DANGEROUS";
  if (v < meta.warnMin   || v > meta.warnMax)   return "DANGEROUS";
  if (v < meta.normalMin || v > meta.normalMax)  return "WARNING";
  return "NORMAL";
}

function fmtFull(ts) {
  return new Date(ts).toLocaleString("en-US", {
    year:"numeric", month:"short", day:"numeric",
    hour:"2-digit", minute:"2-digit", second:"2-digit",
  });
}
function fmtShort(ts) {
  return new Date(ts).toLocaleTimeString("en-US", { hour:"2-digit", minute:"2-digit" });
}
function toInputVal(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2,"0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── Chart ─────────────────────────────────────────────────────────────────
function LineChart({ series, meta, fetchError }) {
  const containerRef = useRef(null);
  const [tooltip, setTooltip] = useState(null); // { x, y, point } — relative to container

  const W = 700, H = 240;
  const PAD = { top: 16, right: 20, bottom: 44, left: 52 };
  const CW = W - PAD.left - PAD.right;
  const CH = H - PAD.top  - PAD.bottom;

  if (!series?.length) {
    const msg = fetchError ? `Error: ${fetchError}` : "NO DATA AVAILABLE";
    const col = fetchError ? "#f87171" : "var(--color-text-secondary,#94a3b8)";
    return <div style={{ height: H, display:"flex", alignItems:"center", justifyContent:"center", color: col, fontSize:13, padding:"0 16px", textAlign:"center" }}>{msg}</div>;
  }

  const vals  = series.map(p => p.value);
  const times = series.map(p => p.ts);
  let minV = Math.min(...vals), maxV = Math.max(...vals);
  const rng = maxV - minV || 1;
  minV -= rng * 0.1; maxV += rng * 0.1;
  const minT = Math.min(...times), maxT = Math.max(...times);

  const px = ts  => ((ts  - minT) / (maxT - minT || 1)) * CW;
  const py = val => CH - ((val - minV) / (maxV - minV)) * CH;

  // Colored segments
  const segments = [];
  for (let i = 0; i < series.length - 1; i++) {
    const color = getColor(meta, series[i].value);
    if (segments.length && segments[segments.length-1].color === color) {
      segments[segments.length-1].points.push(series[i+1]);
    } else {
      segments.push({ color, points: [series[i], series[i+1]] });
    }
  }

  const yTicks = Array.from({ length: 5 }, (_, i) => minV + (maxV - minV) * (i / 4));
  const xCount = Math.min(5, series.length);
  const xIdxs  = xCount < 2 ? [0] : Array.from({ length: xCount }, (_, i) =>
    Math.round((i / (xCount - 1)) * (series.length - 1))
  );

  const bandTop = Math.max(0, Math.min(CH, py(Math.min(meta.normalMax, maxV))));
  const bandBot = Math.max(0, Math.min(CH, py(Math.max(meta.normalMin, minV))));

  const handleMouseMove = (e) => {
    const container = containerRef.current;
    if (!container) return;
    // Coords relative to the container div — used directly for tooltip left/top
    const cRect  = container.getBoundingClientRect();
    const cX     = e.clientX - cRect.left;   // px from left of container
    const cY     = e.clientY - cRect.top;    // px from top of container

    // Map cX → SVG data space (account for SVG scaling + PAD.left)
    const svgW   = cRect.width;              // rendered SVG width == container width
    const chartX = cX * (W / svgW) - PAD.left;
    const frac   = Math.max(0, Math.min(1, chartX / CW));
    const idx    = Math.round(frac * (series.length - 1));

    setTooltip({ x: cX, y: cY, point: series[idx] });
  };

  const handleMouseLeave = () => setTooltip(null);

  // Crosshair x in SVG coords
  const crosshairX = tooltip
    ? ((tooltip.x * (W / (containerRef.current?.getBoundingClientRect().width || W))) - PAD.left)
    : null;

  return (
    <div ref={containerRef} style={{ position:"relative", userSelect:"none" }}
      onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height:H, display:"block" }}>
        <g transform={`translate(${PAD.left},${PAD.top})`}>
          {/* normal band */}
          {bandBot - bandTop > 0 && <rect x={0} y={bandTop} width={CW} height={bandBot - bandTop} fill="rgba(34,197,94,0.07)" rx={2} />}
          {/* grid */}
          {yTicks.map((v,i) => <line key={i} x1={0} y1={py(v)} x2={CW} y2={py(v)} stroke="var(--color-border-tertiary,#e2e8f0)" strokeWidth={0.5} strokeDasharray="3,3"/>)}
          {/* colored line segments */}
          {segments.map((seg, si) => (
            <polyline key={si}
              points={seg.points.map(p => `${px(p.ts).toFixed(1)},${py(p.value).toFixed(1)}`).join(" ")}
              fill="none" stroke={seg.color} strokeWidth={1.8}
              strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {/* y labels */}
          {yTicks.map((v,i) => (
            <text key={i} x={-6} y={py(v)+4} textAnchor="end" fontSize={10} fill="var(--color-text-secondary,#94a3b8)">{v.toFixed(1)}</text>
          ))}
          {/* x labels */}
          {xIdxs.map(i => (
            <text key={i} x={px(series[i].ts)} y={CH+14} textAnchor="end" fontSize={10}
              fill="var(--color-text-secondary,#94a3b8)"
              transform={`rotate(-30,${px(series[i].ts)},${CH+14})`}>
              {fmtShort(series[i].ts)}
            </text>
          ))}
          {/* crosshair */}
          {crosshairX != null && (
            <line x1={crosshairX} y1={0} x2={crosshairX} y2={CH}
              stroke="#94a3b8" strokeWidth={1} strokeDasharray="4,3" opacity={0.5}/>
          )}
          {/* dot on hovered point */}
          {tooltip && (
            <circle
              cx={px(tooltip.point.ts)} cy={py(tooltip.point.value)} r={5}
              fill={getColor(meta, tooltip.point.value)}
              stroke="var(--color-background-primary,#fff)" strokeWidth={2}/>
          )}
        </g>
      </svg>

      {/* Tooltip — positioned exactly at cursor using container-relative coords */}
      {tooltip && (() => {
        const p     = tooltip.point;
        const s     = getStatus(meta, p.value);
        const color = getColor(meta, p.value);
        const cW    = containerRef.current?.getBoundingClientRect().width || 700;
        const flipX = tooltip.x > cW * 0.6;
        const flipY = tooltip.y < 90;
        return (
          <div style={{
            position:      "absolute",
            left:          tooltip.x,
            top:           tooltip.y,
            transform:     `translate(${flipX ? "calc(-100% - 12px)" : "12px"}, ${flipY ? "4px" : "-100%"})`,
            background:    "var(--color-background-primary,#fff)",
            border:        `1.5px solid ${color}`,
            borderRadius:  10,
            padding:       "8px 12px",
            pointerEvents: "none",
            zIndex:        30,
            minWidth:      150,
            boxShadow:     "0 4px 20px rgba(0,0,0,0.15)",
            fontSize:      12,
            whiteSpace:    "nowrap",
          }}>
            <div style={{ fontWeight:700, color, fontSize:20, lineHeight:1 }}>
              {p.value.toFixed(1)}<span style={{ fontSize:12, fontWeight:400, marginLeft:3 }}>{meta.unit}</span>
            </div>
            <div style={{ color:"var(--color-text-secondary,#64748b)", fontSize:11, marginTop:5 }}>
              {fmtFull(p.ts)}
            </div>
            {s && <div style={{ color, fontSize:10, fontWeight:700, marginTop:4, letterSpacing:"0.06em" }}>● {s}</div>}
          </div>
        );
      })()}
    </div>
  );
}

// ── Modal ──────────────────────────────────────────────────────────────────
export default function VitalHistoryModal({ vitalKey, deviceId, tbToken, currentValue, onClose }) {
  const meta = VITAL_META[vitalKey];

  const now = Date.now();
  const [startTs, setStartTs] = useState(now - 3600_000);
  const [endTs,   setEndTs]   = useState(now);
  const [series,  setSeries]  = useState([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(null);

  const fetchHistory = useCallback(async () => {
    if (!deviceId || !vitalKey || !tbToken) return;
    setLoading(true);
    setFetchError(null);
    try {
      const hours = (endTs - startTs) / 3600_000;
      const pts = await getTelemetryHistory(tbToken, deviceId, vitalKey, hours, 5000);
      setSeries(pts.filter(p => p.ts >= startTs && p.ts <= endTs));
    } catch(e) {
      console.error(e);
      setFetchError(e.message);
    }
    finally { setLoading(false); }
  }, [deviceId, vitalKey, tbToken, startTs, endTs]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  useEffect(() => {
    const fn = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  if (!meta) return null;

  const avg    = series.length ? series.reduce((s,p) => s+p.value, 0) / series.length : null;
  const minVal = series.length ? Math.min(...series.map(p => p.value)) : null;
  const maxVal = series.length ? Math.max(...series.map(p => p.value)) : null;
  const liveColor  = getColor(meta, currentValue);
  const liveStatus = getStatus(meta, currentValue);

  const PRESETS = [
    { label:"15 min", ms: 15*60_000 },
    { label:"1 hr",   ms: 3600_000  },
    { label:"6 hr",   ms: 6*3600_000},
    { label:"24 hr",  ms: 24*3600_000},
    { label:"7 days", ms: 168*3600_000},
  ];
  const activePreset = PRESETS.find(p => Math.abs((endTs - startTs) - p.ms) < 5000);

  return (
    <div onClick={e => { if(e.target===e.currentTarget) onClose(); }}
      style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16, backdropFilter:"blur(2px)" }}>
      <div style={{ background:"var(--color-background-primary,#fff)", borderRadius:16, border:"0.5px solid var(--color-border-tertiary,#e2e8f0)", width:"100%", maxWidth:800, maxHeight:"92vh", overflowY:"auto", animation:"vhm .18s ease" }}>
        <style>{`@keyframes vhm{from{opacity:0;transform:scale(.96) translateY(8px)}to{opacity:1;transform:scale(1) translateY(0)}}`}</style>

        {/* Header */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 20px", borderBottom:"0.5px solid var(--color-border-tertiary,#e2e8f0)", flexWrap:"wrap", gap:10 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:36, height:36, borderRadius:8, background:`${liveColor}20`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>
              {vitalKey==="ppgHeartRate"?"❤️":vitalKey==="ecgHeartRate"?"💓":vitalKey==="spo2"?"💧":"🌡"}
            </div>
            <div>
              <div style={{ fontSize:15, fontWeight:700, color:"var(--color-text-primary,#1e293b)" }}>{meta.label} History</div>
              {currentValue != null && (
                <div style={{ fontSize:12, color:"var(--color-text-secondary,#64748b)" }}>
                  Live: <span style={{ color:liveColor, fontWeight:700 }}>{currentValue.toFixed(1)} {meta.unit}</span>
                  {liveStatus && <span style={{ marginLeft:8, color:liveColor, fontWeight:700, fontSize:11 }}>● {liveStatus}</span>}
                </div>
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ fontSize:22, background:"none", border:"none", cursor:"pointer", color:"var(--color-text-secondary,#94a3b8)", padding:"4px 8px", borderRadius:6, fontFamily:"inherit" }}>×</button>
        </div>

        {/* Time range */}
        <div style={{ padding:"12px 20px", borderBottom:"0.5px solid var(--color-border-tertiary,#e2e8f0)", display:"flex", flexWrap:"wrap", alignItems:"center", gap:10 }}>
          <div style={{ display:"flex", gap:3, background:"var(--color-background-secondary,#f1f5f9)", borderRadius:8, padding:3 }}>
            {PRESETS.map(p => (
              <button key={p.label} onClick={() => { const n=Date.now(); setStartTs(n-p.ms); setEndTs(n); }} style={{
                fontSize:11, fontWeight:600, padding:"4px 10px", borderRadius:6, border:"none", cursor:"pointer", fontFamily:"inherit",
                background: activePreset?.label===p.label ? "var(--color-background-primary,#fff)" : "transparent",
                color: activePreset?.label===p.label ? "var(--color-text-primary,#1e293b)" : "var(--color-text-secondary,#94a3b8)",
                boxShadow: activePreset?.label===p.label ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
              }}>{p.label}</button>
            ))}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:12, color:"var(--color-text-secondary,#94a3b8)" }}>
            <span>From</span>
            <input type="datetime-local" value={toInputVal(startTs)} onChange={e => setStartTs(new Date(e.target.value).getTime())}
              style={{ fontSize:12, padding:"4px 8px", borderRadius:6, border:"0.5px solid var(--color-border-tertiary,#e2e8f0)", background:"var(--color-background-primary,#fff)", color:"var(--color-text-primary,#1e293b)", fontFamily:"inherit" }}/>
            <span>To</span>
            <input type="datetime-local" value={toInputVal(endTs)} onChange={e => setEndTs(new Date(e.target.value).getTime())}
              style={{ fontSize:12, padding:"4px 8px", borderRadius:6, border:"0.5px solid var(--color-border-tertiary,#e2e8f0)", background:"var(--color-background-primary,#fff)", color:"var(--color-text-primary,#1e293b)", fontFamily:"inherit" }}/>
            <button onClick={fetchHistory} style={{ fontSize:11, fontWeight:700, padding:"5px 12px", borderRadius:6, border:"0.5px solid var(--color-border-tertiary,#e2e8f0)", background:"var(--color-background-secondary,#f1f5f9)", color:"var(--color-text-primary,#1e293b)", cursor:"pointer", fontFamily:"inherit" }}>Apply</button>
          </div>
          {series.length > 0 && <span style={{ marginLeft:"auto", fontSize:11, color:"var(--color-text-secondary,#94a3b8)" }}>{series.length} points</span>}
        </div>

        {/* Stats */}
        {series.length > 0 && (
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10, padding:"12px 20px", borderBottom:"0.5px solid var(--color-border-tertiary,#e2e8f0)" }}>
            {[["CURRENT",currentValue?.toFixed(1)??"—"],["AVG",avg?.toFixed(1)??"—"],["MIN",minVal?.toFixed(1)??"—"],["MAX",maxVal?.toFixed(1)??"—"]].map(([lbl,val]) => (
              <div key={lbl} style={{ background:"var(--color-background-secondary,#f8fafc)", borderRadius:10, padding:"10px 14px", border:"0.5px solid var(--color-border-tertiary,#e2e8f0)" }}>
                <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.1em", color:"var(--color-text-secondary,#94a3b8)", marginBottom:4 }}>{lbl}</div>
                <div style={{ fontSize:20, fontWeight:700, color: lbl==="CURRENT" ? liveColor : lbl==="MIN" ? getColor(meta, minVal) : lbl==="MAX" ? getColor(meta, maxVal) : "#64748b" }}>
                  {val}<span style={{ fontSize:11, fontWeight:400, marginLeft:2 }}>{meta.unit}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Legend */}
        <div style={{ padding:"10px 20px 0", display:"flex", gap:16, fontSize:11, color:"var(--color-text-secondary,#94a3b8)" }}>
          {[["#22c55e","Normal"],["#f59e0b","Warning"],["#ef4444","Critical"]].map(([c,l]) => (
            <span key={l} style={{ display:"flex", alignItems:"center", gap:4 }}>
              <span style={{ width:24, height:3, background:c, borderRadius:2, display:"inline-block" }}/>
              {l}
            </span>
          ))}
          <span style={{ display:"flex", alignItems:"center", gap:4 }}>
            <span style={{ width:12, height:8, background:"rgba(34,197,94,0.07)", border:"1px solid rgba(34,197,94,0.3)", borderRadius:2, display:"inline-block" }}/>
            Normal range: {meta.normalMin}–{meta.normalMax} {meta.unit}
          </span>
        </div>

        {/* Chart */}
        <div style={{ padding:"8px 20px 20px" }}>
          <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", color:"var(--color-text-secondary,#94a3b8)", marginBottom:8 }}>
            {meta.label.toUpperCase()} — HOVER TO INSPECT
            {loading && <span style={{ opacity:.5, fontWeight:400, marginLeft:8 }}>Loading...</span>}
          </div>
          {loading
            ? <div style={{ height:240, display:"flex", alignItems:"center", justifyContent:"center", color:"var(--color-text-secondary,#94a3b8)", fontSize:13 }}>Loading...</div>
            : <LineChart series={series} meta={meta} fetchError={fetchError} />
          }
        </div>
      </div>
    </div>
  );
}