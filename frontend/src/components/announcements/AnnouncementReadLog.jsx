// AnnouncementReadLog — admin-only collapsible panel.
// Surfaces who has opened each HQ Update and when.
//
// Reads come from `announcement_reads` (one row per user+announcement).
// Lazy-loaded on first expand so it doesn't slow down the main page
// load. Identical UX to FileVaultAuditLog so the two feel consistent.
import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Eye, Loader2, RefreshCw, Megaphone } from "lucide-react";
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

export default function AnnouncementReadLog({ franchiseeId = null, compact = false }) {
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
      const { data } = await api.get("/admin/announcements/reads", { params });
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not load the read log.");
    } finally { setLoading(false); }
  };

  useEffect(() => {
    if (open && items === null) load();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="bg-white border border-stone-200 rounded-2xl overflow-hidden"
      data-testid="announcement-read-log"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="announcement-log-toggle"
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-stone-50 transition-colors text-left"
      >
        <Eye className="w-4 h-4 text-stone-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-stone-950">{franchiseeId ? "HQ Updates opened" : "HQ Updates — who has opened what"}</div>
          <div className="text-[11px] text-stone-500">
            {items ? `${items.length} of ${total} read event${total === 1 ? "" : "s"}` : (franchiseeId ? "Admin-only log of this franchisee's opens" : "Admin-only log of franchisee opens")}
          </div>
        </div>
        {open && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); load(); }}
            title="Refresh"
            data-testid="announcement-log-refresh"
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
              Nobody's opened any HQ Updates yet — once franchisees start opening their email links, you'll see them appear here.
            </div>
          ) : items ? (
            <div className="max-h-[420px] overflow-y-auto text-xs">
              <table className="w-full">
                <thead className="sticky top-0 bg-stone-50 text-[10px] uppercase tracking-wider text-stone-600 font-bold">
                  <tr>
                    <th className="px-3 py-2 text-left w-44">Opened</th>
                    {!franchiseeId && <th className="px-3 py-2 text-left w-56">Franchisee</th>}
                    <th className="px-3 py-2 text-left">Announcement</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r, idx) => (
                    <tr key={`${r.franchisee_id}-${r.announcement_id}-${idx}`} className="border-t border-stone-100 hover:bg-stone-50/40">
                      <td className="px-3 py-1.5 font-mono text-stone-700 tabular-nums">{ukDateTime(r.read_at)}</td>
                      {!franchiseeId && (
                        <td className="px-3 py-1.5 truncate">
                          <div className="font-semibold text-stone-900 truncate">{r.franchisee_name || "—"}</div>
                          <div className="text-[10px] text-stone-500 font-mono truncate">{r.franchisee_email || ""}</div>
                        </td>
                      )}
                      <td className="px-3 py-1.5 truncate">
                        <div className="flex items-center gap-1.5 text-stone-900 truncate">
                          <Megaphone className="w-3 h-3 text-stone-400 shrink-0" />
                          <span className="truncate" title={r.announcement_title}>{r.announcement_title || "(deleted)"}</span>
                        </div>
                      </td>
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
