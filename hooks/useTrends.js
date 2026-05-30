// hooks/useTrends.js
// Calculates trend direction for each vital (up/down/stable)
// by comparing current value vs average of last N readings.

import { useState, useEffect, useRef } from "react";

const WINDOW = 10;        // number of past readings to average
const STABLE_BAND = 0.02; // % change below which trend is "stable"

export function useTrends(vitals) {
  const history = useRef({ ppgHeartRate:[], ecgHeartRate:[], spo2:[], temperature:[] });
  const [trends, setTrends] = useState({});

  useEffect(() => {
    if (!vitals) return;

    const newTrends = {};

    for (const key of ["ppgHeartRate", "ecgHeartRate", "spo2", "temperature"]) {
      const current = vitals[key]?.value;
      if (current == null) continue;

      // Push to history buffer
      const buf = history.current[key];
      buf.push(current);
      if (buf.length > WINDOW) buf.shift();

      if (buf.length < 3) { newTrends[key] = "stable"; continue; }

      // Compare current vs mean of previous readings (excluding current)
      const prev = buf.slice(0, -1);
      const avg  = prev.reduce((a, b) => a + b, 0) / prev.length;
      const pct  = Math.abs(current - avg) / (avg || 1);

      if (pct < STABLE_BAND)     newTrends[key] = "stable";
      else if (current > avg)    newTrends[key] = "up";
      else                       newTrends[key] = "down";
    }

    setTrends(prev => ({ ...prev, ...newTrends }));
  }, [vitals]);

  return trends; // { ppgHeartRate: "up"|"down"|"stable", ecgHeartRate: ..., ... }
}