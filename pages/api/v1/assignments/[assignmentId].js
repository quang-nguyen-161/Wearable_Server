// pages/api/v1/assignments/[assignmentId].js
// REST Endpoint for Retrieving and Closing an Assignment (Architecture v2).

import { authenticateRequest } from '../../../../lib/server/auth.mjs';
import { getAssignmentById, closeAssignment } from '../../../../lib/server/assignments.mjs';
import { computeRequestHash, validateId } from '../../../../lib/server/validation.mjs';
import { sendError, badRequest, forbidden } from '../../../../lib/server/errors.mjs';

export default async function handler(req, res) {
  try {
    const session = authenticateRequest(req);
    const { assignmentId } = req.query;

    if (!assignmentId) {
      throw badRequest('assignmentId parameter is required');
    }
    const validatedId = validateId(assignmentId, 'assignmentId');

    if (req.method === 'GET') {
      const assignment = await getAssignmentById({
        tenantId: session.tenantId,
        assignmentId: validatedId,
      });
      return res.status(200).json(assignment);
    }

    if (req.method === 'PATCH') {
      if (session.authority !== 'TENANT_ADMIN') {
        throw forbidden('Only TENANT_ADMIN can modify or close patient assignments');
      }

      const idempotencyKey = req.headers['idempotency-key'] || null;
      const requestHash = idempotencyKey ? computeRequestHash(req.body) : null;

      const { validTo, expectedVersion } = req.body || {};

      if (expectedVersion === undefined || expectedVersion === null) {
        throw badRequest('expectedVersion is required for closing an assignment');
      }

      const { assignment, isReplay } = await closeAssignment({
        tenantId: session.tenantId,
        actor: session.username || session.userId || 'user',
        assignmentId: validatedId,
        validTo: validTo || Date.now(),
        expectedVersion: Number(expectedVersion),
        idempotencyKey,
        requestHash,
      });

      if (isReplay) {
        res.setHeader('Idempotent-Replay', 'true');
      }

      return res.status(200).json(assignment);
    }

    res.setHeader('Allow', 'GET, PATCH');
    return res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  } catch (err) {
    return sendError(res, err, req);
  }
}
