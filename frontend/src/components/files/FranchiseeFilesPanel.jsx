// Files panel embedded inside FranchiseeDetailPage. Shows files
// scoped to a single franchisee's R2 folder (and exposes the shared
// brand folders read-only). This is the component a Phase-3
// franchisee login will see on their own dashboard. Admins also see
// it inline on the franchisee page so they can manage in context
// without bouncing to the global Files menu.
import { useEffect, useState, useCallback } from "react";
import api, { API_BASE } from "@/lib/api";
import {
  Folder, File as FileIcon, FileText, FileAudio, FileVideo, FileArchive, Image as ImageIcon,
  Download, Loader2, AlertCircle, CloudUpload, ChevronRight, Package, Share2,
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

// One folder/file row in the per-franchisee view
function Row({ children, onClick, testid }) {
  return (
    <button onClick={onClick} data-testid={testid}
      className="w-full px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-stone-50 text-left border-b border-stone-100 last:border-0">
      {children}
    </button>
  );
}

export default function FranchiseeFilesPanel({ franchisee, canUpload = true }) {
  // Build the franchisee's R2 prefix from their slug fields. We rely on
  // the migration's deterministic folder_key (number + organisation +
  // first/last name). Fallback: list by franchisee_id which always works.
  const [prefix, setPrefix] = useState(""); // relative to franchisee root; "" = root
  const [tree, setTree] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [downloadingKey, setDownloadingKey] = useState(null);

  // First call: ask backend for ANY files belonging to this franchisee
  // and derive their root prefix from the first key. Subsequent calls
  // use the derived prefix.
  const [rootPrefix, setRootPrefix] = useState(null);

  const fetchRoot = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      // Two requests in parallel: tree (top-level franchisees/ scoped to id),
      // and a search filtered by franchisee_id to derive the root prefix.
      const { data } = await api.get("/files/tree", {
        params: { prefix: "franchisees/", franchisee_id: franchisee.id },
      });
      // tree returns folders under franchisees/ — pick the one that
      // belongs to this franchisee (should be exactly one in normal data).
      const candidate = (data.folders || [])[0];
      if (candidate) {
        setRootPrefix(candidate.key);
      } else {
        setRootPrefix(null);
      }
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not load files.");
    } finally { setLoading(false); }
  }, [franchisee.id]);

  useEffect(() => { fetchRoot(); }, [fetchRoot]);

  // Once we have the root, fetch the current sub-prefix
  const fullPrefix = rootPrefix ? rootPrefix + prefix : null;
  useEffect(() => {
    if (!fullPrefix) return;
    setLoading(true); setErr("");
    (async () => {
      try {
        const { data } = await api.get("/files/tree", { params: { prefix: fullPrefix } });
        setTree(data);
      } catch (e) {
        setErr(e?.response?.data?.detail || "Could not load files.");
      } finally { setLoading(false); }
    })();
  }, [fullPrefix]);

  const download = async (key) => {
    setDownloadingKey(key);
    try {
      const { data } = await api.get("/files/download", { params: { key } });
      window.open(data.url, "_blank");
    } catch (e) {
      alert(e?.response?.data?.detail || "Download failed.");
    } finally { setDownloadingKey(null); }
  };

  const zipAll = () => {
    if (!fullPrefix) return;
    window.location.href = `${API_BASE}/files/folder-zip?prefix=${encodeURIComponent(fullPrefix)}`;
  };

  const segs = prefix.split("/").filter(Boolean);

  return (
    <div className="space-y-3" data-testid="franchisee-files-panel">
      {/* Header strip: breadcrumb + Download all */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1 text-xs text-stone-600 flex-wrap" data-testid="franchisee-files-breadcrumb">
          <button onClick={() => setPrefix("")} className="hover:underline font-bold text-stone-800">Their files</button>
          {segs.map((s, i) => {
            const upto = segs.slice(0, i + 1).join("/") + "/";
            return (
              <span key={i} className="flex items-center gap-1">
                <ChevronRight className="w-3 h-3 text-stone-400" />
                <button onClick={() => setPrefix(upto)} className="hover:underline">{s.replace(/-/g, " ")}</button>
              </span>
            );
          })}
        </div>
        {rootPrefix && (
          <button onClick={zipAll} data-testid="franchisee-files-zip"
            className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg flex items-center gap-1.5">
            <Package className="w-3 h-3" /> Download this folder as ZIP
          </button>
        )}
      </div>

      {/* Body */}
      {loading && (
        <div className="px-4 py-8 text-center text-sm text-stone-500 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading files…
        </div>
      )}
      {!loading && err && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" /> {err}
        </div>
      )}
      {!loading && !err && !rootPrefix && (
        <div className="px-4 py-8 text-center text-sm text-stone-500" data-testid="franchisee-files-empty">
          No R2 folder mapped to this franchisee yet. New uploads under <span className="font-mono">franchisees/&lt;slug&gt;/</span> will appear here.
        </div>
      )}
      {!loading && !err && rootPrefix && tree && (
        <div className="bg-stone-50 border border-stone-200 rounded-xl overflow-hidden">
          {tree.folders.length === 0 && tree.files.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-stone-500">This folder is empty.</div>
          )}
          {tree.folders.map((f) => (
            <Row key={f.key} onClick={() => setPrefix(f.key.slice(rootPrefix.length))}
              testid={`fr-folder-${f.name}`}>
              <div className="flex items-center gap-2.5 min-w-0">
                <Folder className="w-4 h-4 text-amber-600 shrink-0" />
                <span className="text-sm text-stone-900 truncate">{f.name.replace(/-/g, " ")}</span>
              </div>
              <span className="text-xs text-stone-500 tabular-nums shrink-0">{f.files} files · {fmtBytes(f.bytes)}</span>
            </Row>
          ))}
          {tree.files.map((it) => {
            const Icon = pickIcon(it);
            return (
              <div key={it.key} className="px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-white border-b border-stone-100 last:border-0" data-testid={`fr-file-${it.key}`}>
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <Icon className="w-4 h-4 text-stone-500 shrink-0" />
                  <span className="text-sm text-stone-900 truncate">{it.name}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-stone-500 tabular-nums">{fmtBytes(it.size)}</span>
                  <button onClick={() => download(it.key)} disabled={downloadingKey === it.key}
                    className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md flex items-center gap-1 disabled:opacity-50">
                    {downloadingKey === it.key ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
