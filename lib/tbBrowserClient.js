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
    if (isCustomer) {
      if (!customerId) {
        // No customerId on the JWT — nothing this user can see. Don't call
        // /api/tenant/devices, it will always 403 for CUSTOMER_USER.
        return [];
      }
      const all = await tbFetch(`/api/customer/${customerId}/devices?pageSize=100&page=0`, token);
      allDevices = (all?.data || [])
        .filter(d => d.id.id !== GATEWAY_ID)
        .map(d => ({ id: d.id.id, name: d.name, label: d.label || null }));
    } else {
      const all = await tbFetch(`/api/tenant/devices?pageSize=100&page=0`, token);
      allDevices = (all?.data || [])
        .filter(d => d.id.id !== GATEWAY_ID)
        .map(d => ({ id: d.id.id, name: d.name, label: d.label || null }));
    }
  }

  const nodeDevices = allDevices.filter(d => d.name.toLowerCase().includes("node"));

  const withStatus = await Promise.all(
    nodeDevices.map(async (device) => {
      try {
        const attrs = await tbFetch(
          `/api/plugins/telemetry/DEVICE/${device.id}/values/attributes/SERVER_SCOPE?keys=connected,patientName`,
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