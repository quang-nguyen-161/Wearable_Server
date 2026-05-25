# HealthMonitor Dashboard - Complete Development Guide

A comprehensive A-Z guide for modifying and extending the HealthMonitor application including JavaScript, CSS, HTML structure, and more.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Project Structure](#project-structure)
3. [A-Z Development Guide](#a-z-development-guide)
4. [CSS System](#css-system)
5. [Adding New Features](#adding-new-features)
6. [Common Modifications](#common-modifications)
7. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

The HealthMonitor is a **Next.js React application** that displays real-time health monitoring data from ThingsBoard IoT platform.

**Tech Stack:**
- **Framework:** Next.js 14.2.3 (React 18)
- **Styling:** CSS3 with CSS Variables (Light/Dark themes)
- **Charts:** Recharts for data visualization
- **Data Source:** ThingsBoard Cloud API
- **Storage:** localStorage for user preferences

**Key Features:**
- Real-time vital sign monitoring (Heart Rate, SpO₂, Temperature)
- ECG and PPG signal visualization
- Light/Dark theme toggle
- Auto-refresh every 10 seconds
- Responsive design (4-col on desktop, 3-col on tablet, 2-col on mobile)

---

## Project Structure

```
health-monitor/
├── pages/
│   ├── index.js                 # Main dashboard component
│   ├── _app.js                  # App wrapper
│   └── api/
│       ├── patient.js           # Patient info endpoint
│       └── telemetry/
│           ├── latest.js        # Latest vitals endpoint
│           └── history.js       # Historical data endpoint
│
├── components/
│   ├── VitalCard.js             # Individual vital display card
│   └── TrendChart.js            # Chart component for signals
│
├── lib/
│   └── thingsboard.js           # ThingsBoard API helpers
│
├── styles/
│   └── globals.css              # All styling (light & dark modes)
│
├── public/
│   └── (static assets)
│
├── package.json                 # Dependencies
├── next.config.js               # Next.js configuration
├── .env.local                   # Environment variables (Git ignored)
└── README.md                    # Project documentation
```

---

## A-Z Development Guide

### A - Adding State Variables

**Location:** `pages/index.js` → `Dashboard` component

```javascript
// Add new state at the top of the component
const [newVariable, setNewVariable] = useState(initialValue);

// Example:
const [showAlerts, setShowAlerts] = useState(false);
```

**Rules:**
- Use descriptive names (avoid single letters)
- Group related states together
- Initialize with appropriate type (array, object, string, etc.)

---

### B - Building & Running

**Development Server:**
```bash
cd health-monitor
npm run dev
# Runs on http://localhost:3000 (or next available port)
```

**Production Build:**
```bash
npm run build
npm start
```

**Clear Cache:**
```bash
rm -r .next
npm run dev
```

---

### C - CSS Changes & Styling

**Location:** `styles/globals.css`

**Theme Variables:**
The app uses CSS custom properties that change based on `data-theme` attribute:

```css
:root[data-theme="light"] {
  --bg-void: #f8f9fa;        /* Page background */
  --bg-card: #ffffff;        /* Card background */
  --text-primary: #2c3e50;   /* Main text */
  --cyan: #5B9BD5;           /* Accent color */
  /* ... more variables */
}

:root[data-theme="dark"] {
  --bg-void: #0f1419;
  --bg-card: #232d3c;
  --text-primary: #e0e6ed;
  /* ... dark variants */
}
```

**Adding New Styles:**

1. **For light mode only:**
   ```css
   .my-component {
     color: var(--text-primary);  /* Automatic theme switching */
   }
   ```

2. **For theme-specific styles:**
   ```css
   :root[data-theme="light"] .my-component {
     background: #fff;
   }
   
   :root[data-theme="dark"] .my-component {
     background: #1a1f2e;
   }
   ```

3. **Common CSS Classes:**
   - `.vital-card` - Individual health metric display
   - `.chart-section` - Chart container
   - `.header` - Top navigation
   - `.patient-bar` - Patient information display
   - `.dashboard-grid` - Main grid layout

---

### D - Data Fetching & APIs

**Location:** `pages/index.js` and `pages/api/`

**Fetch Functions:**

1. **Latest Vitals** (`/api/telemetry/latest`)
   ```javascript
   const fetchVitals = useCallback(async () => {
     const res = await fetch("/api/telemetry/latest");
     const json = await res.json();
     setVitals(json.data || {});
   }, []);
   ```

2. **Signal Data** (`/api/telemetry/history`)
   ```javascript
   const fetchSignals = useCallback(async () => {
     const ecgRes = await fetch(`/api/telemetry/history?key=ecg&hours=1`);
     const ecgJson = await ecgRes.json();
     setEcgData(ecgJson.series || []);
   }, []);
   ```

**Data Format:**
```javascript
// Vital data
{
  heartRate: { value: 72, ts: 1234567890 },
  spo2: { value: 98, ts: 1234567890 },
  temperature: { value: 36.8, ts: 1234567890 }
}

// Chart data
[
  { ts: 1234567890, time: "10:30", value: 72 },
  { ts: 1234567891, time: "10:31", value: 73 }
]
```

---

### E - Environment Variables

**Location:** `.env.local` (create this file in project root)

```env
TB_BASE_URL=https://thingsboard.cloud
TB_USERNAME=your-username
TB_PASSWORD=your-password
TB_DEVICE_ID=your-device-uuid
```

**Where to use:**
- Imported in `lib/thingsboard.js` via `process.env`
- Never commit to Git (already in .gitignore)

---

### F - File Organization

**When to modify each file:**

- **pages/index.js** - UI layout, state logic, data fetching
- **components/VitalCard.js** - Individual card styling/behavior
- **components/TrendChart.js** - Chart appearance/data formatting
- **styles/globals.css** - Colors, spacing, responsive breakpoints
- **lib/thingsboard.js** - API communication
- **pages/api/** - Backend endpoints

---

### G - Grid Layout

**Dashboard Grid Configuration:**

```css
.dashboard-grid {
  grid-template-columns: repeat(4, 1fr);  /* Desktop: 4 columns */
  gap: 16px;
}

@media (max-width: 1100px) {
  .dashboard-grid { grid-template-columns: repeat(3, 1fr); }
}

@media (max-width: 768px) {
  .dashboard-grid { grid-template-columns: repeat(2, 1fr); }
}
```

**Modify card width:**
- Change grid column count in breakpoints
- Cards automatically resize

---

### H - Header Component

**Location:** `pages/index.js` lines 175-200

**Elements:**
- Brand logo and name
- Connection status badge
- Last update time
- Theme toggle button (🌙/☀️)
- Refresh button

**Modify header:**
```javascript
<header className="header">
  {/* Brand section */}
  <div className="header-brand">...</div>
  
  {/* Right side controls */}
  <div className="header-right">
    {/* Status, time, theme toggle, refresh */}
  </div>
</header>
```

---

### I - Imports & Dependencies

**Essential imports in index.js:**
```javascript
import { useState, useEffect, useCallback, useRef } from "react";
import Head from "next/head";
import VitalCard from "../components/VitalCard";
import TrendChart from "../components/TrendChart";
```

**Adding new packages:**
```bash
npm install package-name
npm install --save-dev package-name  # Dev dependency
```

Then import in your files:
```javascript
import { Component } from 'package-name';
```

---

### J - JavaScript Events & Handlers

**Button Click Handler:**
```javascript
const handleClick = () => {
  // Action here
};

<button onClick={handleClick}>Click Me</button>
```

**Event Delegation (Dashboard):**
```javascript
const toggleTheme = () => {
  const newTheme = theme === "light" ? "dark" : "light";
  setTheme(newTheme);
  localStorage.setItem("theme", newTheme);
  document.documentElement.setAttribute("data-theme", newTheme);
};

<button onClick={toggleTheme}>🌙 / ☀️</button>
```

---

### K - Key Props & Unique Identifiers

**React Keys (Required in Lists):**
```javascript
{VITALS.map((v, i) => (
  <VitalCard
    key={v.key}  // ✓ Unique identifier
    label={v.label}
    // ...
  />
))}
```

**Rules:**
- Always use unique, stable keys
- Never use array index as key (causes bugs)
- Use unique ID from data (v.key, v.id, etc.)

---

### L - localStorage for Persistence

**Saving Theme Preference:**
```javascript
useEffect(() => {
  const savedTheme = localStorage.getItem("theme") || "light";
  setTheme(savedTheme);
  document.documentElement.setAttribute("data-theme", savedTheme);
}, []);

// Save when changed
const toggleTheme = () => {
  const newTheme = theme === "light" ? "dark" : "light";
  localStorage.setItem("theme", newTheme);
  setTheme(newTheme);
};
```

**Store other preferences:**
```javascript
// Save user preferences
localStorage.setItem("refreshInterval", "10000");

// Retrieve them
const interval = localStorage.getItem("refreshInterval") || "10000";
```

---

### M - Modifying Vital Parameters

**Location:** `pages/index.js` lines 7-34

Currently showing:
- Heart Rate (♥)
- SpO₂ (💧)
- Temperature (🌡)

**To add a vital:**
```javascript
const VITALS = [
  // ... existing vitals
  {
    key: "bloodPressure",
    label: "BLOOD PRESSURE",
    icon: "▲",
    unit: "mmHg",
    color: "red",
    min: 90, max: 130,
    critMin: 70, critMax: 180,
  },
];
```

**Required fields:**
- `key` - Unique identifier (matches ThingsBoard telemetry key)
- `label` - Display name
- `icon` - Emoji or symbol
- `unit` - Measurement unit
- `color` - Color variant (cyan, green, amber, red, purple, pink)
- `min`/`max` - Normal range
- `critMin`/`critMax` - Critical range

**Update API calls:**
Add key to `pages/api/telemetry/latest.js`:
```javascript
const keys = [
  "heartRate",
  "spo2",
  "temperature",
  "bloodPressure",  // Add here
];
```

---

### N - Next.js Specific

**File-based routing:**
- `pages/index.js` → `/`
- `pages/api/patient.js` → `/api/patient`
- `pages/api/telemetry/latest.js` → `/api/telemetry/latest`

**API Routes:**
Files in `pages/api/` become server endpoints automatically:
```javascript
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  
  const data = await fetchData();
  res.status(200).json(data);
}
```

---

### O - Output & Logging

**Console Debugging:**
```javascript
console.log("Variable value:", variable);
console.error("Error occurred:", error);
console.warn("Warning message");
```

**In Terminal:**
```bash
# During development, check terminal for console output
npm run dev
# Errors will appear in the terminal
```

---

### P - Patient Information Display

**Location:** `pages/index.js` lines 202-220

Shows patient details if available from API:
- Name
- ID
- Ward
- Physician
- Age, Gender, Blood Type, Weight

**Data comes from:** `pages/api/patient.js`

**Modify patient attributes:**
```javascript
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
```

---

### Q - Query Parameters

**Getting URL parameters:**
```javascript
import { useRouter } from 'next/router';

const router = useRouter();
const { id } = router.query;
```

**API endpoint parameters:**
```javascript
// In pages/api/telemetry/history.js
const { key = "heartRate", hours = "1" } = req.query;
```

---

### R - Responsive Design Breakpoints

**Location:** `styles/globals.css` lines 592+

```css
/* Desktop (default) */
.dashboard-grid { grid-template-columns: repeat(4, 1fr); }

/* Tablet */
@media (max-width: 1100px) {
  .dashboard-grid { grid-template-columns: repeat(3, 1fr); }
}

/* Tablet - small */
@media (max-width: 768px) {
  .app-shell { padding: 0 16px 32px; }
  .dashboard-grid { grid-template-columns: repeat(2, 1fr); }
  .card-value { font-size: 2rem; }
}

/* Mobile */
@media (max-width: 480px) {
  .dashboard-grid { grid-template-columns: 1fr 1fr; }
  .vital-card { padding: 16px 14px; }
}
```

**Modify breakpoints:**
- Adjust pixel values for different screen sizes
- Test with browser DevTools

---

### S - Signals & Charts

**ECG & PPG Signal Visualization**

**Location:** `pages/index.js` lines 251-270

**Data fetch:**
```javascript
const fetchSignals = useCallback(async () => {
  const ecgRes = await fetch(`/api/telemetry/history?key=ecg&hours=1`);
  const ppgRes = await fetch(`/api/telemetry/history?key=ppg&hours=1`);
  // ... process results
}, []);
```

**Display:**
```javascript
<TrendChart
  series={ecgData}
  metricKey="ecg"
  loading={signalsLoading}
/>
```

**Add new signal type:**

1. Add to fetchSignals:
```javascript
const signalRes = await fetch(`/api/telemetry/history?key=signal&hours=1`);
const [, setSignalData] = useState([]);
```

2. Add chart section:
```javascript
<div className="chart-section">
  <div className="chart-header">
    <span className="chart-title">SIGNAL NAME</span>
  </div>
  <TrendChart series={signalData} metricKey="signal" loading={signalsLoading} />
</div>
```

---

### T - Theme System

**Current Theme:** Stored in `document.documentElement.getAttribute("data-theme")`

**Toggle theme:**
```javascript
const toggleTheme = () => {
  const newTheme = theme === "light" ? "dark" : "light";
  setTheme(newTheme);
  localStorage.setItem("theme", newTheme);
  document.documentElement.setAttribute("data-theme", newTheme);
};
```

**Add custom theme:**

1. Add CSS variables:
```css
:root[data-theme="custom"] {
  --bg-void: #yourcolor;
  --text-primary: #yourcolor;
  /* ... all variables */
}
```

2. Update toggle logic:
```javascript
const themes = ["light", "dark", "custom"];
const currentIndex = themes.indexOf(theme);
const newTheme = themes[(currentIndex + 1) % themes.length];
```

---

### U - useEffect Hook for Side Effects

**Initial data fetching:**
```javascript
useEffect(() => {
  fetchVitals();
  fetchPatient();
  fetchSignals();
}, []);  // Empty dependency = runs once on mount
```

**Theme initialization:**
```javascript
useEffect(() => {
  const savedTheme = localStorage.getItem("theme") || "light";
  setTheme(savedTheme);
  document.documentElement.setAttribute("data-theme", savedTheme);
}, []);
```

**Auto-refresh:**
```javascript
useEffect(() => {
  const interval = setInterval(fetchVitals, 10000);
  return () => clearInterval(interval);  // Cleanup
}, [fetchVitals]);
```

**When dependencies change:**
```javascript
useEffect(() => {
  // Runs whenever 'activeKey' or 'activeHours' changes
  fetchHistory(activeKey, activeHours);
}, [activeKey, activeHours]);
```

---

### V - Vital Card Component

**Location:** `components/VitalCard.js`

**Props:**
```javascript
<VitalCard
  label="HEART RATE"
  icon="♥"
  value={72}
  unit="bpm"
  color="cyan"
  min={60}
  max={100}
  critMin={40}
  critMax={130}
  loading={false}
  animDelay={0}
/>
```

**Status Determination:**
- Green (NORMAL) - value between min/max
- Yellow (CAUTION) - value outside min/max
- Red (ALERT) - value outside critMin/critMax

**Percentage bar:**
- Shows position within critical range
- Animated fill based on value

---

### W - Warning & Error Handling

**Error Banner:**
```javascript
{error && (
  <div className="error-banner">
    <span>⚠</span>
    <span>CONNECTION ERROR: {error}</span>
  </div>
)}
```

**Loading States:**
```javascript
{loading && displayValue === null ? "––" : displayValue ?? "––"}
```

**Try-Catch in API calls:**
```javascript
const fetchData = useCallback(async () => {
  try {
    const res = await fetch("/api/endpoint");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    // Process data
  } catch (err) {
    console.error("Fetch error:", err);
    setError(err.message);
  } finally {
    setLoading(false);
  }
}, []);
```

---

### X - Extending Functionality

**Common Extensions:**

1. **Add patient alerts:**
```javascript
const [alerts, setAlerts] = useState([]);

useEffect(() => {
  const criticalVitals = Object.entries(vitals).filter(
    ([key, data]) => isCritical(key, data.value)
  );
  setAlerts(criticalVitals);
}, [vitals]);
```

2. **Add data export:**
```javascript
const exportData = () => {
  const csv = convertToCSV(chartData);
  downloadFile(csv, "health-data.csv");
};
```

3. **Add alarm sounds:**
```javascript
const playAlarm = () => {
  new Audio("/alarm.mp3").play();
};
```

---

### Y - YAML & Configuration

**Next.js doesn't use YAML by default, but you can:**

```bash
npm install js-yaml
```

Then:
```javascript
import YAML from 'js-yaml';

const config = YAML.load(configYAML);
```

**Or use JSON (simpler):**
```javascript
const config = {
  refreshInterval: 10000,
  maxChartPoints: 200,
  // ...
};
```

---

### Z - Zero-Based Indexing (Arrays)

**Always remember arrays start at 0:**
```javascript
const items = ["a", "b", "c"];
items[0] // "a"
items[1] // "b"
items[2] // "c"

// Using in map:
VITALS.map((v, i) => (
  <VitalCard
    key={v.key}
    animDelay={i * 60}  // 0, 60, 120, ...
  />
))
```

---

## CSS System

### Color Palette

**Light Mode:**
- Background: `#f8f9fa` → `#ffffff`
- Text: `#2c3e50`
- Accent (Cyan): `#5B9BD5`
- Success (Green): `#70AD47`
- Warning (Amber): `#FFC000`
- Danger (Red): `#E74C3C`

**Dark Mode:**
- Background: `#0f1419` → `#232d3c`
- Text: `#e0e6ed`
- Colors same, with adjusted opacity

### Spacing

```css
--radius: 16px;        /* Border radius for cards */
--radius-sm: 10px;     /* Smaller radius for buttons */

/* Gaps */
gap: 16px;            /* Between cards */
gap: 28px;            /* Between sections */
gap: 8px;             /* Between buttons */
```

### Shadows

```css
--shadow-card: 0 2px 12px rgba(0, 0, 0, 0.08);
--shadow-glow-cyan: 0 4px 16px rgba(91, 155, 213, 0.12);
```

---

## Adding New Features

### 1. Add a New Vital Parameter

```javascript
// 1. Add to VITALS array
const VITALS = [
  // ... existing
  {
    key: "newVital",
    label: "NEW VITAL",
    icon: "🔔",
    unit: "units",
    color: "purple",
    min: 0, max: 100,
    critMin: -10, critMax: 110,
  },
];

// 2. Add to API keys (pages/api/telemetry/latest.js)
const keys = [
  "heartRate",
  "spo2",
  "temperature",
  "newVital",  // ← Add
];

// 3. Update color map in TrendChart.js if needed
const COLOR_MAP = {
  // ...
  newVital: "#9B59B6",  // ← Add
};
```

### 2. Add a New Chart/Signal

```javascript
// 1. Add state
const [newSignalData, setNewSignalData] = useState([]);

// 2. Fetch data
const fetchSignals = useCallback(async () => {
  // ... existing fetches
  const newRes = await fetch(`/api/telemetry/history?key=newSignal&hours=1`);
  if (newRes.ok) {
    const newJson = await newRes.json();
    setNewSignalData(newJson.series || []);
  }
}, []);

// 3. Display chart
<div className="chart-section">
  <div className="chart-header">
    <span className="chart-title">NEW SIGNAL</span>
  </div>
  <TrendChart series={newSignalData} metricKey="newSignal" loading={signalsLoading} />
</div>
```

### 3. Change Color Scheme

Update CSS variables:
```css
:root[data-theme="light"] {
  --cyan: #your-color;
  --green: #your-color;
  --text-primary: #your-color;
  /* ... etc */
}

:root[data-theme="dark"] {
  --cyan: #your-dark-color;
  /* ... */
}
```

---

## Common Modifications

### Adjust Refresh Interval

```javascript
// Currently: 10 seconds (10000ms)
useEffect(() => {
  intervalRef.current = setInterval(fetchVitals, 10000);  // ← Change here
  return () => clearInterval(intervalRef.current);
}, [fetchVitals]);
```

### Change Chart Time Range

```javascript
// In fetchSignals:
const [ecgRes, ppgRes] = await Promise.all([
  fetch(`/api/telemetry/history?key=ecg&hours=24`),  // ← Change hours
  fetch(`/api/telemetry/history?key=ppg&hours=24`),
]);
```

### Modify Card Layout

```css
/* Change from 4 to 3 columns */
.dashboard-grid {
  grid-template-columns: repeat(3, 1fr);
}
```

### Hide Patient Bar

```javascript
// Comment out in render:
{/*{patient && (
  <div className="patient-bar">
    ...
  </div>
)}*/}
```

---

## Troubleshooting

### Issue: "key" prop warning

**Cause:** Spreading vitals object into component includes `key` in props

**Solution:** Explicitly pass props (already fixed in current version)

```javascript
// ❌ Wrong
<VitalCard key={v.key} {...v} value={...} />

// ✓ Correct
<VitalCard
  key={v.key}
  label={v.label}
  icon={v.icon}
  // ... each prop explicitly
/>
```

### Issue: Theme doesn't persist

**Cause:** localStorage not loading on mount

**Solution:** Check useEffect runs on mount:
```javascript
useEffect(() => {
  const savedTheme = localStorage.getItem("theme") || "light";
  setTheme(savedTheme);
  document.documentElement.setAttribute("data-theme", savedTheme);
}, []);  // ← Empty dependency array
```

### Issue: Connection Error to ThingsBoard

**Cause:** .env.local missing or incorrect

**Solution:** Create `.env.local` with correct credentials:
```env
TB_BASE_URL=https://thingsboard.cloud
TB_USERNAME=your-email
TB_PASSWORD=your-password
TB_DEVICE_ID=your-device-uuid
```

### Issue: Charts show "NO DATA AVAILABLE"

**Cause:** Telemetry keys don't match device

**Solution:** Verify in ThingsBoard:
1. Go to Device Details
2. Check telemetry key names match code
3. Ensure data is being sent

---

## Performance Tips

1. **Memoize callbacks:** Use `useCallback` for functions passed to children
2. **Limit chart points:** TrendChart shows last 60 points to avoid lag
3. **Batch updates:** Use Promise.all for parallel API calls
4. **Debounce window resize:** If adding window resize listener

---

## Security Notes

1. **Never commit .env.local** - Already in .gitignore
2. **API tokens cached:** 2 hours in thingsboard.js
3. **HTTPS recommended:** For production deployment
4. **Validate inputs:** Check API responses before using

---

## Deployment

```bash
# Build for production
npm run build

# Start production server
npm start
```

**Vercel (recommended for Next.js):**
```bash
# Push to GitHub
git push origin main

# Deploy via Vercel dashboard or CLI
vercel
```

---

## Resources

- [Next.js Documentation](https://nextjs.org/docs)
- [React Hooks Reference](https://react.dev/reference/react)
- [Recharts Documentation](https://recharts.org)
- [ThingsBoard API Docs](https://thingsboard.io/docs/api/)
- [CSS Variables Guide](https://developer.mozilla.org/en-US/docs/Web/CSS/--*)

---

**Last Updated:** May 24, 2026  
**Version:** 2.0.0  
**Author:** HealthMonitor Development Team
