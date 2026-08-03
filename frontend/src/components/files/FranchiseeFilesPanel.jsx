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
import { useEffect, useRef, useState, useCallback } from "react";
import api, { API_BASE } from "@/lib/api";

// Set localStorage.setItem("ff:debug","0") to silence, or leave alone
// to keep verbose console logs from FranchiseeFilesPanel. Verbose by
// default while we're chasing the "0 files rendered" bug on
// production. Toggle off in prod with:
//     localStorage.setItem("ff:debug","0"); location.reload();
const FF_DEBUG = (() => {
  if (typeof window === "undefined") return false;
  if (window.__FF_DEBUG === false) return false;
  if (window.__FF_DEBUG) return true;
  try {
    const v = localStorage.getItem("ff:debug");
    if (v === "0") return false;
    return true; // default ON until we've confirmed the fix
  } catch { return true; }
})();
const flog = (...args) => { if (FF_DEBUG) console.log("[FFPanel]", ...args); };
const fwarn = (...args) => { if (FF_DEBUG) console.warn("[FFPanel]", ...args); };
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

export default function FranchiseeFilesPanel({ franchisee, canUpload = true, lockedTab = null, hideZipAll = false, hideRootBreadcrumb = false, openPrefixSignal = null }) {
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

  // ---------------------------------------------------------------
  // Abort controllers — we run two chained fetches (root discovery +
  // tree listing) and both can be superseded by a franchisee change or
  // a tab flip. Without cancellation, an in-flight response can land
  // AFTER a newer request completes and stomp the freshly-loaded
  // ``tree`` / ``ownRootPrefix`` state with stale data (empty for the
  // previous franchisee, for example). That was the root cause of the
  // "0 files rendered even though the diagnostic simulation returns
  // 4+5" symptom — the second effect kicked off with a stale
  // fullPrefix while the root was still resolving, then the *first*
  // fetch's response overrode ``ownRootPrefix`` mid-flight so tree
  // state ended up dangling and never re-fetched.
  const rootAbortRef = useRef(null);
  const treeAbortRef = useRef(null);

  const fetchOwnRoot = useCallback(async () => {
    // Cancel any in-flight root discovery for the previous franchisee.
    if (rootAbortRef.current) rootAbortRef.current.abort();
    const ac = new AbortController();
    rootAbortRef.current = ac;
    setLoading(true); setErr("");
    flog("fetchOwnRoot() start", { franchisee_id: franchisee?.id });
    try {
      const { data } = await api.get("/files/tree", {
        params: { prefix: "franchisees/", franchisee_id: franchisee.id },
        signal: ac.signal,
      });
      if (ac.signal.aborted) { flog("fetchOwnRoot aborted post-response"); return; }
      const folders = data?.folders || [];
      // Prefer the folder that actually holds files. Backend sorts
      // ``folders`` alphabetically by name, which used to bite us in
      // rename scenarios — e.g. a franchisee originally onboarded as
      // "0091-carer-plus" whose organisation was later renamed to
      // "0091-samantha-whiteman-mynurserycare". files_index rows keep
      // the ORIGINAL prefix, and the derived canonical prefix now
      // points at the new slug. Picking ``folders[0]`` blindly would
      // land the panel on the empty (new) folder even though the
      // legacy (populated) folder is right there.
      //
      // Strategy:
      //   1. If exactly one candidate: use it.
      //   2. Otherwise, prefer the candidate with the most files. Ties
      //      broken by highest byte size, then alphabetical name.
      const candidate = folders.length <= 1
        ? folders[0]
        : [...folders].sort((a, b) => {
            if ((b.files || 0) !== (a.files || 0)) return (b.files || 0) - (a.files || 0);
            if ((b.bytes || 0) !== (a.bytes || 0)) return (b.bytes || 0) - (a.bytes || 0);
            return (a.name || "").localeCompare(b.name || "");
          })[0];
      flog("fetchOwnRoot response", {
        folder_count: folders.length,
        candidate_key: candidate?.key || null,
        candidate_files: candidate?.files || 0,
        candidate_bytes: candidate?.bytes || 0,
        all_root_folders: folders.map((f) => ({ key: f.key, files: f.files, bytes: f.bytes })),
      });
      if (folders.length > 1) {
        fwarn(
          "Multiple root folders returned for this franchisee — selected the one with the most files. This usually means the organisation slug changed after upload; consider consolidating the two prefixes.",
          folders.map((f) => ({ key: f.key, files: f.files })),
        );
      }
      setOwnRootPrefix(candidate ? candidate.key : null);
    } catch (e) {
      if (ac.signal.aborted || e?.name === "CanceledError" || e?.code === "ERR_CANCELED") {
        flog("fetchOwnRoot canceled");
        return;
      }
      flog("fetchOwnRoot error", e?.message || e);
      setErr(e?.response?.data?.detail || "Could not load files.");
    } finally {
      if (rootAbortRef.current === ac) setLoading(false);
    }
  }, [franchisee.id]);

  const fetchRoot = fetchOwnRoot;

  useEffect(() => { fetchOwnRoot(); }, [fetchOwnRoot]);
  useEffect(() => { setPrefix(""); setSearch(""); setResults(null); }, [tab]);
  useEffect(() => { localStorage.setItem("ff:view", viewMode); }, [viewMode]);

  const rootPrefix = tab === "own" ? ownRootPrefix : BRAND_ROOT;
  const fullPrefix = rootPrefix ? rootPrefix + prefix : null;

  // Allow the parent (e.g. PortalFilesPage) to imperatively navigate
  // this panel to a specific absolute R2 prefix — used by the
  // "Recently added" strip so franchisees can click a folder tile and
  // jump straight into it. ``openPrefixSignal`` is an absolute key
  // (e.g. "shared/files-for-all-franchisees/Foo Bar/"); we strip the
  // active tab's root prefix to get the panel's relative path.
  useEffect(() => {
    if (!openPrefixSignal || !rootPrefix) return;
    if (!openPrefixSignal.startsWith(rootPrefix)) return; // out of scope
    const rel = openPrefixSignal.slice(rootPrefix.length);
    setPrefix(rel);
    setSearch("");
    setResults(null);
  }, [openPrefixSignal, rootPrefix]);

  useEffect(() => {
    if (!fullPrefix || search) return;
    // Cancel any in-flight tree fetch for the previous prefix. Without
    // this, a slower request from an older ``fullPrefix`` could land
    // after a newer one and blank the freshly-loaded tree — which is
    // exactly the "0 files displayed" symptom users were seeing.
    if (treeAbortRef.current) treeAbortRef.current.abort();
    const ac = new AbortController();
    treeAbortRef.current = ac;
    setLoading(true); setErr("");
    // Clear stale tree data so the previous franchisee/folder's
    // contents don't linger while the new fetch is in flight.
    setTree(null);
    const url = `${API_BASE}/files/tree?prefix=${encodeURIComponent(fullPrefix)}`;
    flog("tree fetch start", { fullPrefix, url });
    (async () => {
      try {
        const { data } = await api.get("/files/tree", {
          params: { prefix: fullPrefix },
          signal: ac.signal,
        });
        if (ac.signal.aborted) { flog("tree fetch aborted post-response", { fullPrefix }); return; }
        flog("tree fetch response", {
          fullPrefix,
          folder_count: (data?.folders || []).length,
          file_count: (data?.files || []).length,
          folder_cards: (data?.folders || []).map((f) => ({ name: f.name, key: f.key, files: f.files, bytes: f.bytes })),
          file_names: (data?.files || []).map((f) => f.name),
          total_in_tree: data?.total_in_tree,
        });
        setTree(data);
      } catch (e) {
        if (ac.signal.aborted || e?.name === "CanceledError" || e?.code === "ERR_CANCELED") {
          flog("tree fetch canceled", { fullPrefix });
          return;
        }
        flog("tree fetch error", { fullPrefix, message: e?.message || e });
        setErr(e?.response?.data?.detail || "Could not load files.");
      } finally {
        if (treeAbortRef.current === ac) setLoading(false);
      }
    })();
    return () => { ac.abort(); };
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

  // Reveal a search-result file inside its containing folder. Works
  // across tabs: if the file lives under the brand bucket we hop the
  // tab, otherwise we stay on "own". Clears the search so the tree
  // browser is what the user sees on return.
  const openFolderFor = (file) => {
    const parent = file?.parent_prefix
      || (file?.key ? file.key.replace(/\/[^/]+$/, "/") : "");
    if (!parent) return;
    let nextTab = tab;
    let root = rootPrefix;
    if (parent.startsWith(BRAND_ROOT)) {
      nextTab = "brand";
      root = BRAND_ROOT;
    } else if (ownRootPrefix && parent.startsWith(ownRootPrefix)) {
      nextTab = "own";
      root = ownRootPrefix;
    }
    const rel = root && parent.startsWith(root) ? parent.slice(root.length) : parent;
    if (!lockedTab && nextTab !== tab) setTab(nextTab);
    setSearch("");
    setResults(null);
    setPrefix(rel);
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

      {/* Search + view toggle. Search is hidden in "own" locked mode (the
          Profile panel) — franchisees have so few personal files that the
          input adds clutter without value. Browsing the small folder
          structure is faster. */}
      <div className="flex items-center gap-2 flex-wrap">
        {lockedTab !== "own" && (
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
        )}
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
        {tab === "own" && rootPrefix && !search && !hideZipAll && (
          <button onClick={zipAll} data-testid="franchisee-files-zip"
            className="touch-target px-3 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-xl flex items-center gap-1.5">
            <Package className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Download all as ZIP</span><span className="sm:hidden">ZIP</span>
          </button>
        )}
      </div>

      {/* Breadcrumb (hidden in search mode) — pill buttons so it's clear
          each segment is a clickable shortcut back up the tree. The
          host page can also pass `hideRootBreadcrumb` so the breadcrumb
          disappears at the root (it only carries information once the
          user has drilled into a subfolder). */}
      {!search && !(hideRootBreadcrumb && segs.length === 0) && (
        <nav
          aria-label="Folder path"
          data-testid="franchisee-files-breadcrumb"
          className="flex items-center gap-2 flex-wrap bg-stone-50 border border-stone-200 rounded-2xl px-3 py-2.5"
        >
          <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-stone-500 px-1 hidden sm:inline">Folder</span>
          {(() => {
            const pillBase = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-stone-950";
            const pillInactive = "bg-white border-stone-300 text-stone-700 hover:bg-stone-100 hover:border-stone-950 hover:text-stone-950";
            const pillActive = "bg-stone-950 border-stone-950 text-white cursor-default";
            const atRoot = segs.length === 0;
            return (
              <>
                <button
                  type="button"
                  onClick={() => atRoot ? null : setPrefix("")}
                  aria-current={atRoot ? "page" : undefined}
                  className={`${pillBase} ${atRoot ? pillActive : pillInactive}`}
                >
                  <Folder className="w-3.5 h-3.5" /> {breadcrumbHome}
                </button>
                {segs.map((s, i) => {
                  const upto = segs.slice(0, i + 1).join("/") + "/";
                  const isLast = i === segs.length - 1;
                  return (
                    <span key={i} className="flex items-center gap-2">
                      <ChevronRight className="w-4 h-4 text-stone-400" />
                      <button
                        type="button"
                        onClick={() => isLast ? null : setPrefix(upto)}
                        aria-current={isLast ? "page" : undefined}
                        className={`${pillBase} ${isLast ? pillActive : pillInactive}`}
                      >
                        {prettyFolderName(s)}
                      </button>
                    </span>
                  );
                })}
              </>
            );
          })()}
        </nav>
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
            viewMode === "grid" ? <ResultsGrid items={results.items} onPreview={setPreview} onDownload={download} onOpenFolder={openFolderFor} downloadingKey={downloadingKey} />
            : <ResultsList items={results.items} onPreview={setPreview} onDownload={download} onOpenFolder={openFolderFor} downloadingKey={downloadingKey} />
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
          <div className="aspect-square bg-[#dddd16]/15 flex items-center justify-center border-b border-[#dddd16]/30">
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

function ResultsGrid({ items, onPreview, onDownload, onOpenFolder, downloadingKey }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 p-3">
      {items.map((it) => (
        <FileTile key={it.key} file={it} onPreview={onPreview} onDownload={onDownload} onOpenFolder={onOpenFolder} downloadingKey={downloadingKey} showPath />
      ))}
    </div>
  );
}

function ResultsList({ items, onPreview, onDownload, onOpenFolder, downloadingKey }) {
  return (
    <div className="divide-y divide-stone-100">
      {items.map((it) => (
        <FileRow key={it.key} file={it} onPreview={onPreview} onDownload={onDownload} onOpenFolder={onOpenFolder} downloadingKey={downloadingKey} showPath />
      ))}
    </div>
  );
}

function FileTile({ file, onPreview, onDownload, onOpenFolder, downloadingKey, showPath = false }) {
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
          <div className="flex items-center gap-1">
            {showPath && onOpenFolder && (
              <button
                onClick={() => onOpenFolder(file)}
                title="Reveal this file in its folder"
                data-testid={`ff-open-folder-${file.key}`}
                className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-50 text-stone-800 rounded-md flex items-center gap-1"
              >
                <FolderOpen className="w-3 h-3" />
              </button>
            )}
            <button onClick={() => onDownload(file.key)} disabled={downloadingKey === file.key}
              data-testid={`ff-dl-${file.key}`}
              className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md flex items-center gap-1 disabled:opacity-50">
              {downloadingKey === file.key ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Download className="w-3 h-3" /> Save</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FileRow({ file, onPreview, onDownload, onOpenFolder, downloadingKey, showPath = false }) {
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
      <div className="flex items-center gap-2 shrink-0">
        <span className="hidden sm:inline text-xs text-stone-500 tabular-nums">{fmtBytes(file.size)}</span>
        {showPath && onOpenFolder && (
          <button
            onClick={() => onOpenFolder(file)}
            title="Reveal this file in its folder"
            data-testid={`ff-open-folder-row-${file.key}`}
            aria-label="Open file folder"
            className="touch-target px-3 text-[10px] font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-50 text-stone-800 rounded-md flex items-center gap-1"
          >
            <FolderOpen className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Open Folder</span>
          </button>
        )}
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
      await api.post(`/franchisees/${franchiseeId}/bootstrap-folders`);
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
