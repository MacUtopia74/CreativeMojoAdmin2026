// "Resolve Duplicates" modal — surfaces orders that share the same
// business `id` (e.g. duplicate WooCommerce sync inserts) and lets the
// admin tick which copy to keep per group. Deletion is by Mongo `_id`
// since that's the only field that distinguishes the otherwise-identical
// docs.
import { useEffect, useState } from "react";
import { Loader2, X, Trash2, AlertTriangle } from "lucide-react";
import api from "@/lib/api";

export default function ResolveDuplicatesModal({ open, onClose, onResolved }) {
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState([]);
  // Map { orderId: Set<mongo_id to KEEP> } — every group starts with one
  // doc pre-selected to keep (the one with the latest date_modified) so
  // a quick "Delete Others" sweep is the default safe action.
  const [keep, setKeep] = useState({});
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/order-duplicates");
      const gs = data.groups || [];
      setGroups(gs);
      // Auto-pick the latest doc per group as the survivor.
      const next = {};
      for (const g of gs) {
        const sorted = [...(g.docs || [])].sort((a, b) =>
          String(b.date_modified || b.date_created || "").localeCompare(
            String(a.date_modified || a.date_created || "")
          )
        );
        if (sorted[0]) next[g._id] = sorted[0].mongo_id;
      }
      setKeep(next);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (open) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);

  const resolve = async () => {
    const toDelete = [];
    for (const g of groups) {
      const survivor = keep[g._id];
      if (!survivor) continue;
      for (const d of g.docs || []) {
        if (d.mongo_id !== survivor) toDelete.push(d.mongo_id);
      }
    }
    if (toDelete.length === 0) {
      onClose?.();
      return;
    }
    const ok = window.prompt(
      `Delete ${toDelete.length} duplicate copy/copies (keeping the chosen survivor per group)?\n\nThis is irreversible. Type DELETE to confirm.`,
      ""
    );
    if (ok !== "DELETE") return;
    setBusy(true);
    try {
      await api.post("/order-duplicates/resolve", { delete_mongo_ids: toDelete });
      onResolved?.();
      onClose?.();
    } finally { setBusy(false); }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto" data-testid="duplicates-modal">
      <div className="bg-white rounded-2xl max-w-4xl w-full my-8 shadow-2xl">
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Trash2 className="w-5 h-5 text-red-600" />
            <div>
              <div className="text-lg font-bold text-stone-950">Resolve Duplicate Orders</div>
              <div className="text-xs text-stone-500">Pick the copy you want to keep for each duplicated order ID. The others will be permanently deleted.</div>
            </div>
          </div>
          <button onClick={onClose} className="text-stone-500 hover:text-stone-900" data-testid="duplicates-close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-stone-500"><Loader2 className="w-4 h-4 animate-spin" /> Scanning…</div>
          ) : groups.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-emerald-600 text-3xl mb-2">✓</div>
              <div className="text-sm text-stone-600">No duplicate orders found.</div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{groups.length} order ID(s) appear more than once. The most recently modified copy is pre-selected as the survivor; tick a different row to keep that one instead.</span>
              </div>
              {groups.map((g) => (
                <div key={g._id} className="border border-stone-200 rounded-lg overflow-hidden" data-testid={`dup-group-${g._id}`}>
                  <div className="px-3 py-2 bg-stone-50 border-b border-stone-200 text-xs font-bold text-stone-700">
                    Order {g._id} · {g.count} copies
                  </div>
                  <div className="divide-y divide-stone-100">
                    {(g.docs || []).map((d) => (
                      <label key={d.mongo_id} className="flex items-center gap-3 px-3 py-2 hover:bg-stone-50 cursor-pointer" data-testid={`dup-doc-${d.mongo_id}`}>
                        <input
                          type="radio"
                          name={`survivor-${g._id}`}
                          checked={keep[g._id] === d.mongo_id}
                          onChange={() => setKeep({ ...keep, [g._id]: d.mongo_id })}
                          data-testid={`dup-keep-${d.mongo_id}`}
                        />
                        <div className="flex-1 min-w-0 text-xs">
                          <div className="font-semibold text-stone-900 truncate">{d.customer_label || "(no customer)"}</div>
                          <div className="text-stone-500 truncate">
                            {d.production_status || "—"} · {d.channel || "direct"} ·
                            modified {d.date_modified ? new Date(d.date_modified).toLocaleString("en-GB") : "—"}
                          </div>
                          <div className="text-[10px] text-stone-400 font-mono truncate">_id: {d.mongo_id}</div>
                        </div>
                        {keep[g._id] === d.mongo_id ? (
                          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded">Keep</span>
                        ) : (
                          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 bg-red-100 text-red-800 rounded">Delete</span>
                        )}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-stone-200 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy}
            data-testid="duplicates-cancel"
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-stone-700 hover:text-stone-900">
            Cancel
          </button>
          {groups.length > 0 && (
            <button onClick={resolve} disabled={busy}
              data-testid="duplicates-resolve"
              className="px-4 py-2 bg-red-600 text-white text-xs font-bold uppercase tracking-wider rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-2">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Delete Others
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
