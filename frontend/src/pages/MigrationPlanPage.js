import { useEffect, useState } from "react";
import api from "@/lib/api";
import { Check, X, Edit3, Combine, HelpCircle, Download, AlertCircle } from "lucide-react";

const ICONS = { keep: Check, rename: Edit3, drop: X, merge: Combine, undecided: HelpCircle };
const COLORS = {
  keep: "text-emerald-700 bg-emerald-50",
  rename: "text-blue-700 bg-blue-50",
  drop: "text-red-700 bg-red-50",
  merge: "text-purple-700 bg-purple-50",
  undecided: "text-stone-500 bg-stone-50",
};

function StatTile({ label, value, decision }) {
  const Icon = ICONS[decision];
  return (
    <div className={`p-5 ${COLORS[decision]} border border-stone-200`} data-testid={`stat-${decision}`}>
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4" />
        <div className="text-[10px] uppercase tracking-[0.2em] font-bold">{label}</div>
      </div>
      <div className="font-display font-black text-3xl mt-2 text-stone-950">{value}</div>
    </div>
  );
}

export default function MigrationPlanPage() {
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/migration/plan");
        setPlan(data);
      } catch (e) {
        setError("Could not load migration plan.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const downloadJson = () => {
    if (!plan) return;
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `creative-mojo-migration-plan-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadMarkdown = () => {
    if (!plan) return;
    let md = `# Creative Mojo — Airtable Migration Plan\n\n`;
    md += `Generated: ${new Date().toISOString()}\n\n`;
    md += `## Totals\n`;
    Object.entries(plan.totals).forEach(([k, v]) => { md += `- **${k}**: ${v}\n`; });
    md += `\n---\n\n`;
    plan.tables.forEach((t) => {
      const status = t.migrate === true ? "✅ MIGRATE" : t.migrate === false ? "❌ SKIP" : "⏳ UNDECIDED";
      md += `## ${t.table_name} — ${status}\n`;
      md += `Fields: ${t.field_count} · `;
      md += Object.entries(t.counts).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(" · ") + "\n\n";
      if (t.notes) md += `> ${t.notes}\n\n`;
      if (t.migrate !== false) {
        md += `| # | Field | Type | Decision | Rename to | Merge with | Notes |\n`;
        md += `|---|---|---|---|---|---|---|\n`;
        t.fields.forEach((f, i) => {
          md += `| ${i + 1} | ${f.field_name} | ${f.field_type} | ${f.decision} | ${f.rename_to || ""} | ${f.merge_with || ""} | ${f.notes || ""} |\n`;
        });
      }
      md += `\n`;
    });
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `creative-mojo-migration-plan-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen">
      <div className="h-16 border-b border-stone-200 bg-white flex items-center px-8 sticky top-0 z-10" data-testid="topbar">
        <div className="flex items-baseline gap-3 flex-1">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">Phase 1 — Migration</div>
          <h1 className="font-display font-black text-xl text-stone-950 tracking-tight">Migration Plan</h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={downloadMarkdown} data-testid="download-md" className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white hover:bg-stone-50 flex items-center gap-1.5 rounded-lg">
            <Download className="w-3.5 h-3.5" /> Markdown
          </button>
          <button onClick={downloadJson} data-testid="download-json" className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 flex items-center gap-1.5 rounded-lg">
            <Download className="w-3.5 h-3.5" /> JSON
          </button>
        </div>
      </div>

      <div className="p-8 space-y-8">
        {error && (
          <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2 rounded-xl">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}
        {loading ? (
          <div className="text-center text-stone-500 text-sm font-mono uppercase tracking-widest p-12">Loading…</div>
        ) : plan && (
          <>
            {/* Totals */}
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-3">Field Decision Totals (across all tables)</div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-px bg-stone-200 border border-stone-200 rounded-2xl overflow-hidden">
                <StatTile label="Keep" value={plan.totals.keep} decision="keep" />
                <StatTile label="Rename" value={plan.totals.rename} decision="rename" />
                <StatTile label="Merge" value={plan.totals.merge} decision="merge" />
                <StatTile label="Drop" value={plan.totals.drop} decision="drop" />
                <StatTile label="Undecided" value={plan.totals.undecided} decision="undecided" />
              </div>
            </div>

            {/* Per-table list */}
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-3">Per-Table Breakdown</div>
              <div className="bg-white border border-stone-200 divide-y divide-stone-200 rounded-2xl overflow-hidden">
                {plan.tables.map((t) => {
                  const status = t.migrate === true ? "Migrate" : t.migrate === false ? "Skip" : "Undecided";
                  const statusColor = t.migrate === true ? "bg-emerald-600 text-white" : t.migrate === false ? "bg-stone-300 text-stone-700" : "bg-amber-100 text-amber-800";
                  return (
                    <div key={t.table_id} className="p-5 hover:bg-stone-50/50 transition-colors" data-testid={`plan-table-${t.table_id}`}>
                      <div className="flex items-center justify-between flex-wrap gap-3">
                        <div className="flex items-center gap-3">
                          <span className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-md ${statusColor}`}>{status}</span>
                          <div className="font-display font-bold text-lg text-stone-950">{t.table_name}</div>
                          <div className="text-xs text-stone-500 font-mono">{t.field_count} fields</div>
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          {Object.entries(t.counts).filter(([, v]) => v > 0).map(([k, v]) => (
                            <span key={k} className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-md ${COLORS[k]}`}>{v} {k}</span>
                          ))}
                        </div>
                      </div>
                      {t.notes && <div className="text-sm text-stone-600 mt-2 italic">{t.notes}</div>}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="text-xs text-stone-500 font-mono">
              When all decisions are captured, send me to start the migration. Or download the plan above to review offline.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
