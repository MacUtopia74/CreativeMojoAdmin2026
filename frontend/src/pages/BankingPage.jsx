import { useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import api from "@/lib/api";
import { toast } from "sonner";
import {
  Banknote,
  Loader2,
  RefreshCw,
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Calendar,
  Building2,
  Search,
  Upload,
  FileText,
  Trash2,
  CheckCircle2,
  Filter,
  Plus,
  X as XIcon,
} from "lucide-react";

const moneyFmt = (n, currency = "GBP") =>
  n == null
    ? "—"
    : new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(n);

// ----- Drop-zone for uploading PDFs. Multi-file, drag-or-click. -----
function StatementDropZone({ onUploaded, compact = false }) {
  const fileRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);

  const upload = async (fileList) => {
    const files = Array.from(fileList || []).filter((f) => {
      const n = f.name.toLowerCase();
      return n.endsWith(".pdf") || n.endsWith(".csv");
    });
    if (!files.length) {
      toast.error("Please drop PDF or CSV files only.");
      return;
    }
    setBusy(true);
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    try {
      const { data } = await api.post("/banking/statements", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      // Summarise toast: how many parsed cleanly vs warnings vs errors
      const ok = data.results.filter((r) => r.status === "ok");
      const errors = data.results.filter((r) => r.status === "error");
      const warnings = data.results.filter((r) => r.status === "warning");
      if (ok.length) {
        const totalNew = ok.reduce((a, r) => a + (r.new_transactions || 0), 0);
        toast.success(`${ok.length} statement${ok.length === 1 ? "" : "s"} imported · ${totalNew} new transaction${totalNew === 1 ? "" : "s"}`);
      }
      warnings.forEach((w) => toast.warning(`${w.filename}: ${w.message}`));
      errors.forEach((e) => toast.error(`${e.filename}: ${e.message}`));
      onUploaded?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Upload failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files); }}
      onClick={() => fileRef.current?.click()}
      data-testid="banking-statement-dropzone"
      className={`cursor-pointer rounded-2xl border-2 border-dashed transition-all
        ${dragOver ? "border-[#D4FF00] bg-stone-50" : "border-stone-300 hover:border-stone-400 bg-white"}
        ${compact ? "p-4" : "p-10"} text-center`}
    >
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,.pdf,.csv,text/csv"
        multiple
        className="hidden"
        onChange={(e) => upload(e.target.files)}
      />
      {busy ? (
        <div className="inline-flex items-center gap-2 text-stone-700 font-bold uppercase tracking-wider text-xs">
          <Loader2 className="w-4 h-4 animate-spin" /> Parsing PDFs…
        </div>
      ) : (
        <>
          <div className={`mx-auto ${compact ? "w-10 h-10" : "w-14 h-14"} rounded-full bg-stone-950 flex items-center justify-center`}>
            <Upload className={`${compact ? "w-5 h-5" : "w-7 h-7"} text-[#D4FF00]`} />
          </div>
          <div className={compact ? "mt-2" : "mt-4"}>
            <p className="font-bold text-stone-900">
              {compact ? "Upload more statements" : "Drop HSBC statements here"}
            </p>
            <p className="text-xs text-stone-500 mt-1">
              {compact ? "PDF or CSV · multiple supported" : "Or click to choose. PDF or CSV exports from HSBC Online Banking. Multiple files supported. Duplicates skipped automatically."}
            </p>
          </div>
        </>
      )}
    </div>
  );
}

export default function BankingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dashboard, setDashboard] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [statements, setStatements] = useState([]);
  const [direction, setDirection] = useState("in");
  const [search, setSearch] = useState("");
  // Supplier-keyword chips. `keywords` is the full saved list; `active`
  // is the subset the user has currently toggled on (empty = no filter).
  const [keywords, setKeywords] = useState([]);
  const [activeKeywords, setActiveKeywords] = useState(new Set());
  const [newKeyword, setNewKeyword] = useState("");

  const loadStatus = useCallback(async () => {
    try {
      const { data } = await api.get("/banking/status");
      setStatus(data);
      return data;
    } catch {
      setStatus({ connected: false });
      return { connected: false };
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    try {
      const { data } = await api.get("/banking/dashboard", { params: { months: 12 } });
      setDashboard(data);
    } catch {/* ignore */}
  }, []);

  const loadTransactions = useCallback(async () => {
    try {
      const params = { direction, search: search || undefined, limit: 500 };
      if (activeKeywords.size > 0) {
        params.keywords = Array.from(activeKeywords).join(",");
      }
      const { data } = await api.get("/banking/transactions", { params });
      setTransactions(data.transactions || []);
    } catch {/* ignore */}
  }, [direction, search, activeKeywords]);

  const loadKeywords = useCallback(async () => {
    try {
      const { data } = await api.get("/banking/supplier-keywords");
      setKeywords(data.keywords || []);
    } catch {/* ignore */}
  }, []);

  const loadStatements = useCallback(async () => {
    try {
      const { data } = await api.get("/banking/statements");
      setStatements(data.statements || []);
    } catch {/* ignore */}
  }, []);

  const refreshAll = useCallback(async () => {
    const s = await loadStatus();
    if (s?.connected) {
      await Promise.all([loadDashboard(), loadTransactions(), loadStatements(), loadKeywords()]);
    }
  }, [loadStatus, loadDashboard, loadTransactions, loadStatements, loadKeywords]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await refreshAll();
      setLoading(false);
      // Clean up any old TrueLayer callback params
      if (searchParams.get("connected") || searchParams.get("error")) {
        setSearchParams({});
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch transactions when filter changes
  useEffect(() => {
    if (status?.connected) loadTransactions();
  }, [direction, status?.connected, activeKeywords, loadTransactions]);

  const toggleKeyword = (k) => {
    setActiveKeywords((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  };

  const clearKeywords = () => setActiveKeywords(new Set());
  const selectAllKeywords = () => setActiveKeywords(new Set(keywords));

  const addKeyword = async () => {
    const trimmed = newKeyword.trim();
    if (!trimmed) return;
    if (keywords.some((k) => k.toLowerCase() === trimmed.toLowerCase())) {
      toast.warning(`"${trimmed}" is already in the list.`);
      return;
    }
    const updated = [...keywords, trimmed];
    try {
      const { data } = await api.put("/banking/supplier-keywords", { keywords: updated });
      setKeywords(data.keywords);
      setNewKeyword("");
      toast.success(`Added "${trimmed}"`);
    } catch {
      toast.error("Could not save");
    }
  };

  const removeKeyword = async (k) => {
    if (!window.confirm(`Remove "${k}" from the supplier filters?`)) return;
    const updated = keywords.filter((x) => x !== k);
    try {
      const { data } = await api.put("/banking/supplier-keywords", { keywords: updated });
      setKeywords(data.keywords);
      setActiveKeywords((prev) => {
        const next = new Set(prev); next.delete(k); return next;
      });
    } catch {
      toast.error("Could not save");
    }
  };

  const handleDeleteStatement = async (s) => {
    if (!window.confirm(`Delete "${s.filename}"? Its ${s.transaction_count} transactions will be removed.`)) return;
    try {
      await api.delete(`/banking/statements/${s.id}`);
      toast.success("Statement deleted");
      refreshAll();
    } catch {
      toast.error("Delete failed");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh] text-stone-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading banking…
      </div>
    );
  }

  // ===== Empty state — no statements imported yet =====
  if (!status?.connected) {
    return (
      <div className="max-w-2xl space-y-6" data-testid="banking-empty">
        <div>
          <h1 className="text-4xl font-bold tracking-tight" data-testid="page-title">Banking</h1>
          <p className="text-stone-500 mt-1">
            Upload your HSBC statement PDFs to see incoming receipts and monthly income.
          </p>
        </div>
        <StatementDropZone onUploaded={refreshAll} />
        <div className="text-xs text-stone-500 bg-stone-50 border border-stone-200 rounded-xl p-4 space-y-1">
          <p className="font-bold text-stone-700">How it works</p>
          <ul className="list-disc pl-4 space-y-0.5">
            <li>Download your monthly HSBC statement as PDF from Online Banking</li>
            <li>Drop it (or several) into the box above — we extract every transaction</li>
            <li>Duplicates are detected and skipped automatically, so re-uploading is safe</li>
            <li>Default view filters to incoming only — toggle to see outgoing or all</li>
          </ul>
        </div>
      </div>
    );
  }

  // ===== Connected — full dashboard =====
  const balance = dashboard?.balance;
  const totalIncomingTx = transactions.filter((t) => t.transaction_type === "CREDIT").length;

  return (
    <div className="space-y-6" data-testid="banking-dashboard">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">Banking</h1>
          <p className="text-stone-500 mt-1 text-sm">
            <span className="inline-flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5" />
              {status.institution_name || "HSBC UK"}
            </span>
            <span className="ml-3 text-xs text-stone-400">
              · {status.statement_count} statement{status.statement_count === 1 ? "" : "s"} imported
            </span>
          </p>
        </div>
        <button
          onClick={refreshAll}
          data-testid="banking-refresh-btn"
          className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white hover:bg-stone-50 rounded-lg flex items-center gap-1.5"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white border border-stone-200 rounded-2xl p-5">
          <div className="text-[10px] uppercase tracking-wider text-stone-500 font-bold">Closing Balance</div>
          <div className="text-3xl font-bold mt-1 tabular-nums">
            {moneyFmt(balance?.current, balance?.currency || "GBP")}
          </div>
          <div className="text-xs text-stone-400 mt-1">
            From latest uploaded statement
          </div>
        </div>
        <div className="bg-white border border-stone-200 rounded-2xl p-5">
          <div className="text-[10px] uppercase tracking-wider text-stone-500 font-bold">Total Incoming</div>
          <div className="text-3xl font-bold mt-1 tabular-nums text-emerald-700">
            {moneyFmt(dashboard?.total_in_window)}
          </div>
          <div className="text-xs text-stone-400 mt-1">
            Across {totalIncomingTx} receipts (last 12 months)
          </div>
        </div>
        <div className="bg-white border border-stone-200 rounded-2xl p-5">
          <div className="text-[10px] uppercase tracking-wider text-stone-500 font-bold">Months Covered</div>
          <div className="text-3xl font-bold mt-1 tabular-nums">
            {dashboard?.months?.length ?? 0}
          </div>
          <div className="text-xs text-stone-400 mt-1">
            {dashboard?.months?.length ? `${dashboard.months[dashboard.months.length - 1]?.month} → ${dashboard.months[0]?.month}` : "—"}
          </div>
        </div>
      </div>

      {/* Monthly + top sources */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-white border border-stone-200 rounded-2xl p-5 lg:col-span-2">
          <h2 className="text-sm font-bold tracking-wider uppercase text-stone-700 mb-4">Monthly Incoming</h2>
          {dashboard?.months?.length ? (
            <div className="space-y-2">
              {dashboard.months.map((m) => {
                const max = Math.max(...dashboard.months.map((x) => x.total));
                const pct = Math.max(2, (m.total / max) * 100);
                return (
                  <div key={m.month} className="flex items-center gap-3 text-sm">
                    <div className="w-20 tabular-nums text-stone-500 text-xs">{m.month}</div>
                    <div className="flex-1 bg-stone-100 rounded-full h-3 overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="w-28 text-right tabular-nums font-bold">{moneyFmt(m.total)}</div>
                    <div className="w-12 text-right tabular-nums text-xs text-stone-400">{m.count}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-stone-500 text-sm">No incoming receipts yet — upload more statements.</p>
          )}
        </div>
        <div className="bg-white border border-stone-200 rounded-2xl p-5">
          <h2 className="text-sm font-bold tracking-wider uppercase text-stone-700 mb-4">Top Sources</h2>
          {dashboard?.top_sources?.length ? (
            <div className="space-y-2">
              {dashboard.top_sources.map((s, i) => (
                <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b border-stone-100 last:border-0">
                  <div className="truncate pr-2 text-stone-700">{s.name || "—"}</div>
                  <div className="tabular-nums font-bold text-emerald-700 shrink-0">{moneyFmt(s.total)}</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-stone-500 text-sm">—</p>
          )}
        </div>
      </div>

      {/* Statements list + upload-more */}
      <div className="bg-white border border-stone-200 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold tracking-wider uppercase text-stone-700">Imported Statements</h2>
          <span className="text-xs text-stone-400">{statements.length} file{statements.length === 1 ? "" : "s"}</span>
        </div>
        <StatementDropZone onUploaded={refreshAll} compact />
        {statements.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-wider text-stone-500 border-b border-stone-200">
                <tr>
                  <th className="text-left py-2 font-bold">File</th>
                  <th className="text-left py-2 font-bold w-40">Period</th>
                  <th className="text-right py-2 font-bold w-24">Tx</th>
                  <th className="text-right py-2 font-bold w-24">New</th>
                  <th className="text-right py-2 font-bold w-28">Closing</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {statements.map((s) => (
                  <tr key={s.id} className="border-b border-stone-100 hover:bg-stone-50">
                    <td className="py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className="w-3.5 h-3.5 text-stone-400 shrink-0" />
                        <span className="truncate text-stone-800">{s.filename}</span>
                      </div>
                    </td>
                    <td className="py-2 text-xs text-stone-500">
                      {s.period_from} → {s.period_to}
                    </td>
                    <td className="py-2 text-right tabular-nums">{s.transaction_count}</td>
                    <td className="py-2 text-right tabular-nums text-emerald-700 font-bold">
                      {s.new_transactions > 0 ? `+${s.new_transactions}` : (
                        <span className="text-stone-400 font-normal inline-flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> dupes
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {s.closing_balance != null ? moneyFmt(s.closing_balance) : "—"}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => handleDeleteStatement(s)}
                        className="text-stone-400 hover:text-red-600 p-1"
                        data-testid={`delete-statement-${s.id}`}
                        title="Delete this statement"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Supplier keyword filters — quick-toggle chips above the tx list */}
      <div className="bg-white border border-stone-200 rounded-2xl p-5" data-testid="banking-supplier-filters">
        <div className="flex items-center gap-3 flex-wrap mb-3">
          <h2 className="text-sm font-bold tracking-wider uppercase text-stone-700 flex items-center gap-2">
            <Filter className="w-3.5 h-3.5" /> Suppliers
          </h2>
          <span className="text-xs text-stone-400">
            {activeKeywords.size > 0
              ? `${activeKeywords.size} of ${keywords.length} active — list below shows only these suppliers`
              : `${keywords.length} saved · click any to filter`}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {activeKeywords.size > 0 && (
              <button onClick={clearKeywords} className="text-[10px] uppercase tracking-wider font-bold text-stone-500 hover:text-stone-950 px-2 py-1">Clear</button>
            )}
            <button onClick={selectAllKeywords} className="text-[10px] uppercase tracking-wider font-bold text-stone-500 hover:text-stone-950 px-2 py-1">Select all</button>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {keywords.map((k) => {
            const isActive = activeKeywords.has(k);
            return (
              <span
                key={k}
                className={`inline-flex items-center gap-1 rounded-full text-xs font-bold transition-all
                  ${isActive
                    ? "bg-stone-950 text-white shadow-sm"
                    : "bg-stone-100 text-stone-700 hover:bg-stone-200"}`}
                data-testid={`supplier-chip-${k}`}
              >
                <button
                  onClick={() => toggleKeyword(k)}
                  className="pl-3 pr-1 py-1.5 uppercase tracking-wider"
                  title={isActive ? "Remove from filter" : "Add to filter"}
                >
                  {k}
                </button>
                <button
                  onClick={() => removeKeyword(k)}
                  className={`pr-2 pl-0.5 py-1.5 ${isActive ? "text-white/60 hover:text-white" : "text-stone-400 hover:text-red-600"}`}
                  title="Delete keyword"
                >
                  <XIcon className="w-3 h-3" />
                </button>
              </span>
            );
          })}
          <div className="inline-flex items-center gap-1 border-2 border-dashed border-stone-300 rounded-full pl-2 pr-1">
            <Plus className="w-3 h-3 text-stone-400" />
            <input
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addKeyword(); }}
              placeholder="Add supplier…"
              className="text-xs font-bold uppercase tracking-wider bg-transparent px-1 py-1.5 focus:outline-none w-32"
              data-testid="supplier-add-input"
            />
            <button
              onClick={addKeyword}
              disabled={!newKeyword.trim()}
              className="text-[10px] uppercase tracking-wider font-bold text-stone-600 hover:text-stone-950 px-2 py-1 disabled:opacity-40"
            >Add</button>
          </div>
        </div>
      </div>

      {/* Transactions list */}
      <div className="bg-white border border-stone-200 rounded-2xl p-5">
        <div className="flex items-center gap-3 flex-wrap mb-4">
          <h2 className="text-sm font-bold tracking-wider uppercase text-stone-700">Transactions</h2>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") loadTransactions(); }}
                placeholder="Search description"
                className="pl-7 pr-3 py-1.5 text-sm border border-stone-200 rounded-lg w-44 focus:outline-none focus:ring-2 focus:ring-stone-900/10"
              />
            </div>
            <div className="inline-flex border border-stone-200 rounded-lg overflow-hidden" role="tablist">
              {[
                { k: "in", label: "Incoming" },
                { k: "out", label: "Outgoing" },
                { k: "all", label: "All" },
              ].map((opt) => (
                <button
                  key={opt.k}
                  onClick={() => setDirection(opt.k)}
                  data-testid={`tx-filter-${opt.k}`}
                  className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider ${direction === opt.k ? "bg-stone-950 text-white" : "bg-white text-stone-700 hover:bg-stone-50"}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {transactions.length === 0 ? (
          <p className="text-stone-500 text-sm py-8 text-center">No transactions match.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-wider text-stone-500 border-b border-stone-200">
                <tr>
                  <th className="text-left py-2 font-bold w-24">Date</th>
                  <th className="text-left py-2 font-bold">Description</th>
                  <th className="text-right py-2 font-bold w-28">Amount</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t) => (
                  <tr key={t.transaction_id} className="border-b border-stone-100 hover:bg-stone-50">
                    <td className="py-2 text-stone-500 tabular-nums text-xs">
                      <span className="inline-flex items-center gap-1.5">
                        <Calendar className="w-3 h-3" />
                        {t.timestamp ? new Date(t.timestamp).toLocaleDateString("en-GB") : "—"}
                      </span>
                    </td>
                    <td className="py-2 text-stone-800 max-w-md truncate" title={t.description}>
                      {t.description || "—"}
                      {t.linked_invoice_number && (
                        <span className="ml-2 inline-flex items-center px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-800 border border-emerald-200 rounded">
                          → {t.linked_invoice_number}
                        </span>
                      )}
                    </td>
                    <td className={`py-2 text-right tabular-nums font-bold ${t.transaction_type === "CREDIT" ? "text-emerald-700" : "text-stone-700"}`}>
                      <span className="inline-flex items-center gap-1 justify-end">
                        {t.transaction_type === "CREDIT" ? <ArrowDownLeft className="w-3 h-3" /> : <ArrowUpRight className="w-3 h-3" />}
                        {moneyFmt(t.amount, t.currency || "GBP")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
