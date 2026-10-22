// lib/mergeVitals.mjs
// Monotonic Vitals Merging Engine for Wearable Health Monitor

/**
 * Merges incoming vitals into target vitals object while strictly preserving
 * monotonic advancement of timestamps per metric.
 * 
 * Rules:
 * 1. Each metric is evaluated independently (no global timestamp rejection).
 * 2. Only accepts valid finite numeric values and finite positive timestamps.
 * 3. Incoming sample is accepted if and only if:
 *    !target[key] || incoming.ts >= target[key].ts
 * 4. If incoming.ts < target[key].ts, the stale sample is rejected.
 * 5. Returns a new object if any metric changed, or the original object if no changes.
 * 
 * @param {Object} current - Existing vitals map { [key]: { value: number, ts: number } }
 * @param {Object} incoming - Incoming vitals map { [key]: { value: number, ts: number } }
 * @returns {Object} Updated vitals map
 */
export function mergeVitalsMonotonic(current = {}, incoming = {}) {
  if (!incoming || typeof incoming !== 'object') return current;

  let hasChanges = false;
  const next = { ...current };

  for (const [key, sample] of Object.entries(incoming)) {
    if (!sample || typeof sample !== 'object') continue;
    const { value, ts } = sample;

    // Validate finite number and timestamp
    const numVal = typeof value === 'number' ? value : parseFloat(value);
    const tsNum = typeof ts === 'number' ? ts : Number(ts);

    if (isNaN(numVal) || !Number.isFinite(numVal) || isNaN(tsNum) || !Number.isFinite(tsNum) || tsNum <= 0) {
      continue;
    }

    const existing = current[key];
    if (!existing || tsNum >= existing.ts) {
      next[key] = { value: numVal, ts: tsNum };
      hasChanges = true;
    }
  }

  return hasChanges ? next : current;
}
