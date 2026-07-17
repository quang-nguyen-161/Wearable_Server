// context/TbAuthContext.js
// Browser-side ThingsBoard authentication.
// The login page calls login() which POSTs directly from the browser to TB,
// passing Cloudflare's challenge that blocks server-to-server requests.
// JWT stored in sessionStorage (cleared on tab close).

import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";

const TB_URL     = process.env.NEXT_PUBLIC_TB_BASE_URL?.replace(/\/$/, "");
const TOKEN_KEY  = "tb_token";
const EXPIRY_KEY = "tb_token_expiry";

const TbAuthContext = createContext(null);

// ThingsBoard JWTs are standard base64url JWTs — decode the payload locally,
// no network call needed. Carries: authority ("TENANT_ADMIN" | "CUSTOMER_USER"
// | "SYS_ADMIN"), userId, customerId, tenantId, etc.
function decodeTbJwt(jwt) {
  try {
    const payload = jwt.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(decodeURIComponent(escape(json)));
    // TB puts the role in a "scopes" array (e.g. ["CUSTOMER_USER"]), not "authority"
    const scopes = Array.isArray(claims.scopes) ? claims.scopes : [];
    return {
      authority:  scopes[0]      ?? null,
      userId:     claims.userId  ?? null,
      customerId: claims.customerId ?? null, // "13814000-1dd2-11b2-8080-808080808080" = "not set" sentinel
      username:   claims.sub     ?? null,     // TB stores email/username in "sub"
    };
  } catch {
    return { authority: null, userId: null, customerId: null, username: null };
  }
}

// TB uses this all-zero-ish UUID to mean "no customer" (e.g. for tenant admins)
const NULL_CUSTOMER_ID = "13814000-1dd2-11b2-8080-808080808080";

export function TbAuthProvider({ children }) {
  const [token,      setToken]      = useState(null);
  const [authority,  setAuthority]  = useState(null);
  const [customerId, setCustomerId] = useState(null);
  const [username,   setUsername]   = useState(null);
  const [loading,    setLoading]    = useState(true);
  const router = useRouter();

  // Restore token from sessionStorage on first load
  useEffect(() => {
    const saved  = sessionStorage.getItem(TOKEN_KEY);
    const expiry = sessionStorage.getItem(EXPIRY_KEY);
    if (saved && expiry && Date.now() < Number(expiry)) {
      setToken(saved);
      const claims = decodeTbJwt(saved);
      setAuthority(claims.authority);
      setCustomerId(claims.customerId && claims.customerId !== NULL_CUSTOMER_ID ? claims.customerId : null);
      setUsername(claims.username);
    }
    setLoading(false);
  }, []);

  const login = useCallback(async (username, password) => {
    const res = await fetch(`${TB_URL}/api/auth/login`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const text = await res.text();
      // Cloudflare challenge returns HTML — give a clear message
      const msg = text.includes("DOCTYPE")
        ? "Cannot reach the server. Open the server URL in a new tab first, then try again."
        : `Login failed (${res.status})`;
      throw new Error(msg);
    }
    const { token: jwt } = await res.json();
    const expiresAt = Date.now() + 2.5 * 60 * 60 * 1000; // TB tokens last ~2.5h
    sessionStorage.setItem(TOKEN_KEY,  jwt);
    sessionStorage.setItem(EXPIRY_KEY, String(expiresAt));
    setToken(jwt);
    const claims = decodeTbJwt(jwt);
    setAuthority(claims.authority);
    setCustomerId(claims.customerId && claims.customerId !== NULL_CUSTOMER_ID ? claims.customerId : null);
    setUsername(claims.username);
    return jwt;
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(EXPIRY_KEY);
    setToken(null);
    setAuthority(null);
    setCustomerId(null);
    setUsername(null);
    router.push("/login");
  }, [router]);

  return (
    <TbAuthContext.Provider value={{ token, authority, customerId, username, login, logout, loading }}>
      {children}
    </TbAuthContext.Provider>
  );
}

export function useTbAuth() {
  const ctx = useContext(TbAuthContext);
  if (!ctx) throw new Error("useTbAuth must be inside TbAuthProvider");
  return ctx;
}