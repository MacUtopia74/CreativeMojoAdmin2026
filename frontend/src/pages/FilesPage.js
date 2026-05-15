// Phase 3 — Admin File Browser. Read-only file index over R2, populated by
// the FileCamp migration. Three views:
//   • Sidebar of scopes/franchisees (counts + sizes)
//   • Centre tree-list of the current prefix
//   • Top search bar (whole-bucket name search)
//
// Migration panel lives at the top — Dry-Run / Commit / live progress.
import { useEffect, useMemo, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import { formatDate } from "@/lib/date";
import {
  Folder, FolderOpen, File as FileIcon, ChevronRight, Search,
  Download, Loader2, AlertCircle, CloudUpload, Database, Users, Lock, Globe,
  RefreshCw, ChevronUp, ChevronDown, X, ExternalLink,
} from "lucide-react";

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


export default function FilesPage() {
  const [scopeTree, setScopeTree] = useState(null);
  const [tree, setTree] = useState(null);
  const [prefix, setPrefix] = useState("");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [downloadingKey, setDownloadingKey] = useState(null);

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
              <button onClick={() => setPrefix("")} data-testid="scope-all"
                className={`w-full px-3 py-2 text-left text-xs font-bold uppercase tracking-wider hover:bg-stone-50 ${prefix === "" ? "bg-stone-100" : ""}`}>
                All files
              </button>
              <div className="border-t border-stone-100">
                <div className="px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 bg-stone-50">Shared</div>
                {(scopeTree?.shared_folders || []).map((f) => (
                  <button key={f.folder} onClick={() => setPrefix(`shared/${f.folder}/`)}
                    className={`w-full px-3 py-2 text-left text-xs hover:bg-stone-50 flex items-center justify-between ${prefix === `shared/${f.folder}/` ? "bg-blue-50" : ""}`}>
                    <span className="flex items-center gap-2 truncate"><Globe className="w-3 h-3 text-blue-600" /> {f.folder.replace(/-/g, " ")}</span>
                    <span className="text-[10px] text-stone-500 tabular-nums">{f.files}</span>
                  </button>
                ))}
              </div>
              <div className="border-t border-stone-100">
                <div className="px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 bg-stone-50">Admin only</div>
                {(scopeTree?.admin_folders || []).map((f) => (
                  <button key={f.folder} onClick={() => setPrefix(`admin/${f.folder}/`)}
                    className={`w-full px-3 py-2 text-left text-xs hover:bg-stone-50 flex items-center justify-between ${prefix === `admin/${f.folder}/` ? "bg-amber-50" : ""}`}>
                    <span className="flex items-center gap-2 truncate"><Lock className="w-3 h-3 text-amber-600" /> {f.folder.replace(/-/g, " ")}</span>
                    <span className="text-[10px] text-stone-500 tabular-nums">{f.files}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
              <div className="px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 bg-stone-50 border-b border-stone-200">Franchisees</div>
              <div className="max-h-[60vh] overflow-y-auto">
                {(scopeTree?.franchisees || []).length === 0 && (
                  <div className="px-3 py-4 text-xs text-stone-500">No franchisees yet</div>
                )}
                {(scopeTree?.franchisees || []).map((f) => (
                  <button key={f.franchisee_id} onClick={() => setPrefix("franchisees/")}
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
            {results ? (
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
                        <div className="flex items-center gap-3 truncate">
                          <FileIcon className="w-3.5 h-3.5 text-stone-500 shrink-0" />
                          <div className="truncate">
                            <div className="text-sm text-stone-900 truncate">{it.name}</div>
                            <div className="text-[11px] text-stone-500 truncate font-mono">{it.parent_prefix}</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <ScopeBadge scope={it.scope} />
                          <span className="text-xs text-stone-500 tabular-nums">{fmtBytes(it.size)}</span>
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
                <div className="bg-white border border-stone-200 rounded-2xl px-4 py-3" data-testid="files-tree">
                  <Breadcrumb prefix={prefix} onJump={setPrefix} />
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
                    <div className="divide-y divide-stone-100">
                      {tree.folders.map((f) => (
                        <button key={f.key} onClick={() => setPrefix(f.key)}
                          data-testid={`folder-${f.name}`}
                          className="w-full px-4 py-2 hover:bg-stone-50 flex items-center justify-between text-left">
                          <div className="flex items-center gap-3 truncate">
                            <Folder className="w-4 h-4 text-amber-600 shrink-0" />
                            <span className="text-sm text-stone-900 truncate">{f.name.replace(/-/g, " ")}</span>
                          </div>
                          <span className="text-xs text-stone-500 tabular-nums">{f.files} files · {fmtBytes(f.bytes)}</span>
                        </button>
                      ))}
                      {tree.files.map((it) => (
                        <div key={it.key} className="px-4 py-2 flex items-center justify-between hover:bg-stone-50" data-testid={`file-row-${it.key}`}>
                          <div className="flex items-center gap-3 truncate">
                            <FileIcon className="w-3.5 h-3.5 text-stone-500 shrink-0" />
                            <span className="text-sm text-stone-900 truncate">{it.name}</span>
                            {it.orphan && <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider bg-amber-100 text-amber-900 border border-amber-300 rounded-md">orphan</span>}
                          </div>
                          <div className="flex items-center gap-3">
                            <ScopeBadge scope={it.scope} />
                            <span className="text-xs text-stone-500 tabular-nums">{fmtBytes(it.size)}</span>
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
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
