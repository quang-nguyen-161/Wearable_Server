// lib/vitalsFreshness.mjs
// Pure vitals freshness and alert evaluation helpers (Architecture v2)

/**
 * Get vital value if fresh, or null if stale/missing.
 * Timeout is max(vitalInterval * 3, 10000) ms.
 *
 * @param {object} entry { value, ts }
 * @param {number} now Current clock timestamp in ms
 * @param {number} vitalInterval Expected interval in ms between updates
 * @returns {number|null} Fresh value or null
 */
export function getFreshVitalValue(entry, now = Date.now(), vitalInterval = 1000) {
  if (!entry || entry.value === null || entry.value === undefined) {
    return null;
  }
  const intervalMs = Number(vitalInterval) || 1000;
  const staleMs = Math.max(intervalMs * 3, 10000);
  const ts = Number(entry.ts);
  if (!Number.isFinite(ts) || (now - ts) > staleMs) {
    return null;
  }
  return entry.value;
}

/**
 * Evaluate if live vitals trigger a danger alert for a device.
 * Only fresh metrics and online devices can trigger alerts.
 *
 * @param {object} vitals Map of metric entries: { ppgHeartRate, ecgHeartRate, spo2, temperature }
 * @param {object} thresholds Danger min/max thresholds
 * @param {boolean} isOnline Whether the device is currently online
 * @param {number} now Current timestamp in ms
 * @param {number} vitalInterval Expected update interval in ms
 * @returns {boolean} True if in alert condition
 */
export function evaluateDeviceAlert(
  vitals,
  thresholds,
  isOnline = true,
  now = Date.now(),
  vitalInterval = 1000
) {
  if (!vitals || isOnline === false || !thresholds) {
    return false;
  }

  const ppgHr = getFreshVitalValue(vitals.ppgHeartRate, now, vitalInterval);
  const ecgHr = getFreshVitalValue(vitals.ecgHeartRate, now, vitalInterval);
  const spo2  = getFreshVitalValue(vitals.spo2, now, vitalInterval);
  const temp  = getFreshVitalValue(vitals.temperature, now, vitalInterval);

  const thPpg = thresholds.ppgHeartRate || thresholds.heartRate || {};
  const thEcg = thresholds.ecgHeartRate || thresholds.heartRate || {};
  const thSpo2 = thresholds.spo2 || {};
  const thTemp = thresholds.temperature || {};

  return Boolean(
    (ppgHr != null && (ppgHr < thPpg.dangerMin || ppgHr > thPpg.dangerMax)) ||
    (ecgHr != null && (ecgHr < thEcg.dangerMin || ecgHr > thEcg.dangerMax)) ||
    (spo2  != null && (spo2  < thSpo2.dangerMin || spo2  > thSpo2.dangerMax)) ||
    (temp  != null && (temp  < thTemp.dangerMin || temp  > thTemp.dangerMax))
  );
}
