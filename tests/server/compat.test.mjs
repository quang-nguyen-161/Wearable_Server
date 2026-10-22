// tests/server/compat.test.mjs
// Compatibility & Legacy Consumer Transition Tests (T15 & T15b)

import test from 'node:test';
import assert from 'node:assert/strict';

import { query, closePool } from '../../lib/server/db.mjs';
import { createAssignment } from '../../lib/server/assignments.mjs';
import { verifyJwt, createSignedJwt } from '../../lib/server/auth.mjs';

import devicesHandler from '../../pages/api/devices.js';
import patientHandler from '../../pages/api/patient.js';
import saveAttributesHandler from '../../pages/api/attributes/save.js';
import tokenHandler from '../../pages/api/auth/token.js';

const TENANT_ID = 'tenant-compat-01';
const WATCH_MAC = 'E4:5F:01:23:45:67';
const PATIENT_ID = 'p-compat-01';
const TEST_SECRET = 'wearable-test-jwt-secret-key-32chars!!';

test.before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = TEST_SECRET;

  await query(
    `INSERT INTO watches (tenant_id, watch_mac, tb_device_id, label) VALUES ($1, $2, $3, $4)`,
    [TENANT_ID, WATCH_MAC, 'tb-dev-compat-01', 'Smart Watch Compat']
  );
  await query(
    `INSERT INTO patients (tenant_id, patient_id, name, mrn) VALUES ($1, $2, $3, $4)`,
    [TENANT_ID, PATIENT_ID, 'Do Van E', 'MRN-E']
  );

  await createAssignment({
    tenantId: TENANT_ID,
    actor: 'dr-nurse',
    watchMac: WATCH_MAC,
    patientId: PATIENT_ID,
    validFrom: Date.now() - 60000,
  });
});

test.after(async () => {
  await closePool();
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

test('T15-COMPAT-1: pages/api/devices.js resolves active patient from DB without SERVER_SCOPE.connected', async () => {
  const req = { method: 'GET', query: {} };
  const res = createMockRes();
  await devicesHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.devices));
  const device = res.body.devices.find((d) => d.name.toUpperCase() === WATCH_MAC);
  assert.ok(device);
  assert.equal(device.patientName, 'Do Van E');
  assert.equal(device.patientId, PATIENT_ID);
});

test('T15-COMPAT-2: pages/api/patient.js resolves patient info from assignments', async () => {
  // Query for assigned watch without token (dev/test fallback)
  const reqAssigned = { method: 'GET', query: { deviceId: WATCH_MAC } };
  const resAssigned = createMockRes();
  await patientHandler(reqAssigned, resAssigned);

  assert.equal(resAssigned.statusCode, 200);
  assert.equal(resAssigned.body.info.patientName, 'Do Van E');
  assert.equal(resAssigned.body.info.patientId, PATIENT_ID);

  // Query with matching tenant token
  const validToken = createSignedJwt({ sub: 'doctor', tenantId: TENANT_ID }, TEST_SECRET);
  const reqWithToken = {
    method: 'GET',
    headers: { authorization: `Bearer ${validToken}` },
    query: { deviceId: WATCH_MAC },
  };
  const resWithToken = createMockRes();
  await patientHandler(reqWithToken, resWithToken);
  assert.equal(resWithToken.statusCode, 200);
  assert.equal(resWithToken.body.info.patientId, PATIENT_ID);

  // Cross-tenant access: token from different tenant
  const foreignToken = createSignedJwt({ sub: 'intruder', tenantId: 'tenant-other' }, TEST_SECRET);
  const reqForeign = {
    method: 'GET',
    headers: { authorization: `Bearer ${foreignToken}` },
    query: { deviceId: WATCH_MAC },
  };
  const resForeign = createMockRes();
  await patientHandler(reqForeign, resForeign);
  assert.equal(resForeign.statusCode, 200);
  assert.equal(resForeign.body.info, null);

  // Production unauthenticated enforcement: missing token in production -> 401
  const origEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const reqNoAuth = { method: 'GET', query: { deviceId: WATCH_MAC } };
    const resNoAuth = createMockRes();
    await patientHandler(reqNoAuth, resNoAuth);
    assert.equal(resNoAuth.statusCode, 401);
  } finally {
    process.env.NODE_ENV = origEnv;
  }

  // Query for unassigned watch
  const reqUnassigned = { method: 'GET', query: { deviceId: 'AA:BB:CC:DD:EE:FF' } };
  const resUnassigned = createMockRes();
  await patientHandler(reqUnassigned, resUnassigned);

  assert.equal(resUnassigned.statusCode, 200);
  assert.equal(resUnassigned.body.info, null);
});

test('T15B-GUARD-1: pages/api/attributes/save.js blocks writing connected and patient metadata', async () => {
  // Attempt to write "connected: true"
  const reqConn = {
    method: 'POST',
    body: {
      deviceId: 'tb-dev-01',
      attributes: { connected: true },
    },
  };
  const resConn = createMockRes();
  await saveAttributesHandler(reqConn, resConn);

  assert.equal(resConn.statusCode, 422);
  assert.equal(resConn.body.error.code, 'UNPROCESSABLE_ENTITY');
  assert.ok(/prohibited/i.test(resConn.body.error.message));

  // Attempt to write "patientName: John"
  const reqPat = {
    method: 'POST',
    body: {
      deviceId: 'tb-dev-01',
      attributes: { patientName: 'John Doe' },
    },
  };
  const resPat = createMockRes();
  await saveAttributesHandler(reqPat, resPat);

  assert.equal(resPat.statusCode, 422);
  assert.equal(resPat.body.error.code, 'UNPROCESSABLE_ENTITY');
});

test('T15B-GUARD-2: pages/api/attributes/save.js permits patientName in SHARED_SCOPE for downlink mirroring', async () => {
  const reqSharedPat = {
    method: 'POST',
    body: {
      deviceId: 'tb-dev-01',
      scope: 'SHARED_SCOPE',
      attributes: { patientName: 'John Doe' },
    },
  };
  const resSharedPat = createMockRes();
  await saveAttributesHandler(reqSharedPat, resSharedPat);

  assert.equal(resSharedPat.statusCode, 200);
  assert.equal(resSharedPat.body.ok, true);
});

test('T15B-TOKEN-1: pages/api/auth/token.js issues scoped CUSTOMER_USER token, not TENANT_ADMIN', async () => {
  const req = { method: 'GET' };
  const res = createMockRes();
  await tokenHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token);

  const claims = verifyJwt(res.body.token, TEST_SECRET);
  assert.equal(claims.authority, 'CUSTOMER_USER');
  assert.notEqual(claims.authority, 'TENANT_ADMIN');
});
