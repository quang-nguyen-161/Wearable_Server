// tests/server/assignments.test.mjs
// Unit & Integration Tests for Architecture v2 Assignment Service & API (TDD)

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { query, closePool } from '../../lib/server/db.mjs';
import {
  createAssignment,
  closeAssignment,
  listAssignments,
  getAssignmentById,
} from '../../lib/server/assignments.mjs';
import { createSignedJwt } from '../../lib/server/auth.mjs';
import { AppError } from '../../lib/server/errors.mjs';
import indexHandler from '../../pages/api/v1/assignments/index.js';
import detailHandler from '../../pages/api/v1/assignments/[assignmentId].js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixtures = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/assignments.json'), 'utf8')
).fixtures;

const TEST_SECRET = 'wearable-test-jwt-secret-key-32chars!!';

test.before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = TEST_SECRET;

  // Populate watches and patients
  await query(
    `INSERT INTO watches (tenant_id, watch_mac, tb_device_id, label) VALUES ($1, $2, $3, $4)`,
    [fixtures.tenantId, fixtures.watchMac, 'tb-dev-01', 'Smart Watch 1']
  );
  await query(
    `INSERT INTO patients (tenant_id, patient_id, name, mrn) VALUES ($1, $2, $3, $4)`,
    [fixtures.tenantId, fixtures.patient1.patientId, fixtures.patient1.name, fixtures.patient1.mrn]
  );
  await query(
    `INSERT INTO patients (tenant_id, patient_id, name, mrn) VALUES ($1, $2, $3, $4)`,
    [fixtures.tenantId, fixtures.patient2.patientId, fixtures.patient2.name, fixtures.patient2.mrn]
  );
});

test.after(async () => {
  await closePool();
});

let initialAssignmentId = null;

test('T12-AS-1: Create initial open assignment [t0, null)', async () => {
  const { assignment, isReplay } = await createAssignment({
    tenantId: fixtures.tenantId,
    actor: 'dr-john',
    watchMac: fixtures.createRequest.watchMac,
    patientId: fixtures.createRequest.patientId,
    validFrom: fixtures.createRequest.validFrom,
  });

  assert.equal(isReplay, false);
  assert.ok(assignment.assignment_id.startsWith('as-'));
  assert.equal(assignment.watch_mac, fixtures.watchMac);
  assert.equal(assignment.patient_id, fixtures.patient1.patientId);
  assert.equal(assignment.valid_from, fixtures.createRequest.validFrom);
  assert.equal(assignment.valid_to, null);
  assert.equal(assignment.version, 1);

  initialAssignmentId = assignment.assignment_id;
});

test('T12-AS-2: Overlapping creation without replacesAssignmentId rejected with 409 CONFLICT', async () => {
  await assert.rejects(
    async () => {
      await createAssignment({
        tenantId: fixtures.tenantId,
        actor: 'dr-jane',
        watchMac: fixtures.watchMac,
        patientId: fixtures.patient2.patientId,
        validFrom: fixtures.createRequest.validFrom + 10000,
      });
    },
    (err) => err instanceof AppError && err.status === 409 && err.code === 'CONFLICT'
  );
});

test('T12-AS-3: Stale expectedVersion on reassignment rejected with 409 CONFLICT', async () => {
  await assert.rejects(
    async () => {
      await createAssignment({
        tenantId: fixtures.tenantId,
        actor: 'dr-jane',
        watchMac: fixtures.watchMac,
        patientId: fixtures.patient2.patientId,
        validFrom: fixtures.reassignRequest.validFrom,
        replacesAssignmentId: initialAssignmentId,
        expectedVersion: 99, // stale version
      });
    },
    (err) => err instanceof AppError && err.status === 409 && /optimistic concurrency/i.test(err.message)
  );
});

let reassignedAssignmentId = null;

test('T12-AS-4: Atomic reassignment closes A at t and opens B at t', async () => {
  const switchTime = fixtures.reassignRequest.validFrom; // 1700000060000

  const { assignment, isReplay } = await createAssignment({
    tenantId: fixtures.tenantId,
    actor: 'dr-jane',
    watchMac: fixtures.watchMac,
    patientId: fixtures.patient2.patientId,
    validFrom: switchTime,
    replacesAssignmentId: initialAssignmentId,
    expectedVersion: 1,
  });

  assert.equal(isReplay, false);
  assert.ok(assignment.assignment_id);
  assert.equal(assignment.valid_from, switchTime);
  assert.equal(assignment.valid_to, null);
  assert.equal(assignment.patient_id, fixtures.patient2.patientId);
  reassignedAssignmentId = assignment.assignment_id;

  // Verify previous assignment is closed at exactly switchTime
  const prev = await getAssignmentById({
    tenantId: fixtures.tenantId,
    assignmentId: initialAssignmentId,
  });
  assert.equal(prev.valid_to, switchTime);
  assert.equal(prev.version, 2);
});

test('T12-AS-5: Close assignment with expected version succeeds', async () => {
  const closeTime = fixtures.reassignRequest.validFrom + 50000;
  const { assignment, isReplay } = await closeAssignment({
    tenantId: fixtures.tenantId,
    actor: 'dr-jane',
    assignmentId: reassignedAssignmentId,
    validTo: closeTime,
    expectedVersion: 1,
  });

  assert.equal(isReplay, false);
  assert.equal(assignment.valid_to, closeTime);
  assert.equal(assignment.version, 2);

  // Attempting to close again throws 409 CONFLICT
  await assert.rejects(
    async () => {
      await closeAssignment({
        tenantId: fixtures.tenantId,
        actor: 'dr-jane',
        assignmentId: reassignedAssignmentId,
        validTo: closeTime + 1000,
        expectedVersion: 2,
      });
    },
    (err) => err instanceof AppError && err.status === 409 && /already closed/i.test(err.message)
  );
});

test('T12-AS-6: Idempotency replay returns cached response, body change returns 422', async () => {
  // Re-open another assignment for testing idempotency
  const { assignment: created1 } = await createAssignment({
    tenantId: fixtures.tenantId,
    actor: 'dr-idempotent',
    watchMac: fixtures.watchMac,
    patientId: fixtures.patient1.patientId,
    validFrom: 1700000200000,
    idempotencyKey: 'idem-key-batch-1',
    requestHash: 'hash-1111',
  });

  // Replay with identical key and identical hash
  const { assignment: replay, isReplay } = await createAssignment({
    tenantId: fixtures.tenantId,
    actor: 'dr-idempotent',
    watchMac: fixtures.watchMac,
    patientId: fixtures.patient1.patientId,
    validFrom: 1700000200000,
    idempotencyKey: 'idem-key-batch-1',
    requestHash: 'hash-1111',
  });

  assert.equal(isReplay, true);
  assert.equal(replay.assignment_id, created1.assignment_id);

  // Key reused with different payload/hash -> 422
  await assert.rejects(
    async () => {
      await createAssignment({
        tenantId: fixtures.tenantId,
        actor: 'dr-idempotent',
        watchMac: fixtures.watchMac,
        patientId: fixtures.patient2.patientId,
        validFrom: 1700000200000,
        idempotencyKey: 'idem-key-batch-1',
        requestHash: 'hash-DIFFERENT-PAYLOAD',
      });
    },
    (err) => err instanceof AppError && err.status === 422
  );
});

test('T12-API-1: Next.js API route GET /api/v1/assignments and POST /api/v1/assignments', async () => {
  const token = createSignedJwt(
    { sub: 'dr-api', tenantId: fixtures.tenantId, scopes: ['TENANT_ADMIN'] },
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

  // GET /api/v1/assignments
  const getReq = {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
    query: { watchMac: fixtures.watchMac },
  };
  const getRes = createMockRes();
  await indexHandler(getReq, getRes);

  assert.equal(getRes.statusCode, 200);
  assert.ok(Array.isArray(getRes.body.data));
  assert.ok(getRes.body.data.length >= 2);
});

test('T12-API-2: Next.js API route PATCH /api/v1/assignments/[assignmentId]', async () => {
  const token = createSignedJwt(
    { sub: 'dr-api', tenantId: fixtures.tenantId, scopes: ['TENANT_ADMIN'] },
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

  // Missing expectedVersion -> 400 Bad Request
  const patchReq = {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}` },
    query: { assignmentId: initialAssignmentId },
    body: { validTo: 1700000060000 },
  };
  const patchRes = createMockRes();
  await detailHandler(patchReq, patchRes);

  assert.equal(patchRes.statusCode, 400);
  assert.equal(patchRes.body.error.code, 'BAD_REQUEST');
});

test('T12-API-3: POST and PATCH rejected with 403 Forbidden for CUSTOMER_USER role', async () => {
  const customerToken = createSignedJwt(
    { sub: 'patient-user', tenantId: fixtures.tenantId, customerId: 'cust-1', scopes: ['CUSTOMER_USER'] },
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

  // 1. Attempt POST /api/v1/assignments as CUSTOMER_USER
  const postReq = {
    method: 'POST',
    headers: { authorization: `Bearer ${customerToken}` },
    body: {
      watchMac: fixtures.watchMac,
      patientId: fixtures.patient1.patientId,
    },
  };
  const postRes = createMockRes();
  await indexHandler(postReq, postRes);

  assert.equal(postRes.statusCode, 403);
  assert.equal(postRes.body.error.code, 'FORBIDDEN');

  // 2. Attempt PATCH /api/v1/assignments/[assignmentId] as CUSTOMER_USER
  const patchReq = {
    method: 'PATCH',
    headers: { authorization: `Bearer ${customerToken}` },
    query: { assignmentId: initialAssignmentId },
    body: { validTo: 1700000060000, expectedVersion: 1 },
  };
  const patchRes = createMockRes();
  await detailHandler(patchReq, patchRes);

  assert.equal(patchRes.statusCode, 403);
  assert.equal(patchRes.body.error.code, 'FORBIDDEN');
});
