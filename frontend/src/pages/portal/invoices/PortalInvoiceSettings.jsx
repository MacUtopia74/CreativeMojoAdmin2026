// Portal Invoice Settings — manages the business + bank details that
// appear on every generated invoice PDF. Includes a new "Franchise name"
// field that prints large at the top of every invoice.
import { useState, useEffect } from "react";
import api from "@/lib/api";
import { Save, Settings as SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";

export default function PortalInvoiceSettings() {
  const [settings, setSettings] = useState({
    franchise_name: "",
    business_name: "",
    business_address_line1: "",
    business_address_line2: "",
    business_city: "",
    business_county: "",
    business_postcode: "",
    business_phone: "",
    business_email: "",
    bank_payment_info: "",
    bank_account_name: "",
    bank_details: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/portal/invoices/settings/me");
        // Merge with empty defaults so every input remains controlled
        // even when an older settings doc is missing the newer fields.
        setSettings((prev) => ({ ...prev, ...data }));
      } catch {
        toast.error("Failed to fetch settings");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.put("/portal/invoices/settings/me", settings);
      toast.success("Settings saved");
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const field = (key) => settings[key] ?? "";
  const setField = (key) => (e) => setSettings((p) => ({ ...p, [key]: e.target.value }));

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-2xl" data-testid="invoice-settings-page">
      <div>
        <h1 className="text-5xl font-bold tracking-tight text-slate-900" data-testid="page-title">
          Invoice Settings
        </h1>
        <p className="text-muted-foreground mt-2">
          Business and bank details printed on every invoice PDF.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card className="p-6">
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <SettingsIcon className="w-5 h-5" /> Business Details
          </h3>
          <p className="text-sm text-muted-foreground mb-4">These details appear on every invoice you generate.</p>
          <div className="space-y-4">
            <div>
              <Label>Franchise Name</Label>
              <p className="text-xs text-muted-foreground mb-1.5">
                Shown large at the top of every invoice (e.g. "Creative Mojo North &amp; West Devon").
              </p>
              <Input value={field("franchise_name")} onChange={setField("franchise_name")} data-testid="franchise-name-input" />
            </div>
            <div>
              <Label>Your Name / Business Name</Label>
              <Input className="mt-2" value={field("business_name")} onChange={setField("business_name")} data-testid="business-name-input" />
            </div>
            <div>
              <Label>Address Line 1</Label>
              <Input className="mt-2" value={field("business_address_line1")} onChange={setField("business_address_line1")} data-testid="business-address-line1-input" />
            </div>
            <div>
              <Label>Address Line 2</Label>
              <Input className="mt-2" value={field("business_address_line2")} onChange={setField("business_address_line2")} data-testid="business-address-line2-input" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label>Town / City</Label>
                <Input className="mt-2" value={field("business_city")} onChange={setField("business_city")} data-testid="business-city-input" />
              </div>
              <div>
                <Label>County</Label>
                <Input className="mt-2" value={field("business_county")} onChange={setField("business_county")} data-testid="business-county-input" />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label>Postcode</Label>
                <Input className="mt-2 font-mono" value={field("business_postcode")} onChange={setField("business_postcode")} data-testid="business-postcode-input" />
              </div>
              <div>
                <Label>Phone</Label>
                <Input className="mt-2" value={field("business_phone")} onChange={setField("business_phone")} data-testid="business-phone-input" />
              </div>
            </div>
            <div>
              <Label>Email</Label>
              <Input type="email" className="mt-2" value={field("business_email")} onChange={setField("business_email")} data-testid="business-email-input" />
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <h3 className="text-lg font-semibold mb-4">Payment Details</h3>
          <p className="text-sm text-muted-foreground mb-4">Appear at the bottom of every invoice.</p>
          <div className="space-y-4">
            <div>
              <Label>Payment Instructions</Label>
              <Input className="mt-2" value={field("bank_payment_info")} onChange={setField("bank_payment_info")} data-testid="bank-payment-info-input" />
            </div>
            <div>
              <Label>Account Name</Label>
              <Input className="mt-2" value={field("bank_account_name")} onChange={setField("bank_account_name")} data-testid="bank-account-name-input" />
            </div>
            <div>
              <Label>Sort Code / Account</Label>
              <Input className="mt-2" value={field("bank_details")} onChange={setField("bank_details")} data-testid="bank-details-input" />
            </div>
          </div>
        </Card>

        <Button type="submit" className="w-full h-12 rounded-full" disabled={saving} data-testid="save-settings-btn">
          <Save className="w-4 h-4 mr-2" />{saving ? "Saving…" : "Save Settings"}
        </Button>
      </form>
    </div>
  );
}
