// tests/server/db.test.mjs
// Unit & Integration Tests for Architecture v2 Assignment Database Store (TDD)

import test from 'node:test';
import assert from 'node:assert/strict';
import { getPool, query, withTransaction, closePool } from '../../lib/server/db.mjs';

test.beforeEach(() => {
  process.env.NODE_ENV = 'test';
});

test.after(async () => {
  await closePool();
});

test('T10-DB-1: Insert watch and patient registry records', async () => {
  const watchRes = await query(
    `INSERT INTO watches (tenant_id, watch_mac, tb_device_id, label) VALUES ($1, $2, $3, $4) RETURNING *`,
    ['tenant-01', 'E4:5F:01:23:45:67', 'tb-uuid-01', 'Cardio Watch 1']
  );
  assert.equal(watchRes.rowCount, 1);

  const patientRes = await query(
    `INSERT INTO patients (tenant_id, patient_id, name, mrn) VALUES ($1, $2, $3, $4) RETURNING *`,
    ['tenant-01', 'patient-uuid-101', 'Nguyen Van A', 'MRN-101']
  );
  assert.equal(patientRes.rowCount, 1);
});

test('T10-DB-2: Foreign key validation rejects unreferenced watch or patient', async () => {
  // Invalid watch
  await assert.rejects(
    async () => {
      await query(
        `INSERT INTO assignments (assignment_id, tenant_id, watch_mac, patient_id, valid_from, valid_to, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['as-invalid-watch', 'tenant-01', 'AA:BB:CC:DD:EE:FF', 'patient-uuid-101', 1700000000000, null, 'dr-smith']
      );
    },
    (err) => {
      assert.equal(err.code, '23503'); // foreign_key_violation
      return true;
    }
  );

  // Invalid patient
  await assert.rejects(
    async () => {
      await query(
        `INSERT INTO assignments (assignment_id, tenant_id, watch_mac, patient_id, valid_from, valid_to, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['as-invalid-patient', 'tenant-01', 'E4:5F:01:23:45:67', 'non-existent-patient', 1700000000000, null, 'dr-smith']
      );
    },
    (err) => {
      assert.equal(err.code, '23503'); // foreign_key_violation
      return true;
    }
  );
});

test('T10-DB-3: Check constraint rejects valid_from >= valid_to', async () => {
  await assert.rejects(
    async () => {
      await query(
        `INSERT INTO assignments (assignment_id, tenant_id, watch_mac, patient_id, valid_from, valid_to, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['as-inv-time', 'tenant-01', 'E4:5F:01:23:45:67', 'patient-uuid-101', 1700000010000, 1700000005000, 'dr-smith']
      );
    },
    (err) => {
      assert.equal(err.code, '23514'); // check_violation
      return true;
    }
  );
});

test('T10-DB-4: Insert initial open assignment [t0, null)', async () => {
  const res = await query(
    `INSERT INTO assignments (assignment_id, tenant_id, watch_mac, patient_id, valid_from, valid_to, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    ['as-01', 'tenant-01', 'E4:5F:01:23:45:67', 'patient-uuid-101', 1700000000000, null, 'dr-smith']
  );
  assert.equal(res.rowCount, 1);
  assert.equal(res.rows[0].assignment_id, 'as-01');
  assert.equal(res.rows[0].valid_to, null);
  assert.equal(res.rows[0].version, 1);
});

test('T10-DB-5: Overlap exclusion constraint rejects concurrent assignment for same watch', async () => {
  // Another patient 102
  await query(
    `INSERT INTO patients (tenant_id, patient_id, name, mrn) VALUES ($1, $2, $3, $4) RETURNING *`,
    ['tenant-01', 'patient-uuid-102', 'Tran Thi B', 'MRN-102']
  );

  // Attempt overlapping assignment while as-01 is still open [1700000000000, null)
  await assert.rejects(
    async () => {
      await query(
        `INSERT INTO assignments (assignment_id, tenant_id, watch_mac, patient_id, valid_from, valid_to, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['as-02-overlap', 'tenant-01', 'E4:5F:01:23:45:67', 'patient-uuid-102', 1700000005000, null, 'dr-jones']
      );
    },
    (err) => {
      assert.equal(err.code, '23P01'); // exclusion_violation
      return true;
    }
  );
});

test('T10-DB-6: Optimistic version check and assignment close [t0, t1)', async () => {
  // Stale version update must fail (return rowCount 0)
  const staleRes = await query(
    `UPDATE assignments SET valid_to = $1, version = version + 1
     WHERE assignment_id = $2 AND tenant_id = $3 AND version = $4 RETURNING *`,
    [1700000050000, 'as-01', 'tenant-01', 99] // expected version 99 != 1
  );
  assert.equal(staleRes.rowCount, 0);

  // Correct version update succeeds
  const closeRes = await query(
    `UPDATE assignments SET valid_to = $1, version = version + 1
     WHERE assignment_id = $2 AND tenant_id = $3 AND version = $4 RETURNING *`,
    [1700000050000, 'as-01', 'tenant-01', 1]
  );
  assert.equal(closeRes.rowCount, 1);
  assert.equal(closeRes.rows[0].valid_to, 1700000050000);
  assert.equal(closeRes.rows[0].version, 2);
});

test('T10-DB-7: Non-overlapping consecutive assignment succeeds [t1, null)', async () => {
  // Now as-01 is [1700000000000, 1700000050000).
  // An assignment starting exactly at t1 = 1700000050000 does NOT overlap!
  const res = await query(
    `INSERT INTO assignments (assignment_id, tenant_id, watch_mac, patient_id, valid_from, valid_to, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    ['as-02', 'tenant-01', 'E4:5F:01:23:45:67', 'patient-uuid-102', 1700000050000, null, 'dr-jones']
  );
  assert.equal(res.rowCount, 1);
  assert.equal(res.rows[0].assignment_id, 'as-02');
});

test('T10-DB-8: Idempotency store unique claim and replay', async () => {
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const insRes = await query(
    `INSERT INTO idempotency_keys (tenant_id, actor, operation, idempotency_key, request_hash, status_code, response_body, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    ['tenant-01', 'user-01', 'CREATE_ASSIGNMENT', 'idem-key-123', 'hash-abc', 201, '{"assignmentId":"as-02"}', expiresAt]
  );
  assert.equal(insRes.rowCount, 1);

  // Duplicate idempotency key with same tenant+actor+op must trigger unique_violation (23505)
  await assert.rejects(
    async () => {
      await query(
        `INSERT INTO idempotency_keys (tenant_id, actor, operation, idempotency_key, request_hash, status_code, response_body, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        ['tenant-01', 'user-01', 'CREATE_ASSIGNMENT', 'idem-key-123', 'hash-different', 201, '{"assignmentId":"as-03"}', expiresAt]
      );
    },
    (err) => {
      assert.equal(err.code, '23505'); // unique_violation
      return true;
    }
  );
});
