// components/AssignModal.js
// Admin-only modal for assigning a customer user:
// 1) Account & password
// 2) Node assignment (which devices this user can see)
// 3) Permissions (placeholder — not wired up yet)
//
// On submit: creates a new ThingsBoard Customer, creates a CUSTOMER_USER
// under it, sets the password via the activation-link flow (no email step),
// then assigns the selected devices to that customer.

import { useState, useEffect } from "react";
import {
  createCustomer,
  createCustomerUser,
  getUserActivationLink,
  activateUser,
  assignDeviceToCustomer,
} from "../lib/tbBrowserClient";

function extractActivateToken(link) {
  try {
    const url = new URL(link);
    return url.searchParams.get("activateToken");
  } catch {
    const match = String(link || "").match(/activateToken=([^&\s]+)/);
    return match ? match[1] : null;
  }
}

export default function AssignModal({ token, devices, onClose, onAssigned }) {
  const [username,      setUsername]      = useState("");
  const [password,      setPassword]      = useState("");
  const [selectedNodes, setSelectedNodes] = useState([]);
  const [saving,        setSaving]        = useState(false);
  const [msg,           setMsg]           = useState(null);

  useEffect(() => {
    const fn = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  const toggleNode = (id) => {
    setSelectedNodes(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleSubmit = async () => {
    const email = username.trim();
    if (!email)            { setMsg({ type: "err", text: "Account (email/username) is required." }); return; }
    if (!password.trim())  { setMsg({ type: "err", text: "Password is required." }); return; }
    if (selectedNodes.length === 0) { setMsg({ type: "err", text: "Assign at least one node." }); return; }

    setSaving(true);
    setMsg(null);
    try {
      setMsg({ type: "info", text: "Creating customer…" });
      const customer = await createCustomer(token, email);
      const customerId = customer.id.id;

      setMsg({ type: "info", text: "Creating user…" });
      const user = await createCustomerUser(token, customerId, email);
      const userId = user.id.id;

      setMsg({ type: "info", text: "Setting password…" });
      const link = await getUserActivationLink(token, userId);
      const activateToken = extractActivateToken(link);
      if (!activateToken) throw new Error("Could not read activation token from ThingsBoard's response.");
      await activateUser(activateToken, password);

      setMsg({ type: "info", text: "Assigning nodes…" });
      for (const deviceId of selectedNodes) {
        await assignDeviceToCustomer(token, customerId, deviceId);
      }

      setMsg({ type: "ok", text: `"${email}" created and assigned ${selectedNodes.length} node(s) ✓` });
      onAssigned?.();
      setTimeout(onClose, 900);
    } catch (e) {
      setMsg({ type: "err", text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const sectionLabelStyle = {
    fontSize: 11, fontWeight: 700, color: "var(--text-muted,#64748b)",
    letterSpacing: "0.06em", marginBottom: 8,
  };
  const inputStyle = {
    width: "100%", boxSizing: "border-box", padding: "9px 12px", borderRadius: 8,
    border: "1.5px solid var(--border,#e2e8f0)", background: "var(--bg-void,#f8fafc)",
    color: "var(--text-primary,#1e293b)", fontSize: 14, fontWeight: 600,
    outline: "none", fontFamily: "inherit",
  };

  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: 16, backdropFilter: "blur(3px)" }}>
      <div style={{ background: "var(--bg-card,#fff)", borderRadius: 16,
        border: "0.5px solid var(--border,#e2e8f0)", width: "100%", maxWidth: 480,
        maxHeight: "90vh", overflowY: "auto", animation: "assign-in .18s ease" }}
        onClick={e => e.stopPropagation()}>
        <style>{`@keyframes assign-in{from{opacity:0;transform:scale(.96) translateY(6px)}to{opacity:1;transform:scale(1) translateY(0)}}`}</style>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 20px", borderBottom: "0.5px solid var(--border,#e2e8f0)",
          position: "sticky", top: 0, background: "var(--bg-card,#fff)", zIndex: 2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(91,155,213,0.12)",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>👤</div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary,#1e293b)" }}>Assign User</div>
              <div style={{ fontSize: 11, color: "var(--text-muted,#94a3b8)" }}>Create an account and assign nodes</div>
            </div>
          </div>
          <button onClick={onClose} style={{ fontSize: 22, background: "none", border: "none",
            cursor: "pointer", color: "var(--text-muted,#94a3b8)", padding: "4px 8px",
            borderRadius: 6, fontFamily: "inherit" }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: "16px 20px 20px", display: "flex", flexDirection: "column", gap: 18 }}>

          {/* ── Section 1: Account & password ── */}
          <div>
            <div style={sectionLabelStyle}>ACCOUNT &amp; PASSWORD</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input
                autoFocus
                type="text"
                placeholder="Email or username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                style={inputStyle}
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                style={inputStyle}
              />
            </div>
          </div>

          {/* ── Section 2: Node assignment ── */}
          <div>
            <div style={sectionLabelStyle}>ASSIGN NODES</div>
            {devices.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-muted,#94a3b8)" }}>No nodes available.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 180, overflowY: "auto" }}>
                {devices.map(d => (
                  <label key={d.id} style={{ display: "flex", alignItems: "center", gap: 8,
                    padding: "7px 10px", borderRadius: 8,
                    border: "1px solid var(--border,#e2e8f0)",
                    background: selectedNodes.includes(d.id) ? "rgba(91,155,213,0.08)" : "transparent",
                    cursor: "pointer", fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={selectedNodes.includes(d.id)}
                      onChange={() => toggleNode(d.id)}
                    />
                    <span style={{ fontWeight: 600, color: "var(--text-primary,#1e293b)" }}>
                      {d.displayName || d.name}
                    </span>
                    <span style={{ color: "var(--text-muted,#94a3b8)", fontSize: 11 }}>{d.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* ── Section 3: Permissions (placeholder, not functional yet) ── */}
          <div>
            <div style={sectionLabelStyle}>PERMISSIONS <span style={{ opacity: 0.6, fontWeight: 500 }}>(coming soon)</span></div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, opacity: 0.5 }}>
              {["View vitals", "Edit thresholds", "Manage nodes", "Print / export reports"].map(perm => (
                <label key={perm} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13,
                  color: "var(--text-primary,#1e293b)", cursor: "not-allowed" }}>
                  <input type="checkbox" disabled />
                  {perm}
                </label>
              ))}
            </div>
          </div>

          {msg && (
            <div style={{ padding: "8px 12px", borderRadius: 8, fontSize: 13,
              background: msg.type === "ok" ? "#d1fae5" : msg.type === "info" ? "#e0f2fe" : "#fee2e2",
              color:      msg.type === "ok" ? "#065f46" : msg.type === "info" ? "#0369a1" : "#991b1b" }}>
              {msg.text}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button onClick={onClose}
              style={{ padding: "8px 18px", borderRadius: 8,
                border: "1px solid var(--border,#e2e8f0)", background: "none",
                cursor: "pointer", fontSize: 13, color: "var(--text-primary,#1e293b)", fontFamily: "inherit" }}>
              Cancel
            </button>
            <button onClick={handleSubmit} disabled={saving}
              style={{ padding: "8px 22px", borderRadius: 8, border: "none",
                background: saving ? "#94a3b8" : "#5B9BD5",
                color: "#fff", fontWeight: 700, cursor: saving ? "not-allowed" : "pointer",
                fontSize: 13, fontFamily: "inherit" }}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}