// FileVaultAuditLog — admin-only collapsible panel showing every
// File Vault download. Each row records: franchisee name, date,
// time, and the file that was downloaded. Lazy-loaded — fetches
// only when the user expands the panel for the first time, so the
// main Files page stays snappy.
//
// Per Paul, this is admin-only and lives ONLY in the admin Files
// page. There's no franchisee-facing equivalent.
import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, ClipboardList, Loader2, RefreshCw, FileText } from "lucide-react";
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

export default function FileVaultAuditLog() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const load = async () => {
    setLoading(true); setErr("");
    try {
      const { data } = await api.get("/admin/files/download-log", { params: { limit: 500 } });
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not load the audit log.");
    } finally { setLoading(false); }
  };

  useEffect(() => {
    if (open && items === null) load();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="bg-white border border-stone-200 rounded-2xl overflow-hidden"
      data-testid="file-vault-audit-log"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="audit-log-toggle"
        className="w-full px-4 py-3 flex items-center gap-3 hover:bg-stone-50 transition-colors text-left"
      >
        <ClipboardList className="w-4 h-4 text-stone-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-stone-950">File Vault download log</div>
          <div className="text-[11px] text-stone-500">
            {items ? `${items.length} of ${total} recent download${total === 1 ? "" : "s"}` : "Admin-only audit trail of franchisee downloads"}
          </div>
        </div>
        {open && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); load(); }}
            title="Refresh"
            data-testid="audit-log-refresh"
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
              No downloads logged yet.
            </div>
          ) : items ? (
            <div className="max-h-[420px] overflow-y-auto text-xs">
              <table className="w-full">
                <thead className="sticky top-0 bg-stone-50 text-[10px] uppercase tracking-wider text-stone-600 font-bold">
                  <tr>
                    <th className="px-3 py-2 text-left w-44">When</th>
                    <th className="px-3 py-2 text-left w-44">Franchisee</th>
                    <th className="px-3 py-2 text-left">File</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.id} className="border-t border-stone-100 hover:bg-stone-50/40" data-testid={`audit-row-${r.id}`}>
                      <td className="px-3 py-1.5 font-mono text-stone-700 tabular-nums">{ukDateTime(r.downloaded_at)}</td>
                      <td className="px-3 py-1.5 truncate">
                        <div className="font-semibold text-stone-900 truncate">
                          {r.franchisee_name || r.user_email || "—"}
                          {r.user_role === "admin" && (
                            <span className="ml-1 text-[9px] uppercase tracking-wider bg-stone-200 text-stone-700 px-1 py-0.5 rounded">Admin</span>
                          )}
                        </div>
                        <div className="text-[10px] text-stone-500 font-mono truncate">{r.user_email}</div>
                      </td>
                      <td className="px-3 py-1.5 truncate">
                        <div className="flex items-center gap-1.5 text-stone-900 truncate">
                          <FileText className="w-3 h-3 text-stone-400 shrink-0" />
                          <span className="truncate" title={r.file_name}>{r.file_name || "(unknown)"}</span>
                        </div>
                        <div className="text-[10px] text-stone-400 font-mono truncate" title={r.file_key}>
                          {r.file_key}
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
