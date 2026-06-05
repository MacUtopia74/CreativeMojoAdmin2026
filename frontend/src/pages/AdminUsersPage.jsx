// Admin Users — single page for managing every login account. Two tabs:
//   1. Users   — roster + role + linked franchisee + create / edit / delete
//   2. Resets  — queue of forgot-password requests; admin generates temp pwds
//
// Replaces the old standalone "Password Resets" page.
import { useCallback, useEffect, useMemo, useState } from "react";
import api from "@/lib/api";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { ADMIN_NAV_KEYS } from "@/components/Layout";
import {
  Loader2,
  Users as UsersIcon,
  KeyRound,
  ShieldCheck,
  ShieldAlert,
  Plus,
  Trash2,
  X as XIcon,
  Copy,
  CheckCircle2,
  Mail,
  Clock,
  MoreHorizontal,
  Search,
  RefreshCw,
  Sparkles,
  Map as MapIcon,
  FileText,
  Megaphone,
  CalendarClock,
  ShoppingBag,
} from "lucide-react";

const ROLE_OPTIONS = [
  { value: "admin", label: "Admin (full access)" },
  { value: "franchisee", label: "Franchisee (portal only)" },
  { value: "licensee", label: "Licensee (downloads)" },
];

// Plus add-ons that can be toggled per franchisee/licensee from the Users
// page. Mirrors PortalModulesPanel.PLUS_MODULES — keep these in sync.
const PLUS_MODULES = [
  { key: "territory_plus", label: "My Territory+", icon: MapIcon },
  { key: "invoicing",      label: "Invoicing+",     icon: FileText },
  { key: "marketing",      label: "Marketing+",     icon: Megaphone },
  { key: "bookings",       label: "Bookings+",      icon: CalendarClock },
  { key: "shape_orders",   label: "Shape Orders",  icon: ShoppingBag },
];

const money = (s) => (s ? new Date(s).toLocaleString("en-GB") : "—");

export default function AdminUsersPage() {
  const [tab, setTab] = useState("users");
  const [resetsCount, setResetsCount] = useState(0);

  // Light poll so the badge on the Resets tab updates without a manual refresh.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const { data } = await api.get(
          "/auth/password-reset/requests", { params: { status: "pending" } }
        );
        if (!cancelled) setResetsCount(data.pending_count || 0);
      } catch { /* ignore */ }
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [tab]);

  return (
    <div className="space-y-6 p-6 md:p-8" data-testid="admin-users-page">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">
            Security · User Accounts
          </div>
          <h1 className="font-display text-4xl text-stone-950 mt-1">
            Users
          </h1>
          <p className="text-sm text-stone-600 mt-2 max-w-2xl">
            Roster of every login on the system — admins, franchisees and licensees.
            Create new accounts, manage portal module access, or fulfil password-reset requests.
          </p>
        </div>
        <div className="inline-flex bg-stone-100 rounded-lg p-0.5">
          <TabButton active={tab === "users"} onClick={() => setTab("users")} testid="users-tab-users">
            <UsersIcon className="w-3.5 h-3.5 mr-1.5" /> Users
          </TabButton>
          <TabButton active={tab === "resets"} onClick={() => setTab("resets")} testid="users-tab-resets">
            <KeyRound className="w-3.5 h-3.5 mr-1.5" /> Password Resets
            {resetsCount > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold bg-red-600 text-white rounded-full" data-testid="resets-pending-badge">
                {resetsCount}
              </span>
            )}
          </TabButton>
        </div>
      </div>

      {tab === "users" ? <UsersTab /> : <ResetsTab />}
    </div>
  );
}

function TabButton({ active, onClick, children, testid }) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className={`inline-flex items-center px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-md transition ${
        active ? "bg-white text-stone-950 shadow-sm" : "text-stone-600 hover:text-stone-900"
      }`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Users Tab — list + create modal
// ---------------------------------------------------------------------------
function UsersTab() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [franchisees, setFranchisees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createdToast, setCreatedToast] = useState(null); // {email, password}
  const [permsUser, setPermsUser] = useState(null);       // user being edited
  const [modulesUser, setModulesUser] = useState(null);   // franchisee/licensee user being edited

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [u, f] = await Promise.all([
        api.get("/auth/users"),
        api.get("/franchisees"),
      ]);
      setUsers(u.data.users || []);
      setFranchisees(f.data?.items || f.data || []);
    } catch (e) {
      toast.error("Failed to load users");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Map franchisee_id → franchisee record for quick portal_modules lookup
  // when rendering the Modules button on franchisee/licensee rows.
  const franchiseeById = useMemo(() => {
    const m = new Map();
    franchisees.forEach((f) => m.set(f.id, f));
    return m;
  }, [franchisees]);

  const matches = useCallback((u) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return (
      u.email?.toLowerCase().includes(needle) ||
      u.name?.toLowerCase().includes(needle) ||
      (u.franchisee_label || "").toLowerCase().includes(needle)
    );
  }, [q]);

  const adminUsers = useMemo(
    () => users.filter((u) => u.role === "admin" && matches(u)),
    [users, matches],
  );
  const portalUsers = useMemo(
    () => users.filter((u) => (u.role === "franchisee" || u.role === "licensee") && matches(u)),
    [users, matches],
  );

  const deleteUser = async (u) => {
    if (!window.confirm(`Delete user ${u.email}? They will lose all access immediately.`)) return;
    try {
      await api.delete(`/auth/users/${u.id}`);
      toast.success("User deleted");
      load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not delete");
    }
  };

  return (
    <>
      {/* Filter / search bar */}
      <div className="bg-white border border-stone-200 rounded-2xl p-3 flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, email or franchisee…"
            className="w-full pl-9 pr-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-stone-900/20"
            data-testid="users-search"
          />
        </div>
        <button
          onClick={load}
          title="Reload"
          className="px-2.5 py-2 border border-stone-200 rounded-lg hover:bg-stone-50"
          data-testid="users-reload"
        >
          <RefreshCw className="w-3.5 h-3.5 text-stone-600" />
        </button>
        <button
          onClick={() => setShowCreate(true)}
          data-testid="users-new-btn"
          className="ml-auto inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-lg"
        >
          <Plus className="w-3.5 h-3.5" /> New User
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-[30vh] text-stone-500 mt-6">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
        </div>
      ) : (
        <div className="mt-4 space-y-6">
          <UsersSection
            title="Admin Users"
            subtitle="Full back-office access to HQ tooling."
            users={adminUsers}
            totalCount={users.filter((u) => u.role === "admin").length}
            me={me}
            franchiseeById={franchiseeById}
            onPermissions={setPermsUser}
            onModules={setModulesUser}
            onDelete={deleteUser}
            testid="admin-users-section"
          />
          <UsersSection
            title="Franchisee & Licensee Users"
            subtitle="Portal logins for franchisees and worldwide licensees. Tick the Modules button to enable My Territory+, Invoicing, Marketing or Bookings."
            users={portalUsers}
            totalCount={users.filter((u) => u.role === "franchisee" || u.role === "licensee").length}
            me={me}
            franchiseeById={franchiseeById}
            onPermissions={setPermsUser}
            onModules={setModulesUser}
            onDelete={deleteUser}
            testid="franchisee-users-section"
          />
        </div>
      )}

      <CreateUserModal
        open={showCreate}
        franchisees={franchisees}
        onClose={() => setShowCreate(false)}
        onCreated={(user) => {
          setShowCreate(false);
          setCreatedToast(user);
          load();
        }}
      />

      <CredentialsRevealModal data={createdToast} onClose={() => setCreatedToast(null)} />
      <PermissionsModal
        me={me}
        user={permsUser}
        onClose={() => setPermsUser(null)}
        onSaved={(patch) => {
          // Mirror the new value into the local list so the badge updates
          // immediately without a full reload.
          setUsers((arr) => arr.map((u) => u.id === patch.id ? { ...u, nav_permissions: patch.nav_permissions } : u));
          setPermsUser(null);
        }}
      />
      <ModulesModal
        user={modulesUser}
        franchisee={modulesUser ? franchiseeById.get(modulesUser.franchisee_id) : null}
        onClose={() => setModulesUser(null)}
        onSaved={(franchiseeId, portal_modules) => {
          // Patch the cached franchisee record so subsequent opens of the
          // modal start from the new state without a full reload.
          setFranchisees((arr) => arr.map((f) => f.id === franchiseeId ? { ...f, portal_modules } : f));
          setModulesUser(null);
        }}
      />
    </>
  );
}

// One panel — either "Admin Users" or "Franchisee & Licensee Users".
// Pulls the row-render logic out of the parent so both sections look
// identical without duplicating the markup.
function UsersSection({
  title, subtitle, users, totalCount, me, franchiseeById,
  onPermissions, onModules, onDelete, testid,
}) {
  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid={testid}>
      <div className="px-5 py-3 bg-stone-50 border-b border-stone-200 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">{title}</div>
          {subtitle && <div className="text-[11px] text-stone-500 mt-0.5 max-w-2xl">{subtitle}</div>}
        </div>
        <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
          {users.length} of {totalCount}
        </div>
      </div>
      <ul className="divide-y divide-stone-100">
        {users.length === 0 ? (
          <li className="px-5 py-10 text-center text-sm text-stone-500">
            No users match the current filter.
          </li>
        ) : users.map((u) => {
          const f = u.franchisee_id ? franchiseeById.get(u.franchisee_id) : null;
          const mods = f?.portal_modules || {};
          const enabledPlus = PLUS_MODULES.filter((m) => mods[m.key]).length;
          return (
            <li key={u.id} className="px-5 py-3 flex items-center gap-4 flex-wrap" data-testid={`user-row-${u.id}`}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-stone-900">{u.name || u.email}</span>
                  <span className="text-xs text-stone-500 inline-flex items-center gap-1">
                    <Mail className="w-3 h-3" /> {u.email}
                  </span>
                  <RolePill role={u.role} />
                  {u.id === me?.id && (
                    <span className="text-[10px] uppercase tracking-wider font-bold bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                      You
                    </span>
                  )}
                  {u.active === false && (
                    <span className="text-[10px] uppercase tracking-wider font-bold bg-stone-200 text-stone-700 px-2 py-0.5 rounded">
                      Disabled
                    </span>
                  )}
                </div>
                <div className="text-xs text-stone-500 mt-1 flex items-center gap-3 flex-wrap">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="w-3 h-3" /> Created {money(u.created_at)}
                  </span>
                  {u.franchisee_label && (
                    <span>· Linked to <strong className="text-stone-700">{u.franchisee_label}</strong></span>
                  )}
                  {u.role === "admin" && (
                    Array.isArray(u.nav_permissions) ? (
                      <span data-testid={`user-perms-${u.id}`} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-amber-50 text-amber-900 border border-amber-200">
                        <ShieldAlert className="w-3 h-3" />
                        {u.nav_permissions.length === 0 ? "No pages" : `${u.nav_permissions.length} page${u.nav_permissions.length === 1 ? "" : "s"}`}
                      </span>
                    ) : (
                      <span data-testid={`user-perms-${u.id}`} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-stone-100 text-stone-600 border border-stone-200">
                        <ShieldCheck className="w-3 h-3" /> Full access
                      </span>
                    )
                  )}
                  {(u.role === "franchisee" || u.role === "licensee") && f && (
                    <span data-testid={`user-modules-${u.id}`} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-stone-100 text-stone-600 border border-stone-200">
                      <Sparkles className="w-3 h-3" />
                      {enabledPlus === 0 ? "No add-ons" : `${enabledPlus}/${PLUS_MODULES.length} add-on${enabledPlus === 1 ? "" : "s"}`}
                    </span>
                  )}
                </div>
              </div>
              {u.role === "admin" && (
                <button
                  onClick={() => onPermissions(u)}
                  data-testid={`user-perms-edit-${u.id}`}
                  className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-lg flex items-center gap-1.5"
                  title="Restrict which pages this user can see"
                >
                  <ShieldCheck className="w-3.5 h-3.5" /> Permissions
                </button>
              )}
              {(u.role === "franchisee" || u.role === "licensee") && u.franchisee_id && (
                <button
                  onClick={() => onModules(u)}
                  data-testid={`user-modules-edit-${u.id}`}
                  className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-lg flex items-center gap-1.5"
                  title="Enable or disable portal add-on modules"
                >
                  <Sparkles className="w-3.5 h-3.5" /> Modules
                </button>
              )}
              {u.id !== me?.id && (
                <button
                  onClick={() => onDelete(u)}
                  data-testid={`user-delete-${u.id}`}
                  className="text-stone-400 hover:text-red-600 p-2"
                  title="Delete user"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RolePill({ role }) {
  const cfg = {
    admin: "bg-stone-900 text-white",
    franchisee: "bg-emerald-100 text-emerald-900 border border-emerald-300",
    licensee: "bg-amber-100 text-amber-900 border border-amber-300",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded ${cfg[role] || cfg.licensee}`}>
      {role}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Create-user modal — supports admin / franchisee / licensee. When the
// role is "franchisee" we surface a searchable franchisee picker so the
// account is correctly linked to a record (the portal pages key off this
// id to scope what the user sees).
// ---------------------------------------------------------------------------
function CreateUserModal({ open, franchisees, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("admin");
  const [franchiseeId, setFranchiseeId] = useState("");
  const [franSearch, setFranSearch] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (open) {
      setName(""); setEmail(""); setRole("admin");
      setFranchiseeId(""); setFranSearch("");
      setPassword(""); setShowPw(false); setErr("");
    }
  }, [open]);

  if (!open) return null;

  const generatePw = () => {
    // 12-char readable password — easier to send via Signal than 20-char hex.
    const alpha = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#";
    let p = "";
    const arr = new Uint32Array(12);
    crypto.getRandomValues(arr);
    arr.forEach((n) => { p += alpha[n % alpha.length]; });
    setPassword(p); setShowPw(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    if (password.length < 8) { setErr("Password must be at least 8 characters."); return; }
    if (role === "franchisee" && !franchiseeId) {
      setErr("Pick a franchisee to link this account to.");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: name.trim(), email: email.trim(), role, password,
        ...(role === "franchisee" && franchiseeId ? { franchisee_id: franchiseeId } : {}),
      };
      const { data } = await api.post("/auth/users", payload);
      onCreated({ ...data, password });
    } catch (e2) {
      setErr(e2?.response?.data?.detail || "Could not create user.");
    } finally { setBusy(false); }
  };

  const matchedFranchisees = (() => {
    const needle = franSearch.trim().toLowerCase();
    if (!needle) return franchisees.slice(0, 20);
    return franchisees.filter((f) => {
      const blob = `${f.franchise_number || ""} ${f.organisation || ""} ${f.name || ""}`.toLowerCase();
      return blob.includes(needle);
    }).slice(0, 20);
  })();

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[80] bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-6"
      data-testid="create-user-modal"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden max-h-[92vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-stone-200 shrink-0">
          <div className="flex items-center gap-2">
            <UsersIcon className="w-4 h-4 text-stone-700" />
            <span className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">
              New User Account
            </span>
          </div>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg" data-testid="create-user-close">
            <XIcon className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={submit} className="px-6 py-5 space-y-4 overflow-y-auto">
          <Field label="Full name" required>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required autoFocus
              className="w-full px-3 py-2.5 border border-stone-300 rounded-xl text-sm focus:outline-none focus:border-stone-950"
              data-testid="create-user-name"
            />
          </Field>
          <Field label="Email" required>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-3 py-2.5 border border-stone-300 rounded-xl text-sm focus:outline-none focus:border-stone-950"
              data-testid="create-user-email"
            />
          </Field>
          <Field label="Role">
            <div className="grid grid-cols-3 gap-2">
              {ROLE_OPTIONS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => setRole(r.value)}
                  data-testid={`create-user-role-${r.value}`}
                  className={`px-2 py-2 text-[11px] font-bold uppercase tracking-wider rounded-xl border transition ${
                    role === r.value
                      ? "bg-stone-950 border-stone-950 text-white"
                      : "bg-white border-stone-300 text-stone-700 hover:bg-stone-50"
                  }`}
                >
                  {r.value}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-stone-500 mt-1.5">
              {ROLE_OPTIONS.find((r) => r.value === role)?.label}
            </p>
          </Field>
          {role === "franchisee" && (
            <Field label="Linked franchisee" required>
              <div className="relative mb-2">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
                <input
                  value={franSearch}
                  onChange={(e) => setFranSearch(e.target.value)}
                  placeholder="Search by number, name or organisation…"
                  className="w-full pl-9 pr-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-stone-900/20"
                  data-testid="create-user-fran-search"
                />
              </div>
              <div className="max-h-44 overflow-y-auto border border-stone-200 rounded-lg divide-y divide-stone-100">
                {matchedFranchisees.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-stone-500 text-center">No franchisees match.</div>
                ) : matchedFranchisees.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFranchiseeId(f.id)}
                    data-testid={`create-user-fran-${f.id}`}
                    className={`w-full px-3 py-2 text-left text-xs flex items-center gap-2 hover:bg-stone-50 ${
                      franchiseeId === f.id ? "bg-emerald-50" : ""
                    }`}
                  >
                    <span className="tabular-nums font-bold text-stone-700 shrink-0 w-10">
                      {f.franchise_number || "—"}
                    </span>
                    <span className="truncate flex-1 text-stone-700">
                      {f.organisation || f.name}
                    </span>
                    {franchiseeId === f.id && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />}
                  </button>
                ))}
              </div>
            </Field>
          )}
          <Field label="Initial password" required>
            <div className="flex gap-2">
              <input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                placeholder="Min. 8 characters"
                className="flex-1 px-3 py-2.5 border border-stone-300 rounded-xl text-sm focus:outline-none focus:border-stone-950 font-mono"
                data-testid="create-user-password"
              />
              <button
                type="button"
                onClick={generatePw}
                className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-xl"
                data-testid="create-user-generate-pw"
              >
                Generate
              </button>
            </div>
            <p className="text-[11px] text-stone-500 mt-1.5">
              You'll see this password once after creation — copy and send it to the user.
            </p>
          </Field>
          {err && (
            <div className="px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
              {err}
            </div>
          )}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              data-testid="create-user-submit"
              className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              Create user
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, required, children }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1.5 block">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

// Show the new user's credentials once after creation so the admin can
// copy them to share. Same UX as the password-reset reveal modal so the
// admin's muscle-memory works across both flows.
function CredentialsRevealModal({ data, onClose }) {
  const [copied, setCopied] = useState(false);
  if (!data) return null;
  const summary = `Email: ${data.email}\nPassword: ${data.password}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };
  return (
    <div onClick={onClose} className="fixed inset-0 z-[80] bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-6" data-testid="user-created-modal">
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
        <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">User Created</span>
          </div>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg">
            <XIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="text-sm text-stone-700">
            <strong>{data.name || data.email}</strong> can now sign in. Send them the credentials below via a secure channel (Signal, SMS or phone).
          </div>
          <div className="bg-stone-950 rounded-xl px-4 py-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-stone-400 w-16 shrink-0">Email</span>
              <code className="font-mono text-sm text-[#dddd16] select-all">{data.email}</code>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-stone-400 w-16 shrink-0">Password</span>
              <code data-testid="created-password" className="font-mono text-sm text-[#dddd16] tracking-widest select-all">{data.password}</code>
            </div>
          </div>
          <button onClick={copy} data-testid="created-copy" className="w-full px-3 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-lg flex items-center justify-center gap-2">
            {copied ? <><CheckCircle2 className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy credentials</>}
          </button>
          <div className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <MoreHorizontal className="w-3.5 h-3.5 inline mr-1" />
            Shown <strong>once</strong>. Close this window and the password is gone — you'd need to issue a reset to recover it.
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resets Tab — preserves the previous PasswordResetsPage functionality.
// ---------------------------------------------------------------------------
function ResetsTab() {
  const [requests, setRequests] = useState([]);
  const [filter, setFilter] = useState("pending");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [reveal, setReveal] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/auth/password-reset/requests", { params: { status: filter } });
      setRequests(data.requests || []);
    } catch { toast.error("Could not load reset requests"); }
    finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const fulfill = async (req) => {
    setBusyId(req.id);
    try {
      const { data } = await api.post(`/auth/password-reset/requests/${req.id}/fulfill`);
      setReveal({ email: data.email, user_name: data.user_name, temp_password: data.temp_password });
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not fulfill"); }
    finally { setBusyId(null); }
  };

  const reject = async (req) => {
    if (!window.confirm(`Reject the reset request from ${req.email}?`)) return;
    setBusyId(req.id);
    try {
      await api.post(`/auth/password-reset/requests/${req.id}/reject`);
      toast.success("Request rejected"); load();
    } catch (e) { toast.error(e?.response?.data?.detail || "Could not reject"); }
    finally { setBusyId(null); }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-3 mt-2 flex-wrap">
        <div className="text-sm text-stone-600">
          Locked-out users who clicked "Forgot Password" on a login page. Generate a temporary
          password — it shows once. The user will be forced to change it on next login.
        </div>
        <div className="inline-flex bg-stone-100 rounded-lg p-0.5">
          {["pending", "fulfilled", "rejected", "all"].map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              data-testid={`reset-filter-${s}`}
              className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-md transition ${
                filter === s ? "bg-white text-stone-950 shadow-sm" : "text-stone-600 hover:text-stone-900"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <div className="flex items-center justify-center min-h-[30vh] text-stone-500 mt-6">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
        </div>
      ) : requests.length === 0 ? (
        <div className="bg-white border border-stone-200 rounded-2xl p-10 text-center mt-4">
          <ShieldCheck className="w-10 h-10 text-emerald-500 mx-auto" />
          <p className="mt-3 text-stone-700 font-bold">No {filter === "all" ? "" : filter} reset requests</p>
        </div>
      ) : (
        <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden mt-4">
          <ul className="divide-y divide-stone-100">
            {requests.map((r) => (
              <li key={r.id} className="px-5 py-4 flex items-center gap-4 flex-wrap" data-testid={`reset-row-${r.id}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-stone-900">{r.user_name || r.email}</span>
                    <span className="text-xs text-stone-500 inline-flex items-center gap-1">
                      <Mail className="w-3 h-3" /> {r.email}
                    </span>
                    <StatusPill status={r.status} />
                    {r.role && (
                      <span className="text-[10px] uppercase tracking-wider font-bold text-stone-500 bg-stone-100 px-2 py-0.5 rounded">
                        {r.role}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-stone-500 mt-1 inline-flex items-center gap-1">
                    <Clock className="w-3 h-3" /> {money(r.requested_at)} · IP {r.ip}
                  </div>
                </div>
                {r.status === "pending" && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      disabled={busyId === r.id}
                      onClick={() => fulfill(r)}
                      data-testid={`reset-fulfill-${r.id}`}
                      className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
                    >
                      {busyId === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                      Generate temp password
                    </button>
                    <button
                      disabled={busyId === r.id}
                      onClick={() => reject(r)}
                      data-testid={`reset-reject-${r.id}`}
                      className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <XIcon className="w-3.5 h-3.5" /> Reject
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <RevealModal data={reveal} onClose={() => setReveal(null)} />
    </>
  );
}

function StatusPill({ status }) {
  const cfg = {
    pending: "bg-amber-100 text-amber-900 border border-amber-300",
    fulfilled: "bg-emerald-100 text-emerald-900 border border-emerald-300",
    rejected: "bg-stone-100 text-stone-700 border border-stone-300",
  };
  return <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded ${cfg[status] || cfg.rejected}`}>{status}</span>;
}

function RevealModal({ data, onClose }) {
  const [copied, setCopied] = useState(false);
  if (!data) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.temp_password);
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };
  return (
    <div onClick={onClose} className="fixed inset-0 z-[80] bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-6" data-testid="reset-reveal-modal">
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
        <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-stone-700" />
            <span className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">Temporary Password</span>
          </div>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg">
            <XIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="text-sm text-stone-700">
            Share with <strong>{data.user_name || data.email}</strong> via Signal/SMS/phone. They must change it on next login.
          </div>
          <div className="bg-stone-950 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
            <code data-testid="reveal-temp-pwd" className="font-mono text-base text-[#dddd16] tracking-widest select-all">{data.temp_password}</code>
            <button onClick={copy} data-testid="reveal-copy" className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-md flex items-center gap-1.5">
              {copied ? <><CheckCircle2 className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
            </button>
          </div>
          <div className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <MoreHorizontal className="w-3.5 h-3.5 inline mr-1" />
            Shown <strong>once</strong>. Close this window and it's gone.
          </div>
        </div>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Permissions modal — picks which sidebar pages a given admin user can
// see. The "Full access" toggle clears the restriction (sends null);
// otherwise we send the ticked keys as an explicit list.
//
// "Sandra preset" is a one-click shortcut for the original ask from
// Paul: Sandra should only see Franchises / Licences + Calendar +
// Sandra's Invoices. Click → pre-fills the boxes; Save commits.
// ---------------------------------------------------------------------------
const SANDRA_PRESET = ["franchisees", "calendar", "invoices"];

function PermissionsModal({ user, me, onClose, onSaved }) {
  const [unrestricted, setUnrestricted] = useState(true);
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!user) return;
    if (Array.isArray(user.nav_permissions)) {
      setUnrestricted(false);
      setPicked(new Set(user.nav_permissions));
    } else {
      setUnrestricted(true);
      setPicked(new Set());
    }
    setErr("");
  }, [user]);

  if (!user) return null;

  const isSelf = me?.id === user.id;
  const toggle = (key) => {
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  };

  const applyPreset = () => {
    setUnrestricted(false);
    setPicked(new Set(SANDRA_PRESET));
  };

  const submit = async () => {
    setErr(""); setBusy(true);
    try {
      const payload = { nav_permissions: unrestricted ? null : Array.from(picked) };
      await api.patch(`/auth/users/${user.id}`, payload);
      toast.success("Permissions updated");
      onSaved({ id: user.id, nav_permissions: payload.nav_permissions });
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not save permissions.");
    } finally { setBusy(false); }
  };

  return (
    <div onClick={onClose} className="fixed inset-0 z-[80] bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-6" data-testid="permissions-modal">
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl max-w-xl w-full overflow-hidden max-h-[92vh] flex flex-col">
        <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between shrink-0">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">Page Permissions</div>
            <div className="text-sm font-semibold text-stone-900 mt-0.5">{user.name || user.email}</div>
          </div>
          <button onClick={onClose} data-testid="permissions-close" className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4 overflow-y-auto">
          <label className="flex items-start gap-3 p-3 border border-stone-200 rounded-xl cursor-pointer hover:bg-stone-50" data-testid="perm-full-access">
            <input
              type="checkbox"
              checked={unrestricted}
              onChange={(e) => setUnrestricted(e.target.checked)}
              className="mt-1 w-4 h-4 rounded border-stone-300 text-stone-900 focus:ring-stone-900"
            />
            <div>
              <div className="text-sm font-semibold text-stone-900 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" /> Full access
              </div>
              <div className="text-xs text-stone-500 mt-0.5">
                This user can see every page in the admin sidebar. Untick to restrict to specific pages only.
              </div>
            </div>
          </label>

          <div className="border border-stone-200 rounded-xl">
            <div className="px-3 py-2 bg-stone-50 border-b border-stone-200 flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 flex items-center gap-1.5">
                <ShieldAlert className="w-3 h-3" /> Restrict to these pages
              </div>
              <button
                type="button"
                onClick={applyPreset}
                data-testid="perm-sandra-preset"
                className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-700 hover:text-stone-900 underline">
                Sandra preset
              </button>
            </div>
            <div className={`p-3 grid grid-cols-1 sm:grid-cols-2 gap-1 ${unrestricted ? "opacity-50 pointer-events-none" : ""}`}>
              {ADMIN_NAV_KEYS.map((n) => {
                const checked = picked.has(n.key);
                return (
                  <label key={n.key} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-stone-50 cursor-pointer" data-testid={`perm-${n.key}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(n.key)}
                      className="w-4 h-4 rounded border-stone-300 text-stone-900 focus:ring-stone-900"
                    />
                    <span className={`text-sm ${checked ? "text-stone-900 font-medium" : "text-stone-700"}`}>{n.label}</span>
                  </label>
                );
              })}
            </div>
            {!unrestricted && picked.size === 0 && (
              <div className="px-3 py-2 text-[11px] text-amber-900 bg-amber-50 border-t border-amber-200 flex items-start gap-1.5">
                <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>No pages ticked. This user will only see the password-change screen when they log in.</span>
              </div>
            )}
          </div>

          {isSelf && (
            <div className="px-3 py-2 text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>You're editing your <strong>own</strong> account. To avoid locking yourself out, Admin Users will be kept reachable automatically.</span>
            </div>
          )}

          {err && (
            <div className="px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">{err}</div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-stone-200 flex items-center justify-end gap-2 shrink-0 bg-stone-50">
          <button onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white hover:bg-stone-50 rounded-lg">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            data-testid="permissions-save"
            className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-lg flex items-center gap-1.5 disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
            Save permissions
          </button>
        </div>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Modules modal — toggles the four "Plus" portal add-ons for a single
// franchisee/licensee user. Hits the same /franchisees/:id/portal-modules
// endpoint that the franchisee detail page uses, so admins get the same
// outcome from either entry point without us having to invent a parallel
// API for users.
// ---------------------------------------------------------------------------
function ModulesModal({ user, franchisee, onClose, onSaved }) {
  const [state, setState] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!user || !franchisee) return;
    const mods = franchisee.portal_modules || {};
    setState({
      territory_plus: !!mods.territory_plus,
      invoicing:      !!mods.invoicing,
      marketing:      !!mods.marketing,
      bookings:       !!mods.bookings,
    });
    setErr("");
  }, [user, franchisee]);

  if (!user) return null;
  if (!franchisee) {
    return (
      <div onClick={onClose} className="fixed inset-0 z-[80] bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-6">
        <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 text-sm text-stone-700">
          This user is not linked to a franchisee record, so portal modules can't be toggled. Edit the user and link them to a franchisee first.
          <div className="mt-4 flex justify-end">
            <button onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-lg">Close</button>
          </div>
        </div>
      </div>
    );
  }

  const toggle = (key) => setState((s) => ({ ...s, [key]: !s[key] }));

  const submit = async () => {
    setErr(""); setBusy(true);
    try {
      const { data } = await api.patch(`/franchisees/${franchisee.id}/portal-modules`, state);
      toast.success("Modules updated");
      onSaved(franchisee.id, data.portal_modules || state);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not save modules.");
    } finally { setBusy(false); }
  };

  return (
    <div onClick={onClose} className="fixed inset-0 z-[80] bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-6" data-testid="modules-modal">
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
        <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700 flex items-center gap-1.5">
              <Sparkles className="w-3 h-3" /> Portal Add-on Modules
            </div>
            <div className="text-sm font-semibold text-stone-900 mt-0.5">{user.name || user.email}</div>
            {franchisee.organisation && (
              <div className="text-xs text-stone-500 mt-0.5">{franchisee.organisation}</div>
            )}
          </div>
          <button onClick={onClose} data-testid="modules-close" className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg">
            <XIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-2">
          <p className="text-xs text-stone-600 mb-3">
            Switch on the portal sections this user should see. Changes apply instantly the next time they sign in or refresh.
          </p>
          {PLUS_MODULES.map((m) => {
            const Icon = m.icon;
            const on = !!state[m.key];
            return (
              <label
                key={m.key}
                className="flex items-center justify-between p-3 bg-stone-50 border border-stone-200 rounded-lg cursor-pointer hover:bg-stone-100"
                data-testid={`modules-toggle-${m.key}`}
              >
                <span className="flex items-center gap-3">
                  <span className={`p-1.5 rounded ${on ? "bg-stone-950 text-[#dddd16]" : "bg-stone-200 text-stone-500"}`}>
                    <Icon className="w-4 h-4" />
                  </span>
                  <span className="text-sm font-semibold text-stone-900">{m.label}</span>
                </span>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(m.key)}
                  className="w-4 h-4 rounded border-stone-300 text-stone-900 focus:ring-stone-900"
                />
              </label>
            );
          })}
          {err && (
            <div className="px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">{err}</div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-stone-200 flex items-center justify-end gap-2 bg-stone-50">
          <button onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white hover:bg-stone-50 rounded-lg">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            data-testid="modules-save"
            className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-lg flex items-center gap-1.5 disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
            Save modules
          </button>
        </div>
      </div>
    </div>
  );
}
