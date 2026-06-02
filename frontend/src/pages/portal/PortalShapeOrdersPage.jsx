// Franchisee portal — Shape Orders.
//
// Simple product grid + cart sidebar. The product list is curated by
// HQ from /admin/shape-orders. The franchisee picks 2/4/6… DIFFERENT
// sets (each shipping box holds two distinct sets) and clicks
// Finalise — the backend creates a £0 "Shape Order" directly in the
// HQ Orders queue, using the franchisee's saved contact details.
import { useEffect, useState, useCallback, useMemo } from "react";
import {
  ShoppingBag, Loader2, AlertCircle, CheckCircle2, X, ImageOff,
  Plus, Minus, Send,
} from "lucide-react";
import api from "@/lib/api";
import PortalPageHeading from "@/components/portal/PortalPageHeading";

const BOX_NOTE = "Each shipping box fits TWO DIFFERENT sets. Duplicates aren't allowed — pick from the list below in pairs (2, 4, 6…).";

export default function PortalShapeOrdersPage() {
  const [access, setAccess] = useState(null);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(() => new Set()); // woo_id set
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [acc, prods] = await Promise.all([
        api.get("/portal/shape-orders/access").catch((e) => ({ data: { allowed: false, reason: e?.response?.data?.detail || "Unavailable" } })),
        api.get("/portal/shape-orders/products").catch(() => ({ data: { items: [] } })),
      ]);
      setAccess(acc.data);
      setProducts(prods.data.items || []);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = (woo_id) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(woo_id)) n.delete(woo_id);
      else n.add(woo_id);
      return n;
    });

  const selectedArr = useMemo(() => Array.from(selected), [selected]);
  const isEven = selectedArr.length > 0 && selectedArr.length % 2 === 0;
  const canSubmit = isEven && !submitting;
  const boxes = Math.floor(selectedArr.length / 2);

  const submit = async () => {
    setSubmitting(true); setError("");
    try {
      const { data } = await api.post("/portal/shape-orders", {
        woo_ids: selectedArr,
      });
      setConfirmation(data);
      setSelected(new Set());
    } catch (e) {
      setError(e?.response?.data?.detail || "Couldn't submit your order.");
    } finally { setSubmitting(false); }
  };

  if (loading || !access) {
    return (
      <div className="flex items-center justify-center min-h-[200px] text-stone-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
      </div>
    );
  }

  if (!access.allowed) {
    return (
      <div className="space-y-5" data-testid="portal-shape-orders-locked">
        <PortalPageHeading
          eyebrow="Shape orders"
          icon={ShoppingBag}
          title="Shape Orders"
          subtitle="Order your Die-Cut Shape sets directly from HQ."
        />
        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-6 py-8 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-amber-100 mb-4">
            <AlertCircle className="w-7 h-7 text-amber-700" />
          </div>
          <h2 className="font-display text-2xl font-black text-stone-950 mb-2">Shape Orders isn't enabled</h2>
          <p className="text-sm text-stone-700 max-w-md mx-auto">
            {access.reason || "Speak to HQ to enable this module on your subscription."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="portal-shape-orders-page">
      <PortalPageHeading
        eyebrow="Shape orders"
        icon={ShoppingBag}
        title="Shape Orders"
        subtitle="Order your Die-Cut Shape sets directly from HQ. Free to franchisees — shipping handled by HQ."
      />

      <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-900 flex items-start gap-2">
        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <div>
          <strong>Before you order, please review the shapes you have and utilise as many as you can.</strong>
          <div className="mt-1">{BOX_NOTE}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">
        {/* Product grid */}
        <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
          <div className="px-5 py-3 border-b border-stone-200 text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">
            Available sets ({products.length})
          </div>
          {products.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-stone-500">
              No shape sets available yet. HQ is curating the catalogue.
            </div>
          ) : (
            <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 p-4">
              {products.map((p) => {
                const checked = selected.has(p.woo_id);
                return (
                  <li
                    key={p.woo_id}
                    data-testid={`shape-card-${p.woo_id}`}
                    className={`border rounded-xl overflow-hidden bg-white hover:shadow-md transition cursor-pointer ${checked ? "border-stone-950 ring-2 ring-stone-950" : "border-stone-200"}`}
                    onClick={() => toggle(p.woo_id)}
                  >
                    <div className="aspect-[4/3] bg-stone-100 flex items-center justify-center overflow-hidden">
                      {p.image_url ? (
                        <img src={p.image_url} alt={p.name} className="w-full h-full object-contain" />
                      ) : (
                        <ImageOff className="w-8 h-8 text-stone-300" />
                      )}
                    </div>
                    <div className="px-3 py-2 border-t border-stone-100">
                      <div className="text-xs text-stone-500 font-mono uppercase tracking-wider">{p.sku || `#${p.woo_id}`}</div>
                      <div className="text-sm font-semibold text-stone-900 mt-0.5 leading-tight">{p.name}</div>
                      <button
                        type="button"
                        data-testid={`shape-toggle-${p.woo_id}`}
                        onClick={(e) => { e.stopPropagation(); toggle(p.woo_id); }}
                        className={`mt-2 w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded-lg ${
                          checked ? "bg-stone-950 text-[#dddd16]" : "bg-stone-100 hover:bg-stone-200 text-stone-800"
                        }`}
                      >
                        {checked ? <><Minus className="w-3 h-3" /> Remove</> : <><Plus className="w-3 h-3" /> Add to order</>}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Cart sidebar */}
        <aside className="bg-white border border-stone-200 rounded-2xl overflow-hidden h-fit lg:sticky lg:top-6" data-testid="shape-cart">
          <div className="px-4 py-3 bg-stone-950 text-[#dddd16] text-[10px] uppercase tracking-[0.3em] font-bold flex items-center justify-between">
            Your selection
            <span data-testid="shape-cart-count" className="bg-[#dddd16] text-stone-950 px-2 py-0.5 rounded">
              {selected.size} {selected.size === 1 ? "set" : "sets"}
            </span>
          </div>
          {selected.size === 0 ? (
            <div className="px-5 py-8 text-center text-xs text-stone-500">
              No sets picked yet. Tap a card on the left to add it.
            </div>
          ) : (
            <ul className="divide-y divide-stone-100" data-testid="shape-cart-list">
              {selectedArr.map((wid) => {
                const p = products.find((x) => x.woo_id === wid);
                if (!p) return null;
                return (
                  <li key={wid} className="px-3 py-2 flex items-center gap-2">
                    <div className="w-10 h-10 bg-stone-100 rounded shrink-0 overflow-hidden flex items-center justify-center">
                      {p.image_url ? <img src={p.image_url} alt="" className="w-full h-full object-contain" /> : <ImageOff className="w-4 h-4 text-stone-300" />}
                    </div>
                    <div className="flex-1 min-w-0 text-xs">
                      <div className="font-semibold text-stone-900 truncate">{p.name}</div>
                      <div className="text-stone-500 font-mono">{p.sku || `#${wid}`}</div>
                    </div>
                    <button
                      onClick={() => toggle(wid)}
                      className="text-stone-400 hover:text-red-600 p-1"
                      data-testid={`shape-cart-remove-${wid}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="px-4 py-3 border-t border-stone-200 space-y-2">
            <div className="flex items-center justify-between text-xs text-stone-600">
              <span>Boxes (2 sets each)</span>
              <span className="font-bold text-stone-900" data-testid="shape-cart-boxes">{boxes}</span>
            </div>
            <div className="flex items-center justify-between text-xs text-stone-600">
              <span>Order total</span>
              <span className="font-bold text-stone-900">£0.00</span>
            </div>
            {selected.size > 0 && !isEven && (
              <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 flex items-start gap-1">
                <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                <span>Pick one more set — boxes ship as pairs.</span>
              </div>
            )}
            {error && (
              <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5 flex items-start gap-1" data-testid="shape-error">
                <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <button
              onClick={submit}
              disabled={!canSubmit}
              data-testid="shape-submit-btn"
              className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-lg disabled:opacity-50"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              Finalise order
            </button>
          </div>
        </aside>
      </div>

      {confirmation && (
        <div onClick={() => setConfirmation(null)} className="fixed inset-0 z-50 bg-stone-950/40 backdrop-blur-sm flex items-center justify-center p-4" data-testid="shape-confirm-modal">
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
            <div className="px-6 py-6 text-center">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-emerald-100 mb-3">
                <CheckCircle2 className="w-7 h-7 text-emerald-700" />
              </div>
              <h3 className="font-display text-2xl font-black text-stone-950">Order placed!</h3>
              <p className="text-sm text-stone-600 mt-2">
                HQ has received your shape order
                {confirmation.display_order_id ? <> — reference <strong>#{confirmation.display_order_id}</strong></> : null}.
                You'll get a dispatch update when your {confirmation.boxes} box{confirmation.boxes === 1 ? "" : "es"} ship.
              </p>
              <button
                onClick={() => setConfirmation(null)}
                className="mt-5 px-5 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-[#dddd16] rounded-lg"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
