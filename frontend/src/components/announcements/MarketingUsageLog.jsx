// MarketingUsageLog — admin-only collapsible panel.
// Surfaces every Marketing e-shot sent by every franchisee + the
// rolled-up delivery/open/click counts. Same lazy-load + UX pattern
// as AnnouncementReadLog and FileVaultAuditLog so the three audit
// panels feel consistent on the admin pages.
import { useEffect, useState } from "react";
import {
  ChevronDown, ChevronUp, BarChart3, Loader2, RefreshCw, Mail,
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

export default function MarketingUsageLog({ franchiseeId = null }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const load = async () => {
    setLoading(true); setErr("");
    try {
      const params = { limit: 500 };
      if (franchiseeId) params.franchisee_id = franchiseeId;
      const { data } = await api.get("/admin/marketing/log", { params });
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not load the marketing log.");
    } finally { setLoading(false); }
  };

  useEffect(() => {
    if (open && items === null) load();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="bg-white border border-stone-200 rounded-2xl overflow-hidden"
      data-testid="marketing-usage-log"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="marketing-log-toggle"
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-stone-50 transition-colors text-left"
      >
        <BarChart3 className="w-4 h-4 text-stone-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-stone-950">{franchiseeId ? "Marketing e-shots sent" : "Marketing usage log"}</div>
          <div className="text-[11px] text-stone-500">
            {items
              ? `${items.length} of ${total} campaign${total === 1 ? "" : "s"}${franchiseeId ? "" : " sent across all franchisees"}`
              : (franchiseeId ? "Admin-only log of this franchisee's e-shots" : "Admin-only log of franchisee e-shots — recipient counts, opens & clicks")}
          </div>
        </div>
        {open && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); load(); }}
            title="Refresh"
            data-testid="marketing-log-refresh"
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
          {err && (
            <div className="px-4 py-3 text-xs text-rose-800 bg-rose-50 border-b border-rose-100">{err}</div>
          )}
          {loading && items === null ? (
            <div className="px-4 py-8 text-center text-sm text-stone-500 flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : items && items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-stone-500">
              No e-shots have gone out yet.
            </div>
          ) : items ? (
            <div className="max-h-[420px] overflow-y-auto text-xs">
              <table className="w-full">
                <thead className="sticky top-0 bg-stone-50 text-[10px] uppercase tracking-wider text-stone-600 font-bold">
                  <tr>
                    <th className="px-3 py-2 text-left w-40">Sent</th>
                    {!franchiseeId && <th className="px-3 py-2 text-left w-48">Franchisee</th>}
                    <th className="px-3 py-2 text-left">Subject</th>
                    <th className="px-3 py-2 text-right w-16">Recip.</th>
                    <th className="px-3 py-2 text-right w-16">Deliv.</th>
                    <th className="px-3 py-2 text-right w-16">Opens</th>
                    <th className="px-3 py-2 text-right w-16">Clicks</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.id} className="border-t border-stone-100 hover:bg-stone-50/40">
                      <td className="px-3 py-1.5 font-mono text-stone-700 tabular-nums whitespace-nowrap">
                        {ukDateTime(r.sent_at || r.created_at)}
                      </td>
                      {!franchiseeId && (
                        <td className="px-3 py-1.5 truncate">
                          <div className="font-semibold text-stone-900 truncate">{r.franchisee_name}</div>
                          <div className="text-[10px] text-stone-500 font-mono truncate">{r.franchisee_email || ""}</div>
                        </td>
                      )}
                      <td className="px-3 py-1.5 truncate">
                        <div className="flex items-center gap-1.5 text-stone-900 truncate">
                          <Mail className="w-3 h-3 text-stone-400 shrink-0" />
                          <span className="truncate" title={r.title}>{r.title}</span>
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-mono">{r.recipient_count}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-mono text-emerald-700">{r.delivered}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-mono text-stone-700">{r.opens}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-mono text-stone-700">{r.clicks}</td>
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
