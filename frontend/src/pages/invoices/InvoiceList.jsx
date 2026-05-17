import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import { API_BASE } from "@/lib/api";
import { Plus, FileText, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import InvoiceCard from "@/components/invoices/InvoiceCard";
import { toast } from "sonner";


const InvoiceList = () => {
  const [invoices, setInvoices] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    fetchInvoices();
    fetchStats();
  }, [statusFilter]);

  const fetchInvoices = async () => {
    try {
      const params = statusFilter !== "all" ? { status: statusFilter } : {};
      const response = await api.get("/invoices", { params });
      setInvoices(response.data);
    } catch (error) {
      toast.error("Failed to fetch invoices");
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      const response = await api.get("/invoices/stats");
      setStats(response.data);
    } catch (error) {
      console.error("Failed to fetch stats:", error);
    }
  };

  const filteredInvoices = invoices.filter((invoice) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      invoice.invoice_number.toLowerCase().includes(query) ||
      invoice.client_name.toLowerCase().includes(query) ||
      invoice.client_email.toLowerCase().includes(query)
    );
  });

  return (
    <div className="space-y-8" data-testid="invoice-list-page">
      {/* Page header — shell already provides the tab strip + New CTA. */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight" data-testid="page-title">
          Invoices
        </h1>
        <p className="text-stone-500 mt-1 text-sm">
          {stats?.total_invoices ?? 0} total · {stats?.outstanding != null ? `£${stats.outstanding.toFixed(2)} outstanding` : "—"}
        </p>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4" data-testid="stats-section">
          <Card 
            className={`p-6 cursor-pointer transition-all hover:shadow-md hover:scale-[1.02] ${statusFilter === "all" ? "ring-2 ring-primary" : ""}`}
            onClick={() => setStatusFilter("all")}
            data-testid="stat-card-total"
          >
            <p className="text-sm font-medium text-muted-foreground">Total Invoices</p>
            <p className="text-2xl font-bold font-mono mt-1" data-testid="stat-total">
              {stats.total_invoices}
            </p>
          </Card>
          <Card 
            className={`p-6 cursor-pointer transition-all hover:shadow-md hover:scale-[1.02] ${statusFilter === "draft" ? "ring-2 ring-slate-500" : ""}`}
            onClick={() => setStatusFilter("draft")}
            data-testid="stat-card-draft"
          >
            <p className="text-sm font-medium text-muted-foreground">Draft</p>
            <p className="text-2xl font-bold font-mono mt-1 text-slate-600" data-testid="stat-draft">
              {stats.draft_count}
            </p>
          </Card>
          <Card 
            className={`p-6 cursor-pointer transition-all hover:shadow-md hover:scale-[1.02] ${statusFilter === "sent" ? "ring-2 ring-blue-500" : ""}`}
            onClick={() => setStatusFilter("sent")}
            data-testid="stat-card-sent"
          >
            <p className="text-sm font-medium text-muted-foreground">Sent</p>
            <p className="text-2xl font-bold font-mono mt-1 text-blue-600" data-testid="stat-sent">
              {stats.sent_count}
            </p>
          </Card>
          <Card 
            className={`p-6 cursor-pointer transition-all hover:shadow-md hover:scale-[1.02] ${statusFilter === "paid" ? "ring-2 ring-emerald-500" : ""}`}
            onClick={() => setStatusFilter("paid")}
            data-testid="stat-card-paid"
          >
            <p className="text-sm font-medium text-muted-foreground">Paid</p>
            <p className="text-2xl font-bold font-mono mt-1 text-emerald-600" data-testid="stat-paid">
              {stats.paid_count}
            </p>
          </Card>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search invoices..."
            className="pl-10 h-12"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-testid="search-input"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[180px] h-12" data-testid="status-filter">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="paid">Paid</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Invoice List */}
      <div className="space-y-4" data-testid="invoices-container">
        {loading ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">Loading invoices...</p>
          </div>
        ) : filteredInvoices.length === 0 ? (
          <Card className="p-12 text-center">
            <FileText className="w-12 h-12 mx-auto text-muted-foreground/50" />
            <h3 className="text-lg font-semibold mt-4">No invoices found</h3>
            <p className="text-muted-foreground mt-1">
              {searchQuery || statusFilter !== "all"
                ? "Try adjusting your filters"
                : "Create your first invoice to get started"}
            </p>
            {!searchQuery && statusFilter === "all" && (
              <Link to="/invoices/new">
                <Button className="mt-6 gap-2" data-testid="empty-create-btn">
                  <Plus className="w-4 h-4" />
                  Create Invoice
                </Button>
              </Link>
            )}
          </Card>
        ) : (
          filteredInvoices.map((invoice, index) => (
            <div
              key={invoice.id}
              className="animate-fade-in"
              style={{ animationDelay: `${index * 0.05}s` }}
            >
              <InvoiceCard invoice={invoice} />
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default InvoiceList;
