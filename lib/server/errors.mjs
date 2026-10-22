// lib/server/errors.mjs
// Standardized API error envelopes for Architecture v2.

import crypto from 'node:crypto';

export class AppError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function createError(code, message, status = 400, details = null) {
  return new AppError(code, message, status, details);
}

export function badRequest(message, details = null) {
  return new AppError('BAD_REQUEST', message, 400, details);
}

export function unauthorized(message = 'Authentication required', details = null) {
  return new AppError('UNAUTHORIZED', message, 401, details);
}

export function forbidden(message = 'Access denied', details = null) {
  return new AppError('FORBIDDEN', message, 403, details);
}

export function notFound(message = 'Resource not found', details = null) {
  return new AppError('NOT_FOUND', message, 404, details);
}

export function conflict(message = 'Resource conflict or concurrent modification', details = null) {
  return new AppError('CONFLICT', message, 409, details);
}

export function unprocessable(message = 'Validation failed', details = null) {
  return new AppError('UNPROCESSABLE_ENTITY', message, 422, details);
}

export function internal(message = 'Internal server error', details = null) {
  return new AppError('INTERNAL_ERROR', message, 500, details);
}

export function badGateway(message = 'Upstream service error', details = null) {
  return new AppError('BAD_GATEWAY', message, 502, details);
}

export function serviceUnavailable(message = 'Service temporarily unavailable', details = null) {
  return new AppError('SERVICE_UNAVAILABLE', message, 503, details);
}

/**
 * Sends a standardized JSON error response.
 * Guaranteed schema: { error: { code, message, details?, requestId } }
 */
export function sendError(res, err, req = null) {
  const requestId = req?.headers?.['x-request-id'] || crypto.randomUUID();
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'An unexpected error occurred';
  let details = undefined;

  if (err instanceof AppError) {
    status = err.status;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err.code === '23P01') { // PostgreSQL exclusion_violation
    status = 409;
    code = 'CONFLICT';
    message = 'Assignment interval overlaps with an existing record for this watch';
  } else if (err.code === '23505') { // PostgreSQL unique_violation
    status = 409;
    code = 'CONFLICT';
    message = 'Duplicate key violation';
  } else if (err.code === '23503') { // PostgreSQL foreign_key_violation
    status = 422;
    code = 'UNPROCESSABLE_ENTITY';
    message = 'Referenced entity (watch or patient) does not exist in tenant';
  } else if (err.code === '23514') { // PostgreSQL check_violation
    status = 422;
    code = 'UNPROCESSABLE_ENTITY';
    message = 'Invalid data: validFrom must be less than validTo';
  }

  const responseBody = {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      requestId,
    }
  };

  return res.status(status).json(responseBody);
}
