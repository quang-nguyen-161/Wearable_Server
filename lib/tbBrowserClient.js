// lib/tbBrowserClient.js
// Browser-side ThingsBoard API client.
// All calls use the JWT obtained on the login page — the browser handles
// Cloudflare challenges so these work even when server-side calls are blocked.

const TB_URL    = process.env.NEXT_PUBLIC_TB_BASE_URL?.replace(/\/$/, "");
export const GATEWAY_ID = process.env.NEXT_PUBLIC_TB_DEVICE_ID;

// In-memory tracker for Local Reception Time (Solution 1)
const s_browser_telemetry_tracker = new Map(); // devId -> { lastTs, localArrivalMs }

function isLocalDemoToken(jwt) {
  try {
    if (!jwt || typeof jwt !== "string") return false;
    const parts = jwt.split(".");
    if (parts.length !== 3) return false;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.sub === "browser-client" || payload.sub === "demo_doctor";
  } catch {
    return false;
  }
}

async function tbFetch(path, token, options = {}) {
  if (!TB_URL) return null;
  if (isLocalDemoToken(token)) return null;
  const res = await fetch(`${TB_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Authorization": `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    if (typeof window !== "undefined" && window.location.pathname !== "/login") {
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

// authOpts = { authority, customerId } from useTbAuth() — pass through so we
// never call the tenant-admin-only endpoint with a customer JWT (403).
export async function getDevices(token, authOpts = {}) {
  const { authority, customerId } = authOpts;
  const isCustomer = authority === "CUSTOMER_USER";

  let allDevices = [];

  // Relation-based lookup (gateway → node "Manages" relations). Works for
  // TENANT_ADMIN always; works for CUSTOMER_USER only if the gateway device
  // itself is assigned to that customer, so still worth trying first.
  try {
    const relations = (!GATEWAY_ID || GATEWAY_ID === "undefined") ? null : await tbFetch(
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
    if (isCustomer) {
      if (customerId) {
        try {
          const all = await tbFetch(`/api/customer/${customerId}/devices?pageSize=100&page=0`, token);
          allDevices = (all?.data || [])
            .filter(d => d.id.id !== GATEWAY_ID)
            .map(d => ({ id: d.id.id, name: d.name, label: d.label || null }));
        } catch (_) {}
      }
    } else {
      try {
        const all = await tbFetch(`/api/tenant/devices?pageSize=100&page=0`, token);
        allDevices = (all?.data || [])
          .filter(d => d.id.id !== GATEWAY_ID)
          .map(d => ({ id: d.id.id, name: d.name, label: d.label || null }));
      } catch (_) {}
    }
  }

  if (allDevices.length === 0) {
    try {
      const fallbackRes = await fetch('/api/devices');
      if (fallbackRes.ok) {
        const fallbackData = await fallbackRes.json();
        if (Array.isArray(fallbackData.devices) && fallbackData.devices.length > 0) {
          return fallbackData.devices.map(d => ({
            ...d,
            displayName: d.displayName || d.label || d.name,
            showEcg: d.showEcg !== undefined ? Boolean(d.showEcg) : true,
            deviceMode: d.deviceMode !== undefined ? Number(d.deviceMode) || 0 : 0,
          }));
        }
      }
    } catch (_) {}
  }

  // Filter to wearable node devices only (original code filter)
  const isWearableNode = (d) => {
    const name = (d.name || "").toLowerCase().trim();
    if (name.includes("gateway")) return false;
    if (name === "00:00:00:00:00:00" || name === "ff:ff:ff:ff:ff:ff") return false;
    const devId = (typeof d.id === 'object' && d.id !== null) ? d.id.id : d.id;
    if (GATEWAY_ID && devId === GATEWAY_ID) return false;
    return name.includes("node") || /^([0-9a-f]{2}[:-]){5}([0-9a-f]{2})$/i.test(name);
  };

  const nodeDevices = allDevices.filter(isWearableNode);

  const withStatus = await Promise.all(
    nodeDevices.map(async (device) => {
      try {
        const attrs = await tbFetch(
          `/api/plugins/telemetry/DEVICE/${device.id}/values/attributes?keys=connected,bleConnected,patientName,showEcg,deviceMode`,
          token
        );
        const map = {};
        for (const item of attrs || []) map[item.key] = item.value;

        let lastActivityTs = 0;
        try {
          const telemetry = await tbFetch(
            `/api/plugins/telemetry/DEVICE/${device.id}/values/timeseries?keys=spo2,ecgHeartRate,ppgHeartRate,temperature,ecg_batch&limit=1`,
            token
          );
          for (const key of ["spo2", "ecgHeartRate", "ppgHeartRate", "temperature", "ecg_batch"]) {
            const series = telemetry?.[key];
            if (Array.isArray(series) && series.length > 0 && series[0].ts) {
              const val = series[0].value;
              if (val !== null && val !== undefined && val !== "") {
                lastActivityTs = Math.max(lastActivityTs, Number(series[0].ts));
              }
            }
          }
        } catch (_) {}

        // Solution 1: Local Reception Time Tracking
        const now = Date.now();
        const FRESHNESS_WINDOW_MS = 5000; // 5 seconds (Architecture v2 standard)
        const INITIAL_SKEW_TOLERANCE_MS = 20000; // 20s tolerance for initial load clock skew between PC and Gateway SNTP
        const ageMs = lastActivityTs > 0 ? Math.abs(now - lastActivityTs) : Infinity;

        let localRecord = s_browser_telemetry_tracker.get(device.id);
        if (lastActivityTs > 0) {
          if (!localRecord) {
            // First time seeing this device on page load:
            // If telemetry was received within 20s (accounting for PC vs SNTP clock skew), treat as fresh arrival
            if (ageMs < INITIAL_SKEW_TOLERANCE_MS) {
              localRecord = { lastTs: lastActivityTs, localArrivalMs: now };
            } else {
              localRecord = { lastTs: lastActivityTs, localArrivalMs: 0 };
            }
            s_browser_telemetry_tracker.set(device.id, localRecord);
          } else if (lastActivityTs > localRecord.lastTs) {
            // Telemetry has advanced in real-time while page is open
            localRecord = { lastTs: lastActivityTs, localArrivalMs: now };
            s_browser_telemetry_tracker.set(device.id, localRecord);
          }
        }

        const localElapsedMs = (localRecord && localRecord.localArrivalMs > 0) ? (now - localRecord.localArrivalMs) : Infinity;
        const freshOnline = (lastActivityTs > 0 && ageMs < FRESHNESS_WINDOW_MS) || (localElapsedMs < FRESHNESS_WINDOW_MS);

        // Solution 3: Immediate Disconnect Latch via Gateway Attribute
        let isOnline = false;
        if (map.bleConnected === false || map.bleConnected === "false" || map.connected === false || map.connected === "false") {
          isOnline = false;
          s_browser_telemetry_tracker.delete(device.id);
        } else {
          isOnline = freshOnline;
        }

        let showEcg = true;
        if (map.showEcg !== undefined && map.showEcg !== null) {
          showEcg = (map.showEcg === true || map.showEcg === "true" || map.showEcg === 1 || map.showEcg === "1");
        }
        let deviceMode = 0;
        if (map.deviceMode !== undefined && map.deviceMode !== null) {
          deviceMode = Number(map.deviceMode) || 0;
        }

        return {
          ...device,
          patientName:        map.patientName || null,
          displayName:        map.patientName || device.label || device.name,
          online:             isOnline,
          showEcg,
          deviceMode,
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
  try {
    const [serverRaw, sharedRaw] = await Promise.all([
      tbFetch(`/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes/SERVER_SCOPE`, token),
      tbFetch(`/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes/SHARED_SCOPE`, token),
    ]);
    const flatten = arr =>
      (arr || []).reduce((acc, item) => ({ ...acc, [item.key]: item.value }), {});
    return { ...flatten(serverRaw), ...flatten(sharedRaw) };
  } catch (_) {
    try {
      const res = await fetch(`/api/attributes/load?deviceId=${encodeURIComponent(deviceId)}`);
      if (res.ok) {
        const json = await res.json();
        return json.attributes || {};
      }
    } catch (__) {}
    return {};
  }
}

export async function saveDeviceAttributes(token, deviceId, scope, attributes) {
  // First attempt server-side proxy
  try {
    const res = await fetch("/api/attributes/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, scope, attributes }),
    });
    if (res.ok) return;
  } catch (_) {}

  // Fallback to direct TB call if TB_URL configured
  if (TB_URL && !TB_URL.includes("your-tb-host")) {
    try {
      const res = await fetch(
        `${TB_URL}/api/plugins/telemetry/DEVICE/${deviceId}/attributes/${scope}`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/json", "X-Authorization": `Bearer ${token}` },
          body:    JSON.stringify(attributes),
        }
      );
      if (res.ok) return;
    } catch (_) {}
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
  try {
    const res = await fetch(`/api/patient?deviceId=${encodeURIComponent(deviceId)}`);
    if (res.ok) {
      const data = await res.json();
      if (data?.info) return data.info;
    }
  } catch (_) {}

  if (TB_URL && !TB_URL.includes("your-tb-host")) {
    try {
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
    } catch (_) {}
  }
  return null;
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
  return res.json();
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

// ── Customer / user management (used by Assign User modal) ──────────────────
// Model: each "client" login gets its own Customer entity, so the customer
// devices endpoint (/api/customer/{customerId}/devices) naturally scopes
// visibility to exactly the nodes assigned below — no extra ACL needed.

export async function createCustomer(token, title) {
  const res = await fetch(`${TB_URL}/api/customer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Authorization": `Bearer ${token}` },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Create customer failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json(); // customer.id.id is the UUID
}

export async function createCustomerUser(token, customerId, email, firstName = "", lastName = "") {
  const res = await fetch(`${TB_URL}/api/user?sendActivationMail=false`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Authorization": `Bearer ${token}` },
    body: JSON.stringify({
      email,
      firstName,
      lastName,
      authority: "CUSTOMER_USER",
      customerId: { id: customerId, entityType: "CUSTOMER" },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Create user failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json(); // user.id.id is the UUID
}

export async function getUserActivationLink(token, userId) {
  const res = await fetch(`${TB_URL}/api/user/${userId}/activationLink`, {
    headers: { "X-Authorization": `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Get activation link failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const raw = await res.text();
  // TB may return a bare string or a JSON-quoted string depending on Accept header
  try { return JSON.parse(raw); } catch { return raw; }
}

// Public endpoint (new user has no JWT yet) — sets the password directly
// using the token embedded in the activation link, no email step needed.
export async function activateUser(activateToken, password) {
  const res = await fetch(`${TB_URL}/api/noauth/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ activateToken, password }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Set password failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function assignDeviceToCustomer(token, customerId, deviceId) {
  const res = await fetch(`${TB_URL}/api/customer/${customerId}/device/${deviceId}`, {
    method: "POST",
    headers: { "X-Authorization": `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Assign device failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Customer listing / editing (used by AssignModal's "Edit existing" tab) ──
// Customer.title is always set to the client's email at creation time (see
// createCustomer(token, email) at the call site), so title doubles as the
// display name — no separate user lookup needed to show "who this is".

export async function getCustomers(token, textSearch = "") {
  const qs = new URLSearchParams({ pageSize: "100", page: "0", sortProperty: "title", sortOrder: "ASC" });
  if (textSearch) qs.set("textSearch", textSearch);
  const data = await tbFetch(`/api/customers?${qs.toString()}`, token);
  return (data?.data || []).map(c => ({ id: c.id.id, title: c.title }));
}

// Devices currently assigned to a given customer (just the ids — used to
// pre-check the node list when editing an existing client).
export async function getCustomerDeviceIds(token, customerId) {
  const data = await tbFetch(`/api/customer/${customerId}/devices?pageSize=100&page=0`, token);
  return (data?.data || []).map(d => d.id.id);
}

export async function unassignDeviceFromCustomer(token, deviceId) {
  const res = await fetch(`${TB_URL}/api/customer/device/${deviceId}`, {
    method: "DELETE",
    headers: { "X-Authorization": `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Unassign device failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Customer permissions ──────────────────────────────────────────────────
// Feature-level permissions (edit thresholds / intervals / modes / sensors)
// live as SERVER_SCOPE attributes on the Customer entity itself, so every
// CUSTOMER_USER under that client shares the same access automatically.

export async function getCustomerAttributes(token, customerId) {
  const attrs = await tbFetch(
    `/api/plugins/telemetry/CUSTOMER/${customerId}/values/attributes/SERVER_SCOPE`,
    token
  );
  const map = {};
  for (const item of attrs || []) map[item.key] = item.value;
  return map;
}

export async function saveCustomerAttributes(token, customerId, attributes) {
  const res = await fetch(
    `${TB_URL}/api/plugins/telemetry/CUSTOMER/${customerId}/attributes/SERVER_SCOPE`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json", "X-Authorization": `Bearer ${token}` },
      body:    JSON.stringify(attributes),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Save customer attributes failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

// Deletes the Customer entity outright. ThingsBoard cascades this: any
// CUSTOMER_USER accounts under it are deleted too, and its devices become
// unassigned (not deleted) automatically.
export async function deleteCustomer(token, customerId) {
  const res = await fetch(`${TB_URL}/api/customer/${customerId}`, {
    method: "DELETE",
    headers: { "X-Authorization": `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Delete account failed (${res.status}): ${text.slice(0, 200)}`);
  }
}