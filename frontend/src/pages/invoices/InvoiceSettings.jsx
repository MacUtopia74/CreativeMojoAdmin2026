// Invoice settings page — manages the business + bank details that appear
// on every generated invoice PDF. The standalone Pay-Paperwork app had its
// own password-protection block here; that's been removed because the host
// admin app already gates this page behind admin JWT auth.
import { useState, useEffect } from "react";
import api from "@/lib/api";
import { Save, Settings as SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";

export default function InvoiceSettings() {
  const [settings, setSettings] = useState({
    business_name: "",
    business_address_line1: "",
    business_address_line2: "",
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
        const { data } = await api.get("/invoices/settings/me");
        setSettings(data);
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
      await api.put("/invoices/settings/me", settings);
      toast.success("Settings saved");
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

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
        <h1 className="text-4xl font-bold tracking-tight font-display" data-testid="page-title">
          Invoice Settings
        </h1>
        <p className="text-muted-foreground mt-1">
          Business and bank details printed on every invoice PDF.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card className="p-6">
          <h3 className="text-lg font-semibold mb-4  flex items-center gap-2">
            <SettingsIcon className="w-5 h-5" /> Business Details
          </h3>
          <p className="text-sm text-muted-foreground mb-4">These details appear on your invoices.</p>
          <div className="space-y-4">
            <div>
              <Label>Business Name</Label>
              <Input className="mt-2" value={settings.business_name || ""} onChange={(e) => setSettings((p) => ({ ...p, business_name: e.target.value }))} data-testid="business-name-input" />
            </div>
            <div>
              <Label>Address Line 1</Label>
              <Input className="mt-2" value={settings.business_address_line1 || ""} onChange={(e) => setSettings((p) => ({ ...p, business_address_line1: e.target.value }))} data-testid="business-address-line1-input" />
            </div>
            <div>
              <Label>Address Line 2</Label>
              <Input className="mt-2" value={settings.business_address_line2 || ""} onChange={(e) => setSettings((p) => ({ ...p, business_address_line2: e.target.value }))} data-testid="business-address-line2-input" />
            </div>
            <div>
              <Label>Phone</Label>
              <Input className="mt-2" value={settings.business_phone || ""} onChange={(e) => setSettings((p) => ({ ...p, business_phone: e.target.value }))} data-testid="business-phone-input" />
            </div>
            <div>
              <Label>Email</Label>
              <Input type="email" className="mt-2" value={settings.business_email || ""} onChange={(e) => setSettings((p) => ({ ...p, business_email: e.target.value }))} data-testid="business-email-input" />
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <h3 className="text-lg font-semibold mb-4 ">Payment Details</h3>
          <p className="text-sm text-muted-foreground mb-4">Appear at the bottom of every invoice.</p>
          <div className="space-y-4">
            <div>
              <Label>Payment Instructions</Label>
              <Input className="mt-2" value={settings.bank_payment_info || ""} onChange={(e) => setSettings((p) => ({ ...p, bank_payment_info: e.target.value }))} data-testid="bank-payment-info-input" />
            </div>
            <div>
              <Label>Account Name</Label>
              <Input className="mt-2" value={settings.bank_account_name || ""} onChange={(e) => setSettings((p) => ({ ...p, bank_account_name: e.target.value }))} data-testid="bank-account-name-input" />
            </div>
            <div>
              <Label>Sort Code / Account</Label>
              <Input className="mt-2" value={settings.bank_details || ""} onChange={(e) => setSettings((p) => ({ ...p, bank_details: e.target.value }))} data-testid="bank-details-input" />
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
