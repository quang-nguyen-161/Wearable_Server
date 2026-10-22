// lib/server/auth.mjs
// Authentication and Tenant/Customer ACL enforcement for Architecture v2 API.

import crypto from 'node:crypto';
import { unauthorized, forbidden } from './errors.mjs';

const NULL_CUSTOMER_ID = '13814000-1dd2-11b2-8080-808080808080';

/**
 * Resolves JWT secret with fail-closed security in production.
 */
export function getJwtSecret() {
  if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be set in production');
  }
  return process.env.JWT_SECRET || 'wearable-test-jwt-secret-key-32chars!!';
}

/**
 * Creates a signed JWT for testing or token minting.
 */
export function createSignedJwt(payload, secret = getJwtSecret()) {
  const effectiveSecret = secret || getJwtSecret();
  const header = { alg: 'HS256', typ: 'JWT' };
  const b64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
  const b64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', effectiveSecret)
    .update(`${b64Header}.${b64Payload}`)
    .digest('base64url');
  return `${b64Header}.${b64Payload}.${signature}`;
}

/**
 * Extracts Bearer token or ThingsBoard token from request headers.
 */
export function extractToken(req) {
  const authHeader = req?.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const tbHeader = req?.headers?.['x-tb-token'];
  if (tbHeader && typeof tbHeader === 'string') {
    return tbHeader.trim();
  }
  throw unauthorized('Missing or malformed authorization header');
}

/**
 * Verifies JWT signature and claims.
 */
export function verifyJwt(token, secret = getJwtSecret()) {
  const effectiveSecret = secret || getJwtSecret();
  if (!token || typeof token !== 'string') {
    throw unauthorized('Invalid token format');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw unauthorized('Malformed JWT token structure');
  }

  const [b64Header, b64Payload, signature] = parts;

  // Signature verification
  const expectedSignature = crypto
    .createHmac('sha256', effectiveSecret)
    .update(`${b64Header}.${b64Payload}`)
    .digest('base64url');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSignature);

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw unauthorized('Invalid token signature (token forged or secret mismatch)');
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(b64Payload, 'base64url').toString('utf8'));
  } catch {
    throw unauthorized('Invalid token payload encoding');
  }

  // Check expiration
  if (claims.exp && claims.exp * 1000 <= Date.now()) {
    throw unauthorized('Token has expired');
  }

  // Tenant claim is mandatory
  if (!claims.tenantId) {
    throw unauthorized('Token missing required tenantId claim');
  }

  const scopes = Array.isArray(claims.scopes) ? claims.scopes : [];
  const authority = scopes[0] || claims.authority || 'CUSTOMER_USER';
  const customerId = claims.customerId && claims.customerId !== NULL_CUSTOMER_ID ? claims.customerId : null;

  return {
    userId: claims.userId || claims.sub,
    username: claims.sub || claims.username,
    tenantId: claims.tenantId,
    customerId,
    authority,
    scopes,
  };
}

/**
 * Authenticates request and extracts verified caller session.
 */
export function authenticateRequest(req, secret = getJwtSecret()) {
  const effectiveSecret = secret || getJwtSecret();
  const token = extractToken(req);
  return verifyJwt(token, effectiveSecret);
}

/**
 * Enforces Tenant and Customer ACL on a resource.
 */
export function authorizeResourceAccess(session, resourceTenantId, resourceCustomerId = null) {
  if (!session || !session.tenantId) {
    throw unauthorized('Unauthenticated request');
  }

  // 1. Strict Tenant Isolation
  if (session.tenantId !== resourceTenantId) {
    throw forbidden('Cross-tenant access forbidden', {
      callerTenant: session.tenantId,
      resourceTenant: resourceTenantId,
    });
  }

  // 2. Customer User Scope Constraint
  if (session.authority === 'CUSTOMER_USER') {
    if (!session.customerId) {
      throw forbidden('Customer user has no assigned customerId');
    }
    if (resourceCustomerId && session.customerId !== resourceCustomerId) {
      throw forbidden('Access to resource belonging to another customer is forbidden', {
        callerCustomer: session.customerId,
        resourceCustomer: resourceCustomerId,
      });
    }
  }

  return true;
}
