// Admin Trash view. Shows soft-deleted folders grouped by their
// original path with: deleted_at, who, file count, size. Each row has
// "Restore" + "Delete forever". Header has an "Empty trash" button.
import { useEffect, useState, useCallback } from "react";
import api from "@/lib/api";
import {
  Trash2, RotateCcw, Loader2, AlertCircle, Database, FolderOpen,
} from "lucide-react";

function fmtBytes(b) {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

export default function TrashView({ onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [emptying, setEmptying] = useState(false);
  const [err, setErr] = useState("");

  const reload = useCallback(async () => {
    setErr("");
    try {
      const { data } = await api.get("/files/trash");
      setData(data);
    } catch (e) { setErr(e?.response?.data?.detail || "Could not load trash."); }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const restore = async (tp) => {
    setBusyKey(tp);
    try {
      await api.post("/files/trash/restore", { trash_prefix: tp });
      await reload();
      onChanged?.();
    } catch (e) { alert(e?.response?.data?.detail || "Restore failed."); }
    finally { setBusyKey(null); }
  };

  const purge = async (tp, originalPrefix) => {
    if (!window.confirm(`Permanently delete the trashed folder "${originalPrefix}"?\n\nThis cannot be undone.`)) return;
    setBusyKey(tp);
    try {
      const params = new URLSearchParams({ trash_prefix: tp });
      await api.delete(`/files/trash/item?${params.toString()}`);
      await reload();
      onChanged?.();
    } catch (e) { alert(e?.response?.data?.detail || "Permanent delete failed."); }
    finally { setBusyKey(null); }
  };

  const emptyAll = async () => {
    if (!window.confirm("Empty the entire Trash?\n\nEVERY trashed folder will be permanently destroyed. This cannot be undone.")) return;
    const typed = window.prompt('Type EMPTY (all caps) to confirm:', '');
    if (typed !== "EMPTY") { alert("Cancelled — confirmation did not match."); return; }
    setEmptying(true);
    try {
      await api.delete(`/files/trash/empty?confirm=EMPTY`);
      await reload();
      onChanged?.();
    } catch (e) { alert(e?.response?.data?.detail || "Empty trash failed."); }
    finally { setEmptying(false); }
  };

  const items = (data?.items || []).filter((x) => !x.restored);
  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid="trash-view">
      <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Trash2 className="w-3.5 h-3.5 text-stone-700" />
          <span className="text-xs uppercase tracking-widest font-bold text-stone-700">
            Trash · {items.length} folder{items.length === 1 ? "" : "s"}
            {data?.total_bytes ? <span className="text-stone-500 ml-1.5">· {fmtBytes(data.total_bytes)}</span> : null}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={emptyAll} disabled={emptying || items.length === 0}
            data-testid="trash-empty-btn"
            className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-red-600 text-white hover:bg-red-700 rounded-lg flex items-center gap-1.5 disabled:opacity-40">
            {emptying ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />} Delete all now
          </button>
          <button onClick={onClose} className="text-xs text-stone-500 hover:text-stone-900">Close</button>
        </div>
      </div>

      {err && (
        <div className="px-4 py-3 text-xs text-red-700 bg-red-50 border-b border-red-200 flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" /> {err}
        </div>
      )}

      {!data && (
        <div className="px-4 py-10 text-center text-sm text-stone-500 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      )}

      {data && items.length === 0 && (
        <div className="px-4 py-12 text-center" data-testid="trash-empty">
          <Database className="w-8 h-8 text-stone-300 mx-auto mb-2" />
          <div className="text-sm text-stone-500">Trash is empty.</div>
          <div className="text-[11px] text-stone-400 mt-1">Soft-deleted folders appear here for 30 days before automatic purge.</div>
        </div>
      )}

      {data && items.length > 0 && (
        <div className="divide-y divide-stone-100">
          {items.map((it) => {
            const isBusy = busyKey === it.trash_prefix;
            return (
              <div key={it.trash_prefix} className="px-4 py-3 flex items-center justify-between gap-3 hover:bg-stone-50" data-testid={`trash-row-${it.trash_prefix}`}>
                <div className="flex items-start gap-3 truncate flex-1 min-w-0">
                  <FolderOpen className="w-4 h-4 text-stone-400 shrink-0 mt-0.5" />
                  <div className="truncate min-w-0">
                    <div className="text-sm text-stone-900 truncate font-mono">{it.original_prefix}</div>
                    <div className="text-[11px] text-stone-500 mt-0.5 flex items-center gap-2 flex-wrap">
                      <span>Deleted {new Date(it.deleted_at).toLocaleString()}</span>
                      <span>·</span>
                      <span>by {it.deleted_by}</span>
                      <span>·</span>
                      <span className="tabular-nums">{it.files_now} files · {fmtBytes(it.bytes_now)}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => restore(it.trash_prefix)} disabled={isBusy}
                    data-testid={`trash-restore-${it.trash_prefix}`}
                    className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-emerald-600 text-white hover:bg-emerald-700 rounded-md flex items-center gap-1 disabled:opacity-50">
                    {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} Restore
                  </button>
                  <button onClick={() => purge(it.trash_prefix, it.original_prefix)} disabled={isBusy}
                    data-testid={`trash-purge-${it.trash_prefix}`}
                    className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-white border border-red-300 text-red-700 hover:bg-red-50 rounded-md flex items-center gap-1 disabled:opacity-50">
                    <Trash2 className="w-3 h-3" /> Delete forever
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
