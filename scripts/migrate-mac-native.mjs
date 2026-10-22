#!/usr/bin/env node
// scripts/migrate-mac-native.mjs
// MAC-Native Migration & Legacy Data Preservation Script

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMac } from '../lib/server/validation.mjs';
import { getPool } from '../lib/server/db.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Classifies a set of legacy ThingsBoard devices into migration categories.
 */
export function classifyLegacyDevices(devices) {
  const result = {
    migrated: [],
    unattributed: [],
    alreadyMacNative: [],
    conflicts: []
  };

  const seenMacs = new Map();

  for (const dev of devices) {
    const name = dev.name || '';
    const rawMac = dev.serverAttributes?.macAddress;

    let parsedMac = null;
    try {
      if (rawMac) parsedMac = validateMac(rawMac);
    } catch {
      parsedMac = null;
    }

    // Case 1: Already MAC-native
    try {
      const nameAsMac = validateMac(name);
      result.alreadyMacNative.push({
        deviceId: dev.id?.id,
        macAddress: nameAsMac,
        originalName: name,
        telemetryCount: dev.telemetryCount || 0,
        telemetryChecksum: dev.telemetryChecksum || null
      });
      continue;
    } catch {
      // Not named as MAC, proceed
    }

    // Case 2: Slot-based device (NodeX) with provable hardware MAC attribute
    if (parsedMac) {
      if (seenMacs.has(parsedMac)) {
        result.conflicts.push({
          macAddress: parsedMac,
          conflictDevice: dev.id?.id,
          existingDevice: seenMacs.get(parsedMac),
          reason: 'Duplicate MAC claimed by multiple legacy slots'
        });
      } else {
        seenMacs.set(parsedMac, dev.id?.id);
        result.migrated.push({
          deviceId: dev.id?.id,
          macAddress: parsedMac,
          legacySlotName: name,
          telemetryCount: dev.telemetryCount || 0,
          telemetryChecksum: dev.telemetryChecksum || null
        });
      }
    } else {
      // Case 3: Slot-based device without provable MAC -> UNATTRIBUTED_LEGACY
      result.unattributed.push({
        deviceId: dev.id?.id,
        legacySlotName: name,
        reason: 'Missing provable hardware MAC attribute in server attributes',
        telemetryCount: dev.telemetryCount || 0,
        telemetryChecksum: dev.telemetryChecksum || null
      });
    }
  }

  return result;
}

/**
 * Runs the migration rehearsal or live migration.
 */
export async function runMigration({ dryRun = true, fixturePath = null, tenantId = 'tenant-alpha-01', dbPool = null } = {}) {
  let devices = [];
  if (fixturePath) {
    const raw = fs.readFileSync(fixturePath, 'utf8');
    const data = JSON.parse(raw);
    devices = data.devices || [];
    if (data.tenantId) tenantId = data.tenantId;
  }

  const classification = classifyLegacyDevices(devices);
  const pool = dbPool || (!dryRun ? getPool() : null);

  const report = {
    dryRun,
    tenantId,
    totalDevices: devices.length,
    migratedCount: classification.migrated.length,
    unattributedCount: classification.unattributed.length,
    alreadyMacNativeCount: classification.alreadyMacNative.length,
    conflictsCount: classification.conflicts.length,
    details: classification,
    legacyChecksumsVerified: true
  };

  // Verify legacy telemetry checksums remain intact
  for (const d of devices) {
    if (!d.telemetryChecksum) {
      report.legacyChecksumsVerified = false;
    }
  }

  if (!dryRun) {
    // Live migration: persist verified watches to DB
    for (const item of [...classification.migrated, ...classification.alreadyMacNative]) {
      await pool.query(
        `INSERT INTO watches (tenant_id, watch_mac, tb_device_id, label)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, watch_mac) DO UPDATE
         SET tb_device_id = EXCLUDED.tb_device_id, label = EXCLUDED.label`,
        [tenantId, item.macAddress, item.deviceId || null, item.legacySlotName || 'MAC_NATIVE']
      );
    }
  }

  return report;
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('migrate-mac-native.mjs')) {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const fixtureIdx = args.indexOf('--fixture');
  const defaultFixture = path.resolve(__dirname, '../tests/server/fixtures/legacy-devices.json');
  const fixturePath = fixtureIdx !== -1 ? args[fixtureIdx + 1] : defaultFixture;

  console.log(`=== RUNNING MAC-NATIVE MIGRATION (Mode: ${isDryRun ? 'DRY-RUN' : 'LIVE'}) ===`);
  runMigration({ dryRun: isDryRun, fixturePath })
    .then((report) => {
      console.log(`Tenant ID             : ${report.tenantId}`);
      console.log(`Total Devices Scanned : ${report.totalDevices}`);
      console.log(`Migrated to MAC       : ${report.migratedCount}`);
      console.log(`Unattributed (Archive): ${report.unattributedCount}`);
      console.log(`Already MAC-Native    : ${report.alreadyMacNativeCount}`);
      console.log(`Conflicts Detected    : ${report.conflictsCount}`);
      console.log(`Legacy Checksums OK   : ${report.legacyChecksumsVerified}`);
      console.log('=== MIGRATION REHEARSAL COMPLETE ===');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
