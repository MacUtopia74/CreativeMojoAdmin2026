// Portal-side reconcile page. Same idea as the admin Reconcile (match
// bank credits → invoices) but uses the franchisee-scoped endpoints:
//   POST /portal/invoices/bank/upload  ·  GET /portal/invoices/bank/transactions
//   POST /portal/invoices/{id}/link-payment
// Layout is full-page (mounted under /portal/invoices/reconcile) so the
// franchisee gets the same kind of focused experience Sandra has on the
// admin side.
import { useEffect, useMemo, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import api from "@/lib/api";
import { Upload, Loader2, Link2, Unlink, Trash2, CheckCircle2, Receipt } from "lucide-react";

const moneyFmt = (n) => `£${Number(n || 0).toFixed(2)}`;

export default function PortalReconcile() {
  const [rows, setRows] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState("unreconciled");
  const [pickerForTxn, setPickerForTxn] = useState(null);

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
      toast.error(e?.response?.data?.detail || "Couldn't load bank transactions");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

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
      toast.success("Payment linked");
      setPickerForTxn(null);
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || "Couldn't link"); }
  };
  const unlink = async (txnId, invoiceId) => {
    try {
      await api.delete(`/portal/invoices/bank/transactions/${txnId}/link/${invoiceId}`);
      toast.success("Unlinked");
      load();
    } catch (e) { toast.error(e?.response?.data?.detail || "Couldn't unlink"); }
  };
  const removeTxn = async (txnId) => {
    if (!window.confirm("Remove this transaction from the reconciliation list?")) return;
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
    <div className="space-y-6" data-testid="portal-reconcile">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-slate-900">Reconcile</h1>
          <p className="text-muted-foreground mt-1">Upload a CSV from your bank and match incoming payments to invoices.</p>
        </div>
        <label className="px-4 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-full inline-flex items-center gap-1.5 cursor-pointer shadow-sm">
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Upload CSV
          <input type="file" accept=".csv,text/csv" onChange={onUpload} className="hidden" disabled={uploading} data-testid="reconcile-csv-upload" />
        </label>
      </div>

      <Card className="p-4">
        <div className="flex items-center gap-1 mb-3">
          {[
            { id: "unreconciled", label: "Unmatched" },
            { id: "reconciled",   label: "Matched" },
            { id: "all",          label: "All credits" },
          ].map((t) => (
            <button key={t.id} onClick={() => setFilter(t.id)} data-testid={`reconcile-filter-${t.id}`}
              className={`px-3 py-1 text-xs font-bold uppercase tracking-wider rounded-md ${
                filter === t.id ? "bg-slate-900 text-white" : "bg-stone-100 text-stone-700 hover:bg-stone-200"
              }`}>{t.label}</button>
          ))}
          <div className="ml-auto text-xs text-stone-500 tabular-nums">{visible.length} of {rows.length}</div>
        </div>

        {loading ? (
          <div className="text-sm text-stone-400 flex items-center gap-1.5 py-6">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : visible.length === 0 ? (
          <div className="text-center py-12">
            <Receipt className="w-10 h-10 text-stone-300 mx-auto" />
            <p className="text-sm text-stone-500 mt-3">
              {rows.length === 0 ? <>Upload a CSV from your bank to get started.</> : <>Nothing to show in this view.</>}
            </p>
          </div>
        ) : (
          <div className="border border-stone-100 rounded-lg overflow-hidden">
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
                    <tr key={tx.id} className="border-t border-stone-100 hover:bg-stone-50" data-testid={`reconcile-row-${tx.id}`}>
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
                            data-testid={`reconcile-picker-${tx.id}`}
                            className="px-2 py-1 text-xs border border-stone-300 rounded bg-white">
                            <option value="">— Pick an invoice —</option>
                            {invoices.map((inv) => (
                              <option key={inv.id} value={inv.id}>
                                {inv.invoice_number} · {inv.client_name} · {moneyFmt(inv.total)}
                              </option>
                            ))}
                          </select>
                        ) : tx.suggested_invoice ? (
                          <Button size="sm" onClick={() => link(tx.id, tx.suggested_invoice.id)} data-testid={`reconcile-match-${tx.id}`}
                            className="bg-amber-100 hover:bg-amber-200 text-amber-900 border-amber-200 px-2 h-7 text-[10px] font-bold uppercase tracking-wider gap-1">
                            <Link2 className="w-3 h-3" />
                            Match {tx.suggested_invoice.invoice_number}
                          </Button>
                        ) : (
                          <Button size="sm" onClick={() => setPickerForTxn(tx.id)} data-testid={`reconcile-pick-${tx.id}`}
                            variant="outline" className="px-2 h-7 text-[10px] font-bold uppercase tracking-wider gap-1">
                            <Link2 className="w-3 h-3" /> Pick…
                          </Button>
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
      </Card>

      <p className="text-xs text-stone-500">
        Tip — open any invoice to also link payments from the invoice side.
        <Link to="/portal/invoices" className="ml-1 text-blue-600 hover:underline">Go to invoices</Link>
      </p>
    </div>
  );
}
