// Admin — Subscription requests queue.
//
// Lists every bolt-on request submitted from the franchisee portal,
// newest first. Two-button action row: Approve flips the matching
// ``portal_modules.<key>`` flag on the franchisee, Reject records a
// reason on the request. Approval is also the trigger that fires the
// confirmation email + Xero invoice-line schedule (handled server-side).
import { useEffect, useState, useCallback } from "react";
import {
  Loader2, CheckCircle2, X, AlertCircle, Inbox, Sparkles, Clock,
} from "lucide-react";
import api from "@/lib/api";

const STATUS_TABS = [
  { value: "pending",  label: "Pending",  pillCls: "bg-amber-100 text-amber-800 border-amber-300" },
  { value: "approved", label: "Approved", pillCls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  { value: "rejected", label: "Rejected", pillCls: "bg-stone-100 text-stone-600 border-stone-300" },
  { value: "all",      label: "All",      pillCls: "bg-stone-100 text-stone-700 border-stone-300" },
];

const ADDON_LABELS = {
  territory_plus: "Territory+",
  marketing:      "Marketing+",
  invoicing:      "Invoicing+",
  bookings:       "Bookings+",
};
const ADDON_PRICE = 10;  // Headline single-bolt-on price in GBP.

export default function AdminSubscriptionRequestsPage() {
  const [status, setStatus] = useState("pending");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(null);          // request id currently being actioned
  const [rejectingFor, setRejectingFor] = useState(null);
  const [rejectReason, setRejectReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const { data } = await api.get(`/admin/subscription-requests?status=${status}`);
      setRows(data.requests || []);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't load requests.");
    } finally { setLoading(false); }
  }, [status]);
  useEffect(() => { load(); }, [load]);

  const approve = async (r) => {
    if (!window.confirm(`Activate ${ADDON_LABELS[r.addon] || r.addon} for ${r.franchisee_name}?\n\nThis enables the module immediately and queues the £${ADDON_PRICE} addition on their next Xero invoice.`)) return;
    setBusy(r.id);
    try {
      await api.post(`/admin/subscription-requests/${r.id}/approve`);
      await load();
    } catch (e) {
      setErr(e?.response?.data?.detail || "Approve failed.");
    } finally { setBusy(null); }
  };

  const reject = async () => {
    if (!rejectingFor) return;
    setBusy(rejectingFor.id);
    try {
      await api.post(`/admin/subscription-requests/${rejectingFor.id}/reject`, {
        reason: rejectReason.trim() || undefined,
      });
      setRejectingFor(null); setRejectReason("");
      await load();
    } catch (e) {
      setErr(e?.response?.data?.detail || "Reject failed.");
    } finally { setBusy(null); }
  };

  const pendingCount = rows.filter((r) => r.status === "pending").length;

  return (
    <div className="p-6 md:p-8 space-y-5 max-w-6xl" data-testid="admin-subscription-requests-page">
      <div>
        <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 flex items-center gap-1.5">
          <Sparkles className="w-3 h-3" /> Subscription requests
        </div>
        <h1 className="font-display text-4xl text-stone-950 mt-1">Bolt-on activation queue</h1>
        <p className="text-sm text-stone-600 mt-2 max-w-2xl">
          Franchisees submit bolt-on requests from their Portal Subscriptions page. Approving
          here <strong>immediately enables the module</strong> on their account and stamps the
          monthly addition onto their existing Xero invoice via their GoCardless mandate.
        </p>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {STATUS_TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setStatus(t.value)}
            data-testid={`subs-status-${t.value}`}
            className={`px-3.5 py-1.5 text-xs font-bold uppercase tracking-wider rounded-lg border ${status === t.value ? "bg-stone-950 text-[#dddd16] border-stone-950" : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"}`}
          >
            {t.label}
            {t.value === "pending" && pendingCount > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] text-[10px] rounded-full bg-amber-500 text-white">{pendingCount}</span>
            )}
          </button>
        ))}
      </div>

      {err && (
        <div className="px-4 py-3 border border-amber-300 bg-amber-50 text-amber-900 rounded-xl text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /> {err}
        </div>
      )}

      <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-stone-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-12 text-stone-500">
            <Inbox className="w-8 h-8 mx-auto mb-2 text-stone-300" />
            <p className="font-semibold text-stone-700">No {status === "all" ? "" : status} requests</p>
            <p className="text-xs mt-1">Franchisee bolt-on requests will appear here as soon as they hit Confirm.</p>
          </div>
        ) : (
          <ul className="divide-y divide-stone-100" data-testid="subs-requests-list">
            {rows.map((r) => {
              const label = ADDON_LABELS[r.addon] || r.addon;
              const sTab = STATUS_TABS.find((t) => t.value === r.status);
              return (
                <li key={r.id} className="px-4 py-3 flex items-center gap-3 flex-wrap" data-testid={`subs-request-${r.id}`}>
                  <div className="flex-1 min-w-[260px]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-stone-900">{r.franchisee_name}</span>
                      <span className="text-stone-300">·</span>
                      <span className="text-sm text-stone-600">wants <strong>{label}</strong></span>
                      <span className={`px-2 py-0.5 text-[10px] uppercase tracking-wider font-bold rounded border ${sTab?.pillCls || "bg-stone-100 border-stone-300 text-stone-700"}`}>
                        {r.status}
                      </span>
                    </div>
                    <div className="text-xs text-stone-500 mt-0.5 font-mono">
                      <Clock className="w-3 h-3 inline -mt-0.5 mr-1" />
                      Submitted {r.created_at ? new Date(r.created_at).toLocaleString("en-GB") : "—"}
                      {r.franchisee_email && <span> · {r.franchisee_email}</span>}
                    </div>
                    {r.reject_reason && (
                      <div className="text-xs text-rose-700 mt-1">Reject reason: {r.reject_reason}</div>
                    )}
                  </div>
                  {r.status === "pending" ? (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => approve(r)}
                        disabled={busy === r.id}
                        data-testid={`subs-approve-${r.id}`}
                        className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg flex items-center gap-1.5 disabled:opacity-50"
                      >
                        {busy === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                        Approve
                      </button>
                      <button
                        onClick={() => { setRejectingFor(r); setRejectReason(""); }}
                        disabled={busy === r.id}
                        data-testid={`subs-reject-${r.id}`}
                        className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 hover:bg-rose-50 hover:text-rose-700 text-stone-700 rounded-lg flex items-center gap-1.5"
                      >
                        <X className="w-3.5 h-3.5" /> Reject
                      </button>
                    </div>
                  ) : (
                    <div className="text-xs text-stone-500">
                      {r.decided_at ? `${r.status} ${new Date(r.decided_at).toLocaleDateString("en-GB")}` : ""}
                      {r.decided_by ? ` · ${r.decided_by}` : ""}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Reject reason modal — captures an optional reason so the
          franchisee gets useful context in the rejection email. */}
      {rejectingFor && (
        <div onClick={() => !busy && setRejectingFor(null)} className="fixed inset-0 z-[120] bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-4" data-testid="subs-reject-modal">
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
            <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
              <div className="font-display text-lg font-black text-stone-950">Reject request</div>
              <button onClick={() => !busy && setRejectingFor(null)} className="p-1.5 hover:bg-stone-100 rounded-lg"><X className="w-4 h-4" /></button>
            </div>
            <div className="px-5 py-4 space-y-3 text-sm">
              <p className="text-stone-700">
                Rejecting <strong>{ADDON_LABELS[rejectingFor.addon] || rejectingFor.addon}</strong> for <strong>{rejectingFor.franchisee_name}</strong>.
              </p>
              <textarea
                rows={3}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Optional reason — included in the email back to the franchisee"
                data-testid="subs-reject-reason"
                className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-none focus:border-stone-900"
              />
            </div>
            <div className="px-5 py-3 bg-stone-50 border-t border-stone-200 flex items-center justify-end gap-2">
              <button onClick={() => setRejectingFor(null)} disabled={!!busy} className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 hover:bg-white text-stone-700 rounded-lg">Cancel</button>
              <button onClick={reject} disabled={!!busy} data-testid="subs-reject-confirm" className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-rose-600 hover:bg-rose-700 text-white rounded-lg flex items-center gap-2">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />} Reject request
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
