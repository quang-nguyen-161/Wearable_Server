// lib/thingsboard.js

const TB_URL  = process.env.TB_BASE_URL?.replace(/\/$/, "");
const TB_USER = process.env.TB_USERNAME;
const TB_PASS = process.env.TB_PASSWORD;

let _cache = { token: null, expiresAt: 0 };

/* ── Auth ──────────────────────────────────────────────────── */
export async function getTbToken() {
  const now = Date.now();
  if (_cache.token && now < _cache.expiresAt - 30_000) return _cache.token;

  const res = await fetch(`${TB_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: TB_USER, password: TB_PASS }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TB auth failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  _cache = { token: json.token, expiresAt: now + 2.5 * 60 * 60 * 1000 };
  return _cache.token;
}

/* ── Generic GET ───────────────────────────────────────────── */
export async function tbGet(path, query = {}) {
  const token = await getTbToken();
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)]))
  ).toString();
  const url = `${TB_URL}${path}${qs ? "?" + qs : ""}`;

  const res = await fetch(url, {
    headers: { "X-Authorization": `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TB GET ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

/* ── Telemetry ─────────────────────────────────────────────── */
export async function getLatestTelemetry(deviceId, keys) {
  const raw = await tbGet(
    `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`,
    { keys: keys.join(",") }
  );
  const result = {};
  for (const key of keys) {
    const entry = raw[key]?.[0];
    if (entry) result[key] = { value: parseFloat(entry.value), ts: entry.ts };
  }
  return result;
}

export async function getTelemetryHistory(deviceId, key, hours = 1, limit = 1000) {
  const endTs = Date.now();
  const startTs = endTs - hours * 60 * 60 * 1000;
  const raw = await tbGet(
    `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`,
    { keys: key, startTs, endTs, limit, orderBy: "ASC" }
  );
  return (raw[key] || []).map((pt) => ({ ts: pt.ts, value: parseFloat(pt.value) }));
}

/* ── Attributes ────────────────────────────────────────────── */
export async function getDeviceAttributes(deviceId, keys = [], scope = "SERVER_SCOPE") {
  const raw = await tbGet(
    `/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes/${scope}`,
    keys.length > 0 ? { keys: keys.join(",") } : {}
  );
  const result = {};
  for (const item of raw || []) result[item.key] = item.value;
  return result;
}

export async function getPatientInfo(deviceId) {
  const attrs = await getDeviceAttributes(deviceId, [
    "patientName","patientId","ward","physician",
    "age","gender","bloodType","weight",
    "hospitalPhone","physicianPhone","familyPhone",
  ]);
  return {
    patientName:    attrs.patientName    ?? null,
    patientId:      attrs.patientId      ?? null,
    ward:           attrs.ward           ?? null,
    physician:      attrs.physician      ?? null,
    age:            attrs.age            ?? null,
    gender:         attrs.gender         ?? null,
    bloodType:      attrs.bloodType      ?? null,
    weight:         attrs.weight         ?? null,
    hospitalPhone:  attrs.hospitalPhone  ?? null,
    physicianPhone: attrs.physicianPhone ?? null,
    familyPhone:    attrs.familyPhone    ?? null,
  };
}