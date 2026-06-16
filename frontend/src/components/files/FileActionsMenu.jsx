// Three-dot kebab menu attached to file rows / tiles in the admin
// FilesPage. Houses: Rename, Move to…, Delete (soft). Admin-only
// (route protected on the backend; this menu is rendered only in
// the admin browser, never the franchisee portal).
//
// Implementation borrows the portal-positioned dropdown from
// FolderActionsMenu so the menu never gets clipped by parent
// `overflow-hidden` rounded cards.
import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import api from "@/lib/api";
import {
  MoreVertical, Pencil, MoveRight, Trash2, Loader2,
} from "lucide-react";

const MENU_WIDTH = 184;
const MENU_HEIGHT_ESTIMATE = 130;

export default function FileActionsMenu({ file, onChanged, onMove }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  const updatePos = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    let left = r.right - MENU_WIDTH;
    if (left < 8) left = 8;
    const spaceBelow = window.innerHeight - r.bottom;
    const top = spaceBelow < MENU_HEIGHT_ESTIMATE + 12
      ? Math.max(8, r.top - MENU_HEIGHT_ESTIMATE - 4)
      : r.bottom + 4;
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
    const current = file.name || "";
    const next = window.prompt("Rename file to:", current);
    if (!next || next.trim() === current) return;
    setBusy(true);
    try {
      await api.post("/files/rename", {
        key: file.key,
        new_name: next.trim(),
      });
      onChanged?.();
    } catch (e) {
      alert(e?.response?.data?.detail || "Rename failed.");
    } finally {
      setBusy(false);
    }
  };

  const softDelete = async () => {
    setOpen(false);
    if (!window.confirm(`Delete "${file.name}"?\n\nThe file will be moved to Trash for 30 days. You can restore it from there.`)) return;
    setBusy(true);
    try {
      const params = new URLSearchParams({ key: file.key });
      await api.delete(`/files?${params.toString()}`);
      onChanged?.();
    } catch (e) {
      alert(e?.response?.data?.detail || "Delete failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button ref={btnRef}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        disabled={busy}
        title="More actions"
        data-testid={`file-actions-${file.key}`}
        className="w-7 h-7 flex items-center justify-center hover:bg-stone-200 rounded-md disabled:opacity-50">
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MoreVertical className="w-3.5 h-3.5" />}
      </button>
      {open && createPortal(
        <div ref={menuRef}
          onClick={(e) => e.stopPropagation()}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: MENU_WIDTH }}
          className="z-[80] bg-white border border-stone-200 rounded-lg shadow-xl py-1"
          data-testid={`file-actions-menu-${file.key}`}>
          <MenuItem icon={Pencil} label="Rename" onClick={rename} testid={`file-rename-${file.key}`} />
          <MenuItem icon={MoveRight} label="Move to…" onClick={() => { setOpen(false); onMove?.(file); }} testid={`file-move-${file.key}`} />
          <div className="my-1 border-t border-stone-100" />
          <MenuItem icon={Trash2} label="Delete (soft)" onClick={softDelete} testid={`file-delete-${file.key}`} danger />
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
