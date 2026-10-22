// pages/api/v1/assignments/index.js
// REST Endpoint for Listing and Creating Patient Assignments (Architecture v2).

import { authenticateRequest, authorizeResourceAccess } from '../../../../lib/server/auth.mjs';
import { createAssignment, listAssignments } from '../../../../lib/server/assignments.mjs';
import { validatePagination, computeRequestHash } from '../../../../lib/server/validation.mjs';
import { sendError, badRequest, forbidden } from '../../../../lib/server/errors.mjs';

export default async function handler(req, res) {
  try {
    const session = authenticateRequest(req);

    if (req.method === 'GET') {
      const { watchMac, patientId, from, to, cursor, limit } = req.query;
      const { limit: parsedLimit } = validatePagination(cursor, limit);

      const result = await listAssignments({
        tenantId: session.tenantId,
        watchMac: watchMac || null,
        patientId: patientId || null,
        from: from || null,
        to: to || null,
        cursor: cursor || null,
        limit: parsedLimit,
      });

      return res.status(200).json(result);
    }

    if (req.method === 'POST') {
      if (session.authority !== 'TENANT_ADMIN') {
        throw forbidden('Only TENANT_ADMIN can create patient assignments');
      }

      const idempotencyKey = req.headers['idempotency-key'] || null;
      const requestHash = idempotencyKey ? computeRequestHash(req.body) : null;

      const {
        watchMac,
        patientId,
        validFrom,
        replacesAssignmentId,
        expectedVersion,
      } = req.body || {};

      if (!watchMac || !patientId) {
        throw badRequest('watchMac and patientId are required fields');
      }

      const { assignment, isReplay } = await createAssignment({
        tenantId: session.tenantId,
        actor: session.username || session.userId || 'user',
        watchMac,
        patientId,
        validFrom: validFrom || Date.now(),
        replacesAssignmentId: replacesAssignmentId || null,
        expectedVersion: expectedVersion !== undefined ? expectedVersion : null,
        idempotencyKey,
        requestHash,
      });

      if (isReplay) {
        res.setHeader('Idempotent-Replay', 'true');
      }

      return res.status(201).json(assignment);
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  } catch (err) {
    return sendError(res, err, req);
  }
}
