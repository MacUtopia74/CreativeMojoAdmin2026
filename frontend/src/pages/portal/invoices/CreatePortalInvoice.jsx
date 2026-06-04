import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import api from "@/lib/api";
import { API_BASE } from "@/lib/api";
import { format } from "date-fns";
import { Plus, Trash2, Save, ArrowLeft, CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Calendar } from "@/components/ui/calendar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "sonner";
import StatusBadge from "@/components/invoices/StatusBadge";


function LineItemRow({ item, index, onUpdate, onRemove, canRemove }) {
  return (
    <div className="p-4 border rounded-lg mb-4" data-testid={`line-item-${index}`}>
      <div className="flex gap-2">
        <div className="flex-1">
          <Label>Description</Label>
          <Input className="mt-1" value={item.description} onChange={(e) => onUpdate(index, "description", e.target.value)} data-testid={`line-item-desc-${index}`} />
        </div>
        {canRemove && (
          <Button type="button" variant="ghost" size="icon" className="mt-6" onClick={() => onRemove(index)}>
            <Trash2 className="w-4 h-4 text-destructive" />
          </Button>
        )}
      </div>
      <div className="mt-2">
        <Label>Date of class / event (optional)</Label>
        <Input
          type="date"
          className="mt-1 font-mono"
          value={item.class_date || ""}
          onChange={(e) => onUpdate(index, "class_date", e.target.value)}
          data-testid={`line-item-class-date-${index}`}
        />
      </div>
      <div className="grid grid-cols-3 gap-2 mt-2">
        <div>
          <Label>Qty</Label>
          <Input type="number" className="mt-1 font-mono" value={item.quantity} onChange={(e) => onUpdate(index, "quantity", e.target.value)} data-testid={`line-item-qty-${index}`} />
        </div>
        <div>
          <Label>Price (£)</Label>
          <Input type="number" step="0.01" className="mt-1 font-mono" value={item.unit_price} onChange={(e) => onUpdate(index, "unit_price", e.target.value)} data-testid={`line-item-price-${index}`} />
        </div>
        <div>
          <Label>Amount</Label>
          <Input className="mt-1 font-mono bg-muted" value={`£${Number(item.amount).toFixed(2)}`} disabled />
        </div>
      </div>
    </div>
  );
}

function InvoicePreview({ formData, subtotal, discountAmount, taxAmount, total, settings }) {
  return (
    <Card className="bg-white shadow-xl sticky top-24 overflow-hidden" data-testid="invoice-preview" style={{ aspectRatio: '210/297' }}>
      <div className="h-full flex flex-col p-12">
        {/* Brand header — logo top-left + franchise name top-right */}
        <div className="flex items-start justify-between gap-6 border-b border-slate-200 pb-4 mb-6">
          <img
            src="/cm-invoice-logo.png"
            alt="Creative Mojo"
            className="h-12 w-auto object-contain shrink-0"
            data-testid="invoice-preview-logo"
          />
          {(settings?.franchise_name || settings?.business_name) && (
            <div className="text-right">
              <p className="text-2xl font-bold text-slate-900 tracking-tight leading-tight">
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
              <p className="font-mono text-lg mt-1 text-slate-700">{formData.invoice_number || "SCD-000"}</p>
            </div>
            <StatusBadge status={formData.status} />
          </div>
          
          {/* Business Details & Invoice To */}
          <div className="grid grid-cols-2 gap-8 mb-8 text-sm">
            <div>
              <p className="text-slate-500 uppercase tracking-wider text-xs font-semibold mb-1">Invoice to:</p>
              {formData.client_name ? (
                <div>
                  {formData.client_name && <p className="font-semibold text-slate-900">{formData.client_name}</p>}
                  {formData.client_email && <p className="text-slate-600 text-sm">{formData.client_email}</p>}
                  {formData.client_email2 && <p className="text-slate-600 text-sm">{formData.client_email2}</p>}
                  {formData.client_phone && <p className="text-slate-600 text-sm">{formData.client_phone}</p>}
                  {formData.client_address && <p className="text-slate-600 text-sm">{formData.client_address}</p>}
                </div>
              ) : <p className="text-slate-400 italic text-sm">Select a client</p>}
            </div>
            <div className="text-right text-slate-600 space-y-0.5">
              {settings?.business_name && <p className="font-semibold text-slate-900">{settings.business_name}</p>}
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
          
          <div className="mb-8 text-sm">
            <div className="space-y-4">
              <div>
                <p className="text-slate-500 uppercase tracking-wider text-xs font-semibold">Issue Date</p>
                <p className="font-mono text-slate-900 mt-1">{formData.issue_date ? format(new Date(formData.issue_date), "dd/MM/yyyy") : ""}</p>
              </div>
              <div>
                <p className="text-slate-500 uppercase tracking-wider text-xs font-semibold">Due Date</p>
                <p className="font-mono text-slate-900 mt-1">{formData.due_date ? format(new Date(formData.due_date), "dd/MM/yyyy") : ""}</p>
              </div>
            </div>
          </div>
          
          <table className="w-full text-sm mb-6 mt-8">
            <thead>
              <tr className="border-b-2 border-slate-200">
                <th className="text-left py-3 text-xs uppercase text-slate-500">Description</th>
                <th className="text-right py-3 text-xs uppercase text-slate-500">Qty</th>
                <th className="text-right py-3 text-xs uppercase text-slate-500">Price</th>
                <th className="text-right py-3 text-xs uppercase text-slate-500">Amount</th>
              </tr>
            </thead>
            <tbody>
              {formData.line_items.map((item, i) => (
                <tr key={item._uid || `${i}-${item.description || ""}`} className="border-b border-slate-100">
                  <td className="py-3 text-slate-900">{item.description || "—"}</td>
                  <td className="py-3 text-right font-mono text-slate-700">{item.quantity}</td>
                  <td className="py-3 text-right font-mono text-slate-700">£{Number(item.unit_price).toFixed(2)}</td>
                  <td className="py-3 text-right font-mono font-medium text-slate-900">£{Number(item.amount).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          
          <div className="border-t-2 border-slate-200 pt-4 space-y-2 mt-6">
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Subtotal</span>
              <span className="font-mono text-slate-900">£{subtotal.toFixed(2)}</span>
            </div>
            {Number(formData.discount_rate) > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Discount ({formData.discount_rate}%)</span>
                <span className="font-mono text-emerald-600">-£{discountAmount.toFixed(2)}</span>
              </div>
            )}
            {Number(formData.tax_rate) > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Tax ({formData.tax_rate}%)</span>
                <span className="font-mono text-slate-900">£{taxAmount.toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between text-base font-bold pt-3 border-t border-slate-200">
              <span className="text-slate-900">Total</span>
              <span className="font-mono text-slate-900">£{total.toFixed(2)}</span>
            </div>
          </div>
        </div>
        
        {/* Footer - Bank Details (always at bottom) */}
        <div className="pt-6 border-t border-slate-200 text-sm text-slate-600 mt-auto">
          <p>{settings?.bank_payment_info || "Payments by BACS/Online should be made to:"}</p>
          <p className="font-medium text-slate-900">{settings?.bank_account_name || "Sandra Caldeira-Dunkerley"}</p>
          <p>{settings?.bank_details || "Sort Code: 40-07-33 Account No. 62079658"}</p>
        </div>
      </div>
    </Card>
  );
}

function CreateInvoice() {
  const navigate = useNavigate();
  const [clients, setClients] = useState([]);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(false);
  const [issueDateOpen, setIssueDateOpen] = useState(false);
  const [dueDateOpen, setDueDateOpen] = useState(false);
  
  const today = new Date();
  const fourteenDays = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);

  // Per-line stable IDs — used as React keys so reorders/removes keep
  // each row's input focus + local state intact. Runtime-only, stripped
  // before POST so we don't pollute the saved invoice document.
  const _newLineUid = () =>
    (globalThis.crypto?.randomUUID?.() || `li-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  const [formData, setFormData] = useState({
    client_id: "",
    client_name: "",
    client_email: "",
    client_email2: "",
    client_phone: "",
    client_address: "",
    invoice_number: "",
    issue_date: format(today, "yyyy-MM-dd"),
    due_date: format(fourteenDays, "yyyy-MM-dd"),
    line_items: [{ _uid: _newLineUid(), description: "", quantity: 1, unit_price: 0, amount: 0 }],
    tax_rate: 0,
    discount_rate: 0,
    notes: "",
    payment_terms: "Net 14 Days",
    status: "draft",
  });

  useEffect(() => {
    api.get("/portal/invoices/clients").then(r => setClients(r.data)).catch(() => {});
    api.get("/portal/invoices/next-number").then(r => setFormData(p => ({ ...p, invoice_number: r.data.invoice_number }))).catch(() => {});
    api.get("/portal/invoices/settings/me").then(r => setSettings(r.data)).catch(() => {});
  }, []);

  const handleClientChange = (clientId) => {
    const client = clients.find(c => c.id === clientId);
    if (client) {
      // Build display info based on show_* flags
      const displayParts = [];
      if (client.show_address !== false && client.address) displayParts.push(client.address);
      if (client.show_city !== false && client.city) displayParts.push(client.city);
      if (client.show_country !== false && client.country) displayParts.push(client.country);
      
      setFormData(p => ({
        ...p,
        client_id: client.id,
        client_name: client.show_name !== false ? client.name : "",
        client_email: client.show_email !== false ? (client.email || "") : "",
        client_email2: client.show_email2 !== false ? (client.email2 || "") : "",
        client_phone: client.show_phone !== false ? (client.phone || "") : "",
        client_address: displayParts.join(", "),
        // Store raw values too for reference
        client_display: {
          show_name: client.show_name !== false,
          show_email: client.show_email !== false,
          show_email2: client.show_email2 !== false,
          show_phone: client.show_phone !== false,
          show_address: client.show_address !== false,
          show_city: client.show_city !== false,
          show_country: client.show_country !== false,
        }
      }));
    }
  };

  const handleLineItemChange = (index, field, value) => {
    setFormData(prev => {
      const newItems = [...prev.line_items];
      newItems[index] = { ...newItems[index], [field]: value };
      if (field === "quantity" || field === "unit_price") {
        newItems[index].amount = Number(newItems[index].quantity) * Number(newItems[index].unit_price);
      }
      return { ...prev, line_items: newItems };
    });
  };

  const addLineItem = () => {
    setFormData(p => ({ ...p, line_items: [...p.line_items, { _uid: _newLineUid(), description: "", quantity: 1, unit_price: 0, amount: 0 }] }));
  };

  const removeLineItem = (index) => {
    if (formData.line_items.length > 1) {
      setFormData(p => ({ ...p, line_items: p.line_items.filter((_, i) => i !== index) }));
    }
  };

  const subtotal = formData.line_items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const discountAmount = subtotal * (Number(formData.discount_rate) || 0) / 100;
  const taxAmount = (subtotal - discountAmount) * (Number(formData.tax_rate) || 0) / 100;
  const total = subtotal - discountAmount + taxAmount;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.client_id) { toast.error("Please select a client"); return; }
    if (!formData.line_items.some(i => i.description && i.amount > 0)) { toast.error("Please add at least one line item"); return; }
    setLoading(true);
    try {
      // Strip runtime-only `_uid` from line items before POST — it's a
      // React-key helper, not part of the invoice schema.
      const cleanItems = formData.line_items.map(({ _uid, ...rest }) => rest);  // eslint-disable-line no-unused-vars
      await api.post("/portal/invoices", { ...formData, line_items: cleanItems, subtotal, tax_amount: taxAmount, discount_amount: discountAmount, total });
      toast.success("Invoice created successfully");
      navigate("/portal/invoices");
    } catch (err) { toast.error("Failed to create invoice"); }
    setLoading(false);
  };

  const handleIssueDateSelect = (d) => {
    if (d) {
      setFormData(p => ({ ...p, issue_date: format(d, "yyyy-MM-dd") }));
      setIssueDateOpen(false);
    }
  };

  const handleDueDateSelect = (d) => {
    if (d) {
      setFormData(p => ({ ...p, due_date: format(d, "yyyy-MM-dd") }));
      setDueDateOpen(false);
    }
  };

  const issueDate = formData.issue_date ? new Date(formData.issue_date) : undefined;
  const dueDate = formData.due_date ? new Date(formData.due_date) : undefined;

  return (
    <div className="space-y-8" data-testid="create-invoice-page">
      <div className="flex items-center gap-4">
        <Button variant="ghost" onClick={() => navigate(-1)} data-testid="back-btn">
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-4xl font-bold tracking-tight font-display" data-testid="page-title">Create Invoice</h1>
          <p className="text-muted-foreground mt-1">Fill in the details below</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className="lg:col-span-5 space-y-6">
            <Card className="p-6">
              <h3 className="text-lg font-semibold mb-4 ">Client</h3>
              <Label>Select Client</Label>
              <Select value={formData.client_id} onValueChange={handleClientChange}>
                <SelectTrigger className="h-12 mt-2" data-testid="client-select">
                  <SelectValue placeholder="Choose a client" />
                </SelectTrigger>
                <SelectContent>
                  {clients.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {formData.client_id && (
                <div className="p-4 bg-muted rounded-lg mt-4">
                  <p className="font-medium">{formData.client_name}</p>
                  <p className="text-sm text-muted-foreground">{formData.client_email}</p>
                </div>
              )}
            </Card>

            <Card className="p-6">
              <h3 className="text-lg font-semibold mb-4 ">Invoice Details</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Invoice Number</Label>
                  <Input className="h-12 mt-2 font-mono" value={formData.invoice_number} onChange={(e) => setFormData(p => ({ ...p, invoice_number: e.target.value }))} data-testid="invoice-number-input" />
                </div>
                <div>
                  <Label>Payment Terms</Label>
                  <Select value={formData.payment_terms} onValueChange={(v) => setFormData(p => ({ ...p, payment_terms: v }))}>
                    <SelectTrigger className="h-12 mt-2" data-testid="payment-terms-select"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Net 7 Days">Net 7 Days</SelectItem>
                      <SelectItem value="Net 14 Days">Net 14 Days</SelectItem>
                      <SelectItem value="Net 30 Days">Net 30 Days</SelectItem>
                      <SelectItem value="Due on Receipt">Due on Receipt</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Issue Date</Label>
                  <Popover open={issueDateOpen} onOpenChange={setIssueDateOpen}>
                    <PopoverTrigger asChild>
                      <Button type="button" variant="outline" className="w-full h-12 mt-2 justify-start font-mono" data-testid="issue-date-btn">
                        <CalendarIcon className="mr-2 h-4 w-4" />{formData.issue_date}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar mode="single" selected={issueDate} onSelect={handleIssueDateSelect} />
                    </PopoverContent>
                  </Popover>
                </div>
                <div>
                  <Label>Due Date</Label>
                  <Popover open={dueDateOpen} onOpenChange={setDueDateOpen}>
                    <PopoverTrigger asChild>
                      <Button type="button" variant="outline" className="w-full h-12 mt-2 justify-start font-mono" data-testid="due-date-btn">
                        <CalendarIcon className="mr-2 h-4 w-4" />{formData.due_date}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar mode="single" selected={dueDate} onSelect={handleDueDateSelect} />
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
            </Card>

            <Card className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold ">Line Items</h3>
                <Button type="button" variant="outline" size="sm" onClick={addLineItem} data-testid="add-line-item-btn">
                  <Plus className="w-4 h-4 mr-1" /> Add
                </Button>
              </div>
              {formData.line_items.map((item, idx) => (
                <LineItemRow key={item._uid || `idx-${idx}`} item={item} index={idx} onUpdate={handleLineItemChange} onRemove={removeLineItem} canRemove={formData.line_items.length > 1} />
              ))}
            </Card>

            <Card className="p-6">
              <h3 className="text-lg font-semibold mb-4 ">Tax & Discount</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Tax Rate (%)</Label>
                  <Input type="number" step="0.1" className="h-12 mt-2 font-mono" value={formData.tax_rate} onChange={(e) => setFormData(p => ({ ...p, tax_rate: e.target.value }))} data-testid="tax-rate-input" />
                </div>
                <div>
                  <Label>Discount Rate (%)</Label>
                  <Input type="number" step="0.1" className="h-12 mt-2 font-mono" value={formData.discount_rate} onChange={(e) => setFormData(p => ({ ...p, discount_rate: e.target.value }))} data-testid="discount-rate-input" />
                </div>
              </div>
            </Card>

            <Card className="p-6">
              <h3 className="text-lg font-semibold mb-4 ">Notes</h3>
              <Textarea placeholder="Additional notes..." className="min-h-[80px]" value={formData.notes} onChange={(e) => setFormData(p => ({ ...p, notes: e.target.value }))} data-testid="notes-input" />
            </Card>

            <Button type="submit" className="w-full h-12 rounded-full bg-[#dedd0a] hover:brightness-95 text-stone-950" disabled={loading} data-testid="save-invoice-btn">
              <Save className="w-4 h-4 mr-2" />{loading ? "Saving..." : "Save Invoice"}
            </Button>
          </div>

          <div className="lg:col-span-7">
            <InvoicePreview formData={formData} subtotal={subtotal} discountAmount={discountAmount} taxAmount={taxAmount} total={total} settings={settings} />
          </div>
        </div>
      </form>
    </div>
  );
}

export default CreateInvoice;
