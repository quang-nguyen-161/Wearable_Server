// components/TrendChart.js
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";

const COLOR_MAP = {
  heartRate: "#5B9BD5",
  spo2: "#70AD47",
  temperature: "#FFC000",
  systolic: "#E74C3C",
  diastolic: "#9B59B6",
  respiratoryRate: "#FF96B7",
  glucose: "#5B9BD5",
  steps: "#70AD47",
  ecg: "#FF96B7",
  ppg: "#70AD47",
};

const LABEL_MAP = {
  heartRate: "Heart Rate (bpm)",
  spo2: "SpO₂ (%)",
  temperature: "Temperature (°C)",
  systolic: "Systolic BP (mmHg)",
  diastolic: "Diastolic BP (mmHg)",
  respiratoryRate: "Resp. Rate (br/min)",
  glucose: "Glucose (mg/dL)",
  steps: "Steps",
  ecg: "ECG Signal (µV)",
  ppg: "PPG Signal (a.u.)",
};

const NORMAL_RANGES = {
  heartRate: [60, 100],
  spo2: [95, 100],
  temperature: [36.1, 37.2],
  systolic: [90, 130],
  diastolic: [60, 85],
  respiratoryRate: [12, 20],
  glucose: [70, 140],
};

const CustomTooltip = ({ active, payload, label, metricKey }) => {
  if (!active || !payload || !payload.length) return null;

  const val = payload[0]?.value;
  const color = COLOR_MAP[metricKey] || "#5B9BD5";

  return (
    <div
      style={{
        background: "rgba(255, 255, 255, 0.98)",
        border: `1.5px solid ${color}`,
        borderRadius: 12,
        padding: "12px 16px",
        fontFamily: "'Inter', sans-serif",
        fontSize: "0.75rem",
        color: "#2c3e50",
        backdropFilter: "blur(8px)",
        boxShadow: "0 4px 16px rgba(0, 0, 0, 0.1)",
      }}
    >
      <div style={{ color, marginBottom: 6, fontWeight: 600 }}>{LABEL_MAP[metricKey]}</div>
      <div style={{ fontSize: "1rem", color, fontWeight: 700 }}>
        {val !== undefined ? val.toFixed(1) : "—"}
      </div>
      <div style={{ color: "#7f8c8d", marginTop: 6, fontSize: "0.7rem", fontWeight: 500 }}>
        {label}
      </div>
    </div>
  );
};

export default function TrendChart({ series, metricKey, loading }) {
  const color = COLOR_MAP[metricKey] || "#00c8ff";
  const range = NORMAL_RANGES[metricKey];

  if (loading || !series || series.length === 0) {
    return (
      <div
        style={{
          height: 220,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "Share Tech Mono, monospace",
          fontSize: "0.72rem",
          color: "rgba(120,160,200,0.4)",
          letterSpacing: "0.08em",
        }}
      >
        {loading ? "LOADING DATA..." : "NO DATA AVAILABLE"}
      </div>
    );
  }

  // Show only last 60 points to keep chart clean
  const displayData = series.slice(-60);

  const values = displayData.map((d) => d.value);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const padding = (maxVal - minVal) * 0.15 || 2;
  const domainMin = Math.floor(minVal - padding);
  const domainMax = Math.ceil(maxVal + padding);

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={displayData} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
        <defs>
          <linearGradient id={`grad-${metricKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.2} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>

        <CartesianGrid
          stroke="rgba(255,255,255,0.04)"
          strokeDasharray="4 4"
          vertical={false}
        />

        <XAxis
          dataKey="time"
          tick={{
            fill: "rgba(120,160,200,0.45)",
            fontSize: 10,
            fontFamily: "Share Tech Mono, monospace",
          }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />

        <YAxis
          domain={[domainMin, domainMax]}
          tick={{
            fill: "rgba(120,160,200,0.45)",
            fontSize: 10,
            fontFamily: "Share Tech Mono, monospace",
          }}
          tickLine={false}
          axisLine={false}
          width={36}
        />

        <Tooltip content={<CustomTooltip metricKey={metricKey} />} />

        {range && (
          <>
            <ReferenceLine
              y={range[0]}
              stroke={color}
              strokeOpacity={0.2}
              strokeDasharray="3 3"
              label={{ value: "MIN", fill: color, fontSize: 9, opacity: 0.5 }}
            />
            <ReferenceLine
              y={range[1]}
              stroke={color}
              strokeOpacity={0.2}
              strokeDasharray="3 3"
              label={{ value: "MAX", fill: color, fontSize: 9, opacity: 0.5 }}
            />
          </>
        )}

        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={1.5}
          fill={`url(#grad-${metricKey})`}
          dot={false}
          activeDot={{ r: 4, fill: color, stroke: "none" }}
          isAnimationActive
          animationDuration={600}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
