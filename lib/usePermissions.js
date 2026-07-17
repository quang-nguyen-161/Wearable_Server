// lib/usePermissions.js
// Resolves the current user's feature permissions for the Settings page.
// TENANT_ADMIN (dashboard operator) always gets full access. CUSTOMER_USER
// accounts are gated by the permissions stored on their Customer entity.

import { useState, useEffect } from "react";
import { useTbAuth } from "../context/TbAuthContext";
import { getCustomerAttributes } from "./tbBrowserClient";
import { DEFAULT_PERMISSIONS, parsePermissions } from "./permissions";

export function usePermissions() {
  const { token, authority, customerId } = useTbAuth();
  const [permissions, setPermissions] = useState(DEFAULT_PERMISSIONS);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) return;

    // Tenant admins always have full access — no lookup needed.
    if (authority !== "CUSTOMER_USER") {
      setPermissions(DEFAULT_PERMISSIONS);
      return;
    }

    if (!customerId) {
      setPermissions(DEFAULT_PERMISSIONS);
      return;
    }

    let cancelled = false;
    setLoading(true);
    getCustomerAttributes(token, customerId)
      .then(attrs => { if (!cancelled) setPermissions(parsePermissions(attrs)); })
      .catch(e => {
        console.error("[usePermissions] failed to load, defaulting to full access:", e);
        if (!cancelled) setPermissions(DEFAULT_PERMISSIONS);
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [token, authority, customerId]);

  return { permissions, loading };
}