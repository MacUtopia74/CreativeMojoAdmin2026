import { useState, useEffect } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import api from "@/lib/api";
import { API_BASE } from "@/lib/api";
import { format, parseISO } from "date-fns";
import { ArrowLeft, Download, Edit, Send, CheckCircle, Trash2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import StatusBadge from "@/components/invoices/StatusBadge";


function InvoiceLineItem({ item, index }) {
  return (
    <tr className="border-b border-slate-100">
      <td className="py-4 text-slate-900">{item.description}</td>
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

  useEffect(() => {
    Promise.all([
      api.get(`/invoices/${id}`),
      api.get("/invoices/settings/me")
    ]).then(([invRes, settingsRes]) => {
      setInvoice(invRes.data);
      setSettings(settingsRes.data);
    }).catch(() => { toast.error("Failed to fetch invoice"); navigate("/invoices"); })
      .finally(() => setLoading(false));
  }, [id, navigate]);

  const refreshClientInfo = async () => {
    if (!invoice?.client_id) {
      toast.error("No client associated with this invoice");
      return;
    }
    setRefreshing(true);
    try {
      const clientRes = await api.get(`/invoices/clients/${invoice.client_id}`);
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
      
      await api.put(`/invoices/${id}`, updatedData);
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
      await api.patch(`/invoices/${id}/status`, { status: newStatus });
      setInvoice(p => ({ ...p, status: newStatus }));
      toast.success(`Invoice marked as ${newStatus}`);
      if (newStatus === "deleted") navigate("/invoices/deleted");
    } catch (err) { toast.error("Failed to update status"); }
  };

  const viewPDF = () => {
    // Open PDF directly in new tab
    window.open(`${API_BASE}/invoices/${id}/pdf`, '_blank');
    toast.success("PDF opened in new tab");
    
    // Refresh invoice status after a short delay (auto-marked as sent)
    setTimeout(async () => {
      try {
        const updatedInvoice = await api.get(`/invoices/${id}`);
        setInvoice(updatedInvoice.data);
      } catch (err) {}
    }, 1000);
  };

  const downloadPDF = async () => {
    try {
      // Use direct URL approach for more reliable downloads
      const downloadUrl = `${API_BASE}/invoices/${id}/pdf?download=true`;
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `${invoice.invoice_number}.pdf`;
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      toast.success("PDF download started");
      
      // Refresh invoice to show updated status
      setTimeout(async () => {
        const updatedInvoice = await api.get(`/invoices/${id}`);
        setInvoice(updatedInvoice.data);
      }, 1000);
    } catch (err) { 
      console.error("PDF download error:", err);
      toast.error("Failed to download PDF"); 
    }
  };

  const deleteInvoice = async () => {
    try {
      await api.patch(`/invoices/${id}/status`, { status: "deleted" });
      toast.success("Invoice moved to deleted");
      navigate("/invoices/deleted");
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
          <Button variant="ghost" onClick={() => navigate("/invoices")} data-testid="back-btn">
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-4xl font-bold tracking-tight font-['Manrope']" data-testid="invoice-number">{invoice.invoice_number}</h1>
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
          <Link to={`/invoices/${id}/edit`}>
            <Button variant="outline" data-testid="edit-invoice-btn">
              <Edit className="w-4 h-4 mr-2" />Edit
            </Button>
          </Link>
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

      <Card className="bg-white shadow-xl max-w-4xl mx-auto overflow-hidden" data-testid="invoice-content" style={{ aspectRatio: '210/297', minHeight: '800px' }}>
        <div className="h-full flex flex-col p-12 md:p-16">
          {/* Main Content */}
          <div className="flex-1">
            <div className="flex justify-between items-start mb-6">
              <div>
                <h2 className="text-4xl font-bold tracking-tight font-['Manrope'] text-slate-900">INVOICE</h2>
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
              <div className="text-right">
                <p className="font-semibold text-slate-900">{settings?.business_name || "Sandra Caldeira-Dunkerley"}</p>
                <p className="text-slate-600">{settings?.business_address_line1 || "Channings, Brithem Bottom,"}</p>
                <p className="text-slate-600">{settings?.business_address_line2 || "Cullompton, EX15 1NB"}</p>
                <p className="text-slate-600">{settings?.business_phone || "07957 343449"}</p>
                <p className="text-slate-600">{settings?.business_email || "sandracaldeiradunkerley77@gmail.com"}</p>
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
                  <InvoiceLineItem key={i} item={item} index={i} />
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
