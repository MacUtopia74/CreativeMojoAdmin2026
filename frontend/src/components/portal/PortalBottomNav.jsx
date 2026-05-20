// PortalBottomNav — bottom-tab navigation that only renders on small
// screens (`<md`). Tap a tab → smooth-scrolls to the matching section
// anchor in the portal dashboard (Hero / Files / Events / Profile).
// Active state highlights the section currently in the viewport using
// IntersectionObserver. Respects iOS safe-area-inset-bottom so it
// sits cleanly above the home indicator.
import { useEffect, useState } from "react";
import { Home, User as UserIcon, MapPin, CalendarDays, FolderOpen, LogOut } from "lucide-react";

const TABS = [
  { id: "portal-section-home",    label: "Home",    icon: Home,         testid: "tab-home" },
  { id: "portal-section-profile", label: "Profile", icon: UserIcon,     testid: "tab-profile" },
  { id: "portal-section-map",     label: "Map",     icon: MapPin,       testid: "tab-map" },
  { id: "portal-section-events",  label: "Events",  icon: CalendarDays, testid: "tab-events" },
  { id: "portal-section-files",   label: "Files",   icon: FolderOpen,   testid: "tab-files" },
];

export default function PortalBottomNav({ onLogout, sectionsRef, onTabSelect, openSections = {} }) {
  // Track which section is in the viewport (intersection-based) — used as a
  // secondary "you're here" hint when nothing is explicitly expanded.
  const [activeByViewport, setActiveByViewport] = useState("portal-section-home");

  useEffect(() => {
    const targets = TABS
      .map((t) => document.getElementById(t.id))
      .filter(Boolean);
    if (targets.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible.length > 0) setActiveByViewport(visible[0].target.id);
      },
      { rootMargin: "-30% 0px -50% 0px", threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    targets.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [sectionsRef]);

  const jumpTo = (id) => {
    // Whether this click will EXPAND the panel (true) vs COLLAPSE it
    // (false) — we only scroll-to-section on expand, otherwise re-tapping
    // the same tab would yank the user back to a now-collapsed pill at the
    // top. HOME is a special case: it closes everything AND scrolls all
    // the way back to the top of the page so the user sees the hero card.
    let willExpand = false;
    if (id !== "portal-section-home") {
      willExpand = !openSections[id];
    }

    // Let the parent toggle the corresponding panel (single source of
    // truth for open/closed state).
    onTabSelect && onTabSelect(id);

    if (id === "portal-section-home") {
      // Scroll all the way back to the very top of the page.
      requestAnimationFrame(() => {
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
      return;
    }

    if (!willExpand) return;

    // Defer scroll by one frame so React commits the new open state and
    // section heights settle before measuring. Use the LIVE sticky-header
    // height as the scroll offset so the tapped panel lands flush with
    // the top of the visible area (just under the header) regardless of
    // font-scale cycling, safe-area-inset, or notch heights.
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      const header = document.querySelector("header.sticky");
      const headerH = header ? header.getBoundingClientRect().height : 56;
      const top = el.getBoundingClientRect().top + window.scrollY - headerH - 4;
      window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    });
  };

  return (
    <nav
      data-testid="portal-bottom-nav"
      aria-label="Portal navigation"
      className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-[#dddd16] border-t border-stone-950/20 pb-safe pl-safe pr-safe shadow-[0_-4px_14px_rgba(0,0,0,0.06)]">
      <div className="grid grid-cols-6">
        {TABS.map((t) => {
          const Icon = t.icon;
          // ON state = the section's panel is currently expanded. HOME is
          // a special-case "everything collapsed" state.
          let isOn = false;
          if (t.id === "portal-section-home") {
            isOn = !openSections["portal-section-profile"]
                && !openSections["portal-section-map"]
                && !openSections["portal-section-events"]
                && !openSections["portal-section-files"];
          } else {
            isOn = !!openSections[t.id];
          }
          // Secondary hint: if nothing is on but the user has scrolled
          // into a section, surface it subtly.
          const viewportHint = !isOn && activeByViewport === t.id && t.id !== "portal-section-home";
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => jumpTo(t.id)}
              data-testid={t.testid}
              aria-pressed={isOn}
              className={`touch-target relative flex flex-col items-center justify-center gap-0.5 py-2 transition-all ${
                isOn
                  ? "text-stone-950 bg-stone-950/15"
                  : viewportHint
                    ? "text-stone-950/85"
                    : "text-stone-950/55"
              }`}>
              <Icon className={`w-5 h-5 ${isOn ? "stroke-[2.5]" : ""}`} />
              <span className={`text-[10px] font-bold uppercase tracking-wider ${isOn ? "" : "opacity-80"}`}>
                {t.label}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={onLogout}
          data-testid="tab-logout"
          className="touch-target flex flex-col items-center justify-center gap-0.5 py-2 text-stone-950/55 hover:text-red-700 transition-colors">
          <LogOut className="w-5 h-5" />
          <span className="text-[10px] font-bold uppercase tracking-wider opacity-80">Sign out</span>
        </button>
      </div>
    </nav>
  );
}
