// Phase 3 — Admin File Browser. Read-only file index over R2, populated by
// the FileCamp migration. Three views:
//   • Sidebar of scopes/franchisees (counts + sizes)
//   • Centre tree-list of the current prefix
//   • Top search bar (whole-bucket name search)
//
// Migration panel lives at the top — Dry-Run / Commit / live progress.
import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import { formatDate } from "@/lib/date";
import {
  Folder, FolderOpen, File as FileIcon, ChevronRight, Search,
  Download, Loader2, AlertCircle, CloudUpload, Database, Users, Lock, Globe,
  RefreshCw, ChevronUp, ChevronDown, X, ExternalLink, Share2, Copy, CheckCircle2,
  FolderPlus, Trash2, Eye, LayoutGrid, List, FileText, Image as ImageIcon,
  FileAudio, FileVideo, FileArchive, Sparkles, Clock,
} from "lucide-react";
import FolderActionsMenu from "@/components/files/FolderActionsMenu";
import FolderMovePicker from "@/components/files/FolderMovePicker";
import FolderShareModal from "@/components/files/FolderShareModal";
import RecentFilesStrip from "@/components/files/RecentFilesStrip";
import TrashView from "@/components/files/TrashView";

function fmtBytes(b) {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

const SCOPE_BADGE = {
  franchisee: { label: "FRANCHISEE", icon: Users, cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
  shared:     { label: "ALL",        icon: Globe, cls: "bg-blue-100 text-blue-800 border-blue-300" },
  admin:      { label: "ADMIN",      icon: Lock,  cls: "bg-amber-100 text-amber-900 border-amber-300" },
};

// Pick a sensible Lucide icon for a file based on its content_type / extension.
function fileIcon(file) {
  const ct = (file.content_type || "").toLowerCase();
  const ext = (file.name?.split(".").pop() || "").toLowerCase();
  if (ct.startsWith("image/") || ["jpg","jpeg","png","gif","webp","svg","heic"].includes(ext)) return ImageIcon;
  if (ct === "application/pdf" || ext === "pdf") return FileText;
  if (ct.startsWith("audio/") || ["mp3","wav","m4a","aac","ogg","flac","aif","aiff"].includes(ext)) return FileAudio;
  if (ct.startsWith("video/") || ["mp4","mov","webm","mkv","avi","wmv"].includes(ext)) return FileVideo;
  if (["zip","rar","7z","tar","gz"].includes(ext)) return FileArchive;
  if (["doc","docx","txt","rtf","md"].includes(ext) || ct.startsWith("text/")) return FileText;
  return FileIcon;
}

// Tailwind background tint per file kind — used by the grid thumbnail tiles
// so the eye can sort by type at a glance.
function fileTint(file) {
  const ct = (file.content_type || "").toLowerCase();
  const ext = (file.name?.split(".").pop() || "").toLowerCase();
  if (ct.startsWith("image/") || ["jpg","jpeg","png","gif","webp","svg","heic"].includes(ext)) return "bg-rose-50 text-rose-700 border-rose-200";
  if (ct === "application/pdf" || ext === "pdf") return "bg-red-50 text-red-700 border-red-200";
  if (ct.startsWith("audio/") || ["mp3","wav","m4a","aac","ogg","flac","aif","aiff"].includes(ext)) return "bg-purple-50 text-purple-700 border-purple-200";
  if (ct.startsWith("video/") || ["mp4","mov","webm","mkv","avi","wmv"].includes(ext)) return "bg-indigo-50 text-indigo-700 border-indigo-200";
  if (["doc","docx","txt","rtf","md"].includes(ext)) return "bg-sky-50 text-sky-700 border-sky-200";
  return "bg-stone-50 text-stone-600 border-stone-200";
}

function ScopeBadge({ scope }) {
  const s = SCOPE_BADGE[scope] || SCOPE_BADGE.admin;
  const Icon = s.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider border rounded-md ${s.cls}`}>
      <Icon className="w-2.5 h-2.5" /> {s.label}
    </span>
  );
}

function Breadcrumb({ prefix, onJump }) {
  const segs = useMemo(() => prefix.split("/").filter(Boolean), [prefix]);
  return (
    <div className="flex items-center gap-1 text-sm text-stone-600 flex-wrap" data-testid="files-breadcrumb">
      <button onClick={() => onJump("")} className="hover:underline font-bold text-stone-800">All Files</button>
      {segs.map((seg, i) => {
        const upto = segs.slice(0, i + 1).join("/") + "/";
        return (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="w-3 h-3 text-stone-400" />
            <button onClick={() => onJump(upto)} className="hover:underline">{seg.replace(/-/g, " ")}</button>
          </span>
        );
      })}
    </div>
  );
}

function MigrationPanel({ db, onMigrationDone }) {
  const [planBusy, setPlanBusy] = useState(false);
  const [planErr, setPlanErr] = useState("");
  const [status, setStatus] = useState(null);
  const [collapsed, setCollapsed] = useState(false);

  // Derived: plan summary lives on status.latest_plan.summary
  const plan = status?.latest_plan?.summary || null;
  const planRunning = status?.plan?.running;

  const refreshStatus = useCallback(async () => {
    try {
      const { data } = await api.get("/files/migration/status");
      setStatus(data);
    } catch (e) { /* noop */ }
  }, []);

  useEffect(() => {
    refreshStatus();
    const id = setInterval(refreshStatus, 4000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  const dryRun = async () => {
    setPlanBusy(true); setPlanErr("");
    try {
      await api.post("/files/migration/plan");
      // The walk now runs in the background — status will reflect progress.
      refreshStatus();
    } catch (e) {
      setPlanErr(e?.response?.data?.detail || "Plan failed.");
    } finally { setPlanBusy(false); }
  };

  const commit = async () => {
    if (!window.confirm("Start the migration? Files will stream from FileCamp into R2 in the background. Safe to leave the page.")) return;
    try {
      await api.post("/files/migration/start?confirm=MIGRATE");
      refreshStatus();
    } catch (e) {
      alert(e?.response?.data?.detail || "Could not start migration.");
    }
  };

  const running = status?.running;
  const pctFiles = status?.files_total ? Math.round((status.files_done / status.files_total) * 100) : 0;
  const pctBytes = status?.bytes_total ? Math.round((status.bytes_done / status.bytes_total) * 100) : 0;

  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden mb-6" data-testid="migration-panel">
      <button onClick={() => setCollapsed((c) => !c)} className="w-full px-5 py-4 flex items-center justify-between hover:bg-stone-50">
        <div className="flex items-center gap-3">
          <CloudUpload className="w-4 h-4 text-stone-700" />
          <span className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">FileCamp → R2 Migration</span>
          {running && <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border rounded-md bg-amber-100 text-amber-900 border-amber-300 flex items-center gap-1"><Loader2 className="w-2.5 h-2.5 animate-spin" /> RUNNING</span>}
          {!running && status?.finished_at && <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border rounded-md bg-emerald-100 text-emerald-800 border-emerald-300">Last finished {formatDate(status.finished_at)}</span>}
        </div>
        {collapsed ? <ChevronDown className="w-4 h-4 text-stone-500" /> : <ChevronUp className="w-4 h-4 text-stone-500" />}
      </button>
      {!collapsed && (
        <div className="border-t border-stone-100 px-5 py-4 space-y-4">
          {running && status && (
            <div className="space-y-2" data-testid="migration-progress">
              <div className="flex items-center justify-between text-xs text-stone-700">
                <div className="flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> {status.current ? <span className="truncate max-w-xl">{status.current}</span> : "Starting…"}</div>
                <div className="tabular-nums">{status.files_done}/{status.files_total} files · {fmtBytes(status.bytes_done)} of {fmtBytes(status.bytes_total)}</div>
              </div>
              <div className="h-2 bg-stone-100 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pctBytes}%` }} />
              </div>
              <div className="text-[11px] text-stone-500 tabular-nums">{pctFiles}% by files · {pctBytes}% by bytes{status.errors ? ` · ${status.errors} errors` : ""}</div>
            </div>
          )}

          {!plan && !running && !planRunning && (
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm text-stone-800">Walk the FileCamp WebDAV server and plan which files will copy across, where each one will land in R2, and which franchisees they'll attach to.</div>
                <div className="text-xs text-stone-500 mt-1">Dry-run only — nothing is uploaded until you click Commit on the plan.</div>
              </div>
              <button onClick={dryRun} disabled={planBusy} data-testid="migration-dryrun"
                className="shrink-0 px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                <RefreshCw className={`w-3.5 h-3.5 ${planBusy ? "animate-spin" : ""}`} /> {planBusy ? "Walking…" : "Run Dry-Run"}
              </button>
            </div>
          )}
          {planRunning && (
            <div className="flex items-center gap-2 text-sm text-stone-700" data-testid="plan-running">
              <Loader2 className="w-4 h-4 animate-spin" />
              Walking FileCamp WebDAV — this typically takes 30 — 90 seconds for 8 GB. Page will auto-refresh when the plan is ready.
            </div>
          )}
          {status?.plan?.error && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" /> Plan error: {status.plan.error}
            </div>
          )}
          {planErr && (
            <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" /> {planErr}
            </div>
          )}
          {plan && (
            <div className="space-y-3" data-testid="migration-plan">
              <div className="grid grid-cols-4 gap-3">
                <div className="bg-stone-50 border border-stone-200 rounded-lg p-3">
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Files</div>
                  <div className="font-display text-2xl text-stone-950 mt-1 tabular-nums" data-testid="plan-files">{plan.files_total.toLocaleString()}</div>
                </div>
                <div className="bg-stone-50 border border-stone-200 rounded-lg p-3">
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Total Size</div>
                  <div className="font-display text-2xl text-stone-950 mt-1 tabular-nums">{fmtBytes(plan.bytes_total)}</div>
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-amber-700">Orphans</div>
                  <div className="font-display text-2xl text-amber-900 mt-1 tabular-nums">{plan.orphan_files}</div>
                </div>
                <div className="bg-stone-50 border border-stone-200 rounded-lg p-3">
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Skipped (noise)</div>
                  <div className="font-display text-2xl text-stone-950 mt-1 tabular-nums">{plan.skipped}</div>
                </div>
              </div>
              <div className="border border-stone-200 rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-stone-50 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 border-b border-stone-200">Per franchisee preview</div>
                <div className="max-h-64 overflow-y-auto divide-y divide-stone-100 text-xs">
                  {plan.franchisee_summary?.map((f) => (
                    <div key={f.franchisee_id} className="px-3 py-2 flex items-center justify-between hover:bg-stone-50">
                      <span className="text-stone-700">{f.franchise_number || "—"} · {f.name || f.organisation || "(unnamed)"}</span>
                      <span className="text-stone-500 tabular-nums">{f.files} files · {fmtBytes(f.bytes)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between pt-1">
                <button onClick={async () => {
                  await api.post("/files/migration/plan/discard").catch(() => {});
                  refreshStatus();
                }} className="text-xs text-stone-500 hover:text-stone-900" data-testid="plan-discard">Discard plan</button>
                <button onClick={commit} disabled={running} data-testid="migration-commit"
                  className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-[#D4FF00] text-stone-950 hover:bg-[#BDE600] rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                  <CloudUpload className="w-3.5 h-3.5" /> Commit Migration ({plan.files_total.toLocaleString()} files · {fmtBytes(plan.bytes_total)})
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview modal — handles images, PDFs, audio, video inline. Anything else
// just gets a "Download" button. The header now carries a permanent
// Download button so any file can be saved with one click.
function PreviewModal({ file, onClose }) {
  const [url, setUrl] = useState(null);
  const [dlUrl, setDlUrl] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!file) return;
    setUrl(null); setDlUrl(null); setErr("");
    (async () => {
      try {
        // Inline preview URL (Content-Disposition: inline → renders PDFs etc.)
        const previewReq = api.get("/files/download", { params: { key: file.key, attachment: false } });
        // Force-download URL (attachment) for the Download button
        const dlReq = api.get("/files/download", { params: { key: file.key, attachment: true } });
        const [{ data: pv }, { data: dl }] = await Promise.all([previewReq, dlReq]);
        setUrl(pv.url);
        setDlUrl(dl.url);
      } catch (e) { setErr(e?.response?.data?.detail || "Could not load preview."); }
    })();
  }, [file]);
  if (!file) return null;
  const ct = (file.content_type || "").toLowerCase();
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const isImg = ct.startsWith("image/") || ["jpg","jpeg","png","gif","webp","svg","heic"].includes(ext);
  const isPdf = ct === "application/pdf" || ext === "pdf";
  const isAudio = ct.startsWith("audio/") || ["mp3","wav","m4a","aac","ogg","flac","aif","aiff"].includes(ext);
  const isVideo = ct.startsWith("video/") || ["mp4","mov","webm","mkv","avi","wmv"].includes(ext);

  return (
    <div onClick={onClose} className="fixed inset-0 z-[60] bg-stone-950/80 backdrop-blur-sm flex items-center justify-center p-6" data-testid="preview-modal">
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-stone-200">
          <div className="truncate min-w-0">
            <div className="text-sm font-bold text-stone-950 truncate">{file.name}</div>
            <div className="text-[11px] text-stone-500 truncate font-mono">{file.key}</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {dlUrl && (
              <a href={dlUrl} target="_blank" rel="noreferrer" data-testid="preview-download"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-[10px] font-bold uppercase tracking-wider bg-[#D4FF00] text-stone-950 hover:bg-[#BDE600] rounded-lg">
                <Download className="w-3.5 h-3.5" /> Download
              </a>
            )}
            {url && (
              <a href={url} target="_blank" rel="noreferrer" title="Open in new tab"
                className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg" data-testid="preview-open-tab">
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
            <button onClick={onClose} data-testid="preview-close" className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg"><X className="w-4 h-4" /></button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-stone-50 flex items-center justify-center p-4">
          {!url && !err && <Loader2 className="w-6 h-6 animate-spin text-stone-400" />}
          {err && <div className="text-sm text-red-700 flex items-center gap-2"><AlertCircle className="w-4 h-4" /> {err}</div>}
          {url && isImg && <img src={url} alt={file.name} className="max-w-full max-h-[70vh] object-contain rounded" />}
          {url && isPdf && (
            // <object> with <embed> fallback. Most reliable cross-browser PDF
            // preview pattern; the iframe approach was failing on some
            // browsers because of how R2 served the Content-Disposition.
            <object data={`${url}#view=FitH`} type="application/pdf" className="w-full h-[75vh] bg-white border border-stone-200 rounded" data-testid="preview-pdf">
              <embed src={`${url}#view=FitH`} type="application/pdf" className="w-full h-[75vh]" />
              <div className="text-center p-6">
                <FileIcon className="w-12 h-12 text-stone-300 mx-auto mb-3" />
                <div className="text-sm text-stone-600 mb-3">Your browser can&apos;t display this PDF inline.</div>
                <a href={url} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg">
                  <ExternalLink className="w-3.5 h-3.5" /> Open in a new tab
                </a>
              </div>
            </object>
          )}
          {url && isAudio && <audio src={url} controls className="w-full max-w-2xl" />}
          {url && isVideo && <video src={url} controls className="max-w-full max-h-[70vh] rounded" />}
          {url && !isImg && !isPdf && !isAudio && !isVideo && (
            <div className="text-center">
              <FileIcon className="w-12 h-12 text-stone-300 mx-auto mb-3" />
              <div className="text-sm text-stone-600 mb-3">Preview not supported for this file type.</div>
              <a href={dlUrl || url} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg">
                <Download className="w-3.5 h-3.5" /> Download
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Share modal — creates a stable app-side share token that resolves to a
// fresh signed R2 URL on each click. Lets us offer up to 30 days even
// though R2's underlying signed URLs cap at 7 days. Use for ad-hoc external
// sharing (e-shots, sales PDFs to prospects). For franchisees, they get
// their own portal login (permanent access).
function ShareModal({ file, onClose }) {
  const [days, setDays] = useState(30);
  const [url, setUrl] = useState(null);
  const [expiresAt, setExpiresAt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");

  const generate = useCallback(async (d) => {
    setBusy(true); setErr(""); setUrl(null); setCopied(false);
    try {
      const { data } = await api.post("/files/share-link", { key: file.key, days: d });
      setUrl(data.url);
      setExpiresAt(data.expires_at);
    } catch (e) { setErr(e?.response?.data?.detail || "Could not generate link."); }
    finally { setBusy(false); }
  }, [file]);

  useEffect(() => { if (file) generate(days); /* eslint-disable-next-line */ }, [file]);

  if (!file) return null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch (e) { /* ignore */ }
  };

  return (
    <div onClick={onClose} className="fixed inset-0 z-[60] bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-6" data-testid="share-modal">
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl max-w-xl w-full overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-stone-200">
          <div className="flex items-center gap-2"><Share2 className="w-4 h-4 text-stone-700" />
            <span className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">Share Link</span>
          </div>
          <button onClick={onClose} data-testid="share-close" className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div>
            <div className="text-sm font-semibold text-stone-950 truncate">{file.name}</div>
            <div className="text-[11px] text-stone-500 truncate font-mono">{file.key}</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Expires in</span>
            {[1, 7, 14, 30].map((d) => (
              <button key={d} onClick={() => { setDays(d); generate(d); }} data-testid={`share-days-${d}`}
                className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md border ${days === d ? "bg-stone-950 text-white border-stone-950" : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"}`}>
                {d} {d === 1 ? "day" : "days"}
              </button>
            ))}
          </div>
          {busy && <div className="text-sm text-stone-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Generating…</div>}
          {err && <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{err}</div>}
          {url && !busy && (
            <div className="space-y-2">
              <div className="flex items-stretch gap-2">
                <input readOnly value={url} data-testid="share-url"
                  className="flex-1 px-3 py-2 text-xs bg-stone-50 border border-stone-300 rounded-lg font-mono text-stone-700" />
                <button onClick={copy} data-testid="share-copy"
                  className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-[#D4FF00] hover:bg-[#BDE600] text-stone-950 rounded-lg flex items-center gap-1.5">
                  {copied ? <><CheckCircle2 className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
                </button>
              </div>
              <div className="text-[11px] text-stone-500">
                Paste into an email or e-shot. Anyone with the link can open or download — no login required.
                {expiresAt ? ` Auto-expires ${new Date(expiresAt).toLocaleString()}.` : ""}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload manager (drag-drop + button). Server-proxied multipart upload —
// the file is POSTed to /api/files/upload which streams the body to R2 and
// indexes it. This bypasses the need for R2 bucket CORS (our API token
// scope doesn't permit setting CORS).
function UploadButton({ prefix, onUploaded }) {
  const inputRef = useRef(null);
  const [progress, setProgress] = useState(null); // { current, total, name, pct }

  const uploadFile = useCallback(async (file, current, total) => {
    setProgress({ current, total, name: file.name, pct: 0 });
    const form = new FormData();
    form.append("file", file);
    form.append("prefix", prefix || "admin/uploads/");
    const backendBase = process.env.REACT_APP_BACKEND_URL || "";
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${backendBase}/api/files/upload`);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          setProgress((p) => p ? { ...p, pct: Math.round((e.loaded / e.total) * 100) } : p);
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        let msg = `Upload failed: ${xhr.status}`;
        try {
          const body = JSON.parse(xhr.responseText || "{}");
          if (body.detail) msg = body.detail;
        } catch { /* ignore parse error */ }
        reject(new Error(msg));
      };
      xhr.onerror = () => reject(new Error("Network error during upload"));
      xhr.send(form);
    });
  }, [prefix]);

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    try {
      for (let i = 0; i < files.length; i++) {
        await uploadFile(files[i], i + 1, files.length);
      }
    } catch (e) {
      alert(`Upload failed: ${e.message}`);
    } finally {
      setProgress(null);
      onUploaded?.();
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <>
      <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => handleFiles(e.target.files)}
        data-testid="upload-input" />
      <button onClick={() => inputRef.current?.click()} disabled={!!progress} data-testid="upload-btn"
        className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg flex items-center gap-1.5 disabled:opacity-50">
        <CloudUpload className="w-3.5 h-3.5" />
        {progress ? `Uploading ${progress.current}/${progress.total} · ${progress.pct}%` : "Upload"}
      </button>
      {progress && (
        <div className="absolute mt-12 right-8 z-50 bg-white border border-stone-200 rounded-xl shadow-lg p-3 w-72" data-testid="upload-progress">
          <div className="text-xs text-stone-700 truncate mb-1.5">{progress.name}</div>
          <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${progress.pct}%` }} />
          </div>
        </div>
      )}
    </>
  );
}

function NewFolderButton({ prefix, onCreated }) {
  const [busy, setBusy] = useState(false);
  const click = async () => {
    const name = window.prompt("Folder name:", "");
    if (!name) return;
    setBusy(true);
    try {
      await api.post("/files/folder", { prefix, name });
      onCreated?.();
    } catch (e) {
      alert(e?.response?.data?.detail || "Could not create folder.");
    } finally { setBusy(false); }
  };
  return (
    <button onClick={click} disabled={busy} data-testid="new-folder-btn"
      className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-900 hover:bg-stone-50 rounded-lg flex items-center gap-1.5 disabled:opacity-50">
      <FolderPlus className="w-3.5 h-3.5" /> {busy ? "Creating…" : "New folder"}
    </button>
  );
}


export default function FilesPage() {
  const [scopeTree, setScopeTree] = useState(null);
  const [tree, setTree] = useState(null);
  const [prefix, setPrefix] = useState("");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [downloadingKey, setDownloadingKey] = useState(null);
  const [preview, setPreview] = useState(null);
  const [share, setShare] = useState(null);
  const [folderShare, setFolderShare] = useState(null);
  const [movingFolder, setMovingFolder] = useState(null);
  // Trash view: shows soft-deleted folders with restore + permanent
  // delete + empty-trash actions. Activated from the sidebar.
  const [trashMode, setTrashMode] = useState(false);
  // View mode persists per browser. "list" = compact admin rows; "grid" =
  // FileCamp-style large thumbnail tiles (better for franchisees / visual
  // browsing of artwork & PDFs).
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem("filesViewMode") || "list"; }
    catch { return "list"; }
  });
  useEffect(() => {
    try { localStorage.setItem("filesViewMode", viewMode); } catch { /* ignore */ }
  }, [viewMode]);

  const reloadScopes = useCallback(async () => {
    try { const { data } = await api.get("/files/scope-tree"); setScopeTree(data); }
    catch (e) { /* noop */ }
  }, []);
  const reloadTree = useCallback(async (p) => {
    setBusy(true);
    try {
      const { data } = await api.get("/files/tree", { params: { prefix: p } });
      setTree(data);
    } catch (e) { setTree({ folders: [], files: [], prefix: p }); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { reloadScopes(); }, [reloadScopes]);
  useEffect(() => { reloadTree(prefix); }, [prefix, reloadTree]);

  const moveFolder = async (newParent) => {
    const src = movingFolder.key;
    await api.post("/files/folder/move", { prefix: src, new_parent: newParent });
    setMovingFolder(null);
    reloadTree(prefix); reloadScopes();
  };

  // Live search debounce
  useEffect(() => {
    if (search.trim().length < 2) { setResults(null); return; }
    const id = setTimeout(async () => {
      try {
        const { data } = await api.get("/files/search", { params: { q: search.trim(), limit: 80 } });
        setResults(data);
      } catch (e) { setResults({ items: [], count: 0 }); }
    }, 300);
    return () => clearTimeout(id);
  }, [search]);

  const download = async (key) => {
    setDownloadingKey(key);
    try {
      const { data } = await api.get("/files/download", { params: { key } });
      window.open(data.url, "_blank");
    } catch (e) {
      alert(e?.response?.data?.detail || "Download link could not be generated.");
    } finally { setDownloadingKey(null); }
  };

  return (
    <div className="min-h-screen bg-[#FBFAF8]" data-testid="files-page">
      {/* Topbar */}
      <div className="bg-white border-b border-stone-200 px-8 py-5 flex items-center justify-between sticky top-0 z-10">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">CRM · PHASE 3</div>
          <h1 className="font-display text-3xl text-stone-950 mt-1 flex items-baseline gap-3">
            Files
            {scopeTree && (
              <span className="text-sm text-stone-500 tabular-nums font-normal">
                {scopeTree.totals.files.toLocaleString()} files · {fmtBytes(scopeTree.totals.bytes)}
              </span>
            )}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search any file by name…"
              data-testid="files-search"
              className="pl-10 pr-3 py-2 w-80 bg-stone-50 border border-stone-300 text-sm focus:outline-none focus:border-stone-900 rounded-lg" />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700"><X className="w-3.5 h-3.5" /></button>
            )}
          </div>
        </div>
      </div>

      <div className="p-8 pt-6">
        <MigrationPanel onMigrationDone={() => { reloadScopes(); reloadTree(prefix); }} />

        <div className="grid grid-cols-12 gap-6">
          {/* Sidebar — scope navigation */}
          <aside className="col-span-12 md:col-span-3 space-y-4">
            <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
              <button onClick={() => { setTrashMode(false); setPrefix(""); }} data-testid="scope-all"
                className={`w-full px-3 py-2 text-left text-xs font-bold uppercase tracking-wider hover:bg-stone-50 ${prefix === "" && !trashMode ? "bg-stone-100" : ""}`}>
                All files
              </button>
              <div className="border-t border-stone-100">
                <div className="px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 bg-stone-50">Shared</div>
                {(scopeTree?.shared_folders || []).map((f) => (
                  <button key={f.folder} onClick={() => { setTrashMode(false); setPrefix(`shared/${f.folder}/`); }}
                    className={`w-full px-3 py-2 text-left text-xs hover:bg-stone-50 flex items-center justify-between ${prefix === `shared/${f.folder}/` && !trashMode ? "bg-blue-50" : ""}`}>
                    <span className="flex items-center gap-2 truncate"><Globe className="w-3 h-3 text-blue-600" /> {f.folder.replace(/-/g, " ")}</span>
                    <span className="text-[10px] text-stone-500 tabular-nums">{f.files}</span>
                  </button>
                ))}
              </div>
              <div className="border-t border-stone-100">
                <div className="px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 bg-stone-50">Admin only</div>
                {(scopeTree?.admin_folders || []).map((f) => (
                  <button key={f.folder} onClick={() => { setTrashMode(false); setPrefix(`admin/${f.folder}/`); }}
                    className={`w-full px-3 py-2 text-left text-xs hover:bg-stone-50 flex items-center justify-between ${prefix === `admin/${f.folder}/` && !trashMode ? "bg-amber-50" : ""}`}>
                    <span className="flex items-center gap-2 truncate"><Lock className="w-3 h-3 text-amber-600" /> {f.folder.replace(/-/g, " ")}</span>
                    <span className="text-[10px] text-stone-500 tabular-nums">{f.files}</span>
                  </button>
                ))}
              </div>
              <div className="border-t border-stone-100">
                <button onClick={() => setTrashMode(true)} data-testid="scope-trash"
                  className={`w-full px-3 py-2 text-left text-xs font-bold uppercase tracking-wider hover:bg-stone-50 flex items-center gap-1.5 ${trashMode ? "bg-red-50 text-red-700" : "text-stone-700"}`}>
                  <Trash2 className="w-3 h-3" /> Trash
                </button>
              </div>
            </div>
            <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
              <div className="px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 bg-stone-50 border-b border-stone-200">Franchisees</div>
              <div className="max-h-[60vh] overflow-y-auto">
                {(scopeTree?.franchisees || []).length === 0 && (
                  <div className="px-3 py-4 text-xs text-stone-500">No franchisees yet</div>
                )}
                {(scopeTree?.franchisees || []).map((f) => (
                  <button key={f.franchisee_id} onClick={() => { setTrashMode(false); setPrefix("franchisees/"); }}
                    className="w-full px-3 py-2 text-left text-xs hover:bg-stone-50 flex items-center justify-between"
                    data-testid={`scope-franchisee-${f.franchisee_id}`}>
                    <span className="flex items-center gap-2 truncate"><Users className="w-3 h-3 text-emerald-600" /> {f.franchise_number || "—"} · {f.organisation || f.name}</span>
                    <span className="text-[10px] text-stone-500 tabular-nums">{f.files}</span>
                  </button>
                ))}
              </div>
            </div>
          </aside>

          {/* Main pane */}
          <main className="col-span-12 md:col-span-9 space-y-3">
            {trashMode ? (
              <TrashView onClose={() => setTrashMode(false)}
                onChanged={() => { reloadScopes(); reloadTree(prefix); }} />
            ) : results ? (
              <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid="search-results">
                <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between">
                  <span className="text-xs uppercase tracking-widest font-bold text-stone-700">Search results · {results.count}</span>
                  <button onClick={() => setSearch("")} className="text-xs text-stone-500 hover:text-stone-900">Clear</button>
                </div>
                {results.items.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-stone-500">No files found.</div>
                ) : (
                  <div className="divide-y divide-stone-100">
                    {results.items.map((it) => (
                      <div key={it.key} className="px-4 py-2 flex items-center justify-between hover:bg-stone-50">
                        <button onClick={() => setPreview(it)} className="flex items-center gap-3 truncate text-left flex-1" data-testid={`preview-${it.key}`}>
                          <FileIcon className="w-3.5 h-3.5 text-stone-500 shrink-0" />
                          <div className="truncate">
                            <div className="text-sm text-stone-900 truncate hover:underline">{it.name}</div>
                            <div className="text-[11px] text-stone-500 truncate font-mono">{it.parent_prefix}</div>
                          </div>
                        </button>
                        <div className="flex items-center gap-2">
                          <ScopeBadge scope={it.scope} />
                          <span className="text-xs text-stone-500 tabular-nums">{fmtBytes(it.size)}</span>
                          <button onClick={() => setShare(it)} title="Share link"
                            className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-md flex items-center gap-1">
                            <Share2 className="w-3 h-3" />
                          </button>
                          <button onClick={() => download(it.key)} disabled={downloadingKey === it.key}
                            className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md flex items-center gap-1 disabled:opacity-50">
                            {downloadingKey === it.key ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />} Download
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <>
                <RecentFilesStrip viewMode={viewMode}
                  onOpenFile={(it) => setPreview(it)}
                  onDownload={(key) => download(key)} />
                <div className="bg-white border border-stone-200 rounded-2xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap" data-testid="files-tree">
                  <Breadcrumb prefix={prefix} onJump={setPrefix} />
                  <div className="flex items-center gap-2 relative">
                    {/* View mode toggle — list/grid */}
                    <div className="flex items-center bg-stone-100 rounded-lg p-0.5" data-testid="view-toggle">
                      <button onClick={() => setViewMode("list")} data-testid="view-list"
                        title="List view"
                        className={`px-2 py-1 rounded-md flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider transition-all ${viewMode === "list" ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:text-stone-900"}`}>
                        <List className="w-3.5 h-3.5" /> List
                      </button>
                      <button onClick={() => setViewMode("grid")} data-testid="view-grid"
                        title="Grid view"
                        className={`px-2 py-1 rounded-md flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider transition-all ${viewMode === "grid" ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:text-stone-900"}`}>
                        <LayoutGrid className="w-3.5 h-3.5" /> Grid
                      </button>
                    </div>
                    <NewFolderButton prefix={prefix} onCreated={() => { reloadTree(prefix); reloadScopes(); }} />
                    <UploadButton prefix={prefix} onUploaded={() => { reloadTree(prefix); reloadScopes(); }} />
                  </div>
                </div>
                <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
                  {busy && (
                    <div className="px-4 py-8 text-center text-sm text-stone-500 flex items-center justify-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                    </div>
                  )}
                  {!busy && tree && tree.folders.length === 0 && tree.files.length === 0 && (
                    <div className="px-4 py-12 text-center" data-testid="files-empty">
                      <Database className="w-8 h-8 text-stone-300 mx-auto mb-2" />
                      <div className="text-sm text-stone-500">
                        {scopeTree?.totals.files === 0
                          ? "No files in R2 yet. Run the FileCamp migration above."
                          : "This folder is empty."}
                      </div>
                    </div>
                  )}
                  {!busy && tree && (tree.folders.length > 0 || tree.files.length > 0) && (
                    viewMode === "grid" ? (
                      <div className="p-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3" data-testid="files-grid">
                        {tree.folders.map((f) => (
                          <div key={f.key} className="group flex flex-col items-stretch border border-stone-200 hover:border-stone-400 hover:shadow-md transition-all rounded-xl overflow-hidden text-left bg-white relative">
                            <button onClick={() => setPrefix(f.key)} data-testid={`folder-grid-${f.name}`}
                              className="aspect-square bg-amber-50 flex items-center justify-center border-b border-amber-100">
                              <Folder className="w-14 h-14 text-amber-600 group-hover:scale-105 transition-transform" />
                            </button>
                            <div className="p-2.5 flex items-start justify-between gap-2">
                              <button onClick={() => setPrefix(f.key)} className="text-left min-w-0 flex-1">
                                <div className="text-xs font-semibold text-stone-900 truncate">{f.name.replace(/-/g, " ")}</div>
                                <div className="text-[10px] text-stone-500 tabular-nums mt-0.5">{f.files} files · {fmtBytes(f.bytes)}</div>
                              </button>
                              <FolderActionsMenu folder={f}
                                onChanged={() => { reloadTree(prefix); reloadScopes(); }}
                                onMove={(fl) => setMovingFolder(fl)}
                                onShare={(fl) => setFolderShare(fl)} />
                            </div>
                          </div>
                        ))}
                        {tree.files.map((it) => {
                          const Icon = fileIcon(it);
                          const tint = fileTint(it);
                          return (
                            <div key={it.key} className="group flex flex-col items-stretch border border-stone-200 hover:border-stone-400 hover:shadow-md transition-all rounded-xl overflow-hidden bg-white relative" data-testid={`file-grid-${it.key}`}>
                              <button onClick={() => setPreview(it)} data-testid={`preview-grid-${it.key}`}
                                className={`aspect-square flex items-center justify-center border-b ${tint}`}>
                                <Icon className="w-14 h-14 opacity-80 group-hover:scale-105 transition-transform" />
                              </button>
                              <div className="p-2.5 flex-1 flex flex-col">
                                <div className="text-xs font-semibold text-stone-900 truncate" title={it.name}>{it.name}</div>
                                <div className="flex items-center justify-between mt-1">
                                  <span className="text-[10px] text-stone-500 tabular-nums">{fmtBytes(it.size)}</span>
                                  <ScopeBadge scope={it.scope} />
                                </div>
                                <div className="flex items-center gap-1 mt-2">
                                  <button onClick={() => setShare(it)} data-testid={`share-grid-${it.key}`}
                                    title="Share link"
                                    className="flex-1 px-1.5 py-1 text-[9px] font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-md flex items-center justify-center gap-1">
                                    <Share2 className="w-3 h-3" /> Share
                                  </button>
                                  <button onClick={() => download(it.key)} disabled={downloadingKey === it.key}
                                    data-testid={`download-grid-${it.key}`}
                                    className="flex-1 px-1.5 py-1 text-[9px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md flex items-center justify-center gap-1 disabled:opacity-50">
                                    {downloadingKey === it.key ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                    <div className="divide-y divide-stone-100">
                      {tree.folders.map((f) => (
                        <div key={f.key} data-testid={`folder-${f.name}`}
                          className="w-full px-4 py-2 hover:bg-stone-50 flex items-center justify-between gap-3 group">
                          <button onClick={() => setPrefix(f.key)}
                            className="flex items-center gap-3 truncate text-left flex-1">
                            <Folder className="w-4 h-4 text-amber-600 shrink-0" />
                            <span className="text-sm text-stone-900 truncate">{f.name.replace(/-/g, " ")}</span>
                          </button>
                          <span className="text-xs text-stone-500 tabular-nums">{f.files} files · {fmtBytes(f.bytes)}</span>
                          <FolderActionsMenu folder={f}
                            onChanged={() => { reloadTree(prefix); reloadScopes(); }}
                            onMove={(fl) => setMovingFolder(fl)}
                            onShare={(fl) => setFolderShare(fl)} />
                        </div>
                      ))}
                      {tree.files.map((it) => (
                        <div key={it.key} className="px-4 py-2 flex items-center justify-between hover:bg-stone-50" data-testid={`file-row-${it.key}`}>
                          <button onClick={() => setPreview(it)} className="flex items-center gap-3 truncate text-left flex-1" data-testid={`preview-file-${it.key}`}>
                            <FileIcon className="w-3.5 h-3.5 text-stone-500 shrink-0" />
                            <span className="text-sm text-stone-900 truncate hover:underline">{it.name}</span>
                            {it.orphan && <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider bg-amber-100 text-amber-900 border border-amber-300 rounded-md">orphan</span>}
                          </button>
                          <div className="flex items-center gap-2">
                            <ScopeBadge scope={it.scope} />
                            <span className="text-xs text-stone-500 tabular-nums">{fmtBytes(it.size)}</span>
                            <button onClick={() => setShare(it)} title="Share link" data-testid={`share-btn-${it.key}`}
                              className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-md flex items-center gap-1">
                              <Share2 className="w-3 h-3" />
                            </button>
                            <button onClick={() => download(it.key)} disabled={downloadingKey === it.key}
                              className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md flex items-center gap-1 disabled:opacity-50">
                              {downloadingKey === it.key ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />} Download
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    )
                  )}
                </div>
              </>
            )}
          </main>
        </div>
      </div>

      {/* Preview & Share modals */}
      <PreviewModal file={preview} onClose={() => setPreview(null)} />
      <ShareModal file={share} onClose={() => setShare(null)} />
      <FolderShareModal folder={folderShare} onClose={() => setFolderShare(null)} />
      <FolderMovePicker open={!!movingFolder}
        sourcePrefix={movingFolder?.key || ""}
        onClose={() => setMovingFolder(null)}
        onConfirm={moveFolder} />
    </div>
  );
}
