// Public folder-share viewer. No auth. Token from URL → fetches the
// folder listing from /api/files/folder-share/:token → renders a clean
// branded page with individual download buttons + Download All as ZIP.
//
// Supports both LIST view (compact rows) and GRID view (thumbnail
// tiles). The toggle persists per browser via localStorage so the
// recipient gets their preference back next time. List is the default
// since it accommodates long filenames + paths better.
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { API_BASE } from "@/lib/api";
import axios from "axios";
import {
  Download, FileText, Image as ImageIcon, FileAudio, FileVideo,
  FileArchive, File as FileIcon, AlertCircle, Loader2, Package,
  LayoutGrid, List,
} from "lucide-react";
import Logo from "@/components/Logo";

function fmtBytes(b) {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function pickIcon(name, ct) {
  const ext = (name?.split(".").pop() || "").toLowerCase();
  const t = (ct || "").toLowerCase();
  if (t.startsWith("image/") || ["jpg","jpeg","png","gif","webp","svg","heic"].includes(ext)) return ImageIcon;
  if (t === "application/pdf" || ext === "pdf") return FileText;
  if (t.startsWith("audio/") || ["mp3","wav","m4a","aac","ogg","flac"].includes(ext)) return FileAudio;
  if (t.startsWith("video/") || ["mp4","mov","webm","mkv","avi"].includes(ext)) return FileVideo;
  if (["zip","rar","7z","tar","gz"].includes(ext)) return FileArchive;
  return FileIcon;
}

// Detect whether a file is an image (so the grid tile can show a real
// thumbnail by pulling the presigned download URL into an <img> tag).
function isImage(name, ct) {
  const ext = (name?.split(".").pop() || "").toLowerCase();
  return (ct || "").toLowerCase().startsWith("image/")
    || ["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(ext);
}

export default function PublicFolderSharePage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem("folderShareView") || "list"; }
    catch { return "list"; }
  });

  useEffect(() => {
    try { localStorage.setItem("folderShareView", viewMode); } catch { /* noop */ }
  }, [viewMode]);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await axios.get(`${API_BASE}/files/folder-share/${token}`);
        setData(data);
      } catch (e) {
        setErr(e?.response?.data?.detail || "Link not found or expired.");
      } finally { setLoading(false); }
    })();
  }, [token]);

  const zipUrl = `${API_BASE}/files/folder-share/${token}/zip`;
  const exp = data?.expires_at ? new Date(data.expires_at) : null;

  return (
    <div className="min-h-screen bg-[#FBFAF8]" data-testid="public-folder-share">
      <div className="max-w-5xl mx-auto px-6 py-10">
        <div className="bg-[#EEEE86] rounded-2xl px-6 py-5 mb-6 flex items-center justify-between border border-yellow-300/50">
          <Logo className="h-12" />
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-950">Shared Folder</div>
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-stone-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        )}
        {err && (
          <div className="border border-red-200 bg-red-50 text-red-700 rounded-2xl px-5 py-4 flex items-center gap-2" data-testid="public-folder-error">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}

        {data && (
          <>
            <div className="bg-white border border-stone-200 rounded-2xl p-5 mb-5 flex items-center justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">Folder</div>
                <h1 className="font-display text-2xl text-stone-950 truncate" data-testid="public-folder-label">{data.label}</h1>
                <div className="text-xs text-stone-500 mt-1 tabular-nums">
                  {data.file_count} files{exp ? ` · expires ${exp.toLocaleDateString()}` : " · permanent access"}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="inline-flex bg-stone-100 border border-stone-200 rounded-lg p-0.5" data-testid="folder-share-view-toggle">
                  <button
                    onClick={() => setViewMode("list")}
                    data-testid="folder-share-view-list"
                    className={`px-2.5 py-1.5 rounded-md flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider ${viewMode === "list" ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:text-stone-900"}`}
                  >
                    <List className="w-3.5 h-3.5" /> List
                  </button>
                  <button
                    onClick={() => setViewMode("grid")}
                    data-testid="folder-share-view-grid"
                    className={`px-2.5 py-1.5 rounded-md flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider ${viewMode === "grid" ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:text-stone-900"}`}
                  >
                    <LayoutGrid className="w-3.5 h-3.5" /> Grid
                  </button>
                </div>
                <a href={zipUrl} data-testid="public-folder-zip-btn"
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg">
                  <Package className="w-3.5 h-3.5" /> Download all as ZIP
                </a>
              </div>
            </div>

            {viewMode === "list" ? (
              <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
                <div className="divide-y divide-stone-100">
                  {data.files.map((f) => {
                    const Icon = pickIcon(f.name, f.content_type);
                    return (
                      <div key={f.rel_path} className="px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-stone-50" data-testid={`public-file-${f.rel_path}`}>
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <Icon className="w-4 h-4 text-stone-500 shrink-0" />
                          <div className="min-w-0">
                            <div className="text-sm text-stone-900 truncate">{f.name}</div>
                            {f.rel_path !== f.name && (
                              <div className="text-[11px] text-stone-500 truncate font-mono">{f.rel_path}</div>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span className="text-xs text-stone-500 tabular-nums">{fmtBytes(f.size)}</span>
                          <a href={f.download_url} target="_blank" rel="noreferrer"
                            className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md flex items-center gap-1">
                            <Download className="w-3 h-3" /> Download
                          </a>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {data.files.map((f) => {
                  const Icon = pickIcon(f.name, f.content_type);
                  const showThumb = isImage(f.name, f.content_type) && f.inline_url;
                  return (
                    <div
                      key={f.rel_path}
                      className="bg-white border border-stone-200 rounded-2xl overflow-hidden flex flex-col"
                      data-testid={`public-file-grid-${f.rel_path}`}
                    >
                      <div className="aspect-square bg-stone-50 flex items-center justify-center relative">
                        {showThumb ? (
                          <img
                            src={f.inline_url}
                            alt={f.name}
                            loading="lazy"
                            className="w-full h-full object-cover"
                            onError={(e) => { e.currentTarget.style.display = "none"; }}
                          />
                        ) : (
                          <Icon className="w-10 h-10 text-stone-400" />
                        )}
                      </div>
                      <div className="p-3 flex flex-col gap-1 flex-1">
                        <div className="text-xs font-semibold text-stone-900 truncate" title={f.name}>{f.name}</div>
                        <div className="text-[10px] text-stone-500 tabular-nums">{fmtBytes(f.size)}</div>
                        <a
                          href={f.download_url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-auto inline-flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md"
                        >
                          <Download className="w-3 h-3" /> Download
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="text-[11px] text-stone-400 text-center mt-6">
              Shared via Creative Mojo Admin · Anyone with this link can download these files.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
