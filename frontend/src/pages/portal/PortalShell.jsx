// PortalShell — top-level layout for every /portal/* route.
//
// Desktop (md+): logo + brand bar on top, vertical sidebar on the left,
// page content via <Outlet />. Same shape as the admin Layout so the
// admin and the franchisee feel like one family of products.
//
// Mobile/tablet (<md): the sidebar collapses into the existing
// PortalBottomNav (bottom-tab style) so franchisees on a phone keep
// the thumb-friendly nav they're used to.
//
// Each tab is a real route — no more accordion / single-page collapse.
// Tapping "Invoicing" loads /portal/invoices, tapping "Territory" loads
// /portal/territory, etc.
import { useEffect, useState } from "react";
import { Outlet, NavLink, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import api from "@/lib/api";
import Logo from "@/components/Logo";
import {
  User as UserIcon, MapPin, CalendarDays, FolderOpen, Receipt,
  LogOut, Type, Loader2, AlertCircle, Megaphone, GraduationCap,
} from "lucide-react";

const FONT_SCALES = {
  small: { label: "Small", zoom: 0.9 },
  medium: { label: "Medium", zoom: 1 },
  large: { label: "Large", zoom: 1.15 },
  xlarge: { label: "Extra large", zoom: 1.3 },
};

// Map a tab id to a route. Sections are split with thin dividing rules
// per Paul's spec.
//
// Standard modules (always available): My Franchise, My Territory,
//   Calendar, HQ Updates, File Vault.
//
// Plus add-ons (subscription-gated, toggled per franchisee via the
// admin "Portal Modules" panel):
//   • territory_plus  → label becomes "My Territory+"
//   • marketing       → adds "Marketing" item
//   • invoicing       → adds "Invoicing" item
function buildTabs({ modules }) {
  const sections = [];
  // ---- Section 1: identity, territory, marketing, invoicing ----
  const s1 = [
    { to: "/portal/details", label: "My Franchise", icon: UserIcon, end: true, testid: "portal-nav-profile" },
  ];
  if (modules.map !== false) {
    s1.push({
      to: "/portal/territory",
      label: modules.territory_plus ? "My Territory+" : "My Territory",
      icon: MapPin,
      testid: "portal-nav-territory",
    });
  }
  if (modules.marketing === true) {
    s1.push({ to: "/portal/marketing", label: "Marketing", icon: Megaphone, testid: "portal-nav-marketing" });
  }
  if (modules.invoicing === true) {
    s1.push({ to: "/portal/invoices", label: "Invoicing", icon: Receipt, testid: "portal-nav-invoices" });
  }
  sections.push(s1);
  // ---- Section 2: comms + scheduling ----
  const s2 = [];
  if (modules.calendar !== false) s2.push({ to: "/portal/events", label: "Calendar", icon: CalendarDays, testid: "portal-nav-events" });
  // Training & Meetings is available for ALL franchisees (not gated).
  s2.push({ to: "/portal/training", label: "Training & Meetings", icon: GraduationCap, testid: "portal-nav-training" });
  s2.push({ to: "/portal/updates", label: "HQ Updates", icon: Megaphone, testid: "portal-nav-updates" });
  sections.push(s2);
  // ---- Section 3: files vault ----
  const s3 = [];
  if (modules.files !== false) s3.push({ to: "/portal/files", label: "File Vault", icon: FolderOpen, testid: "portal-nav-files" });
  sections.push(s3);
  return sections.filter((s) => s.length);
}

export default function PortalShell() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [profile, setProfile] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/portal/me");
        setProfile(data);
      } catch (e) {
        setErr(e?.response?.data?.detail || "Could not load your dashboard.");
      }
    })();
  }, []);

  const [fontScale, setFontScale] = useState(() => {
    try {
      const v = localStorage.getItem("portal.fontScale");
      return FONT_SCALES[v] ? v : "medium";
    } catch { return "medium"; }
  });
  useEffect(() => {
    try { localStorage.setItem("portal.fontScale", fontScale); }
    catch (e) { console.debug("[PortalShell] localStorage write blocked", e); }
  }, [fontScale]);

  const modules = profile?.profile?.portal_modules || {};
  const sections = buildTabs({ modules });
  const flatTabs = sections.flat();

  return (
    <div
      className="min-h-screen bg-[#FBFAF8] pl-safe pr-safe"
      style={{ zoom: FONT_SCALES[fontScale].zoom }}
      data-testid="portal-shell"
    >
      {/* Top bar — logo, font-size, sign-out (desktop). Always sticky. */}
      <header className="bg-white border-b border-stone-200 sticky top-0 z-30 pt-safe">
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-2 sm:py-3 flex items-center justify-between gap-2">
          <Logo className="h-7 sm:h-10 shrink-0 max-w-[40%]" />
          <div className="flex items-center gap-2 sm:gap-4">
            <button
              onClick={() => {
                const order = ["small", "medium", "large", "xlarge"];
                const next = order[(order.indexOf(fontScale) + 1) % order.length];
                setFontScale(next);
              }}
              title={`Text size: ${FONT_SCALES[fontScale].label} — click for the next size`}
              data-testid="portal-font-size"
              className="px-2.5 sm:px-3 py-2 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-lg flex items-center gap-1.5"
            >
              <Type className="w-3.5 h-3.5" />
              <span className="hidden md:inline">Text · {FONT_SCALES[fontScale].label}</span>
              <span className="md:hidden">{FONT_SCALES[fontScale].label}</span>
            </button>
            <div className="text-right hidden lg:block">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Signed in as</div>
              <div className="text-xs text-stone-900 font-mono truncate max-w-[180px]">{user?.email}</div>
            </div>
            <button
              onClick={logout}
              data-testid="portal-logout"
              className="hidden md:inline-flex px-3 py-2 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg items-center gap-1.5"
            >
              <LogOut className="w-3 h-3" /> Sign out
            </button>
          </div>
        </div>
      </header>

      {err && (
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 mt-4">
          <div className="px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-2xl flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        </div>
      )}
      {!profile && !err && (
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 mt-4">
          <div className="flex items-center gap-2 text-sm text-stone-500">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading your account…
          </div>
        </div>
      )}

      {profile && (
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-5 sm:py-8 flex gap-6">
          {/* Sidebar — md+ only. Mobile uses PortalBottomNav (rendered
              below outside the flex container). */}
          <aside className="hidden md:block w-56 shrink-0" data-testid="portal-sidebar">
            <nav className="sticky top-24 space-y-1">
              {sections.map((tabs, sIdx) => (
                <div key={sIdx}>
                  {sIdx > 0 && <div className="my-3 border-t border-stone-200" data-testid={`portal-nav-divider-${sIdx}`} />}
                  {tabs.map(({ to, label, icon: Icon, end, testid }) => (
                    <NavLink
                      key={to}
                      to={to}
                      end={end}
                      data-testid={testid}
                      className={({ isActive }) =>
                        `flex items-center gap-3 px-3 py-2.5 text-sm rounded-lg font-medium transition-colors ${
                          isActive
                            ? "bg-stone-950 text-white"
                            : "text-stone-700 hover:bg-stone-100"
                        }`
                      }
                    >
                      <Icon className="w-4 h-4" />
                      {label}
                    </NavLink>
                  ))}
                </div>
              ))}
            </nav>
          </aside>

          {/* Main content — page-specific via Outlet. */}
          <main className="flex-1 min-w-0 pb-[20vh] md:pb-8" data-testid="portal-main">
            {/* Provide the profile to children via outlet context */}
            <Outlet context={{ profile, refreshProfile: async () => {
              const { data } = await api.get("/portal/me");
              setProfile(data);
            } }} />
          </main>
        </div>
      )}

      {/* Mobile bottom-nav — visible <md only, navigates between routes. */}
      <PortalMobileBottomNav
        tabs={flatTabs}
        currentPath={location.pathname}
        onLogout={logout}
      />
    </div>
  );
}

// Slim mobile bottom-nav — purely route-based (one tap → one route).
function PortalMobileBottomNav({ tabs, currentPath, onLogout }) {
  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-stone-200 pb-safe"
      data-testid="portal-bottom-nav"
    >
      <div className="flex items-stretch overflow-x-auto">
        {tabs.map(({ to, label, icon: Icon, end, testid }) => {
          const active = end ? currentPath === to : currentPath.startsWith(to);
          return (
            <NavLink
              key={to}
              to={to}
              end={end}
              data-testid={testid}
              className={`flex-1 min-w-[68px] flex flex-col items-center justify-center gap-0.5 py-2 ${
                active ? "text-stone-950" : "text-stone-500"
              }`}
            >
              <Icon className={`w-5 h-5 ${active ? "" : "opacity-70"}`} />
              <span className="text-[10px] font-bold uppercase tracking-wider truncate max-w-full">{label}</span>
            </NavLink>
          );
        })}
        <button
          onClick={onLogout}
          data-testid="portal-bottom-logout"
          className="flex-1 min-w-[68px] flex flex-col items-center justify-center gap-0.5 py-2 text-stone-500 hover:text-stone-950"
        >
          <LogOut className="w-5 h-5 opacity-70" />
          <span className="text-[10px] font-bold uppercase tracking-wider">Sign out</span>
        </button>
      </div>
    </nav>
  );
}
