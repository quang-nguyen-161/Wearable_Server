// lib/server/history.mjs
// Patient Telemetry History with Temporal Interval Join and ECG Sample Clipping.

import { query } from './db.mjs';
import { resolveWatchTbDeviceId, fetchDeviceTelemetry } from './tbAdapter.mjs';
import { validateId, validateTimeRange, validateTelemetryKeys, validatePagination } from './validation.mjs';

/**
 * Retrieves telemetry for a patient strictly bounded by assignment validity intervals.
 */
export async function getPatientTelemetry({
  tenantId,
  patientId,
  assignmentId = null,
  keys = ['spo2', 'ecgHeartRate', 'ppgHeartRate', 'temperature', 'ecg_batch'],
  from,
  to,
  limit = 100,
  cursor = null,
}) {
  const pId = validateId(patientId, 'patientId');
  const { from: fromTs, to: toTs } = validateTimeRange(from, to);
  const validatedKeys = validateTelemetryKeys(keys);

  // 1. Query all assignments for this patient intersecting [from, to)
  let sql = `SELECT * FROM assignments
             WHERE tenant_id = $1 AND patient_id = $2
               AND (valid_to IS NULL OR valid_to > $3)
               AND valid_from < $4`;
  const params = [tenantId, pId, fromTs, toTs];

  if (assignmentId) {
    params.push(assignmentId);
    sql += ` AND assignment_id = $${params.length}`;
  }

  sql += ` ORDER BY valid_from ASC`;
  const assignmentRes = await query(sql, params);
  const assignments = assignmentRes.rows;

  if (assignments.length === 0) {
    return {
      data: [],
      nextCursor: null,
      serverNow: Date.now(),
    };
  }

  const allSamples = [];

  // 2. Fetch and filter telemetry for each matching assignment
  for (const asgn of assignments) {
    const asgnFrom = Math.max(fromTs, Number(asgn.valid_from));
    const asgnTo = asgn.valid_to !== null ? Math.min(toTs, Number(asgn.valid_to)) : toTs;

    if (asgnFrom >= asgnTo) continue;

    const tbDeviceId = await resolveWatchTbDeviceId(tenantId, asgn.watch_mac);
    const rawTelemetry = await fetchDeviceTelemetry({
      tenantId,
      tbDeviceId,
      keys: validatedKeys,
      startTs: asgnFrom,
      endTs: asgnTo + 5000, // Fetch slightly beyond to capture any multi-sample batch spanning boundary
      limit: 1000,
    });

    // Process each requested key
    for (const key of validatedKeys) {
      const items = rawTelemetry[key] || [];

      if (key === 'ecg_batch') {
        // Unpack ECG batch and clip individual samples
        for (const item of items) {
          const batchEndTs = item.ts;
          let samples = [];
          try {
            samples = typeof item.value === 'string' ? JSON.parse(item.value) : item.value;
          } catch {
            continue;
          }

          if (!Array.isArray(samples) || samples.length === 0) continue;

          const samplePeriodMs = item.samplePeriodMs || 4; // 250 Hz default
          const sampleCount = samples.length;

          // Check each sample in batch
          const clippedSamples = [];
          for (let i = 0; i < sampleCount; i++) {
            const sampleTs = batchEndTs - (sampleCount - 1 - i) * samplePeriodMs;
            // Strict interval containment: [asgn.valid_from, asgn.valid_to) && [fromTs, toTs)
            const inAssignment = sampleTs >= Number(asgn.valid_from) &&
              (asgn.valid_to === null || sampleTs < Number(asgn.valid_to));
            const inQueryWindow = sampleTs >= fromTs && sampleTs < toTs;

            if (inAssignment && inQueryWindow) {
              clippedSamples.push({ ts: sampleTs, ecg_val: samples[i] });
            }
          }

          if (clippedSamples.length > 0) {
            const batchEnd = clippedSamples[clippedSamples.length - 1].ts;
            allSamples.push({
              assignmentId: asgn.assignment_id,
              watchMac: asgn.watch_mac,
              observedAt: batchEnd,
              metric: 'ecg_batch',
              values: {
                samples: clippedSamples.map(s => s.ecg_val),
                sampleCount: clippedSamples.length,
                samplePeriodMs,
                startTs: clippedSamples[0].ts,
                endTs: batchEnd,
              },
              quality: 'CENTRAL_RX_ESTIMATE',
            });
          }
        }
      } else {
        // Scalar telemetry (spo2, heart rates, temp)
        for (const item of items) {
          const sampleTs = Number(item.ts);
          const inAssignment = sampleTs >= Number(asgn.valid_from) &&
            (asgn.valid_to === null || sampleTs < Number(asgn.valid_to));
          const inQueryWindow = sampleTs >= fromTs && sampleTs < toTs;

          if (inAssignment && inQueryWindow) {
            allSamples.push({
              assignmentId: asgn.assignment_id,
              watchMac: asgn.watch_mac,
              observedAt: sampleTs,
              metric: key,
              values: { [key]: item.value },
              quality: 'SYNCED',
            });
          }
        }
      }
    }
  }

  // 3. Sort by observedAt ASC
  allSamples.sort((a, b) => a.observedAt - b.observedAt);

  // Apply limit
  const pagedData = allSamples.slice(0, limit);

  return {
    data: pagedData,
    nextCursor: allSamples.length > limit ? String(pagedData[pagedData.length - 1].observedAt) : null,
    serverNow: Date.now(),
  };
}
