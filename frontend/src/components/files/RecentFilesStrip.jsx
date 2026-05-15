// Collapsible "Recently added" strip — sits above the main file
// browser. Shows files (and folders that received files) from the last
// 30 days, scoped to franchisee + shared (admin-only excluded so this
// is safe for the future franchisee portal). Has its own LIST/GRID
// toggle independent of the parent file browser. Persisted to
// localStorage so the user's choice sticks.
import { useEffect, useState, useCallback } from "react";
import api from "@/lib/api";
import {
  Sparkles, ChevronUp, ChevronDown, Download, Loader2, File as FileIcon,
  FileText, FileAudio, FileVideo, FileArchive, Image as ImageIcon, Users, Globe,
  Folder, List, LayoutGrid,
} from "lucide-react";
import FileThumbnail from "@/components/files/FileThumbnail";
import { prettyFolderName } from "@/utils/folderName";

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

function ScopeChip({ scope, label }) {
  if (scope === "shared") {
    return <span className="inline-flex items-center gap-1 text-[11px] text-stone-500 truncate"><Globe className="w-2.5 h-2.5 text-blue-600" /> SHARED</span>;
  }
  return <span className="inline-flex items-center gap-1 text-[11px] text-stone-500 truncate"><Users className="w-2.5 h-2.5 text-emerald-600" /> {label || "Franchisee"}</span>;
}

export default function RecentFilesStrip({ onOpenFile, onDownload, onOpenFolder }) {
  // Collapse state. Default = closed.
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem("recentStripOpen") === "true"; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("recentStripOpen", String(open)); } catch { /* ignore */ }
  }, [open]);

  // Internal view mode — separate from the main browser's view mode so
  // users can have e.g. List for browsing but Grid for the recent strip.
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem("recentStripView") || "list"; }
    catch { return "list"; }
  });
  useEffect(() => {
    try { localStorage.setItem("recentStripView", viewMode); } catch { /* ignore */ }
  }, [viewMode]);

  const [data, setData] = useState(null); // {items, folders, days}
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/files/recent", { params: { days: 30, limit: 200 } });
      setData(data);
    } catch (e) { setData({ items: [], folders: [], days: 30 }); }
    finally { setLoading(false); }
  }, []);

  // Always fetch so the count badge is accurate even when collapsed.
  useEffect(() => { load(); }, [load]);

  const folders = data?.folders || [];
  const items = data?.items || [];
  const total = folders.length + items.length;

  return (
    <div className="bg-white border border-stone-300 rounded-2xl overflow-hidden mb-4 shadow-sm" data-testid="recent-strip">
      {/* Header strip — yellow, always visible */}
      <div className="w-full bg-[#EEEE86] hover:brightness-95 transition-[filter]">
        <button onClick={() => setOpen((o) => !o)}
          data-testid="recent-strip-toggle"
          className="w-full px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md flex items-center justify-center bg-stone-950">
              <Sparkles className="w-4 h-4 text-[#DEDD0C]" />
            </div>
            <span className="text-sm font-display font-bold tracking-tight text-stone-950">Recently added</span>
            <span className="text-[11px] uppercase tracking-[0.2em] font-bold text-stone-800">· last 30 days</span>
            {data && (
              <span className="px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-md tabular-nums bg-stone-950 text-[#DEDD0C]">
                {total}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-stone-700" />}
            <span className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md flex items-center gap-1 bg-stone-950 text-white">
              {open
                ? <><ChevronUp className="w-3 h-3" /> Hide</>
                : <><ChevronDown className="w-3 h-3" /> Show recent files</>}
            </span>
          </div>
        </button>
      </div>

      {open && (
        <div className="border-t border-stone-200">
          {/* Sub-toolbar: List/Grid toggle */}
          <div className="px-5 py-2 border-b border-stone-100 flex items-center justify-between bg-white">
            <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
              {folders.length} folder{folders.length === 1 ? "" : "s"} · {items.length} file{items.length === 1 ? "" : "s"}
            </span>
            <div className="flex items-center bg-stone-100 rounded-lg p-0.5" data-testid="recent-view-toggle">
              <button onClick={() => setViewMode("list")} data-testid="recent-view-list"
                className={`px-2 py-1 rounded-md flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider transition-all ${viewMode === "list" ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:text-stone-900"}`}>
                <List className="w-3 h-3" /> List
              </button>
              <button onClick={() => setViewMode("grid")} data-testid="recent-view-grid"
                className={`px-2 py-1 rounded-md flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider transition-all ${viewMode === "grid" ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:text-stone-900"}`}>
                <LayoutGrid className="w-3 h-3" /> Grid
              </button>
            </div>
          </div>

          {!data && (
            <div className="px-5 py-6 text-sm text-stone-400 text-center flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          )}
          {data && total === 0 && (
            <div className="px-5 py-6 text-sm text-stone-400 text-center" data-testid="recent-strip-empty">
              No files or folders added in the last 30 days.
            </div>
          )}

          {data && total > 0 && (
            viewMode === "grid" ? (
              <div className="p-3 max-h-[400px] overflow-y-auto">
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3">
                  {folders.map((f) => (
                    <button key={f.key} onClick={() => onOpenFolder?.(f.key)}
                      data-testid={`recent-folder-tile-${f.key}`}
                      className="group flex flex-col items-stretch border border-stone-200 hover:border-stone-400 hover:shadow-sm transition-all rounded-xl overflow-hidden bg-white text-left">
                      <div className="aspect-square bg-amber-50 flex items-center justify-center border-b border-amber-100">
                        <Folder className="w-10 h-10 text-amber-600 group-hover:scale-105 transition-transform" />
                      </div>
                      <div className="p-2">
                        <div className="text-[11px] font-semibold text-stone-900 truncate" title={f.name}>{prettyFolderName(f.name)}</div>
                        <div className="text-[10px] text-stone-500 tabular-nums mt-0.5">+{f.file_count} files · {fmtBytes(f.bytes)}</div>
                      </div>
                    </button>
                  ))}
                  {items.map((it) => {
                    return (
                      <div key={it.key} className="group border border-stone-200 hover:border-stone-400 hover:shadow-sm transition-all rounded-xl overflow-hidden bg-white" data-testid={`recent-tile-${it.key}`}>
                        <button onClick={() => onOpenFile?.(it)}
                          className="w-full aspect-square overflow-hidden">
                          <FileThumbnail file={it} className="w-full h-full" />
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
              <div className="max-h-[400px] overflow-y-auto divide-y divide-stone-100">
                {folders.map((f) => (
                  <button key={f.key} onClick={() => onOpenFolder?.(f.key)}
                    data-testid={`recent-folder-row-${f.key}`}
                    className="w-full px-4 py-2 flex items-center justify-between gap-3 hover:bg-stone-50 text-left">
                    <div className="flex items-center gap-3 truncate flex-1 min-w-0">
                      <Folder className="w-4 h-4 text-amber-600 shrink-0" />
                      <div className="truncate min-w-0">
                        <div className="text-sm text-stone-900 truncate">{prettyFolderName(f.name)}</div>
                        <div className="text-[11px] text-stone-500 truncate">
                          <ScopeChip scope={f.scope} label={f.franchisee_label} />
                          {f.latest_at ? ` · last update ${new Date(f.latest_at).toLocaleDateString()}` : ""}
                        </div>
                      </div>
                    </div>
                    <span className="text-xs text-stone-500 tabular-nums shrink-0">+{f.file_count} · {fmtBytes(f.bytes)}</span>
                  </button>
                ))}
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
                            <ScopeChip scope={it.scope} label={it.franchisee_label} />
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
