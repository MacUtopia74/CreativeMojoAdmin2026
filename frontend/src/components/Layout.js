import { NavLink, Outlet, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import Logo from "@/components/Logo";
import api from "@/lib/api";
import {
  LayoutDashboard,
  Users,
  Contact,
  Inbox,
  BellRing,
  FolderOpen,
  MapPin,
  Target,
  Stethoscope,
  CalendarDays,
  LogOut,
  ChevronDown,
  Receipt,
  Banknote,
  KeyRound,
  ShoppingBag,
  Calculator,
  Wrench,
  Settings as SettingsIcon,
  Building2,
  Cog,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

// Sidebar structure — designed in May 2026 around how the franchise owner
// actually moves through the admin day-to-day. The two collapsible groups
// (Franchises, Admin) keep the top-level list short while still surfacing
// every page within two clicks.
//
// `kind` values:
//   - "item"      → leaf link (has a `permKey` matching ADMIN_NAV_KEYS)
//   - "group"     → expandable section with .children
//   - "subgroup"  → heading inside a group (renders as a non-clickable
//                   sub-section label with its own .children indented)
//   - "divider"   → thin grey rule between top-level items
//
// The structure here is the single source of truth; the rendering loop
// below just walks it. Every leaf carries a `permKey` (= the testid
// suffix without the "nav-" prefix) so granular per-user nav permissions
// can hide/show items individually.
const SIDEBAR = [
  { kind: "item", to: "/", label: "Dashboard", icon: LayoutDashboard, testid: "nav-dashboard", permKey: "dashboard" },
  { kind: "divider" },

  { kind: "item", to: "/orders", label: "Orders", icon: ShoppingBag, testid: "nav-orders", permKey: "orders" },
  { kind: "divider" },

  {
    kind: "group", key: "franchises", label: "Franchises", icon: Building2, testid: "nav-franchises-group",
    children: [
      { kind: "item", to: "/franchisees", label: "Franchises / Licences", icon: Users, testid: "nav-franchisees", permKey: "franchisees", alertBadge: "missing_mandate" },
      { kind: "item", to: "/renewals", label: "Renewals", icon: BellRing, testid: "nav-renewals", permKey: "renewals" },
      { kind: "item", to: "/territory-builder", label: "Territory Builder", icon: Target, testid: "nav-territory-builder", permKey: "territory-builder" },
      { kind: "item", to: "/files", label: "Files", icon: FolderOpen, testid: "nav-files", permKey: "files" },
    ],
  },
  { kind: "divider" },

  { kind: "item", to: "/contacts", label: "Sales & Contacts", icon: Contact, testid: "nav-contacts", permKey: "contacts" },
  { kind: "divider" },

  { kind: "item", to: "/calendar", label: "Calendar", icon: CalendarDays, testid: "nav-calendar", permKey: "calendar" },
  { kind: "divider" },

  {
    kind: "group", key: "admin", label: "Admin", icon: Wrench, testid: "nav-admin-group",
    children: [
      { kind: "item", to: "/find-class", label: "Find-a-Class", icon: MapPin, testid: "nav-find-class", permKey: "find-class" },
      { kind: "item", to: "/cqc-definitions", label: "CQC Definitions", icon: Stethoscope, testid: "nav-cqc-definitions", permKey: "cqc-definitions" },
      { kind: "item", to: "/scotland-definitions", label: "Scotland Definitions", icon: Stethoscope, testid: "nav-scotland-definitions", permKey: "scotland-definitions" },
      {
        kind: "subgroup", key: "sandras", label: "Sandra's Invoices", icon: Receipt,
        children: [
          { kind: "item", to: "/invoices", label: "Sandra's Invoices", icon: Receipt, testid: "nav-invoices", permKey: "invoices" },
          { kind: "item", to: "/banking", label: "Banking", icon: Banknote, testid: "nav-banking", permKey: "banking" },
        ],
      },
      {
        kind: "subgroup", key: "settings", label: "Settings", icon: Cog,
        children: [
          { kind: "item", to: "/admin/users", label: "Admin Users", icon: KeyRound, testid: "nav-admin-users", permKey: "admin-users" },
          { kind: "item", to: "/admin/xero", label: "Xero", icon: Calculator, testid: "nav-admin-xero", permKey: "admin-xero" },
          { kind: "item", to: "/form-intake", label: "Form Intake", icon: Inbox, testid: "nav-form-intake", permKey: "form-intake" },
        ],
      },
    ],
  },
];

// Single source-of-truth for permission key → human label and the route
// prefix it gates. Used by the Admin Users permissions modal and the
// Layout's page-guard effect. Order here drives display order in the
// permissions UI.
export const ADMIN_NAV_KEYS = [
  { key: "dashboard",        label: "Dashboard",            paths: ["/"] },
  { key: "orders",           label: "Orders",               paths: ["/orders"] },
  { key: "franchisees",      label: "Franchises / Licences", paths: ["/franchisees"] },
  { key: "renewals",         label: "Renewals",             paths: ["/renewals"] },
  { key: "territory-builder", label: "Territory Builder",   paths: ["/territory-builder"] },
  { key: "files",            label: "Files",                paths: ["/files"] },
  { key: "contacts",         label: "Sales & Contacts",     paths: ["/contacts"] },
  { key: "calendar",         label: "Calendar",             paths: ["/calendar"] },
  { key: "find-class",       label: "Find-a-Class",         paths: ["/find-class"] },
  { key: "cqc-definitions",  label: "CQC Definitions",      paths: ["/cqc-definitions"] },
  { key: "scotland-definitions", label: "Scotland Definitions", paths: ["/scotland-definitions"] },
  { key: "invoices",         label: "Sandra's Invoices",    paths: ["/invoices"] },
  { key: "banking",          label: "Banking",              paths: ["/banking"] },
  { key: "admin-users",      label: "Admin Users",          paths: ["/admin/users", "/admin/password-resets"] },
  { key: "admin-xero",       label: "Xero (settings)",      paths: ["/admin/xero"] },
  { key: "form-intake",      label: "Form Intake",          paths: ["/form-intake"] },
];

// Helper — does `nav_permissions` permit visiting a given path?
// `permissions === null/undefined` = full access (back-compat).
function pathAllowed(pathname, permissions) {
  if (permissions == null) return true;             // unrestricted
  if (!Array.isArray(permissions)) return true;     // defensive
  const allowedSet = new Set(permissions);
  for (const n of ADMIN_NAV_KEYS) {
    if (!allowedSet.has(n.key)) continue;
    for (const p of n.paths) {
      if (pathname === p) return true;
      if (p !== "/" && pathname.startsWith(p + "/")) return true;
    }
  }
  return false;
}

// Resolve the first allowed route — used as a "landing pad" when the
// user lands on (or refreshes onto) a forbidden URL.
function firstAllowedPath(permissions) {
  if (permissions == null) return "/";
  if (!Array.isArray(permissions) || permissions.length === 0) return "/change-password";
  const allowedSet = new Set(permissions);
  for (const n of ADMIN_NAV_KEYS) {
    if (allowedSet.has(n.key)) return n.paths[0];
  }
  return "/change-password";
}

// ---------------------------------------------------------------------------
// Leaf nav link — used at every level of the tree
// ---------------------------------------------------------------------------
function NavItem({ to, label, icon: Icon, testid, badge, depth = 0 }) {
  // Sub-items are indented to give visual hierarchy without arrow icons.
  const padLeft = depth === 0 ? "px-6" : depth === 1 ? "pl-10 pr-6" : "pl-14 pr-6";
  return (
    <NavLink
      to={to}
      end={to === "/"}
      data-testid={testid}
      className={({ isActive }) =>
        `flex items-center gap-3 ${padLeft} py-2 text-sm font-semibold transition-colors duration-150 border-l-2 ${
          isActive
            ? "bg-white text-stone-950 border-l-[#dddd16]"
            : "text-stone-600 hover:text-stone-950 border-l-transparent hover:bg-white/50"
        }`
      }
    >
      {Icon && <Icon className="w-4 h-4 shrink-0" strokeWidth={2} />}
      <span className="flex-1 truncate">{label}</span>
      {badge != null && badge > 0 && (
        <span
          data-testid={`${testid}-badge`}
          title={badge === 1 ? "1 alert" : `${badge} alerts`}
          className="shrink-0 min-w-[20px] h-5 px-1.5 inline-flex items-center justify-center rounded-full bg-red-600 text-white text-[10px] font-bold tabular-nums shadow-sm">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </NavLink>
  );
}

// ---------------------------------------------------------------------------
// Expandable group header (Franchises, Admin)
// ---------------------------------------------------------------------------
function GroupHeader({ label, icon: Icon, open, onToggle, testid }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      data-testid={testid}
      aria-expanded={open}
      className="w-full flex items-center gap-3 px-6 py-2 text-sm font-bold text-stone-700 hover:text-stone-950 transition-colors"
    >
      {Icon && <Icon className="w-4 h-4 shrink-0" strokeWidth={2} />}
      <span className="flex-1 text-left">{label}</span>
      <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={2} />
    </button>
  );
}

// Sub-group inside an expandable group (Sandra's Invoices, Settings)
function SubGroupHeader({ label, icon: Icon }) {
  return (
    <div className="pl-10 pr-6 pt-2 pb-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
      {Icon && <Icon className="w-3 h-3 shrink-0" strokeWidth={2} />}
      <span>{label}</span>
    </div>
  );
}

// Thin horizontal divider between top-level sections.
function Divider() {
  return <div className="mx-6 my-2 border-t border-stone-200" />;
}

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Per-user nav restriction. Admins without a list (or with null) see
  // everything (back-compat for the existing accounts pre-perms). When a
  // list is set, only those page keys render in the sidebar and only
  // their routes are reachable — direct URL access gets redirected.
  const navPermissions = user?.role === "admin" ? (user.nav_permissions ?? null) : null;

  // Filter the SIDEBAR tree to only branches that actually contain at
  // least one allowed leaf. Groups/subgroups vanish entirely once empty
  // so we don't leave dangling headers.
  const filteredSidebar = useMemo(() => {
    if (navPermissions == null) return SIDEBAR;
    const allowed = new Set(navPermissions);
    const walk = (nodes) => {
      const out = [];
      for (const n of nodes) {
        if (n.kind === "item") {
          if (!n.permKey || allowed.has(n.permKey)) out.push(n);
        } else if (n.kind === "group" || n.kind === "subgroup") {
          const kids = walk(n.children);
          if (kids.length > 0) out.push({ ...n, children: kids });
        } else if (n.kind === "divider") {
          // Keep dividers but collapse runs of them post-filter.
          out.push(n);
        }
      }
      // Trim leading / trailing / duplicate dividers.
      const trimmed = [];
      for (const n of out) {
        if (n.kind === "divider" && (trimmed.length === 0 || trimmed[trimmed.length - 1].kind === "divider")) continue;
        trimmed.push(n);
      }
      while (trimmed.length && trimmed[trimmed.length - 1].kind === "divider") trimmed.pop();
      return trimmed;
    };
    return walk(SIDEBAR);
  }, [navPermissions]);

  // Page guard — when the user navigates (or refreshes) to a route they
  // can't access, push them to their first allowed page instead. Skip
  // the universal "/change-password" route since that's always reachable
  // for force-change flows.
  useEffect(() => {
    if (navPermissions == null) return;
    if (location.pathname === "/change-password") return;
    if (!pathAllowed(location.pathname, navPermissions)) {
      const landing = firstAllowedPath(navPermissions);
      if (landing && landing !== location.pathname) navigate(landing, { replace: true });
    }
  }, [location.pathname, navPermissions, navigate]);

  // Track which expandable groups are open. Persisted in localStorage so
  // power-users keep their preferred layout across sessions.
  const [openGroups, setOpenGroups] = useState(() => {
    try {
      const raw = localStorage.getItem("cm.sidebar.openGroups");
      if (raw) return new Set(JSON.parse(raw));
    } catch {/* ignore */}
    return new Set();
  });
  const toggleGroup = (key) => {
    setOpenGroups((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key); else n.add(key);
      try { localStorage.setItem("cm.sidebar.openGroups", JSON.stringify(Array.from(n))); } catch {/* ignore */}
      return n;
    });
  };

  // Auto-open whichever group contains the currently active path — so a
  // direct deep-link to /admin/xero opens the Admin group on load. Also
  // auto-open groups for nav-restricted users where the only entry is
  // inside one (otherwise Sandra logs in and sees an empty-looking
  // sidebar with a collapsed Admin section).
  useEffect(() => {
    const path = location.pathname;
    setOpenGroups((s) => {
      const n = new Set(s);
      for (const node of filteredSidebar) {
        if (node.kind !== "group") continue;
        const has = (children) => children.some((c) =>
          (c.kind === "item" && (path === c.to || path.startsWith(c.to + "/")))
          || (c.kind === "subgroup" && has(c.children))
        );
        if (has(node.children) || navPermissions != null) n.add(node.key);
      }
      return n;
    });
  }, [location.pathname, filteredSidebar, navPermissions]);

  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  // Poll for the "missing GoCardless mandate" alert count.
  const [missingMandateCount, setMissingMandateCount] = useState(0);
  useEffect(() => {
    let active = true;
    const fetchAlerts = async () => {
      try {
        const { data } = await api.get("/franchisees/alerts/missing-mandate");
        if (active) setMissingMandateCount(data?.count || 0);
      } catch {/* ignore */}
    };
    fetchAlerts();
    const id = setInterval(fetchAlerts, 5 * 60 * 1000);
    return () => { active = false; clearInterval(id); };
  }, [user?.email]);

  // Resolve a dynamic badge value for a given item.
  const resolveBadge = (item) => {
    if (item.alertBadge === "missing_mandate") return missingMandateCount;
    return undefined;
  };

  // Renderer — walks the tree recursively.
  const renderNode = (node, idx, depth = 0) => {
    if (node.kind === "divider") return <Divider key={`d-${idx}`} />;
    if (node.kind === "item") {
      return <NavItem key={node.to} {...node} depth={depth} badge={resolveBadge(node)} />;
    }
    if (node.kind === "group") {
      const open = openGroups.has(node.key);
      return (
        <div key={node.key} data-testid={node.testid}>
          <GroupHeader
            label={node.label}
            icon={node.icon}
            open={open}
            onToggle={() => toggleGroup(node.key)}
            testid={`${node.testid}-toggle`}
          />
          {open && (
            <div className="pb-1">
              {node.children.map((c, i) => renderNode(c, i, depth + 1))}
            </div>
          )}
        </div>
      );
    }
    if (node.kind === "subgroup") {
      return (
        <div key={node.key}>
          <SubGroupHeader label={node.label} icon={node.icon} />
          {node.children.map((c, i) => renderNode(c, i, depth + 1))}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="min-h-screen flex bg-[#F9F9F8]">
      {/* Sidebar */}
      <aside className="w-[260px] shrink-0 bg-[#F2F2F0] border-r border-stone-200 flex flex-col" data-testid="sidebar">
        <div className="px-5 py-5 border-b border-stone-200 bg-white flex flex-col items-start gap-1.5">
          <Logo className="h-16" />
          <div className="text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold pl-1">Admin Console</div>
        </div>

        <nav className="flex-1 py-3 overflow-y-auto">
          {filteredSidebar.map((node, i) => renderNode(node, i, 0))}
        </nav>

        <div className="p-4 border-t border-stone-200 space-y-3">
          <div className="px-2">
            <div className="text-[10px] uppercase tracking-[0.2em] text-stone-500 font-bold">Signed in as</div>
            <div className="text-sm font-semibold text-stone-900 mt-0.5 truncate" data-testid="current-user-name">{user?.name}</div>
            <div className="text-xs text-stone-500 truncate" data-testid="current-user-email">{user?.email}</div>
          </div>
          <button
            onClick={handleLogout}
            data-testid="logout-button"
            className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-900 hover:bg-stone-50 transition-colors rounded-lg"
          >
            <LogOut className="w-3.5 h-3.5" /> Logout
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 min-w-0">
        <Outlet />
      </main>
    </div>
  );
}
