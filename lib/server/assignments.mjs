// lib/server/assignments.mjs
// Transactional Patient Assignment Service for Architecture v2.

import crypto from 'node:crypto';
import { query, withTransaction } from './db.mjs';
import { validateMac, validateId, computeRequestHash } from './validation.mjs';
import {
  conflict,
  notFound,
  unprocessable,
  badRequest,
} from './errors.mjs';

/**
 * Creates a new assignment or atomically reassigns a watch from one patient to another.
 */
export async function createAssignment({
  tenantId,
  actor = 'system',
  watchMac,
  patientId,
  validFrom = Date.now(),
  replacesAssignmentId = null,
  expectedVersion = null,
  idempotencyKey = null,
  requestHash = null,
}) {
  const normalizedMac = validateMac(watchMac);
  const validatedPatientId = validateId(patientId, 'patientId');
  const fromMs = Number(validFrom);

  if (isNaN(fromMs) || fromMs <= 0) {
    throw unprocessable('validFrom must be a valid positive UTC timestamp', { validFrom });
  }

  // 1. Idempotency Check
  if (idempotencyKey) {
    const existingKeyRes = await query(
      `SELECT * FROM idempotency_keys
       WHERE tenant_id = $1 AND actor = $2 AND operation = $3 AND idempotency_key = $4`,
      [tenantId, actor, 'CREATE_ASSIGNMENT', idempotencyKey]
    );

    if (existingKeyRes.rowCount > 0) {
      const record = existingKeyRes.rows[0];
      if (record.request_hash !== requestHash) {
        throw unprocessable('Idempotency key reused with different request payload', {
          idempotencyKey,
        });
      }
      return {
        assignment: JSON.parse(record.response_body),
        isReplay: true,
      };
    }
  }

  // 2. Transactional execution
  const newAssignmentId = `as-${crypto.randomUUID()}`;

  let resultAssignment;
  try {
    resultAssignment = await withTransaction(async (client) => {
    // If replacing an active assignment: close old, open new in the same atomic transaction
    if (replacesAssignmentId) {
      const prevRes = await client.query(
        `SELECT * FROM assignments
         WHERE assignment_id = $1 AND tenant_id = $2`,
        [replacesAssignmentId, tenantId]
      );

      if (prevRes.rowCount === 0) {
        throw notFound(`Assignment ${replacesAssignmentId} not found in this tenant`);
      }

      const prev = prevRes.rows[0];
      if (prev.watch_mac !== normalizedMac) {
        throw conflict(`replacesAssignmentId ${replacesAssignmentId} is for watch ${prev.watch_mac}, not ${normalizedMac}`);
      }
      if (prev.valid_to !== null) {
        throw conflict(`Assignment ${replacesAssignmentId} is already closed`, {
          closedAt: prev.valid_to,
        });
      }
      if (expectedVersion !== null && expectedVersion !== undefined && prev.version !== expectedVersion) {
        throw conflict(`Optimistic concurrency conflict on assignment ${replacesAssignmentId}. Expected version ${expectedVersion}, but found ${prev.version}`, {
          expectedVersion,
          actualVersion: prev.version,
        });
      }
      if (fromMs <= prev.valid_from) {
        throw unprocessable(`New assignment start time (${fromMs}) must be after previous assignment start time (${prev.valid_from})`);
      }

      // Close previous assignment at exact moment fromMs
      const updateRes = await client.query(
        `UPDATE assignments
         SET valid_to = $1, version = version + 1, updated_at = NOW()
         WHERE assignment_id = $2 AND tenant_id = $3 AND version = $4
         RETURNING *`,
        [fromMs, replacesAssignmentId, tenantId, prev.version]
      );

      if (updateRes.rowCount === 0) {
        throw conflict(`Concurrent modification occurred while closing assignment ${replacesAssignmentId}`);
      }

      // Audit log for closing previous assignment
      await client.query(
        `INSERT INTO assignment_audit_log (assignment_id, tenant_id, action, actor, old_state, new_state)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          replacesAssignmentId,
          tenantId,
          'REASSIGNED_CLOSED',
          actor,
          JSON.stringify(prev),
          JSON.stringify(updateRes.rows[0]),
        ]
      );
    }

    // Insert new assignment
    const insertRes = await client.query(
      `INSERT INTO assignments (
         assignment_id, tenant_id, watch_mac, patient_id, valid_from, valid_to, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [newAssignmentId, tenantId, normalizedMac, validatedPatientId, fromMs, null, actor]
    );

    const created = insertRes.rows[0];

    // Audit log for new assignment
    await client.query(
      `INSERT INTO assignment_audit_log (assignment_id, tenant_id, action, actor, old_state, new_state)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newAssignmentId, tenantId, 'CREATED', actor, null, JSON.stringify(created)]
    );

    return created;
  });
  } catch (err) {
    if (err.code === '23P01') {
      throw conflict('Assignment interval overlaps with an existing record for this watch', { originalCode: '23P01' });
    }
    if (err.code === '23503') {
      throw unprocessable('Referenced watch or patient does not exist in tenant', { originalCode: '23503' });
    }
    if (err.code === '23505') {
      throw conflict('Duplicate record', { originalCode: '23505' });
    }
    throw err;
  }

  // 3. Store idempotency key if requested
  if (idempotencyKey && requestHash) {
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    await query(
      `INSERT INTO idempotency_keys (
         tenant_id, actor, operation, idempotency_key, request_hash, status_code, response_body, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, actor, operation, idempotency_key) DO NOTHING`,
      [
        tenantId,
        actor,
        'CREATE_ASSIGNMENT',
        idempotencyKey,
        requestHash,
        201,
        JSON.stringify(resultAssignment),
        expiresAt,
      ]
    );
  }

  return {
    assignment: resultAssignment,
    isReplay: false,
  };
}

/**
 * Closes an active assignment at validTo timestamp with optimistic concurrency check.
 */
export async function closeAssignment({
  tenantId,
  actor = 'system',
  assignmentId,
  validTo = Date.now(),
  expectedVersion,
  idempotencyKey = null,
  requestHash = null,
}) {
  const toMs = Number(validTo);
  if (isNaN(toMs) || toMs <= 0) {
    throw unprocessable('validTo must be a valid positive UTC timestamp', { validTo });
  }

  if (expectedVersion === undefined || expectedVersion === null) {
    throw unprocessable('expectedVersion is required for closing an assignment');
  }

  // 1. Idempotency Check
  if (idempotencyKey) {
    const existingKeyRes = await query(
      `SELECT * FROM idempotency_keys
       WHERE tenant_id = $1 AND actor = $2 AND operation = $3 AND idempotency_key = $4`,
      [tenantId, actor, 'CLOSE_ASSIGNMENT', idempotencyKey]
    );

    if (existingKeyRes.rowCount > 0) {
      const record = existingKeyRes.rows[0];
      if (record.request_hash !== requestHash) {
        throw unprocessable('Idempotency key reused with different request payload', {
          idempotencyKey,
        });
      }
      return {
        assignment: JSON.parse(record.response_body),
        isReplay: true,
      };
    }
  }

  // 2. Transactional close
  const resultAssignment = await withTransaction(async (client) => {
    const currentRes = await client.query(
      `SELECT * FROM assignments WHERE assignment_id = $1 AND tenant_id = $2`,
      [assignmentId, tenantId]
    );

    if (currentRes.rowCount === 0) {
      throw notFound(`Assignment ${assignmentId} not found in this tenant`);
    }

    const current = currentRes.rows[0];
    if (current.valid_to !== null) {
      throw conflict(`Assignment ${assignmentId} is already closed`, {
        closedAt: current.valid_to,
      });
    }

    if (current.version !== expectedVersion) {
      throw conflict(`Optimistic concurrency conflict on assignment ${assignmentId}. Expected version ${expectedVersion}, but found ${current.version}`, {
        expectedVersion,
        actualVersion: current.version,
      });
    }

    if (toMs <= current.valid_from) {
      throw unprocessable(`validTo (${toMs}) must be strictly greater than validFrom (${current.valid_from})`);
    }

    const updateRes = await client.query(
      `UPDATE assignments
       SET valid_to = $1, version = version + 1, updated_at = NOW()
       WHERE assignment_id = $2 AND tenant_id = $3 AND version = $4
       RETURNING *`,
      [toMs, assignmentId, tenantId, expectedVersion]
    );

    if (updateRes.rowCount === 0) {
      throw conflict(`Concurrent modification occurred while closing assignment ${assignmentId}`);
    }

    const updated = updateRes.rows[0];

    // Audit log
    await client.query(
      `INSERT INTO assignment_audit_log (assignment_id, tenant_id, action, actor, old_state, new_state)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [assignmentId, tenantId, 'CLOSED', actor, JSON.stringify(current), JSON.stringify(updated)]
    );

    return updated;
  });

  // 3. Store idempotency key
  if (idempotencyKey && requestHash) {
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    await query(
      `INSERT INTO idempotency_keys (
         tenant_id, actor, operation, idempotency_key, request_hash, status_code, response_body, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, actor, operation, idempotency_key) DO NOTHING`,
      [
        tenantId,
        actor,
        'CLOSE_ASSIGNMENT',
        idempotencyKey,
        requestHash,
        200,
        JSON.stringify(resultAssignment),
        expiresAt,
      ]
    );
  }

  return {
    assignment: resultAssignment,
    isReplay: false,
  };
}

/**
 * Lists assignments filtered by tenant and optional filters.
 */
export async function listAssignments({
  tenantId,
  watchMac = null,
  patientId = null,
  from = null,
  to = null,
  cursor = null,
  limit = 50,
}) {
  let sql = `SELECT * FROM assignments WHERE tenant_id = $1`;
  const params = [tenantId];

  if (watchMac) {
    const mac = validateMac(watchMac);
    params.push(mac);
    sql += ` AND watch_mac = $${params.length}`;
  }

  if (patientId) {
    const pId = validateId(patientId, 'patientId');
    params.push(pId);
    sql += ` AND patient_id = $${params.length}`;
  }

  if (from !== null && from !== undefined) {
    params.push(Number(from));
    sql += ` AND (valid_to IS NULL OR valid_to > $${params.length})`;
  }

  if (to !== null && to !== undefined) {
    params.push(Number(to));
    sql += ` AND valid_from < $${params.length}`;
  }

  sql += ` ORDER BY valid_from DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const res = await query(sql, params);
  return {
    data: res.rows,
    nextCursor: null,
    serverNow: Date.now(),
  };
}

/**
 * Gets a single assignment by ID within a tenant.
 */
export async function getAssignmentById({ tenantId, assignmentId }) {
  const res = await query(
    `SELECT * FROM assignments WHERE assignment_id = $1 AND tenant_id = $2`,
    [assignmentId, tenantId]
  );
  if (res.rowCount === 0) {
    throw notFound(`Assignment ${assignmentId} not found in this tenant`);
  }
  return res.rows[0];
}
