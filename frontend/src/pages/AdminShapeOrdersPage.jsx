// Admin > Shape Order Catalogue.
//
// Curates the list of Woo products that franchisees see on
// /portal/shape-orders. Pick a product by name (searches the Woo
// mirror), preview the cached image, drop into the list. Existing
// rows can be reordered (up/down), toggled active/inactive, or
// removed.
import { useEffect, useState, useCallback } from "react";
import {
  ShoppingBag, Plus, Trash2, Search, Loader2, ArrowUp, ArrowDown,
  X as XIcon, ImageOff, AlertCircle, CheckCircle2, RefreshCw,
} from "lucide-react";
import api from "@/lib/api";

export default function AdminShapeOrdersPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const { data } = await api.get("/admin/shape-orders/products");
      setItems(data.items || []);
    } catch (e) {
      setError(e?.response?.data?.detail || "Couldn't load the catalogue.");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const refreshImages = async () => {
    if (!window.confirm("Refresh every catalogue card's image from Woo? Takes ~10 seconds.")) return;
    setRefreshing(true); setError("");
    try {
      const { data } = await api.post("/admin/shape-orders/products/refresh-all-images");
      await load();
      window.alert(`Updated ${data.updated} card${data.updated === 1 ? "" : "s"}${data.errors?.length ? ` (${data.errors.length} failed)` : ""}.`);
    } catch (e) {
      setError(e?.response?.data?.detail || "Image refresh failed.");
    } finally { setRefreshing(false); }
  };

  const reorder = async (idx, delta) => {
    const next = [...items];
    const newIdx = idx + delta;
    if (newIdx < 0 || newIdx >= next.length) return;
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    setItems(next); // optimistic
    try {
      await api.post("/admin/shape-orders/products/reorder", {
        order: next.map((p) => p.woo_id),
      });
    } catch (e) {
      setError(e?.response?.data?.detail || "Reorder failed.");
      load();
    }
  };

  const toggleActive = async (p) => {
    const next = !p.active;
    setItems((arr) => arr.map((x) => x.woo_id === p.woo_id ? { ...x, active: next } : x));
    try {
      await api.patch(`/admin/shape-orders/products/${p.woo_id}`, { active: next });
    } catch (e) {
      setError(e?.response?.data?.detail || "Update failed.");
      load();
    }
  };

  const setKind = async (p, kind) => {
    if ((p.product_kind || "shape_set") === kind) return;
    setItems((arr) => arr.map((x) => x.woo_id === p.woo_id ? { ...x, product_kind: kind } : x));
    try {
      await api.patch(`/admin/shape-orders/products/${p.woo_id}`, { product_kind: kind });
    } catch (e) {
      setError(e?.response?.data?.detail || "Couldn't change product kind.");
      load();
    }
  };

  const remove = async (p) => {
    if (!window.confirm(`Remove "${p.name}" from the catalogue?\n\nFranchisees won't be able to order this set any more, but existing orders are unaffected.`)) return;
    try {
      await api.delete(`/admin/shape-orders/products/${p.woo_id}`);
      setItems((arr) => arr.filter((x) => x.woo_id !== p.woo_id));
    } catch (e) {
      setError(e?.response?.data?.detail || "Delete failed.");
    }
  };

  return (
    <div className="min-h-screen" data-testid="admin-shape-orders-page">
      <div className="h-16 border-b border-stone-200 bg-white flex items-center px-8 sticky top-0 z-10">
        <div className="flex items-baseline gap-3 flex-1">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">Admin</div>
          <h1 className="font-display text-xl text-stone-950">Franchise Store</h1>
          <span className="text-xs text-stone-500">{items.length} product{items.length === 1 ? "" : "s"}</span>
        </div>
        <button
          onClick={refreshImages}
          disabled={refreshing}
          data-testid="shape-catalogue-refresh-images"
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-lg disabled:opacity-50"
        >
          {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh images
        </button>
        <button
          onClick={() => setPickerOpen(true)}
          data-testid="shape-catalogue-add"
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-lg"
        >
          <Plus className="w-3.5 h-3.5" /> Add product
        </button>
      </div>

      <div className="p-6 space-y-4">
        <div className="bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 text-xs text-stone-700 flex items-start gap-2">
          <ShoppingBag className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div>
            These are the products that appear on the franchisee <strong>Franchise Store</strong> page.
            Each row is either a <strong>Shape Set</strong> (free, ships in pairs) or <strong>Signage &amp; Clothing</strong> (priced from Woo, ordered by quantity).
            Adding a product copies its name, SKU and image from the Woo mirror — keeping the page in sync without you having to retype anything.
            Toggle Active to temporarily hide a product without losing its position.
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl px-4 py-2 text-xs flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5" /> {error}
          </div>
        )}

        <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center min-h-[200px] text-stone-500">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-stone-500">
              No products yet. Click <strong>Add product</strong> to pick something from your Woo catalogue.
            </div>
          ) : (
            <ul className="divide-y divide-stone-100" data-testid="shape-catalogue-list">
              {items.map((p, idx) => (
                <li key={p.woo_id} className="px-4 py-3 flex items-center gap-3 flex-wrap" data-testid={`shape-catalogue-row-${p.woo_id}`}>
                  <div className="flex flex-col">
                    <button onClick={() => reorder(idx, -1)} disabled={idx === 0} className="p-0.5 text-stone-400 hover:text-stone-950 disabled:opacity-25" data-testid={`shape-catalogue-up-${p.woo_id}`}>
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => reorder(idx, 1)} disabled={idx === items.length - 1} className="p-0.5 text-stone-400 hover:text-stone-950 disabled:opacity-25" data-testid={`shape-catalogue-down-${p.woo_id}`}>
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="w-14 h-14 bg-stone-100 rounded overflow-hidden flex items-center justify-center shrink-0">
                    {p.image_url ? <img src={p.image_url} alt="" className="w-full h-full object-contain" /> : <ImageOff className="w-5 h-5 text-stone-300" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-stone-900 truncate">{p.name}</div>
                    <div className="text-xs text-stone-500 font-mono">{p.sku || `#${p.woo_id}`}{(p.product_kind === "signage_clothing" && p.price) ? <> · <span className="text-stone-700 font-bold">£{Number(p.price).toFixed(2)}</span></> : null}</div>
                  </div>
                  <select
                    value={p.product_kind || "shape_set"}
                    onChange={(e) => setKind(p, e.target.value)}
                    data-testid={`shape-catalogue-kind-${p.woo_id}`}
                    className="text-[11px] font-semibold border border-stone-300 rounded-lg px-2 py-1 bg-white text-stone-800 focus:outline-none focus:border-stone-950"
                    title="Shape Set: free, ships in pairs. Signage & Clothing: priced at Woo, no pair rule."
                  >
                    <option value="shape_set">Shape Set</option>
                    <option value="signage_clothing">Signage &amp; Clothing</option>
                  </select>
                  <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer" data-testid={`shape-catalogue-active-${p.woo_id}`}>
                    <input type="checkbox" checked={!!p.active} onChange={() => toggleActive(p)} className="w-4 h-4 rounded border-stone-300 text-stone-900 focus:ring-stone-900" />
                    {p.active ? <span className="text-emerald-700 font-bold">Active</span> : <span className="text-stone-500">Hidden</span>}
                  </label>
                  <button onClick={() => remove(p)} data-testid={`shape-catalogue-remove-${p.woo_id}`} className="text-stone-400 hover:text-red-600 p-2">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <ProductPickerModal open={pickerOpen} onClose={() => setPickerOpen(false)} onAdded={(p) => { setItems((arr) => [...arr, p]); setPickerOpen(false); }} />
    </div>
  );
}

function ProductPickerModal({ open, onClose, onAdded }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(null);
  const [err, setErr] = useState("");
  // Default kind for new picks — flip to "signage_clothing" when adding
  // a wave of t-shirts / stickers etc.
  const [kind, setKind] = useState("shape_set");

  useEffect(() => {
    if (!open) { setQ(""); setResults([]); setErr(""); return; }
  }, [open]);

  useEffect(() => {
    if (!open || !q.trim()) { setResults([]); return; }
    const t = setTimeout(async () => {
      setBusy(true); setErr("");
      try {
        const { data } = await api.get(`/admin/shape-orders/woo-products?q=${encodeURIComponent(q.trim())}`);
        setResults(data.items || []);
      } catch (e) {
        setErr(e?.response?.data?.detail || "Search failed.");
      } finally { setBusy(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [q, open]);

  const add = async (wp) => {
    setAdding(wp.woo_id); setErr("");
    try {
      const { data } = await api.post("/admin/shape-orders/products", { woo_id: wp.woo_id, product_kind: kind });
      onAdded(data);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't add product.");
    } finally { setAdding(null); }
  };

  if (!open) return null;
  return (
    <div onClick={onClose} className="fixed inset-0 z-50 bg-stone-950/40 backdrop-blur-sm flex items-center justify-center p-4" data-testid="shape-picker-modal">
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[88vh] flex flex-col overflow-hidden">
        <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700 flex items-center gap-1.5">
            <Plus className="w-3 h-3" /> Add a product
          </div>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg" data-testid="shape-picker-close">
            <XIcon className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-stone-700">
            <span>Add as:</span>
            <div className="inline-flex rounded-lg overflow-hidden border border-stone-300" data-testid="shape-picker-kind">
              <button
                type="button"
                onClick={() => setKind("shape_set")}
                data-testid="shape-picker-kind-shape"
                className={`px-3 py-1.5 text-[11px] ${kind === "shape_set" ? "bg-stone-950 text-[#dddd16]" : "bg-white text-stone-700 hover:bg-stone-50"}`}
              >Shape Set</button>
              <button
                type="button"
                onClick={() => setKind("signage_clothing")}
                data-testid="shape-picker-kind-signage"
                className={`px-3 py-1.5 text-[11px] border-l border-stone-300 ${kind === "signage_clothing" ? "bg-stone-950 text-[#dddd16]" : "bg-white text-stone-700 hover:bg-stone-50"}`}
              >Signage &amp; Clothing</button>
            </div>
          </div>
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name or SKU…"
              data-testid="shape-picker-search"
              className="w-full pl-9 pr-3 py-2.5 border border-stone-300 rounded-xl text-sm focus:outline-none focus:border-stone-950"
              autoFocus
            />
          </div>
          {err && <div className="text-xs text-red-700 mt-2 flex items-center gap-1.5"><AlertCircle className="w-3 h-3" /> {err}</div>}
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {busy ? (
            <div className="flex items-center justify-center py-10 text-stone-500"><Loader2 className="w-5 h-5 animate-spin" /></div>
          ) : results.length === 0 ? (
            <div className="text-center text-xs text-stone-500 py-10">
              {q.trim() ? "No matches." : "Type a product name above to search your Woo catalogue."}
            </div>
          ) : (
            <ul className="divide-y divide-stone-100 border border-stone-200 rounded-xl overflow-hidden">
              {results.map((wp) => (
                <li key={wp.woo_id} className="px-3 py-2 flex items-center gap-3" data-testid={`shape-picker-row-${wp.woo_id}`}>
                  <div className="w-12 h-12 bg-stone-100 rounded overflow-hidden flex items-center justify-center shrink-0">
                    {(wp.image_url || wp.images?.[0]?.src) ? (
                      <img src={wp.image_url || wp.images?.[0]?.src} alt="" className="w-full h-full object-contain" />
                    ) : <ImageOff className="w-5 h-5 text-stone-300" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-stone-900 truncate">{wp.name}</div>
                    <div className="text-xs text-stone-500 font-mono">{wp.sku || `#${wp.woo_id}`}</div>
                  </div>
                  <button
                    onClick={() => add(wp)}
                    disabled={adding === wp.woo_id}
                    data-testid={`shape-picker-add-${wp.woo_id}`}
                    className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-[#dddd16] rounded-lg flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {adding === wp.woo_id ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
