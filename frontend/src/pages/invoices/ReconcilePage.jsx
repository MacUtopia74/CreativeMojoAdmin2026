// Reconciliation view — twin columns of outstanding invoices (left) and
// unmatched incoming bank receipts (right). Pick an invoice, then click
// a matching transaction to link them in one shot. Supports supplier
// keyword filtering on the bank side so the user can drill into a
// specific care-home's incoming receipts.
import { useEffect, useState, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import { toast } from "sonner";
import {
  Loader2,
  Search,
  Banknote,
  Receipt,
  ArrowRight,
  CheckCircle2,
  Filter,
  Link2,
  AlertCircle,
} from "lucide-react";
import StatusBadge from "@/components/invoices/StatusBadge";

const money = (n) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(
    Number(n || 0)
  );

const ukDate = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-GB");
  } catch {
    return iso;
  }
};

export default function ReconcilePage() {
  const [invoices, setInvoices] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [keywords, setKeywords] = useState([]);
  const [activeKeywords, setActiveKeywords] = useState(new Set());
  const [invoiceSearch, setInvoiceSearch] = useState("");
  const [txSearch, setTxSearch] = useState("");
  const [selectedInvoiceId, setSelectedInvoiceId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState(false);
  const [hideMatched, setHideMatched] = useState(true);

  const loadInvoices = useCallback(async () => {
    // Pull sent + partial — these are the "outstanding" ones we want to
    // reconcile. Drafts haven't been sent yet so they're excluded; paid
    // ones are already done.
    const [sentRes, partialRes] = await Promise.all([
      api.get("/invoices", { params: { status: "sent" } }),
      api.get("/invoices", { params: { status: "partial" } }),
    ]);
    const merged = [...partialRes.data, ...sentRes.data].sort(
      (a, b) => (a.issue_date || "").localeCompare(b.issue_date || "")
    );
    setInvoices(merged);
  }, []);

  const loadTransactions = useCallback(async () => {
    const params = { direction: "in", limit: 1000 };
    if (activeKeywords.size > 0) {
      params.keywords = Array.from(activeKeywords).join(",");
    }
    if (txSearch) params.search = txSearch;
    const { data } = await api.get("/banking/transactions", { params });
    setTransactions(data.transactions || []);
  }, [activeKeywords, txSearch]);

  const loadKeywords = useCallback(async () => {
    const { data } = await api.get("/banking/supplier-keywords");
    setKeywords(data.keywords || []);
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadInvoices(), loadTransactions(), loadKeywords()]);
  }, [loadInvoices, loadTransactions, loadKeywords]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        await refreshAll();
      } catch (e) {
        toast.error("Failed to load reconciliation data");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch transactions when the keyword/search filters change.
  useEffect(() => {
    loadTransactions().catch(() => {});
  }, [activeKeywords, loadTransactions]);

  // Currently-selected invoice + derived outstanding balance.
  const selectedInvoice = useMemo(
    () => invoices.find((i) => i.id === selectedInvoiceId) || null,
    [invoices, selectedInvoiceId]
  );
  const selectedOutstanding = useMemo(() => {
    if (!selectedInvoice) return 0;
    const paid = (selectedInvoice.linked_transactions || []).reduce(
      (a, x) => a + Number(x.amount || 0),
      0
    );
    return Number(selectedInvoice.total) - paid;
  }, [selectedInvoice]);

  const filteredInvoices = useMemo(() => {
    const q = invoiceSearch.trim().toLowerCase();
    if (!q) return invoices;
    return invoices.filter(
      (i) =>
        i.invoice_number?.toLowerCase().includes(q) ||
        i.client_name?.toLowerCase().includes(q) ||
        i.client_email?.toLowerCase().includes(q)
    );
  }, [invoices, invoiceSearch]);

  const filteredTx = useMemo(() => {
    let list = transactions;
    if (hideMatched) {
      list = list.filter((t) => !t.linked_invoice_id);
    }
    return list;
  }, [transactions, hideMatched]);

  const toggleKeyword = (k) => {
    setActiveKeywords((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  };
  const clearKeywords = () => setActiveKeywords(new Set());
  const selectAllKeywords = () => setActiveKeywords(new Set(keywords));

  const linkTransaction = async (tx) => {
    if (!selectedInvoiceId) {
      toast.warning("Pick an invoice on the left first");
      return;
    }
    if (tx.linked_invoice_id && tx.linked_invoice_id !== selectedInvoiceId) {
      const ok = window.confirm(
        `This transaction is already linked to ${
          tx.linked_invoice_number || "another invoice"
        }. Re-link to the selected invoice anyway?`
      );
      if (!ok) return;
    }
    setLinking(true);
    try {
      await api.post(`/invoices/${selectedInvoiceId}/link-payment`, {
        transaction_id: tx.transaction_id,
      });
      toast.success("Linked");
      // Refresh both sides — the invoice may have moved to "paid" (and
      // dropped off the outstanding list); the tx now carries a link.
      await refreshAll();
      // If the previously-selected invoice is no longer outstanding,
      // clear the selection so the next click feels obvious.
      const stillOutstanding = invoices.find(
        (i) => i.id === selectedInvoiceId
      );
      if (!stillOutstanding) setSelectedInvoiceId(null);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Link failed");
    } finally {
      setLinking(false);
    }
  };

  // Amount-match badge on transactions — green for exact, amber for close.
  const matchClass = (txAmount) => {
    if (!selectedInvoice) return null;
    const diff = Math.abs(Number(txAmount) - selectedOutstanding);
    if (diff < 0.005) return "exact";
    if (diff < 1) return "close";
    return null;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh] text-slate-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading reconciliation…
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="reconcile-page">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-5xl font-bold tracking-tight text-slate-900">
            Reconcile
          </h1>
          <p className="text-muted-foreground mt-2">
            Match outstanding invoices to incoming bank receipts. Pick an
            invoice on the left, then click a transaction on the right to
            link them.
          </p>
        </div>
        <div className="flex flex-col gap-1 items-end text-sm">
          <div className="text-slate-600">
            <strong className="text-slate-900">{invoices.length}</strong>{" "}
            outstanding ·{" "}
            <strong className="text-emerald-700">
              {filteredTx.filter((t) => !t.linked_invoice_id).length}
            </strong>{" "}
            unmatched receipt
            {filteredTx.length === 1 ? "" : "s"}
          </div>
          <button
            onClick={() => setHideMatched((v) => !v)}
            className="text-xs uppercase tracking-wider font-bold text-slate-500 hover:text-slate-900"
            data-testid="toggle-hide-matched"
          >
            {hideMatched
              ? "Show already-matched receipts"
              : "Hide already-matched receipts"}
          </button>
        </div>
      </div>

      {/* Selection banner */}
      {selectedInvoice ? (
        <div
          className="bg-blue-50 border border-blue-200 rounded-2xl px-5 py-3 flex items-center gap-4 flex-wrap"
          data-testid="reconcile-selection"
        >
          <Receipt className="w-5 h-5 text-blue-700 shrink-0" />
          <div className="text-sm flex-1 min-w-0">
            <div className="font-bold text-slate-900">
              {selectedInvoice.invoice_number} · {selectedInvoice.client_name}
            </div>
            <div className="text-xs text-slate-700">
              Total {money(selectedInvoice.total)} ·{" "}
              <strong>{money(selectedOutstanding)} outstanding</strong> · Click a
              transaction on the right to link.
            </div>
          </div>
          <button
            onClick={() => setSelectedInvoiceId(null)}
            className="text-xs font-bold uppercase tracking-wider text-slate-500 hover:text-slate-900"
          >
            Clear selection
          </button>
        </div>
      ) : (
        <div className="bg-stone-50 border border-stone-200 rounded-2xl px-5 py-3 flex items-center gap-3 text-sm text-slate-600">
          <AlertCircle className="w-4 h-4 text-slate-500 shrink-0" />
          <span>
            Pick an outstanding invoice on the left to start linking
            receipts.
          </span>
        </div>
      )}

      {/* Supplier keyword chips — shared with the Banking page */}
      <div className="bg-white border border-stone-200 rounded-2xl p-4">
        <div className="flex items-center gap-3 flex-wrap mb-2">
          <h2 className="text-xs font-bold tracking-wider uppercase text-slate-700 flex items-center gap-2">
            <Filter className="w-3.5 h-3.5" /> Filter receipts by supplier
          </h2>
          <span className="text-xs text-slate-400">
            {activeKeywords.size > 0
              ? `${activeKeywords.size} active`
              : `${keywords.length} saved`}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {activeKeywords.size > 0 && (
              <button
                onClick={clearKeywords}
                data-testid="reconcile-chip-clear"
                className="text-[10px] uppercase tracking-wider font-bold text-slate-500 hover:text-slate-900 px-2 py-1"
              >
                Clear
              </button>
            )}
            <button
              onClick={selectAllKeywords}
              data-testid="reconcile-chip-select-all"
              className="text-[10px] uppercase tracking-wider font-bold text-slate-500 hover:text-slate-900 px-2 py-1"
            >
              Select all
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {keywords.map((k) => {
            const isActive = activeKeywords.has(k);
            return (
              <button
                key={k}
                onClick={() => toggleKeyword(k)}
                data-testid={`reconcile-chip-${k}`}
                className={`rounded-full text-xs font-bold uppercase tracking-wider px-3 py-1.5 transition ${
                  isActive
                    ? "bg-slate-950 text-white"
                    : "bg-stone-100 text-slate-700 hover:bg-stone-200"
                }`}
              >
                {k}
              </button>
            );
          })}
        </div>
      </div>

      {/* Twin columns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LEFT — Outstanding invoices */}
        <div className="bg-white border border-stone-200 rounded-2xl flex flex-col min-h-[60vh]">
          <div className="px-5 py-4 border-b border-stone-200 flex items-center gap-3">
            <Receipt className="w-4 h-4 text-slate-700" />
            <h2 className="text-sm font-bold tracking-wider uppercase text-slate-700">
              Outstanding Invoices
            </h2>
            <span className="ml-auto text-xs text-slate-400 tabular-nums">
              {filteredInvoices.length} of {invoices.length}
            </span>
          </div>
          <div className="px-5 py-3 border-b border-stone-100">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={invoiceSearch}
                onChange={(e) => setInvoiceSearch(e.target.value)}
                placeholder="Search invoice number, client…"
                className="w-full pl-9 pr-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                data-testid="reconcile-invoice-search"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto max-h-[70vh]">
            {filteredInvoices.length === 0 ? (
              <div className="p-10 text-center text-slate-500 text-sm">
                <CheckCircle2 className="w-8 h-8 mx-auto text-emerald-500 mb-2" />
                Nothing outstanding. All invoices are paid.
              </div>
            ) : (
              <ul className="divide-y divide-stone-100">
                {filteredInvoices.map((inv) => {
                  const paid = (inv.linked_transactions || []).reduce(
                    (a, x) => a + Number(x.amount || 0),
                    0
                  );
                  const outstanding = Number(inv.total) - paid;
                  const isSelected = inv.id === selectedInvoiceId;
                  return (
                    <li
                      key={inv.id}
                      onClick={() => setSelectedInvoiceId(inv.id)}
                      data-testid={`reconcile-inv-${inv.invoice_number}`}
                      className={`px-5 py-3 cursor-pointer transition ${
                        isSelected
                          ? "bg-blue-50 border-l-4 border-blue-600"
                          : "hover:bg-stone-50 border-l-4 border-transparent"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="font-mono text-xs font-bold text-slate-700 w-20 shrink-0">
                          {inv.invoice_number}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-slate-900 truncate">
                            {inv.client_name}
                          </div>
                          <div className="text-xs text-slate-500 truncate">
                            Due {ukDate(inv.due_date)}
                          </div>
                        </div>
                        <StatusBadge status={inv.status} />
                        <div className="text-right tabular-nums shrink-0 w-24">
                          <div className="font-mono font-bold text-slate-900">
                            {money(outstanding)}
                          </div>
                          {paid > 0 && (
                            <div className="text-[10px] text-amber-700">
                              {money(paid)} paid
                            </div>
                          )}
                        </div>
                        <Link
                          to={`/invoices/${inv.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-slate-400 hover:text-blue-600 shrink-0"
                          title="Open invoice"
                          data-testid={`reconcile-open-${inv.invoice_number}`}
                        >
                          <ArrowRight className="w-4 h-4" />
                        </Link>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* RIGHT — Incoming bank receipts */}
        <div className="bg-white border border-stone-200 rounded-2xl flex flex-col min-h-[60vh]">
          <div className="px-5 py-4 border-b border-stone-200 flex items-center gap-3">
            <Banknote className="w-4 h-4 text-emerald-700" />
            <h2 className="text-sm font-bold tracking-wider uppercase text-slate-700">
              Incoming Receipts
            </h2>
            <span className="ml-auto text-xs text-slate-400 tabular-nums">
              {filteredTx.length} shown
            </span>
          </div>
          <div className="px-5 py-3 border-b border-stone-100">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={txSearch}
                onChange={(e) => setTxSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") loadTransactions();
                }}
                placeholder="Search description…"
                className="w-full pl-9 pr-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                data-testid="reconcile-tx-search"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto max-h-[70vh]">
            {filteredTx.length === 0 ? (
              <div className="p-10 text-center text-slate-500 text-sm">
                No incoming receipts match the current filter.
              </div>
            ) : (
              <ul className="divide-y divide-stone-100">
                {filteredTx.map((tx) => {
                  const match = matchClass(tx.amount);
                  const alreadyLinked = !!tx.linked_invoice_id;
                  return (
                    <li
                      key={tx.transaction_id}
                      className={`px-5 py-3 transition ${
                        match === "exact" ? "bg-emerald-50/70" : ""
                      } ${selectedInvoiceId ? "cursor-pointer hover:bg-stone-50" : "opacity-90"}`}
                      onClick={() => selectedInvoiceId && !linking && linkTransaction(tx)}
                      data-testid={`reconcile-tx-${tx.transaction_id}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="text-xs text-slate-500 tabular-nums w-20 shrink-0">
                          {ukDate(tx.timestamp)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div
                            className="text-sm text-slate-800 truncate"
                            title={tx.description}
                          >
                            {tx.description || "—"}
                          </div>
                          {alreadyLinked && (
                            <div className="text-[10px] uppercase tracking-wider font-bold text-emerald-700">
                              → linked to {tx.linked_invoice_number}
                            </div>
                          )}
                        </div>
                        {match === "exact" && selectedInvoice && (
                          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">
                            <CheckCircle2 className="w-3 h-3" /> Exact
                          </span>
                        )}
                        {match === "close" && selectedInvoice && (
                          <span className="text-[10px] uppercase tracking-wider font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                            Close
                          </span>
                        )}
                        <div className="text-right tabular-nums shrink-0 w-24 font-mono font-bold text-emerald-700">
                          {money(tx.amount)}
                        </div>
                        {selectedInvoiceId && (
                          <button
                            disabled={linking}
                            onClick={(e) => {
                              e.stopPropagation();
                              linkTransaction(tx);
                            }}
                            className="text-blue-600 hover:bg-blue-50 rounded-lg p-1.5 disabled:opacity-40"
                            title="Link to selected invoice"
                            data-testid={`reconcile-link-${tx.transaction_id}`}
                          >
                            <Link2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
