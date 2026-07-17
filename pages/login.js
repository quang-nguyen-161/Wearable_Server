// pages/login.js
import { useState } from "react";
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

export default function LoginPage() {
  const { login } = useTbAuth();
  const router    = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error,    setError]    = useState(null);
  const [loading,  setLoading]  = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(username, password);
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
              <input
                type="password" value={password} onChange={e => setPassword(e.target.value)}
                required
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