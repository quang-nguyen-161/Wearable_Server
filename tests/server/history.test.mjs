// tests/server/history.test.mjs
// Unit & Integration Tests for Patient Telemetry History and ECG Batch Clipping (TDD)

import test from 'node:test';
import assert from 'node:assert/strict';

import { query, closePool } from '../../lib/server/db.mjs';
import { createAssignment, closeAssignment } from '../../lib/server/assignments.mjs';
import { setMockTelemetry, clearMockTelemetry } from '../../lib/server/tbAdapter.mjs';
import { getPatientTelemetry } from '../../lib/server/history.mjs';
import { createSignedJwt } from '../../lib/server/auth.mjs';
import telemetryHandler from '../../pages/api/v1/patients/[patientId]/telemetry.js';

const TENANT_ID = 'tenant-hist-01';
const WATCH_MAC = 'E4:5F:01:23:45:67';
const PATIENT_A = 'patient-hist-A';
const PATIENT_B = 'patient-hist-B';
const TEST_SECRET = 'wearable-test-jwt-secret-key-32chars!!';

test.before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = TEST_SECRET;

  clearMockTelemetry();

  // Setup registry
  await query(
    `INSERT INTO watches (tenant_id, watch_mac, tb_device_id, label) VALUES ($1, $2, $3, $4)`,
    [TENANT_ID, WATCH_MAC, 'tb-dev-hist-01', 'Watch Hist 1']
  );
  await query(
    `INSERT INTO patients (tenant_id, patient_id, name, mrn) VALUES ($1, $2, $3, $4)`,
    [TENANT_ID, PATIENT_A, 'Patient Alice', 'MRN-A']
  );
  await query(
    `INSERT INTO patients (tenant_id, patient_id, name, mrn) VALUES ($1, $2, $3, $4)`,
    [TENANT_ID, PATIENT_B, 'Patient Bob', 'MRN-B']
  );

  // Patient A assigned [1000, 5000)
  const { assignment: asgnA } = await createAssignment({
    tenantId: TENANT_ID,
    actor: 'dr-nurse',
    watchMac: WATCH_MAC,
    patientId: PATIENT_A,
    validFrom: 1000,
  });

  // Reassign to Patient B at exactly 5000: closes A at 5000, opens B at 5000 [5000, 10000)
  const { assignment: asgnB } = await createAssignment({
    tenantId: TENANT_ID,
    actor: 'dr-nurse',
    watchMac: WATCH_MAC,
    patientId: PATIENT_B,
    validFrom: 5000,
    replacesAssignmentId: asgnA.assignment_id,
    expectedVersion: 1,
  });

  await closeAssignment({
    tenantId: TENANT_ID,
    actor: 'dr-nurse',
    assignmentId: asgnB.assignment_id,
    validTo: 10000,
    expectedVersion: 1,
  });

  // Populate Mock Telemetry for tb-dev-hist-01
  // 1. SpO2 scalar stream
  setMockTelemetry('tb-dev-hist-01', 'spo2', [
    { ts: 900, value: 95 },   // BEFORE Patient A (should NOT appear for A)
    { ts: 1000, value: 96 },  // EXACT start of Patient A (MUST appear for A)
    { ts: 2500, value: 97 },  // During Patient A (MUST appear for A)
    { ts: 4999, value: 98 },  // Just before switch (MUST appear for A)
    { ts: 5000, value: 99 },  // EXACT start of Patient B (MUST appear for B, NOT A)
    { ts: 7000, value: 99 },  // During Patient B (MUST appear for B)
    { ts: 10000, value: 94 }, // AT validTo boundary of B (should NOT appear for B)
  ]);

  // 2. ECG Batch stream spanning the 5000ms boundary
  // Batch of 50 samples ending at 5100 ms with period 4ms -> covers [4904, 5100]
  // Samples with ts < 5000 belong to Patient A; samples with ts >= 5000 belong to Patient B
  const ecgSamples = [];
  for (let i = 0; i < 50; i++) {
    ecgSamples.push(500 + i);
  }
  setMockTelemetry('tb-dev-hist-01', 'ecg_batch', [
    {
      ts: 5100,
      value: JSON.stringify(ecgSamples),
      samplePeriodMs: 4,
    },
  ]);
});

test.after(async () => {
  await closePool();
});

test('T13-HIST-1: Patient A telemetry strictly clipped to [1000, 5000)', async () => {
  const result = await getPatientTelemetry({
    tenantId: TENANT_ID,
    patientId: PATIENT_A,
    from: 0,
    to: 20000,
  });

  // Extract scalar SpO2 samples
  const spo2Samples = result.data.filter((d) => d.metric === 'spo2');
  const timestamps = spo2Samples.map((d) => d.observedAt);

  assert.deepEqual(timestamps, [1000, 2500, 4999]);
  assert.equal(timestamps.includes(900), false);  // Sample before assignment excluded
  assert.equal(timestamps.includes(5000), false); // Sample after assignment excluded
});

test('T13-HIST-2: Patient B telemetry strictly clipped to [5000, 10000)', async () => {
  const result = await getPatientTelemetry({
    tenantId: TENANT_ID,
    patientId: PATIENT_B,
    from: 0,
    to: 20000,
  });

  const spo2Samples = result.data.filter((d) => d.metric === 'spo2');
  const timestamps = spo2Samples.map((d) => d.observedAt);

  assert.deepEqual(timestamps, [5000, 7000]);
  assert.equal(timestamps.includes(4999), false);  // Belongs to A, excluded from B
  assert.equal(timestamps.includes(10000), false); // Boundary at validTo excluded
});

test('T13-HIST-3: ECG batch spanning assignment boundary is clipped correctly for both patients', async () => {
  // Query Patient A
  const resA = await getPatientTelemetry({
    tenantId: TENANT_ID,
    patientId: PATIENT_A,
    from: 0,
    to: 20000,
    keys: ['ecg_batch'],
  });

  assert.equal(resA.data.length, 1);
  const ecgA = resA.data[0].values;
  // Patient A samples must all be < 5000
  assert.ok(ecgA.startTs >= 1000);
  assert.ok(ecgA.endTs < 5000);
  assert.equal(ecgA.endTs, 4996);

  // Query Patient B
  const resB = await getPatientTelemetry({
    tenantId: TENANT_ID,
    patientId: PATIENT_B,
    from: 0,
    to: 20000,
    keys: ['ecg_batch'],
  });

  assert.equal(resB.data.length, 1);
  const ecgB = resB.data[0].values;
  // Patient B samples must all be >= 5000
  assert.ok(ecgB.startTs >= 5000);
  assert.ok(ecgB.endTs <= 5100);
  assert.equal(ecgB.startTs, 5000);

  // Total samples across both patients equals original batch count (50)
  assert.equal(ecgA.sampleCount + ecgB.sampleCount, 50);
});

test('T13-API-1: Next.js API route GET /api/v1/patients/[patientId]/telemetry', async () => {
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
    query: {
      patientId: PATIENT_A,
      from: '1000',
      to: '6000',
    },
  };
  const res = createMockRes();
  await telemetryHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.data));
  assert.ok(res.body.data.length > 0);
  // All returned data belongs to Patient A's assignment
  for (const item of res.body.data) {
    assert.ok(item.observedAt >= 1000 && item.observedAt < 5000);
  }
});
