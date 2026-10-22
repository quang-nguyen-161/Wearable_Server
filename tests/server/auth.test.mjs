// tests/server/auth.test.mjs
// Unit Tests for Architecture v2 Authentication, Validation, and Errors (TDD)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSignedJwt,
  extractToken,
  verifyJwt,
  authenticateRequest,
  authorizeResourceAccess,
  getJwtSecret,
} from '../../lib/server/auth.mjs';
import {
  validateMac,
  validateId,
  validateTimeRange,
  validatePagination,
  validateTelemetryKeys,
  computeRequestHash,
} from '../../lib/server/validation.mjs';
import {
  AppError,
  sendError,
  badRequest,
  unauthorized,
  forbidden,
  conflict,
} from '../../lib/server/errors.mjs';

const TEST_SECRET = 'test-secret-key-32-chars-long!!';

test('T11-AUTH-1: Missing or malformed authorization header throws 401', () => {
  assert.throws(
    () => extractToken({ headers: {} }),
    (err) => err instanceof AppError && err.status === 401 && err.code === 'UNAUTHORIZED'
  );

  assert.throws(
    () => extractToken({ headers: { authorization: 'Basic 12345' } }),
    (err) => err instanceof AppError && err.status === 401
  );
});

test('T11-AUTH-2: Valid token extraction and claim verification', () => {
  const token = createSignedJwt(
    {
      sub: 'doctor@hospital.org',
      tenantId: 'tenant-alpha',
      customerId: 'customer-10',
      scopes: ['CUSTOMER_USER'],
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    TEST_SECRET
  );

  const session = authenticateRequest(
    { headers: { authorization: `Bearer ${token}` } },
    TEST_SECRET
  );
  assert.equal(session.username, 'doctor@hospital.org');
  assert.equal(session.tenantId, 'tenant-alpha');
  assert.equal(session.customerId, 'customer-10');
  assert.equal(session.authority, 'CUSTOMER_USER');
});

test('T11-AUTH-3: Expired token throws 401', () => {
  const expiredToken = createSignedJwt(
    {
      sub: 'doctor@hospital.org',
      tenantId: 'tenant-alpha',
      exp: Math.floor(Date.now() / 1000) - 10, // 10 seconds in past
    },
    TEST_SECRET
  );

  assert.throws(
    () => verifyJwt(expiredToken, TEST_SECRET),
    (err) => err instanceof AppError && err.status === 401 && /expired/i.test(err.message)
  );
});

test('T11-AUTH-4: Forged token or wrong signature throws 401', () => {
  const forgedToken = createSignedJwt(
    { sub: 'hacker@bad.org', tenantId: 'tenant-alpha', exp: Math.floor(Date.now() / 1000) + 3600 },
    'wrong-secret-key-1234567890123'
  );

  assert.throws(
    () => verifyJwt(forgedToken, TEST_SECRET),
    (err) => err instanceof AppError && err.status === 401 && /signature/i.test(err.message)
  );
});

test('T11-AUTH-5: Cross-tenant access is strictly forbidden (403)', () => {
  const session = {
    tenantId: 'tenant-alpha',
    authority: 'TENANT_ADMIN',
  };

  // Attempt to access resource in tenant-beta
  assert.throws(
    () => authorizeResourceAccess(session, 'tenant-beta'),
    (err) => err instanceof AppError && err.status === 403 && err.code === 'FORBIDDEN'
  );

  // Same tenant allowed
  assert.equal(authorizeResourceAccess(session, 'tenant-alpha'), true);
});

test('T11-AUTH-6: Customer User restricted from other customers within same tenant (403)', () => {
  const customerSession = {
    tenantId: 'tenant-alpha',
    customerId: 'cust-10',
    authority: 'CUSTOMER_USER',
  };

  // Forbidden: accessing customer 20
  assert.throws(
    () => authorizeResourceAccess(customerSession, 'tenant-alpha', 'cust-20'),
    (err) => err instanceof AppError && err.status === 403
  );

  // Allowed: accessing own customer 10
  assert.equal(authorizeResourceAccess(customerSession, 'tenant-alpha', 'cust-10'), true);
});

test('T11-VAL-1: MAC address normalization and format validation', () => {
  assert.equal(validateMac('e4:5f:01:23:45:67'), 'E4:5F:01:23:45:67');
  assert.equal(validateMac(' E4:5F:01:23:45:67 '), 'E4:5F:01:23:45:67');

  assert.throws(() => validateMac('invalid-mac'), (err) => err.status === 422);
  assert.throws(() => validateMac('E4:5F:01:23:45'), (err) => err.status === 422);
  assert.throws(() => validateMac(null), (err) => err.status === 422);
});

test('T11-VAL-2: Time range validation and bounds checking', () => {
  const valid = validateTimeRange(1000, 2000);
  assert.equal(valid.from, 1000);
  assert.equal(valid.to, 2000);

  // Inverted range (from >= to)
  assert.throws(() => validateTimeRange(2000, 1000), (err) => err.status === 422);
  assert.throws(() => validateTimeRange(1000, 1000), (err) => err.status === 422);

  // Exceeds max range
  assert.throws(() => validateTimeRange(1000, 1000 + 31 * 86400 * 1000), (err) => err.status === 422);
});

test('T11-VAL-3: Telemetry key allowlist validation', () => {
  const keys = validateTelemetryKeys(['spo2', 'ecgHeartRate']);
  assert.deepEqual(keys, ['spo2', 'ecgHeartRate']);

  // Disallowed key
  assert.throws(
    () => validateTelemetryKeys(['spo2', 'unauthorized_internal_secret']),
    (err) => err.status === 422 && /Unsupported telemetry key/.test(err.message)
  );
});

test('T11-ERR-1: Standardized error envelope structure', () => {
  let capturedStatus = 0;
  let capturedJson = null;

  const mockRes = {
    status(s) {
      capturedStatus = s;
      return this;
    },
    json(j) {
      capturedJson = j;
      return this;
    },
  };

  const err = conflict('Assignment overlap detected', { overlapId: 'as-01' });
  sendError(mockRes, err, { headers: { 'x-request-id': 'req-test-999' } });

  assert.equal(capturedStatus, 409);
  assert.deepEqual(capturedJson, {
    error: {
      code: 'CONFLICT',
      message: 'Assignment overlap detected',
      details: { overlapId: 'as-01' },
      requestId: 'req-test-999',
    },
  });
});

test('T11-AUTH-7: Fail-closed JWT_SECRET enforcement in production', () => {
  const origEnv = process.env.NODE_ENV;
  const origSecret = process.env.JWT_SECRET;

  try {
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_SECRET;

    assert.throws(
      () => getJwtSecret(),
      (err) => err instanceof Error && /JWT_SECRET must be set in production/.test(err.message)
    );

    assert.throws(
      () => createSignedJwt({ sub: 'user1' }),
      (err) => err instanceof Error && /JWT_SECRET must be set in production/.test(err.message)
    );
  } finally {
    process.env.NODE_ENV = origEnv;
    if (origSecret !== undefined) {
      process.env.JWT_SECRET = origSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
  }
});
