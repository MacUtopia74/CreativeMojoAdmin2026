import { Link } from "react-router-dom";
import { format, parseISO } from "date-fns";
import { ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import StatusBadge from "@/components/invoices/StatusBadge";

export const InvoiceCard = ({ invoice }) => {
  const formattedDate = invoice.due_date 
    ? format(parseISO(invoice.due_date), "MMM dd, yyyy")
    : "No date";

  return (
    <Link to={`/invoices/${invoice.id}`} data-testid={`invoice-card-${invoice.id}`}>
      <Card className="p-6 hover:shadow-md transition-all duration-200 border border-border/50 hover:-translate-y-0.5 group">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6">
            {/* Invoice Number */}
            <div>
              <p className="font-mono text-sm font-semibold text-foreground" data-testid="invoice-number">
                {invoice.invoice_number}
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                Due {formattedDate}
              </p>
            </div>

            {/* Client */}
            <div className="hidden sm:block">
              <p className="font-medium text-foreground" data-testid="client-name">
                {invoice.client_name}
              </p>
              <p className="text-sm text-muted-foreground">
                {invoice.client_email}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-6">
            {/* Status */}
            <StatusBadge status={invoice.status} />

            {/* Amount */}
            <div className="text-right">
              <p className="font-mono text-lg font-semibold" data-testid="invoice-total">
                £{invoice.total.toLocaleString('en-GB', { minimumFractionDigits: 2 })}
              </p>
            </div>

            {/* Arrow */}
            <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
          </div>
        </div>
      </Card>
    </Link>
  );
};

export default InvoiceCard;
