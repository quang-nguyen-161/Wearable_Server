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

export function TbAuthProvider({ children }) {
  const [token,   setToken]   = useState(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  // Restore token from sessionStorage on first load
  useEffect(() => {
    const saved  = sessionStorage.getItem(TOKEN_KEY);
    const expiry = sessionStorage.getItem(EXPIRY_KEY);
    if (saved && expiry && Date.now() < Number(expiry)) {
      setToken(saved);
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
    return jwt;
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(EXPIRY_KEY);
    setToken(null);
    router.push("/login");
  }, [router]);

  return (
    <TbAuthContext.Provider value={{ token, login, logout, loading }}>
      {children}
    </TbAuthContext.Provider>
  );
}

export function useTbAuth() {
  const ctx = useContext(TbAuthContext);
  if (!ctx) throw new Error("useTbAuth must be inside TbAuthProvider");
  return ctx;
}
