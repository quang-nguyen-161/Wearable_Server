// pages/api/v1/patients/[patientId]/telemetry.js
// REST Endpoint for Querying Patient Telemetry History with Temporal Isolation (Architecture v2).

import { authenticateRequest, authorizeResourceAccess } from '../../../../../lib/server/auth.mjs';
import { getPatientTelemetry } from '../../../../../lib/server/history.mjs';
import { validatePagination } from '../../../../../lib/server/validation.mjs';
import { sendError, badRequest } from '../../../../../lib/server/errors.mjs';

export default async function handler(req, res) {
  try {
    const session = authenticateRequest(req);

    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
    }

    const { patientId, from, to, keys, assignmentId, cursor, limit } = req.query;

    if (!patientId) {
      throw badRequest('patientId parameter is required');
    }
    if (!from || !to) {
      throw badRequest('Both "from" and "to" query parameters are required');
    }

    const { limit: parsedLimit, cursor: parsedCursor } = validatePagination(cursor, limit);

    // Call history service with strict tenant and temporal containment
    const result = await getPatientTelemetry({
      tenantId: session.tenantId,
      patientId,
      assignmentId: assignmentId || null,
      keys: keys || undefined,
      from,
      to,
      limit: parsedLimit,
      cursor: parsedCursor,
    });

    return res.status(200).json(result);
  } catch (err) {
    return sendError(res, err, req);
  }
}
