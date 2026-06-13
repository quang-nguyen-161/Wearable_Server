// lib/tbBrowserClient.js
// Browser-side ThingsBoard API client.
// All calls use the JWT obtained on the login page — the browser handles
// Cloudflare challenges so these work even when server-side calls are blocked.

const TB_URL    = process.env.NEXT_PUBLIC_TB_BASE_URL?.replace(/\/$/, "");
export const GATEWAY_ID = process.env.NEXT_PUBLIC_TB_DEVICE_ID;

async function tbFetch(path, token, options = {}) {
  const res = await fetch(`${TB_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Authorization": `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    if (typeof window !== "undefined") {
      sessionStorage.removeItem("tb_token");
      sessionStorage.removeItem("tb_token_expiry");
      window.location.href = "/login";
    }
    throw new Error("Session expired — redirecting to login");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TB ${path} (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Devices ──────────────────────────────────────────────────────────────────

export async function getDevices(token) {
  let allDevices = [];

  try {
    const relations = await tbFetch(
      `/api/relations?fromId=${GATEWAY_ID}&fromType=DEVICE&relationType=Manages&relationTypeGroup=COMMON`,
      token
    );
    const childIds = (Array.isArray(relations) ? relations : [])
      .filter(r => r?.to?.entityType === "DEVICE")
      .map(r => r.to.id);

    if (childIds.length > 0) {
      const infos = await Promise.all(
        childIds.map(id => tbFetch(`/api/device/${id}`, token).catch(() => null))
      );
      allDevices = infos.filter(Boolean).map(d => ({
        id: d.id.id, name: d.name, label: d.label || null,
      }));
    }
  } catch (_) {}

  if (allDevices.length === 0) {
    const all = await tbFetch(`/api/tenant/devices?pageSize=100&page=0`, token);
    allDevices = (all?.data || [])
      .filter(d => d.id.id !== GATEWAY_ID)
      .map(d => ({ id: d.id.id, name: d.name, label: d.label || null }));
  }

  const nodeDevices = allDevices.filter(d => d.name.toLowerCase().includes("node"));

  const withStatus = await Promise.all(
    nodeDevices.map(async (device) => {
      try {
        const attrs = await tbFetch(
          `/api/plugins/telemetry/DEVICE/${device.id}/values/attributes?keys=connected,patientName`,
          token
        );
        const map = {};
        for (const item of attrs || []) map[item.key] = item.value;

        return {
          ...device,
          patientName:        map.patientName || null,
          displayName:        map.patientName || device.name,
          online:             map.connected === true || map.connected === "true",
        };
      } catch (_) {
        return { ...device, online: false };
      }
    })
  );

  return withStatus.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Attributes ───────────────────────────────────────────────────────────────

export async function getDeviceAttributes(token, deviceId) {
  const [serverRaw, sharedRaw] = await Promise.all([
    tbFetch(`/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes/SERVER_SCOPE`, token),
    tbFetch(`/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes/SHARED_SCOPE`, token),
  ]);
  const flatten = arr =>
    (arr || []).reduce((acc, item) => ({ ...acc, [item.key]: item.value }), {});
  return { ...flatten(serverRaw), ...flatten(sharedRaw) };
}

export async function saveDeviceAttributes(token, deviceId, scope, attributes) {
  const res = await fetch(
    `${TB_URL}/api/plugins/telemetry/DEVICE/${deviceId}/attributes/${scope}`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json", "X-Authorization": `Bearer ${token}` },
      body:    JSON.stringify(attributes),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Save attributes failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

// ── Telemetry history ─────────────────────────────────────────────────────────

export async function getTelemetryHistory(token, deviceId, key, hours = 1, limit = 1000) {
  const endTs   = Date.now();
  const startTs = endTs - hours * 60 * 60 * 1000;
  const data = await tbFetch(
    `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?keys=${key}&startTs=${startTs}&endTs=${endTs}&limit=${limit}&orderBy=ASC`,
    token
  );
  return (data[key] || []).map(pt => ({ ts: pt.ts, value: parseFloat(pt.value) }));
}

export async function getTelemetryHistoryRange(token, deviceId, key, startTs, endTs, limit = 5000) {
  const data = await tbFetch(
    `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?keys=${key}&startTs=${startTs}&endTs=${endTs}&limit=${limit}&orderBy=ASC`,
    token
  );
  return (data[key] || []).map(pt => ({ ts: pt.ts, value: parseFloat(pt.value) }));
}

// ── Patient info ──────────────────────────────────────────────────────────────

export async function getPatientInfo(token, deviceId) {
  const attrs = await tbFetch(
    `/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes/SERVER_SCOPE?keys=patientName,patientId,ward,physician,age,gender,bloodType,weight,hospitalPhone,physicianPhone,familyPhone`,
    token
  );
  const map = {};
  for (const item of attrs || []) map[item.key] = item.value;
  return {
    patientName:    map.patientName    ?? null,
    patientId:      map.patientId      ?? null,
    ward:           map.ward           ?? null,
    physician:      map.physician      ?? null,
    age:            map.age            ?? null,
    gender:         map.gender         ?? null,
    bloodType:      map.bloodType      ?? null,
    weight:         map.weight         ?? null,
    hospitalPhone:  map.hospitalPhone  ?? null,
    physicianPhone: map.physicianPhone ?? null,
    familyPhone:    map.familyPhone    ?? null,
  };
}

// ── Node management ───────────────────────────────────────────────────────────

export async function createDevice(token, name) {
  const res = await fetch(`${TB_URL}/api/device`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Authorization": `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Create device failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json(); // returns full device object, device.id.id is the UUID
}

export async function addDeviceRelation(token, fromId, toId) {
  const res = await fetch(`${TB_URL}/api/relation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Authorization": `Bearer ${token}` },
    body: JSON.stringify({
      from: { id: fromId, entityType: "DEVICE" },
      to:   { id: toId,   entityType: "DEVICE" },
      type: "Manages",
      typeGroup: "COMMON",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Add relation failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

export async function deleteDevice(token, deviceId) {
  const res = await fetch(`${TB_URL}/api/device/${deviceId}`, {
    method: "DELETE",
    headers: { "X-Authorization": `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Delete device failed (${res.status}): ${text.slice(0, 200)}`);
  }
}
