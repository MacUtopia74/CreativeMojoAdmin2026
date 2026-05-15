// Tree picker for "Move folder…". Lazy-loads each level via
// /api/files/tree?prefix=... — admins click their way down to the
// destination, then hit "Move here". Cannot select the source folder
// or any path inside it (backend enforces this too).
import { useEffect, useState, useCallback } from "react";
import api from "@/lib/api";
import { ChevronRight, ChevronDown, Folder, X, Loader2, Home } from "lucide-react";

function Node({ prefix, name, depth, expanded, onToggle, selected, onSelect, isDescendantOfSrc }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onSelect(prefix); }}
      onDoubleClick={(e) => { e.stopPropagation(); onToggle(prefix); }}
      disabled={isDescendantOfSrc}
      data-testid={`movepicker-node-${prefix}`}
      className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-xs rounded-md transition-colors ${
        selected === prefix ? "bg-stone-900 text-white" : "hover:bg-stone-100 text-stone-800"
      } ${isDescendantOfSrc ? "opacity-40 cursor-not-allowed" : ""}`}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      <span onClick={(e) => { e.stopPropagation(); onToggle(prefix); }}
        className="w-4 h-4 inline-flex items-center justify-center hover:bg-stone-200 rounded">
        {expanded
          ? <ChevronDown className="w-3 h-3" />
          : <ChevronRight className="w-3 h-3" />}
      </span>
      <Folder className={`w-3.5 h-3.5 shrink-0 ${selected === prefix ? "text-amber-300" : "text-amber-600"}`} />
      <span className="truncate">{name}</span>
    </button>
  );
}

export default function FolderMovePicker({ open, sourcePrefix, onClose, onConfirm }) {
  // Map of prefix -> {folders: [...], loading, loaded}
  const [cache, setCache] = useState({});
  const [expanded, setExpanded] = useState({"": true});
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async (p) => {
    if (cache[p]?.loaded || cache[p]?.loading) return;
    setCache((c) => ({ ...c, [p]: { ...(c[p] || {}), loading: true } }));
    try {
      const { data } = await api.get("/files/tree", { params: { prefix: p } });
      setCache((c) => ({ ...c, [p]: { folders: data.folders || [], loaded: true } }));
    } catch (e) {
      setCache((c) => ({ ...c, [p]: { folders: [], loaded: true, error: true } }));
    }
  }, [cache]);

  useEffect(() => { if (open) load(""); }, [open, load]);

  const toggle = (p) => {
    setExpanded((e) => ({ ...e, [p]: !e[p] }));
    if (!cache[p]?.loaded) load(p);
  };

  const isDescendant = (p) => sourcePrefix && p.startsWith(sourcePrefix);

  const confirmMove = async () => {
    setBusy(true); setErr("");
    try { await onConfirm(selected); }
    catch (e) { setErr(e?.response?.data?.detail || e?.message || "Move failed."); }
    finally { setBusy(false); }
  };

  if (!open) return null;

  // Recursive renderer
  const renderNode = (prefix, name, depth) => {
    const isExp = !!expanded[prefix];
    return (
      <div key={prefix || "root"}>
        <Node prefix={prefix} name={name} depth={depth}
          expanded={isExp} onToggle={toggle}
          selected={selected} onSelect={(p) => !isDescendant(p) && setSelected(p)}
          isDescendantOfSrc={isDescendant(prefix)} />
        {isExp && (cache[prefix]?.folders || []).map((f) => renderNode(f.key, f.name.replace(/-/g, " "), depth + 1))}
        {isExp && cache[prefix]?.loading && (
          <div className="flex items-center gap-2 text-[11px] text-stone-400 pl-8 py-1">
            <Loader2 className="w-3 h-3 animate-spin" /> Loading…
          </div>
        )}
      </div>
    );
  };

  return (
    <div onClick={onClose}
      className="fixed inset-0 z-[70] bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-6"
      data-testid="move-picker-modal">
      <div onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[80vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-stone-200">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">Move folder to…</div>
          <button onClick={onClose} className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-3 py-2 border-b border-stone-100">
          <div className="text-[11px] text-stone-500">
            Moving <span className="font-mono">{sourcePrefix}</span>
          </div>
          <div className="text-[11px] text-stone-500 mt-0.5">
            Selected destination: <span className="font-mono text-stone-900">{selected || "/  (root)"}</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          <button onClick={() => setSelected("")} data-testid="movepicker-node-root"
            className={`w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-md text-left ${selected === "" ? "bg-stone-900 text-white" : "hover:bg-stone-100 text-stone-800"}`}>
            <Home className="w-3.5 h-3.5" /> Root (/)
          </button>
          {(cache[""]?.folders || []).map((f) => renderNode(f.key, f.name.replace(/-/g, " "), 0))}
        </div>
        {err && <div className="px-5 py-2 text-xs text-red-700 bg-red-50 border-t border-red-200">{err}</div>}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-100">
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-stone-700 hover:bg-stone-100 rounded-lg">Cancel</button>
          <button onClick={confirmMove} disabled={busy || isDescendant(selected)}
            data-testid="move-picker-confirm"
            className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg flex items-center gap-1.5 disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Move here
          </button>
        </div>
      </div>
    </div>
  );
}
