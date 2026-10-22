// tests/server/vitals-freshness.test.mjs
// Unit tests for pure vitals freshness and alert evaluation (Task 5)

import test from 'node:test';
import assert from 'node:assert/strict';

import { getFreshVitalValue, evaluateDeviceAlert } from '../../lib/vitalsFreshness.mjs';

test('T5-FRESH-1: Fresh vital value within 10s default threshold is returned', () => {
  const now = 20000;
  const entry = { value: 98, ts: 15000 }; // 5s old (< 10000ms staleMs)
  const val = getFreshVitalValue(entry, now, 1000);
  assert.equal(val, 98);
});

test('T5-FRESH-2: Stale vital value older than 10s default threshold returns null', () => {
  const now = 25000;
  const entry = { value: 98, ts: 14000 }; // 11s old (> 10000ms staleMs)
  const val = getFreshVitalValue(entry, now, 1000);
  assert.equal(val, null);
});

test('T5-FRESH-3: Vital interval scaling: max(interval * 3, 10000)', () => {
  const now = 30000;
  // If vitalInterval is 5000ms, staleMs = 15000ms
  const entry = { value: 72, ts: 17000 }; // 13s old (< 15000ms)
  assert.equal(getFreshVitalValue(entry, now, 5000), 72);

  const staleEntry = { value: 72, ts: 14000 }; // 16s old (> 15000ms)
  assert.equal(getFreshVitalValue(staleEntry, now, 5000), null);
});

test('T5-FRESH-4: Valid 0 values preserved and not treated as falsy/null', () => {
  const now = 10000;
  const entry = { value: 0, ts: 9000 };
  assert.equal(getFreshVitalValue(entry, now, 1000), 0);
});

test('T5-FRESH-5: Missing, null, undefined or NaN values safely return null', () => {
  const now = 10000;
  assert.equal(getFreshVitalValue(null, now), null);
  assert.equal(getFreshVitalValue(undefined, now), null);
  assert.equal(getFreshVitalValue({ value: null, ts: 9000 }, now), null);
  assert.equal(getFreshVitalValue({ value: undefined, ts: 9000 }, now), null);
  assert.equal(getFreshVitalValue({ value: 98, ts: NaN }, now), null);
});

test('T5-ALERT-1: Danger threshold triggers alert when fresh and online', () => {
  const now = 10000;
  const vitals = {
    ppgHeartRate: { value: 140, ts: 9500 }, // tachycardia (> 120)
    spo2: { value: 98, ts: 9500 },
    temperature: { value: 36.5, ts: 9500 },
  };
  const thresholds = {
    ppgHeartRate: { dangerMin: 40, dangerMax: 120 },
    spo2: { dangerMin: 90, dangerMax: 100 },
    temperature: { dangerMin: 35.0, dangerMax: 38.5 },
  };

  assert.equal(evaluateDeviceAlert(vitals, thresholds, true, now, 1000), true);
});

test('T5-ALERT-2: Offline device suppresses alerts even with abnormal values', () => {
  const now = 10000;
  const vitals = {
    ppgHeartRate: { value: 140, ts: 9500 },
  };
  const thresholds = {
    ppgHeartRate: { dangerMin: 40, dangerMax: 120 },
  };

  assert.equal(evaluateDeviceAlert(vitals, thresholds, false, now, 1000), false);
});

test('T5-ALERT-3: Stale abnormal metrics do not trigger false alerts', () => {
  const now = 30000;
  const vitals = {
    ppgHeartRate: { value: 150, ts: 10000 }, // 20s old (> 10s staleMs)
  };
  const thresholds = {
    ppgHeartRate: { dangerMin: 40, dangerMax: 120 },
  };

  assert.equal(evaluateDeviceAlert(vitals, thresholds, true, now, 1000), false);
});

test('T5-ALERT-4: Normal vitals produce no alert', () => {
  const now = 10000;
  const vitals = {
    ppgHeartRate: { value: 75, ts: 9500 },
    spo2: { value: 98, ts: 9500 },
    temperature: { value: 36.6, ts: 9500 },
  };
  const thresholds = {
    ppgHeartRate: { dangerMin: 40, dangerMax: 120 },
    spo2: { dangerMin: 90, dangerMax: 100 },
    temperature: { dangerMin: 35.0, dangerMax: 38.5 },
  };

  assert.equal(evaluateDeviceAlert(vitals, thresholds, true, now, 1000), false);
});
