// Reconciliation page — surfaces every order that hasn't been linked to a
// Xero contact yet. For each row we suggest a best-guess Xero match
// (by email then by exact name), so the admin can usually just hit
// "Confirm" without picking anything.
//
// Top-bar actions:
//   • Sync Xero contacts — pulls every Xero contact into our local cache
//     so the suggestion engine has something to match against. Run once
//     after connecting Xero, then again if contacts change in bulk.
//   • Auto-match all — runs the in-process matcher over all unmatched
//     orders. Anything not matched stays in the table for manual review.
//
// Per-row actions:
//   • Confirm suggestion (one click — uses the suggested contact)
//   • Pick a different Xero contact (autocomplete via XeroContactPicker)
//   • Create a new Xero contact straight from the order's customer info
//   • Skip (hides the row from the default view so you can come back later)
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle, CheckCircle2, Loader2, RefreshCw, Search, X,
  UserPlus, ExternalLink, ArrowLeft, ChevronDown,
} from "lucide-react";
import api from "@/lib/api";
import XeroContactPicker from "@/components/orders/XeroContactPicker";

export default function OrdersReconciliationPage() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  const [limit] = useState(50);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [autoMatching, setAutoMatching] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await api.get("/orders/reconciliation", {
        params: { search: search || undefined, skip, limit },
      });
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not load orders.");
    } finally { setLoading(false); }
  }, [search, skip, limit]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setTimeout(() => { setSkip(0); load(); }, search ? 300 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const handleSync = async () => {
    setSyncing(true); setError(""); setInfo("");
    try {
      const { data } = await api.post("/xero/contacts/sync");
      setInfo(`Synced ${data.synced} Xero contacts.`);
    } catch (e) {
      setError(e?.response?.data?.detail || "Sync failed.");
    } finally { setSyncing(false); }
  };

  const handleAutoMatch = async () => {
    setAutoMatching(true); setError(""); setInfo("");
    try {
      const { data } = await api.post("/orders/auto-match-xero");
      setInfo(`Matched ${data.matched_by_email} by email + ${data.matched_by_name} by name. ${data.remaining} still need attention.`);
      await load();
    } catch (e) {
      setError(e?.response?.data?.detail || "Auto-match failed.");
    } finally { setAutoMatching(false); }
  };

  const handleLink = async (orderId, contact) => {
    try {
      await api.post(`/orders/${orderId}/link-xero-contact`, {
        xero_contact_id: contact.contact_id,
        name: contact.name,
        email: contact.email,
      });
      setItems((arr) => arr.filter((o) => o.id !== orderId));
      setTotal((t) => Math.max(0, t - 1));
    } catch (e) {
      alert(e?.response?.data?.detail || "Link failed.");
    }
  };

  const handleSkip = async (orderId) => {
    try {
      await api.post(`/orders/${orderId}/skip-xero-reconcile`);
      setItems((arr) => arr.filter((o) => o.id !== orderId));
      setTotal((t) => Math.max(0, t - 1));
    } catch (e) {
      alert(e?.response?.data?.detail || "Skip failed.");
    }
  };

  return (
    <div className="min-h-screen bg-stone-50" data-testid="orders-reconciliation-page">
      <div className="bg-white border-b border-stone-200 px-8 py-6 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <Link to="/orders" className="text-xs text-stone-500 hover:text-stone-900 inline-flex items-center gap-1">
            <ArrowLeft className="w-3 h-3" /> Back to orders
          </Link>
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mt-2">CRM · Orders</div>
          <h1 className="text-3xl font-display font-black text-stone-950 mt-1">Match to Xero</h1>
          <p className="text-sm text-stone-600 mt-1 max-w-2xl">
            {total.toLocaleString()} order{total === 1 ? "" : "s"} still need a Xero contact link. Confirm the suggestion, pick a different
            Xero contact, or create the contact in Xero — whichever's quicker.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSync}
            disabled={syncing}
            data-testid="reconcile-sync"
            className="px-3 py-2 border border-stone-300 bg-white text-stone-900 text-xs font-bold uppercase tracking-wider hover:bg-stone-50 rounded-lg disabled:opacity-50 flex items-center gap-2"
          >
            {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Sync Xero contacts
          </button>
          <button
            type="button"
            onClick={handleAutoMatch}
            disabled={autoMatching}
            data-testid="reconcile-auto-match"
            className="px-3 py-2 bg-stone-950 text-white text-xs font-bold uppercase tracking-wider rounded-lg hover:bg-stone-800 disabled:opacity-50 flex items-center gap-2"
          >
            {autoMatching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
            Auto-match all
          </button>
        </div>
      </div>

      <div className="px-8 py-4 flex items-center gap-3">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="reconcile-search"
            placeholder="Search by customer or order #…"
            className={`pl-9 ${search ? "pr-9" : "pr-3"} py-2 w-72 bg-white border border-stone-300 text-sm focus:outline-none focus:border-stone-900 rounded-lg`}
          />
          {search && (
            <button type="button" onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-stone-400 hover:text-stone-900">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {(error || info) && (
        <div className="px-8 pb-2 space-y-2">
          {error && <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-800 flex items-center gap-2"><AlertCircle className="w-4 h-4" /> {error}</div>}
          {info && <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-800 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> {info}</div>}
        </div>
      )}

      <div className="px-8 pb-12">
        <div className="bg-white border border-stone-200 rounded-2xl overflow-visible">
          {loading && items.length === 0 ? (
            <div className="p-12 text-center text-stone-500 text-sm">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="p-12 text-center text-stone-500 text-sm">
              All orders are linked to Xero contacts. Nothing to reconcile 🎉
            </div>
          ) : (
            <div className="divide-y divide-stone-100">
              {items.map((o) => (
                <ReconcileRow key={o.id} order={o} onLink={handleLink} onSkip={handleSkip} />
              ))}
            </div>
          )}
        </div>

        {total > limit && (
          <div className="mt-3 flex items-center justify-between text-xs text-stone-500">
            <span>{(skip + 1).toLocaleString()}–{Math.min(skip + limit, total).toLocaleString()} of {total.toLocaleString()}</span>
            <div className="flex gap-2">
              <button type="button" disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - limit))} className="px-3 py-1.5 border border-stone-300 rounded-lg disabled:opacity-40">Previous</button>
              <button type="button" disabled={skip + limit >= total} onClick={() => setSkip(skip + limit)} className="px-3 py-1.5 border border-stone-300 rounded-lg disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ReconcileRow({ order, onLink, onSkip }) {
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [pickerName, setPickerName] = useState(order.customer_label || "");
  const [pickerEmail, setPickerEmail] = useState(order.customer_email || "");
  const dt = order.date_created ? new Date(order.date_created).toLocaleDateString("en-GB") : "—";

  return (
    <div className="p-4 grid grid-cols-[120px_1fr_2fr_auto] gap-4 items-start" data-testid={`reconcile-row-${order.id}`}>
      <div>
        <Link to={`/orders/${order.id}`} className="inline-block px-2.5 py-1 bg-white border border-stone-300 rounded-md text-xs font-mono font-semibold hover:bg-stone-50">
          {order.display_order_id || order.woo_number || order.legacy_order_id || order.id.slice(0, 6)}
        </Link>
        <div className="text-[10px] text-stone-500 mt-1.5">{dt}</div>
        {order.channel === "woocommerce" && (
          <div className="text-[10px] uppercase text-stone-500 mt-0.5 font-bold">Woo</div>
        )}
      </div>

      <div>
        <div className="text-sm font-semibold text-stone-900">{order.customer_label || "(no name)"}</div>
        {order.customer_email && <div className="text-xs text-stone-500">{order.customer_email}</div>}
        {order.total && <div className="text-[11px] text-stone-500 mt-1">£{order.total}</div>}
      </div>

      <div>
        {order.suggested_xero ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2.5">
            <div className="text-[10px] uppercase tracking-wider font-bold text-emerald-700 mb-1">
              Suggested · matched by {order.suggested_xero.match_by}
            </div>
            <div className="text-sm font-medium text-stone-900">{order.suggested_xero.name}</div>
            {order.suggested_xero.email && <div className="text-[11px] text-stone-600">{order.suggested_xero.email}</div>}
            <div className="mt-2 flex gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => onLink(order.id, order.suggested_xero)}
                data-testid={`reconcile-confirm-${order.id}`}
                className="px-3 py-1.5 bg-emerald-600 text-white text-[11px] font-bold uppercase tracking-wider rounded-md hover:bg-emerald-700 flex items-center gap-1.5"
              >
                <CheckCircle2 className="w-3 h-3" /> Confirm
              </button>
              <button
                type="button"
                onClick={() => setOverrideOpen((o) => !o)}
                data-testid={`reconcile-override-${order.id}`}
                className="px-3 py-1.5 border border-stone-300 bg-white text-stone-700 text-[11px] font-bold uppercase tracking-wider rounded-md hover:bg-stone-50 flex items-center gap-1.5"
              >
                Pick different <ChevronDown className="w-3 h-3" />
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5">
            <div className="text-[10px] uppercase tracking-wider font-bold text-amber-700 mb-1">No suggestion</div>
            <div className="text-xs text-stone-700">Search Xero or create this customer.</div>
            <button
              type="button"
              onClick={() => setOverrideOpen(true)}
              className="mt-2 px-3 py-1.5 bg-stone-950 text-white text-[11px] font-bold uppercase tracking-wider rounded-md hover:bg-stone-800 flex items-center gap-1.5"
            >
              <UserPlus className="w-3 h-3" /> Pick or create
            </button>
          </div>
        )}

        {overrideOpen && (
          <div className="mt-2 p-2.5 border border-stone-200 bg-white rounded-lg">
            <XeroContactPicker
              value={pickerName}
              emailValue={pickerEmail}
              onChange={setPickerName}
              onSelect={(c) => { onLink(order.id, c); setOverrideOpen(false); }}
              testid={`reconcile-picker-${order.id}`}
              placeholder="Search Xero contacts…"
            />
            <div className="mt-2">
              <input
                type="email"
                value={pickerEmail}
                onChange={(e) => setPickerEmail(e.target.value)}
                placeholder="Email (used when creating new)"
                className="w-full px-3 py-1.5 border border-stone-300 rounded-lg text-xs focus:outline-none focus:border-stone-900"
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Link
          to={`/orders/${order.id}`}
          className="px-2.5 py-1 border border-stone-300 bg-white text-[11px] font-bold uppercase tracking-wider rounded-md text-stone-700 hover:bg-stone-50 inline-flex items-center gap-1"
        >
          <ExternalLink className="w-3 h-3" /> Open
        </Link>
        <button
          type="button"
          onClick={() => onSkip(order.id)}
          data-testid={`reconcile-skip-${order.id}`}
          className="px-2.5 py-1 text-[11px] uppercase tracking-wider rounded-md text-stone-500 hover:text-stone-900 hover:bg-stone-100"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
