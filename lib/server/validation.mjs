// lib/server/validation.mjs
// Input boundary validation for Architecture v2 API.

import crypto from 'node:crypto';
import { unprocessable } from './errors.mjs';

const MAC_REGEX = /^([0-9A-Fa-f]{2}:){5}([0-9A-Fa-f]{2})$/;
const ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const ALLOWED_METRIC_KEYS = new Set(['spo2', 'ecgHeartRate', 'ppgHeartRate', 'temperature', 'ecg_batch']);

/**
 * Validates and normalizes MAC address to uppercase canonical format (AA:BB:CC:DD:EE:FF).
 */
export function validateMac(mac) {
  if (typeof mac !== 'string' || !MAC_REGEX.test(mac.trim())) {
    throw unprocessable('Invalid MAC address format. Expected format: XX:XX:XX:XX:XX:XX', { field: 'watchMac', value: mac });
  }
  return mac.trim().toUpperCase();
}

/**
 * Validates identifier string.
 */
export function validateId(id, fieldName = 'id') {
  if (typeof id !== 'string' || !ID_REGEX.test(id.trim())) {
    throw unprocessable(`Invalid identifier format for ${fieldName}`, { field: fieldName, value: id });
  }
  return id.trim();
}

/**
 * Validates [from, to) time range.
 */
export function validateTimeRange(from, to, maxRangeMs = 30 * 24 * 3600 * 1000) {
  const fromNum = Number(from);
  const toNum = Number(to);

  if (!Number.isFinite(fromNum) || fromNum < 0) {
    throw unprocessable('Invalid "from" timestamp: must be a non-negative integer', { field: 'from', value: from });
  }
  if (!Number.isFinite(toNum) || toNum <= 0) {
    throw unprocessable('Invalid "to" timestamp: must be a positive integer', { field: 'to', value: to });
  }
  if (fromNum >= toNum) {
    throw unprocessable('Invalid time range: "from" must be strictly less than "to"', { from: fromNum, to: toNum });
  }
  if (toNum - fromNum > maxRangeMs) {
    throw unprocessable(`Time range exceeds maximum allowed window (${maxRangeMs} ms)`, { rangeMs: toNum - fromNum, maxRangeMs });
  }

  return { from: fromNum, to: toNum };
}

/**
 * Validates pagination parameters.
 */
export function validatePagination(cursor, limit, maxLimit = 100) {
  let parsedLimit = 50;
  if (limit !== undefined && limit !== null) {
    const n = parseInt(limit, 10);
    if (isNaN(n) || n < 1 || n > maxLimit) {
      throw unprocessable(`Invalid limit: must be between 1 and ${maxLimit}`, { field: 'limit', value: limit });
    }
    parsedLimit = n;
  }

  let parsedCursor = null;
  if (cursor !== undefined && cursor !== null && cursor !== '') {
    if (typeof cursor !== 'string') {
      throw unprocessable('Invalid cursor format', { field: 'cursor', value: cursor });
    }
    parsedCursor = cursor.trim();
  }

  return { cursor: parsedCursor, limit: parsedLimit };
}

/**
 * Validates metric keys filter allowlist.
 */
export function validateTelemetryKeys(keys) {
  if (!keys) return Array.from(ALLOWED_METRIC_KEYS);

  const list = Array.isArray(keys) ? keys : String(keys).split(',').map(s => s.trim()).filter(Boolean);
  for (const k of list) {
    if (!ALLOWED_METRIC_KEYS.has(k)) {
      throw unprocessable(`Unsupported telemetry key: "${k}"`, { allowedKeys: Array.from(ALLOWED_METRIC_KEYS), requestedKey: k });
    }
  }
  return list;
}

/**
 * Computes deterministic SHA-256 hash of a payload for idempotency key verification.
 */
export function computeRequestHash(payload) {
  const normalized = JSON.stringify(payload, Object.keys(payload || {}).sort());
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
