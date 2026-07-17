// pages/login.js
import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import { useTbAuth } from "../context/TbAuthContext";

// Backend errors can include internal API paths/status codes — never show
// those directly to the user. Map them to generic, user-facing messages.
function friendlyLoginError(err) {
  const msg = String(err?.message || "");
  if (/\(401\)/.test(msg) || /invalid/i.test(msg) || /credentials/i.test(msg)) {
    return "Incorrect email or password.";
  }
  if (/\(403\)/.test(msg)) {
    return "Your account doesn't have access. Contact your administrator.";
  }
  if (/\(4\d\d\)/.test(msg)) {
    return "Couldn't sign in. Please check your details and try again.";
  }
  if (/failed to fetch|network|timeout/i.test(msg)) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  return "Something went wrong signing in. Please try again.";
}

const REMEMBER_KEY = "wearabledev_remembered_email";

export default function LoginPage() {
  const { login } = useTbAuth();
  const router    = useRouter();
  const [username, setUsername]     = useState("");
  const [password, setPassword]     = useState("");
  const [error,    setError]        = useState(null);
  const [loading,  setLoading]      = useState(false);
  const [remember, setRemember]     = useState(true);
  const [showPassword, setShowPassword] = useState(false);

  // Prefill the last signed-in email, if the user opted to be remembered.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(REMEMBER_KEY);
      if (saved) {
        setUsername(saved);
        setRemember(true);
      } else {
        setRemember(false);
      }
    } catch {
      // localStorage unavailable (e.g. private browsing) — just skip prefill.
    }
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(username, password);
      try {
        if (remember) {
          window.localStorage.setItem(REMEMBER_KEY, username.trim());
        } else {
          window.localStorage.removeItem(REMEMBER_KEY);
        }
      } catch {
        // Ignore storage errors — remembering the email is a nice-to-have.
      }
      router.push("/");
    } catch (err) {
      console.error("[login] auth failed:", err);
      setError(friendlyLoginError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Head>
        <title>Sign In — WearableDev</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div style={{
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        background: "var(--bg-void, #f8fafc)", fontFamily: "'Inter', system-ui, sans-serif",
        padding: 16,
      }}>
        <div style={{
          background: "var(--bg-card, #fff)", borderRadius: 16,
          border: "0.5px solid var(--border, #e2e8f0)",
          width: "100%", maxWidth: 380,
          boxShadow: "0 4px 24px rgba(0,0,0,0.07)",
          padding: "32px 28px",
        }}>

          {/* Brand */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8, background: "rgba(0,200,255,0.1)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M3 12h3l3-9 3 18 3-9h3" stroke="#00c8ff" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary, #1e293b)" }}>
                WearableDev
              </div>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.1em",
                color: "var(--text-muted, #94a3b8)" }}>
                HEALTH MONITOR
              </div>
            </div>
          </div>

          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em",
                color: "var(--text-muted, #94a3b8)", display: "block", marginBottom: 6 }}>
                EMAIL
              </label>
              <input
                type="email" value={username} onChange={e => setUsername(e.target.value)}
                required autoFocus
                placeholder="you@example.com"
                style={{
                  width: "100%", boxSizing: "border-box",
                  padding: "10px 12px", borderRadius: 8,
                  border: "1px solid var(--border, #e2e8f0)",
                  background: "var(--bg-void, #f8fafc)",
                  color: "var(--text-primary, #1e293b)",
                  fontSize: 14, fontFamily: "inherit", outline: "none",
                  transition: "border 0.15s",
                }}
                onFocus={e => e.target.style.borderColor = "#00c8ff"}
                onBlur={e => e.target.style.borderColor = "var(--border, #e2e8f0)"}
              />
            </div>

            <div>
              <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em",
                color: "var(--text-muted, #94a3b8)", display: "block", marginBottom: 6 }}>
                PASSWORD
              </label>
              <div style={{ position: "relative" }}>
                <input
                  type={showPassword ? "text" : "password"}
                  value={password} onChange={e => setPassword(e.target.value)}
                  required
                  style={{
                    width: "100%", boxSizing: "border-box",
                    padding: "10px 40px 10px 12px", borderRadius: 8,
                    border: "1px solid var(--border, #e2e8f0)",
                    background: "var(--bg-void, #f8fafc)",
                    color: "var(--text-primary, #1e293b)",
                    fontSize: 14, fontFamily: "inherit", outline: "none",
                    transition: "border 0.15s",
                  }}
                  onFocus={e => e.target.style.borderColor = "#00c8ff"}
                  onBlur={e => e.target.style.borderColor = "var(--border, #e2e8f0)"}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  title={showPassword ? "Hide password" : "Show password"}
                  style={{
                    position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)",
                    width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center",
                    background: "none", border: "none", cursor: "pointer",
                    color: "var(--text-muted, #94a3b8)", borderRadius: 6,
                  }}
                >
                  {showPassword ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <path d="M3 3l18 18M10.6 10.6a2.5 2.5 0 003.53 3.53M9.36 5.6A10.4 10.4 0 0112 5.5c5.5 0 9 5 9 6.5a10.9 10.9 0 01-3.06 3.65M6.4 6.9C3.9 8.5 2.5 11 2.5 12c1 1.6 3.2 4 5.9 5.2a10.4 10.4 0 003.6.8"
                        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"
                        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      <circle cx="12" cy="12" r="2.75" stroke="currentColor" strokeWidth="1.6" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            <label style={{
              display: "flex", alignItems: "center", gap: 8, fontSize: 12,
              color: "var(--text-muted, #94a3b8)", cursor: "pointer", userSelect: "none",
            }}>
              <input
                type="checkbox"
                checked={remember}
                onChange={e => setRemember(e.target.checked)}
                style={{ cursor: "pointer" }}
              />
              Remember me
            </label>

            {error && (
              <div style={{
                background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
                borderRadius: 8, padding: "10px 12px",
                fontSize: 12, color: "#ef4444", lineHeight: 1.4,
              }}>
                {error}
              </div>
            )}

            <button
              type="submit" disabled={loading}
              style={{
                padding: "11px", borderRadius: 8, border: "none",
                background: loading ? "#94a3b8" : "#00c8ff",
                color: "#fff", fontWeight: 700, fontSize: 13,
                letterSpacing: "0.06em", cursor: loading ? "not-allowed" : "pointer",
                fontFamily: "inherit", marginTop: 4,
                transition: "background 0.15s",
              }}
            >
              {loading ? "SIGNING IN…" : "SIGN IN"}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}