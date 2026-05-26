import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import { Search, AlertCircle, RefreshCw, CreditCard, CheckCircle2, X, ChevronDown, LayoutGrid, List as ListIcon, Mail, Phone, ArrowRight } from "lucide-react";
import { formatDate } from "@/lib/date";

// Live GoCardless mandate pill — mirrors the one on FranchiseeDetailPage so the
// list and detail views stay visually in sync.
const MANDATE_STYLE = {
  active: "bg-emerald-100 text-emerald-800 border-emerald-300",
  pending_submission: "bg-blue-100 text-blue-800 border-blue-300",
  submitted: "bg-blue-100 text-blue-800 border-blue-300",
  pending_customer_approval: "bg-amber-100 text-amber-800 border-amber-300",
  cancelled: "bg-red-100 text-red-800 border-red-300",
  failed: "bg-red-100 text-red-800 border-red-300",
  expired: "bg-stone-200 text-stone-700 border-stone-300",
  consumed: "bg-stone-200 text-stone-700 border-stone-300",
};
const MANDATE_LABEL = {
  active: "Active",
  pending_submission: "Pending",
  submitted: "Submitted",
  pending_customer_approval: "Awaiting",
  cancelled: "Cancelled",
  failed: "Failed",
  expired: "Expired",
  consumed: "Consumed",
};
function MandateCell({ franchisee }) {
  const s = franchisee.gocardless_mandate_status;
  if (!s) {
    if (franchisee.gocardless_customer_id) {
      return <span className="text-stone-400 text-[10px] uppercase tracking-wider">No mandate</span>;
    }
    return <span className="text-stone-300 text-xs">—</span>;
  }
  const href = franchisee.gocardless_mandate_id
    ? `https://manage.gocardless.com/mandates/${franchisee.gocardless_mandate_id}`
    : "https://manage.gocardless.com/sign-in";
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      data-testid={`mandate-${franchisee.id}`}
      title={franchisee.gocardless_mandate_id ? `Open ${franchisee.gocardless_mandate_id} on GoCardless` : "Open GoCardless"}
      className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border rounded-md hover:opacity-80 transition-opacity ${MANDATE_STYLE[s] || "bg-stone-100 text-stone-600 border-stone-200"}`}>
      {MANDATE_LABEL[s] || s} ↗
    </a>
  );
}

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
                    className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] text-stone-950 hover:bg-[#aaaa11] rounded-lg flex items-center gap-1.5 disabled:opacity-50">
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

function MissingMandateRow({ item, onResolved }) {
  const [showLink, setShowLink] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    const e = (email || "").trim().toLowerCase();
    if (!e || !e.includes("@")) {
      setErr("Enter a valid email.");
      return;
    }
    setBusy(true); setErr("");
    try {
      const { data } = await api.post(`/franchisees/${item.id}/link-gocardless-by-email`, { email: e });
      if (data?.linked) {
        onResolved && onResolved(item.id);
      } else {
        setErr(data?.refresh?.reason || "No matching GoCardless customer for that email.");
      }
    } catch (ex) {
      setErr(ex?.response?.data?.detail || "Could not link.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-5 py-2.5 hover:bg-red-100/40" data-testid={`missing-mandate-row-${item.id}`}>
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <Link
            to={`/franchisees/${item.id}`}
            className="font-semibold text-stone-950 hover:underline text-sm truncate">
            {item.name}{item.franchise_number ? ` · #${item.franchise_number}` : ""}
          </Link>
          <div className="text-xs text-stone-600 truncate">
            {[item.organisation, item.email, item.postcode].filter(Boolean).join(" · ")}
          </div>
        </div>
        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-red-700 bg-red-100 border border-red-200 px-2 py-0.5 rounded-md tabular-nums">
          Live {item.days_live}d · No mandate
        </span>
        <button
          type="button"
          onClick={() => setShowLink((v) => !v)}
          data-testid={`missing-mandate-link-toggle-${item.id}`}
          className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-stone-900 bg-white border border-stone-300 hover:bg-stone-50 px-2 py-1 rounded-md">
          Link by email
        </button>
        <a
          href="https://manage.gocardless.com/sign-in"
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`missing-mandate-gc-${item.id}`}
          className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-stone-900 bg-white border border-stone-300 hover:bg-stone-50 px-2 py-1 rounded-md">
          Open GoCardless ↗
        </a>
      </div>
      {showLink && (
        <div className="mt-2 flex items-center gap-2" data-testid={`missing-mandate-link-form-${item.id}`}>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="GoCardless customer email (e.g. lucy91@gmail.com)"
            data-testid={`missing-mandate-email-${item.id}`}
            className="flex-1 px-3 py-1.5 text-xs bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-stone-900"
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            data-testid={`missing-mandate-link-submit-${item.id}`}
            className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 disabled:opacity-40 rounded-lg">
            {busy ? "Linking…" : "Add + Re-sync"}
          </button>
          {err && (
            <span className="text-[11px] text-red-700">{err}</span>
          )}
        </div>
      )}
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
  const [missingMandate, setMissingMandate] = useState({ count: 0, items: [], threshold_days: 14 });
  const [missingMandateExpanded, setMissingMandateExpanded] = useState(false);
  // Card vs table view. Persisted so admins land on their last-chosen
  // layout on subsequent visits.
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem("cm.franchisees.view") === "grid" ? "grid" : "list"; }
    catch { return "list"; }
  });
  useEffect(() => {
    try { localStorage.setItem("cm.franchisees.view", viewMode); }
    catch (e) { console.debug("[FranchiseesPage] localStorage write blocked", e); }
  }, [viewMode]);
  // Card click → quick-preview popover instead of a full page nav.
  const [previewId, setPreviewId] = useState(null);
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
    // Missing-mandate alerts — loaded in parallel, non-blocking.
    api.get("/franchisees/alerts/missing-mandate")
      .then(({ data }) => setMissingMandate(data || { count: 0, items: [], threshold_days: 14 }))
      .catch(() => {/* non-fatal */});
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
          {/* View toggle: list / grid */}
          <div className="inline-flex border border-stone-300 rounded-lg overflow-hidden" data-testid="view-toggle">
            <button
              onClick={() => setViewMode("list")}
              data-testid="view-list"
              title="List view"
              className={`px-2.5 py-2 flex items-center justify-center ${viewMode === "list" ? "bg-stone-950 text-white" : "bg-white text-stone-700 hover:bg-stone-50"}`}
            >
              <ListIcon className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode("grid")}
              data-testid="view-grid"
              title="Card view"
              className={`px-2.5 py-2 flex items-center justify-center border-l border-stone-300 ${viewMode === "grid" ? "bg-stone-950 text-white" : "bg-white text-stone-700 hover:bg-stone-50"}`}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
          </div>
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

      {missingMandate.count > 0 && (
        <div className="px-8 pt-6" data-testid="missing-mandate-banner">
          <div className="border border-red-300 bg-red-50 rounded-2xl overflow-hidden">
            <button
              type="button"
              onClick={() => setMissingMandateExpanded((v) => !v)}
              data-testid="missing-mandate-toggle"
              className="w-full flex items-center justify-between gap-3 px-5 py-3 hover:bg-red-100/40 transition-colors text-left">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <span className="shrink-0 w-7 h-7 rounded-full bg-red-600 text-white flex items-center justify-center text-xs font-bold tabular-nums">
                  {missingMandate.count}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-red-700">GoCardless mandate missing</div>
                  <div className="text-sm font-semibold text-red-900 truncate">
                    {missingMandate.count === 1
                      ? "1 active franchisee has been live ≥ "
                      : `${missingMandate.count} active franchisees have been live ≥ `}
                    {missingMandate.threshold_days || 14} days without a Direct Debit mandate.
                  </div>
                </div>
              </div>
              <ChevronDown className={`w-4 h-4 text-red-700 transition-transform ${missingMandateExpanded ? "rotate-180" : ""}`} />
            </button>
            {missingMandateExpanded && (
              <div className="border-t border-red-200 divide-y divide-red-200/60" data-testid="missing-mandate-list">
                {missingMandate.items.map((m) => (
                  <MissingMandateRow
                    key={m.id}
                    item={m}
                    onResolved={(updatedId) => {
                      // Remove from local banner state — next page refresh /
                      // 5-min sidebar poll will reconcile the rest.
                      setMissingMandate((prev) => ({
                        ...prev,
                        count: Math.max(0, prev.count - 1),
                        items: prev.items.filter((x) => x.id !== updatedId),
                      }));
                      reload();
                    }} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

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
                  active ? "bg-[#dddd16] text-stone-950" : "bg-stone-100 text-stone-600"
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
        ) : viewMode === "grid" ? (
          <FranchiseeGrid items={filtered} onPreview={setPreviewId} />
        ) : (
          <div className="bg-white border border-stone-200 overflow-hidden rounded-2xl" data-testid="franchisees-table">
            <table className="w-full">
              <thead className="bg-[#F2F2F0] border-b border-stone-200">
                <tr>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-36">Photo</th>
                  <th onClick={headerClick("franchise_number")} className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 cursor-pointer hover:bg-stone-200/50 w-16">No. <SortArrow col="franchise_number" /></th>
                  <th onClick={headerClick("organisation")} className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 cursor-pointer hover:bg-stone-200/50 w-64">Organisation <SortArrow col="organisation" /></th>
                  <th onClick={headerClick("last_name")} className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 cursor-pointer hover:bg-stone-200/50 w-40">Name <SortArrow col="last_name" /></th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-64">Mojo Email</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-36">Mobile</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-24">Postcode</th>
                  <th onClick={headerClick("date_added")} className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 cursor-pointer hover:bg-stone-200/50 w-28">Added <SortArrow col="date_added" /></th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-28">Mandate</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={9} className="px-3 py-10 text-center text-sm text-stone-500">No franchisees in this view.</td></tr>
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
                      <td className="px-3 py-2 text-xs text-stone-500 tabular-nums">{f.franchise_number || "—"}</td>
                      <td className="px-3 py-2">
                        <Link to={`/franchisees/${f.id}`} className="text-sm font-semibold text-stone-950 hover:text-stone-700 leading-snug line-clamp-2" data-testid={`franchisee-link-${f.id}`}>
                          {f.organisation || "(no organisation)"}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-sm text-stone-700">{[f.first_name, f.last_name].filter(Boolean).join(" ") || "—"}</td>
                      <td className="px-3 py-2 text-xs text-stone-600 break-all">
                        {f.mojo_email ? (
                          <a href={`mailto:${f.mojo_email}`} className="text-stone-700 hover:text-stone-950 hover:underline underline-offset-2" data-testid={`mailto-${f.id}`}>
                            {f.mojo_email}
                          </a>
                        ) : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs text-stone-700 tabular-nums whitespace-nowrap">
                        {f.mobile_phone ? (
                          <a href={`tel:${(f.mobile_phone || "").replace(/\s+/g, "")}`} className="hover:text-stone-950 hover:underline underline-offset-2" data-testid={`tel-${f.id}`}>
                            {f.mobile_phone}
                          </a>
                        ) : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs text-stone-700 tabular-nums">{f.postcode || "—"}</td>
                      <td className="px-3 py-2 text-xs text-stone-500 tabular-nums">{formatDate(f.date_added)}</td>
                      <td className="px-3 py-2"><MandateCell franchisee={f} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {/* Quick-preview popover triggered from the grid view */}
      {previewId && (
        <FranchiseePreview
          franchisee={filtered.find((f) => f.id === previewId)}
          onClose={() => setPreviewId(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card / grid view — 5 columns on wide screens.
// Shows photo, organisation, Mojo email, mobile (per Paul's spec).
// Cards open the quick-preview popover instead of navigating away, so
// admins can scan many franchisees fast without losing their filter state.
// ---------------------------------------------------------------------------
function FranchiseeGrid({ items, onPreview }) {
  if (!items.length) {
    return (
      <div className="bg-white border border-stone-200 rounded-2xl p-10 text-center text-sm text-stone-500" data-testid="franchisees-grid-empty">
        No franchisees in this view.
      </div>
    );
  }
  return (
    <div
      className="grid gap-4 grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
      data-testid="franchisees-grid"
    >
      {items.map((f) => {
        const photo = f.photos?.[0]?.url;
        const name = f.organisation || [f.first_name, f.last_name].filter(Boolean).join(" ") || "(no organisation)";
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => onPreview(f.id)}
            data-testid={`franchisee-card-${f.id}`}
            className="bg-white border border-stone-200 rounded-2xl overflow-hidden text-left hover:border-stone-950 hover:shadow-md transition-all flex flex-col group"
          >
            <div className="relative aspect-square bg-stone-100 overflow-hidden">
              {photo ? (
                <img
                  src={photo}
                  alt=""
                  loading="lazy"
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-4xl font-bold text-stone-300">
                  {(f.first_name?.[0] || "?") + (f.last_name?.[0] || "")}
                </div>
              )}
              {f.franchise_number && (
                <div className="absolute top-2 left-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950/85 text-white rounded-md tabular-nums">
                  #{f.franchise_number}
                </div>
              )}
            </div>
            <div className="p-3 flex-1 flex flex-col gap-1.5 min-w-0">
              <div className="font-semibold text-sm text-stone-950 leading-snug line-clamp-2">
                {name}
              </div>
              <div className="text-xs text-stone-600 truncate flex items-center gap-1.5">
                <Mail className="w-3 h-3 shrink-0 text-stone-400" />
                <span className="truncate">{f.mojo_email || "—"}</span>
              </div>
              <div className="text-xs text-stone-600 truncate flex items-center gap-1.5">
                <Phone className="w-3 h-3 shrink-0 text-stone-400" />
                <span className="truncate tabular-nums">{f.mobile_phone || "—"}</span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick-preview popover for the grid view.
// Mirrors the card content but adds a clear "Open detail" CTA so admins
// can decide whether to dive in. Closes on backdrop click or Esc.
// ---------------------------------------------------------------------------
function FranchiseePreview({ franchisee, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!franchisee) return null;
  const f = franchisee;
  const photo = f.photos?.[0]?.url;
  const name = f.organisation || [f.first_name, f.last_name].filter(Boolean).join(" ") || "(no organisation)";
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in"
      data-testid="franchisee-preview-backdrop"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden"
        data-testid="franchisee-preview"
      >
        <div className="relative aspect-[16/10] bg-stone-100">
          {photo ? (
            <img src={photo} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-6xl font-bold text-stone-300">
              {(f.first_name?.[0] || "?") + (f.last_name?.[0] || "")}
            </div>
          )}
          <button
            onClick={onClose}
            className="absolute top-3 right-3 w-8 h-8 rounded-full bg-white/95 text-stone-900 flex items-center justify-center hover:bg-white shadow"
            data-testid="franchisee-preview-close"
          >
            <X className="w-4 h-4" />
          </button>
          {f.franchise_number && (
            <div className="absolute top-3 left-3 px-2.5 py-1 text-xs font-bold uppercase tracking-wider bg-stone-950/85 text-white rounded-md tabular-nums">
              #{f.franchise_number}
            </div>
          )}
        </div>
        <div className="p-5 space-y-3">
          <div>
            <h2 className="font-display text-2xl text-stone-950 leading-tight">{name}</h2>
            {f.organisation && (f.first_name || f.last_name) && (
              <div className="text-sm text-stone-600 mt-0.5">
                {[f.first_name, f.last_name].filter(Boolean).join(" ")}
              </div>
            )}
          </div>
          <dl className="space-y-2 text-sm">
            <div className="flex items-start gap-2">
              <Mail className="w-4 h-4 text-stone-400 mt-0.5 shrink-0" />
              {f.mojo_email ? (
                <a href={`mailto:${f.mojo_email}`} className="text-stone-700 hover:text-stone-950 hover:underline underline-offset-2 break-all">
                  {f.mojo_email}
                </a>
              ) : <span className="text-stone-400">No Mojo email</span>}
            </div>
            <div className="flex items-start gap-2">
              <Phone className="w-4 h-4 text-stone-400 mt-0.5 shrink-0" />
              {f.mobile_phone ? (
                <a href={`tel:${(f.mobile_phone || "").replace(/\s+/g, "")}`} className="text-stone-700 hover:text-stone-950 hover:underline underline-offset-2 tabular-nums">
                  {f.mobile_phone}
                </a>
              ) : <span className="text-stone-400">No mobile on file</span>}
            </div>
            {(f.city || f.postcode) && (
              <div className="text-stone-600 pl-6 tabular-nums">
                {[f.city, f.postcode].filter(Boolean).join(" · ")}
              </div>
            )}
          </dl>
          <Link
            to={`/franchisees/${f.id}`}
            data-testid={`franchisee-preview-open-${f.id}`}
            className="mt-2 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 font-bold text-sm uppercase tracking-wider rounded-lg"
          >
            Open detail <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}
