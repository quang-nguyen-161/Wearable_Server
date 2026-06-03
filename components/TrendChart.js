// components/TrendChart.js
import { useState } from "react";
import {
  ResponsiveContainer, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  LineChart, Line,
} from "recharts";

const COLOR_MAP = {
  ppgHeartRate: "#5B9BD5", ecgHeartRate: "#00c8ff",
  spo2: "#70AD47", temperature: "#FFC000",
  systolic: "#E74C3C", diastolic: "#9B59B6", respiratoryRate: "#FF96B7",
  glucose: "#5B9BD5", steps: "#70AD47", ecg: "#FF96B7", ppg: "#70AD47",
};

const LABEL_MAP = {
  ppgHeartRate: "PPG Heart Rate (bpm)", ecgHeartRate: "ECG Heart Rate (bpm)",
  spo2: "SpO₂ (%)", temperature: "Temperature (°C)",
  systolic: "Systolic BP (mmHg)", diastolic: "Diastolic BP (mmHg)",
  respiratoryRate: "Resp. Rate (br/min)", glucose: "Glucose (mg/dL)",
  steps: "Steps", ecg: "ECG Signal (µV)", ppg: "PPG Signal (a.u.)",
};

const NORMAL_RANGES = {
  ppgHeartRate: [60, 100], ecgHeartRate: [60, 100],
  spo2: [95, 100], temperature: [36.1, 37.2],
  systolic: [90, 130], diastolic: [60, 85], respiratoryRate: [12, 20], glucose: [70, 140],
};

const SIGNAL_KEYS = new Set(["ecg", "ppg"]);

// ── Display window presets ────────────────────────────────────────────────
// For ECG/PPG (time-based in seconds), for vitals (point count)
const SIGNAL_WINDOWS = [
  { label: "3s",   value: 3,   unit: "sec"  },
  { label: "5s",   value: 5,   unit: "sec"  },
  { label: "10s",  value: 10,  unit: "sec"  },
  { label: "30s",  value: 30,  unit: "sec"  },
  { label: "60s",  value: 60,  unit: "sec"  },
];

const VITAL_WINDOWS = [
  { label: "20 pts",  value: 20  },
  { label: "60 pts",  value: 60  },
  { label: "120 pts", value: 120 },
  { label: "300 pts", value: 300 },
  { label: "All",     value: 9999},
];

// ── Custom tooltip ────────────────────────────────────────────────────────
const CustomTooltip = ({ active, payload, label, metricKey }) => {
  if (!active || !payload?.length) return null;
  const val     = payload[0]?.value;
  const color   = COLOR_MAP[metricKey] || "#5B9BD5";
  const decimals = SIGNAL_KEYS.has(metricKey) ? 4 : 1;
  return (
    <div style={{
      background: "rgba(255,255,255,0.98)", border: `1.5px solid ${color}`,
      borderRadius: 12, padding: "12px 16px",
      fontFamily: "'Inter', sans-serif", fontSize: "0.75rem",
      color: "#2c3e50", backdropFilter: "blur(8px)",
      boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
    }}>
      <div style={{ color, marginBottom: 6, fontWeight: 600 }}>{LABEL_MAP[metricKey]}</div>
      <div style={{ fontSize: "1rem", color, fontWeight: 700 }}>
        {val !== undefined ? val.toFixed(decimals) : "—"}
      </div>
      <div style={{ color: "#7f8c8d", marginTop: 6, fontSize: "0.7rem", fontWeight: 500 }}>{label}</div>
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────
export default function TrendChart({ series, metricKey, loading, hideControls = false, isLiveWaveform = false, stroke, sampleFreqHz = 250, height = 220, liveWindowSec = 5 }) {

  // Live waveform mode — high-performance, no animation, no controls
  if (isLiveWaveform) {
    const liveColor = stroke || COLOR_MAP[metricKey] || "var(--cyan)";
    if (!series || series.length === 0) {
      return (
        <div style={{
          height, display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "Share Tech Mono, monospace", fontSize: "0.72rem",
          color: "rgba(120,160,200,0.4)", letterSpacing: "0.08em",
        }}>
          WAITING FOR SIGNAL…
        </div>
      );
    }
    const windowMs    = liveWindowSec * 1000;
    const MAX_DISPLAY = Math.min(4000, Math.ceil(sampleFreqHz * liveWindowSec));
    const latestTs    = series[series.length - 1].ts;
    const windowed    = series.filter(d => d.ts >= latestTs - windowMs);
    const step        = Math.max(1, Math.floor(windowed.length / MAX_DISPLAY));
    const liveDisplay = step > 1 ? windowed.filter((_, i) => i % step === 0) : windowed;

    const liveDomain = [-7000, 7000];

    // Compute tick interval: snap to a nice value, min 1s, targeting ~5 ticks
    const rawIntervalMs = windowMs / 5;
    const NICE_MS = [1000,2000,5000,10000,15000,30000,60000];
    const tickIntervalMs = NICE_MS.find(n => n >= rawIntervalMs) || 60000;
    const domainStart = latestTs - windowMs;
    const firstTick   = Math.ceil(domainStart / tickIntervalMs) * tickIntervalMs;
    const xTicks = [];
    for (let t = firstTick; t <= latestTs; t += tickIntervalMs) xTicks.push(t);

    const fmtTs = (ts) => new Date(ts).toLocaleTimeString("en-US", {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={liveDisplay} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
          <CartesianGrid stroke="rgba(120,160,200,0.08)" strokeDasharray="4 4" vertical={false} />
          <XAxis
            dataKey="ts"
            type="number"
            scale="time"
            domain={[domainStart, latestTs]}
            ticks={xTicks}
            tickFormatter={fmtTs}
            tick={{ fill: "rgba(120,160,200,0.45)", fontSize: 9, fontFamily: "Share Tech Mono, monospace" }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            type="number"
            domain={liveDomain}
            ticks={[-7000, -3500, 0, 3500, 7000]}
            allowDataOverflow={true}
            tick={{ fill: "rgba(120,160,200,0.45)", fontSize: 9, fontFamily: "Share Tech Mono, monospace" }}
            tickLine={false}
            axisLine={false}
            width={42}
            tickFormatter={v => v === 0 ? "0" : `${Math.round(v / 1000)}k`}
          />
          <Line
            type="linear"
            dataKey="value"
            stroke={liveColor}
            strokeWidth={1.2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    );
  }

  const isSignal  = SIGNAL_KEYS.has(metricKey);
  const windows   = isSignal ? SIGNAL_WINDOWS : VITAL_WINDOWS;

  // Default: 10s for signals, 60 pts for vitals
  const [windowIdx, setWindowIdx] = useState(isSignal ? 2 : 1);

  const color = COLOR_MAP[metricKey] || "#00c8ff";
  const range = NORMAL_RANGES[metricKey];
  const selectedWindow = windows[windowIdx];

  // ── Filter displayData by window ──────────────────────────────────────
  let displayData = [];
  if (series?.length) {
    if (isSignal) {
      // Time-based: use the series' own latest timestamp as anchor
      // (not Date.now() which drifts when tab is inactive)
      const latestTs  = series[series.length - 1].ts;
      const cutoffTs  = latestTs - selectedWindow.value * 1000;
      displayData = series.filter(d => d.ts >= cutoffTs);
      // Safety fallback
      if (displayData.length < 2) displayData = series.slice(-100);
    } else {
      displayData = series.slice(-selectedWindow.value);
    }
  }

  const values   = displayData.map(d => d.value);
  const minVal   = values.length ? Math.min(...values) : 0;
  const maxVal   = values.length ? Math.max(...values) : 1;
  const padding  = (maxVal - minVal) * 0.15 || 0.5;
  const domainMin = parseFloat((minVal - padding).toFixed(4));
  const domainMax = parseFloat((maxVal + padding).toFixed(4));

  if (loading || !series || series.length === 0) {
    return (
      <div style={{
        height: 220, display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "Share Tech Mono, monospace", fontSize: "0.72rem",
        color: "rgba(120,160,200,0.4)", letterSpacing: "0.08em",
      }}>
        {loading ? "LOADING DATA..." : "NO DATA AVAILABLE"}
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>

      {/* ── Chart ── */}
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={displayData} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
          <defs>
            <linearGradient id={`grad-${metricKey}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={color} stopOpacity={0.2} />
              <stop offset="95%" stopColor={color} stopOpacity={0}   />
            </linearGradient>
          </defs>

          <CartesianGrid stroke="rgba(255,255,255,0.04)" strokeDasharray="4 4" vertical={false} />

          <XAxis
            dataKey="time"
            tick={{ fill: "rgba(120,160,200,0.45)", fontSize: 10, fontFamily: "Share Tech Mono, monospace" }}
            tickLine={false} axisLine={false} interval="preserveStartEnd"
          />

          <YAxis
            domain={[domainMin, domainMax]}
            tick={{ fill: "rgba(120,160,200,0.45)", fontSize: 10, fontFamily: "Share Tech Mono, monospace" }}
            tickLine={false} axisLine={false} width={36}
            tickFormatter={v => SIGNAL_KEYS.has(metricKey) ? v.toFixed(2) : v.toFixed(1)}
          />

          <Tooltip content={<CustomTooltip metricKey={metricKey} />} />

          {range && (
            <>
              <ReferenceLine y={range[0]} stroke={color} strokeOpacity={0.2} strokeDasharray="3 3"
                label={{ value: "MIN", fill: color, fontSize: 9, opacity: 0.5 }} />
              <ReferenceLine y={range[1]} stroke={color} strokeOpacity={0.2} strokeDasharray="3 3"
                label={{ value: "MAX", fill: color, fontSize: 9, opacity: 0.5 }} />
            </>
          )}

          <Area
            type="monotone" dataKey="value"
            stroke={color} strokeWidth={1.5}
            fill={`url(#grad-${metricKey})`}
            dot={false}
            activeDot={{ r: 4, fill: color, stroke: "none" }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}