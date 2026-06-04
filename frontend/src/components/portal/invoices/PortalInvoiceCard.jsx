// Portal invoice client — links to /portal/invoices/:id (NOT the admin
// /invoices route — that's how franchisees ended up at the dashboard
// every time they clicked an invoice card).
import { useState } from "react";
import { format } from "date-fns";
import { Link } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { ChevronRight, Calendar, Trash2, Loader2 } from "lucide-react";
import StatusBadge from "@/components/invoices/StatusBadge";
import api from "@/lib/api";
import { toast } from "sonner";

const PortalInvoiceCard = ({ invoice, onDeleted }) => {
  const [deleting, setDeleting] = useState(false);

  const formatDate = (dateStr) => {
    try { return format(new Date(dateStr), "MMM d, yyyy"); }
    catch { return dateStr; }
  };

  const handleDelete = async (e) => {
    // Don't navigate to the detail page when the user clicks the bin.
    e.preventDefault();
    e.stopPropagation();
    if (deleting) return;
    if (!window.confirm(`Move invoice ${invoice.invoice_number} to deleted?`)) return;
    setDeleting(true);
    try {
      await api.patch(`/portal/invoices/${invoice.id}/status`, { status: "deleted" });
      toast.success("Invoice moved to deleted");
      onDeleted?.(invoice.id);
    } catch {
      toast.error("Could not delete invoice");
    } finally {
      setDeleting(false);
    }
  };

  // Only render the inline bin button on still-deletable statuses —
  // mirrors the admin-side rule (deleted invoices stay in /deleted).
  const canQuickDelete = invoice.status !== "deleted";

  return (
    <Card className="p-4 hover:shadow-md transition-shadow rounded-lg group relative">
      <Link
        to={`/portal/invoices/${invoice.id}`}
        data-testid={`invoice-card-${invoice.id}`}
        className="block hover:bg-muted/30 -m-4 p-4 rounded-lg"
      >
        <div className="flex items-center justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <p className="font-mono text-sm font-semibold text-foreground">
                {invoice.invoice_number}
              </p>
              <StatusBadge status={invoice.status} />
            </div>
            <p className="font-medium text-foreground mt-2 truncate">
              {invoice.client_name}
            </p>
            <div className="flex items-center gap-1 mt-1 text-sm text-muted-foreground">
              <Calendar className="w-3 h-3" />
              <span>{formatDate(invoice.issue_date)}</span>
              <span className="mx-1">·</span>
              <span>Due {formatDate(invoice.due_date)}</span>
            </div>
          </div>
          <div className="flex items-center gap-3 ml-4">
            <div className="text-right">
              <p className="font-mono text-lg font-semibold">
                £{Number(invoice.total).toFixed(2)}
              </p>
            </div>
            {canQuickDelete && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                data-testid={`invoice-card-delete-${invoice.id}`}
                title="Delete invoice"
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity w-8 h-8 rounded-md border border-stone-200 hover:border-rose-300 hover:bg-rose-50 flex items-center justify-center"
              >
                {deleting
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin text-stone-500" />
                  : <Trash2 className="w-3.5 h-3.5 text-stone-500" />}
              </button>
            )}
            <ChevronRight className="w-5 h-5 text-muted-foreground" />
          </div>
        </div>
      </Link>
    </Card>
  );
};

export default PortalInvoiceCard;
