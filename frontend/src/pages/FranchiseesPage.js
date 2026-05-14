import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import { Search, AlertCircle, RefreshCw, CreditCard, CheckCircle2, X } from "lucide-react";
import { formatDate } from "@/lib/date";

const SEGMENTS = [
  { key: "active", label: "Active", tag: "Franchisee" },
  { key: "ex", label: "Ex-Franchisees", tag: "EX-Franchisee" },
  { key: "licencee", label: "Worldwide Licencees", tag: "Worldwide Licencee" },
  { key: "all", label: "All", tag: null },
];

function hasTag(franchisee, tag) {
  const tags = franchisee.tags || [];
  return Array.isArray(tags) ? tags.includes(tag) : tags === tag;
}

// Phase 1.5 — GoCardless sync modal. Defaults to DRY-RUN until the operator
// explicitly hits "Commit to database".
function GoCardlessSyncModal({ open, onClose, onCommitted }) {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);
  const [err, setErr] = useState("");

  const run = async (dryRun) => {
    setBusy(true); setErr("");
    try {
      const { data } = await api.post(`/gocardless/mandates/sync?dry_run=${dryRun ? "true" : "false"}`);
      setReport(data);
      if (!dryRun) onCommitted?.();
    } catch (e) {
      setErr(e?.response?.data?.detail || "Sync failed.");
    } finally { setBusy(false); }
  };

  if (!open) return null;
  const committed = report && report.dry_run === false;

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 bg-stone-950/40 backdrop-blur-sm flex items-start justify-center p-6 overflow-y-auto" data-testid="gc-sync-modal">
      <div onClick={(e) => e.stopPropagation()} className="bg-white border border-stone-200 max-w-2xl w-full rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200">
          <div className="flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-stone-700" />
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">GoCardless Sync</div>
          </div>
          <button onClick={onClose} data-testid="gc-sync-close" className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {!report && !err && !busy && (
            <>
              <p className="text-sm text-stone-700">
                Read every active GoCardless customer and link them to franchisees by email
                (<code className="text-xs bg-stone-100 px-1 rounded">email</code>,
                <code className="text-xs bg-stone-100 px-1 rounded ml-1">mojo_email</code>,
                <code className="text-xs bg-stone-100 px-1 rounded ml-1">secondary_email</code>).
              </p>
              <p className="text-xs text-stone-500">A dry-run scans everything but writes nothing to the database — review the matches first, then commit.</p>
              <div className="flex items-center gap-2 pt-2">
                <button onClick={() => run(true)} data-testid="gc-sync-dryrun"
                  className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg flex items-center gap-1.5">
                  <RefreshCw className="w-3.5 h-3.5" /> Run Dry-Run
                </button>
              </div>
            </>
          )}
          {busy && (
            <div className="text-sm text-stone-600 flex items-center gap-2 py-6">
              <RefreshCw className="w-4 h-4 animate-spin" /> Talking to GoCardless…
            </div>
          )}
          {err && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg" data-testid="gc-sync-error">
              <AlertCircle className="w-4 h-4 inline mr-1" /> {err}
            </div>
          )}
          {report && (
            <div className="space-y-3" data-testid="gc-sync-report">
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-stone-50 border border-stone-200 rounded-lg p-3">
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">GC Customers</div>
                  <div className="font-display text-2xl text-stone-950 mt-1 tabular-nums">{report.customers_scanned}</div>
                </div>
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-emerald-700">Matched</div>
                  <div className="font-display text-2xl text-emerald-900 mt-1 tabular-nums" data-testid="gc-matched-count">{report.matched_count}</div>
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-amber-700">Unmatched</div>
                  <div className="font-display text-2xl text-amber-900 mt-1 tabular-nums">{report.unmatched_count}</div>
                </div>
              </div>
              {report.matched_preview?.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">Sample Matches</div>
                  <div className="border border-stone-200 rounded-lg divide-y divide-stone-100 max-h-56 overflow-y-auto text-xs">
                    {report.matched_preview.map((m) => (
                      <div key={m.franchisee_id + (m.mandate?.mandate_id || "")} className="px-3 py-2 flex items-center justify-between">
                        <span className="text-stone-700">{m.franchisee_email}</span>
                        <span className="text-stone-500 tabular-nums">{m.mandate?.mandate_id || "no mandate"} · {m.mandate?.status || "—"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {committed ? (
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 flex items-center gap-2 text-sm text-emerald-800" data-testid="gc-sync-committed">
                  <CheckCircle2 className="w-4 h-4" /> Committed {report.committed_count} franchisee link(s) to the database.
                </div>
              ) : (
                <div className="flex items-center justify-between pt-2 border-t border-stone-200">
                  <button onClick={() => { setReport(null); setErr(""); }} className="text-xs text-stone-500 hover:text-stone-900">Reset</button>
                  <button onClick={() => run(false)} disabled={busy} data-testid="gc-sync-commit"
                    className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-[#D4FF00] text-stone-950 hover:bg-[#BDE600] rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Commit to database
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function FranchiseesPage() {
  const [all, setAll] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [segment, setSegment] = useState("active");
  const [sortBy, setSortBy] = useState("franchise_number");
  const [sortDir, setSortDir] = useState(1);
  const [gcSyncOpen, setGcSyncOpen] = useState(false);
  const reload = async () => {
    try {
      const { data } = await api.get("/franchisees", { params: { limit: 500, sort_by: "franchise_number", sort_dir: 1 } });
      setAll(data.items || []);
    } catch (e) { setError("Could not load franchisees."); }
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { data } = await api.get("/franchisees", { params: { limit: 500, sort_by: "franchise_number", sort_dir: 1 } });
        setAll(data.items || []);
      } catch (e) {
        setError("Could not load franchisees.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Segment counts
  const counts = useMemo(() => {
    const c = { active: 0, ex: 0, licencee: 0, all: all.length };
    for (const f of all) {
      if (hasTag(f, "Franchisee")) c.active += 1;
      if (hasTag(f, "EX-Franchisee")) c.ex += 1;
      if (hasTag(f, "Worldwide Licencee")) c.licencee += 1;
    }
    return c;
  }, [all]);

  const filtered = useMemo(() => {
    const seg = SEGMENTS.find((s) => s.key === segment);
    let items = seg && seg.tag ? all.filter((f) => hasTag(f, seg.tag)) : [...all];
    if (search) {
      const q = search.toLowerCase();
      items = items.filter((f) =>
        [f.organisation, f.first_name, f.last_name, f.mojo_email, f.franchise_number, f.city, f.postcode]
          .filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
      );
    }
    items.sort((a, b) => {
      const va = a[sortBy] ?? "";
      const vb = b[sortBy] ?? "";
      if (va < vb) return -1 * sortDir;
      if (va > vb) return 1 * sortDir;
      return 0;
    });
    return items;
  }, [all, segment, search, sortBy, sortDir]);

  const headerClick = (col) => () => {
    if (sortBy === col) setSortDir(-sortDir);
    else { setSortBy(col); setSortDir(1); }
  };

  const SortArrow = ({ col }) => sortBy === col ? (
    <span className="text-stone-950 ml-1">{sortDir === 1 ? "↑" : "↓"}</span>
  ) : <span className="text-stone-300 ml-1">↕</span>;

  return (
    <div className="min-h-screen">
      <div className="h-16 border-b border-stone-200 bg-white flex items-center px-8 sticky top-0 z-10" data-testid="topbar">
        <div className="flex items-baseline gap-3 flex-1">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">CRM</div>
          <h1 className="font-display text-xl text-stone-950">Franchisees</h1>
          <span className="text-xs text-stone-500">{filtered.length} of {all.length} records</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setGcSyncOpen(true)} data-testid="gc-sync-button"
            className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-900 hover:bg-stone-50 rounded-lg flex items-center gap-1.5">
            <CreditCard className="w-3.5 h-3.5" /> Sync GoCardless
          </button>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="franchisee-search"
              placeholder="Search name, org, email, postcode…"
              className="pl-10 pr-4 py-2 w-80 bg-stone-50 border border-stone-300 text-sm focus:outline-none focus:border-stone-900 rounded-lg"
            />
          </div>
        </div>
      </div>

      <GoCardlessSyncModal open={gcSyncOpen} onClose={() => setGcSyncOpen(false)} onCommitted={reload} />

      {/* Segment tabs */}
      <div className="px-8 pt-6">
        <div className="flex border-b border-stone-200 -mb-px" data-testid="segment-tabs">
          {SEGMENTS.map((s) => {
            const active = segment === s.key;
            const count = counts[s.key];
            return (
              <button
                key={s.key}
                onClick={() => setSegment(s.key)}
                data-testid={`segment-${s.key}`}
                className={`px-5 py-3 text-sm font-bold transition-colors border-b-2 ${
                  active
                    ? "border-stone-950 text-stone-950"
                    : "border-transparent text-stone-500 hover:text-stone-900"
                }`}
              >
                {s.label}
                <span className={`ml-2 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-md ${
                  active ? "bg-[#D4FF00] text-stone-950" : "bg-stone-100 text-stone-600"
                }`}>{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="p-8 pt-6">
        {error && (
          <div className="mb-4 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2 rounded-xl">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}
        {loading ? (
          <div className="text-center text-stone-500 text-sm uppercase tracking-widest p-12" data-testid="franchisees-loading">Loading…</div>
        ) : (
          <div className="bg-white border border-stone-200 overflow-hidden rounded-2xl" data-testid="franchisees-table">
            <table className="w-full">
              <thead className="bg-[#F2F2F0] border-b border-stone-200">
                <tr>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-12">Photo</th>
                  <th onClick={headerClick("franchise_number")} className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 cursor-pointer hover:bg-stone-200/50 w-24">No. <SortArrow col="franchise_number" /></th>
                  <th onClick={headerClick("organisation")} className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 cursor-pointer hover:bg-stone-200/50">Organisation <SortArrow col="organisation" /></th>
                  <th onClick={headerClick("last_name")} className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 cursor-pointer hover:bg-stone-200/50">Name <SortArrow col="last_name" /></th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Mojo Email</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-28">Postcode</th>
                  <th onClick={headerClick("date_added")} className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 cursor-pointer hover:bg-stone-200/50 w-32">Added <SortArrow col="date_added" /></th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-24">Mandate</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={8} className="px-3 py-10 text-center text-sm text-stone-500">No franchisees in this view.</td></tr>
                ) : filtered.map((f) => {
                  const photo = f.photos?.[0]?.url;
                  return (
                    <tr key={f.id} className="border-b border-stone-100 hover:bg-stone-50 transition-colors" data-testid={`franchisee-row-${f.id}`}>
                      <td className="px-3 py-2">
                        {photo ? (
                          <img src={photo} alt="" className="w-32 h-32 object-cover rounded-2xl" />
                        ) : (
                          <div className="w-32 h-32 bg-stone-100 rounded-2xl flex items-center justify-center text-3xl font-bold text-stone-400">
                            {(f.first_name?.[0] || "?") + (f.last_name?.[0] || "")}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-stone-500">{f.franchise_number || "—"}</td>
                      <td className="px-3 py-2">
                        <Link to={`/franchisees/${f.id}`} className="text-sm font-semibold text-stone-950 hover:text-stone-700" data-testid={`franchisee-link-${f.id}`}>
                          {f.organisation || "(no organisation)"}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-sm text-stone-700">{[f.first_name, f.last_name].filter(Boolean).join(" ") || "—"}</td>
                      <td className="px-3 py-2 text-xs text-stone-600">{f.mojo_email || "—"}</td>
                      <td className="px-3 py-2 text-xs text-stone-700">{f.postcode || "—"}</td>
                      <td className="px-3 py-2 text-xs text-stone-500">{formatDate(f.date_added)}</td>
                      <td className="px-3 py-2">
                        {f.mandate ? (
                          <span className="inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-[#D4FF00]/20 border border-[#D4FF00]/60 text-stone-900 rounded-md">
                            {Array.isArray(f.mandate) ? f.mandate[0] : f.mandate}
                          </span>
                        ) : <span className="text-stone-300 text-xs">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
