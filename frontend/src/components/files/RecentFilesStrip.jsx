// Collapsible "Recently added" strip that sits ABOVE the main file
// browser. Replaces the old sidebar entry — much more prominent and
// always available. Shows files added in the last 30 days, scoped to
// franchisee + shared (admin-only files intentionally excluded).
//
// Renders horizontally as small thumbnail tiles (grid) or as a compact
// list — follows whatever view-mode the parent FilesPage uses.
import { useEffect, useState, useCallback } from "react";
import api from "@/lib/api";
import {
  Sparkles, ChevronUp, ChevronDown, Download, Loader2, File as FileIcon,
  FileText, FileAudio, FileVideo, FileArchive, Image as ImageIcon, Users, Globe,
} from "lucide-react";

function fmtBytes(b) {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function pickIcon(file) {
  const ct = (file.content_type || "").toLowerCase();
  const ext = (file.name?.split(".").pop() || "").toLowerCase();
  if (ct.startsWith("image/") || ["jpg","jpeg","png","gif","webp","svg","heic"].includes(ext)) return ImageIcon;
  if (ct === "application/pdf" || ext === "pdf") return FileText;
  if (ct.startsWith("audio/") || ["mp3","wav","m4a","aac","ogg","flac"].includes(ext)) return FileAudio;
  if (ct.startsWith("video/") || ["mp4","mov","webm","mkv","avi"].includes(ext)) return FileVideo;
  if (["zip","rar","7z","tar","gz"].includes(ext)) return FileArchive;
  return FileIcon;
}

function tint(file) {
  const ct = (file.content_type || "").toLowerCase();
  const ext = (file.name?.split(".").pop() || "").toLowerCase();
  if (ct.startsWith("image/") || ["jpg","jpeg","png","gif","webp","svg","heic"].includes(ext)) return "bg-rose-50 text-rose-700";
  if (ct === "application/pdf" || ext === "pdf") return "bg-red-50 text-red-700";
  if (ct.startsWith("audio/") || ["mp3","wav","m4a","aac","ogg","flac"].includes(ext)) return "bg-purple-50 text-purple-700";
  if (ct.startsWith("video/") || ["mp4","mov","webm","mkv","avi"].includes(ext)) return "bg-indigo-50 text-indigo-700";
  return "bg-stone-50 text-stone-600";
}

export default function RecentFilesStrip({ viewMode = "list", onOpenFile, onDownload }) {
  // Collapse state persisted in localStorage.
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem("recentStripOpen") !== "false"; }
    catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("recentStripOpen", String(open)); } catch { /* ignore */ }
  }, [open]);

  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/files/recent", { params: { days: 30, limit: 120 } });
      setItems(data.items || []);
    } catch (e) { setItems([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);

  const count = items?.length || 0;

  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden mb-4" data-testid="recent-strip">
      <button onClick={() => setOpen((o) => !o)}
        data-testid="recent-strip-toggle"
        className="w-full px-5 py-3 flex items-center justify-between hover:bg-stone-50">
        <div className="flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-stone-700" />
          <span className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">
            Recently added · last 30 days
          </span>
          {items && (
            <span className="px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-[#D4FF00] text-stone-950 rounded-md tabular-nums">
              {count}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-stone-400" />}
          {open ? <ChevronUp className="w-4 h-4 text-stone-500" /> : <ChevronDown className="w-4 h-4 text-stone-500" />}
        </div>
      </button>

      {open && (
        <div className="border-t border-stone-100">
          {!items && (
            <div className="px-5 py-6 text-sm text-stone-400 text-center flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading recent files…
            </div>
          )}
          {items && items.length === 0 && (
            <div className="px-5 py-6 text-sm text-stone-400 text-center" data-testid="recent-strip-empty">
              No files added in the last 30 days.
            </div>
          )}
          {items && items.length > 0 && (
            viewMode === "grid" ? (
              <div className="p-3 overflow-x-auto">
                <div className="flex gap-3 min-w-min">
                  {items.map((it) => {
                    const Icon = pickIcon(it);
                    const t = tint(it);
                    return (
                      <div key={it.key} className="group w-40 shrink-0 border border-stone-200 hover:border-stone-400 hover:shadow-sm transition-all rounded-xl overflow-hidden bg-white" data-testid={`recent-tile-${it.key}`}>
                        <button onClick={() => onOpenFile?.(it)}
                          className={`w-full aspect-square flex items-center justify-center ${t}`}>
                          <Icon className="w-10 h-10 opacity-80 group-hover:scale-105 transition-transform" />
                        </button>
                        <div className="p-2">
                          <div className="text-[11px] font-semibold text-stone-900 truncate" title={it.name}>{it.name}</div>
                          <div className="flex items-center justify-between mt-1">
                            <span className="text-[10px] text-stone-500 tabular-nums truncate">{it.franchisee_label || ""}</span>
                            <span className="text-[10px] text-stone-500 tabular-nums">{fmtBytes(it.size)}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="max-h-[260px] overflow-y-auto divide-y divide-stone-100">
                {items.map((it) => {
                  const Icon = pickIcon(it);
                  const when = it.uploaded_at || it.imported_at || it.last_modified;
                  return (
                    <div key={it.key} className="px-4 py-2 flex items-center justify-between gap-3 hover:bg-stone-50" data-testid={`recent-row-${it.key}`}>
                      <button onClick={() => onOpenFile?.(it)} className="flex items-center gap-3 truncate text-left flex-1 min-w-0">
                        <Icon className="w-4 h-4 text-stone-500 shrink-0" />
                        <div className="truncate min-w-0">
                          <div className="text-sm text-stone-900 truncate hover:underline">{it.name}</div>
                          <div className="text-[11px] text-stone-500 truncate">
                            {it.scope === "shared"
                              ? <span className="inline-flex items-center gap-1"><Globe className="w-2.5 h-2.5 text-blue-600" /> SHARED</span>
                              : <span className="inline-flex items-center gap-1"><Users className="w-2.5 h-2.5 text-emerald-600" /> {it.franchisee_label || "Franchisee"}</span>}
                            {when ? ` · ${new Date(when).toLocaleDateString()}` : ""}
                          </div>
                        </div>
                      </button>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-xs text-stone-500 tabular-nums">{fmtBytes(it.size)}</span>
                        <button onClick={() => onDownload?.(it.key)}
                          className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md flex items-center gap-1">
                          <Download className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
