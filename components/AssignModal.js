// components/AssignModal.js
// Admin-only modal with two tabs:
// - "Create New": creates a ThingsBoard Customer + CUSTOMER_USER, sets the
//   password via the activation-link flow (no email step), then assigns the
//   selected devices to that customer.
// - "Edit Existing": pick an existing client (Customer), see which nodes are
//   currently assigned, and add/remove nodes for them.
//
// Permissions section is a placeholder — not wired up yet in either tab.

import { useState, useEffect, useCallback } from "react";
import {
  createCustomer,
  createCustomerUser,
  getUserActivationLink,
  activateUser,
  assignDeviceToCustomer,
  unassignDeviceFromCustomer,
  getCustomers,
  getCustomerDeviceIds,
  deleteCustomer,
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
const selectStyle = { ...inputStyle, cursor: "pointer" };
const tabBtnStyle = (active) => ({
  fontSize: 12, fontWeight: 700, padding: "7px 16px", borderRadius: 8,
  border: active ? "1.5px solid #5B9BD5" : "1.5px solid var(--border,#e2e8f0)",
  background: active ? "rgba(91,155,213,0.1)" : "transparent",
  color: active ? "#5B9BD5" : "var(--text-muted,#94a3b8)",
  cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
});

// Shared checklist used by both tabs
function NodeChecklist({ devices, selected, onToggle, disabled }) {
  if (devices.length === 0) {
    return <div style={{ fontSize: 12, color: "var(--text-muted,#94a3b8)" }}>No nodes available.</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 180, overflowY: "auto", opacity: disabled ? 0.5 : 1 }}>
      {devices.map(d => (
        <label key={d.id} style={{ display: "flex", alignItems: "center", gap: 8,
          padding: "7px 10px", borderRadius: 8,
          border: "1px solid var(--border,#e2e8f0)",
          background: selected.includes(d.id) ? "rgba(91,155,213,0.08)" : "transparent",
          cursor: disabled ? "not-allowed" : "pointer", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={selected.includes(d.id)}
            onChange={() => !disabled && onToggle(d.id)}
            disabled={disabled}
          />
          <span style={{ fontWeight: 600, color: "var(--text-primary,#1e293b)" }}>
            {d.displayName || d.name}
          </span>
          <span style={{ color: "var(--text-muted,#94a3b8)", fontSize: 11 }}>{d.name}</span>
        </label>
      ))}
    </div>
  );
}

export default function AssignModal({ token, devices, onClose, onAssigned }) {
  const [mode, setMode] = useState("create"); // "create" | "edit"
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState(null);

  // ── Create-tab state ──────────────────────────────────────────────────
  const [username,      setUsername]      = useState("");
  const [password,      setPassword]      = useState("");
  const [selectedNodes, setSelectedNodes] = useState([]);

  // ── Edit-tab state ────────────────────────────────────────────────────
  const [customers,          setCustomers]          = useState([]);
  const [customersLoading,   setCustomersLoading]   = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [editSelectedNodes,  setEditSelectedNodes]  = useState([]);
  const [originalNodes,      setOriginalNodes]      = useState([]);
  const [editLoading,        setEditLoading]        = useState(false);
  const [confirmDelete,      setConfirmDelete]      = useState(false);
  const [deleting,           setDeleting]           = useState(false);

  useEffect(() => {
    const fn = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  // Load the client list once, the first time the Edit tab is opened
  useEffect(() => {
    if (mode !== "edit" || customers.length > 0 || customersLoading) return;
    setCustomersLoading(true);
    getCustomers(token)
      .then(setCustomers)
      .catch(e => setMsg({ type: "err", text: e.message }))
      .finally(() => setCustomersLoading(false));
  }, [mode, token, customers.length, customersLoading]);

  const toggleNode     = (id) => setSelectedNodes(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleEditNode = (id) => setEditSelectedNodes(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const handleSelectCustomer = useCallback(async (customerId) => {
    setSelectedCustomerId(customerId);
    setMsg(null);
    setEditSelectedNodes([]);
    setOriginalNodes([]);
    setConfirmDelete(false);
    if (!customerId) return;
    setEditLoading(true);
    try {
      const deviceIds = await getCustomerDeviceIds(token, customerId);
      setEditSelectedNodes(deviceIds);
      setOriginalNodes(deviceIds);
    } catch (e) {
      setMsg({ type: "err", text: e.message });
    } finally {
      setEditLoading(false);
    }
  }, [token]);

  // ── Create submit ─────────────────────────────────────────────────────
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

  // ── Edit submit (diff-based add/remove) ──────────────────────────────
  const handleSaveEdit = async () => {
    if (!selectedCustomerId) { setMsg({ type: "err", text: "Select a client first." }); return; }

    const toAdd    = editSelectedNodes.filter(id => !originalNodes.includes(id));
    const toRemove = originalNodes.filter(id => !editSelectedNodes.includes(id));
    if (toAdd.length === 0 && toRemove.length === 0) {
      setMsg({ type: "err", text: "No changes to save." });
      return;
    }

    setSaving(true);
    setMsg(null);
    try {
      if (toAdd.length > 0) {
        setMsg({ type: "info", text: `Assigning ${toAdd.length} node(s)…` });
        for (const deviceId of toAdd) {
          await assignDeviceToCustomer(token, selectedCustomerId, deviceId);
        }
      }
      if (toRemove.length > 0) {
        setMsg({ type: "info", text: `Removing ${toRemove.length} node(s)…` });
        for (const deviceId of toRemove) {
          await unassignDeviceFromCustomer(token, deviceId);
        }
      }

      setOriginalNodes(editSelectedNodes);
      const label = customers.find(c => c.id === selectedCustomerId)?.title ?? "client";
      setMsg({ type: "ok", text: `"${label}" updated — ${toAdd.length} added, ${toRemove.length} removed ✓` });
      onAssigned?.();
      setTimeout(onClose, 900);
    } catch (e) {
      setMsg({ type: "err", text: e.message });
    } finally {
      setSaving(false);
    }
  };

  // ── Delete account ────────────────────────────────────────────────────
  const handleDeleteAccount = async () => {
    if (!selectedCustomerId) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }

    setDeleting(true);
    setMsg(null);
    try {
      const label = customers.find(c => c.id === selectedCustomerId)?.title ?? "client";
      await deleteCustomer(token, selectedCustomerId);
      setCustomers(prev => prev.filter(c => c.id !== selectedCustomerId));
      setSelectedCustomerId("");
      setEditSelectedNodes([]);
      setOriginalNodes([]);
      setConfirmDelete(false);
      setMsg({ type: "ok", text: `"${label}" account deleted ✓` });
      onAssigned?.();
    } catch (e) {
      setMsg({ type: "err", text: e.message });
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  const isEdit = mode === "edit";
  const canSaveEdit = !!selectedCustomerId && !editLoading;

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
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary,#1e293b)" }}>
                {isEdit ? "Edit Client" : "Assign User"}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted,#94a3b8)" }}>
                {isEdit ? "Update node access for an existing client" : "Create an account and assign nodes"}
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{ fontSize: 22, background: "none", border: "none",
            cursor: "pointer", color: "var(--text-muted,#94a3b8)", padding: "4px 8px",
            borderRadius: 6, fontFamily: "inherit" }}>×</button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 8, padding: "14px 20px 0" }}>
          <button onClick={() => { setMode("create"); setMsg(null); }} style={tabBtnStyle(!isEdit)}>
            Create New
          </button>
          <button onClick={() => { setMode("edit"); setMsg(null); }} style={tabBtnStyle(isEdit)}>
            Edit Existing
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "16px 20px 20px", display: "flex", flexDirection: "column", gap: 18 }}>

          {isEdit ? (
            <div>
              <div style={sectionLabelStyle}>SELECT CLIENT</div>
              <select
                value={selectedCustomerId}
                onChange={e => handleSelectCustomer(e.target.value)}
                style={selectStyle}
                disabled={customersLoading}
              >
                <option value="">
                  {customersLoading ? "Loading clients…" : "— Choose a client —"}
                </option>
                {customers.map(c => (
                  <option key={c.id} value={c.id}>{c.title}</option>
                ))}
              </select>
              {!customersLoading && customers.length === 0 && (
                <div style={{ fontSize: 12, color: "var(--text-muted,#94a3b8)", marginTop: 6 }}>
                  No clients found yet.
                </div>
              )}
            </div>
          ) : (
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
          )}

          {/* Node assignment */}
          <div>
            <div style={sectionLabelStyle}>
              ASSIGN NODES
              {isEdit && editLoading && <span style={{ opacity: 0.6, fontWeight: 500 }}> — loading…</span>}
            </div>
            {isEdit ? (
              <NodeChecklist
                devices={devices}
                selected={editSelectedNodes}
                onToggle={toggleEditNode}
                disabled={!selectedCustomerId || editLoading}
              />
            ) : (
              <NodeChecklist
                devices={devices}
                selected={selectedNodes}
                onToggle={toggleNode}
                disabled={false}
              />
            )}
          </div>

          {/* Permissions (placeholder, not functional yet) */}
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

          {/* Danger zone — delete the whole client account (Edit tab only) */}
          {isEdit && selectedCustomerId && (
            <div>
              <div style={{ ...sectionLabelStyle, color: "#ef4444" }}>DANGER ZONE</div>
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                gap: 10, padding: "10px 12px", borderRadius: 8,
                border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.05)",
              }}>
                <div style={{ fontSize: 12, color: "#991b1b", lineHeight: 1.4 }}>
                  {confirmDelete
                    ? "Are you sure? This deletes the login and unassigns all its nodes. This cannot be undone."
                    : "Permanently delete this client's account and login access."}
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  {confirmDelete && (
                    <button onClick={() => setConfirmDelete(false)} disabled={deleting}
                      style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border,#e2e8f0)",
                        background: "none", cursor: "pointer", fontSize: 12, color: "var(--text-primary,#1e293b)",
                        fontFamily: "inherit" }}>
                      Cancel
                    </button>
                  )}
                  <button onClick={handleDeleteAccount} disabled={deleting}
                    style={{ padding: "6px 12px", borderRadius: 6, border: "none",
                      background: deleting ? "#f3a5a5" : "#ef4444", color: "#fff", fontWeight: 700,
                      cursor: deleting ? "not-allowed" : "pointer", fontSize: 12, fontFamily: "inherit",
                      whiteSpace: "nowrap" }}>
                    {deleting ? "Deleting…" : confirmDelete ? "Confirm delete" : "Delete account"}
                  </button>
                </div>
              </div>
            </div>
          )}

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
            <button
              onClick={isEdit ? handleSaveEdit : handleSubmit}
              disabled={saving || deleting || (isEdit && !canSaveEdit)}
              style={{ padding: "8px 22px", borderRadius: 8, border: "none",
                background: (saving || deleting || (isEdit && !canSaveEdit)) ? "#94a3b8" : "#5B9BD5",
                color: "#fff", fontWeight: 700,
                cursor: (saving || deleting || (isEdit && !canSaveEdit)) ? "not-allowed" : "pointer",
                fontSize: 13, fontFamily: "inherit" }}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}