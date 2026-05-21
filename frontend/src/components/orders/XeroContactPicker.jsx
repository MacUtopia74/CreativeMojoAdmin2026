// Reusable Xero customer picker — debounced autocomplete that pulls live
// from /api/xero/contacts as the admin types.
//
// Behaviour:
//   • Shows matching Xero contacts in a dropdown (with email).
//   • Lets the admin keep typing a brand-new name and offers a
//     "Create '<typed>' in Xero" row when no exact-name match exists.
//   • Calls onSelect({contact_id, name, email, created}) on pick.
//   • Calls onChange(text) on raw input changes so parent components
//     can keep their existing free-text state in sync.
//
// Used in:
//   • CreateOrderModal — customer/email fields
//   • ChangeCustomerModal on OrderDetailPage
//   • OrdersReconciliationPage — inline picker per row
import { useEffect, useRef, useState } from "react";
import { Search, Loader2, UserPlus, Check } from "lucide-react";
import api from "@/lib/api";

export default function XeroContactPicker({
  value = "",
  emailValue = "",
  onChange,
  onSelect,
  placeholder = "Type a customer name…",
  testid = "xero-contact-picker",
  showCreateOption = true,
  autoFocus = false,
}) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const wrapRef = useRef(null);
  const debounceRef = useRef(null);

  // Debounced search
  useEffect(() => {
    if (!value || value.trim().length < 2) {
      setResults([]); setLoading(false);
      return;
    }
    setLoading(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const { data } = await api.get("/xero/contacts", { params: { search: value.trim() } });
        setResults(data?.contacts || []);
      } catch (e) {
        setResults([]);
      } finally { setLoading(false); }
    }, 250);
    return () => debounceRef.current && clearTimeout(debounceRef.current);
  }, [value]);

  // Close on outside click
  useEffect(() => {
    const onDoc = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const exactNameHit = results.find((c) => (c.name || "").toLowerCase() === value.trim().toLowerCase());

  const handleSelect = (contact) => {
    setOpen(false);
    onSelect?.({
      contact_id: contact.contact_id,
      name: contact.name,
      email: contact.email,
      created: false,
    });
  };

  const handleCreate = async () => {
    if (!value.trim()) return;
    setCreating(true);
    try {
      const { data } = await api.post("/xero/contacts/create", {
        name: value.trim(),
        email: (emailValue || "").trim() || undefined,
      });
      setOpen(false);
      onSelect?.({
        contact_id: data.contact_id,
        name: data.name,
        email: data.email,
        created: true,
      });
    } catch (e) {
      alert(e?.response?.data?.detail || "Could not create Xero contact.");
    } finally { setCreating(false); }
  };

  return (
    <div ref={wrapRef} className="relative" data-testid={testid}>
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400 pointer-events-none" />
        <input
          type="text"
          value={value}
          onChange={(e) => { onChange?.(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          data-testid={`${testid}-input`}
          className="w-full pl-9 pr-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:border-stone-900"
        />
        {loading && (
          <Loader2 className="w-3.5 h-3.5 absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 animate-spin" />
        )}
      </div>

      {open && value.trim().length >= 2 && (
        <div className="absolute z-30 mt-1 left-0 right-0 bg-white border border-stone-200 rounded-xl shadow-lg max-h-72 overflow-y-auto"
             data-testid={`${testid}-menu`}>
          {results.length === 0 && !loading && (
            <div className="px-3 py-2 text-xs text-stone-500">No Xero contacts found for "{value}".</div>
          )}
          {results.map((c) => (
            <button
              key={c.contact_id}
              type="button"
              onClick={() => handleSelect(c)}
              data-testid={`${testid}-option-${c.contact_id}`}
              className="w-full px-3 py-2 text-left hover:bg-stone-50 flex items-start gap-2 border-b border-stone-100 last:border-b-0"
            >
              <Check className="w-3.5 h-3.5 text-emerald-600 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-stone-900 truncate">{c.name}</div>
                {c.email && <div className="text-[11px] text-stone-500 truncate">{c.email}</div>}
              </div>
            </button>
          ))}
          {showCreateOption && !exactNameHit && (
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating}
              data-testid={`${testid}-create`}
              className="w-full px-3 py-2 text-left hover:bg-sky-50 border-t border-stone-200 flex items-center gap-2 text-sky-700 disabled:opacity-50"
            >
              {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
              <span className="text-sm font-semibold">Create "{value.trim()}" in Xero</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
