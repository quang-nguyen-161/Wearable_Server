// lib/server/freshness.mjs
// Stream-level and Aggregate Freshness Evaluation for Architecture v2.

import { query } from './db.mjs';
import { resolveWatchTbDeviceId, fetchDeviceTelemetry } from './tbAdapter.mjs';
import { validateMac } from './validation.mjs';

export const FRESHNESS_WINDOW_MS = 5000;

/**
 * Evaluates the freshness status of an individual stream sample against serverNow.
 */
export function evaluateStreamFreshness(latestSample, serverNow = Date.now(), revocationInfo = null, options = {}) {
  if (!latestSample || latestSample.ts === undefined || latestSample.ts === null) {
    return {
      status: 'UNKNOWN',
      ageMs: null,
      observedAt: null,
      reason: 'NO_DATA',
      timeQuality: 'UNKNOWN',
    };
  }

  const ts = Number(latestSample.ts);
  const timeQuality = latestSample.timeQuality || 'UNKNOWN';

  // Solution 3: Immediate Disconnect Latch via Gateway Attribute
  if (options && options.bleConnected === false) {
    return {
      status: 'STALE',
      ageMs: Math.max(0, serverNow - ts),
      observedAt: ts,
      reason: 'BLE_DISCONNECTED',
      timeQuality,
    };
  }

  // Solution 1: Local Reception Time Tracking
  // If local arrival time is provided (options.localArrivalMs), evaluate elapsed time on the local clock
  const windowMs = options?.freshnessWindowMs || FRESHNESS_WINDOW_MS;
  if (options && options.localArrivalMs !== undefined && options.localArrivalMs !== null) {
    const localElapsed = serverNow - options.localArrivalMs;
    if (localElapsed >= 0 && localElapsed < windowMs) {
      return {
        status: 'LIVE',
        ageMs: localElapsed,
        observedAt: ts,
        reason: 'LOCAL_RECEPTION_FRESH',
        timeQuality,
      };
    }
  }

  // 1. Time Synchronization check: unsynced frames can never be LIVE
  if (timeQuality !== 'SYNCED') {
    return {
      status: 'UNKNOWN',
      ageMs: null,
      observedAt: ts,
      reason: 'UNSYNCHRONIZED_TIME',
      timeQuality,
    };
  }

  const ageMs = serverNow - ts;

  // 2. Future timestamp check: clock skew / future sample can never be LIVE
  if (ageMs < 0) {
    return {
      status: 'UNKNOWN',
      ageMs,
      observedAt: ts,
      reason: 'FUTURE_TIMESTAMP',
      timeQuality,
    };
  }

  // 3. Revocation check: if link disconnected for same session after sample was received
  if (
    revocationInfo &&
    revocationInfo.sessionId !== undefined &&
    latestSample.sessionId !== undefined &&
    revocationInfo.sessionId === latestSample.sessionId &&
    revocationInfo.revokedAt >= ts
  ) {
    return {
      status: 'STALE',
      ageMs,
      observedAt: ts,
      reason: 'SESSION_REVOKED',
      timeQuality,
    };
  }

  // 4. Exact 5000ms boundary check: [0, 5000) is LIVE, >= 5000 is STALE
  if (ageMs < FRESHNESS_WINDOW_MS) {
    return {
      status: 'LIVE',
      ageMs,
      observedAt: ts,
      reason: 'FRESH',
      timeQuality,
    };
  }

  return {
    status: 'STALE',
    ageMs,
    observedAt: ts,
    reason: 'FRESHNESS_EXPIRED',
    timeQuality,
  };
}

/**
 * Computes aggregate device health from individual stream statuses.
 */
export function computeAggregateStatus(streams) {
  const ecgLive = streams.ecg?.status === 'LIVE';
  const spo2Live = streams.spo2?.status === 'LIVE';

  if (ecgLive && spo2Live) {
    return 'LIVE';
  }
  if (ecgLive || spo2Live) {
    return 'PARTIAL';
  }

  const anyStale =
    streams.ecg?.status === 'STALE' ||
    streams.spo2?.status === 'STALE' ||
    streams.temperature?.status === 'STALE';

  if (anyStale) {
    return 'STALE';
  }

  return 'UNKNOWN';
}

/**
 * Retrieves full watch status with current assignment and per-stream freshness.
 */
export async function getWatchStatus(tenantId, watchMac, serverNow = Date.now()) {
  const mac = validateMac(watchMac);
  const tbDeviceId = await resolveWatchTbDeviceId(tenantId, mac);

  // 1. Fetch current open assignment if any
  const asgnRes = await query(
    `SELECT * FROM assignments
     WHERE tenant_id = $1 AND watch_mac = $2 AND valid_to IS NULL
     ORDER BY valid_from DESC LIMIT 1`,
    [tenantId, mac]
  );
  const currentAssignment = asgnRes.rowCount > 0 ? asgnRes.rows[0] : null;

  // 2. Fetch latest telemetry for streams including timeQuality
  const telemetry = await fetchDeviceTelemetry({
    tenantId,
    tbDeviceId,
    keys: ['spo2', 'ecgHeartRate', 'ppgHeartRate', 'temperature', 'ecg_batch', 'timeQuality'],
    startTs: serverNow - 60000, // Look back up to 1 minute
    endTs: serverNow + 1000,
    limit: 10,
  });

  const latestTimeQuality = (telemetry.timeQuality || []).sort((a, b) => b.ts - a.ts)[0]?.value;

  const latestSpo2 = (telemetry.spo2 || []).sort((a, b) => b.ts - a.ts)[0] || null;
  const latestEcg = (telemetry.ecg_batch || telemetry.ecgHeartRate || []).sort((a, b) => b.ts - a.ts)[0] || null;
  const latestTemp = (telemetry.temperature || []).sort((a, b) => b.ts - a.ts)[0] || null;

  if (latestSpo2 && !latestSpo2.timeQuality && latestTimeQuality) {
    latestSpo2.timeQuality = latestTimeQuality;
  }
  if (latestEcg && !latestEcg.timeQuality && latestTimeQuality) {
    latestEcg.timeQuality = latestTimeQuality;
  }
  if (latestTemp && !latestTemp.timeQuality && latestTimeQuality) {
    latestTemp.timeQuality = latestTimeQuality;
  }

  // Evaluate each stream
  const ecgStream = evaluateStreamFreshness(latestEcg, serverNow);
  const spo2Stream = evaluateStreamFreshness(latestSpo2, serverNow);
  const tempStream = evaluateStreamFreshness(latestTemp, serverNow);

  const streams = {
    ecg: ecgStream,
    spo2: spo2Stream,
    temperature: tempStream,
  };

  const aggregateStatus = computeAggregateStatus(streams);

  return {
    watchMac: mac,
    tbDeviceId,
    currentAssignment,
    aggregateStatus,
    streams,
    linkHint: {
      bleConnected: aggregateStatus === 'LIVE' || aggregateStatus === 'PARTIAL',
    },
    serverNow,
  };
}

/**
 * Lists all watches in a tenant with their computed statuses.
 */
export async function listWatchStatuses(tenantId, serverNow = Date.now(), limit = 50) {
  const res = await query(
    `SELECT * FROM watches WHERE tenant_id = $1 ORDER BY watch_mac ASC LIMIT $2`,
    [tenantId, limit]
  );

  const statuses = await Promise.all(
    res.rows.map((w) => getWatchStatus(tenantId, w.watch_mac, serverNow))
  );

  return {
    data: statuses,
    nextCursor: null,
    serverNow,
  };
}
