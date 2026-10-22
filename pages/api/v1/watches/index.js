// pages/api/v1/watches/index.js
// REST Endpoint for Listing Registered Watches with Freshness Status (Architecture v2).

import { authenticateRequest } from '../../../../lib/server/auth.mjs';
import { listWatchStatuses } from '../../../../lib/server/freshness.mjs';
import { validatePagination } from '../../../../lib/server/validation.mjs';
import { sendError } from '../../../../lib/server/errors.mjs';

export default async function handler(req, res) {
  try {
    const session = authenticateRequest(req);

    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
    }

    const { cursor, limit } = req.query;
    const { limit: parsedLimit } = validatePagination(cursor, limit);

    const result = await listWatchStatuses(session.tenantId, Date.now(), parsedLimit);

    return res.status(200).json(result);
  } catch (err) {
    return sendError(res, err, req);
  }
}
