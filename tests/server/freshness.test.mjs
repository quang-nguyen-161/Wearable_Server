// tests/server/freshness.test.mjs
// Unit & Integration Tests for Stream Freshness and Aggregate Health (TDD)

import test from 'node:test';
import assert from 'node:assert/strict';

import { query, closePool } from '../../lib/server/db.mjs';
import {
  evaluateStreamFreshness,
  computeAggregateStatus,
  getWatchStatus,
  FRESHNESS_WINDOW_MS,
} from '../../lib/server/freshness.mjs';
import { setMockTelemetry, clearMockTelemetry } from '../../lib/server/tbAdapter.mjs';
import { createSignedJwt } from '../../lib/server/auth.mjs';
import watchesHandler from '../../pages/api/v1/watches/index.js';

const TENANT_ID = 'tenant-fresh-01';
const WATCH_MAC = 'E4:5F:01:23:45:67';
const TEST_SECRET = 'wearable-test-jwt-secret-key-32chars!!';

test.before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = TEST_SECRET;
  clearMockTelemetry();

  await query(
    `INSERT INTO watches (tenant_id, watch_mac, tb_device_id, label) VALUES ($1, $2, $3, $4)`,
    [TENANT_ID, WATCH_MAC, 'tb-dev-fresh-01', 'Smart Watch Fresh']
  );
});

test.after(async () => {
  await closePool();
});

test('T14-FRESH-1: Exact 5000ms boundary: 4999ms is LIVE, 5000ms and 5001ms are STALE', () => {
  const serverNow = 10000;

  // Case A: Age = 4999ms (< 5000ms) -> LIVE
  const sampleLive = { ts: 5001, timeQuality: 'SYNCED', sessionId: 1 };
  const evalLive = evaluateStreamFreshness(sampleLive, serverNow);
  assert.equal(evalLive.status, 'LIVE');
  assert.equal(evalLive.ageMs, 4999);
  assert.equal(evalLive.reason, 'FRESH');

  // Case B: Age = 5000ms (== 5000ms) -> STALE
  const sampleBoundary = { ts: 5000, timeQuality: 'SYNCED', sessionId: 1 };
  const evalBoundary = evaluateStreamFreshness(sampleBoundary, serverNow);
  assert.equal(evalBoundary.status, 'STALE');
  assert.equal(evalBoundary.ageMs, 5000);
  assert.equal(evalBoundary.reason, 'FRESHNESS_EXPIRED');

  // Case C: Age = 5001ms (> 5000ms) -> STALE
  const sampleStale = { ts: 4999, timeQuality: 'SYNCED', sessionId: 1 };
  const evalStale = evaluateStreamFreshness(sampleStale, serverNow);
  assert.equal(evalStale.status, 'STALE');
  assert.equal(evalStale.ageMs, 5001);
  assert.equal(evalStale.reason, 'FRESHNESS_EXPIRED');
});

test('T14-FRESH-2: Unsynchronized time and future timestamps evaluated as UNKNOWN', () => {
  const serverNow = 10000;

  // Future timestamp
  const futureSample = { ts: 10500, timeQuality: 'SYNCED', sessionId: 1 };
  const evalFuture = evaluateStreamFreshness(futureSample, serverNow);
  assert.equal(evalFuture.status, 'UNKNOWN');
  assert.equal(evalFuture.reason, 'FUTURE_TIMESTAMP');

  // Unsynchronized time
  const unsyncedSample = { ts: 9800, timeQuality: 'UNKNOWN', sessionId: 1 };
  const evalUnsynced = evaluateStreamFreshness(unsyncedSample, serverNow);
  assert.equal(evalUnsynced.status, 'UNKNOWN');
  assert.equal(evalUnsynced.reason, 'UNSYNCHRONIZED_TIME');

  // No data
  const evalNoData = evaluateStreamFreshness(null, serverNow);
  assert.equal(evalNoData.status, 'UNKNOWN');
  assert.equal(evalNoData.reason, 'NO_DATA');
});

test('T14-FRESH-3: Revocation in same session marks stream STALE; old session does not affect new', () => {
  const serverNow = 10000;
  const recentSample = { ts: 9500, timeQuality: 'SYNCED', sessionId: 42 };

  // Revocation in same session (sessionId 42, revoked at 9800 after sample)
  const evalRevoked = evaluateStreamFreshness(recentSample, serverNow, {
    sessionId: 42,
    revokedAt: 9800,
  });
  assert.equal(evalRevoked.status, 'STALE');
  assert.equal(evalRevoked.reason, 'SESSION_REVOKED');

  // Revocation in different session (sessionId 41) does NOT revoke new session
  const evalDifferentSession = evaluateStreamFreshness(recentSample, serverNow, {
    sessionId: 41,
    revokedAt: 9800,
  });
  assert.equal(evalDifferentSession.status, 'LIVE');
});

test('T14-FRESH-4: Aggregate status logic: LIVE, PARTIAL, STALE, and UNKNOWN', () => {
  // Both LIVE -> LIVE
  assert.equal(
    computeAggregateStatus({
      ecg: { status: 'LIVE' },
      spo2: { status: 'LIVE' },
    }),
    'LIVE'
  );

  // ECG LIVE, SpO2 STALE -> PARTIAL
  assert.equal(
    computeAggregateStatus({
      ecg: { status: 'LIVE' },
      spo2: { status: 'STALE' },
    }),
    'PARTIAL'
  );

  // ECG STALE, SpO2 LIVE -> PARTIAL
  assert.equal(
    computeAggregateStatus({
      ecg: { status: 'STALE' },
      spo2: { status: 'LIVE' },
    }),
    'PARTIAL'
  );

  // Both STALE -> STALE
  assert.equal(
    computeAggregateStatus({
      ecg: { status: 'STALE' },
      spo2: { status: 'STALE' },
    }),
    'STALE'
  );

  // Both UNKNOWN -> UNKNOWN
  assert.equal(
    computeAggregateStatus({
      ecg: { status: 'UNKNOWN' },
      spo2: { status: 'UNKNOWN' },
    }),
    'UNKNOWN'
  );
});

test('T14-API-1: Next.js API route GET /api/v1/watches returns stream freshness', async () => {
  const serverNow = 20000;
  // Mock fresh SpO2 (age = 1000ms) and fresh ECG (age = 1500ms)
  setMockTelemetry('tb-dev-fresh-01', 'spo2', [
    { ts: 19000, value: 98, timeQuality: 'SYNCED', sessionId: 1 },
  ]);
  setMockTelemetry('tb-dev-fresh-01', 'ecg_batch', [
    { ts: 18500, value: '[500, 510]', timeQuality: 'SYNCED', sessionId: 1 },
  ]);

  const token = createSignedJwt(
    { sub: 'dr-nurse', tenantId: TENANT_ID, scopes: ['TENANT_ADMIN'] },
    TEST_SECRET
  );

  function createMockRes() {
    return {
      statusCode: 200,
      headers: {},
      body: null,
      status(s) {
        this.statusCode = s;
        return this;
      },
      setHeader(k, v) {
        this.headers[k] = v;
      },
      json(d) {
        this.body = d;
        return this;
      },
    };
  }

  const req = {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
    query: {},
  };
  const res = createMockRes();
  await watchesHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.data));
  const watch = res.body.data.find((w) => w.watchMac === WATCH_MAC);
  assert.ok(watch);
  assert.equal(watch.watchMac, WATCH_MAC);
  assert.ok(watch.streams.spo2);
  assert.ok(watch.streams.ecg);
  assert.ok(watch.aggregateStatus);
});

test('T14-FRESH-5: getWatchStatus propagates timeQuality from telemetry series', async () => {
  const serverNow = 50000;
  // SpO2 sample without inline timeQuality, but timeQuality series is SYNCED
  setMockTelemetry('tb-dev-fresh-01', 'spo2', [
    { ts: 48000, value: 99, sessionId: 2 },
  ]);
  setMockTelemetry('tb-dev-fresh-01', 'timeQuality', [
    { ts: 48000, value: 'SYNCED' },
  ]);

  const status = await getWatchStatus(TENANT_ID, WATCH_MAC, serverNow);
  assert.equal(status.streams.spo2.status, 'LIVE');
  assert.equal(status.streams.spo2.timeQuality, 'SYNCED');
});

test('T14-DISC-1: Explicit bleConnected: false forces stream status to STALE immediately', () => {
  const serverNow = 10000;
  // Fresh telemetry: age = 500ms (< 5000ms window)
  const freshSample = { ts: 9500, timeQuality: 'SYNCED', sessionId: 1 };

  // When bleConnected is true or unspecified -> LIVE
  const normalEval = evaluateStreamFreshness(freshSample, serverNow);
  assert.equal(normalEval.status, 'LIVE');

  // When bleConnected is false (Solution 3 Gateway Disconnect) -> STALE immediately!
  const discEval = evaluateStreamFreshness(freshSample, serverNow, null, { bleConnected: false });
  assert.equal(discEval.status, 'STALE');
  assert.equal(discEval.reason, 'BLE_DISCONNECTED');
});

test('T14-SKEW-1: Local reception tracking marks stream LIVE despite severe PC clock skew', () => {
  const serverNow = 25000; // Simulated PC clock 15 seconds ahead of Gateway SNTP
  const sampleFromSntp = { ts: 10000, timeQuality: 'SYNCED', sessionId: 1 }; // Age according to PC: 15000ms

  // Without local reception tracking: ageMs = 15000ms > 5000ms -> STALE
  const staleEval = evaluateStreamFreshness(sampleFromSntp, serverNow);
  assert.equal(staleEval.status, 'STALE');

  // With Solution 1 Local Reception Tracking: local packet arrival was 800ms ago (< 5000ms)
  const localArrivalMs = 24200; // Received locally 800ms ago on PC clock
  const skewEval = evaluateStreamFreshness(sampleFromSntp, serverNow, null, {
    localArrivalMs,
    freshnessWindowMs: 5000
  });
  assert.equal(skewEval.status, 'LIVE');
  assert.equal(skewEval.reason, 'LOCAL_RECEPTION_FRESH');
});
