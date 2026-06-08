// Franchisee portal — Franchise Store.
//
// Two sections:
//   1. Shape Sets — free, ships in pairs (2/4/6…), no duplicates.
//   2. Signage & Clothing — quantities allowed, Woo prices honoured,
//      no pair rule.
//
// The cart sidebar reflects both sections and totals only the
// signage/clothing line items. The submit endpoint accepts a richer
// body so the two halves are validated separately on the server.
import { useEffect, useState, useCallback, useMemo } from "react";
import {
  ShoppingBag, Loader2, AlertCircle, CheckCircle2, X, ImageOff,
  Plus, Minus, Send,
} from "lucide-react";
import api from "@/lib/api";
import PortalPageHeading from "@/components/portal/PortalPageHeading";

const BOX_NOTE = "Each shipping box fits TWO DIFFERENT shape sets. Duplicates aren't allowed — pick the shape sets below in pairs (2, 4, 6…).";

const fmt = (n) => `£${(Number(n) || 0).toFixed(2)}`;

export default function PortalShapeOrdersPage() {
  const [access, setAccess] = useState(null);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  // shape sets: set of woo_id; extras: map of woo_id → qty
  const [shapeSel, setShapeSel] = useState(() => new Set());
  const [extraSel, setExtraSel] = useState(() => ({}));
  // Per-item personalisation options keyed by woo_id:
  //   { [woo_id]: { text, size, colour } }
  const [extraOpts, setExtraOpts] = useState(() => ({}));
  const [chartZoomUrl, setChartZoomUrl] = useState("");
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

  const shapeSets = useMemo(
    () => products.filter((p) => (p.product_kind || "shape_set") === "shape_set"),
    [products],
  );
  const signageItems = useMemo(
    () => products.filter((p) => p.product_kind === "signage_clothing"),
    [products],
  );

  const toggleShape = (woo_id) =>
    setShapeSel((s) => {
      const n = new Set(s);
      if (n.has(woo_id)) n.delete(woo_id);
      else n.add(woo_id);
      return n;
    });

  const setExtraQty = (woo_id, qty) =>
    setExtraSel((prev) => {
      const next = { ...prev };
      if (qty <= 0) delete next[woo_id];
      else next[woo_id] = qty;
      return next;
    });
  const adjustExtra = (woo_id, delta) =>
    setExtraQty(woo_id, Math.max(0, (extraSel[woo_id] || 0) + delta));

  const setOption = (woo_id, key, value) =>
    setExtraOpts((prev) => ({ ...prev, [woo_id]: { ...(prev[woo_id] || {}), [key]: value } }));

  const shapeIds = useMemo(() => Array.from(shapeSel), [shapeSel]);
  const isEven = shapeIds.length % 2 === 0;
  const boxes = Math.floor(shapeIds.length / 2);

  const extrasArr = useMemo(
    () =>
      Object.entries(extraSel).map(([wid, qty]) => {
        const p = products.find((x) => x.woo_id === Number(wid));
        return p ? { ...p, quantity: qty, options: extraOpts[Number(wid)] || {} } : null;
      }).filter(Boolean),
    [extraSel, extraOpts, products],
  );

  // A signage line is incomplete until every "enabled" personalisation
  // field has a value. We use this to grey out Finalise and to inline
  // a per-card warning.
  const missingOptions = useMemo(() => {
    const missing = {};
    for (const e of extrasArr) {
      const pers = e.personalisation || {};
      const opts = e.options || {};
      const out = [];
      if (pers?.text_input?.enabled && !opts.text) out.push("text");
      if (pers?.size?.enabled && !opts.size) out.push("size");
      if (pers?.colour?.enabled && !opts.colour) out.push("colour");
      if (out.length) missing[e.woo_id] = out;
    }
    return missing;
  }, [extrasArr]);

  const extrasTotal = useMemo(
    () => extrasArr.reduce((sum, e) => sum + (Number(e.price) || 0) * e.quantity, 0),
    [extrasArr],
  );

  const hasAnything = shapeIds.length > 0 || extrasArr.length > 0;
  const shapesOk = shapeIds.length === 0 || isEven;
  const optionsOk = Object.keys(missingOptions).length === 0;
  const canSubmit = hasAnything && shapesOk && optionsOk && !submitting;

  const submit = async () => {
    setSubmitting(true); setError("");
    try {
      const { data } = await api.post("/portal/shape-orders", {
        shape_set_woo_ids: shapeIds,
        extra_items: extrasArr.map((e) => ({
          woo_id: e.woo_id,
          quantity: e.quantity,
          options: e.options || {},
        })),
      });
      setConfirmation(data);
      setShapeSel(new Set());
      setExtraSel({});
      setExtraOpts({});
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
          eyebrow="Franchise store"
          icon={ShoppingBag}
          title="Franchise Store"
          subtitle="Order your Die-Cut Shape sets and branded signage / clothing directly from HQ."
        />
        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-6 py-8 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-amber-100 mb-4">
            <AlertCircle className="w-7 h-7 text-amber-700" />
          </div>
          <h2 className="font-display text-2xl font-black text-stone-950 mb-2">Franchise Store isn&apos;t enabled</h2>
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
        eyebrow="Franchise store"
        icon={ShoppingBag}
        title="Franchise Store"
        subtitle="Shape sets are free and ship in pairs. Signage & clothing items are charged at the Woo price."
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">
        {/* Sections */}
        <div className="space-y-5">
          {/* Shape sets section */}
          <section className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid="portal-shape-sets-section">
            <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between flex-wrap gap-2">
              <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">
                Shape Sets ({shapeSets.length})
              </div>
              <div className="text-[11px] text-stone-500">Free · ships in pairs</div>
            </div>
            <div className="bg-amber-50 border-b border-amber-200 px-5 py-2 text-[11px] text-amber-900 flex items-start gap-2">
              <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
              <div>
                <strong>Before you order, please review the shapes you have and utilise as many as you can.</strong>
                <div className="mt-0.5">{BOX_NOTE}</div>
              </div>
            </div>
            {shapeSets.length === 0 ? (
              <div className="px-6 py-10 text-center text-sm text-stone-500">
                No shape sets available yet.
              </div>
            ) : (
              <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 p-4">
                {shapeSets.map((p) => {
                  const checked = shapeSel.has(p.woo_id);
                  return (
                    <li
                      key={p.woo_id}
                      data-testid={`shape-card-${p.woo_id}`}
                      className={`border rounded-xl overflow-hidden bg-white hover:shadow-md transition cursor-pointer ${checked ? "border-stone-950 ring-2 ring-stone-950" : "border-stone-200"}`}
                      onClick={() => toggleShape(p.woo_id)}
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
                          onClick={(e) => { e.stopPropagation(); toggleShape(p.woo_id); }}
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
          </section>

          {/* Signage & Clothing section */}
          {signageItems.length > 0 && (
            <section className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid="portal-signage-section">
              <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between flex-wrap gap-2">
                <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">
                  Signage &amp; Clothing ({signageItems.length})
                </div>
                <div className="text-[11px] text-stone-500">Charged at Woo prices · order any quantity</div>
              </div>
              <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 p-4">
                {signageItems.map((p) => {
                  const qty = extraSel[p.woo_id] || 0;
                  const opts = extraOpts[p.woo_id] || {};
                  const pers = p.personalisation || {};
                  const missing = missingOptions[p.woo_id] || [];
                  return (
                    <li
                      key={p.woo_id}
                      data-testid={`signage-card-${p.woo_id}`}
                      className={`border rounded-xl overflow-hidden bg-white hover:shadow-md transition ${qty > 0 ? "border-stone-950 ring-2 ring-stone-950" : "border-stone-200"}`}
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
                        <div className="text-xs text-stone-700 mt-1 font-bold">{fmt(p.price)}</div>
                        {qty === 0 ? (
                          <button
                            type="button"
                            data-testid={`signage-add-${p.woo_id}`}
                            onClick={() => adjustExtra(p.woo_id, 1)}
                            className="mt-2 w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-800"
                          >
                            <Plus className="w-3 h-3" /> Add to order
                          </button>
                        ) : (
                          <>
                            <div className="mt-2 flex items-center justify-between gap-1" data-testid={`signage-qty-${p.woo_id}`}>
                              <button
                                type="button"
                                onClick={() => adjustExtra(p.woo_id, -1)}
                                data-testid={`signage-dec-${p.woo_id}`}
                                className="w-9 h-9 inline-flex items-center justify-center bg-stone-100 hover:bg-stone-200 text-stone-800 rounded-lg"
                              >
                                <Minus className="w-3.5 h-3.5" />
                              </button>
                              <input
                                type="number"
                                min="0"
                                value={qty}
                                data-testid={`signage-qty-input-${p.woo_id}`}
                                onChange={(e) => setExtraQty(p.woo_id, Math.max(0, parseInt(e.target.value || "0", 10)))}
                                className="flex-1 text-center text-sm font-bold border border-stone-200 rounded-lg py-1.5 focus:outline-none focus:border-stone-950 tabular-nums"
                              />
                              <button
                                type="button"
                                onClick={() => adjustExtra(p.woo_id, 1)}
                                data-testid={`signage-inc-${p.woo_id}`}
                                className="w-9 h-9 inline-flex items-center justify-center bg-stone-950 hover:bg-stone-800 text-[#dddd16] rounded-lg"
                              >
                                <Plus className="w-3.5 h-3.5" />
                              </button>
                            </div>
                            {/* Personalisation controls — only render the
                                fields that are enabled on this product. */}
                            {pers?.text_input?.enabled && (
                              <div className="mt-2">
                                <label className="text-[10px] uppercase tracking-wider font-bold text-stone-600">
                                  {pers.text_input.label || "Personalisation text"}
                                </label>
                                <input
                                  type="text"
                                  value={opts.text || ""}
                                  maxLength={pers.text_input.max_length || 100}
                                  onChange={(e) => setOption(p.woo_id, "text", e.target.value)}
                                  data-testid={`signage-text-${p.woo_id}`}
                                  placeholder="Type your personalisation…"
                                  className="w-full mt-0.5 px-2 py-1.5 text-sm border border-stone-300 rounded-lg focus:outline-none focus:border-stone-950"
                                />
                              </div>
                            )}
                            {pers?.size?.enabled && (
                              <div className="mt-2">
                                <label className="text-[10px] uppercase tracking-wider font-bold text-stone-600">Size</label>
                                <select
                                  value={opts.size || ""}
                                  onChange={(e) => setOption(p.woo_id, "size", e.target.value)}
                                  data-testid={`signage-size-${p.woo_id}`}
                                  className="w-full mt-0.5 px-2 py-1.5 text-sm border border-stone-300 rounded-lg bg-white focus:outline-none focus:border-stone-950"
                                >
                                  <option value="">Pick a size…</option>
                                  {(pers.size.options || ["S","M","L","XL","XXL"]).map((s) => (
                                    <option key={s} value={s}>{s}</option>
                                  ))}
                                </select>
                              </div>
                            )}
                            {pers?.colour?.enabled && (
                              <div className="mt-2">
                                <div className="flex items-center justify-between">
                                  <label className="text-[10px] uppercase tracking-wider font-bold text-stone-600">Colour</label>
                                  {pers.colour.chart_image_url && (
                                    <button
                                      type="button"
                                      onClick={() => setChartZoomUrl(pers.colour.chart_image_url)}
                                      data-testid={`signage-chart-${p.woo_id}`}
                                      className="text-[10px] underline text-stone-700 hover:text-stone-950"
                                    >
                                      View colour chart
                                    </button>
                                  )}
                                </div>
                                <select
                                  value={opts.colour || ""}
                                  onChange={(e) => setOption(p.woo_id, "colour", e.target.value)}
                                  data-testid={`signage-colour-${p.woo_id}`}
                                  className="w-full mt-0.5 px-2 py-1.5 text-sm border border-stone-300 rounded-lg bg-white focus:outline-none focus:border-stone-950"
                                >
                                  <option value="">Pick a colour…</option>
                                  {(pers.colour.options || []).map((c) => (
                                    <option key={c} value={c}>{c}</option>
                                  ))}
                                </select>
                              </div>
                            )}
                            {missing.length > 0 && (
                              <div className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 flex items-start gap-1" data-testid={`signage-missing-${p.woo_id}`}>
                                <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                                <span>Pick the {missing.join(" + ")} before submitting.</span>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>

        {/* Cart sidebar */}
        <aside className="bg-white border border-stone-200 rounded-2xl overflow-hidden h-fit lg:sticky lg:top-6" data-testid="shape-cart">
          <div className="px-4 py-3 bg-stone-950 text-[#dddd16] text-[10px] uppercase tracking-[0.3em] font-bold flex items-center justify-between">
            Your selection
            <span data-testid="shape-cart-count" className="bg-[#dddd16] text-stone-950 px-2 py-0.5 rounded">
              {shapeIds.length + extrasArr.length}
            </span>
          </div>
          {!hasAnything ? (
            <div className="px-5 py-8 text-center text-xs text-stone-500">
              Nothing picked yet. Add shape sets or signage / clothing from the left.
            </div>
          ) : (
            <ul className="divide-y divide-stone-100" data-testid="shape-cart-list">
              {shapeIds.map((wid) => {
                const p = products.find((x) => x.woo_id === wid);
                if (!p) return null;
                return (
                  <li key={`s-${wid}`} className="px-3 py-2 flex items-center gap-2">
                    <div className="w-10 h-10 bg-stone-100 rounded shrink-0 overflow-hidden flex items-center justify-center">
                      {p.image_url ? <img src={p.image_url} alt="" className="w-full h-full object-contain" /> : <ImageOff className="w-4 h-4 text-stone-300" />}
                    </div>
                    <div className="flex-1 min-w-0 text-xs">
                      <div className="font-semibold text-stone-900 truncate">{p.name}</div>
                      <div className="text-stone-500 font-mono">{p.sku || `#${wid}`} · Free</div>
                    </div>
                    <button
                      onClick={() => toggleShape(wid)}
                      className="text-stone-400 hover:text-red-600 p-1"
                      data-testid={`shape-cart-remove-${wid}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </li>
                );
              })}
              {extrasArr.map((p) => (
                <li key={`e-${p.woo_id}`} className="px-3 py-2 flex items-center gap-2">
                  <div className="w-10 h-10 bg-stone-100 rounded shrink-0 overflow-hidden flex items-center justify-center">
                    {p.image_url ? <img src={p.image_url} alt="" className="w-full h-full object-contain" /> : <ImageOff className="w-4 h-4 text-stone-300" />}
                  </div>
                  <div className="flex-1 min-w-0 text-xs">
                    <div className="font-semibold text-stone-900 truncate">{p.name}</div>
                    <div className="text-stone-500">{p.quantity} × {fmt(p.price)} = <strong className="text-stone-800">{fmt((Number(p.price)||0) * p.quantity)}</strong></div>
                  </div>
                  <button
                    onClick={() => setExtraQty(p.woo_id, 0)}
                    className="text-stone-400 hover:text-red-600 p-1"
                    data-testid={`signage-cart-remove-${p.woo_id}`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="px-4 py-3 border-t border-stone-200 space-y-2">
            <div className="flex items-center justify-between text-xs text-stone-600">
              <span>Shape boxes (2 sets each)</span>
              <span className="font-bold text-stone-900" data-testid="shape-cart-boxes">{boxes}</span>
            </div>
            <div className="flex items-center justify-between text-xs text-stone-600">
              <span>Signage &amp; clothing total</span>
              <span className="font-bold text-stone-900" data-testid="shape-cart-extras-total">{fmt(extrasTotal)}</span>
            </div>
            <div className="flex items-center justify-between text-sm border-t border-stone-200 pt-2 text-stone-900">
              <span className="font-bold">Order total</span>
              <span className="font-display text-lg" data-testid="shape-cart-total">{fmt(extrasTotal)}</span>
            </div>
            {shapeIds.length > 0 && !isEven && (
              <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 flex items-start gap-1">
                <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                <span>Pick one more shape set — boxes ship as pairs.</span>
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

      {chartZoomUrl && (
        <div onClick={() => setChartZoomUrl("")} className="fixed inset-0 z-50 bg-stone-950/70 backdrop-blur-sm flex items-center justify-center p-4" data-testid="colour-chart-modal">
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full overflow-hidden">
            <div className="px-5 py-3 flex items-center justify-between border-b border-stone-200">
              <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">Colour chart</div>
              <button onClick={() => setChartZoomUrl("")} className="text-stone-400 hover:text-stone-900 p-1" data-testid="colour-chart-close">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 bg-stone-50">
              <img src={chartZoomUrl} alt="Colour chart" className="w-full max-h-[80vh] object-contain" />
            </div>
          </div>
        </div>
      )}

      {confirmation && (
        <div onClick={() => setConfirmation(null)} className="fixed inset-0 z-50 bg-stone-950/40 backdrop-blur-sm flex items-center justify-center p-4" data-testid="shape-confirm-modal">
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
            <div className="px-6 py-6 text-center">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-emerald-100 mb-3">
                <CheckCircle2 className="w-7 h-7 text-emerald-700" />
              </div>
              <h3 className="font-display text-2xl font-black text-stone-950">Order placed!</h3>
              <p className="text-sm text-stone-600 mt-2">
                HQ has received your store order
                {confirmation.display_order_id ? <> — reference <strong>#{confirmation.display_order_id}</strong></> : null}.
                {confirmation.total > 0 ? <> Order total <strong>{fmt(confirmation.total)}</strong>.</> : null}
                {confirmation.boxes > 0 ? <> You&apos;ll get a dispatch update when your {confirmation.boxes} box{confirmation.boxes === 1 ? "" : "es"} ship.</> : null}
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
