// PortalBottomNav — bottom-tab navigation that only renders on small
// screens (`<md`). Tap a tab → smooth-scrolls to the matching section
// anchor in the portal dashboard (Hero / Files / Events / Profile).
// Active state highlights the section currently in the viewport using
// IntersectionObserver. Respects iOS safe-area-inset-bottom so it
// sits cleanly above the home indicator.
import { useEffect, useState } from "react";
import { Home, FolderOpen, CalendarDays, User as UserIcon, LogOut } from "lucide-react";

const TABS = [
  { id: "portal-section-home", label: "Home", icon: Home, testid: "tab-home" },
  { id: "portal-section-files", label: "Files", icon: FolderOpen, testid: "tab-files" },
  { id: "portal-section-events", label: "Events", icon: CalendarDays, testid: "tab-events" },
  { id: "portal-section-profile", label: "Profile", icon: UserIcon, testid: "tab-profile" },
];

export default function PortalBottomNav({ onLogout, sectionsRef }) {
  const [active, setActive] = useState("portal-section-home");

  useEffect(() => {
    // Track which section is currently in view — the one whose top is
    // nearest the top of the viewport wins. We re-build the observer
    // when the section refs change.
    const targets = TABS
      .map((t) => document.getElementById(t.id))
      .filter(Boolean);
    if (targets.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        // Pick the entry with the highest intersection ratio AND that
        // is at least partially above the midpoint of the viewport.
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
    const el = document.getElementById(id);
    if (!el) return;
    // Offset by the sticky header (~3.5rem) so the section title isn't
    // hidden behind it.
    const top = el.getBoundingClientRect().top + window.scrollY - 60;
    window.scrollTo({ top, behavior: "smooth" });
    setActive(id);
  };

  return (
    <nav
      data-testid="portal-bottom-nav"
      aria-label="Portal navigation"
      className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white/95 backdrop-blur-md border-t border-stone-200 pb-safe pl-safe pr-safe">
      <div className="grid grid-cols-5">
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
                isActive ? "text-stone-950" : "text-stone-500"
              }`}>
              <Icon className={`w-5 h-5 ${isActive ? "stroke-[2.5]" : ""}`} />
              <span className={`text-[10px] font-bold uppercase tracking-wider ${isActive ? "" : "opacity-80"}`}>
                {t.label}
              </span>
              {isActive && (
                <span className="absolute mt-9 w-1 h-1 rounded-full bg-[#DEDD0C]" aria-hidden="true" />
              )}
            </button>
          );
        })}
        <button
          type="button"
          onClick={onLogout}
          data-testid="tab-logout"
          className="touch-target flex flex-col items-center justify-center gap-0.5 py-2 text-stone-500 hover:text-red-700 transition-colors">
          <LogOut className="w-5 h-5" />
          <span className="text-[10px] font-bold uppercase tracking-wider opacity-80">Sign out</span>
        </button>
      </div>
    </nav>
  );
}
