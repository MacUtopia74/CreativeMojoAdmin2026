// Compact "Care Groups in your territory" breakdown card.
//
// Surfaces the top regulated providers (care groups) inside the
// franchisee's territory so they can spot wholesale-target
// opportunities at a glance without scrolling the home list.
//
// Each row is a clickable filter that delegates to ``onSelectProvider``
// — wired up at the widget level to drive the existing providerFilter
// state, so clicking "WCS Care Group · 11 homes" filters the list
// + map markers down to just that group's homes.
import { useMemo, useState } from "react";
import { Building2, ChevronDown } from "lucide-react";

export default function TerritoryCareGroupsCard({
  providers = [],        // [{ name, count }] — full ranked list (no top-N cap)
  totalHomes = 0,        // homes with a providerName (used to compute "Other")
  totalAllHomes = 0,     // homes in territory (denominator for % display)
  activeProvider = null, // current filter (highlight matching row)
  onSelectProvider = null, // (name | null) — toggles the filter
}) {
  const [showAll, setShowAll] = useState(false);
  // Default to the top 8 — feels scannable, still gives clear signal of
  // dominance. Expandable for the curious.
  const top = useMemo(() => providers.slice(0, showAll ? providers.length : 8), [providers, showAll]);

  if (!providers.length) return null;

  // Bar widths scaled against the largest count so the leader feels
  // dominant. Falls back to 4% so single-home groups still render a
  // small chip.
  const maxCount = providers[0]?.count || 1;
  const remainingCount = Math.max(0, totalAllHomes - totalHomes);

  return (
    <div className="bg-white border border-stone-200 rounded-2xl p-5 space-y-3" data-testid="care-groups-card">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 mb-1">
            <Building2 className="w-3.5 h-3.5" /> Care groups in your territory
          </div>
          <div className="text-sm text-stone-900">
            <strong>{providers.length}</strong> distinct care group{providers.length === 1 ? "" : "s"} across <strong>{totalHomes}</strong> home{totalHomes === 1 ? "" : "s"}
            {remainingCount > 0 && <span className="text-stone-500"> · {remainingCount} home{remainingCount === 1 ? "" : "s"} with no group on file</span>}
            <span className="text-stone-500"> · click any row to filter</span>
          </div>
        </div>
        {activeProvider && (
          <button
            onClick={() => onSelectProvider?.(null)}
            data-testid="care-groups-clear"
            className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-md border border-stone-300"
          >
            Clear filter
          </button>
        )}
      </div>

      <div className="space-y-1">
        {top.map((p) => {
          const active = activeProvider === p.name;
          const pct = totalHomes > 0 ? Math.round((p.count / totalHomes) * 100) : 0;
          const barWidth = Math.max(3, Math.round((p.count / maxCount) * 100));
          return (
            <button
              key={p.name}
              onClick={() => onSelectProvider?.(active ? null : p.name)}
              data-testid={`care-groups-row-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
              className={`w-full group flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
                active
                  ? "bg-stone-950 text-white"
                  : "hover:bg-stone-50 text-stone-900"
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-3 mb-1">
                  <div className={`text-sm font-semibold truncate ${active ? "text-white" : "text-stone-900"}`}>
                    {p.name}
                  </div>
                  <div className={`shrink-0 text-xs tabular-nums font-bold ${active ? "text-[#dddd16]" : "text-stone-900"}`}>
                    {p.count}
                    <span className={`ml-1.5 font-medium ${active ? "text-white/70" : "text-stone-500"}`}>· {pct}%</span>
                  </div>
                </div>
                <div className={`h-1.5 rounded-full overflow-hidden ${active ? "bg-white/15" : "bg-stone-100"}`}>
                  <div
                    className={`h-full rounded-full transition-all ${active ? "bg-[#dddd16]" : "bg-stone-900 group-hover:bg-stone-700"}`}
                    style={{ width: `${barWidth}%` }}
                  />
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {providers.length > 8 && (
        <button
          onClick={() => setShowAll((s) => !s)}
          data-testid="care-groups-expand"
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-stone-700 hover:text-stone-950 hover:bg-stone-50 rounded-md border border-dashed border-stone-300"
        >
          {showAll ? "Show top 8 only" : `Show all ${providers.length} care groups`}
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showAll ? "rotate-180" : ""}`} />
        </button>
      )}
    </div>
  );
}
