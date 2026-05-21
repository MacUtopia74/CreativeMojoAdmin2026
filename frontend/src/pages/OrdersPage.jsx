// Orders — Stage A of the Phase 2 Orders Management module.
//
// Mirrors the legacy admin's "Active Orders" page (admin.creativemojo.co.uk)
// with the same UX: tab pills (ACTIVE / COMPLETED / ALL / DRAFT), search bar,
// Show Products toggle, and a table with channel pills + status badges.
//
// Data flows in from /api/orders which (a) reads from the local
// woo_orders Mongo mirror that the woocommerce_integration module keeps
// in sync via webhook + hourly resync, or (b) shows seed demo data
// until live Woo credentials are wired in.
//
// Note: Stage A is read-only. Order detail editing, manual create,
// product autocomplete, status workflow, and Xero invoicing arrive in
// Stages B+C.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ShoppingBag, Search, X, Plus, RefreshCw, Loader2, AlertCircle,
  CheckSquare, Square, CheckCircle2, CreditCard, FileText,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import api from "@/lib/api";
import CreateOrderModal from "@/components/orders/CreateOrderModal";
import ProductionStatusDropdown from "@/components/orders/ProductionStatusDropdown";

const TABS = [
  { key: "active",    label: "ACTIVE",    activeBg: "bg-[#dddd16] text-stone-950" },
  { key: "completed", label: "COMPLETED", activeBg: "bg-[#dddd16] text-stone-950" },
  { key: "all",       label: "ALL",       activeBg: "bg-[#dddd16] text-stone-950" },
  { key: "draft",     label: "DRAFT",     activeBg: "bg-[#dddd16] text-stone-950" },
];

const PRODUCTION_PILL = {
  "Ready To Ship":     "bg-stone-900 text-white",
  "Awaiting Assembly": "bg-rose-500 text-white",
  "In Production":     "bg-amber-500 text-white",
  "Dispatched":        "bg-emerald-600 text-white",
  "Completed":         "bg-stone-400 text-white",
  "Cancelled":         "bg-stone-500 text-white",
  "Refunded":          "bg-stone-500 text-white",
  "Failed":            "bg-rose-700 text-white",
};

const PAYMENT_PILL = {
  Paid:    "bg-emerald-500 text-white",
  Pending: "bg-stone-400 text-white",
};

const fmtDate = (iso) => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "2-digit" });
  } catch { return "—"; }
};

const dueLabel = (iso) => {
  if (!iso) return null;
  const due = new Date(iso);
  if (isNaN(due.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  const days = Math.round((due - today) / 86400000);
  if (days === 0) {
    const hours = Math.round((new Date(iso) - new Date()) / 3600000);
    if (hours > 0 && hours <= 24) return { txt: `in about ${hours} hours`, color: "text-rose-600" };
    return { txt: "today", color: "text-rose-600" };
  }
  if (days < 0) return { txt: `${-days} day${days === -1 ? "" : "s"} ago`, color: "text-rose-700" };
  if (days <= 3) return { txt: `in ${days} day${days === 1 ? "" : "s"}`, color: "text-rose-600" };
  if (days <= 7) return { txt: `in ${days} days`, color: "text-amber-600" };
  return { txt: `in ${days} days`, color: "text-emerald-600" };
};

export default function OrdersPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState("active");
  const [search, setSearch] = useState("");
  const [showProducts, setShowProducts] = useState(true);
  // Driven by the toggle on /admin/xero (saved in localStorage). When true
  // we hide the small "Legacy (#1234)" tag under the order ID.
  const [hideLegacyIds, setHideLegacyIds] = useState(() => localStorage.getItem("hide_legacy_ids") === "1");
  useEffect(() => {
    const onStorage = () => setHideLegacyIds(localStorage.getItem("hide_legacy_ids") === "1");
    window.addEventListener("storage", onStorage);
    window.addEventListener("hide-legacy-ids-changed", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("hide-legacy-ids-changed", onStorage);
    };
  }, []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState({ items: [], total: 0 });
  const [counts, setCounts] = useState({ active: 0, completed: 0, all: 0, draft: 0 });
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [bulkPending, setBulkPending] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await api.get("/orders", {
        params: { tab, search: search || undefined, limit: 1000 },
      });
      setData(data);
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not load orders.");
    } finally {
      setLoading(false);
    }
  };

  const loadCounts = async () => {
    try {
      const { data } = await api.get("/orders/counts");
      setCounts(data || {});
    } catch (e) { /* non-critical */ }
  };

  useEffect(() => {
    const t = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, search]);

  useEffect(() => { loadCounts(); }, [data.items.length]);
  // Reset selection on tab/search change
  useEffect(() => { setSelectedIds(new Set()); }, [tab, search]);

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectAllVisible = () => {
    setSelectedIds(new Set((data.items || []).map((o) => o.id)));
  };
  const clearSelection = () => setSelectedIds(new Set());

  const runBulk = async (action) => {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`Apply "${action.replace(/_/g, " ")}" to ${selectedIds.size} order(s)?`)) return;
    setBulkPending(true);
    try {
      await api.post("/orders/bulk-action", { ids: Array.from(selectedIds), action });
      clearSelection();
      await load();
      await loadCounts();
    } catch (e) {
      setError(e?.response?.data?.detail || "Bulk action failed.");
    } finally { setBulkPending(false); }
  };

  // Bulk-create Xero invoices for every selected order. Skips any that
  // already have a Xero invoice (server-side) so the user can fire it
  // safely after partial runs.
  const runBulkXero = async () => {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`Create Xero draft invoices for ${selectedIds.size} order(s)?\n\nOrders already invoiced will be skipped.`)) return;
    setBulkPending(true);
    setError("");
    try {
      const { data } = await api.post("/xero/orders/bulk-create-invoices", { ids: Array.from(selectedIds) });
      let msg = `Created ${data.created} draft invoice(s) in Xero.`;
      if (data.skipped) msg += ` Skipped ${data.skipped} already-invoiced.`;
      if (data.failed) msg += ` ${data.failed} failed — check console.`;
      if (data.errors?.length) console.warn("Xero bulk-create errors:", data.errors);
      alert(msg);
      clearSelection();
      await load();
    } catch (e) {
      setError(e?.response?.data?.detail || "Bulk Xero invoice creation failed.");
    } finally { setBulkPending(false); }
  };

  const items = data.items || [];

  return (
    <div className="min-h-screen bg-stone-100" data-testid="orders-page">
      {/* Page header */}
      <div className="bg-white border-b border-stone-200 px-8 py-6 flex items-center justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">CRM · Orders</div>
          <h1 className="text-3xl font-display font-black text-stone-950 mt-1 flex items-center gap-2">
            <ShoppingBag className="w-6 h-6" />
            {tab === "active" && "Active Orders"}
            {tab === "completed" && "Completed Orders"}
            {tab === "all" && "All Orders"}
            {tab === "draft" && "Draft Orders"}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/orders/reconcile"
            data-testid="open-reconcile"
            className="px-4 py-2 border border-stone-300 bg-white text-stone-900 text-xs font-bold uppercase tracking-wider hover:bg-stone-50 rounded-lg transition-colors flex items-center gap-2"
          >
            Match to Xero
          </Link>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            data-testid="create-order-button"
            className="px-4 py-2 border border-stone-300 bg-white text-stone-900 text-xs font-bold uppercase tracking-wider hover:bg-stone-50 rounded-lg transition-colors flex items-center gap-2"
          >
            <Plus className="w-3.5 h-3.5" /> Create Order
          </button>
        </div>
      </div>

      {/* Filter row — tab pills + Show Products toggle + search */}
      <div className="px-8 py-4 flex items-center gap-3 flex-wrap">
        {TABS.map((t) => {
          const active = tab === t.key;
          const n = counts[t.key];
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              data-testid={`orders-tab-${t.key}`}
              className={`px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-lg border transition-colors ${
                active ? t.activeBg + " border-[#dddd16]" : "bg-white text-stone-700 border-stone-300 hover:bg-stone-100"
              }`}
            >
              <span>{t.label}</span>
              {typeof n === "number" && (
                <span
                  data-testid={`orders-tab-count-${t.key}`}
                  className={`ml-2 inline-block tabular-nums text-[10px] px-1.5 py-0.5 rounded-full ${
                    active ? "bg-stone-950 text-white" : "bg-stone-100 text-stone-700"
                  }`}
                >
                  {n.toLocaleString()}
                </span>
              )}
            </button>
          );
        })}

        <div className="ml-2 flex items-center gap-2 text-xs text-stone-700">
          <label htmlFor="show-products-toggle" className="font-medium cursor-pointer select-none">Show Products</label>
          <Switch
            id="show-products-toggle"
            checked={showProducts}
            onCheckedChange={setShowProducts}
            data-testid="show-products-toggle"
            className="data-[state=checked]:bg-[#dddd16] data-[state=unchecked]:bg-stone-300"
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="orders-search"
              placeholder="Search orders…"
              className={`pl-9 ${search ? "pr-9" : "pr-3"} py-2 w-64 bg-white border border-stone-300 text-sm focus:outline-none focus:border-stone-900 rounded-lg`}
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                data-testid="orders-search-clear"
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-stone-400 hover:text-stone-900 hover:bg-stone-200 rounded-md"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => { load(); loadCounts(); }}
            data-testid="orders-refresh"
            disabled={loading}
            className="p-2 border border-stone-300 bg-white text-stone-900 hover:bg-stone-50 rounded-lg disabled:opacity-40"
            aria-label="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Bulk action bar — appears when one or more orders are selected */}
      {selectedIds.size > 0 && (
        <div className="px-8" data-testid="orders-bulk-bar">
          <div className="bg-stone-950 text-white rounded-xl px-4 py-2.5 flex items-center gap-3 flex-wrap">
            <span className="text-sm font-bold" data-testid="orders-bulk-count">
              {selectedIds.size} selected
            </span>
            <button
              type="button"
              onClick={() => runBulk("mark_completed")}
              disabled={bulkPending}
              data-testid="orders-bulk-mark-completed"
              className="px-3 py-1.5 bg-stone-800 hover:bg-stone-700 text-white text-[11px] font-bold uppercase tracking-wider rounded-lg flex items-center gap-1.5 disabled:opacity-50"
            >
              <CheckCircle2 className="w-3.5 h-3.5" /> Mark Completed
            </button>
            <button
              type="button"
              onClick={() => runBulk("mark_paid")}
              disabled={bulkPending}
              data-testid="orders-bulk-mark-paid"
              className="px-3 py-1.5 bg-stone-800 hover:bg-stone-700 text-white text-[11px] font-bold uppercase tracking-wider rounded-lg flex items-center gap-1.5 disabled:opacity-50"
            >
              <CreditCard className="w-3.5 h-3.5" /> Mark Paid
            </button>
            {tab === "draft" && (
              <button
                type="button"
                onClick={() => runBulk("mark_active")}
                disabled={bulkPending}
                data-testid="orders-bulk-mark-active"
                className="px-3 py-1.5 bg-[#dddd16] hover:bg-[#c4c413] text-stone-950 text-[11px] font-bold uppercase tracking-wider rounded-lg flex items-center gap-1.5 disabled:opacity-50"
              >
                <CheckCircle2 className="w-3.5 h-3.5" /> Make Active
              </button>
            )}
            <button
              type="button"
              onClick={runBulkXero}
              disabled={bulkPending}
              data-testid="orders-bulk-send-xero"
              className="px-3 py-1.5 bg-[#13B5EA] hover:bg-[#0e9ed1] text-white text-[11px] font-bold uppercase tracking-wider rounded-lg flex items-center gap-1.5 disabled:opacity-50"
            >
              <FileText className="w-3.5 h-3.5" /> Send to Xero
            </button>
            <button
              type="button"
              onClick={selectAllVisible}
              data-testid="orders-bulk-select-all"
              className="ml-auto px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-stone-300 hover:text-white"
            >
              Select all on page ({items.length})
            </button>
            <button
              type="button"
              onClick={clearSelection}
              data-testid="orders-bulk-clear"
              className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-stone-300 hover:text-white"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Stage A banner — only renders until Woo creds are wired */}
      <OrdersStageBanner />

      {/* Orders table */}
      <div className="px-8 pb-12">
        {error && (
          <div className="my-4 p-3 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-800 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}

        <div className="bg-white border-2 border-stone-300 rounded-2xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 border-b-2 border-stone-300">
                <tr className="text-stone-500 uppercase tracking-wider text-[10px]">
                  <th className="px-2 py-3 text-left font-bold w-8"></th>
                  <th className="px-2 py-3 text-left font-bold">ID</th>
                  <th className="px-2 py-3 text-left font-bold">Created</th>
                  <th className="px-2 py-3 text-left font-bold">Due</th>
                  <th className="px-2 py-3 text-left font-bold">Customer</th>
                  <th className="px-2 py-3 text-left font-bold">Products</th>
                  <th className="px-2 py-3 text-left font-bold">Production</th>
                  <th className="px-2 py-3 text-left font-bold">Invoiced</th>
                  <th className="px-2 py-3 text-left font-bold">Payment</th>
                  <th className="px-2 py-3 text-left font-bold">Channel</th>
                  <th className="px-2 py-3 text-left font-bold w-10"></th>
                </tr>
              </thead>
              <tbody>
                {loading && items.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="px-3 py-12 text-center text-stone-500 text-sm">
                      <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading orders…
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="px-3 py-12 text-center text-stone-500 text-sm">
                      No orders match.
                    </td>
                  </tr>
                ) : items.map((o) => (
                  <OrderRow
                    key={o.id}
                    order={o}
                    showProducts={showProducts}
                    hideLegacyIds={hideLegacyIds}
                    selected={selectedIds.has(o.id)}
                    onSelect={() => toggleSelect(o.id)}
                    onOpen={() => navigate(`/orders/${o.id}`)}
                    onMakeActive={async (id) => {
                      try {
                        await api.post(`/orders/${id}/action`, { action: "mark_active" });
                        await load();
                        await loadCounts();
                      } catch (e) {
                        setError(e?.response?.data?.detail || "Could not make active.");
                      }
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-3 text-xs text-stone-500 flex justify-between" data-testid="orders-footer">
          <span>{items.length.toLocaleString()} orders shown</span>
          <Link to="/mojo-orders" className="text-stone-500 hover:text-stone-900 underline">
            Open legacy admin (admin.creativemojo.co.uk) →
          </Link>
        </div>
      </div>

      <CreateOrderModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(newId) => {
          setCreateOpen(false);
          navigate(`/orders/${newId}`);
        }}
      />
    </div>
  );
}

function OrderRow({ order, showProducts, hideLegacyIds, selected = false, onSelect, onOpen, onMakeActive }) {
  const due = dueLabel(order.due_date);
  const isWoo = (order.channel || "").toLowerCase() === "woocommerce";

  return (
    <tr
      className={`border-b border-stone-200 last:border-b-0 cursor-pointer ${selected ? "bg-amber-50/40" : "hover:bg-stone-50/50"}`}
      onClick={(e) => {
        // Don't open the detail page when the click was on the checkbox.
        if (e.target.closest("[data-row-checkbox]")) return;
        onOpen?.();
      }}
      data-testid={`order-row-${order.id}`}
    >
      <td className="px-2 py-2.5 align-top" data-row-checkbox>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onSelect?.(); }}
          aria-label="Select row"
          data-testid={`order-select-${order.id}`}
          className="text-stone-400 hover:text-stone-950"
        >
          {selected ? <CheckSquare className="w-4 h-4 text-stone-950" /> : <Square className="w-4 h-4" />}
        </button>
      </td>
      <td className="px-2 py-2.5 align-top">
        <span className="inline-block px-2 py-0.5 bg-white border border-stone-300 rounded-md text-xs font-mono font-semibold">
          {order.display_order_id || order.woo_number || order.legacy_order_id || order.id}
        </span>
        {order.legacy_import && !hideLegacyIds && (
          <div
            className="text-[9px] uppercase tracking-wider text-stone-400 mt-1 font-bold"
            title={`Originally legacy admin #${order.legacy_order_id}`}
          >
            Legacy (#{order.legacy_order_id})
          </div>
        )}
      </td>
      <td className="px-2 py-2.5 align-top text-stone-700 whitespace-nowrap text-[13px]">
        {fmtDate(order.date_created)}
      </td>
      <td className="px-2 py-2.5 align-top whitespace-nowrap text-[13px]">
        <div>{fmtDate(order.due_date)}</div>
        {due && <div className={`text-[11px] ${due.color}`}>{due.txt}</div>}
      </td>
      <td className="px-2 py-2.5 align-top text-stone-900 font-medium max-w-[200px] text-[13px]">
        <div>{order.customer_label}</div>
      </td>
      <td className="px-2 py-2.5 align-top max-w-[280px]">
        {order.line_items_unavailable ? (
          <span className="text-[11px] text-stone-400 italic" data-testid={`legacy-no-items-${order.id}`}>
            Legacy import — line items not migrated
          </span>
        ) : showProducts && (order.line_items || []).map((li, i) => (
          <div key={i} className="flex items-start gap-2 mb-0.5 last:mb-0">
            <span className="text-[11px] text-stone-500 mt-0.5 font-mono">×{li.quantity}</span>
            <span className="text-stone-800 text-[12px] leading-tight">{li.name}</span>
          </div>
        ))}
        {!order.line_items_unavailable && !showProducts && (
          <span className="text-xs text-stone-400">
            {(order.line_items || []).length} item{(order.line_items || []).length === 1 ? "" : "s"}
          </span>
        )}
      </td>
      <td className="px-2 py-2.5 align-top">
        <ProductionStatusDropdown
          orderId={order.id}
          value={order.production_status}
          onChange={(next) => { order.production_status = next; }}
        />
      </td>
      <td className="px-2 py-2.5 align-top text-center">
        {order.invoiced ? (
          <span className="text-emerald-600" aria-label="Invoiced">✓</span>
        ) : (
          <span className="text-stone-400" aria-label="Not invoiced">✗</span>
        )}
      </td>
      <td className="px-2 py-2.5 align-top">
        <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${
          PAYMENT_PILL[order.payment_status] || "bg-stone-200 text-stone-700"
        }`}>
          {order.payment_status}
        </span>
      </td>
      <td className="px-2 py-2.5 align-top text-xs text-stone-700 whitespace-nowrap">
        {isWoo
          ? <span className="font-mono">{order.channel_label}</span>
          : <span>Direct</span>
        }
      </td>
      <td className="px-2 py-2.5 align-top">
        <div className="flex flex-col gap-1">
          <Link
            to={`/orders/${order.id}`}
            onClick={(e) => e.stopPropagation()}
            data-testid={`order-edit-${order.id}`}
            className="px-2 py-1 border border-stone-300 bg-white text-[11px] font-bold uppercase tracking-wider rounded-md text-stone-700 hover:bg-stone-50 text-center"
          >
            Edit
          </Link>
          {order.is_draft && onMakeActive && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onMakeActive(order.id); }}
              data-testid={`order-make-active-${order.id}`}
              className="px-2 py-1 bg-[#dddd16] text-stone-950 text-[11px] font-bold uppercase tracking-wider rounded-md hover:bg-[#c4c413]"
            >
              Make Active
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function OrdersStageBanner() {
  // Renders only while we're still on seed data (no live Woo creds yet).
  // Hidden once the user wires WOO_CONSUMER_KEY into backend/.env tomorrow
  // and the seed records get replaced by real Woo orders.
  const [shouldShow, setShouldShow] = useState(true);
  useEffect(() => {
    api.get("/orders?tab=all&limit=1").then(({ data }) => {
      const first = (data.items || [])[0];
      setShouldShow(!!first?.seed);
    }).catch(() => setShouldShow(true));
  }, []);
  if (!shouldShow) return null;
  return (
    <div className="mx-8 mb-2 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-900 flex items-start gap-3" data-testid="orders-stage-banner">
      <Info className="w-4 h-4 mt-0.5 shrink-0" />
      <div>
        <strong>Stage A — Demo data.</strong> Add your WooCommerce Consumer Key / Secret / Webhook Secret
        to <code>backend/.env</code> as <code>WOO_BASE_URL</code> / <code>WOO_CONSUMER_KEY</code> /
        {" "}<code>WOO_CONSUMER_SECRET</code> / <code>WOO_WEBHOOK_SECRET</code>, then trigger{" "}
        <code>POST /api/admin/woo/backfill-orders</code> + <code>POST /api/admin/woo/sync-products</code> and
        this banner will disappear as real orders replace the seeded ones.
      </div>
    </div>
  );
}

// Tiny standalone Info icon to keep the banner self-contained.
function Info({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
    </svg>
  );
}
