// CreateOrderModal — manual draft order entry. Mirrors the "Create Order"
// button from the legacy admin's main orders page. New rows start in the
// DRAFT tab; the admin opens the detail page and clicks "Mark as Active"
// in the Actions menu to promote them onto the Active tab.
//
// Minimal scope: just enough fields to seed the order. Full line-item +
// product-autocomplete editing happens on the detail page after creation.
import { useState } from "react";
import { X, Loader2, Plus } from "lucide-react";
import api from "@/lib/api";

export default function CreateOrderModal({ open, onClose, onCreated }) {
  const [customer, setCustomer] = useState("");
  const [email, setEmail] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [shipping, setShipping] = useState("0.00");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  const reset = () => {
    setCustomer(""); setEmail(""); setDueDate("");
    setShipping("0.00"); setError("");
  };
  const handleClose = () => { reset(); onClose && onClose(); };

  const handleCreate = async () => {
    setError("");
    if (!customer.trim()) { setError("Customer name is required."); return; }
    setSubmitting(true);
    try {
      const { data } = await api.post("/orders", {
        customer_label: customer.trim(),
        customer_email: email.trim() || undefined,
        due_date: dueDate || undefined,
        shipping_total: parseFloat(shipping || 0),
        line_items: [],
      });
      reset();
      onCreated && onCreated(data.id);
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not create order.");
    } finally { setSubmitting(false); }
  };

  return (
    <div
      data-testid="create-order-modal"
      onClick={handleClose}
      className="fixed inset-0 z-[55] bg-stone-950/50 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">CRM · ORDERS</div>
            <h2 className="text-xl font-display font-black text-stone-950 flex items-center gap-2">
              <Plus className="w-5 h-5" /> Create manual order
            </h2>
          </div>
          <button type="button" onClick={handleClose} aria-label="Close" className="text-stone-400 hover:text-stone-900">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-800">{error}</div>
          )}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">Customer name / company</label>
            <input
              type="text"
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              placeholder="e.g. The Haven Care Home"
              data-testid="create-order-customer"
              autoFocus
              className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-900"
            />
          </div>
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">Email (optional)</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="create-order-email"
              className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-900"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">Due date (optional)</label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                data-testid="create-order-due-date"
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-900"
              />
            </div>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">Shipping (£)</label>
              <input
                type="number"
                step="0.01"
                value={shipping}
                onChange={(e) => setShipping(e.target.value)}
                data-testid="create-order-shipping"
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm tabular-nums focus:outline-none focus:border-stone-900"
              />
            </div>
          </div>
          <p className="text-[11px] text-stone-500 leading-relaxed">
            Add products to this order on the next screen. The new order will land in the
            <span className="font-bold"> Draft </span> tab — use the Actions menu to mark it Active when ready.
          </p>
        </div>

        <div className="px-6 py-4 border-t border-stone-200 flex justify-end gap-2">
          <button type="button" onClick={handleClose} className="px-3 py-2 text-sm border border-stone-300 rounded-lg hover:bg-stone-50">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={submitting || !customer.trim()}
            data-testid="create-order-submit"
            className="px-4 py-2 bg-stone-950 text-white text-xs font-bold uppercase tracking-wider rounded-lg hover:bg-stone-800 disabled:opacity-50 flex items-center gap-2"
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Create draft
          </button>
        </div>
      </div>
    </div>
  );
}
