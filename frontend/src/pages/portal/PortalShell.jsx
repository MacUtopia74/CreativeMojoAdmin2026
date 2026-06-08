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
import useUnreadUpdates from "@/hooks/useUnreadUpdates";
import {
  User as UserIcon, MapPin, CalendarDays, FolderOpen, Receipt,
  LogOut, Type, Loader2, AlertCircle, Megaphone, GraduationCap,
  CalendarClock, KeyRound, Sparkles, UserCog, ChevronDown, ShoppingBag,
  Menu, X, Facebook, LifeBuoy,
} from "lucide-react";
import PortalHelpModal from "@/components/portal/PortalHelpModal";

// Private community Facebook group — every franchisee gets the same
// button to keep the link consistent and visible across every portal
// page. Meta blocks embedding private groups so the only viable UX
// is opening it in a new tab.
const COMFORT_ZONE_FB_URL = "https://www.facebook.com/groups/223912961485958/";

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
function buildTabs({ modules, isDemo }) {
  const sections = [];
  // ---- Section 1: identity, territory, marketing, invoicing ----
  const s1 = [
    { to: "/portal/details", label: "My Franchise", icon: UserIcon, end: true, testid: "portal-nav-profile" },
  ];
  if (modules.map !== false) {
    if (isDemo) {
      // Demo account — render BOTH nav entries side-by-side so the user
      // can flip between vanilla and the upgraded view to demonstrate
      // what the bolt-on adds. The "basic" route forces the widget out
      // of Territory+ mode regardless of the demo's portal_modules flag.
      s1.push({
        to: "/portal/territory/basic",
        label: "My Territory",
        icon: MapPin,
        end: true,
        testid: "portal-nav-territory",
      });
      s1.push({
        to: "/portal/territory",
        label: "My Territory+",
        icon: MapPin,
        end: true,
        testid: "portal-nav-territory-plus",
      });
    } else {
      s1.push({
        to: "/portal/territory",
        label: modules.territory_plus ? "My Territory+" : "My Territory",
        icon: MapPin,
        testid: "portal-nav-territory",
      });
    }
  }
  // Bookings — placeholder for now, ships behind a "coming soon" page.
  // Available to all franchisees so they can register interest. Branded
  // with the trailing "+" to match the other bolt-ons.
  s1.push({ to: "/portal/bookings", label: "Bookings+", icon: CalendarClock, testid: "portal-nav-bookings" });
  if (modules.marketing === true) {
    s1.push({ to: "/portal/marketing", label: "Marketing+", icon: Megaphone, testid: "portal-nav-marketing" });
  }
  if (modules.invoicing === true) {
    s1.push({ to: "/portal/invoices", label: "Invoicing+", icon: Receipt, testid: "portal-nav-invoices" });
  }
  sections.push(s1);
  // ---- Section 2: comms + scheduling ----
  const s2 = [];
  if (modules.calendar !== false) s2.push({ to: "/portal/events", label: "Calendar", icon: CalendarDays, testid: "portal-nav-events" });
  // Video Hub is available for ALL franchisees (not gated).
  s2.push({ to: "/portal/training", label: "Video Hub", icon: GraduationCap, testid: "portal-nav-training" });
  s2.push({ to: "/portal/updates", label: "HQ Updates", icon: Megaphone, testid: "portal-nav-updates" });
  sections.push(s2);
  // ---- Section 3: files vault ----
  const s3 = [];
  if (modules.files !== false) s3.push({ to: "/portal/files", label: "File Vault", icon: FolderOpen, testid: "portal-nav-files" });
  sections.push(s3);
  // ---- Section 4: HQ shop (Shape Orders) — sits in its own band
  // between File Vault and Account so it visually reads as a
  // "stores / supplies" area rather than a portal feature.
  const s4 = [];
  if (modules.shape_orders === true) {
    s4.push({ to: "/portal/shape-orders", label: "Franchise Store", icon: ShoppingBag, testid: "portal-nav-shape-orders" });
  }
  sections.push(s4);
  // ---- Section 5: account (always last) — change password, subscriptions, sign out
  const s5 = [
    { to: "/portal/account/password", label: "Change password", icon: KeyRound, testid: "portal-nav-password" },
    { to: "/portal/account/subscriptions", label: "Subscriptions", icon: Sparkles, testid: "portal-nav-subscriptions" },
  ];
  sections.push(s5);
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
  // Demo accounts get extra side-by-side nav entries (e.g. "My Territory"
  // AND "My Territory+") so the user can show off the upgrade to
  // prospective franchisees.
  const tags = profile?.profile?.tags || [];
  const isDemo = tags.some((t) => String(t).trim().toLowerCase() === "demo");
  const sections = buildTabs({ modules, isDemo });

  // HQ Updates unread badge — visible on the sidebar + bottom-nav.
  // Polls every 60s and on focus; refresh() is also called explicitly
  // by PortalUpdatesPage via the OutletContext below when the user
  // opens an update so the badge clears instantly.
  const { unread: unreadUpdates, refresh: refreshUnreadUpdates } = useUnreadUpdates(!!profile);

  // Account dropdown — auto-opens if the user is currently on any
  // /portal/account/* route (so a fresh navigate doesn't hide the
  // active tab) or if they explicitly toggled it open.
  const onAccountRoute = location.pathname.startsWith("/portal/account");
  const [accountOpen, setAccountOpen] = useState(onAccountRoute);
  useEffect(() => {
    if (onAccountRoute) setAccountOpen(true);
  }, [onAccountRoute]);

  // Mobile drawer state — closes automatically on route change so the
  // user lands on the new page without the menu still covering it.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => { setMobileNavOpen(false); }, [location.pathname]);
  // Lock background scroll while drawer is open.
  useEffect(() => {
    if (!mobileNavOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [mobileNavOpen]);

  return (
    <div
      className="min-h-screen bg-[#FBFAF8] pl-safe pr-safe"
      style={{ zoom: FONT_SCALES[fontScale].zoom }}
      data-testid="portal-shell"
    >
      {/* Top bar — logo, font-size, sign-out (desktop). Always sticky. */}
      <header className="bg-white border-b border-stone-200 sticky top-0 z-30 pt-safe">
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-2 sm:py-3 flex items-center justify-between gap-2">
          <Logo className="h-12 sm:h-16 shrink-0 max-w-[55%]" />
          <div className="flex items-center gap-2 sm:gap-4">
            {/* Help — opens a full-screen modal with the marked-up
                screenshot HQ has uploaded for the current page. Same
                style + position the Comfort Zone button used to live
                in; Comfort Zone has moved into the sidebar. */}
            <button
              onClick={() => setHelpOpen(true)}
              data-testid="portal-help-btn"
              title="Show me what this page does"
              className="px-2.5 sm:px-4 py-2 text-[10px] sm:text-xs font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-lg flex items-center gap-1.5 sm:gap-2 transition-colors shadow-sm"
            >
              <LifeBuoy className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <span className="hidden sm:inline">Help</span>
            </button>
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
            {/* Hamburger — mobile only. Opens the full-screen drawer that
                mirrors the desktop sidebar. */}
            <button
              onClick={() => setMobileNavOpen(true)}
              data-testid="portal-mobile-menu-btn"
              aria-label="Open menu"
              className="md:hidden p-2 -mr-1 text-stone-800 hover:bg-stone-100 rounded-lg"
            >
              <Menu className="w-6 h-6" strokeWidth={2.2} />
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
              {sections.map((tabs, sIdx) => {
                const isAccount = sIdx === sections.length - 1;
                if (isAccount) {
                  return (
                    <div key={sIdx}>
                      <div className="my-3 border-t border-stone-200" data-testid={`portal-nav-divider-${sIdx}`} />
                      {/* Creative Mojo Comfort Zone — Facebook group
                          link sitting between Franchise Store and the
                          Account dropdown, framed by the regular
                          section dividers so it reads as a peer of the
                          other nav rows rather than a special CTA. */}
                      <a
                        href={COMFORT_ZONE_FB_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid="portal-nav-comfort-zone"
                        title="Open the Creative Mojo Comfort Zone private Facebook group"
                        className="w-full flex items-center gap-3 px-3 py-2.5 text-sm rounded-lg font-medium transition-colors text-stone-700 hover:bg-stone-100"
                      >
                        <Facebook className="w-4 h-4 shrink-0 text-[#1877F2]" />
                        <span>Comfort Zone</span>
                      </a>
                      <div className="my-3 border-t border-stone-200" data-testid={`portal-nav-divider-${sIdx}-account`} />
                      <button
                        type="button"
                        onClick={() => setAccountOpen((v) => !v)}
                        aria-expanded={accountOpen}
                        data-testid="portal-nav-account-toggle"
                        className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 text-sm rounded-lg font-medium transition-colors ${
                          accountOpen ? "bg-stone-100 text-stone-950" : "text-stone-700 hover:bg-stone-100"
                        }`}
                      >
                        <span className="flex items-center gap-3 min-w-0">
                          <UserCog className="w-4 h-4 shrink-0" />
                          <span>Account</span>
                        </span>
                        <ChevronDown
                          className={`w-4 h-4 shrink-0 transition-transform ${accountOpen ? "rotate-180" : ""}`}
                        />
                      </button>
                      {accountOpen && (
                        <div className="mt-1 ml-3 pl-3 border-l border-stone-200 space-y-1" data-testid="portal-nav-account-panel">
                          {tabs.map(({ to, label, icon: Icon, end, testid }) => (
                            <NavLink
                              key={to}
                              to={to}
                              end={end}
                              data-testid={testid}
                              className={({ isActive }) =>
                                `flex items-center gap-3 px-3 py-2 text-sm rounded-lg font-medium transition-colors ${
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
                          <button
                            onClick={logout}
                            data-testid="portal-logout"
                            className="w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg font-medium transition-colors text-stone-700 hover:bg-stone-100"
                          >
                            <LogOut className="w-4 h-4" />
                            Sign out
                          </button>
                        </div>
                      )}
                    </div>
                  );
                }
                return (
                  <div key={sIdx}>
                    {sIdx > 0 && <div className="my-3 border-t border-stone-200" data-testid={`portal-nav-divider-${sIdx}`} />}
                    {tabs.map(({ to, label, icon: Icon, end, testid }) => {
                      const showBadge = to === "/portal/updates" && unreadUpdates > 0;
                      return (
                        <NavLink
                          key={to}
                          to={to}
                          end={end}
                          data-testid={testid}
                          className={({ isActive }) =>
                            `relative flex items-center gap-3 px-3 py-2.5 text-sm rounded-lg font-medium transition-colors ${
                              isActive
                                ? "bg-stone-950 text-white"
                                : "text-stone-700 hover:bg-stone-100"
                            }`
                          }
                        >
                          <Icon className="w-4 h-4" />
                          <span className="flex-1">{label}</span>
                          {showBadge && (
                            <span
                              data-testid="nav-updates-badge"
                              className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 text-[10px] font-bold rounded-full bg-rose-600 text-white tabular-nums shadow-sm"
                              title={`${unreadUpdates} unread update${unreadUpdates === 1 ? "" : "s"}`}
                            >
                              {unreadUpdates > 99 ? "99+" : unreadUpdates}
                            </span>
                          )}
                        </NavLink>
                      );
                    })}
                  </div>
                );
              })}
            </nav>
          </aside>

          {/* Main content — page-specific via Outlet. */}
          <main className="flex-1 min-w-0 pb-8" data-testid="portal-main">
            {/* Provide the profile + unread-updates refresher to children via outlet context */}
            <Outlet context={{
              profile,
              refreshProfile: async () => {
                const { data } = await api.get("/portal/me");
                setProfile(data);
              },
              refreshUnreadUpdates,
            }} />
          </main>
        </div>
      )}

      {/* Mobile drawer — slides down from the top, mirrors the desktop
          sidebar order including the Account dropdown. Visible <md only. */}
      <PortalMobileDrawer
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        sections={sections}
        accountOpen={accountOpen}
        onToggleAccount={() => setAccountOpen((v) => !v)}
        onLogout={logout}
        userEmail={user?.email}
        unreadUpdates={unreadUpdates}
      />
      <PortalHelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

// Mobile drawer — full-screen overlay that mirrors the desktop sidebar.
// Last section is the Account dropdown so behaviour matches md+ exactly.
function PortalMobileDrawer({
  open, onClose, sections, accountOpen, onToggleAccount, onLogout, userEmail,
  unreadUpdates = 0,
}) {
  if (!open) return null;
  return (
    <div className="md:hidden fixed inset-0 z-50" data-testid="portal-mobile-drawer">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className="absolute inset-0 bg-stone-950/60 backdrop-blur-sm"
        data-testid="portal-mobile-drawer-backdrop"
      />
      {/* Panel — slides in from the right, full height */}
      <div
        className="absolute top-0 right-0 bottom-0 w-[86%] max-w-sm bg-white shadow-2xl flex flex-col pt-safe pb-safe animate-[slideIn_180ms_ease-out]"
        style={{ animationName: "slideIn" }}
      >
        <div className="px-5 py-4 flex items-center justify-between border-b border-stone-200">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Signed in as</div>
            <div className="text-xs text-stone-900 font-mono truncate">{userEmail}</div>
          </div>
          <button
            onClick={onClose}
            data-testid="portal-mobile-drawer-close"
            aria-label="Close menu"
            className="p-2 -mr-1 text-stone-800 hover:bg-stone-100 rounded-lg shrink-0"
          >
            <X className="w-6 h-6" strokeWidth={2.2} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {sections.map((tabs, sIdx) => {
            const isAccount = sIdx === sections.length - 1;
            if (isAccount) {
              return (
                <div key={sIdx}>
                  <div className="my-3 border-t border-stone-200" />
                  <a
                    href={COMFORT_ZONE_FB_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={onClose}
                    data-testid="portal-mobile-comfort-zone"
                    className="w-full flex items-center gap-3 px-3 py-3 text-base rounded-lg font-medium transition-colors text-stone-700 hover:bg-stone-100"
                  >
                    <Facebook className="w-5 h-5 shrink-0 text-[#1877F2]" />
                    <span>Comfort Zone</span>
                  </a>
                  <div className="my-3 border-t border-stone-200" />
                  <button
                    type="button"
                    onClick={onToggleAccount}
                    aria-expanded={accountOpen}
                    data-testid="portal-mobile-account-toggle"
                    className={`w-full flex items-center justify-between gap-3 px-3 py-3 text-base rounded-lg font-medium transition-colors ${
                      accountOpen ? "bg-stone-100 text-stone-950" : "text-stone-700 hover:bg-stone-100"
                    }`}
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <UserCog className="w-5 h-5 shrink-0" />
                      <span>Account</span>
                    </span>
                    <ChevronDown className={`w-5 h-5 shrink-0 transition-transform ${accountOpen ? "rotate-180" : ""}`} />
                  </button>
                  {accountOpen && (
                    <div className="mt-1 ml-3 pl-3 border-l border-stone-200 space-y-1">
                      {tabs.map(({ to, label, icon: Icon, end, testid }) => (
                        <NavLink
                          key={to}
                          to={to}
                          end={end}
                          data-testid={testid}
                          className={({ isActive }) =>
                            `flex items-center gap-3 px-3 py-2.5 text-base rounded-lg font-medium transition-colors ${
                              isActive
                                ? "bg-stone-950 text-white"
                                : "text-stone-700 hover:bg-stone-100"
                            }`
                          }
                        >
                          <Icon className="w-5 h-5" />
                          {label}
                        </NavLink>
                      ))}
                      <button
                        onClick={onLogout}
                        data-testid="portal-mobile-logout"
                        className="w-full flex items-center gap-3 px-3 py-2.5 text-base rounded-lg font-medium transition-colors text-stone-700 hover:bg-stone-100"
                      >
                        <LogOut className="w-5 h-5" />
                        Sign out
                      </button>
                    </div>
                  )}
                </div>
              );
            }
            return (
              <div key={sIdx}>
                {sIdx > 0 && <div className="my-3 border-t border-stone-200" />}
                {tabs.map(({ to, label, icon: Icon, end, testid }) => {
                  const showBadge = to === "/portal/updates" && unreadUpdates > 0;
                  return (
                    <NavLink
                      key={to}
                      to={to}
                      end={end}
                      data-testid={testid}
                      className={({ isActive }) =>
                        `relative flex items-center gap-3 px-3 py-3 text-base rounded-lg font-medium transition-colors ${
                          isActive
                            ? "bg-stone-950 text-white"
                            : "text-stone-700 hover:bg-stone-100"
                        }`
                      }
                    >
                      <Icon className="w-5 h-5" />
                      <span className="flex-1">{label}</span>
                      {showBadge && (
                        <span
                          data-testid="mobile-nav-updates-badge"
                          className="inline-flex items-center justify-center min-w-[1.4rem] h-6 px-1.5 text-xs font-bold rounded-full bg-rose-600 text-white tabular-nums shadow-sm"
                        >
                          {unreadUpdates > 99 ? "99+" : unreadUpdates}
                        </span>
                      )}
                    </NavLink>
                  );
                })}
              </div>
            );
          })}
        </nav>
      </div>

      {/* Inline keyframes for the slide-in panel (Tailwind doesn't ship
          this out of the box and adding it to tailwind.config is overkill
          for a single transition). */}
      <style>{`
        @keyframes slideIn {
          from { transform: translateX(100%); }
          to   { transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
