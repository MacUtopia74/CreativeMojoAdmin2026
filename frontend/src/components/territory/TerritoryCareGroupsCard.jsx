// Compact "Care Groups in your territory" breakdown card.
//
// Surfaces the top regulated providers (care groups) inside the
// franchisee's territory so they can spot wholesale-target
// opportunities at a glance without scrolling the home list.
//
// Collapsible — defaults to closed (matches the homes-list pattern)
// so the dashboard stays scannable. Header uses the site-wide brand
// yellow #dedd0a.
import { useMemo, useState } from "react";
import { Building2, ChevronDown } from "lucide-react";

export default function TerritoryCareGroupsCard({
  providers = [],        // [{ name, count }] — full ranked list (no top-N cap)
  totalHomes = 0,        // homes with a providerName (used to compute %)
  totalAllHomes = 0,     // homes in territory (for "no group on file" note)
  activeProvider = null, // current filter (highlight matching row)
  onSelectProvider = null, // (name | null) — toggles the filter
}) {
  const [expanded, setExpanded] = useState(false);
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

  // Collapsed — yellow brand CTA matching the homes-list pattern.
  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        data-testid="expand-care-groups"
        className="w-full flex items-center justify-between gap-3 bg-[#dedd0a] hover:brightness-95 text-stone-950 rounded-2xl px-5 py-4 transition-all group"
      >
        <span className="flex items-center gap-3 min-w-0">
          <span className="w-9 h-9 rounded-full bg-stone-950 text-[#dedd0a] flex items-center justify-center shrink-0">
            <Building2 className="w-4 h-4" />
          </span>
          <span className="text-left min-w-0">
            <span className="block text-[10px] uppercase tracking-[0.3em] font-bold text-stone-950/70">
              Care groups in your territory
            </span>
            <span className="block text-sm font-semibold truncate text-stone-950">
              Expand to see {providers.length} care group{providers.length === 1 ? "" : "s"} across {totalHomes} home{totalHomes === 1 ? "" : "s"}
            </span>
          </span>
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-wider font-bold bg-stone-950 text-[#dedd0a] group-hover:bg-stone-800 px-3 py-1.5 rounded-full flex items-center gap-1.5">
          Expand <ChevronDown className="w-3.5 h-3.5" />
        </span>
      </button>
    );
  }

  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid="care-groups-card">
      <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between gap-3 flex-wrap" style={{ backgroundColor: "#dedd0a" }}>
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-9 h-9 rounded-full bg-stone-950 text-[#dedd0a] flex items-center justify-center shrink-0">
            <Building2 className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-950/70">
              Care groups in your territory
            </div>
            <div className="text-sm text-stone-950 mt-0.5">
              <strong>{providers.length}</strong> distinct group{providers.length === 1 ? "" : "s"} across <strong>{totalHomes}</strong> home{totalHomes === 1 ? "" : "s"}
              {remainingCount > 0 && <span className="text-stone-950/60"> · {remainingCount} with no group on file</span>}
              <span className="text-stone-950/60"> · click a row to filter</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {activeProvider && (
            <button
              onClick={() => onSelectProvider?.(null)}
              data-testid="care-groups-clear"
              className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950/10 hover:bg-stone-950/20 text-stone-950 rounded-md"
            >
              Clear filter
            </button>
          )}
          <button
            onClick={() => setExpanded(false)}
            data-testid="collapse-care-groups"
            className="w-7 h-7 rounded-full border border-stone-950 bg-stone-950 text-[#dedd0a] hover:bg-stone-800 flex items-center justify-center"
            aria-label="Hide care groups"
          >
            <ChevronDown className="w-3.5 h-3.5 rotate-180" />
          </button>
        </div>
      </div>

      <div className="px-5 py-4 space-y-1">
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
                  <div className={`shrink-0 text-xs tabular-nums font-bold ${active ? "text-[#dedd0a]" : "text-stone-900"}`}>
                    {p.count}
                    <span className={`ml-1.5 font-medium ${active ? "text-white/70" : "text-stone-500"}`}>· {pct}%</span>
                  </div>
                </div>
                <div className={`h-1.5 rounded-full overflow-hidden ${active ? "bg-white/15" : "bg-stone-100"}`}>
                  <div
                    className={`h-full rounded-full transition-all ${active ? "bg-[#dedd0a]" : "bg-stone-900 group-hover:bg-stone-700"}`}
                    style={{ width: `${barWidth}%` }}
                  />
                </div>
              </div>
            </button>
          );
        })}

        {providers.length > 8 && (
          <button
            onClick={() => setShowAll((s) => !s)}
            data-testid="care-groups-expand-all"
            className="w-full mt-2 flex items-center justify-center gap-1.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-stone-700 hover:text-stone-950 hover:bg-stone-50 rounded-md border border-dashed border-stone-300"
          >
            {showAll ? "Show top 8 only" : `Show all ${providers.length} care groups`}
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showAll ? "rotate-180" : ""}`} />
          </button>
        )}
      </div>
    </div>
  );
}
