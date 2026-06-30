// "Open Project Folder" modal — opens from the Calendar →
// "Projects this month" view. Mirrors the look-and-feel of the
// public folder-share page (PublicFolderSharePage.jsx) so franchisees
// get one consistent file-browsing experience whether the files came
// from HQ Updates or a Calendar project link.
//
// Behaviour:
//   - Lists every file that lives in the same R2 folder as the project
//     guide PDF (instruction, stencils, photos, etc.).
//   - Per-file "Download" button → signed presigned-URL.
//   - "Download all as ZIP" → streams the whole folder via
//     /api/files/folder-zip.
//   - List / Grid toggle (preference persists per browser).
//   - PDFs + images get real thumbnails in Grid view via the authed
//     /api/files/thumbnail proxy (same-origin, cached). The previous
//     implementation fetched R2 signed URLs directly from the browser
//     and rendered PDFs with pdfjs in-page — that broke on production
//     because the R2 bucket CORS policy doesn't allow
//     hub.creativemojo.co.uk, so every tile fell back to the red
//     "failed" icon. Reusing FileThumbnail (same approach already
//     proven on PortalUpdatesPage / AnnouncementsPage) makes it
//     CORS-free and dramatically faster (no multi-MB PDF download per
//     tile).
import { useEffect, useMemo, useState } from "react";
import {
  X, Loader2, AlertCircle, Download, Package,
  LayoutGrid, List, FileText, Image as ImageIcon,
  FileAudio, FileVideo, FileArchive, File as FileIcon,
} from "lucide-react";
import api from "@/lib/api";
import FileThumbnail from "@/components/files/FileThumbnail";

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

const VIEW_PREF_KEY = "cm.projectFolder.viewMode";

export default function ProjectGuideModal({ project, onClose }) {
  const { name, project_code, guide_key } = project;
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [viewMode, setViewMode] = useState(() => {
    if (typeof window === "undefined") return "list";
    return window.localStorage.getItem(VIEW_PREF_KEY) || "list";
  });

  // Persist the view-mode preference across modal opens.
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(VIEW_PREF_KEY, viewMode);
    }
  }, [viewMode]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr("");
    (async () => {
      try {
        if (!project_code) {
          setFiles([]); return;
        }
        const { data } = await api.get(
          `/portal/projects/${encodeURIComponent(project_code)}/files`,
          { params: guide_key ? { guide_key } : {} },
        );
        if (cancelled) return;
        setFiles(data?.files || []);
      } catch (e) {
        if (!cancelled) setErr(e?.response?.data?.detail || "Could not load this project folder.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [project_code, guide_key]);

  const folderLabel = useMemo(() => {
    if (!guide_key) return "";
    const parts = guide_key.split("/");
    return parts.length >= 2 ? parts[parts.length - 2] : "";
  }, [guide_key]);

  const folderPrefix = useMemo(() => {
    if (!guide_key) return null;
    const idx = guide_key.lastIndexOf("/");
    return idx >= 0 ? guide_key.substring(0, idx + 1) : null;
  }, [guide_key]);

  // ``api`` doesn't expose a one-shot "give me the signed URL" helper,
  // so each download mints the URL on demand. Same pattern the rest of
  // the file vault uses.
  const downloadFile = async (f, asAttachment = true) => {
    try {
      const params = asAttachment ? {} : { attachment: false };
      const { data } = await api.get(f.download_url, { params });
      const url = data?.url || data?.signed_url;
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't open that file.");
    }
  };

  const downloadZip = () => {
    if (!folderPrefix) return;
    // Stream the ZIP via the axios instance (carries the bearer token)
    // into a blob, then trigger a normal browser save. Avoids the
    // "fetch with custom headers in a plain <a>" problem.
    api.get("/files/folder-zip", { params: { prefix: folderPrefix }, responseType: "blob" })
      .then((resp) => {
        const blob = new Blob([resp.data], { type: "application/zip" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${folderLabel || "project-folder"}.zip`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      })
      .catch((e) => setErr(e?.response?.data?.detail || "Couldn't build the ZIP."));
  };

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-0 sm:p-4"
      data-testid="project-folder-modal"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="bg-stone-50 w-full max-w-5xl h-full sm:h-[92vh] sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-stone-200 bg-white flex items-center justify-between gap-3 flex-shrink-0">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">
              Project folder{project_code ? ` · ${project_code}` : ""}
            </div>
            <h2 className="font-display text-xl sm:text-2xl text-stone-950 mt-0.5 truncate">{name}</h2>
          </div>
          <button
            onClick={onClose}
            data-testid="project-folder-close"
            className="w-9 h-9 rounded-full border border-stone-300 bg-white hover:bg-stone-100 flex items-center justify-center flex-shrink-0"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body — scrollable area */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5">
          {err && (
            <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-900 flex items-center gap-2" data-testid="project-folder-error">
              <AlertCircle className="w-4 h-4 shrink-0" /> {err}
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-stone-500 py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading folder…
            </div>
          ) : (
            <>
              {/* Folder summary card — same shape as PublicFolderSharePage */}
              <div className="bg-white border border-stone-200 rounded-2xl p-5 mb-5 flex items-center justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">Folder</div>
                  <h1 className="font-display text-2xl text-stone-950 truncate" data-testid="project-folder-label">
                    {folderLabel || name}
                  </h1>
                  <div className="text-xs text-stone-500 mt-1 tabular-nums">
                    {files.length} file{files.length === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="inline-flex bg-stone-100 border border-stone-200 rounded-lg p-0.5" data-testid="project-folder-view-toggle">
                    <button
                      onClick={() => setViewMode("list")}
                      data-testid="project-folder-view-list"
                      className={`px-2.5 py-1.5 rounded-md flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider ${viewMode === "list" ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:text-stone-900"}`}
                    >
                      <List className="w-3.5 h-3.5" /> List
                    </button>
                    <button
                      onClick={() => setViewMode("grid")}
                      data-testid="project-folder-view-grid"
                      className={`px-2.5 py-1.5 rounded-md flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider ${viewMode === "grid" ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:text-stone-900"}`}
                    >
                      <LayoutGrid className="w-3.5 h-3.5" /> Grid
                    </button>
                  </div>
                  {folderPrefix && files.length > 0 && (
                    <button
                      onClick={downloadZip}
                      data-testid="project-folder-zip-btn"
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg"
                    >
                      <Package className="w-3.5 h-3.5" /> Download all as ZIP
                    </button>
                  )}
                </div>
              </div>

              {files.length === 0 ? (
                <div className="bg-white border border-stone-200 rounded-2xl px-5 py-10 text-center text-sm text-stone-500"
                  data-testid="project-folder-empty">
                  No files in this project folder yet.
                </div>
              ) : viewMode === "list" ? (
                <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
                  <div className="divide-y divide-stone-100">
                    {files.map((f) => {
                      const Icon = pickIcon(f.name, f.content_type);
                      return (
                        <div
                          key={f.key}
                          className="px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-stone-50"
                          data-testid={`project-folder-file-${f.key}`}
                        >
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <Icon className="w-4 h-4 text-stone-500 shrink-0" />
                            <div className="min-w-0">
                              <div className="text-sm text-stone-900 truncate" title={f.name}>{f.name}</div>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <span className="text-xs text-stone-500 tabular-nums">{fmtBytes(f.size)}</span>
                            <button
                              onClick={() => downloadFile(f, true)}
                              className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md flex items-center gap-1"
                            >
                              <Download className="w-3 h-3" /> Download
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {files.map((f) => (
                    <div
                      key={f.key}
                      className="bg-white border border-stone-200 rounded-2xl overflow-hidden flex flex-col"
                      data-testid={`project-folder-file-grid-${f.key}`}
                    >
                      <FileThumbnail
                        file={f}
                        size="md"
                        className="aspect-square w-full"
                      />
                      <div className="p-3 flex flex-col gap-1 flex-1">
                        <div className="text-xs font-semibold text-stone-900 truncate" title={f.name}>{f.name}</div>
                        <div className="text-[10px] text-stone-500 tabular-nums">{fmtBytes(f.size)}</div>
                        <button
                          onClick={() => downloadFile(f, true)}
                          className="mt-auto inline-flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md"
                        >
                          <Download className="w-3 h-3" /> Download
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
