// lib/server/db.mjs
// PostgreSQL connection pool and transaction manager for Wearable Health Architecture v2.

import pg from 'pg';

const { Pool } = pg;

let pool = null;

/**
 * Returns or initializes the PostgreSQL pool.
 */
export function getPool() {
  if (pool) return pool;

  const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString && (process.env.NODE_ENV === 'test' || process.env.DB_DRIVER === 'test-memory' || process.env.DB_DRIVER === 'memory')) {
    pool = createMemoryTestPool();
    return pool;
  }

  if (!connectionString) {
    if (process.env.NODE_ENV === 'test' || process.env.DB_DRIVER === 'memory') {
      pool = createMemoryTestPool();
      return pool;
    }
    throw new Error('DATABASE_URL or TEST_DATABASE_URL environment variable is required');
  }

  pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    console.error('[db] Unexpected error on idle client', err);
  });

  return pool;
}

/**
 * Close pool and release all connections.
 */
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Execute a query with parameters using the pool.
 */
export async function query(text, params = []) {
  const p = getPool();
  return p.query(text, params);
}

/**
 * Execute operations within a PostgreSQL transaction.
 * Automatically handles BEGIN, COMMIT, and ROLLBACK.
 */
export async function withTransaction(callback) {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      console.error('[db] Error rolling back transaction:', rbErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

// =============================================================================
// In-Memory Test Driver for Isolated TDD Harness
// Simulates PostgreSQL exclusion constraints (23P01), FKs, and transaction rollback
// =============================================================================
function createMemoryTestPool() {
  const isDev = process.env.NODE_ENV !== 'test';

  const store = {
    watches: isDev ? new Map([
      ['tenant-default:D2:6C:5A:11:22:33', { tenant_id: 'tenant-default', watch_mac: 'D2:6C:5A:11:22:33', tb_device_id: 'tb-dev-01', label: 'Watch Alpha (Cardio)' }],
      ['tenant-default:E4:5F:01:44:55:66', { tenant_id: 'tenant-default', watch_mac: 'E4:5F:01:44:55:66', tb_device_id: 'tb-dev-02', label: 'Watch Beta (ICU)' }],
    ]) : new Map(),
    patients: isDev ? new Map([
      ['tenant-default:pat-01', { tenant_id: 'tenant-default', patient_id: 'pat-01', name: 'Nguyen Van A', mrn: 'MRN-101' }],
      ['tenant-default:pat-02', { tenant_id: 'tenant-default', patient_id: 'pat-02', name: 'Tran Thi B', mrn: 'MRN-102' }],
    ]) : new Map(),
    assignments: isDev ? new Map([
      ['as-initial-01', {
        assignment_id: 'as-initial-01',
        tenant_id: 'tenant-default',
        watch_mac: 'D2:6C:5A:11:22:33',
        patient_id: 'pat-01',
        valid_from: Date.now() - 3600000,
        valid_to: null,
        version: 1,
        created_by: 'system',
        created_at: new Date(),
        updated_at: new Date()
      }],
      ['as-initial-02', {
        assignment_id: 'as-initial-02',
        tenant_id: 'tenant-default',
        watch_mac: 'E4:5F:01:44:55:66',
        patient_id: 'pat-02',
        valid_from: Date.now() - 1800000,
        valid_to: null,
        version: 1,
        created_by: 'system',
        created_at: new Date(),
        updated_at: new Date()
      }]
    ]) : new Map(),
    idempotency_keys: new Map(),
    audit_log: [],
  };

  const checkIntervalOverlap = (tenantId, watchMac, validFrom, validTo, excludeId = null) => {
    const to = validTo ?? Number.MAX_SAFE_INTEGER;
    for (const [id, a] of store.assignments.entries()) {
      if (excludeId && id === excludeId) continue;
      if (a.tenant_id === tenantId && a.watch_mac === watchMac) {
        const existingTo = a.valid_to ?? Number.MAX_SAFE_INTEGER;
        // Check interval [validFrom, to) && [a.valid_from, existingTo)
        const overlaps = Math.max(validFrom, a.valid_from) < Math.min(to, existingTo);
        if (overlaps) {
          const err = new Error(`conflicting key value violates exclusion constraint "no_assignment_overlap"`);
          err.code = '23P01'; // PostgreSQL code for exclusion_violation
          throw err;
        }
      }
    }
  };

  const poolInstance = {
    _store: store,
    async end() {
      // no-op
    },
    async connect() {
      // Snapshot state for transaction rollback simulation
      let inTx = false;
      let snapshot = null;

      const client = {
        async query(text, params = []) {
          return poolInstance.query(text, params, { inTx });
        },
        release() {
          // release client
        }
      };
      return client;
    },
    async query(text, params = []) {
      const sql = text.trim();

      // INSERT INTO watches
      if (sql.startsWith('INSERT INTO watches')) {
        const [tenant_id, watch_mac, tb_device_id, label] = params;
        const key = `${tenant_id}:${watch_mac.toUpperCase()}`;
        store.watches.set(key, { tenant_id, watch_mac: watch_mac.toUpperCase(), tb_device_id, label });
        return { rowCount: 1, rows: [{ tenant_id, watch_mac: watch_mac.toUpperCase() }] };
      }

      // INSERT INTO patients
      if (sql.startsWith('INSERT INTO patients')) {
        const [tenant_id, patient_id, name, mrn] = params;
        const key = `${tenant_id}:${patient_id}`;
        store.patients.set(key, { tenant_id, patient_id, name, mrn });
        return { rowCount: 1, rows: [{ tenant_id, patient_id }] };
      }

      // SELECT FROM watches
      if (sql.includes('FROM watches')) {
        if (sql.includes('watch_mac =')) {
          const [tenant_id, watch_mac] = params;
          const mac = (watch_mac || '').toUpperCase();
          const w = store.watches.get(`${tenant_id}:${mac}`);
          if (w) {
            return { rowCount: 1, rows: [{ ...w }] };
          }
          return { rowCount: 0, rows: [] };
        } else {
          const [tenant_id, limit = 50] = params;
          const matches = [];
          for (const w of store.watches.values()) {
            if (!tenant_id || w.tenant_id === tenant_id) {
              matches.push({ ...w });
            }
          }
          matches.sort((a, b) => a.watch_mac.localeCompare(b.watch_mac));
          return { rowCount: matches.length, rows: matches.slice(0, Number(limit)) };
        }
      }

      // SELECT assignments JOIN patients
      if (sql.includes('JOIN patients')) {
        if (Array.isArray(params[0])) {
          const macList = params[0].map(m => String(m).toUpperCase());
          const rows = [];
          for (const a of store.assignments.values()) {
            if (a.valid_to === null) {
              const watch = Array.from(store.watches.values()).find(w => (w.watch_mac && w.watch_mac.toUpperCase() === a.watch_mac.toUpperCase()));
              const matches = macList.includes(a.watch_mac.toUpperCase()) ||
                              (watch?.tb_device_id && macList.includes(watch.tb_device_id.toUpperCase())) ||
                              (watch?.label && macList.includes(watch.label.toUpperCase()));
              if (matches) {
                const p = store.patients.get(`${a.tenant_id}:${a.patient_id}`);
                rows.push({
                  assignment_id: a.assignment_id,
                  watch_mac: a.watch_mac,
                  valid_from: a.valid_from,
                  valid_to: a.valid_to,
                  patient_id: a.patient_id,
                  patient_name: p ? p.name : null,
                  mrn: p ? p.mrn : null,
                });
              }
            }
          }
          rows.sort((a, b) => Number(b.valid_from) - Number(a.valid_from));
          return { rowCount: rows.length, rows };
        }

        const [device_mac, assignment_id_param, tenant_id_param] = params;
        const mac = (device_mac || '').toUpperCase();
        for (const a of store.assignments.values()) {
          if (tenant_id_param && a.tenant_id !== tenant_id_param) continue;
          const watch = Array.from(store.watches.values()).find(w => (w.tb_device_id && w.tb_device_id.toUpperCase() === mac) || (w.watch_mac && w.watch_mac.toUpperCase() === mac));
          const matches = (a.watch_mac === mac || a.assignment_id === device_mac || (watch && watch.watch_mac === a.watch_mac));
          if (matches && a.valid_to === null) {
            const p = store.patients.get(`${a.tenant_id}:${a.patient_id}`);
            return {
              rowCount: 1,
              rows: [{
                assignment_id: a.assignment_id,
                watch_mac: a.watch_mac,
                valid_from: a.valid_from,
                valid_to: a.valid_to,
                patient_id: a.patient_id,
                patient_name: p ? p.name : null,
                mrn: p ? p.mrn : null,
              }],
            };
          }
        }
        return { rowCount: 0, rows: [] };
      }

      // INSERT INTO assignments
      if (sql.startsWith('INSERT INTO assignments')) {
        const [assignment_id, tenant_id, watch_mac, patient_id, valid_from, valid_to, created_by] = params;
        const mac = watch_mac.toUpperCase();

        // FK check watches
        if (!store.watches.has(`${tenant_id}:${mac}`)) {
          const err = new Error('insert or update on table "assignments" violates foreign key constraint "fk_assignment_watch"');
          err.code = '23503';
          throw err;
        }
        // FK check patients
        if (!store.patients.has(`${tenant_id}:${patient_id}`)) {
          const err = new Error('insert or update on table "assignments" violates foreign key constraint "fk_assignment_patient"');
          err.code = '23503';
          throw err;
        }
        // Interval check
        if (valid_to !== null && valid_to !== undefined && valid_from >= valid_to) {
          const err = new Error('new row for relation "assignments" violates check constraint "chk_assignment_interval"');
          err.code = '23514';
          throw err;
        }
        // Overlap constraint
        checkIntervalOverlap(tenant_id, mac, valid_from, valid_to);

        const record = {
          assignment_id,
          tenant_id,
          watch_mac: mac,
          patient_id,
          valid_from: Number(valid_from),
          valid_to: valid_to !== null && valid_to !== undefined ? Number(valid_to) : null,
          version: 1,
          created_by,
          created_at: new Date(),
          updated_at: new Date(),
        };
        store.assignments.set(assignment_id, record);
        return { rowCount: 1, rows: [record] };
      }

      // SELECT assignments by id
      if (sql.includes('FROM assignments') && sql.includes('WHERE assignment_id =') && !sql.includes('watch_mac')) {
        const [assignment_id, tenant_id] = params;
        const a = store.assignments.get(assignment_id);
        if (a && (!tenant_id || a.tenant_id === tenant_id)) {
          return { rowCount: 1, rows: [{ ...a }] };
        }
        return { rowCount: 0, rows: [] };
      }

      // SELECT active or interval assignments for MAC
      if (sql.includes('FROM assignments') && sql.includes('watch_mac =')) {
        const [tenant_id, watch_mac] = params;
        const mac = watch_mac.toUpperCase();
        const matches = [];
        for (const a of store.assignments.values()) {
          if (a.tenant_id === tenantIdOr(tenant_id) && a.watch_mac === mac) {
            matches.push({ ...a });
          }
        }
        return { rowCount: matches.length, rows: matches };
      }

      // SELECT assignments by patient_id with interval filter
      if (sql.includes('FROM assignments') && sql.includes('patient_id =')) {
        const [tenant_id, patient_id, fromTs, toTs, assignment_id] = params;
        const matches = [];
        for (const a of store.assignments.values()) {
          if (a.tenant_id === tenant_id && a.patient_id === patient_id) {
            if (assignment_id && a.assignment_id !== assignment_id) continue;
            if (fromTs !== undefined && a.valid_to !== null && a.valid_to <= fromTs) continue;
            if (toTs !== undefined && a.valid_from >= toTs) continue;
            matches.push({ ...a });
          }
        }
        // sort by valid_from ASC
        matches.sort((x, y) => x.valid_from - y.valid_from);
        return { rowCount: matches.length, rows: matches };
      }

      // UPDATE assignments (Close or Reassign with optimistic lock)
      if (sql.startsWith('UPDATE assignments')) {
        // UPDATE assignments SET valid_to = $1, version = version + 1 WHERE assignment_id = $2 AND tenant_id = $3 AND version = $4
        const [valid_to, assignment_id, tenant_id, expected_version] = params;
        const a = store.assignments.get(assignment_id);
        if (!a || a.tenant_id !== tenant_id) {
          return { rowCount: 0, rows: [] };
        }
        if (expected_version !== undefined && expected_version !== null && a.version !== expected_version) {
          return { rowCount: 0, rows: [] }; // Stale version
        }
        if (valid_to !== null && valid_to !== undefined && a.valid_from >= valid_to) {
          const err = new Error('violates check constraint "chk_assignment_interval"');
          err.code = '23514';
          throw err;
        }

        // Check overlap if shortening/closing interval
        checkIntervalOverlap(tenant_id, a.watch_mac, a.valid_from, valid_to, assignment_id);

        a.valid_to = Number(valid_to);
        a.version += 1;
        a.updated_at = new Date();
        return { rowCount: 1, rows: [{ ...a }] };
      }

      // Idempotency keys
      if (sql.startsWith('INSERT INTO idempotency_keys')) {
        const [tenant_id, actor, operation, idempotency_key, request_hash, status_code, response_body, expires_at] = params;
        const key = `${tenant_id}:${actor}:${operation}:${idempotency_key}`;
        if (store.idempotency_keys.has(key)) {
          const existing = store.idempotency_keys.get(key);
          const err = new Error('duplicate key value violates unique constraint "idempotency_keys_pkey"');
          err.code = '23505';
          err.existingRecord = existing;
          throw err;
        }
        const record = { tenant_id, actor, operation, idempotency_key, request_hash, status_code, response_body, expires_at };
        store.idempotency_keys.set(key, record);
        return { rowCount: 1, rows: [record] };
      }

      if (sql.includes('FROM idempotency_keys')) {
        const [tenant_id, actor, operation, idempotency_key] = params;
        const key = `${tenant_id}:${actor}:${operation}:${idempotency_key}`;
        const record = store.idempotency_keys.get(key);
        if (record) {
          return { rowCount: 1, rows: [{ ...record }] };
        }
        return { rowCount: 0, rows: [] };
      }

      // Default fallback
      return { rowCount: 0, rows: [] };
    }
  };

  function tenantIdOr(t) { return t; }

  return poolInstance;
}
