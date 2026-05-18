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
      <Card className="p-6 hover:shadow-md transition-all duration-200 border border-stone-200 hover:-translate-y-0.5 group rounded-2xl">
        <div className="flex items-center justify-between gap-6">
          <div className="flex items-center gap-8 min-w-0 flex-1">
            {/* Invoice Number + due date */}
            <div className="shrink-0 w-32">
              <p className="font-mono text-base font-semibold text-slate-900" data-testid="invoice-number">
                {invoice.invoice_number}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Due {formattedDate}
              </p>
            </div>

            {/* Client */}
            <div className="hidden sm:block min-w-0 flex-1">
              <p className="font-semibold text-slate-900 truncate" data-testid="client-name">
                {invoice.client_name}
              </p>
              <p className="text-sm text-muted-foreground truncate">
                {invoice.client_email}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-6 shrink-0">
            {/* Status */}
            <StatusBadge status={invoice.status} />

            {/* Amount */}
            <div className="text-right w-24">
              <p className="font-mono text-lg font-bold text-slate-900" data-testid="invoice-total">
                £{invoice.total.toLocaleString('en-GB', { minimumFractionDigits: 2 })}
              </p>
            </div>

            {/* Arrow */}
            <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-blue-600 transition-colors" />
          </div>
        </div>
      </Card>
    </Link>
  );
};

export default InvoiceCard;
