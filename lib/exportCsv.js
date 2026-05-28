// lib/exportCsv.js
// Fetches history for selected keys and downloads as CSV.

export async function exportCsv({ deviceId, deviceName, patientName, keys, startTs, endTs }) {
  const hours = (endTs - startTs) / 3600_000;
  const rows  = []; // { ts, key, value }

  // Fetch all keys in parallel
  await Promise.all(
    keys.map(async key => {
      try {
        const res  = await fetch(`/api/telemetry/history?deviceId=${deviceId}&key=${key}&hours=${hours.toFixed(4)}&limit=50000`);
        const json = await res.json();
        for (const { ts, value } of (json.series || [])) {
          if (ts >= startTs && ts <= endTs) rows.push({ ts, key, value });
        }
      } catch (_) {}
    })
  );

  if (!rows.length) { alert("No data found for selected range."); return; }

  // Sort by timestamp
  rows.sort((a, b) => a.ts - b.ts);

  // Build CSV — pivot keys into columns
  const uniqueTs  = [...new Set(rows.map(r => r.ts))].sort((a,b) => a-b);
  const byTs      = {};
  for (const r of rows) {
    if (!byTs[r.ts]) byTs[r.ts] = {};
    byTs[r.ts][r.key] = r.value;
  }

  const headers = ["timestamp_ms", "datetime", ...keys];
  const csvRows = [
    // File header comment
    `# VitalSync Export`,
    `# Device: ${deviceName || deviceId}`,
    `# Patient: ${patientName || "N/A"}`,
    `# From: ${new Date(startTs).toISOString()}`,
    `# To: ${new Date(endTs).toISOString()}`,
    `# Generated: ${new Date().toISOString()}`,
    "",
    headers.join(","),
    ...uniqueTs.map(ts => {
      const dt = new Date(ts).toISOString();
      const row = byTs[ts];
      return [ts, dt, ...keys.map(k => row[k] ?? "")].join(",");
    }),
  ];

  // Trigger download
  const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `vitalsync_${deviceName || deviceId}_${new Date(startTs).toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}