// lib/server/tbAdapter.mjs
// Server-side ThingsBoard Adapter for Architecture v2.

import { query } from './db.mjs';
import { notFound, badGateway } from './errors.mjs';

let mockTelemetryStore = new Map(); // For testing: key `${tbDeviceId}:${key}` -> [{ ts, value }]

export function setMockTelemetry(tbDeviceId, key, series) {
  mockTelemetryStore.set(`${tbDeviceId}:${key}`, series);
}

export function clearMockTelemetry() {
  mockTelemetryStore.clear();
}

/**
 * Resolves ThingsBoard device UUID for a watch MAC address within a tenant.
 */
export async function resolveWatchTbDeviceId(tenantId, watchMac) {
  const res = await query(
    `SELECT tb_device_id FROM watches WHERE tenant_id = $1 AND watch_mac = $2`,
    [tenantId, watchMac]
  );
  if (res.rowCount === 0 || !res.rows[0].tb_device_id) {
    // If not in registry yet, use a deterministic synthetic ID or throw notFound
    return `tb-dev-${watchMac.replace(/:/g, '').toLowerCase()}`;
  }
  return res.rows[0].tb_device_id;
}

/**
 * Fetches timeseries telemetry for a device from ThingsBoard REST or mock store.
 */
export async function fetchDeviceTelemetry({
  tenantId,
  tbDeviceId,
  keys = ['spo2', 'ecgHeartRate', 'ppgHeartRate', 'temperature', 'ecg_batch'],
  startTs,
  endTs,
  limit = 1000,
}) {
  // Test / Offline mode: read from mock store
  if (process.env.NODE_ENV === 'test' || !process.env.TB_BASE_URL) {
    const result = {};
    for (const k of keys) {
      const series = mockTelemetryStore.get(`${tbDeviceId}:${k}`) || [];
      // Filter by [startTs, endTs)
      result[k] = series
        .filter((item) => item.ts >= startTs && item.ts < endTs)
        .slice(0, limit);
    }
    return result;
  }

  // Live ThingsBoard REST call
  const baseUrl = process.env.TB_BASE_URL.replace(/\/$/, '');
  const url = `${baseUrl}/api/plugins/telemetry/DEVICE/${tbDeviceId}/values/timeseries?keys=${keys.join(',')}&startTs=${startTs}&endTs=${endTs}&limit=${limit}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Authorization': `Bearer ${process.env.TB_SERVER_JWT || ''}`,
      },
    });

    if (!response.ok) {
      throw badGateway(`ThingsBoard timeseries query failed with status ${response.status}`);
    }

    return await response.json();
  } catch (err) {
    if (err.status) throw err;
    throw badGateway(`Cannot reach ThingsBoard service: ${err.message}`);
  }
}
