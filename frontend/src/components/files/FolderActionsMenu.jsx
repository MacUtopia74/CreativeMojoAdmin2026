// Three-dot kebab menu attached to every folder row/tile in the
// admin FilesPage. Houses: Rename, Move to…, Share folder…,
// Download as ZIP, Soft-delete. Admin-only.
//
// The dropdown is rendered via createPortal at the document body so it
// is never clipped by parent `overflow-hidden` containers (the cards
// have rounded corners + overflow-hidden which previously hid the
// dropdown). Position is computed from the trigger button's
// getBoundingClientRect on open.
import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import api, { API_BASE } from "@/lib/api";
import {
  MoreVertical, Pencil, MoveRight, Share2, Download, Trash2, Loader2,
} from "lucide-react";

const MENU_WIDTH = 192; // matches min-w-[192px] below

export default function FolderActionsMenu({ folder, onChanged, onMove, onShare }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  const updatePos = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // Right-align the menu with the button. Clamp within viewport.
    let left = r.right - MENU_WIDTH;
    if (left < 8) left = 8;
    const top = r.bottom + 4;
    setPos({ top, left });
  };

  useLayoutEffect(() => { if (open) updatePos(); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (menuRef.current?.contains(e.target)) return;
      if (btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
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
    const url = `${API_BASE}/files/folder-zip?prefix=${encodeURIComponent(folder.key)}`;
    window.location.href = url;
  };

  return (
    <>
      <button ref={btnRef}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        disabled={busy}
        data-testid={`folder-actions-${folder.name}`}
        className="w-7 h-7 flex items-center justify-center hover:bg-stone-200 rounded-md disabled:opacity-50">
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MoreVertical className="w-3.5 h-3.5" />}
      </button>
      {open && createPortal(
        <div ref={menuRef}
          onClick={(e) => e.stopPropagation()}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: MENU_WIDTH }}
          className="z-[80] bg-white border border-stone-200 rounded-lg shadow-xl py-1"
          data-testid={`folder-actions-menu-${folder.name}`}>
          <MenuItem icon={Pencil} label="Rename" onClick={rename} testid={`folder-rename-${folder.name}`} />
          <MenuItem icon={MoveRight} label="Move to…" onClick={() => { setOpen(false); onMove?.(folder); }} testid={`folder-move-${folder.name}`} />
          <MenuItem icon={Share2} label="Share folder…" onClick={() => { setOpen(false); onShare?.(folder); }} testid={`folder-share-${folder.name}`} />
          <MenuItem icon={Download} label="Download as ZIP" onClick={downloadZip} testid={`folder-zip-${folder.name}`} />
          <div className="my-1 border-t border-stone-100" />
          <MenuItem icon={Trash2} label="Delete (soft)" onClick={softDelete} testid={`folder-delete-${folder.name}`} danger />
        </div>,
        document.body,
      )}
    </>
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
