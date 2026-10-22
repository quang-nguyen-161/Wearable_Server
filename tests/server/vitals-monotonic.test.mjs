// tests/server/vitals-monotonic.test.mjs
// Unit tests for monotonic timestamp guard and vitals merging (Task 7)

import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeVitalsMonotonic } from '../../lib/mergeVitals.mjs';

test('T7-MONO-1: Monotonic timestamp advancement per metric', () => {
  const state = {
    spo2: { value: 98, ts: 2000 },
  };

  // 1. Newer sample arrives (ts: 3000 > 2000) -> Accepted
  const next1 = mergeVitalsMonotonic(state, { spo2: { value: 99, ts: 3000 } });
  assert.equal(next1.spo2.value, 99);
  assert.equal(next1.spo2.ts, 3000);

  // 2. Older sample arrives (ts: 1000 < 3000) -> Rejected
  const next2 = mergeVitalsMonotonic(next1, { spo2: { value: 95, ts: 1000 } });
  assert.equal(next2.spo2.value, 99);
  assert.equal(next2.spo2.ts, 3000);
  assert.strictEqual(next2, next1, 'Should return same object reference when unchanged');

  // 3. Same timestamp arrives (ts: 3000 == 3000) -> Accepted
  const next3 = mergeVitalsMonotonic(next1, { spo2: { value: 97, ts: 3000 } });
  assert.equal(next3.spo2.value, 97);
  assert.equal(next3.spo2.ts, 3000);
});

test('T7-MONO-2: Independent metric evaluation (no cross-metric blocking)', () => {
  const current = {
    ppgHeartRate: { value: 72, ts: 5000 },
    spo2:         { value: 98, ts: 2000 },
  };

  // Incoming: HR is older (4000 < 5000) but SpO2 is newer (3000 > 2000)
  const incoming = {
    ppgHeartRate: { value: 80, ts: 4000 },
    spo2:         { value: 99, ts: 3000 },
  };

  const merged = mergeVitalsMonotonic(current, incoming);
  assert.equal(merged.ppgHeartRate.value, 72, 'HR should not regress');
  assert.equal(merged.ppgHeartRate.ts, 5000);
  assert.equal(merged.spo2.value, 99, 'SpO2 should advance');
  assert.equal(merged.spo2.ts, 3000);
});

test('T7-MONO-3: Valid zero values are preserved (not dropped)', () => {
  const current = {
    temperature: { value: 36.5, ts: 1000 },
  };

  // Value 0 is valid (e.g. 0 bpm or 0 error code)
  const incoming = {
    temperature: { value: 0, ts: 2000 },
  };

  const merged = mergeVitalsMonotonic(current, incoming);
  assert.equal(merged.temperature.value, 0);
  assert.equal(merged.temperature.ts, 2000);
});

test('T7-MONO-4: Null, undefined, empty string, NaN, non-finite values safely rejected', () => {
  const current = {
    spo2: { value: 98, ts: 1000 },
  };

  const badSamples = [
    { spo2: { value: null, ts: 2000 } },
    { spo2: { value: undefined, ts: 2000 } },
    { spo2: { value: '', ts: 2000 } },
    { spo2: { value: 'not-a-number', ts: 2000 } },
    { spo2: { value: NaN, ts: 2000 } },
    { spo2: { value: Infinity, ts: 2000 } },
    { spo2: { value: 99, ts: null } },
    { spo2: { value: 99, ts: undefined } },
    { spo2: { value: 99, ts: -100 } },
    { spo2: { value: 99, ts: NaN } },
  ];

  for (const bad of badSamples) {
    const res = mergeVitalsMonotonic(current, bad);
    assert.equal(res.spo2.value, 98);
    assert.equal(res.spo2.ts, 1000);
    assert.strictEqual(res, current);
  }
});
