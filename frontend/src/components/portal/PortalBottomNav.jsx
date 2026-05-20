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

export default function PortalBottomNav({ onLogout, sectionsRef, onTabSelect }) {
  const [active, setActive] = useState("portal-section-home");

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
        if (visible.length > 0) setActive(visible[0].target.id);
      },
      { rootMargin: "-30% 0px -50% 0px", threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    targets.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [sectionsRef]);

  const jumpTo = (id) => {
    // Tell the parent to expand THIS section and collapse all others
    // (accordion behaviour requested by client). The parent will set the
    // matching `xxxOpen` flag to true and the rest to false BEFORE we
    // scroll, so the layout reaches its final height first — otherwise
    // scrollTo lands on a stale offset.
    onTabSelect && onTabSelect(id);
    // Defer scroll by one frame so React commits the new open/closed
    // state and DOM heights settle before we measure.
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY - 60;
      window.scrollTo({ top, behavior: "smooth" });
    });
    setActive(id);
  };

  return (
    <nav
      data-testid="portal-bottom-nav"
      aria-label="Portal navigation"
      className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-[#dddd16] border-t border-stone-950/20 pb-safe pl-safe pr-safe shadow-[0_-4px_14px_rgba(0,0,0,0.06)]">
      <div className="grid grid-cols-6">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = active === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => jumpTo(t.id)}
              data-testid={t.testid}
              className={`touch-target flex flex-col items-center justify-center gap-0.5 py-2 transition-colors ${
                isActive ? "text-stone-950" : "text-stone-950/70"
              }`}>
              <Icon className={`w-5 h-5 ${isActive ? "stroke-[2.5]" : ""}`} />
              <span className={`text-[10px] font-bold uppercase tracking-wider ${isActive ? "" : "opacity-80"}`}>
                {t.label}
              </span>
              {isActive && (
                <span className="mt-0.5 w-6 h-0.5 rounded-full bg-stone-950" aria-hidden="true" />
              )}
            </button>
          );
        })}
        <button
          type="button"
          onClick={onLogout}
          data-testid="tab-logout"
          className="touch-target flex flex-col items-center justify-center gap-0.5 py-2 text-stone-950/70 hover:text-red-700 transition-colors">
          <LogOut className="w-5 h-5" />
          <span className="text-[10px] font-bold uppercase tracking-wider opacity-80">Sign out</span>
        </button>
      </div>
    </nav>
  );
}
