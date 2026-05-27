// SubscriptionsModal — picker for which customers should auto-generate a
// fresh empty Draft order on the 1st of each month (08:00 Europe/London).
//
// Lists every distinct customer that has at least one order in the DB
// (Woo or Direct), paginated, with a search box and a single "Add
// Subscription" checkbox per row. Toggling the checkbox immediately calls
// the backend (POST or DELETE) — there's no Save step.
import { useCallback, useEffect, useState } from "react";
import { Loader2, Repeat, Search, X, AlertCircle, CheckCircle2 } from "lucide-react";
import api from "@/lib/api";

const PAGE_SIZE = 50;

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return "—"; }
}

export default function SubscriptionsModal({ open, onClose }) {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0, has_more: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Per-row pending state keyed by customer_key, so a click on one row
  // doesn't grey out every other row.
  const [pending, setPending] = useState(() => new Set());
  const [toast, setToast] = useState(null); // { type: 'ok' | 'err', msg }

  // Debounce search input → 1 backend call per keystroke burst.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => { setDebouncedQ(q.trim()); setPage(1); }, 250);
    return () => clearTimeout(t);
  }, [q, open]);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const { data: res } = await api.get("/orders/subscriptions/customers", {
        params: { q: debouncedQ, page, page_size: PAGE_SIZE },
      });
      setData(res || { items: [], total: 0, has_more: false });
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not load customers.");
    } finally {
      setLoading(false);
    }
  }, [debouncedQ, page]);

  useEffect(() => { if (open) load(); }, [open, load]);

  // Toggle one customer's subscription state. Optimistic so the checkbox
  // ticks immediately; rolls back on failure.
  const toggle = async (row) => {
    if (pending.has(row.customer_key)) return;
    setPending((s) => new Set(s).add(row.customer_key));
    const wasActive = row.subscription_active;
    // Optimistic UI update
    setData((d) => ({
      ...d,
      items: d.items.map((r) => (
        r.customer_key === row.customer_key
          ? { ...r, subscription_active: !wasActive }
          : r
      )),
    }));
    try {
      if (wasActive && row.subscription_id) {
        await api.delete(`/orders/subscriptions/${row.subscription_id}`);
        setToast({ type: "ok", msg: `Subscription removed for ${row.customer_label}` });
      } else {
        const { data: res } = await api.post("/orders/subscriptions", {
          customer_label: row.customer_label,
        });
        const newId = res?.subscription?.id || row.subscription_id;
        setData((d) => ({
          ...d,
          items: d.items.map((r) => (
            r.customer_key === row.customer_key
              ? { ...r, subscription_active: true, subscription_id: newId }
              : r
          )),
        }));
        setToast({ type: "ok", msg: `${row.customer_label} will get a draft on the 1st of each month` });
      }
    } catch (e) {
      // Roll back the optimistic toggle
      setData((d) => ({
        ...d,
        items: d.items.map((r) => (
          r.customer_key === row.customer_key
            ? { ...r, subscription_active: wasActive }
            : r
        )),
      }));
      setToast({ type: "err", msg: e?.response?.data?.detail || "Could not update subscription." });
    } finally {
      setPending((s) => { const n = new Set(s); n.delete(row.customer_key); return n; });
      // Auto-dismiss the toast.
      setTimeout(() => setToast(null), 3500);
    }
  };

  if (!open) return null;

  const totalPages = Math.max(1, Math.ceil((data.total || 0) / PAGE_SIZE));

  return (
    <div
      className="fixed inset-0 z-50 bg-stone-950/40 backdrop-blur-sm flex items-start justify-center px-4 py-10 overflow-y-auto"
      onClick={onClose}
      data-testid="subscriptions-modal-backdrop"
    >
      <div
        className="bg-white w-full max-w-5xl rounded-2xl border border-stone-200 shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        data-testid="subscriptions-modal"
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-stone-200 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-1.5">
              <Repeat className="w-3 h-3" /> Monthly subscriptions
            </div>
            <h2 className="font-display text-2xl font-black text-stone-950 mt-1">Subscription customers</h2>
            <p className="text-sm text-stone-600 mt-1 max-w-2xl">
              Tick a customer to auto-create an empty Draft order on the 1st of each month at 08:00 UK time.
              Untick to stop. Drafts land on the <strong>Draft</strong> tab with a memo line so they're easy to spot.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            data-testid="subscriptions-modal-close"
            className="shrink-0 w-9 h-9 rounded-full border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 hover:text-stone-950 flex items-center justify-center"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Toast */}
        {toast && (
          <div
            className={`mx-6 mt-4 px-3 py-2 rounded-lg text-xs flex items-center gap-2 border ${
              toast.type === "ok"
                ? "bg-emerald-50 border-emerald-200 text-emerald-900"
                : "bg-rose-50 border-rose-200 text-rose-900"
            }`}
            data-testid="subscriptions-toast"
          >
            {toast.type === "ok" ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
            {toast.msg}
          </div>
        )}

        {/* Search */}
        <div className="px-6 py-4 flex items-center gap-3 border-b border-stone-100">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search customer name…"
              data-testid="subscriptions-search"
              className="w-full pl-9 pr-3 py-2 text-sm bg-stone-50 border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400"
            />
          </div>
          <div className="text-xs text-stone-500 ml-auto" data-testid="subscriptions-total">
            {data.total.toLocaleString()} customer{data.total === 1 ? "" : "s"}
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto max-h-[60vh]">
          {error && (
            <div className="mx-6 my-3 px-3 py-2 rounded-lg text-xs bg-rose-50 border border-rose-200 text-rose-900 flex items-center gap-2">
              <AlertCircle className="w-3.5 h-3.5" /> {error}
            </div>
          )}
          <table className="w-full text-sm">
            <thead className="bg-stone-50 sticky top-0 z-10">
              <tr className="text-left text-[10px] uppercase tracking-wider text-stone-500">
                <th className="px-6 py-2 font-bold">Customer</th>
                <th className="px-3 py-2 font-bold whitespace-nowrap">Orders</th>
                <th className="px-3 py-2 font-bold whitespace-nowrap">Last order</th>
                <th className="px-3 py-2 font-bold whitespace-nowrap">Source</th>
                <th className="px-6 py-2 font-bold whitespace-nowrap text-right">Add subscription</th>
              </tr>
            </thead>
            <tbody>
              {loading && data.items.length === 0 ? (
                <tr><td colSpan={5} className="px-6 py-10 text-center text-stone-500"><Loader2 className="w-4 h-4 animate-spin inline" /> Loading customers…</td></tr>
              ) : data.items.length === 0 ? (
                <tr><td colSpan={5} className="px-6 py-10 text-center text-stone-500 text-xs">No customers match that search.</td></tr>
              ) : (
                data.items.map((row) => {
                  const isPending = pending.has(row.customer_key);
                  return (
                    <tr
                      key={row.customer_key}
                      className={`border-t border-stone-100 transition-colors ${row.subscription_active ? "bg-amber-50/50" : "hover:bg-stone-50/60"}`}
                      data-testid={`subscriptions-row-${row.customer_key}`}
                    >
                      <td className="px-6 py-3 font-medium text-stone-950">{row.customer_label}</td>
                      <td className="px-3 py-3 text-stone-700 tabular-nums">{row.order_count}</td>
                      <td className="px-3 py-3 text-stone-700 whitespace-nowrap">{fmtDate(row.last_order_date)}</td>
                      <td className="px-3 py-3">
                        <div className="flex gap-1 flex-wrap">
                          {(row.channels || []).map((c) => (
                            <span key={c} className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-stone-100 text-stone-700 rounded-md">
                              {c === "woocommerce" ? "Woo" : c}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-6 py-3 text-right">
                        <label className="inline-flex items-center gap-2 cursor-pointer select-none" data-testid={`subscriptions-toggle-${row.customer_key}`}>
                          <input
                            type="checkbox"
                            checked={!!row.subscription_active}
                            disabled={isPending}
                            onChange={() => toggle(row)}
                            className="w-4 h-4 accent-[#dddd16] cursor-pointer disabled:opacity-50"
                            aria-label={`Subscribe ${row.customer_label}`}
                          />
                          <span className={`text-xs font-bold uppercase tracking-wider ${row.subscription_active ? "text-stone-950" : "text-stone-500"}`}>
                            {isPending ? <Loader2 className="w-3 h-3 animate-spin inline" /> : (row.subscription_active ? "Subscribed" : "Add")}
                          </span>
                        </label>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="px-6 py-3 border-t border-stone-200 bg-stone-50 flex items-center justify-between text-xs">
          <div className="text-stone-500">
            Page {page} of {totalPages.toLocaleString()}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              data-testid="subscriptions-prev"
              className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-700 hover:bg-stone-100 rounded-md disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={!data.has_more || loading}
              onClick={() => setPage((p) => p + 1)}
              data-testid="subscriptions-next"
              className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-700 hover:bg-stone-100 rounded-md disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
