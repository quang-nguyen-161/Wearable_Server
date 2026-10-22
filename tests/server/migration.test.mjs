// tests/server/migration.test.mjs
// TDD verification for MAC-Native Migration & Legacy Data Preservation

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyLegacyDevices, runMigration } from '../../scripts/migrate-mac-native.mjs';
import { getPool } from '../../lib/server/db.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/legacy-devices.json');

process.env.NODE_ENV = 'test';
process.env.DB_DRIVER = 'test-memory';

test('1. classifyLegacyDevices: correctly classifies slot-based, unattributed, and MAC-native devices', () => {
  const sample = [
    {
      id: { id: 'uuid-1' },
      name: 'Node1',
      serverAttributes: { macAddress: 'AA:BB:CC:11:22:33' },
      telemetryCount: 100,
      telemetryChecksum: 'chk1'
    },
    {
      id: { id: 'uuid-2' },
      name: 'Node2',
      serverAttributes: { room: 'ICU' }, // Missing MAC
      telemetryCount: 50,
      telemetryChecksum: 'chk2'
    },
    {
      id: { id: 'uuid-3' },
      name: 'AA:BB:CC:44:55:66', // Already MAC
      serverAttributes: { macAddress: 'AA:BB:CC:44:55:66' },
      telemetryCount: 80,
      telemetryChecksum: 'chk3'
    }
  ];

  const res = classifyLegacyDevices(sample);
  assert.equal(res.migrated.length, 1);
  assert.equal(res.migrated[0].macAddress, 'AA:BB:CC:11:22:33');
  assert.equal(res.migrated[0].legacySlotName, 'Node1');

  assert.equal(res.unattributed.length, 1);
  assert.equal(res.unattributed[0].legacySlotName, 'Node2');
  assert.ok(res.unattributed[0].reason.includes('Missing provable'));

  assert.equal(res.alreadyMacNative.length, 1);
  assert.equal(res.alreadyMacNative[0].macAddress, 'AA:BB:CC:44:55:66');
});

test('2. classifyLegacyDevices: detects conflicting MAC claims across different slots', () => {
  const sample = [
    {
      id: { id: 'uuid-1' },
      name: 'Node1',
      serverAttributes: { macAddress: 'AA:BB:CC:11:22:33' }
    },
    {
      id: { id: 'uuid-2' },
      name: 'Node2',
      serverAttributes: { macAddress: 'AA:BB:CC:11:22:33' } // Conflict!
    }
  ];

  const res = classifyLegacyDevices(sample);
  assert.equal(res.migrated.length, 1);
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].macAddress, 'AA:BB:CC:11:22:33');
  assert.ok(res.conflicts[0].reason.includes('Duplicate MAC'));
});

test('3. runMigration (--dry-run): reads fixtures, computes plan without DB mutations', async () => {
  const report = await runMigration({
    dryRun: true,
    fixturePath: FIXTURE_PATH,
    tenantId: 'tenant-alpha-01'
  });

  assert.equal(report.dryRun, true);
  assert.equal(report.tenantId, 'tenant-alpha-01');
  assert.equal(report.totalDevices, 4);
  assert.equal(report.migratedCount, 2);
  assert.equal(report.unattributedCount, 1);
  assert.equal(report.alreadyMacNativeCount, 1);
  assert.equal(report.conflictsCount, 0);
  assert.equal(report.legacyChecksumsVerified, true);
});

test('4. runMigration (live): stores watches into DB and is idempotent on rerun', async () => {
  const pool = getPool();

  const report1 = await runMigration({
    dryRun: false,
    fixturePath: FIXTURE_PATH,
    tenantId: 'tenant-alpha-01',
    dbPool: pool
  });
  assert.equal(report1.migratedCount, 2);
  assert.equal(report1.alreadyMacNativeCount, 1);

  // Verify DB entries
  const q = await pool.query('SELECT * FROM watches WHERE tenant_id = $1', ['tenant-alpha-01']);
  assert.ok(q.rows.length >= 3);

  const macSet = new Set(q.rows.map((r) => r.watch_mac));
  assert.ok(macSet.has('F0:F5:BD:11:22:33'));
  assert.ok(macSet.has('F0:F5:BD:44:55:66'));
  assert.ok(macSet.has('F0:F5:BD:77:88:99'));

  // Rerun migration: should succeed without error or duplicate keys
  const report2 = await runMigration({
    dryRun: false,
    fixturePath: FIXTURE_PATH,
    tenantId: 'tenant-alpha-01',
    dbPool: pool
  });
  assert.equal(report2.totalDevices, 4);

  const qAfter = await pool.query('SELECT * FROM watches WHERE tenant_id = $1', ['tenant-alpha-01']);
  assert.equal(qAfter.rows.length, q.rows.length);
});

test('5. Legacy data preservation: unattributed legacy slots remain untouched and read-only', async () => {
  const report = await runMigration({
    dryRun: true,
    fixturePath: FIXTURE_PATH,
    tenantId: 'tenant-alpha-01'
  });

  const unattributed = report.details.unattributed;
  assert.equal(unattributed.length, 1);
  assert.equal(unattributed[0].legacySlotName, 'Node2');
  assert.equal(unattributed[0].telemetryChecksum, '9876543210fedcba');
  assert.equal(unattributed[0].telemetryCount, 45);
});
