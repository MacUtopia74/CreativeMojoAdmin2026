// Xero settings page — lives under Admin → Xero in the sidebar.
//
// Lets the franchise owner:
//   1) See whether Xero env vars are populated on the backend.
//   2) Click "Connect Xero" to launch the OAuth popup.
//   3) See the connected tenant name + expiry, with a disconnect button.
//
// All the heavy lifting (token exchange, refresh, webhook validation)
// happens in /api/xero/* — this page is a thin status board.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, ExternalLink, ArrowLeft } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import api from "@/lib/api";

export default function XeroSettingsPage() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  // Display preference (stored in localStorage so it survives reloads and
  // is read by /orders to suppress the small "Legacy (#1234)" tag under
  // each ID). The Orders page listens for the custom event we dispatch.
  const [hideLegacyIds, setHideLegacyIdsState] = useState(() => localStorage.getItem("hide_legacy_ids") === "1");
  const setHideLegacyIds = (v) => {
    setHideLegacyIdsState(v);
    if (v) localStorage.setItem("hide_legacy_ids", "1");
    else localStorage.removeItem("hide_legacy_ids");
    window.dispatchEvent(new Event("hide-legacy-ids-changed"));
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await api.get("/xero/status");
      setStatus(data);
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not load Xero status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Listen for the postMessage the callback page sends when OAuth completes.
  useEffect(() => {
    const onMsg = (ev) => {
      if (ev?.data?.type === "xero-connected") { setConnecting(false); load(); }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [load]);

  const handleConnect = async () => {
    setConnecting(true);
    setError("");
    try {
      const { data } = await api.get("/xero/connect");
      // Open in popup so the admin stays on the settings page.
      const w = 720, h = 760;
      const left = Math.max(0, (window.screen.width - w) / 2);
      const top  = Math.max(0, (window.screen.height - h) / 2);
      const popup = window.open(data.url, "xero-oauth", `width=${w},height=${h},left=${left},top=${top}`);
      if (!popup) {
        // Popup blocked — fall back to a full-page redirect.
        window.location.href = data.url;
      } else {
        // If the user just closes the popup without completing, re-enable the button.
        const poll = setInterval(() => {
          if (popup.closed) { clearInterval(poll); setConnecting(false); load(); }
        }, 800);
      }
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not start Xero connect.");
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm("Disconnect Xero? Existing invoices stay linked but new ones can't be created until you reconnect.")) return;
    try {
      await api.post("/xero/disconnect");
      load();
    } catch (e) {
      setError(e?.response?.data?.detail || "Disconnect failed.");
    }
  };

  return (
    <div className="min-h-screen bg-stone-50 px-8 py-8" data-testid="xero-settings-page">
      <Link to="/orders" className="text-xs text-stone-500 hover:text-stone-900 inline-flex items-center gap-1">
        <ArrowLeft className="w-3 h-3" /> Back to orders
      </Link>
      <div className="mt-3 flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Admin · Integrations</div>
          <h1 className="text-3xl font-display font-black text-stone-950 mt-1">Xero</h1>
          <p className="text-sm text-stone-600 mt-1 max-w-2xl">
            Connects this admin to your Creative Mojo Ltd. Xero organisation so completed orders can be
            invoiced in one click and paid invoices flow back as "Paid" on the order list.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          data-testid="xero-refresh"
          className="p-2 border border-stone-300 bg-white text-stone-900 hover:bg-stone-50 rounded-lg disabled:opacity-40"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error && (
        <div className="mt-4 p-3 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-800 flex items-center gap-2" data-testid="xero-error">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      <div className="mt-6 bg-white border border-stone-200 rounded-2xl p-6 max-w-2xl">
        {loading && !status ? (
          <div className="text-sm text-stone-500"><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading…</div>
        ) : status?.connected ? (
          <div data-testid="xero-connected-card">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-600" />
              <span className="text-sm font-bold uppercase tracking-wider text-emerald-700">Connected</span>
            </div>
            <Row label="Organisation" value={status.tenant_name || status.tenant_id} />
            <Row label="Connected" value={status.connected_at ? new Date(status.connected_at).toLocaleString("en-GB") : "—"} />
            <Row label="Last refreshed" value={status.updated_at ? new Date(status.updated_at).toLocaleString("en-GB") : "—"} />
            <Row label="Access expires" value={status.expires_at ? new Date(status.expires_at).toLocaleString("en-GB") : "—"} />
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={handleDisconnect}
                data-testid="xero-disconnect"
                className="px-4 py-2 border border-stone-300 bg-white text-stone-900 text-xs font-bold uppercase tracking-wider rounded-lg hover:bg-rose-50 hover:border-rose-300 hover:text-rose-700"
              >
                Disconnect
              </button>
              <button
                type="button"
                onClick={handleConnect}
                disabled={connecting}
                data-testid="xero-reconnect"
                className="px-4 py-2 bg-stone-950 text-white text-xs font-bold uppercase tracking-wider rounded-lg hover:bg-stone-800 disabled:opacity-50"
              >
                {connecting ? "Opening…" : "Re-connect"}
              </button>
            </div>
          </div>
        ) : status?.configured ? (
          <div data-testid="xero-not-connected-card">
            <div className="flex items-center gap-2 mb-3">
              <AlertCircle className="w-5 h-5 text-amber-600" />
              <span className="text-sm font-bold uppercase tracking-wider text-amber-700">Not connected</span>
            </div>
            <p className="text-sm text-stone-700 mb-4">
              Credentials are configured. Click below to log in to Xero and grant access. You'll be redirected to
              <span className="font-mono mx-1 px-1.5 py-0.5 bg-stone-100 rounded">login.xero.com</span> in a popup,
              then bounced back here when you're done.
            </p>
            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting}
              data-testid="xero-connect"
              className="px-5 py-2.5 bg-[#13B5EA] text-white text-sm font-bold uppercase tracking-wider rounded-lg hover:bg-[#0e9ed1] disabled:opacity-50 inline-flex items-center gap-2"
            >
              {connecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
              Connect to Xero
            </button>
            <div className="mt-5 text-xs text-stone-500">
              Redirect URI on file: <code className="px-1.5 py-0.5 bg-stone-100 rounded">{status?.redirect_uri || "—"}</code>
            </div>
          </div>
        ) : (
          <div data-testid="xero-unconfigured-card">
            <div className="flex items-center gap-2 mb-3">
              <AlertCircle className="w-5 h-5 text-rose-600" />
              <span className="text-sm font-bold uppercase tracking-wider text-rose-700">Not configured</span>
            </div>
            <p className="text-sm text-stone-700 mb-3">
              Add these to <code className="px-1.5 py-0.5 bg-stone-100 rounded">backend/.env</code> and restart the
              backend before connecting:
            </p>
            <pre className="bg-stone-50 border border-stone-200 rounded-lg p-3 text-xs font-mono text-stone-800 overflow-x-auto">
{`XERO_CLIENT_ID=...
XERO_CLIENT_SECRET=...
XERO_REDIRECT_URI=https://your-domain/api/xero/callback
XERO_WEBHOOK_SIGNING_KEY=...   # optional, for payment webhook`}
            </pre>
            <p className="text-xs text-stone-500 mt-3">
              Get your Client ID / Secret from{" "}
              <a className="underline hover:text-stone-900" target="_blank" rel="noopener noreferrer" href="https://developer.xero.com/myapps">developer.xero.com/myapps</a>.
            </p>
          </div>
        )}
      </div>

      {/* UI preferences card — adjacent to Xero settings so admins find it
          right after configuring the integration. */}
      <div className="mt-6 bg-white border border-stone-200 rounded-2xl p-6 max-w-2xl" data-testid="orders-display-prefs-card">
        <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">Orders display</div>
        <h2 className="text-lg font-display font-black text-stone-950 mb-3">Hide legacy IDs</h2>
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm text-stone-700 max-w-md">
            When on, the small <code className="px-1 bg-stone-100 rounded text-[11px]">Legacy (#1234)</code> tag is hidden
            under each migrated order on the main Orders list. Useful once you're confident the new continuous numbering
            is the only one being referenced.
          </p>
          <Switch
            checked={hideLegacyIds}
            onCheckedChange={setHideLegacyIds}
            data-testid="hide-legacy-toggle"
            className="mt-1 data-[state=checked]:bg-stone-900 data-[state=unchecked]:bg-stone-300"
          />
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-3 py-1.5 text-sm">
      <div className="text-stone-500 uppercase tracking-wider text-[10px] font-bold pt-1">{label}</div>
      <div className="text-stone-900 break-all">{value || "—"}</div>
    </div>
  );
}
