// lib/permissions.js
// Feature-level permissions for CUSTOMER_USER accounts, controlling which
// sections of the Settings page a client can edit. Stored as SERVER_SCOPE
// attributes on the Customer entity (see getCustomerAttributes /
// saveCustomerAttributes in tbBrowserClient.js), prefixed with "perm_" so
// they don't collide with other customer attributes.

export const PERMISSION_DEFS = [
  { key: "editThresholds", attr: "perm_editThresholds", label: "Edit vital thresholds",
    hint: "Normal / warning / dangerous ranges for HR, SpO₂, temperature." },
  { key: "editIntervals",  attr: "perm_editIntervals",  label: "Edit vital interval",
    hint: "How often the node reports vitals to the gateway." },
  { key: "editModes",      attr: "perm_editModes",      label: "Edit operating mode",
    hint: "Continuous / Periodic mode, wake interval, capture window." },
  { key: "editSensors",    attr: "perm_editSensors",    label: "Edit sensor settings",
    hint: "PPG and ECG sample frequency, packet interval, HR source." },
];

// TENANT_ADMIN (dashboard operator) always has full access — permissions
// only ever gate what a CUSTOMER_USER (client) can edit.
export const DEFAULT_PERMISSIONS = PERMISSION_DEFS.reduce(
  (acc, p) => ({ ...acc, [p.key]: true }),
  {}
);

// Parse raw customer attributes (from getCustomerAttributes) into a clean
// { editThresholds: bool, ... } object. Missing attrs default to true so
// existing clients aren't suddenly locked out when this feature ships.
export function parsePermissions(attrs = {}) {
  const perms = {};
  for (const { key, attr } of PERMISSION_DEFS) {
    const raw = attrs[attr];
    perms[key] = raw === undefined || raw === null ? true : raw === true || raw === "true";
  }
  return perms;
}

// Build the SERVER_SCOPE attribute payload from a { editThresholds: bool, ... } object.
export function toAttributePayload(perms) {
  const payload = {};
  for (const { key, attr } of PERMISSION_DEFS) {
    payload[attr] = !!perms[key];
  }
  return payload;
}