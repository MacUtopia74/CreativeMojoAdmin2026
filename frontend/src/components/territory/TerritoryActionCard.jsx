// Small action card used at the top of My Territory+ for the
// "Show My Clients Only" + "Plan A Route" CTAs.
//
// Two visual states: inactive (white card with subtle border) and
// active (soft brand-yellow #eeee84 fill matching the panel headers).
// ``soon`` renders a "Soon" pill on the right to signal a coming-soon
// feature — the card stays clickable so the parent can show a tooltip
// or no-op silently.
// (no extra imports needed beyond what's used below)


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
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl border transition-all text-left group ${bg}`}
    >
      <span className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${
        active ? "bg-stone-950 text-[#dedd0a]" : "bg-stone-100 text-stone-900 group-hover:bg-stone-200"
      }`}>
        {Icon && <Icon className="w-4 h-4" />}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-[0.2em] font-black text-stone-950 truncate flex items-center gap-1.5">
          {title}
          {soon && (
            <span className="px-1.5 py-0.5 rounded bg-stone-200 text-stone-700 text-[8px] font-black">SOON</span>
          )}
        </div>
        <div className="text-[11px] text-stone-600 mt-0.5 truncate">{subtitle}</div>
      </div>
    </button>
  );
}
