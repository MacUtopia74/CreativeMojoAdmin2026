import { useState, useEffect } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import api from "@/lib/api";
import { API_BASE } from "@/lib/api";
import { format, parseISO } from "date-fns";
import { ArrowLeft, Download, Edit, Send, CheckCircle, Trash2, RefreshCw, Banknote, Link2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import StatusBadge from "@/components/invoices/StatusBadge";


function InvoiceLineItem({ item, index }) {
  // class_date is set by the create / edit form for any "this class on
  // this day" line items. Render it inline below the description so
  // the customer can see exactly which session(s) they're being billed
  // for, without changing the rest of the invoice layout.
  const classDate = item.class_date
    ? new Date(`${item.class_date}T12:00:00`).toLocaleDateString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
    })
    : null;
  return (
    <tr className="border-b border-slate-100">
      <td className="py-4 text-slate-900">
        <div>{item.description}</div>
        {classDate && (
          <div className="text-xs text-slate-500 mt-0.5">
            Date of class/event: <span className="font-mono">{classDate}</span>
          </div>
        )}
      </td>
      <td className="py-4 text-right font-mono text-slate-700">{item.quantity}</td>
      <td className="py-4 text-right font-mono text-slate-700">£{Number(item.unit_price).toFixed(2)}</td>
      <td className="py-4 text-right font-mono font-medium text-slate-900">£{Number(item.amount).toFixed(2)}</td>
    </tr>
  );
}

function InvoiceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [invoice, setInvoice] = useState(null);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Payment-linking state
  const [linkOpen, setLinkOpen] = useState(false);
  const [candidates, setCandidates] = useState([]);
  const [candidatesMeta, setCandidatesMeta] = useState(null);
  const [loadingCandidates, setLoadingCandidates] = useState(false);

  const openLinker = async () => {
    setLinkOpen(true); setLoadingCandidates(true);
    try {
      const { data } = await api.get(`/portal/invoices/${id}/payment-candidates`);
      setCandidates(data.candidates || []);
      setCandidatesMeta({
        invoice_total: data.invoice_total,
        paid_total: data.paid_total,
        remaining: data.remaining,
        target_amount: data.target_amount,
      });
    } catch {
      toast.error("Could not load candidates");
    } finally { setLoadingCandidates(false); }
  };

  const linkPayment = async (txId) => {
    try {
      const { data } = await api.post(`/portal/invoices/${id}/link-payment`, { transaction_id: txId });
      setInvoice(data);
      const fullyPaid = data.status === "paid";
      toast.success(fullyPaid ? "Payment linked · invoice marked Paid" : "Payment linked · invoice now Partially paid");
      // Refresh the candidate list so the just-linked row disappears.
      // Keep modal open if we still have a remaining balance so the user
      // can chain multiple receipts without re-opening.
      if (fullyPaid) {
        setLinkOpen(false);
      } else {
        openLinker();
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Link failed");
    }
  };

  const unlinkSinglePayment = async (txId) => {
    if (!window.confirm("Remove this payment from the invoice?")) return;
    try {
      const { data } = await api.delete(`/portal/invoices/${id}/link-payment/${txId}`);
      setInvoice(data);
      toast.success("Payment unlinked");
    } catch { toast.error("Unlink failed"); }
  };

  const unlinkAllPayments = async () => {
    if (!window.confirm("Remove ALL linked payments from this invoice?")) return;
    try {
      await api.delete(`/portal/invoices/${id}/link-payment`);
      const { data } = await api.get(`/portal/invoices/${id}`);
      setInvoice(data);
      toast.success("All payments unlinked");
    } catch { toast.error("Unlink failed"); }
  };

  useEffect(() => {
    Promise.all([
      api.get(`/portal/invoices/${id}`),
      api.get("/portal/invoices/settings/me")
    ]).then(([invRes, settingsRes]) => {
      setInvoice(invRes.data);
      setSettings(settingsRes.data);
    }).catch(() => { toast.error("Failed to fetch invoice"); navigate("/portal/invoices"); })
      .finally(() => setLoading(false));
  }, [id, navigate]);

  const refreshClientInfo = async () => {
    if (!invoice?.client_id) {
      toast.error("No client associated with this invoice");
      return;
    }
    setRefreshing(true);
    try {
      const clientRes = await api.get(`/portal/invoices/clients/${invoice.client_id}`);
      const client = clientRes.data;
      
      // Build display info based on show_* flags
      const displayParts = [];
      if (client.show_address !== false && client.address) displayParts.push(client.address);
      if (client.show_city !== false && client.city) displayParts.push(client.city);
      if (client.show_country !== false && client.country) displayParts.push(client.country);
      
      const updatedData = {
        client_name: client.show_name !== false ? client.name : "",
        client_email: client.show_email !== false ? (client.email || "") : "",
        client_email2: client.show_email2 !== false ? (client.email2 || "") : "",
        client_phone: client.show_phone !== false ? (client.phone || "") : "",
        client_address: displayParts.join(", "),
      };
      
      await api.put(`/portal/invoices/${id}`, updatedData);
      setInvoice(prev => ({ ...prev, ...updatedData }));
      toast.success("Client info refreshed successfully");
    } catch (err) {
      toast.error("Failed to refresh client info");
    } finally {
      setRefreshing(false);
    }
  };

  const updateStatus = async (newStatus) => {
    try {
      await api.patch(`/portal/invoices/${id}/status`, { status: newStatus });
      setInvoice(p => ({ ...p, status: newStatus }));
      toast.success(`Invoice marked as ${newStatus}`);
      if (newStatus === "deleted") navigate("/portal/invoices/deleted");
    } catch (err) { toast.error("Failed to update status"); }
  };

  // Cross-site cookies are blocked by Chrome incognito on production,
  // so we MUST fetch the PDF as a blob via axios (which attaches the
  // ``Authorization: Bearer`` header). Static <a href> / window.open
  // can't carry the token, hence the previous "Not authenticated" error.
  const viewPDF = async () => {
    const tabRef = window.open("about:blank", "_blank");
    try {
      const res = await api.get(`/portal/invoices/${id}/pdf`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      // Friendly fallback for Cmd+S: also tag the new tab's title with
      // the same filename so it doesn't read "about:blank" in the tab
      // strip while the PDF loads.
      const safe = (s) => (s || "").toString().trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-").slice(0, 60);
      const dateBit = invoice.issue_date
        ? format(parseISO(invoice.issue_date), "dd.MM.yy")
        : (invoice.created_at ? format(parseISO(invoice.created_at), "dd.MM.yy") : "");
      const niceName = [safe(invoice.client_name) || "client", dateBit, invoice.invoice_number || "draft"].filter(Boolean).join("_");
      if (tabRef) {
        try { tabRef.document.title = niceName; } catch (_) { /* cross-origin */ }
        tabRef.location.href = url;
      } else {
        window.open(url, "_blank");
      }
      // Revoke after the new tab has had a chance to load.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast.success("PDF opened in new tab");
    } catch (err) {
      if (tabRef) tabRef.close();
      toast.error(err?.response?.data?.detail || "Couldn't open the PDF");
      return;
    }
    setTimeout(async () => {
      try {
        const updatedInvoice = await api.get(`/portal/invoices/${id}`);
        setInvoice(updatedInvoice.data);
      } catch (e) {
        console.warn("[InvoiceDetail] post-send status refresh failed (non-critical)", e);
      }
    }, 1000);
  };

  const downloadPDF = async () => {
    try {
      const res = await api.get(`/portal/invoices/${id}/pdf`, {
        responseType: "blob",
        params: { download: true },
      });
      const url = URL.createObjectURL(res.data);
      const link = document.createElement("a");
      link.href = url;
      // Filename: ClientName_dd.MM.yy_INV-001.pdf — much friendlier than
      // the raw invoice UUID we used to fall back to.
      const safe = (s) => (s || "").toString().trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-").slice(0, 60);
      const dateBit = invoice.issue_date
        ? format(parseISO(invoice.issue_date), "dd.MM.yy")
        : (invoice.created_at ? format(parseISO(invoice.created_at), "dd.MM.yy") : "");
      const parts = [safe(invoice.client_name) || "client", dateBit, invoice.invoice_number || "draft"].filter(Boolean);
      link.download = `${parts.join("_")}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast.success("PDF download started");
      setTimeout(async () => {
        const updatedInvoice = await api.get(`/portal/invoices/${id}`);
        setInvoice(updatedInvoice.data);
      }, 1000);
    } catch (err) { 
      console.error("PDF download error:", err);
      toast.error("Failed to download PDF"); 
    }
  };

  const deleteInvoice = async () => {
    try {
      await api.patch(`/portal/invoices/${id}/status`, { status: "deleted" });
      toast.success("Invoice moved to deleted");
      navigate("/portal/invoices/deleted");
    } catch (err) { toast.error("Failed to delete invoice"); }
  };

  if (loading) {
    return <div className="flex items-center justify-center min-h-[50vh]"><p className="text-muted-foreground">Loading...</p></div>;
  }

  if (!invoice) {
    return <div className="flex items-center justify-center min-h-[50vh]"><p className="text-muted-foreground">Invoice not found</p></div>;
  }

  const lineItems = invoice.line_items || [];
  const formattedIssueDate = format(parseISO(invoice.issue_date), "dd/MM/yyyy");
  const formattedDueDate = format(parseISO(invoice.due_date), "dd/MM/yyyy");
  const formattedCreatedAt = format(parseISO(invoice.created_at), "dd/MM/yyyy");

  return (
    <div className="space-y-8" data-testid="invoice-detail-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => navigate("/portal/invoices")} data-testid="back-btn">
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-slate-900" data-testid="invoice-number">{invoice.invoice_number}</h1>
              <StatusBadge status={invoice.status} />
            </div>
            <p className="text-muted-foreground mt-1">Created {formattedCreatedAt}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={refreshClientInfo} disabled={refreshing} data-testid="refresh-client-btn">
            <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? "Refreshing..." : "Refresh Client Info"}
          </Button>
          <Button variant="outline" onClick={viewPDF} data-testid="view-pdf-btn">
            <Download className="w-4 h-4 mr-2" />View PDF
          </Button>
          <Link to={`/portal/invoices/${id}/edit`}>
            <Button variant="outline" data-testid="edit-invoice-btn">
              <Edit className="w-4 h-4 mr-2" />Edit
            </Button>
          </Link>
          {/* Standalone Delete button so franchisees don't have to
              hunt through Update Status → Delete. Hidden once the
              invoice already lives in /deleted. */}
          {invoice.status !== "deleted" && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  data-testid="delete-invoice-quick-btn"
                  className="text-rose-700 hover:text-rose-800 hover:bg-rose-50 border-rose-200"
                >
                  <Trash2 className="w-4 h-4 mr-2" /> Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Invoice?</AlertDialogTitle>
                  <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={deleteInvoice} className="bg-destructive text-destructive-foreground">Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button data-testid="status-dropdown-btn">Update Status</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {invoice.status !== "sent" && (
                <DropdownMenuItem onClick={() => updateStatus("sent")} data-testid="mark-sent-btn">
                  <Send className="w-4 h-4 mr-2" />Mark as Sent
                </DropdownMenuItem>
              )}
              {invoice.status !== "paid" && (
                <DropdownMenuItem onClick={() => updateStatus("paid")} data-testid="mark-paid-btn">
                  <CheckCircle className="w-4 h-4 mr-2" />Mark as Paid
                </DropdownMenuItem>
              )}
              {invoice.status !== "draft" && (
                <DropdownMenuItem onClick={() => updateStatus("draft")} data-testid="mark-draft-btn">
                  Mark as Draft
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <DropdownMenuItem onSelect={(e) => e.preventDefault()} className="text-destructive" data-testid="delete-invoice-btn">
                    <Trash2 className="w-4 h-4 mr-2" />Delete
                  </DropdownMenuItem>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete Invoice?</AlertDialogTitle>
                    <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={deleteInvoice} className="bg-destructive text-destructive-foreground">Delete</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>


      {/* Payment-linker panel was removed from the franchisee portal —
          CSV reconciliation is admin-only now. Franchisees mark
          invoices as paid via the "Update Status" dropdown above. */}

      {/* Payment-picker modal (legacy — kept hidden via linkOpen state
          which is no longer ever set to true on the portal). */}
      <AlertDialog open={linkOpen} onOpenChange={setLinkOpen}>
        <AlertDialogContent className="max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Link a banking transaction</AlertDialogTitle>
            <AlertDialogDescription>
              {candidatesMeta?.paid_total > 0 ? (
                <>Already paid <strong>£{Number(candidatesMeta.paid_total).toFixed(2)}</strong> of £{Number(candidatesMeta.invoice_total).toFixed(2)}.
                Showing matches closest to the <strong>£{Number(candidatesMeta.target_amount || 0).toFixed(2)}</strong> outstanding balance.</>
              ) : (
                <>Showing the 50 most likely matches for £{Number(invoice.total).toFixed(2)}.
                Exact-amount matches appear first.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-[60vh] overflow-auto -mx-6 px-6">
            {loadingCandidates ? (
              <div className="flex items-center justify-center py-10 text-stone-500"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading…</div>
            ) : candidates.length === 0 ? (
              <p className="text-sm text-stone-500 py-8 text-center">No incoming transactions found. Upload a statement first.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-[10px] uppercase tracking-wider text-stone-500 border-b">
                  <tr><th className="text-left py-2">Date</th><th className="text-left py-2">Description</th><th className="text-right py-2">Amount</th><th></th></tr>
                </thead>
                <tbody>
                  {candidates.map((t) => {
                    const target = candidatesMeta?.target_amount ?? invoice.total;
                    const exact = Math.abs(t.amount - target) < 0.005;
                    const alreadyLinked = t.linked_invoice_id && t.linked_invoice_id !== id;
                    return (
                      <tr key={t.transaction_id} className={`border-b border-stone-100 hover:bg-stone-50 ${exact ? "bg-emerald-50/60" : ""}`} data-testid={`candidate-${t.transaction_id}`}>
                        <td className="py-2 text-xs text-stone-600 tabular-nums">{new Date(t.timestamp).toLocaleDateString("en-GB")}</td>
                        <td className="py-2 text-stone-800 truncate max-w-xs" title={t.description}>{t.description}</td>
                        <td className={`py-2 text-right tabular-nums font-bold ${exact ? "text-emerald-700" : ""}`}>£{Number(t.amount).toFixed(2)}</td>
                        <td className="py-2 text-right">
                          <Button size="sm" variant={exact ? "default" : "outline"} onClick={() => linkPayment(t.transaction_id)} disabled={alreadyLinked}>
                            {alreadyLinked ? "Linked elsewhere" : "Link"}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card className="bg-white shadow-xl max-w-4xl mx-auto sm:overflow-hidden min-h-[800px] sm:aspect-[210/297]" data-testid="invoice-content">
        <div className="h-full flex flex-col p-6 sm:p-12 md:p-16">
          {/* Brand logo top-left + franchise name top-right.
              The logo lives in /public so it's served same-origin and
              doesn't need auth (unlike the PDF bytes). */}
          <div className="flex items-start justify-between gap-6 border-b border-slate-200 pb-4 mb-6">
            <img
              src="/cm-invoice-logo.png"
              alt="Creative Mojo"
              className="h-14 sm:h-16 w-auto object-contain shrink-0"
              data-testid="invoice-logo"
            />
            {(settings?.franchise_name || settings?.business_name) && (
              <div className="text-right">
                <p className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight leading-tight">
                  {settings?.franchise_name || settings?.business_name}
                </p>
              </div>
            )}
          </div>
          {/* Main Content */}
          <div className="flex-1">
            <div className="flex justify-between items-start mb-6">
              <div>
                <h2 className="text-3xl font-bold tracking-tight text-slate-900 font-display">INVOICE</h2>
                <p className="font-mono text-xl mt-1 text-slate-700">{invoice.invoice_number}</p>
              </div>
              <StatusBadge status={invoice.status} className="text-sm px-4 py-1" />
            </div>
            
            {/* Business Details & Invoice To */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
              <div>
                <p className="text-slate-500 uppercase tracking-wider text-xs font-semibold mb-2">Invoice to:</p>
                {invoice.client_name && <p className="font-semibold text-lg text-slate-900">{invoice.client_name}</p>}
                {invoice.client_email && <p className="text-slate-600">{invoice.client_email}</p>}
                {invoice.client_email2 && <p className="text-slate-600">{invoice.client_email2}</p>}
                {invoice.client_phone && <p className="text-slate-600">{invoice.client_phone}</p>}
                {invoice.client_address && <p className="text-slate-600 mt-1">{invoice.client_address}</p>}
              </div>
              <div className="text-right text-slate-600 space-y-0.5">
                {settings?.business_name && (
                  <p className="font-semibold text-slate-900">{settings.business_name}</p>
                )}
                {settings?.business_address_line1 && <p>{settings.business_address_line1}</p>}
                {settings?.business_address_line2 && <p>{settings.business_address_line2}</p>}
                {(settings?.business_city || settings?.business_county || settings?.business_postcode) && (
                  <p>
                    {[settings?.business_city, settings?.business_county, settings?.business_postcode]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                )}
                {settings?.business_phone && <p>{settings.business_phone}</p>}
                {settings?.business_email && <p>{settings.business_email}</p>}
              </div>
            </div>

            <div className="mb-10">
              <div className="space-y-4">
                <div>
                  <p className="text-slate-500 uppercase tracking-wider text-xs font-semibold">Issue Date</p>
                  <p className="font-mono text-slate-900 mt-1">{formattedIssueDate}</p>
                </div>
                <div>
                  <p className="text-slate-500 uppercase tracking-wider text-xs font-semibold">Due Date</p>
                  <p className="font-mono text-slate-900 mt-1">{formattedDueDate}</p>
                </div>
                {invoice.payment_terms && (
                  <div>
                    <p className="text-slate-500 uppercase tracking-wider text-xs font-semibold">Payment Terms</p>
                    <p className="text-slate-900 mt-1">{invoice.payment_terms}</p>
                  </div>
                )}
              </div>
            </div>

            <table className="w-full mb-8 mt-8">
              <thead>
                <tr className="border-b-2 border-slate-200">
                  <th className="text-left py-4 text-xs uppercase text-slate-500">Description</th>
                  <th className="text-right py-4 text-xs uppercase text-slate-500">Qty</th>
                  <th className="text-right py-4 text-xs uppercase text-slate-500">Price</th>
                  <th className="text-right py-4 text-xs uppercase text-slate-500">Amount</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((item, i) => (
                  <InvoiceLineItem key={`${i}-${item.description || ""}-${item.amount ?? ""}`} item={item} index={i} />
                ))}
              </tbody>
            </table>

            <div className="border-t-2 border-slate-200 pt-4 max-w-sm ml-auto space-y-2 mt-6">
              <div className="flex justify-between">
                <span className="text-slate-500">Subtotal</span>
                <span className="font-mono text-slate-900">£{invoice.subtotal.toFixed(2)}</span>
              </div>
              {invoice.discount_rate > 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Discount ({invoice.discount_rate}%)</span>
                  <span className="font-mono text-emerald-600">-£{invoice.discount_amount.toFixed(2)}</span>
                </div>
              )}
              {invoice.tax_rate > 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Tax ({invoice.tax_rate}%)</span>
                  <span className="font-mono text-slate-900">£{invoice.tax_amount.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between text-xl font-bold pt-3 border-t border-slate-200">
                <span className="text-slate-900">Total</span>
                <span className="font-mono text-slate-900">£{invoice.total.toFixed(2)}</span>
              </div>
            </div>

            {invoice.notes && (
              <div className="mt-10 pt-4 border-t border-slate-100">
                <p className="text-slate-500 uppercase tracking-wider text-xs font-semibold mb-2">Notes</p>
                <p className="text-slate-600">{invoice.notes}</p>
              </div>
            )}
          </div>
          
          {/* Footer - Bank Details (always at bottom) */}
          <div className="pt-6 border-t border-slate-200 mt-auto">
            <p className="text-slate-600">{settings?.bank_payment_info || "Payments by BACS/Online should be made to:"}</p>
            <p className="font-semibold text-slate-900">{settings?.bank_account_name || "Sandra Caldeira-Dunkerley"}</p>
            <p className="text-slate-600">{settings?.bank_details || "Sort Code: 40-07-33 Account No. 62079658"}</p>
          </div>
        </div>
      </Card>
    </div>
  );
}

export default InvoiceDetail;
