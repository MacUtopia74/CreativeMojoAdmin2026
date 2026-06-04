import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import { API_BASE } from "@/lib/api";
import { format, parseISO } from "date-fns";
import { Trash2, RotateCcw, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import StatusBadge from "@/components/invoices/StatusBadge";


function DeletedInvoices() {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDeletedInvoices();
  }, []);

  const fetchDeletedInvoices = async () => {
    try {
      const response = await api.get("/invoices/deleted/list");
      setInvoices(response.data);
    } catch (err) {
      toast.error("Failed to fetch deleted invoices");
    } finally {
      setLoading(false);
    }
  };

  const restoreInvoice = async (id) => {
    try {
      await api.post(`/invoices/${id}/restore`);
      toast.success("Invoice restored successfully");
      fetchDeletedInvoices();
    } catch (err) {
      toast.error("Failed to restore invoice");
    }
  };

  const permanentDelete = async (id) => {
    try {
      await api.delete(`/invoices/${id}?permanent=true`);
      toast.success("Invoice permanently deleted");
      fetchDeletedInvoices();
    } catch (err) {
      toast.error("Failed to delete invoice");
    }
  };

  return (
    <div className="space-y-8" data-testid="deleted-invoices-page">
      <div>
        <h1 className="text-4xl font-bold tracking-tight font-display" data-testid="page-title">Deleted Invoices</h1>
        <p className="text-muted-foreground mt-1">Recover or permanently delete invoices</p>
      </div>

      {loading ? (
        <div className="text-center py-12"><p className="text-muted-foreground">Loading...</p></div>
      ) : invoices.length === 0 ? (
        <Card className="p-12 text-center">
          <Trash2 className="w-12 h-12 mx-auto text-muted-foreground/50" />
          <h3 className="text-lg font-semibold mt-4">No deleted invoices</h3>
          <p className="text-muted-foreground mt-1">Deleted invoices will appear here for recovery</p>
        </Card>
      ) : (
        <div className="space-y-4">
          {invoices.map((invoice) => (
            <Card key={invoice.id} className="p-6" data-testid={`deleted-invoice-${invoice.id}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-6">
                  <div>
                    <p className="font-mono text-sm font-semibold">{invoice.invoice_number}</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Deleted {invoice.deleted_at ? format(parseISO(invoice.deleted_at), "MMM dd, yyyy") : ""}
                    </p>
                  </div>
                  <div className="hidden sm:block">
                    <p className="font-medium">{invoice.client_name}</p>
                    <p className="text-sm text-muted-foreground">{invoice.client_email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <p className="font-mono text-lg font-semibold">£{invoice.total.toFixed(2)}</p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => restoreInvoice(invoice.id)} data-testid={`restore-${invoice.id}`}>
                      <RotateCcw className="w-4 h-4 mr-1" /> Restore
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="destructive" size="sm" data-testid={`perm-delete-${invoice.id}`}>
                          <Trash2 className="w-4 h-4 mr-1" /> Delete
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle className="flex items-center gap-2">
                            <AlertTriangle className="w-5 h-5 text-destructive" />
                            Permanently Delete?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            This will permanently delete invoice {invoice.invoice_number}. This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => permanentDelete(invoice.id)} className="bg-destructive text-destructive-foreground">
                            Delete Permanently
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export default DeletedInvoices;
