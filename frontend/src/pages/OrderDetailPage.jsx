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
  CheckCircle2, FileText, Receipt, CreditCard, UserCog, ChevronDown, AlertCircle, ExternalLink,
} from "lucide-react";
import api from "@/lib/api";
import XeroContactPicker from "@/components/orders/XeroContactPicker";
import ProductionStatusDropdown from "@/components/orders/ProductionStatusDropdown";

const WOO_BASE_URL = (process.env.REACT_APP_WOO_BASE_URL || "https://www.creativemojo.com").replace(/\/+$/, "");

// Colour palette is now centralised in ProductionStatusDropdown.jsx
// (PRODUCTION_PILL_CLASS) — header just renders that component.

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
  const [deleting, setDeleting] = useState(false);

  // Edit buffers — committed to the server on Save Order
  const [lineItems, setLineItems] = useState([]);
  const [shippingTotal, setShippingTotal] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [poNumber, setPoNumber] = useState("");
  // Xero contact (fetched when the order is matched) — used to pull the
  // delivery address straight from Xero when the local Woo shipping
  // record is empty (typical for legacy imports).
  const [xeroContact, setXeroContact] = useState(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await api.get(`/orders/${orderId}`);
      setOrder(data);
      setLineItems((data.line_items || []).map((li, i) => ({ ...li, _key: i })));
      setShippingTotal(data.shipping_total || "0.00");
      setDueDate(data.due_date || "");
      setPoNumber(data.po_number || "");
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not load order.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orderId]);

  // Fetch the Xero contact whenever the order is matched. We use it as a
  // fallback shipping address source for legacy imports.
  useEffect(() => {
    if (!order?.xero_contact_id) { setXeroContact(null); return; }
    let cancelled = false;
    api.get(`/xero/contacts/${order.xero_contact_id}`)
      .then(({ data }) => { if (!cancelled) setXeroContact(data); })
      .catch(() => { if (!cancelled) setXeroContact(null); });
    return () => { cancelled = true; };
  }, [order?.xero_contact_id]);

  // Resolve the address we should show as the delivery address:
  //   1. Local Woo shipping object if it has a real address line
  //   2. Otherwise — DELIVERY/STREET address from the linked Xero contact
  //   3. Fall back to the local shipping company-only stub
  const deliveryAddress = useMemo(() => {
    const local = order?.shipping;
    if (local && (local.address_1 || local.city || local.postcode)) {
      return { ...local, _source: "woocommerce" };
    }
    const xeroAddrs = xeroContact?.addresses || [];
    const xeroPick = xeroAddrs.find((a) => a.type === "DELIVERY" && (a.address_1 || a.city))
      || xeroAddrs.find((a) => a.type === "STREET" && (a.address_1 || a.city))
      || xeroAddrs.find((a) => a.address_1 || a.city);
    if (xeroPick) {
      return {
        company: order?.customer_label,
        first_name: xeroContact?.first_name,
        last_name: xeroContact?.last_name,
        address_1: xeroPick.address_1,
        address_2: xeroPick.address_2,
        city: xeroPick.city,
        state: xeroPick.region,
        postcode: xeroPick.postcode,
        country: xeroPick.country,
        phone: xeroContact?.phones?.[0]?.number,
        _source: "xero",
      };
    }
    return local || null;
  }, [order?.shipping, order?.customer_label, xeroContact]);

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
        po_number: poNumber || null,
      });
      setOrder(data.order);
    } catch (e) {
      setError(e?.response?.data?.detail || "Save failed.");
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!window.confirm("Permanently delete this order? This cannot be undone.")) return;
    setDeleting(true);
    setError("");
    try {
      await api.delete(`/orders/${orderId}`);
      navigate("/orders");
    } catch (e) {
      setError(e?.response?.data?.detail || "Delete failed.");
      setDeleting(false);
    }
  };

  const handleAction = async (action, extra = {}) => {
    setActionsOpen(false);
    setSaving(true);
    setError("");
    try {
      if (action === "create_invoice") {
        const { data } = await api.post(`/xero/orders/${orderId}/create-invoice`);
        if (data?.already_invoiced) {
          alert(`Already invoiced — Xero #${data.xero_invoice_number || data.xero_invoice_id}`);
        }
        await load();
      } else if (action === "complete_and_invoice") {
        await api.post(`/orders/${orderId}/action`, { action: "mark_completed" });
        await api.post(`/xero/orders/${orderId}/create-invoice`);
        await load();
      } else {
        const { data } = await api.post(`/orders/${orderId}/action`, { action, ...extra });
        setOrder(data.order);
        if (action === "mark_active") navigate(`/orders/${orderId}`);
      }
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
    <div className="min-h-screen bg-stone-100" data-testid="order-detail-page">
      {/* Header — compact */}
      <div className="bg-white border-b border-stone-300 px-8 py-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <Link to="/orders" className="text-xs text-stone-500 hover:text-stone-900 inline-flex items-center gap-1">
            <ArrowLeft className="w-3 h-3" /> Orders
          </Link>
          <div className="w-px h-5 bg-stone-200" />
          <h1 className="text-xl font-display font-black text-stone-950 flex items-center gap-3 flex-wrap">
            <span>#{order.display_order_id || order.woo_number || order.legacy_order_id || order.id}</span>
            {isDraft && <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-800 border border-amber-200">DRAFT</span>}
            <ProductionStatusDropdown
              orderId={order.id}
              value={order.production_status}
              onChange={(next) => setOrder((o) => ({ ...o, production_status: next }))}
            />
            <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${
              order.payment_status === "Paid" ? "bg-emerald-500 text-white" : "bg-stone-400 text-white"
            }`}>{order.payment_status}</span>
            {order.invoiced && <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-900 border border-amber-200">Invoiced</span>}
            {order.xero_invoice_id && (
              <a
                href={`https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${order.xero_invoice_id}`}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="xero-invoice-link"
                className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-sky-100 text-sky-900 border border-sky-200 hover:bg-sky-200"
                onClick={(e) => e.stopPropagation()}
              >
                Xero {order.xero_invoice_number ? `#${order.xero_invoice_number}` : "Invoice"} · {order.xero_invoice_status || "DRAFT"}
              </a>
            )}
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

      {/* Two-column body: left = Customer + Line Items + Danger Zone, right = Order Info + Delivery */}
      <div className="px-8 py-6 grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* LEFT column (3/5) */}
        <div className="lg:col-span-3 space-y-6">
          <Card title="Customer">
            <div className="text-2xl font-display font-black text-stone-950 leading-tight" data-testid="customer-name">
              {order.customer_label || "—"}
            </div>
            {order.customer_email && (
              <a className="text-xs text-stone-600 hover:underline mt-1.5 inline-block" href={`mailto:${order.customer_email}`}>
                {order.customer_email}
              </a>
            )}
            {order.xero_contact_id && (
              <div className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                <CheckCircle2 className="w-3 h-3" /> Matched in Xero
              </div>
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

          <Card title="Line Items">
            <AddProductRow onAdd={handleAddProduct} />
            <div className="mt-4">
              {lineItems.length > 0 && <LineItemsHeader />}
              <div className="divide-y divide-stone-100">
                {lineItems.length === 0 ? (
                  <div className="py-6 text-center text-sm text-stone-500" data-testid="line-items-empty">
                    No items yet — search for a product above and click <strong>Add to Order</strong>.
                  </div>
                ) : lineItems.map((li) => (
                  <LineItemRow key={li._key} li={li} onUpdate={updateLine} onRemove={removeLine} />
                ))}
              </div>
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

          {/* Danger zone */}
          <div className="rounded-2xl border-2 border-rose-200 bg-rose-50/60 p-4 flex items-center justify-between gap-4 flex-wrap" data-testid="danger-zone">
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-rose-700">Danger zone</div>
              <p className="text-sm text-stone-700 mt-0.5">Permanently delete this order. This can't be undone.</p>
            </div>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              data-testid="delete-order-button"
              className="px-4 py-2 bg-rose-600 text-white text-xs font-bold uppercase tracking-wider rounded-lg hover:bg-rose-700 disabled:opacity-50 flex items-center gap-2"
            >
              {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Delete Order
            </button>
          </div>
        </div>

        {/* RIGHT column (2/5) */}
        <div className="lg:col-span-2 space-y-6">
          <Card title="Order Info">
            <Row k="Channel" v={
              order.channel === "woocommerce" ? (
                order.woo_id ? (
                  <a
                    href={`${WOO_BASE_URL}/wp-admin/post.php?post=${order.woo_id}&action=edit`}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid={`woo-link-${order.woo_id}`}
                    title={`Open Woo#${order.woo_number || order.woo_id} in WooCommerce admin`}
                    className="font-mono hover:underline underline-offset-2 inline-flex items-center gap-1"
                  >
                    Woo#{order.woo_number || order.woo_id}
                    <ExternalLink className="w-3 h-3 opacity-60" />
                  </a>
                ) : `Woo#${order.woo_number || order.id}`
              ) : "Direct"
            } />
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
            <Row k="PO Number" inputable>
              <input
                type="text"
                value={poNumber}
                onChange={(e) => setPoNumber(e.target.value)}
                data-testid="order-po-number-input"
                placeholder="e.g. PO12345"
                className="px-2 py-1 border border-stone-300 rounded-md text-sm focus:outline-none focus:border-stone-900 w-40 text-right"
              />
            </Row>
            <Row k="Payment" v={order.payment_status} />
            {order.date_paid && <Row k="Paid on" v={new Date(order.date_paid).toLocaleDateString("en-GB")} />}
          </Card>

          <Card title="Delivery Address">
            <AddressBlock addr={deliveryAddress} />
            {deliveryAddress?._source === "xero" && (
              <div className="mt-2 text-[10px] uppercase tracking-wider font-bold text-emerald-700 inline-flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Pulled from Xero
              </div>
            )}
          </Card>

          {(order.billing?.address_1 || order.billing?.city) && (
            <Card title="Billing Address">
              <AddressBlock addr={order.billing} />
            </Card>
          )}
        </div>
      </div>

      <ChangeCustomerModal
        open={changeCustomerOpen}
        order={order}
        onClose={() => setChangeCustomerOpen(false)}
        onSaved={(label, email) => handleAction("change_customer", { customer_label: label, customer_email: email })}
        onLinkXero={async (body) => {
          try {
            await api.post(`/orders/${orderId}/link-xero-contact`, body);
            await load();
          } catch (_) { /* non-fatal */ }
        }}
      />
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div className="bg-white border-2 border-stone-300 rounded-2xl p-5 shadow-sm">
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

// Renders a Woo billing/shipping address block. Skips empty fields so a
// legacy order with only a `company` value doesn't render a wall of dashes.
function AddressBlock({ addr }) {
  if (!addr || (!addr.address_1 && !addr.city && !addr.postcode && !addr.company && !addr.first_name)) {
    return (
      <div className="text-xs text-stone-500 italic" data-testid="address-block-empty">
        No address on file — edit the customer's Xero record or change the order's customer.
      </div>
    );
  }
  const name = [addr.first_name, addr.last_name].filter(Boolean).join(" ").trim();
  const cityLine = [addr.city, addr.state].filter(Boolean).join(", ");
  return (
    <div className="text-sm text-stone-900 leading-snug" data-testid="address-block">
      {name && <div className="font-semibold">{name}</div>}
      {addr.company && <div>{addr.company}</div>}
      {addr.address_1 && <div>{addr.address_1}</div>}
      {addr.address_2 && <div>{addr.address_2}</div>}
      {cityLine && <div>{cityLine}</div>}
      {addr.postcode && <div className="font-mono text-stone-700">{addr.postcode}</div>}
      {addr.country && addr.country !== "GB" && <div className="text-xs text-stone-500 uppercase tracking-wider mt-1">{addr.country}</div>}
      {addr.phone && <div className="text-xs text-stone-600 mt-1.5">☎ {addr.phone}</div>}
    </div>
  );
}

function LineItemRow({ li, onUpdate, onRemove }) {
  return (
    <div className="grid grid-cols-[100px_1fr_72px_96px_96px_auto] items-center gap-3 py-3" data-testid={`line-item-${li._key}`}>
      <input
        type="text"
        value={li.sku || ""}
        onChange={(e) => onUpdate(li._key, { sku: e.target.value })}
        placeholder="SKU"
        data-testid={`line-sku-${li._key}`}
        className="px-2 py-1 border border-stone-300 rounded-md text-[11px] font-mono text-stone-700 focus:outline-none focus:border-stone-900"
      />
      <input
        type="text"
        value={li.name || ""}
        onChange={(e) => onUpdate(li._key, { name: e.target.value })}
        placeholder="Product name"
        data-testid={`line-name-${li._key}`}
        className="px-2 py-1 border border-stone-300 rounded-md text-sm text-stone-900 focus:outline-none focus:border-stone-900"
      />
      <input
        type="number"
        min="1"
        value={li.quantity}
        onChange={(e) => onUpdate(li._key, { quantity: e.target.value })}
        data-testid={`line-qty-${li._key}`}
        className="px-2 py-1 border border-stone-300 rounded-md text-sm tabular-nums focus:outline-none focus:border-stone-900 text-center"
      />
      <div className="flex items-center gap-1">
        <span className="text-stone-400 text-xs">£</span>
        <input
          type="number"
          step="0.01"
          value={li.subtotal}
          onChange={(e) => onUpdate(li._key, { subtotal: e.target.value })}
          data-testid={`line-price-${li._key}`}
          className="w-full px-2 py-1 border border-stone-300 rounded-md text-sm tabular-nums focus:outline-none focus:border-stone-900"
        />
      </div>
      <div className="text-right text-sm font-semibold tabular-nums">
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

// Header row above LineItemRow grid so the columns are labelled.
function LineItemsHeader() {
  return (
    <div className="grid grid-cols-[100px_1fr_72px_96px_96px_auto] gap-3 px-0 pb-2 border-b border-stone-200 text-[10px] uppercase tracking-wider font-bold text-stone-500">
      <span>SKU</span><span>Name</span><span className="text-center">Qty</span><span>Price</span><span className="text-right">Subtotal</span><span></span>
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
        const { data } = await api.get("/woo/products/autocomplete", { params: { q, limit: 25 } });
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

  // Group variations under their parent product so admins see, e.g.:
  //   World Cup 2026
  //     ↳ Group Art Kit – Medium    £40
  //     ↳ Group Art Kit – Large     £50
  //     ↳ 1-2-1 Kit                 £15
  const grouped = (() => {
    const map = new Map();
    for (const p of results) {
      const key = p.is_variation ? `parent:${p.parent_id}` : `item:${p.id}`;
      const groupLabel = p.is_variation ? p.parent_name : p.name;
      if (!map.has(key)) map.set(key, { label: groupLabel, items: [] });
      map.get(key).items.push(p);
    }
    return Array.from(map.values());
  })();

  return (
    <div className="flex items-center gap-2" ref={wrapRef}>
      <div className="relative flex-1">
        <input
          type="text"
          value={q}
          onChange={(e) => { setQ(e.target.value); setSelected(null); }}
          onFocus={() => results.length && setOpen(true)}
          placeholder="Type a product name (variations & 1-2-1 kits included)…"
          data-testid="product-search-input"
          className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-900"
        />
        {open && results.length > 0 && (
          <div
            data-testid="product-autocomplete-dropdown"
            className="absolute left-0 right-0 top-full mt-1 max-h-72 overflow-y-auto z-20 bg-white border border-stone-200 rounded-lg shadow-lg"
          >
            {grouped.map((g, gi) => (
              <div key={gi}>
                {g.items.length > 1 && (
                  <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider font-bold text-stone-500 bg-stone-50 border-b border-stone-100">
                    {g.label}
                  </div>
                )}
                {g.items.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setSelected(p);
                      setQ(p.is_variation ? p.name : (p.name || ""));
                      setOpen(false);
                    }}
                    data-testid={`product-option-${p.id}`}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-stone-50 border-b border-stone-100 last:border-b-0 flex items-center gap-2"
                  >
                    {p.is_variation && <span className="text-stone-300 text-xs">↳</span>}
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-stone-900 leading-tight truncate">
                        {p.is_variation ? p.variant_label : p.name}
                        {p.downloadable && (
                          <span className="ml-2 inline-block px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider font-bold bg-sky-100 text-sky-800">PDF</span>
                        )}
                      </div>
                      <div className="text-[11px] text-stone-500 flex items-center gap-2">
                        {p.sku && <span className="font-mono">{p.sku}</span>}
                        <span className="tabular-nums">{formatGBP(p.price)}</span>
                        {p.stock_status && p.stock_status !== "instock" && (
                          <span className="text-rose-600 uppercase">{p.stock_status}</span>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        disabled={!selected && !q.trim()}
        onClick={() => {
          const product = selected || { name: q, price: "0.00", sku: "" };
          // For variations we want the friendlier "Parent – Variant" label on the line item.
          const lineName = product.is_variation ? product.name : product.name;
          onAdd({ ...product, name: lineName });
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

function ChangeCustomerModal({ open, order, onClose, onSaved, onLinkXero }) {
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [xeroContactId, setXeroContactId] = useState("");
  useEffect(() => {
    if (open && order) {
      setLabel(order.customer_label || "");
      setEmail(order.customer_email || "");
      setXeroContactId(order.xero_contact_id || "");
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
        <XeroContactPicker
          value={label}
          emailValue={email}
          onChange={(v) => { setLabel(v); setXeroContactId(""); }}
          onSelect={(c) => {
            setLabel(c.name || "");
            if (c.email) setEmail(c.email);
            setXeroContactId(c.contact_id);
          }}
          testid="change-customer-picker"
          placeholder="Search Xero customers…"
        />
        {xeroContactId && (
          <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700">
            <CheckCircle2 className="w-3 h-3" /> Linked to Xero
          </div>
        )}
        <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1 mt-3">Email</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="change-customer-email"
          className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-900" />
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm border border-stone-300 rounded-lg hover:bg-stone-50">Cancel</button>
          <button type="button" onClick={async () => {
              await onSaved(label.trim(), email.trim());
              if (xeroContactId) await onLinkXero?.({ xero_contact_id: xeroContactId, name: label.trim(), email: email.trim() });
              onClose();
            }}
            data-testid="change-customer-save"
            className="px-4 py-2 bg-stone-950 text-white text-xs font-bold uppercase tracking-wider rounded-lg hover:bg-stone-800">Save</button>
        </div>
      </div>
    </div>
  );
}
