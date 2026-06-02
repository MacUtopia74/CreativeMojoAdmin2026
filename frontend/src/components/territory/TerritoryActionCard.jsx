// Small action card used at the top of My Territory+ for the
// "Show My Clients Only" + "Plan A Route" CTAs.
//
// Two visual states: inactive (white card with subtle border) and
// active (soft brand-yellow #eeee84 fill matching the panel headers).
// ``soon`` renders a "Soon" pill on the right to signal a coming-soon
// feature — the card stays clickable so the parent can show a tooltip
// or no-op silently.
import { ChevronRight } from "lucide-react";

export default function TerritoryActionCard({
  icon: Icon,
  title,
  subtitle,
  active = false,
  soon = false,
  onClick,
  testid,
}) {
  const bg = active ? "bg-[#eeee84] border-stone-950" : "bg-white border-stone-200 hover:border-stone-400";
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className={`w-full h-full flex items-center gap-3 px-4 py-4 sm:px-5 sm:py-5 rounded-2xl border transition-all text-left group ${bg}`}
    >
      <span className={`shrink-0 w-11 h-11 rounded-full flex items-center justify-center ${
        active ? "bg-stone-950 text-[#dedd0a]" : "bg-stone-100 text-stone-900 group-hover:bg-stone-200"
      }`}>
        {Icon && <Icon className="w-5 h-5" />}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-[0.25em] font-black text-stone-950 truncate flex items-center gap-2">
          {title}
          {soon && (
            <span className="px-1.5 py-0.5 rounded bg-stone-200 text-stone-700 text-[8px] font-black">SOON</span>
          )}
        </div>
        <div className="text-xs text-stone-600 mt-0.5 truncate">{subtitle}</div>
      </div>
      <ChevronRight className={`w-4 h-4 shrink-0 transition-transform ${active ? "text-stone-950" : "text-stone-400 group-hover:translate-x-0.5"}`} />
    </button>
  );
}
