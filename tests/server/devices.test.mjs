// tests/server/devices.test.mjs
// Unit tests for batched assignments and device attributes in pages/api/devices.js (Task 6)

import test from 'node:test';
import assert from 'node:assert/strict';

import { query, closePool, getPool } from '../../lib/server/db.mjs';
import { createAssignment } from '../../lib/server/assignments.mjs';
import devicesHandler from '../../pages/api/devices.js';

const TENANT_ID = 'tenant-devices-test';
const WATCH_1 = 'AA:BB:CC:DD:EE:01';
const WATCH_2 = 'AA:BB:CC:DD:EE:02';
const WATCH_3 = 'AA:BB:CC:DD:EE:03';
const PAT_1 = 'pat-dev-01';
const PAT_2 = 'pat-dev-02';

test.before(async () => {
  process.env.NODE_ENV = 'test';

  await query(
    `INSERT INTO watches (tenant_id, watch_mac, tb_device_id, label) VALUES ($1, $2, $3, $4)`,
    [TENANT_ID, WATCH_1, 'tb-dev-01', 'Smart Watch 1']
  );
  await query(
    `INSERT INTO watches (tenant_id, watch_mac, tb_device_id, label) VALUES ($1, $2, $3, $4)`,
    [TENANT_ID, WATCH_2, 'tb-dev-02', 'Smart Watch 2']
  );
  await query(
    `INSERT INTO watches (tenant_id, watch_mac, tb_device_id, label) VALUES ($1, $2, $3, $4)`,
    [TENANT_ID, WATCH_3, 'tb-dev-03', 'Smart Watch 3']
  );

  await query(
    `INSERT INTO patients (tenant_id, patient_id, name, mrn) VALUES ($1, $2, $3, $4)`,
    [TENANT_ID, PAT_1, 'Patient Alpha', 'MRN-A01']
  );
  await query(
    `INSERT INTO patients (tenant_id, patient_id, name, mrn) VALUES ($1, $2, $3, $4)`,
    [TENANT_ID, PAT_2, 'Patient Beta', 'MRN-B02']
  );

  await createAssignment({
    tenantId: TENANT_ID,
    actor: 'dr-test',
    watchMac: WATCH_1,
    patientId: PAT_1,
    validFrom: Date.now() - 50000,
  });

  await createAssignment({
    tenantId: TENANT_ID,
    actor: 'dr-test',
    watchMac: WATCH_2,
    patientId: PAT_2,
    validFrom: Date.now() - 30000,
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

test('T6-DEV-1: Batch assignments query: exactly 1 SQL query for assignments across multiple devices', async () => {
  const pool = getPool();
  let assignmentQueryCount = 0;
  const originalQuery = pool.query;

  // Intercept pool query to count calls mentioning assignments
  pool.query = async function (text, params) {
    if (typeof text === 'string' && text.includes('FROM assignments')) {
      assignmentQueryCount++;
    }
    return originalQuery.apply(this, arguments);
  };

  try {
    const req = { method: 'GET', query: {} };
    const res = createMockRes();
    await devicesHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.devices));
    assert.ok(res.body.devices.length >= 3);

    // CRITICAL: Must be exactly 1 query for assignments (O(1)), NOT N queries!
    assert.equal(
      assignmentQueryCount,
      1,
      `Expected exactly 1 assignments query for ${res.body.devices.length} devices, but got ${assignmentQueryCount}`
    );
  } finally {
    pool.query = originalQuery;
  }
});

test('T6-DEV-2: Payload embeds showEcg and deviceMode attributes with default contracts', async () => {
  const req = { method: 'GET', query: {} };
  const res = createMockRes();
  await devicesHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.devices));

  for (const d of res.body.devices) {
    assert.equal(typeof d.showEcg, 'boolean', `Device ${d.name} showEcg must be boolean`);
    assert.equal(typeof d.deviceMode, 'number', `Device ${d.name} deviceMode must be number`);
  }
});

test('T6-DEV-3: Active patient assignments resolved accurately via batched map', async () => {
  const req = { method: 'GET', query: {} };
  const res = createMockRes();
  await devicesHandler(req, res);

  assert.equal(res.statusCode, 200);
  const d1 = res.body.devices.find((d) => d.name === WATCH_1);
  assert.ok(d1);
  assert.equal(d1.patientId, PAT_1);
  assert.equal(d1.patientName, 'Patient Alpha');

  const d2 = res.body.devices.find((d) => d.name === WATCH_2);
  assert.ok(d2);
  assert.equal(d2.patientId, PAT_2);
  assert.equal(d2.patientName, 'Patient Beta');

  const d3 = res.body.devices.find((d) => d.name === WATCH_3);
  assert.ok(d3);
  assert.equal(d3.patientId, null);
  assert.equal(d3.patientName, null);
});
