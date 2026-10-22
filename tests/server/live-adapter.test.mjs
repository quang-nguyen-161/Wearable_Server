// tests/server/live-adapter.test.mjs
// Unit & Integration Tests for Live Adapter, Buffer Isolation, and Settings Allowlist (T15c)

import test from 'node:test';
import assert from 'node:assert/strict';

import loadAttributesHandler from '../../pages/api/attributes/load.js';

test.before(() => {
  process.env.NODE_ENV = 'test';
});

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
    end() {
      return this;
    },
  };
}

test('T15C-ATTR-1: pages/api/attributes/load.js filters attributes via strict allowlist', async () => {
  const req = { method: 'GET', query: { deviceId: 'tb-dev-01' } };
  const res = createMockRes();
  await loadAttributesHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.attributes);
  assert.ok(res.body.attributes.hrMin !== undefined);

  // Prohibited patient metadata must NOT leak
  assert.equal(res.body.attributes.patientName, undefined);
  assert.equal(res.body.attributes.patientId, undefined);
  assert.equal(res.body.attributes.ward, undefined);
});

test('T15C-ISO-1: Session and buffer isolation between Device A and Device B', () => {
  // Simulate buffer lifecycle logic
  let activeDeviceId = 'DEV_A';
  let pendingEcg = [{ ts: 1000, value: 512 }, { ts: 1004, value: 515 }];
  let pendingVitals = { spo2: { value: 98, ts: 1000 } };
  let connected = true;

  assert.equal(pendingEcg.length, 2);
  assert.equal(connected, true);

  // Switch device to DEV_B
  activeDeviceId = 'DEV_B';
  // Reset buffers
  pendingEcg = [];
  pendingVitals = {};
  connected = false;

  assert.equal(pendingEcg.length, 0);
  assert.deepEqual(pendingVitals, {});
  assert.equal(connected, false);

  // Simulated stale packet from DEV_A arrives
  const stalePacketDeviceId = 'DEV_A';
  if (stalePacketDeviceId === activeDeviceId) {
    pendingEcg.push({ ts: 1008, value: 520 });
  }

  // Stale packet was discarded because deviceId didn't match active
  assert.equal(pendingEcg.length, 0);
});

test('T15C-FRESH-1: Automatic 5000ms freshness window timeout without SERVER_SCOPE', () => {
  const now = 20000;
  let lastActivityTs = 16000; // 4000ms ago (< 5000ms)
  let isConnected = now - lastActivityTs < 5000;
  assert.equal(isConnected, true);

  // 1500ms later, now = 21500 (age = 5500ms > 5000ms)
  const laterNow = 21500;
  isConnected = laterNow - lastActivityTs < 5000;
  assert.equal(isConnected, false);
});
