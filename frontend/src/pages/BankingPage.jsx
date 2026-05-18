import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import api from "@/lib/api";
import { toast } from "sonner";
import {
  Banknote,
  Loader2,
  RefreshCw,
  Link as LinkIcon,
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Calendar,
  Building2,
  PoundSterling,
  X,
  Search,
} from "lucide-react";

const STATUS_PILL = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  expired: "bg-red-50 text-red-700 border-red-200",
};

const moneyFmt = (n, currency = "GBP") =>
  n == null
    ? "—"
    : new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(n);

export default function BankingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [dashboard, setDashboard] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [direction, setDirection] = useState("in");
  const [search, setSearch] = useState("");

  // ----- Loading helpers -----
  const loadStatus = useCallback(async () => {
    try {
      const { data } = await api.get("/banking/status");
      setStatus(data);
      return data;
    } catch {
      setStatus({ connected: false });
      return { connected: false };
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    try {
      const { data } = await api.get("/banking/dashboard", { params: { months: 6 } });
      setDashboard(data);
    } catch (e) {
      // Connection might have expired — surface it nicely
      if (e?.response?.status === 401) {
        toast.error("Bank consent expired — please reconnect.");
      }
    }
  }, []);

  const loadTransactions = useCallback(async () => {
    try {
      const { data } = await api.get("/banking/transactions", {
        params: { direction, search: search || undefined, limit: 250 },
      });
      setTransactions(data.transactions || []);
    } catch {/* ignore */}
  }, [direction, search]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const s = await loadStatus();
      if (s?.connected) {
        await Promise.all([loadDashboard(), loadTransactions()]);
      }
      setLoading(false);
      // Toast feedback from callback
      if (searchParams.get("connected")) {
        toast.success("HSBC connected — your feed is now live.");
        setSearchParams({});
      } else if (searchParams.get("error")) {
        toast.error(`Bank connection failed: ${searchParams.get("error")}`);
        setSearchParams({});
      }
    })();
  }, [loadStatus, loadDashboard, loadTransactions, searchParams, setSearchParams]);

  // Re-fetch transactions when filter changes
  useEffect(() => {
    if (status?.connected) loadTransactions();
  }, [direction, status?.connected, loadTransactions]);

  // ----- Actions -----
  const handleConnect = async () => {
    setConnecting(true);
    try {
      const { data } = await api.get("/banking/auth-url");
      // Full-page navigation away — TrueLayer's hosted page handles the SCA
      window.location.href = data.url;
    } catch (e) {
      toast.error("Could not start bank connection");
      setConnecting(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const { data } = await api.post("/banking/sync");
      toast.success(`Synced · ${data.new_transactions} new transaction${data.new_transactions === 1 ? "" : "s"}`);
      await Promise.all([loadStatus(), loadDashboard(), loadTransactions()]);
    } catch (e) {
      toast.error("Sync failed — bank consent may have expired");
    } finally {
      setSyncing(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm("Disconnect HSBC? You'll need to re-authorise to reconnect.")) return;
    await api.delete("/banking/connection");
    toast.success("Disconnected");
    setStatus({ connected: false });
    setDashboard(null);
    setTransactions([]);
  };

  // ----- Renders -----
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh] text-stone-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading banking…
      </div>
    );
  }

  // Not connected — show big connect CTA
  if (!status?.connected) {
    const env = (process.env.REACT_APP_TRUELAYER_ENV || "sandbox");
    return (
      <div className="max-w-2xl space-y-6" data-testid="banking-empty">
        <div>
          <h1 className="text-4xl font-bold tracking-tight" data-testid="page-title">Banking</h1>
          <p className="text-stone-500 mt-1">
            Read-only Open Banking feed — see what's come into the account, daily.
          </p>
        </div>
        <div className="bg-white border border-stone-200 rounded-2xl p-8 text-center space-y-5">
          <div className="mx-auto w-14 h-14 rounded-full bg-stone-950 flex items-center justify-center">
            <Banknote className="w-7 h-7 text-[#D4FF00]" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Connect your HSBC account</h2>
            <p className="text-stone-500 mt-1 text-sm max-w-md mx-auto">
              You'll be redirected to TrueLayer to authorise read-only access.
              Connection is granted by HSBC for 90 days, then renewable with a tap.
            </p>
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg mt-3 mx-auto max-w-md px-3 py-2 text-left">
              <strong>Sandbox mode:</strong> picking a mock bank takes you through
              the full flow with test data. Real HSBC requires switching the app
              to Live mode in the TrueLayer console first.
            </p>
          </div>
          <button
            onClick={handleConnect}
            disabled={connecting}
            data-testid="banking-connect-btn"
            className="px-5 py-3 bg-stone-950 hover:bg-stone-800 text-white font-bold uppercase tracking-wider text-xs rounded-lg inline-flex items-center gap-2 disabled:opacity-60"
          >
            {connecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <LinkIcon className="w-4 h-4" />}
            Connect HSBC
          </button>
          <p className="text-[10px] uppercase tracking-wider text-stone-400">
            {env === "live" ? "Live · real bank" : "Sandbox · test data only"}
          </p>
        </div>
      </div>
    );
  }

  // Connected — dashboard + transactions
  const expiringSoon = (status?.days_until_consent_expires ?? 99) <= 7;
  const balance = dashboard?.balance;

  return (
    <div className="space-y-6" data-testid="banking-dashboard">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">Banking</h1>
          <p className="text-stone-500 mt-1 text-sm">
            <span className="inline-flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5" />
              {status.institution_name || "HSBC"}
            </span>
            {status.last_sync_at && (
              <span className="ml-3 text-xs text-stone-400">
                · last sync {new Date(status.last_sync_at).toLocaleString("en-GB")}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSync}
            disabled={syncing}
            data-testid="banking-sync-btn"
            className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white hover:bg-stone-50 rounded-lg flex items-center gap-1.5 disabled:opacity-60"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing…" : "Refresh"}
          </button>
          <button
            onClick={handleDisconnect}
            data-testid="banking-disconnect-btn"
            className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white hover:bg-stone-50 rounded-lg flex items-center gap-1.5 text-stone-600"
          >
            <X className="w-3.5 h-3.5" /> Disconnect
          </button>
        </div>
      </div>

      {expiringSoon && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800 flex items-center gap-2" data-testid="banking-expiry-banner">
          <AlertTriangle className="w-4 h-4" />
          Bank consent expires in {status.days_until_consent_expires} days — reconnect HSBC to keep the feed live.
          <button onClick={handleConnect} className="ml-auto px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-amber-900 text-white rounded">Reconnect</button>
        </div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white border border-stone-200 rounded-2xl p-5">
          <div className="text-[10px] uppercase tracking-wider text-stone-500 font-bold">Current Balance</div>
          <div className="text-3xl font-bold mt-1 tabular-nums">
            {moneyFmt(balance?.current, balance?.currency || "GBP")}
          </div>
          <div className="text-xs text-stone-400 mt-1">
            Available {moneyFmt(balance?.available, balance?.currency || "GBP")}
          </div>
        </div>
        <div className="bg-white border border-stone-200 rounded-2xl p-5">
          <div className="text-[10px] uppercase tracking-wider text-stone-500 font-bold">In Over Last 6 Months</div>
          <div className="text-3xl font-bold mt-1 tabular-nums text-emerald-700">
            {moneyFmt(dashboard?.total_in_window)}
          </div>
          <div className="text-xs text-stone-400 mt-1">
            Across {transactions.filter((t) => t.transaction_type === "CREDIT").length} receipts
          </div>
        </div>
        <div className="bg-white border border-stone-200 rounded-2xl p-5">
          <div className="text-[10px] uppercase tracking-wider text-stone-500 font-bold">Consent</div>
          <div className="mt-1">
            <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded border ${STATUS_PILL[status.status] || STATUS_PILL.active}`}>
              {status.status}
            </span>
          </div>
          <div className="text-xs text-stone-500 mt-1">
            {status.consent_expires_at
              ? `Renew by ${new Date(status.consent_expires_at).toLocaleDateString("en-GB")} (${status.days_until_consent_expires} days)`
              : "—"}
          </div>
        </div>
      </div>

      {/* Monthly incoming */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-white border border-stone-200 rounded-2xl p-5 lg:col-span-2">
          <h2 className="text-sm font-bold tracking-wider uppercase text-stone-700 mb-4">Monthly Incoming</h2>
          {dashboard?.months?.length ? (
            <div className="space-y-2">
              {dashboard.months.map((m) => {
                const max = Math.max(...dashboard.months.map((x) => x.total));
                const pct = Math.max(2, (m.total / max) * 100);
                return (
                  <div key={m.month} className="flex items-center gap-3 text-sm">
                    <div className="w-20 tabular-nums text-stone-500 text-xs">{m.month}</div>
                    <div className="flex-1 bg-stone-100 rounded-full h-3 overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="w-28 text-right tabular-nums font-bold">{moneyFmt(m.total)}</div>
                    <div className="w-12 text-right tabular-nums text-xs text-stone-400">{m.count}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-stone-500 text-sm">No transactions yet — click Refresh to fetch.</p>
          )}
        </div>
        <div className="bg-white border border-stone-200 rounded-2xl p-5">
          <h2 className="text-sm font-bold tracking-wider uppercase text-stone-700 mb-4">Top Sources</h2>
          {dashboard?.top_sources?.length ? (
            <div className="space-y-2">
              {dashboard.top_sources.map((s, i) => (
                <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b border-stone-100 last:border-0">
                  <div className="truncate pr-2 text-stone-700">{s.name || "—"}</div>
                  <div className="tabular-nums font-bold text-emerald-700 shrink-0">{moneyFmt(s.total)}</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-stone-500 text-sm">—</p>
          )}
        </div>
      </div>

      {/* Transactions list */}
      <div className="bg-white border border-stone-200 rounded-2xl p-5">
        <div className="flex items-center gap-3 flex-wrap mb-4">
          <h2 className="text-sm font-bold tracking-wider uppercase text-stone-700">Transactions</h2>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") loadTransactions(); }}
                placeholder="Search description"
                className="pl-7 pr-3 py-1.5 text-sm border border-stone-200 rounded-lg w-44 focus:outline-none focus:ring-2 focus:ring-stone-900/10"
              />
            </div>
            <div className="inline-flex border border-stone-200 rounded-lg overflow-hidden" role="tablist">
              {[
                { k: "in", label: "Incoming" },
                { k: "out", label: "Outgoing" },
                { k: "all", label: "All" },
              ].map((opt) => (
                <button
                  key={opt.k}
                  onClick={() => setDirection(opt.k)}
                  data-testid={`tx-filter-${opt.k}`}
                  className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider ${direction === opt.k ? "bg-stone-950 text-white" : "bg-white text-stone-700 hover:bg-stone-50"}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {transactions.length === 0 ? (
          <p className="text-stone-500 text-sm py-8 text-center">No transactions match.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-wider text-stone-500 border-b border-stone-200">
                <tr>
                  <th className="text-left py-2 font-bold w-24">Date</th>
                  <th className="text-left py-2 font-bold">Description</th>
                  <th className="text-left py-2 font-bold w-40">Merchant</th>
                  <th className="text-right py-2 font-bold w-28">Amount</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t) => (
                  <tr key={t.transaction_id} className="border-b border-stone-100 hover:bg-stone-50">
                    <td className="py-2 text-stone-500 tabular-nums text-xs">
                      <span className="inline-flex items-center gap-1.5">
                        <Calendar className="w-3 h-3" />
                        {t.timestamp ? new Date(t.timestamp).toLocaleDateString("en-GB") : "—"}
                      </span>
                    </td>
                    <td className="py-2 text-stone-800 max-w-md truncate" title={t.description}>{t.description || "—"}</td>
                    <td className="py-2 text-stone-500 text-xs">{t.merchant_name || "—"}</td>
                    <td className={`py-2 text-right tabular-nums font-bold ${t.transaction_type === "CREDIT" ? "text-emerald-700" : "text-stone-700"}`}>
                      <span className="inline-flex items-center gap-1 justify-end">
                        {t.transaction_type === "CREDIT" ? <ArrowDownLeft className="w-3 h-3" /> : <ArrowUpRight className="w-3 h-3" />}
                        {moneyFmt(t.amount, t.currency || "GBP")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
