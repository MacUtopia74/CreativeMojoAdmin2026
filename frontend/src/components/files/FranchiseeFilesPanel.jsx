// Files panel for both the admin franchisee detail page and the
// franchisee portal dashboard. Feature parity with the admin file
// browser:
//   • Two prominent tabs: My franchise files / Files for all franchisees
//   • Name search (whole bucket, scoped server-side)
//   • List & Grid view toggle
//   • Real PDF + image thumbnails via FileThumbnail
//   • Click-to-preview for images & PDFs (FilePreviewModal)
//   • Folder drill-down + breadcrumb
//   • ZIP download for the current folder
//
// Backend access scoping (in /api/files/tree and /api/files/search)
// makes sure a franchisee user only ever sees their own files and the
// shared brand library — admins use the same component as a preview.
import { useEffect, useState, useCallback } from "react";
import api, { API_BASE } from "@/lib/api";
import {
  Folder, FolderOpen, ChevronRight, Loader2, AlertCircle, Package, FolderPlus,
  Search, X, LayoutGrid, List as ListIcon, Download,
} from "lucide-react";
import { prettyFolderName } from "@/utils/folderName";
import FileThumbnail from "@/components/files/FileThumbnail";
import FilePreviewModal from "@/components/files/FilePreviewModal";

function fmtBytes(b) {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

const BRAND_ROOT = "shared/files-for-all-franchisees/";

export default function FranchiseeFilesPanel({ franchisee, canUpload = true, lockedTab = null }) {
  // ``lockedTab`` — when "own" or "brand", the panel renders ONLY that tab and
  // hides the tab strip. Used by the portal which splits the two scopes
  // across two physical sections (own files inside the YOUR FRANCHISE DETAILS
  // panel, shared files in the FILES panel). Admin pages pass ``null`` so
  // both tabs continue to render.
  const [tab, setTab] = useState(lockedTab || "own");
  const [prefix, setPrefix] = useState(""); // relative to current root
  const [tree, setTree] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [downloadingKey, setDownloadingKey] = useState(null);
  const [viewMode, setViewMode] = useState(() => localStorage.getItem("ff:view") || "grid");
  const [preview, setPreview] = useState(null);

  // Search state — when set, list/grid show search hits instead of folder tree
  const [search, setSearch] = useState("");
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);

  // Root prefix for "their files" lazily resolved.
  const [ownRootPrefix, setOwnRootPrefix] = useState(null);

  const fetchOwnRoot = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const { data } = await api.get("/files/tree", {
        params: { prefix: "franchisees/", franchisee_id: franchisee.id },
      });
      const candidate = (data.folders || [])[0];
      setOwnRootPrefix(candidate ? candidate.key : null);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not load files.");
    } finally { setLoading(false); }
  }, [franchisee.id]);

  const fetchRoot = fetchOwnRoot;

  useEffect(() => { fetchOwnRoot(); }, [fetchOwnRoot]);
  useEffect(() => { setPrefix(""); setSearch(""); setResults(null); }, [tab]);
  useEffect(() => { localStorage.setItem("ff:view", viewMode); }, [viewMode]);

  const rootPrefix = tab === "own" ? ownRootPrefix : BRAND_ROOT;
  const fullPrefix = rootPrefix ? rootPrefix + prefix : null;

  useEffect(() => {
    if (!fullPrefix || search) return;
    setLoading(true); setErr("");
    (async () => {
      try {
        const { data } = await api.get("/files/tree", { params: { prefix: fullPrefix } });
        setTree(data);
      } catch (e) {
        setErr(e?.response?.data?.detail || "Could not load files.");
      } finally { setLoading(false); }
    })();
  }, [fullPrefix, search]);

  // Debounced search across the franchisee's accessible bucket.
  useEffect(() => {
    if (!search || search.trim().length < 2) { setResults(null); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const { data } = await api.get("/files/search", { params: { q: search.trim(), limit: 200 } });
        setResults(data);
      } catch (e) {
        setResults({ items: [], count: 0, error: e?.response?.data?.detail || "Search failed" });
      } finally { setSearching(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const download = async (key) => {
    setDownloadingKey(key);
    try {
      const { data } = await api.get("/files/download", { params: { key, attachment: true } });
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
  const breadcrumbHome = tab === "own" ? "My own franchise documents" : "Files for all franchisees";

  return (
    <div className="overflow-hidden" data-testid="franchisee-files-panel">
      {/* Green header strip — mirrors the yellow "Recently added" strip
          directly above. Hidden when the panel is locked to a single scope
          (the parent already provides its own header in that case). */}
      {!lockedTab && (
        <div className="-mx-5 px-5 py-3 bg-[#C8F2C8] flex items-center gap-2.5" data-testid="files-section-header">
          <div className="w-7 h-7 rounded-md flex items-center justify-center bg-stone-950">
            <FolderOpen className="w-4 h-4 text-[#C8F2C8]" />
          </div>
          <span className="text-sm font-display font-bold tracking-tight text-stone-950">
            Franchise File Access
          </span>
          <span className="text-[11px] uppercase tracking-[0.2em] font-bold text-stone-800">
            · all files
          </span>
        </div>
      )}

      <div className={lockedTab ? "space-y-4" : "space-y-4 pt-5"}>
        {/* Tab strip — hidden when ``lockedTab`` forces a single scope. */}
        {!lockedTab && (
          <div className="flex items-center gap-2 -mx-1 px-1 overflow-x-auto scrollbar-none" data-testid="franchisee-files-tabs" role="tablist">
            <button onClick={() => setTab("own")} data-testid="ff-tab-own" role="tab" aria-selected={tab === "own"}
              className={`touch-target shrink-0 px-4 sm:px-5 py-2.5 sm:py-3 text-xs sm:text-sm font-bold rounded-xl border-2 transition-all flex items-center gap-2 ${tab === "own"
                ? "bg-stone-950 text-white border-stone-950 shadow-sm"
                : "bg-white text-stone-700 border-stone-300 hover:border-stone-500"}`}>
              <Folder className="w-4 h-4" />
              <span className="hidden sm:inline">My own franchise documents</span>
              <span className="sm:hidden">My documents</span>
            </button>
            <button onClick={() => setTab("brand")} data-testid="ff-tab-brand" role="tab" aria-selected={tab === "brand"}
              className={`touch-target shrink-0 px-4 sm:px-5 py-2.5 sm:py-3 text-xs sm:text-sm font-bold rounded-xl border-2 transition-all flex items-center gap-2 ${tab === "brand"
                ? "bg-stone-950 text-white border-stone-950 shadow-sm"
                : "bg-white text-stone-700 border-stone-300 hover:border-stone-500"}`}>
              <Folder className="w-4 h-4" />
              <span className="hidden sm:inline">Files for all franchisees</span>
              <span className="sm:hidden">Shared files</span>
            </button>
          </div>
        )}

      {/* Search + view toggle */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-full sm:min-w-[240px]">
          <Search className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} data-testid="ff-search"
            placeholder="Search files by name…"
            className="w-full pl-9 pr-9 py-2.5 ios-no-zoom bg-white border border-stone-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-stone-900/10 focus:border-stone-500" />
          {search && (
            <button onClick={() => setSearch("")} aria-label="Clear search"
              className="touch-target absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center hover:bg-stone-100 rounded-md">
              <X className="w-4 h-4 text-stone-500" />
            </button>
          )}
        </div>
        <div className="inline-flex bg-white border border-stone-300 rounded-xl overflow-hidden text-xs font-bold">
          <button onClick={() => setViewMode("list")} data-testid="ff-view-list"
            className={`touch-target px-3 flex items-center gap-1.5 ${viewMode === "list" ? "bg-stone-950 text-white" : "text-stone-700 hover:bg-stone-50"}`}>
            <ListIcon className="w-3.5 h-3.5" /> List
          </button>
          <button onClick={() => setViewMode("grid")} data-testid="ff-view-grid"
            className={`touch-target px-3 flex items-center gap-1.5 ${viewMode === "grid" ? "bg-stone-950 text-white" : "text-stone-700 hover:bg-stone-50"}`}>
            <LayoutGrid className="w-3.5 h-3.5" /> Grid
          </button>
        </div>
        {tab === "own" && rootPrefix && !search && (
          <button onClick={zipAll} data-testid="franchisee-files-zip"
            className="touch-target px-3 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-xl flex items-center gap-1.5">
            <Package className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Download all as ZIP</span><span className="sm:hidden">ZIP</span>
          </button>
        )}
      </div>

      {/* Breadcrumb (hidden in search mode) */}
      {!search && (
        <div className="flex items-center gap-1.5 text-sm text-stone-600 flex-wrap" data-testid="franchisee-files-breadcrumb">
          <button onClick={() => setPrefix("")} className="hover:underline font-bold text-stone-900">{breadcrumbHome}</button>
          {segs.map((s, i) => {
            const upto = segs.slice(0, i + 1).join("/") + "/";
            return (
              <span key={i} className="flex items-center gap-1.5">
                <ChevronRight className="w-3.5 h-3.5 text-stone-400" />
                <button onClick={() => setPrefix(upto)} className="hover:underline">{prettyFolderName(s)}</button>
              </span>
            );
          })}
        </div>
      )}

      {/* Loading / errors */}
      {loading && !search && (
        <div className="px-4 py-10 text-center text-sm text-stone-500 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading files…
        </div>
      )}
      {!loading && err && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-xl flex items-center gap-1.5">
          <AlertCircle className="w-4 h-4" /> {err}
        </div>
      )}
      {!loading && !err && !rootPrefix && tab === "own" && (
        <div className="px-4 py-10 text-center space-y-3 border border-dashed border-stone-300 rounded-xl" data-testid="franchisee-files-empty">
          <Folder className="w-10 h-10 text-stone-300 mx-auto" />
          <div className="text-sm text-stone-500">No R2 folder mapped to this franchisee yet.</div>
          <BootstrapFoldersButton franchiseeId={franchisee.id} onCreated={fetchRoot} />
        </div>
      )}

      {/* SEARCH RESULTS */}
      {search && (
        <div className="bg-white border border-stone-200 rounded-xl overflow-hidden" data-testid="ff-search-results">
          <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between gap-3">
            <div className="text-xs uppercase tracking-widest font-bold text-stone-700">
              Search results {searching ? "…" : (results ? `· ${results.count}` : "")}
            </div>
            <button onClick={() => setSearch("")} className="text-xs text-stone-500 hover:text-stone-900">Clear search</button>
          </div>
          {searching && !results && (
            <div className="px-4 py-10 text-center text-sm text-stone-500 flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Searching…
            </div>
          )}
          {results && results.count === 0 && (
            <div className="px-4 py-10 text-center text-sm text-stone-500">No matches for “{search}”.</div>
          )}
          {results && results.count > 0 && (
            viewMode === "grid" ? <ResultsGrid items={results.items} onPreview={setPreview} onDownload={download} downloadingKey={downloadingKey} />
            : <ResultsList items={results.items} onPreview={setPreview} onDownload={download} downloadingKey={downloadingKey} />
          )}
        </div>
      )}

      {/* TREE VIEW */}
      {!search && !loading && !err && rootPrefix && tree && (
        viewMode === "grid"
          ? <TreeGrid tree={tree} onOpenFolder={(k) => setPrefix(k.slice(rootPrefix.length))} onPreview={setPreview} onDownload={download} downloadingKey={downloadingKey} />
          : <TreeList tree={tree} onOpenFolder={(k) => setPrefix(k.slice(rootPrefix.length))} onPreview={setPreview} onDownload={download} downloadingKey={downloadingKey} />
      )}

        <FilePreviewModal file={preview} onClose={() => setPreview(null)} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components

function TreeGrid({ tree, onOpenFolder, onPreview, onDownload, downloadingKey }) {
  if (tree.folders.length === 0 && tree.files.length === 0) {
    return <div className="px-4 py-10 text-center text-sm text-stone-500 border border-dashed border-stone-300 rounded-xl">This folder is empty.</div>;
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3" data-testid="ff-grid">
      {tree.folders.map((f) => (
        <button key={f.key} onClick={() => onOpenFolder(f.key)} data-testid={`ff-folder-${f.name}`}
          className="group flex flex-col items-stretch border border-stone-200 hover:border-stone-500 hover:shadow-md transition-all rounded-xl overflow-hidden bg-white text-left">
          <div className="aspect-square bg-[#D4FF00]/15 flex items-center justify-center border-b border-[#D4FF00]/30">
            <Folder className="w-16 h-16 text-[#14532D] group-hover:scale-105 transition-transform" />
          </div>
          <div className="p-3">
            <div className="text-sm font-semibold text-stone-900 truncate" title={f.name}>{prettyFolderName(f.name)}</div>
            <div className="text-xs text-stone-500 tabular-nums mt-0.5">{f.files} files · {fmtBytes(f.bytes)}</div>
          </div>
        </button>
      ))}
      {tree.files.map((it) => (
        <FileTile key={it.key} file={it} onPreview={onPreview} onDownload={onDownload} downloadingKey={downloadingKey} />
      ))}
    </div>
  );
}

function TreeList({ tree, onOpenFolder, onPreview, onDownload, downloadingKey }) {
  if (tree.folders.length === 0 && tree.files.length === 0) {
    return <div className="px-4 py-10 text-center text-sm text-stone-500 border border-dashed border-stone-300 rounded-xl">This folder is empty.</div>;
  }
  return (
    <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-100 overflow-hidden" data-testid="ff-list">
      {tree.folders.map((f) => (
        <button key={f.key} onClick={() => onOpenFolder(f.key)} data-testid={`ff-folder-${f.name}`}
          className="touch-target w-full px-3 sm:px-4 py-3 flex items-center justify-between gap-3 hover:bg-stone-50 text-left">
          <div className="flex items-center gap-3 min-w-0">
            <Folder className="w-5 h-5 text-[#14532D] shrink-0" />
            <span className="text-sm text-stone-900 truncate">{prettyFolderName(f.name)}</span>
          </div>
          <span className="text-[11px] text-stone-500 tabular-nums shrink-0">{f.files} files</span>
        </button>
      ))}
      {tree.files.map((it) => (
        <FileRow key={it.key} file={it} onPreview={onPreview} onDownload={onDownload} downloadingKey={downloadingKey} />
      ))}
    </div>
  );
}

function ResultsGrid({ items, onPreview, onDownload, downloadingKey }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 p-3">
      {items.map((it) => (
        <FileTile key={it.key} file={it} onPreview={onPreview} onDownload={onDownload} downloadingKey={downloadingKey} showPath />
      ))}
    </div>
  );
}

function ResultsList({ items, onPreview, onDownload, downloadingKey }) {
  return (
    <div className="divide-y divide-stone-100">
      {items.map((it) => (
        <FileRow key={it.key} file={it} onPreview={onPreview} onDownload={onDownload} downloadingKey={downloadingKey} showPath />
      ))}
    </div>
  );
}

function FileTile({ file, onPreview, onDownload, downloadingKey, showPath = false }) {
  return (
    <div className="group flex flex-col items-stretch border border-stone-200 hover:border-stone-500 hover:shadow-md transition-all rounded-xl overflow-hidden bg-white" data-testid={`ff-file-tile-${file.key}`}>
      <button onClick={() => onPreview(file)} className="aspect-square overflow-hidden" data-testid={`ff-preview-${file.key}`}>
        <FileThumbnail file={file} className="w-full h-full" />
      </button>
      <div className="p-3">
        <div className="text-sm font-semibold text-stone-900 truncate" title={file.name}>{file.name}</div>
        {showPath && file.key && (
          <div className="text-[11px] text-stone-500 truncate" title={file.key}>{file.key.replace(/\/[^/]+$/, "")}</div>
        )}
        <div className="flex items-center justify-between mt-2 gap-1">
          <span className="text-[11px] text-stone-500 tabular-nums">{fmtBytes(file.size)}</span>
          <button onClick={() => onDownload(file.key)} disabled={downloadingKey === file.key}
            data-testid={`ff-dl-${file.key}`}
            className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md flex items-center gap-1 disabled:opacity-50">
            {downloadingKey === file.key ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Download className="w-3 h-3" /> Save</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function FileRow({ file, onPreview, onDownload, downloadingKey, showPath = false }) {
  return (
    <div className="px-3 sm:px-4 py-3 flex items-center justify-between gap-3 hover:bg-stone-50" data-testid={`ff-file-row-${file.key}`}>
      <button onClick={() => onPreview(file)} className="flex items-center gap-3 min-w-0 flex-1 text-left touch-target" data-testid={`ff-preview-row-${file.key}`}>
        <div className="w-12 h-12 shrink-0 rounded-md overflow-hidden border border-stone-200 bg-white">
          <FileThumbnail file={file} className="w-full h-full" />
        </div>
        <div className="min-w-0">
          <div className="text-sm text-stone-900 truncate">{file.name}</div>
          {showPath && file.key && (
            <div className="text-[11px] text-stone-500 truncate" title={file.key}>{file.key.replace(/\/[^/]+$/, "")}</div>
          )}
          <div className="text-[11px] text-stone-500 tabular-nums sm:hidden mt-0.5">{fmtBytes(file.size)}</div>
        </div>
      </button>
      <div className="flex items-center gap-3 shrink-0">
        <span className="hidden sm:inline text-xs text-stone-500 tabular-nums">{fmtBytes(file.size)}</span>
        <button onClick={() => onDownload(file.key)} disabled={downloadingKey === file.key}
          data-testid={`ff-dl-row-${file.key}`}
          aria-label={`Download ${file.name}`}
          className="touch-target px-3 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md flex items-center gap-1 disabled:opacity-50">
          {downloadingKey === file.key ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <><Download className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Save</span></>}
        </button>
      </div>
    </div>
  );
}

function BootstrapFoldersButton({ franchiseeId, onCreated }) {
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      await api.post("/franchisees/bootstrap-folders", { franchisee_id: franchiseeId });
      onCreated?.();
    } catch (e) { alert(e?.response?.data?.detail || "Could not create folders."); }
    finally { setBusy(false); }
  };
  return (
    <button onClick={create} disabled={busy} data-testid="ff-bootstrap"
      className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg flex items-center gap-1.5 mx-auto disabled:opacity-50">
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderPlus className="w-3.5 h-3.5" />}
      Set up standard folders
    </button>
  );
}
