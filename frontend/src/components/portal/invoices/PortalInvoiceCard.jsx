// Portal invoice client — links to /portal/invoices/:id (NOT the admin
// /invoices route — that's how franchisees ended up at the dashboard
// every time they clicked an invoice card).
import { format } from "date-fns";
import { Link } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { ChevronRight, Calendar } from "lucide-react";
import StatusBadge from "@/components/invoices/StatusBadge";

const PortalInvoiceCard = ({ invoice }) => {
  const formatDate = (dateStr) => {
    try { return format(new Date(dateStr), "MMM d, yyyy"); }
    catch { return dateStr; }
  };

  return (
    <Link to={`/portal/invoices/${invoice.id}`} data-testid={`invoice-card-${invoice.id}`}>
      <Card className="p-4 hover:shadow-md transition-shadow cursor-pointer hover:bg-muted/30 rounded-lg">
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
          <div className="flex items-center gap-4 ml-4">
            <div className="text-right">
              <p className="font-mono text-lg font-semibold">
                £{Number(invoice.total).toFixed(2)}
              </p>
            </div>
            <ChevronRight className="w-5 h-5 text-muted-foreground" />
          </div>
        </div>
      </Card>
    </Link>
  );
};

export default PortalInvoiceCard;
