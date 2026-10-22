// lib/server/attributeStore.mjs
// In-memory attribute store for device attributes (showEcg, deviceMode, thresholds)
// used in development mode and local testing when ThingsBoard Cloud is offline.

const attributesStore = new Map();

export function setDeviceAttributes(deviceId, scope, attrs) {
  const key = `${deviceId}:${scope}`;
  const existing = attributesStore.get(key) || {};
  attributesStore.set(key, { ...existing, ...attrs });
}

export function getDeviceAttributes(deviceId, scope) {
  const key = `${deviceId}:${scope}`;
  return attributesStore.get(key) || {};
}

export function getAllDeviceAttributes(deviceId) {
  const server = getDeviceAttributes(deviceId, 'SERVER_SCOPE');
  const shared = getDeviceAttributes(deviceId, 'SHARED_SCOPE');
  return { ...server, ...shared };
}
