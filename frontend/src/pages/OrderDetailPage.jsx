// OrderDetailPage — full single-order workspace (Stage B).
//
// Mirrors the legacy admin's order detail screen (see "3 Order Detail View
// MAIN.png" reference): editable line items with product autocomplete pulled
// from our synced Woo catalogue, manual shipping field, Save Order, and the
// 5-option Actions menu (Mark Completed / Complete & Invoice / Create
// Invoice / Mark Paid / Change Customer). Draft orders get a different menu
// (Mark Active / Mark Paid / Change Customer / Delete).
//
// Reads /api/orders/:id  · Saves via PATCH /api/orders/:id
// Actions hit /api/orders/:id/action  · Manual create lives in OrdersPage.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import {
  ArrowLeft, Loader2, Save, MoreHorizontal, Plus, X, Trash2,
  CheckCircle2, FileText, Receipt, CreditCard, UserCog, ChevronDown, AlertCircle,
} from "lucide-react";
import api from "@/lib/api";

const PRODUCTION_OPTIONS = [
  "Awaiting Assembly",
  "In Production",
  "Awaiting Labels",
  "Ready To Ship",
  "Complete",
];

// Colour palette mirrors the legacy admin's status pills exactly so any
// admin moving between the two systems sees the same visual cues.
const PRODUCTION_PILL = {
  "Awaiting Assembly": "bg-rose-600 text-white",
  "In Production":     "bg-orange-500 text-white",
  "Awaiting Labels":   "bg-cyan-600 text-white",
  "Ready To Ship":     "bg-indigo-950 text-white",
  "Complete":          "bg-emerald-500 text-white",
  // Back-compat for legacy data that used "Completed"
  "Completed":         "bg-emerald-500 text-white",
  "Dispatched":        "bg-emerald-600 text-white",
  "Cancelled":         "bg-stone-500 text-white",
  "Refunded":          "bg-stone-500 text-white",
  "Failed":            "bg-rose-700 text-white",
};

const formatGBP = (v) => {
  const n = parseFloat(v || 0);
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(isNaN(n) ? 0 : n);
};

export default function OrderDetailPage() {
  const { orderId } = useParams();
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [actionsOpen, setActionsOpen] = useState(false);
  const [changeCustomerOpen, setChangeCustomerOpen] = useState(false);

  // Edit buffers — committed to the server on Save Order
  const [lineItems, setLineItems] = useState([]);
  const [shippingTotal, setShippingTotal] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [productionStatus, setProductionStatus] = useState("Awaiting Assembly");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await api.get(`/orders/${orderId}`);
      setOrder(data);
      setLineItems((data.line_items || []).map((li, i) => ({ ...li, _key: i })));
      setShippingTotal(data.shipping_total || "0.00");
      setDueDate(data.due_date || "");
      setProductionStatus(data.production_status || "Awaiting Assembly");
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not load order.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orderId]);

  const orderTotal = useMemo(() => {
    const lineSum = lineItems.reduce(
      (s, li) => s + (parseFloat(li.subtotal || 0) * (parseInt(li.quantity, 10) || 1)),
      0,
    );
    return lineSum + parseFloat(shippingTotal || 0);
  }, [lineItems, shippingTotal]);

  const handleAddProduct = (product) => {
    setLineItems((items) => [
      ...items,
      {
        _key: Date.now(),
        id: null,
        product_id: product?.woo_id || product?.id,
        name: product?.name || "",
        sku: product?.sku,
        quantity: 1,
        subtotal: product?.price || "0.00",
      },
    ]);
  };

  const updateLine = (key, patch) => {
    setLineItems((items) => items.map((li) => (li._key === key ? { ...li, ...patch } : li)));
  };
  const removeLine = (key) => setLineItems((items) => items.filter((li) => li._key !== key));

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      const { data } = await api.patch(`/orders/${orderId}`, {
        line_items: lineItems.map((li) => ({
          id: li.id, product_id: li.product_id, name: li.name, sku: li.sku,
          quantity: parseInt(li.quantity, 10) || 1,
          subtotal: parseFloat(li.subtotal || 0),
        })),
        shipping_total: parseFloat(shippingTotal || 0),
        due_date: dueDate || null,
        production_status: productionStatus,
      });
      setOrder(data.order);
    } catch (e) {
      setError(e?.response?.data?.detail || "Save failed.");
    } finally { setSaving(false); }
  };

  const handleAction = async (action, extra = {}) => {
    setActionsOpen(false);
    setSaving(true);
    try {
      const { data } = await api.post(`/orders/${orderId}/action`, { action, ...extra });
      setOrder(data.order);
      if (action === "mark_active") navigate(`/orders/${orderId}`);
    } catch (e) {
      setError(e?.response?.data?.detail || "Action failed.");
    } finally { setSaving(false); }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center" data-testid="order-loading">
        <Loader2 className="w-5 h-5 animate-spin text-stone-500" />
      </div>
    );
  }
  if (!order) {
    return (
      <div className="min-h-screen bg-stone-50 px-8 py-12" data-testid="order-missing">
        <Link to="/orders" className="text-sm text-stone-500 hover:text-stone-900 underline">← Back to orders</Link>
        <div className="mt-6 p-4 bg-rose-50 border border-rose-200 rounded-xl text-sm text-rose-800">
          {error || "Order not found."}
        </div>
      </div>
    );
  }

  const isDraft = !!order.is_draft;

  return (
    <div className="min-h-screen bg-stone-50" data-testid="order-detail-page">
      {/* Header */}
      <div className="bg-white border-b border-stone-200 px-8 py-6 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <Link to="/orders" className="text-xs text-stone-500 hover:text-stone-900 inline-flex items-center gap-1">
            <ArrowLeft className="w-3 h-3" /> Back to orders
          </Link>
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mt-2">
            CRM · ORDER {isDraft ? "DRAFT" : ""}
          </div>
          <h1 className="text-3xl font-display font-black text-stone-950 mt-1 flex items-center gap-3">
            <span>#{order.display_order_id || order.woo_number || order.legacy_order_id || order.id}</span>
            <span className={`px-3 py-1 rounded-full text-[11px] font-semibold ${PRODUCTION_PILL[order.production_status] || "bg-stone-300 text-stone-800"}`}>
              {order.production_status}
            </span>
            <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${
              order.payment_status === "Paid" ? "bg-emerald-500 text-white" : "bg-stone-400 text-white"
            }`}>{order.payment_status}</span>
            {order.invoiced && <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-900 border border-amber-200">Invoiced</span>}
          </h1>
        </div>

        {/* Save + Actions */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            data-testid="save-order-button"
            className="px-4 py-2 bg-stone-950 text-white text-xs font-bold uppercase tracking-wider rounded-lg hover:bg-stone-800 disabled:opacity-50 flex items-center gap-2"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save Order
          </button>
          <ActionsDropdown
            isDraft={isDraft}
            open={actionsOpen}
            setOpen={setActionsOpen}
            onAction={handleAction}
            onChangeCustomer={() => { setActionsOpen(false); setChangeCustomerOpen(true); }}
          />
        </div>
      </div>

      {error && (
        <div className="mx-8 my-3 p-3 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-800 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* Two-column body */}
      <div className="px-8 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: line items + add product */}
        <div className="lg:col-span-2 space-y-6">
          <Card title="Line Items">
            <AddProductRow onAdd={handleAddProduct} />
            <div className="mt-4 divide-y divide-stone-100">
              {lineItems.length === 0 ? (
                <div className="py-6 text-center text-sm text-stone-500" data-testid="line-items-empty">
                  No items yet — search for a product above and click <strong>Add to Order</strong>.
                </div>
              ) : lineItems.map((li) => (
                <LineItemRow key={li._key} li={li} onUpdate={updateLine} onRemove={removeLine} />
              ))}
            </div>
            <div className="mt-4 border-t border-stone-200 pt-4 flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-stone-600">Shipping</span>
                <span className="text-stone-400">£</span>
                <input
                  type="number"
                  step="0.01"
                  value={shippingTotal}
                  onChange={(e) => setShippingTotal(e.target.value)}
                  data-testid="order-shipping-input"
                  className="w-24 px-2 py-1 border border-stone-300 rounded-md text-sm tabular-nums focus:outline-none focus:border-stone-900"
                />
              </div>
              <div className="text-lg font-bold text-stone-950 tabular-nums" data-testid="order-total">
                Total: {formatGBP(orderTotal)}
              </div>
            </div>
          </Card>
        </div>

        {/* Right: customer + meta */}
        <div className="space-y-6">
          <Card title="Customer">
            <div className="text-sm text-stone-900 font-medium">{order.customer_label}</div>
            {order.customer_email && (
              <a className="text-xs text-stone-600 hover:underline mt-1 inline-block" href={`mailto:${order.customer_email}`}>
                {order.customer_email}
              </a>
            )}
            <button
              type="button"
              onClick={() => setChangeCustomerOpen(true)}
              data-testid="change-customer-inline"
              className="mt-3 text-[11px] font-bold uppercase tracking-wider text-stone-700 hover:text-stone-950 inline-flex items-center gap-1"
            >
              <UserCog className="w-3 h-3" /> Change customer
            </button>
          </Card>

          <Card title="Order Info">
            <Row k="Channel" v={order.channel === "woocommerce" ? `Woo#${order.woo_number || order.id}` : "Direct"} />
            <Row k="Created" v={new Date(order.date_created).toLocaleString("en-GB")} />
            <Row k="Due date" inputable>
              <input
                type="date"
                value={dueDate ? dueDate.slice(0, 10) : ""}
                onChange={(e) => setDueDate(e.target.value || "")}
                data-testid="order-due-date-input"
                className="px-2 py-1 border border-stone-300 rounded-md text-sm focus:outline-none focus:border-stone-900"
              />
            </Row>
            <Row k="Production" inputable>
              <select
                value={productionStatus}
                onChange={(e) => setProductionStatus(e.target.value)}
                data-testid="order-production-select"
                className="px-2 py-1 border border-stone-300 rounded-md text-sm focus:outline-none focus:border-stone-900"
              >
                {PRODUCTION_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Row>
            <Row k="Payment" v={order.payment_status} />
            {order.date_paid && <Row k="Paid on" v={new Date(order.date_paid).toLocaleDateString("en-GB")} />}
          </Card>
        </div>
      </div>

      <ChangeCustomerModal
        open={changeCustomerOpen}
        order={order}
        onClose={() => setChangeCustomerOpen(false)}
        onSaved={(label, email) => handleAction("change_customer", { customer_label: label, customer_email: email })}
      />
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div className="bg-white border border-stone-200 rounded-2xl p-5">
      <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-3">{title}</div>
      {children}
    </div>
  );
}

function Row({ k, v, inputable, children }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-stone-500 text-xs uppercase tracking-wider">{k}</span>
      {inputable ? children : <span className="text-stone-900 text-right">{v}</span>}
    </div>
  );
}

function LineItemRow({ li, onUpdate, onRemove }) {
  return (
    <div className="flex items-center gap-3 py-3" data-testid={`line-item-${li._key}`}>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-stone-900 text-sm leading-tight truncate">{li.name}</div>
        {li.sku && <div className="text-[11px] text-stone-400 font-mono">{li.sku}</div>}
      </div>
      <input
        type="number"
        min="1"
        value={li.quantity}
        onChange={(e) => onUpdate(li._key, { quantity: e.target.value })}
        data-testid={`line-qty-${li._key}`}
        className="w-14 px-2 py-1 border border-stone-300 rounded-md text-sm tabular-nums focus:outline-none focus:border-stone-900"
      />
      <div className="text-xs text-stone-400">×</div>
      <div className="flex items-center gap-0.5">
        <span className="text-stone-400 text-xs">£</span>
        <input
          type="number"
          step="0.01"
          value={li.subtotal}
          onChange={(e) => onUpdate(li._key, { subtotal: e.target.value })}
          data-testid={`line-price-${li._key}`}
          className="w-20 px-2 py-1 border border-stone-300 rounded-md text-sm tabular-nums focus:outline-none focus:border-stone-900"
        />
      </div>
      <div className="w-20 text-right text-sm font-semibold tabular-nums">
        {formatGBP((parseFloat(li.subtotal) || 0) * (parseInt(li.quantity, 10) || 1))}
      </div>
      <button
        type="button"
        onClick={() => onRemove(li._key)}
        data-testid={`line-remove-${li._key}`}
        aria-label="Remove line"
        className="p-1.5 text-stone-400 hover:text-rose-600 hover:bg-rose-50 rounded-md"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function AddProductRow({ onAdd }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get("/woo/products/autocomplete", { params: { q, limit: 8 } });
        setResults(data.items || []);
        setOpen(true);
      } catch { setResults([]); }
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onDoc = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div className="flex items-center gap-2" ref={wrapRef}>
      <div className="relative flex-1">
        <input
          type="text"
          value={q}
          onChange={(e) => { setQ(e.target.value); setSelected(null); }}
          onFocus={() => results.length && setOpen(true)}
          placeholder="Type a product name…"
          data-testid="product-search-input"
          className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-900"
        />
        {open && results.length > 0 && (
          <div
            data-testid="product-autocomplete-dropdown"
            className="absolute left-0 right-0 top-full mt-1 max-h-60 overflow-y-auto z-20 bg-white border border-stone-200 rounded-lg shadow-lg"
          >
            {results.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => { setSelected(p); setQ(p.name); setOpen(false); }}
                data-testid={`product-option-${p.id}`}
                className="w-full text-left px-3 py-2 text-sm hover:bg-stone-50 border-b border-stone-100 last:border-b-0"
              >
                <div className="font-medium text-stone-900 leading-tight">{p.name}</div>
                <div className="text-[11px] text-stone-500 flex items-center gap-2">
                  {p.sku && <span className="font-mono">{p.sku}</span>}
                  <span>{formatGBP(p.price)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        disabled={!selected && !q.trim()}
        onClick={() => {
          const product = selected || { name: q, price: "0.00" };
          onAdd(product);
          setQ(""); setSelected(null); setResults([]);
        }}
        data-testid="add-to-order-button"
        className="px-4 py-2 bg-stone-950 text-white text-xs font-bold uppercase tracking-wider rounded-lg hover:bg-stone-800 disabled:opacity-40 flex items-center gap-1.5"
      >
        <Plus className="w-3.5 h-3.5" /> Add to Order
      </button>
    </div>
  );
}

function ActionsDropdown({ isDraft, open, setOpen, onAction, onChangeCustomer }) {
  const wrapRef = useRef(null);
  useEffect(() => {
    const onDoc = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [setOpen]);

  const liveOpts = [
    { key: "mark_completed",       label: "Mark as Completed",     icon: CheckCircle2, danger: false },
    { key: "complete_and_invoice", label: "Complete & Create Invoice", icon: Receipt, danger: false },
    { key: "create_invoice",       label: "Create Invoice",        icon: FileText,    danger: false },
    { key: "mark_paid",            label: "Mark as Paid",          icon: CreditCard,  danger: false },
    { key: "_change_customer",     label: "Change Order Customer", icon: UserCog,     danger: false },
  ];
  const draftOpts = [
    { key: "mark_active",      label: "Mark as Active",        icon: CheckCircle2, danger: false },
    { key: "mark_paid",        label: "Mark as Paid",          icon: CreditCard,   danger: false },
    { key: "_change_customer", label: "Change Order Customer", icon: UserCog,      danger: false },
  ];
  const opts = isDraft ? draftOpts : liveOpts;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="actions-menu-button"
        className="px-4 py-2 border border-stone-300 bg-white text-stone-900 text-xs font-bold uppercase tracking-wider rounded-lg hover:bg-stone-50 flex items-center gap-2"
      >
        Actions <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div
          data-testid="actions-menu"
          className="absolute right-0 top-full mt-1 w-64 bg-white border border-stone-200 rounded-xl shadow-lg z-30 overflow-hidden"
        >
          {opts.map((opt) => {
            const Icon = opt.icon;
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => opt.key === "_change_customer" ? onChangeCustomer() : onAction(opt.key)}
                data-testid={`action-${opt.key}`}
                className="w-full px-4 py-2.5 text-left text-sm hover:bg-stone-50 flex items-center gap-2.5"
              >
                <Icon className="w-3.5 h-3.5 text-stone-500" /> {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChangeCustomerModal({ open, order, onClose, onSaved }) {
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  useEffect(() => {
    if (open && order) {
      setLabel(order.customer_label || "");
      setEmail(order.customer_email || "");
    }
  }, [open, order]);
  if (!open) return null;
  return (
    <div onClick={onClose} className="fixed inset-0 z-[55] bg-stone-950/50 backdrop-blur-sm flex items-center justify-center p-4" data-testid="change-customer-modal">
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-display font-black">Change order customer</h3>
          <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-900" aria-label="Close"><X className="w-5 h-5" /></button>
        </div>
        <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">Customer name / company</label>
        <input value={label} onChange={(e) => setLabel(e.target.value)} data-testid="change-customer-label"
          className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-900 mb-3" />
        <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">Email</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="change-customer-email"
          className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-900" />
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm border border-stone-300 rounded-lg hover:bg-stone-50">Cancel</button>
          <button type="button" onClick={() => { onSaved(label.trim(), email.trim()); onClose(); }}
            data-testid="change-customer-save"
            className="px-4 py-2 bg-stone-950 text-white text-xs font-bold uppercase tracking-wider rounded-lg hover:bg-stone-800">Save</button>
        </div>
      </div>
    </div>
  );
}
