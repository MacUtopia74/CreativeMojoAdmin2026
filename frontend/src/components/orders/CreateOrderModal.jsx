// CreateOrderModal — manual draft order entry. Mirrors the "Create Order"
// button from the legacy admin's main orders page. New rows start in the
// DRAFT tab; the admin opens the detail page and clicks "Mark as Active"
// in the Actions menu to promote them onto the Active tab.
//
// Minimal scope: just enough fields to seed the order. Full line-item +
// product-autocomplete editing happens on the detail page after creation.
import { useState } from "react";
import { X, Loader2, Plus, CheckCircle2 } from "lucide-react";
import api from "@/lib/api";
import XeroContactPicker from "@/components/orders/XeroContactPicker";

export default function CreateOrderModal({ open, onClose, onCreated }) {
  const [customer, setCustomer] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [city, setCity] = useState("");
  const [postcode, setPostcode] = useState("");
  const [country, setCountry] = useState("United Kingdom");
  const [xeroContactId, setXeroContactId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [shipping, setShipping] = useState("0.00");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  const reset = () => {
    setCustomer(""); setFirstName(""); setLastName("");
    setEmail(""); setPhone("");
    setAddress1(""); setAddress2(""); setCity(""); setPostcode("");
    setCountry("United Kingdom");
    setXeroContactId("");
    setDueDate(""); setShipping("0.00"); setError("");
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
        customer_phone: phone.trim() || undefined,
        first_name: firstName.trim() || undefined,
        last_name: lastName.trim() || undefined,
        billing: {
          first_name: firstName.trim() || undefined,
          last_name: lastName.trim() || undefined,
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
          address_1: address1.trim() || undefined,
          address_2: address2.trim() || undefined,
          city: city.trim() || undefined,
          postcode: postcode.trim() || undefined,
          country: country.trim() || undefined,
        },
        due_date: dueDate || undefined,
        shipping_total: parseFloat(shipping || 0),
        line_items: [],
      });

      // ─── Xero sync ───────────────────────────────────────────────
      // Three branches:
      //  1. User picked an existing Xero contact in the picker → just
      //     link it to the order (legacy behaviour).
      //  2. No picker selection but the form has enough detail to push
      //     to Xero → create a Xero contact with name + email + phone +
      //     address, then link the order to it.
      //  3. Otherwise → leave the order unlinked; the Reconcile flow
      //     will pick it up later.
      let linkedXeroId = xeroContactId;
      if (xeroContactId) {
        try {
          await api.post(`/orders/${data.id}/link-xero-contact`, {
            xero_contact_id: xeroContactId,
            name: customer.trim(),
            email: email.trim() || undefined,
          });
        } catch (_) { /* non-fatal */ }
      } else if (email.trim() || phone.trim() || address1.trim()) {
        // Create a fresh Xero contact carrying every field the user
        // typed — keeps the Order Detail page and Xero in lock-step.
        try {
          const { data: contact } = await api.post("/xero/contacts/create", {
            name: customer.trim(),
            email: email.trim() || undefined,
            phone: phone.trim() || undefined,
            first_name: firstName.trim() || undefined,
            last_name: lastName.trim() || undefined,
            address_1: address1.trim() || undefined,
            address_2: address2.trim() || undefined,
            city: city.trim() || undefined,
            postcode: postcode.trim() || undefined,
            country: country.trim() || undefined,
          });
          if (contact?.contact_id) {
            linkedXeroId = contact.contact_id;
            await api.post(`/orders/${data.id}/link-xero-contact`, {
              xero_contact_id: contact.contact_id,
              name: customer.trim(),
              email: email.trim() || undefined,
            });
          }
        } catch (e) {
          // Don't block — order is already saved locally. Surface a
          // soft warning so the user knows Xero needs attention.
          // eslint-disable-next-line no-console
          console.warn("Xero contact sync skipped:", e?.response?.data?.detail || e?.message);
        }
      }

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
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[92vh] flex flex-col">
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

        <div className="px-6 py-5 space-y-4 overflow-y-auto">
          {error && (
            <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-800">{error}</div>
          )}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">Customer name / company</label>
            <XeroContactPicker
              value={customer}
              emailValue={email}
              onChange={(v) => { setCustomer(v); setXeroContactId(""); }}
              onSelect={(c) => {
                setCustomer(c.name || "");
                if (c.email) setEmail(c.email);
                setXeroContactId(c.contact_id);
              }}
              placeholder="e.g. The Haven Care Home"
              testid="create-order-customer-picker"
              autoFocus
            />
            {xeroContactId && (
              <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700">
                <CheckCircle2 className="w-3 h-3" /> Linked to Xero contact
              </div>
            )}
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
              <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">First name</label>
              <input
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                data-testid="create-order-first-name"
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-900"
              />
            </div>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">Last name</label>
              <input
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                data-testid="create-order-last-name"
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-900"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">Phone</label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              data-testid="create-order-phone"
              placeholder="e.g. 01392 123456"
              className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-900"
            />
          </div>
          <div className="border-t border-stone-200 pt-4">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">
              Billing address (optional)
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">Address line 1</label>
                <input
                  value={address1}
                  onChange={(e) => setAddress1(e.target.value)}
                  data-testid="create-order-address-1"
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-900"
                />
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">Address line 2</label>
                <input
                  value={address2}
                  onChange={(e) => setAddress2(e.target.value)}
                  data-testid="create-order-address-2"
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-900"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">Town / city</label>
                  <input
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    data-testid="create-order-city"
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">Postcode</label>
                  <input
                    value={postcode}
                    onChange={(e) => setPostcode(e.target.value.toUpperCase())}
                    data-testid="create-order-postcode"
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm font-mono uppercase focus:outline-none focus:border-stone-900"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-stone-500 mb-1">Country</label>
                <input
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  data-testid="create-order-country"
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-900"
                />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 border-t border-stone-200 pt-4">
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
