// Three-dot kebab menu attached to every folder row/tile in the
// admin FilesPage. Houses: Rename, Move to…, Share folder…,
// Download as ZIP, Soft-delete. Admin-only — franchisees never see
// this control (FranchiseeFilesPanel renders folders without it).
import { useState, useRef, useEffect } from "react";
import api, { API_BASE } from "@/lib/api";
import {
  MoreVertical, Pencil, MoveRight, Share2, Download, Trash2, Loader2,
} from "lucide-react";

export default function FolderActionsMenu({ folder, onChanged, onMove, onShare }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const rename = async () => {
    setOpen(false);
    const current = folder.name.replace(/-/g, " ");
    const next = window.prompt("Rename folder to:", current);
    if (!next || next.trim() === current) return;
    setBusy(true);
    try {
      await api.post("/files/folder/rename", { prefix: folder.key, new_name: next.trim() });
      onChanged?.();
    } catch (e) { alert(e?.response?.data?.detail || "Rename failed."); }
    finally { setBusy(false); }
  };

  const softDelete = async () => {
    setOpen(false);
    if (!window.confirm(`Delete "${folder.name}"?\n\nAll ${folder.files} files will be moved to a hidden Trash area for 30 days. They are not permanently destroyed.`)) return;
    setBusy(true);
    try {
      const params = new URLSearchParams({ prefix: folder.key });
      await api.delete(`/files/folder?${params.toString()}`);
      onChanged?.();
    } catch (e) { alert(e?.response?.data?.detail || "Delete failed."); }
    finally { setBusy(false); }
  };

  const downloadZip = () => {
    setOpen(false);
    // Trigger browser download — uses cookie auth via API_BASE
    const url = `${API_BASE}/files/folder-zip?prefix=${encodeURIComponent(folder.key)}`;
    window.location.href = url;
  };

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button onClick={() => setOpen((o) => !o)} disabled={busy}
        data-testid={`folder-actions-${folder.name}`}
        className="w-7 h-7 flex items-center justify-center hover:bg-stone-200 rounded-md disabled:opacity-50">
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MoreVertical className="w-3.5 h-3.5" />}
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-30 bg-white border border-stone-200 rounded-lg shadow-xl py-1 min-w-[180px]" data-testid={`folder-actions-menu-${folder.name}`}>
          <MenuItem icon={Pencil} label="Rename" onClick={rename} testid={`folder-rename-${folder.name}`} />
          <MenuItem icon={MoveRight} label="Move to…" onClick={() => { setOpen(false); onMove?.(folder); }} testid={`folder-move-${folder.name}`} />
          <MenuItem icon={Share2} label="Share folder…" onClick={() => { setOpen(false); onShare?.(folder); }} testid={`folder-share-${folder.name}`} />
          <MenuItem icon={Download} label="Download as ZIP" onClick={downloadZip} testid={`folder-zip-${folder.name}`} />
          <div className="my-1 border-t border-stone-100" />
          <MenuItem icon={Trash2} label="Delete (soft)" onClick={softDelete} testid={`folder-delete-${folder.name}`} danger />
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, testid, danger }) {
  return (
    <button onClick={onClick} data-testid={testid}
      className={`w-full px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-stone-50 text-left ${danger ? "text-red-700 hover:bg-red-50" : "text-stone-800"}`}>
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  );
}
