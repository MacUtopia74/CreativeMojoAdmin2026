// LoginLog — admin-only collapsible panel showing every login attempt.
// Mirrors the UX of AnnouncementReadLog / FileVaultAuditLog / MarketingUsageLog.
//
// Pass `franchiseeId` to scope the log to one franchisee's account; leave
// it null on the global Logs page to see every login system-wide.
//
// Each row marks the outcome (success/failed), so admins can spot
// brute-force or repeat-failed attempts at a glance.
import { useEffect, useState } from "react";
import {
  ChevronDown, ChevronUp, KeyRound, Loader2, RefreshCw, Check, X as XIcon, Shield,
} from "lucide-react";
import api from "@/lib/api";

function ukDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return "—"; }
}

// Trim a typical UA string into something readable in a narrow column.
function shortUA(ua) {
  if (!ua) return "";
  // Try to pull "Browser/version OS" out of the noise.
  const m = ua.match(/(Chrome|Firefox|Safari|Edge|Opera|Mobile Safari)\/?[\d.]*/i);
  const browser = m ? m[0].split("/")[0] : "";
  let os = "";
  if (/iphone|ipad|ios/i.test(ua)) os = "iOS";
  else if (/android/i.test(ua)) os = "Android";
  else if (/mac os|macintosh/i.test(ua)) os = "Mac";
  else if (/windows/i.test(ua)) os = "Win";
  else if (/linux/i.test(ua)) os = "Linux";
  return [browser, os].filter(Boolean).join(" · ") || ua.slice(0, 40);
}

export default function LoginLog({ franchiseeId = null }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("all"); // "all" | "success" | "failed"

  const load = async () => {
    setLoading(true); setErr("");
    try {
      const params = { limit: 500 };
      if (franchiseeId) params.franchisee_id = franchiseeId;
      if (outcomeFilter !== "all") params.outcome = outcomeFilter;
      const { data } = await api.get("/admin/auth/login-log", { params });
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not load the login log.");
    } finally { setLoading(false); }
  };

  useEffect(() => {
    if (open) load();
  }, [open, outcomeFilter, franchiseeId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="bg-white border border-stone-200 rounded-2xl overflow-hidden"
      data-testid="login-log"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="login-log-toggle"
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-stone-50 transition-colors text-left"
      >
        <KeyRound className="w-4 h-4 text-stone-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-stone-950">{franchiseeId ? "Logins" : "Login activity"}</div>
          <div className="text-[11px] text-stone-500">
            {items
              ? `${items.length} of ${total} login attempt${total === 1 ? "" : "s"}`
              : (franchiseeId ? "Admin-only log of this user's sign-ins" : "Admin-only log of every sign-in attempt across the portal")}
          </div>
        </div>
        {open && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); load(); }}
            title="Refresh"
            data-testid="login-log-refresh"
            className="p-1.5 rounded-md hover:bg-stone-100 text-stone-500"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        )}
        <span className="w-7 h-7 rounded-full border border-stone-300 flex items-center justify-center">
          {open ? <ChevronUp className="w-3.5 h-3.5 text-stone-600" /> : <ChevronDown className="w-3.5 h-3.5 text-stone-600" />}
        </span>
      </button>
      {open && (
        <div className="border-t border-stone-200">
          {/* Outcome filter chips */}
          <div className="px-4 py-2 border-b border-stone-200 bg-stone-50 flex items-center gap-1.5 text-[11px]">
            {["all", "success", "failed"].map((k) => (
              <button
                key={k}
                onClick={(e) => { e.stopPropagation(); setOutcomeFilter(k); }}
                data-testid={`login-log-filter-${k}`}
                className={`px-2 py-0.5 rounded-md uppercase tracking-wider font-semibold transition-colors ${
                  outcomeFilter === k
                    ? (k === "failed" ? "bg-rose-600 text-white" : k === "success" ? "bg-emerald-600 text-white" : "bg-stone-900 text-white")
                    : "bg-white border border-stone-200 text-stone-600 hover:bg-stone-100"
                }`}
              >
                {k}
              </button>
            ))}
          </div>
          {err && (
            <div className="px-4 py-3 text-xs text-rose-800 bg-rose-50 border-b border-rose-100">{err}</div>
          )}
          {loading && items === null ? (
            <div className="px-4 py-8 text-center text-sm text-stone-500 flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : items && items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-stone-500">
              {franchiseeId
                ? "No logins recorded for this user yet."
                : "No login attempts logged yet — entries will appear here from now on."}
            </div>
          ) : items ? (
            <div className="max-h-[420px] overflow-y-auto text-xs">
              <table className="w-full">
                <thead className="sticky top-0 bg-stone-50 text-[10px] uppercase tracking-wider text-stone-600 font-bold">
                  <tr>
                    <th className="px-3 py-2 text-left w-44">When</th>
                    <th className="px-3 py-2 text-left w-24">Outcome</th>
                    {!franchiseeId && <th className="px-3 py-2 text-left w-56">User</th>}
                    <th className="px-3 py-2 text-left w-32">IP</th>
                    <th className="px-3 py-2 text-left">Device</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.id} className="border-t border-stone-100 hover:bg-stone-50/40">
                      <td className="px-3 py-1.5 font-mono text-stone-700 tabular-nums">{ukDateTime(r.at)}</td>
                      <td className="px-3 py-1.5">
                        {r.outcome === "success" ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-semibold">
                            <Check className="w-3 h-3" /> Success
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-50 text-rose-800 border border-rose-200 font-semibold">
                            <XIcon className="w-3 h-3" /> Failed
                          </span>
                        )}
                      </td>
                      {!franchiseeId && (
                        <td className="px-3 py-1.5 truncate">
                          <div className="font-semibold text-stone-900 truncate flex items-center gap-1">
                            {r.franchisee_name || r.email || "—"}
                            {r.role === "admin" && (
                              <span className="text-[9px] uppercase tracking-wider bg-stone-200 text-stone-700 px-1 py-0.5 rounded inline-flex items-center gap-0.5">
                                <Shield className="w-2.5 h-2.5" /> Admin
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-stone-500 font-mono truncate">{r.email}</div>
                        </td>
                      )}
                      <td className="px-3 py-1.5 font-mono text-stone-600 truncate">{r.ip || "—"}</td>
                      <td className="px-3 py-1.5 text-stone-600 truncate" title={r.user_agent}>{shortUA(r.user_agent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
