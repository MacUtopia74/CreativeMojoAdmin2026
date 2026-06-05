// Portal Invoicing section — Phase 5 (per-franchisee invoicing).
//
// Compact single-component clone of Sandra's Invoices: tabbed UI with
// Invoices / Clients / Settings. Each franchisee sees ONLY their own
// data — scoping enforced server-side by the JWT's franchisee_id, so
// the frontend just hits /api/portal/invoices/* with the user's portal
// token (axios interceptor injects it automatically).
//
// Phase 1 deliberately skips CSV bank reconciliation — that ships in
// Phase 2. Send-by-email is also out of scope (Paul confirmed they'll
// download the PDF and use their own mail tool).
import { useCallback, useEffect, useMemo, useState } from "react";
import api from "@/lib/api";
import { toast } from "sonner";
import {
  ChevronUp, ChevronDown, FileText, Plus, Loader2, X, Save, Download,
  Trash2, Edit3, Users, Settings, ArrowLeft, Banknote, Upload, Link2, Unlink, CheckCircle2,
} from "lucide-react";

const STATUS_COLORS = {
  draft: "bg-stone-200 text-stone-700",
  sent:  "bg-blue-100 text-blue-700",
  paid:  "bg-emerald-100 text-emerald-700",
  overdue: "bg-amber-100 text-amber-700",
};

const moneyFmt = (v) =>
  Number(v || 0).toLocaleString("en-GB", { style: "currency", currency: "GBP" });

function StatusBadge({ status }) {
  return (
    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${STATUS_COLORS[status] || "bg-stone-100 text-stone-700"}`}>
      {status || "draft"}
    </span>
  );
}

// ----------------------------- Invoices tab
function InvoicesTab({ onCreate, onEdit, onView, refreshKey }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data }, { data: s }] = await Promise.all([
        api.get("/portal/invoices"),
        api.get("/portal/invoices/stats"),
      ]);
      setItems(data);
      setStats(s);
    } catch (e) {
      console.error("[PortalInvoices] load failed", e);
      toast.error(e?.response?.data?.detail || "Couldn't load invoices");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-stone-500">{items.length} invoice{items.length === 1 ? "" : "s"}</div>
        <button onClick={onCreate} data-testid="portal-invoice-new"
          className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md inline-flex items-center gap-1.5">
          <Plus className="w-3 h-3" /> New invoice
        </button>
      </div>
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {["draft", "sent", "paid", "overdue"].map((k) => (
            <div key={k} className="bg-stone-50 border border-stone-200 rounded-lg p-2.5">
              <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500">{k}</div>
              <div className="text-lg font-bold text-stone-950 tabular-nums">{moneyFmt(stats.totals[k])}</div>
              <div className="text-[10px] text-stone-500">{stats.counts[k]} invoice{stats.counts[k] === 1 ? "" : "s"}</div>
            </div>
          ))}
        </div>
      )}
      {loading ? (
        <div className="text-xs text-stone-400 flex items-center gap-1.5 py-4">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading…
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-8 text-stone-500 text-sm border border-dashed border-stone-300 rounded-lg">
          No invoices yet. Click <strong>New invoice</strong> to get started.
        </div>
      ) : (
        <div className="border border-stone-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-[10px] uppercase tracking-wider text-stone-600">
              <tr>
                <th className="px-3 py-2 text-left">Number</th>
                <th className="px-3 py-2 text-left">Client</th>
                <th className="px-3 py-2 text-left">Issue date</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((inv) => (
                <tr key={inv.id} className="border-t border-stone-100 hover:bg-stone-50" data-testid={`portal-invoice-row-${inv.id}`}>
                  <td className="px-3 py-2 font-mono text-xs">{inv.invoice_number}</td>
                  <td className="px-3 py-2 truncate max-w-[200px]">{inv.client_name}</td>
                  <td className="px-3 py-2 tabular-nums">{inv.issue_date}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium">{moneyFmt(inv.total)}</td>
                  <td className="px-3 py-2"><StatusBadge status={inv.status} /></td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button onClick={() => onView(inv)} title="View" className="p-1 hover:bg-stone-100 rounded"><FileText className="w-4 h-4 text-stone-600" /></button>
                    <button onClick={() => onEdit(inv)} title="Edit" className="p-1 hover:bg-stone-100 rounded"><Edit3 className="w-4 h-4 text-stone-600" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ----------------------------- Clients tab
function ClientsTab({ refreshKey, onChanged }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);  // null = none, "new" = create, "<id>" = edit existing
  const [draft, setDraft] = useState({ name: "", email: "", phone: "", address: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/portal/invoices/clients");
      setItems(data);
    } catch (e) {
      console.error("[PortalClients] load failed", e);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  const startNew = () => { setDraft({ name: "", email: "", phone: "", address: "", city: "", country: "" }); setEditing("new"); };
  const startEdit = (c) => { setDraft({ ...c }); setEditing(c.id); };
  const save = async () => {
    if (!draft.name?.trim()) { toast.error("Name is required"); return; }
    try {
      if (editing === "new") await api.post("/portal/invoices/clients", draft);
      else await api.put(`/portal/invoices/clients/${editing}`, draft);
      toast.success("Saved");
      setEditing(null);
      load();
      onChanged?.();
    } catch (e) { toast.error(e?.response?.data?.detail || "Couldn't save"); }
  };
  const remove = async (c) => {
    if (!window.confirm(`Delete ${c.name}?`)) return;
    try { await api.delete(`/portal/invoices/clients/${c.id}`); toast.success("Deleted"); load(); }
    catch (e) { toast.error(e?.response?.data?.detail || "Couldn't delete"); }
  };

  if (editing !== null) {
    return (
      <div className="space-y-3">
        <button onClick={() => setEditing(null)} className="text-xs text-stone-600 hover:text-stone-950 inline-flex items-center gap-1">
          <ArrowLeft className="w-3 h-3" /> Back to clients
        </button>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Name *" value={draft.name} onChange={(v) => setDraft((d) => ({ ...d, name: v }))} testId="client-name" />
          <Field label="Email" value={draft.email} onChange={(v) => setDraft((d) => ({ ...d, email: v }))} testId="client-email" />
          <Field label="Secondary email" value={draft.email2} onChange={(v) => setDraft((d) => ({ ...d, email2: v }))} testId="client-email2" />
          <Field label="Phone" value={draft.phone} onChange={(v) => setDraft((d) => ({ ...d, phone: v }))} testId="client-phone" />
          <Field label="Address" value={draft.address} onChange={(v) => setDraft((d) => ({ ...d, address: v }))} testId="client-address" wide />
          <Field label="City" value={draft.city} onChange={(v) => setDraft((d) => ({ ...d, city: v }))} testId="client-city" />
          <Field label="Country" value={draft.country} onChange={(v) => setDraft((d) => ({ ...d, country: v }))} testId="client-country" />
        </div>
        <button onClick={save} data-testid="client-save"
          className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md inline-flex items-center gap-1.5">
          <Save className="w-3 h-3" /> Save client
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-stone-500">{items.length} client{items.length === 1 ? "" : "s"}</div>
        <button onClick={startNew} data-testid="portal-client-new"
          className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md inline-flex items-center gap-1.5">
          <Plus className="w-3 h-3" /> New client
        </button>
      </div>
      {loading ? <Loader2 className="w-3 h-3 animate-spin" /> :
        items.length === 0 ? (
          <div className="text-center py-8 text-stone-500 text-sm border border-dashed border-stone-300 rounded-lg">
            No clients yet — add one to start invoicing.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {items.map((c) => (
              <li key={c.id} className="flex items-center justify-between p-2.5 border border-stone-200 rounded-lg hover:bg-stone-50">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-stone-900 truncate">{c.name}</div>
                  <div className="text-xs text-stone-500 truncate">{c.email || c.phone || "—"}</div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => startEdit(c)} className="p-1.5 hover:bg-stone-200 rounded"><Edit3 className="w-3.5 h-3.5 text-stone-700" /></button>
                  <button onClick={() => remove(c)} className="p-1.5 hover:bg-red-100 rounded"><Trash2 className="w-3.5 h-3.5 text-red-600" /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

// ----------------------------- Settings tab
function SettingsTab() {
  const [settings, setSettings] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/portal/invoices/settings/me");
        setSettings(data); setDraft(data);
      } catch (e) { console.error("[PortalSettings] load failed", e); }
    })();
  }, []);

  if (!settings || !draft) return <Loader2 className="w-3 h-3 animate-spin" />;

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.put("/portal/invoices/settings/me", draft);
      setSettings(data); setDraft(data);
      toast.success("Settings saved");
    } catch (e) { toast.error(e?.response?.data?.detail || "Couldn't save"); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      <div className="text-xs text-stone-600">
        These details appear on every invoice you create. Bank details are blank by default —
        fill them in so your clients know how to pay you.
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Business name" value={draft.business_name} onChange={(v) => setDraft((d) => ({ ...d, business_name: v }))} testId="settings-business-name" />
        <Field label="Business email" value={draft.business_email} onChange={(v) => setDraft((d) => ({ ...d, business_email: v }))} testId="settings-business-email" />
        <Field label="Business phone" value={draft.business_phone} onChange={(v) => setDraft((d) => ({ ...d, business_phone: v }))} testId="settings-business-phone" />
        <Field label="Address line 1" value={draft.business_address_line1} onChange={(v) => setDraft((d) => ({ ...d, business_address_line1: v }))} testId="settings-addr-1" />
        <Field label="Address line 2" value={draft.business_address_line2} onChange={(v) => setDraft((d) => ({ ...d, business_address_line2: v }))} testId="settings-addr-2" />
      </div>
      <div className="pt-3 mt-3 border-t border-stone-200">
        <div className="flex items-center gap-2 mb-2">
          <Banknote className="w-3.5 h-3.5 text-stone-500" />
          <div className="text-[10px] uppercase tracking-wider font-bold text-stone-700">Bank details (for payment instructions)</div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Payment instructions" value={draft.bank_payment_info} onChange={(v) => setDraft((d) => ({ ...d, bank_payment_info: v }))} testId="settings-bank-info" wide />
          <Field label="Account name" value={draft.bank_account_name} onChange={(v) => setDraft((d) => ({ ...d, bank_account_name: v }))} testId="settings-bank-name" />
          <Field label="Sort code & account number" value={draft.bank_details} onChange={(v) => setDraft((d) => ({ ...d, bank_details: v }))} placeholder="Sort Code: 00-00-00 Account No. 00000000" testId="settings-bank-details" wide />
        </div>
      </div>
      <button onClick={save} disabled={saving} data-testid="settings-save"
        className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md inline-flex items-center gap-1.5">
        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Save settings
      </button>
    </div>
  );
}

// ----------------------------- Bank reconciliation tab (Phase 2)
// Per-franchisee CSV upload + match credits to outstanding invoices.
// Strictly manual — no TrueLayer/Open Banking — Paul confirmed that's
// out of scope for franchisees.
function BankTab({ refreshKey, onChanged }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState("unreconciled");  // all | unreconciled | reconciled
  const [invoices, setInvoices] = useState([]);
  const [pickerForTxn, setPickerForTxn] = useState(null);  // txn id whose picker is open

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: txs }, { data: invs }] = await Promise.all([
        api.get("/portal/invoices/bank/transactions", { params: { only_credits: true } }),
        api.get("/portal/invoices"),
      ]);
      setRows(txs);
      setInvoices(invs.filter((i) => !i.deleted && i.status !== "paid"));
    } catch (e) {
      console.error("[Bank] load failed", e);
      toast.error(e?.response?.data?.detail || "Couldn't load bank transactions");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  const onUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const { data } = await api.post("/portal/invoices/bank/upload", fd);
      toast.success(`Imported ${data.inserted} new · skipped ${data.skipped_duplicates} duplicate${data.skipped_duplicates === 1 ? "" : "s"}`);
      load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't import CSV");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const link = async (txnId, invoiceId) => {
    try {
      await api.post(`/portal/invoices/bank/transactions/${txnId}/link`, { invoice_id: invoiceId });
      toast.success("Linked");
      setPickerForTxn(null);
      load();
      onChanged?.();
    } catch (e) { toast.error(e?.response?.data?.detail || "Couldn't link"); }
  };
  const unlink = async (txnId, invoiceId) => {
    try {
      await api.delete(`/portal/invoices/bank/transactions/${txnId}/link/${invoiceId}`);
      toast.success("Unlinked");
      load();
      onChanged?.();
    } catch (e) { toast.error(e?.response?.data?.detail || "Couldn't unlink"); }
  };
  const removeTxn = async (txnId) => {
    if (!window.confirm("Remove this transaction from the reconciliation list? (Doesn't affect your bank.)")) return;
    try {
      await api.delete(`/portal/invoices/bank/transactions/${txnId}`);
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || "Couldn't delete"); }
  };

  const visible = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "reconciled") return rows.filter((r) => (r.linked_invoice_ids || []).length > 0);
    return rows.filter((r) => (r.linked_invoice_ids || []).length === 0);
  }, [rows, filter]);

  return (
    <div className="space-y-4">
      <div className="bg-stone-50 border border-stone-200 rounded-lg p-3 text-xs text-stone-700">
        <strong>How it works:</strong> Export a CSV of your bank transactions
        (Date · Description · Amount, or a similar layout — most UK banks support
        this). Upload it here and we'll list the incoming payments. Click "Match"
        to link a payment to one of your outstanding invoices; the invoice will
        automatically be marked <em>Paid</em> once the full amount is matched.
        Nothing is sent to your bank — this is reference-only.
      </div>

      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex items-center gap-1">
          {[
            { id: "unreconciled", label: "Unmatched" },
            { id: "reconciled",   label: "Matched" },
            { id: "all",          label: "All credits" },
          ].map((t) => (
            <button key={t.id} onClick={() => setFilter(t.id)} data-testid={`bank-filter-${t.id}`}
              className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded ${
                filter === t.id ? "bg-stone-950 text-white" : "bg-stone-100 text-stone-700 hover:bg-stone-200"
              }`}>{t.label}</button>
          ))}
        </div>
        <label className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md inline-flex items-center gap-1.5 cursor-pointer">
          {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />} Upload CSV
          <input type="file" accept=".csv,text/csv" onChange={onUpload} className="hidden" disabled={uploading} data-testid="bank-csv-upload" />
        </label>
      </div>

      {loading ? (
        <div className="text-xs text-stone-400 flex items-center gap-1.5 py-4">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading…
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-8 text-stone-500 text-sm border border-dashed border-stone-300 rounded-lg">
          {rows.length === 0 ? (
            <>No bank transactions yet. <strong>Upload a CSV</strong> from your bank to start matching.</>
          ) : (
            <>Nothing to show in this view.</>
          )}
        </div>
      ) : (
        <div className="border border-stone-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-[10px] uppercase tracking-wider text-stone-600">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Description</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-left">Match</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((tx) => {
                const linked = tx.linked_invoice_ids || [];
                const linkedInvs = linked.map((id) => invoices.find((i) => i.id === id)).filter(Boolean);
                return (
                  <tr key={tx.id} className="border-t border-stone-100 hover:bg-stone-50" data-testid={`bank-row-${tx.id}`}>
                    <td className="px-3 py-2 tabular-nums text-xs">{tx.date}</td>
                    <td className="px-3 py-2 text-xs truncate max-w-[280px]">{tx.description}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium text-emerald-700">{moneyFmt(tx.amount)}</td>
                    <td className="px-3 py-2 text-xs">
                      {linked.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {linkedInvs.length > 0 ? linkedInvs.map((inv) => (
                            <span key={inv.id} className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-800 px-1.5 py-0.5 rounded font-mono text-[10px]">
                              <CheckCircle2 className="w-3 h-3" /> {inv.invoice_number}
                              <button onClick={() => unlink(tx.id, inv.id)} className="hover:bg-emerald-100 rounded p-0.5" title="Unlink">
                                <Unlink className="w-3 h-3" />
                              </button>
                            </span>
                          )) : <span className="text-stone-400">Linked ({linked.length})</span>}
                        </div>
                      ) : pickerForTxn === tx.id ? (
                        <select autoFocus onChange={(e) => e.target.value && link(tx.id, e.target.value)} onBlur={() => setPickerForTxn(null)}
                          data-testid={`bank-picker-${tx.id}`}
                          className="px-2 py-1 text-xs border border-stone-300 rounded bg-white">
                          <option value="">— Pick an invoice —</option>
                          {invoices.map((inv) => (
                            <option key={inv.id} value={inv.id}>
                              {inv.invoice_number} · {inv.client_name} · {moneyFmt(inv.total)}
                            </option>
                          ))}
                        </select>
                      ) : tx.suggested_invoice ? (
                        <button onClick={() => link(tx.id, tx.suggested_invoice.id)} data-testid={`bank-match-${tx.id}`}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-amber-100 hover:bg-amber-200 text-amber-900 rounded">
                          <Link2 className="w-3 h-3" />
                          Match {tx.suggested_invoice.invoice_number}
                        </button>
                      ) : (
                        <button onClick={() => setPickerForTxn(tx.id)} data-testid={`bank-pick-${tx.id}`}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-200 hover:bg-stone-300 text-stone-800 rounded">
                          <Link2 className="w-3 h-3" /> Pick…
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => removeTxn(tx.id)} title="Remove" className="p-1 hover:bg-red-100 rounded">
                        <Trash2 className="w-3.5 h-3.5 text-red-600" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, placeholder, testId, wide }) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <label className="text-[10px] uppercase tracking-wider font-bold text-stone-500 block mb-1">{label}</label>
      <input type="text" value={value || ""} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} data-testid={testId}
        className="w-full px-3 py-2 text-sm border border-stone-300 rounded-md bg-white focus:outline-none focus:border-stone-900" />
    </div>
  );
}

// ----------------------------- Editor view (create/edit one invoice)
function InvoiceEditor({ invoice, onClose, onSaved }) {
  const isNew = !invoice?.id;
  const [draft, setDraft] = useState(() => invoice || null);
  const [clients, setClients] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: cs } = await api.get("/portal/invoices/clients");
      setClients(cs);
      if (isNew && !draft) {
        const today = new Date().toISOString().slice(0, 10);
        const dueDate = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
        const { data: nn } = await api.get("/portal/invoices/next-number");
        setDraft({
          client_id: "", client_name: "", client_email: "", client_address: "", client_phone: "",
          invoice_number: nn.next_number,
          issue_date: today, due_date: dueDate,
          line_items: [{ description: "", quantity: 1, unit_price: 0, amount: 0 }],
          tax_rate: 0, discount_rate: 0, notes: "", payment_terms: "Net 14 Days", status: "draft",
        });
      }
    })();
  }, [isNew, draft]);

  const totals = useMemo(() => {
    if (!draft?.line_items) return { subtotal: 0, tax: 0, discount: 0, total: 0 };
    const subtotal = draft.line_items.reduce((s, li) => s + Number(li.amount || 0), 0);
    const discount = subtotal * (Number(draft.discount_rate || 0) / 100);
    const tax = (subtotal - discount) * (Number(draft.tax_rate || 0) / 100);
    return { subtotal, tax, discount, total: subtotal - discount + tax };
  }, [draft]);

  if (!draft) return <Loader2 className="w-3 h-3 animate-spin" />;

  const updateLine = (i, field, v) => {
    const items = [...draft.line_items];
    items[i] = { ...items[i], [field]: v };
    if (field === "quantity" || field === "unit_price") {
      items[i].amount = Number(items[i].quantity || 0) * Number(items[i].unit_price || 0);
    }
    setDraft((d) => ({ ...d, line_items: items }));
  };
  const addLine = () => setDraft((d) => ({ ...d, line_items: [...d.line_items, { description: "", quantity: 1, unit_price: 0, amount: 0 }] }));
  const removeLine = (i) => setDraft((d) => ({ ...d, line_items: d.line_items.filter((_, j) => j !== i) }));
  const pickClient = (id) => {
    const c = clients.find((x) => x.id === id);
    if (!c) return;
    setDraft((d) => ({ ...d, client_id: c.id, client_name: c.name, client_email: c.email || "", client_email2: c.email2 || "", client_phone: c.phone || "", client_address: c.address || "" }));
  };

  const save = async () => {
    if (!draft.client_id) { toast.error("Pick a client"); return; }
    if (!draft.line_items?.length) { toast.error("Add at least one line item"); return; }
    setSaving(true);
    try {
      const payload = { ...draft, ...totals, tax_amount: totals.tax, discount_amount: totals.discount };
      const saved = isNew
        ? (await api.post("/portal/invoices", payload)).data
        : (await api.put(`/portal/invoices/${draft.id}`, payload)).data;
      toast.success(isNew ? "Invoice created" : "Invoice updated");
      onSaved?.(saved);
    } catch (e) { toast.error(e?.response?.data?.detail || "Couldn't save invoice"); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button onClick={onClose} className="text-xs text-stone-600 hover:text-stone-950 inline-flex items-center gap-1">
          <ArrowLeft className="w-3 h-3" /> Back to invoices
        </button>
        <div className="text-xs text-stone-500 font-mono">{draft.invoice_number}</div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="text-[10px] uppercase tracking-wider font-bold text-stone-500 block mb-1">Client *</label>
          <select value={draft.client_id} onChange={(e) => pickClient(e.target.value)} data-testid="invoice-client-select"
            className="w-full px-3 py-2 text-sm border border-stone-300 rounded-md bg-white">
            <option value="">— Pick a client —</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <Field label="Status" value={draft.status} onChange={(v) => setDraft((d) => ({ ...d, status: v }))} testId="invoice-status" />
        <Field label="Issue date" value={draft.issue_date} onChange={(v) => setDraft((d) => ({ ...d, issue_date: v }))} testId="invoice-issue" />
        <Field label="Due date" value={draft.due_date} onChange={(v) => setDraft((d) => ({ ...d, due_date: v }))} testId="invoice-due" />
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wider font-bold text-stone-600 mb-1.5">Line items</div>
        <table className="w-full text-sm">
          <thead className="bg-stone-50 text-[10px] uppercase tracking-wider text-stone-600">
            <tr><th className="px-2 py-1.5 text-left">Description</th><th className="px-2 py-1.5">Qty</th><th className="px-2 py-1.5">Unit</th><th className="px-2 py-1.5 text-right">Amount</th><th></th></tr>
          </thead>
          <tbody>
            {draft.line_items.map((li, i) => (
              <tr key={`${i}-${li.description || ""}`} className="border-t border-stone-100">
                <td className="px-1 py-1"><input value={li.description} onChange={(e) => updateLine(i, "description", e.target.value)} className="w-full px-2 py-1 text-sm border border-stone-200 rounded" /></td>
                <td className="px-1 py-1"><input type="number" value={li.quantity} onChange={(e) => updateLine(i, "quantity", e.target.value)} className="w-16 px-2 py-1 text-sm border border-stone-200 rounded tabular-nums" /></td>
                <td className="px-1 py-1"><input type="number" value={li.unit_price} onChange={(e) => updateLine(i, "unit_price", e.target.value)} className="w-20 px-2 py-1 text-sm border border-stone-200 rounded tabular-nums" /></td>
                <td className="px-1 py-1 text-right tabular-nums">{moneyFmt(li.amount)}</td>
                <td className="px-1 py-1"><button onClick={() => removeLine(i)} className="p-1 hover:bg-red-100 rounded"><X className="w-3 h-3 text-red-600" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button onClick={addLine} className="mt-1 text-xs text-stone-600 hover:text-stone-950 inline-flex items-center gap-1">
          <Plus className="w-3 h-3" /> Add line
        </button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Field label="Tax %" value={draft.tax_rate} onChange={(v) => setDraft((d) => ({ ...d, tax_rate: Number(v) }))} testId="invoice-tax" />
        <Field label="Discount %" value={draft.discount_rate} onChange={(v) => setDraft((d) => ({ ...d, discount_rate: Number(v) }))} testId="invoice-discount" />
        <div className="col-span-2 text-right">
          <div className="text-xs text-stone-600">Subtotal: <span className="tabular-nums">{moneyFmt(totals.subtotal)}</span></div>
          {totals.discount > 0 && <div className="text-xs text-stone-600">Discount: <span className="tabular-nums">−{moneyFmt(totals.discount)}</span></div>}
          {totals.tax > 0 && <div className="text-xs text-stone-600">Tax: <span className="tabular-nums">{moneyFmt(totals.tax)}</span></div>}
          <div className="text-base font-bold text-stone-950 tabular-nums">Total: {moneyFmt(totals.total)}</div>
        </div>
      </div>
      <Field label="Notes (optional)" value={draft.notes} onChange={(v) => setDraft((d) => ({ ...d, notes: v }))} testId="invoice-notes" wide />
      <div className="flex items-center gap-2 pt-2">
        <button onClick={save} disabled={saving} data-testid="invoice-save"
          className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md inline-flex items-center gap-1.5">
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Save
        </button>
        {!isNew && (
          <a href={`/api/portal/invoices/${draft.id}/pdf`} target="_blank" rel="noreferrer" data-testid="invoice-pdf"
            className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-md inline-flex items-center gap-1.5">
            <Download className="w-3 h-3" /> PDF
          </a>
        )}
      </div>
    </div>
  );
}

// ----------------------------- Top-level section
export default function PortalInvoicingSection({ open, onToggle }) {
  const [tab, setTab] = useState("invoices");
  const [editor, setEditor] = useState(null);  // null or { invoice }
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <section
      id="portal-section-invoicing"
      className={`${open ? "bg-white" : "bg-stone-100"} border border-stone-200 rounded-2xl overflow-hidden transition-colors scroll-mt-20`}
      data-testid="portal-invoicing">
      <button onClick={onToggle} data-testid="toggle-invoicing"
        className={`touch-target w-full flex items-center justify-between gap-3 ${open ? "hover:bg-stone-50" : "hover:bg-stone-200"} transition-colors px-4 sm:px-6 py-3.5 sm:py-4`}>
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-stone-700" />
          <span className="text-xs uppercase tracking-[0.3em] font-bold text-stone-700">Invoicing+</span>
        </div>
        <span className={`w-7 h-7 rounded-full border flex items-center justify-center transition-colors ${open ? "border-stone-300 bg-white" : "border-stone-950 bg-stone-950 text-white"}`}>
          {open ? <ChevronUp className="w-3.5 h-3.5 text-stone-600" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </span>
      </button>
      {open && (
        <div className="px-4 sm:px-6 pb-5 sm:pb-6">
          {editor ? (
            <InvoiceEditor invoice={editor.invoice} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); setRefreshKey((k) => k + 1); }} />
          ) : (
            <>
              <div className="flex items-center gap-1 mb-4 border-b border-stone-200">
                {[
                  { id: "invoices", label: "Invoices", icon: FileText },
                  { id: "clients",  label: "Clients",  icon: Users },
                  { id: "bank",     label: "Bank",     icon: Banknote },
                  { id: "settings", label: "Settings", icon: Settings },
                ].map((t) => {
                  const TabIcon = t.icon;
                  return (
                    <button key={t.id} onClick={() => setTab(t.id)} data-testid={`portal-invoicing-tab-${t.id}`}
                      className={`px-3 py-2 text-[11px] uppercase tracking-wider font-bold inline-flex items-center gap-1.5 border-b-2 -mb-px ${
                        tab === t.id
                          ? "border-stone-950 text-stone-950"
                          : "border-transparent text-stone-500 hover:text-stone-800"
                      }`}>
                      <TabIcon className="w-3.5 h-3.5" /> {t.label}
                    </button>
                  );
                })}
              </div>
              {tab === "invoices" && (
                <InvoicesTab
                  refreshKey={refreshKey}
                  onCreate={() => setEditor({ invoice: null })}
                  onEdit={(inv) => setEditor({ invoice: inv })}
                  onView={(inv) => setEditor({ invoice: inv })}
                />
              )}
              {tab === "clients" && <ClientsTab refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />}
              {tab === "bank" && <BankTab refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />}
              {tab === "settings" && <SettingsTab />}
            </>
          )}
        </div>
      )}
    </section>
  );
}
