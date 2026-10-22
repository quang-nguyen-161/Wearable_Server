// pages/api/patient.js
// Resolves patient info from active assignment in PostgreSQL assignment store.
// Eliminates dependence on slot-based SERVER_SCOPE patientName.

import { query } from "../../lib/server/db.mjs";
import { authenticateRequest } from "../../lib/server/auth.mjs";
import { sendError, unauthorized } from "../../lib/server/errors.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const deviceId = req.query.deviceId || process.env.TB_DEVICE_ID || null;
  if (!deviceId) return res.status(400).json({ error: "Missing deviceId", info: null });

  try {
    let tenantId = null;
    const hasAuth = req.headers?.authorization || req.headers?.['x-tb-token'];
    if (hasAuth) {
      const session = authenticateRequest(req);
      tenantId = session.tenantId;
    } else if (process.env.NODE_ENV === 'production') {
      throw unauthorized('Missing or malformed authorization header');
    } else {
      tenantId = req.query?.tenantId || null;
    }

    const normalizedDevice = String(deviceId).trim().toUpperCase();
    const asgnRes = await query(
      `SELECT a.assignment_id, a.valid_from, a.valid_to, p.patient_id, p.name as patient_name, p.mrn
       FROM assignments a
       JOIN patients p ON a.tenant_id = p.tenant_id AND a.patient_id = p.patient_id
       WHERE (a.watch_mac = $1 OR a.assignment_id = $2)
         AND (a.tenant_id = $3 OR $3 IS NULL)
         AND a.valid_to IS NULL
       ORDER BY a.valid_from DESC LIMIT 1`,
      [normalizedDevice, deviceId, tenantId]
    );

    if (asgnRes.rowCount > 0) {
      const row = asgnRes.rows[0];
      return res.status(200).json({
        info: {
          patientId: row.patient_id,
          patientName: row.patient_name,
          mrn: row.mrn,
          assignmentId: row.assignment_id,
          assignedSince: row.valid_from,
        }
      });
    }

    return res.status(200).json({ info: null, warning: "No active assignment for this watch" });
  } catch (err) {
    if (err.status) {
      return sendError(res, err, req);
    }
    console.error("[patient] Error:", err.message);
    return res.status(500).json({ info: null, error: err.message });
  }
}
