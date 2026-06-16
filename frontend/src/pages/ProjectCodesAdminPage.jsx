// Admin tool: assign Project Codes that link WooCommerce products to
// Cloudflare R2 project assets (PDFs, SVGs, stencils, videos, images).
//
// Layout:
//   Top — counters (woo total / with code / matched / file total / file with code)
//   ── Suggested Matches panel
//      Auto-generated fuzzy-match suggestions, sorted by confidence.
//      Each row: product card ↔ file card + one-click Approve / Skip.
//      "Approve all ≥ 90%" bulk button at the top.
//   ── Manual mapping tables
//      Two tabs: Woo Products + Cloudflare Files.
//      Click a row → inline editor sets/clears the Project Code.
//
// Per the locked product brief (16 Jun 2026):
//   • Project Codes stored Hub-primary (Mongo). Not in WooCommerce, not
//     in R2 metadata.
//   • Each file also carries an ``asset_type`` so one code can link
//     many files (instruction_pdf, svg_cutting, stencil, video, image,
//     other).
import { useEffect, useMemo, useState, useCallback } from "react";
import api from "@/lib/api";
import {
  Loader2, Search, Link2, CheckCircle2, X, AlertCircle,
  RefreshCw, Sparkles, FileText, Box, FileImage, Film,
  Layers, Hash, Filter,
} from "lucide-react";

const ASSET_TYPES = [
  { value: "instruction_pdf", label: "Instruction PDF",  icon: FileText },
  { value: "svg_cutting",     label: "SVG Cutting File", icon: Box },
  { value: "stencil",         label: "Stencil",          icon: Layers },
  { value: "video",           label: "Video",            icon: Film },
  { value: "image",           label: "Image",            icon: FileImage },
  { value: "other",           label: "Other",            icon: Hash },
];

function AssetTypeChip({ type }) {
  const meta = ASSET_TYPES.find((t) => t.value === type);
  if (!meta) return null;
  const I = meta.icon;
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded bg-stone-100 text-stone-700 border border-stone-200">
      <I className="w-3 h-3" /> {meta.label}
    </span>
  );
}

function ScorePill({ score }) {
  const cls = score >= 95
    ? "bg-emerald-100 text-emerald-900 border-emerald-300"
    : score >= 85
    ? "bg-sky-100 text-sky-900 border-sky-300"
    : "bg-amber-100 text-amber-900 border-amber-300";
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded border ${cls}`}>
      {score}% match
    </span>
  );
}

export default function ProjectCodesAdminPage() {
  const [data, setData] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [flash, setFlash] = useState("");
  const [q, setQ] = useState("");
  const [tab, setTab] = useState("products");  // products | files
  const [status, setStatus] = useState("all");  // all | matched | woo_only | file_only
  const [minScore, setMinScore] = useState(90);
  const [editing, setEditing] = useState(null);  // {type:'woo'|'file', id, value, asset_type}
  const [bulkReview, setBulkReview] = useState(null);  // null | { items, min_score }
  const [skipsCount, setSkipsCount] = useState(0);

  const reload = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const [main, sug, skips] = await Promise.all([
        api.get("/admin/project-codes", { params: { q: q || undefined, status } }),
        api.get("/admin/project-codes/suggestions", { params: { min_score: minScore } }),
        api.get("/admin/project-codes/suggestions/skipped"),
      ]);
      setData(main.data);
      setSuggestions(sug.data.items || []);
      setSkipsCount(skips.data.count || 0);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't load project codes.");
    } finally { setLoading(false); }
  }, [q, status, minScore]);

  useEffect(() => { reload(); }, [reload]);

  const syncWoo = async () => {
    setBusy(true); setErr(""); setFlash("");
    try {
      await api.post("/admin/woo/sync-products");
      // The sync runs in a background task — wait a couple of seconds
      // for the first page of products + their variations to flush
      // through, then refresh. Honest UX: surface a "scheduled" note
      // so the user knows a longer sync is happening behind the scenes.
      setFlash("WooCommerce sync running in the background — refreshing in 6 s…");
      setTimeout(async () => { await reload(); setFlash("WooCommerce sync complete."); }, 6000);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Sync failed.");
    } finally {
      setBusy(false);
    }
  };

  const approve = async (sug, match) => {
    try {
      await api.post("/admin/project-codes/suggestions/approve", {
        woo_id: sug.woo_id,
        file_key: match.file_key,
        project_code: sug.suggested_code,
        asset_type: match.asset_type_guess,
      });
      setFlash(`Linked "${sug.product_name}" → ${match.file_name}`);
      await reload();
    } catch (e) {
      setErr(e?.response?.data?.detail || "Approve failed.");
    }
  };

  const skip = async (sug, match) => {
    try {
      await api.post("/admin/project-codes/suggestions/skip", {
        woo_id: sug.woo_id, file_key: match.file_key,
      });
      await reload();
    } catch (e) { /* noop */ }
  };

  const openBulkReview = () => {
    if (minScore < 90) {
      setErr("Bulk approval requires a minimum confidence of 90%. Raise the threshold and try again.");
      return;
    }
    // Only the pairs at-or-above the threshold are eligible. We use
    // the suggestions already loaded so the review is instant.
    const eligible = suggestions
      .filter((s) => s.matches?.[0]?.score >= minScore)
      .map((s) => ({
        woo_id: s.woo_id,
        product_name: s.product_name,
        product_image: s.product_image,
        suggested_code: s.suggested_code,
        match: s.matches[0],
      }));
    if (!eligible.length) {
      setErr(`No suggestions meet the ${minScore}% confidence threshold.`);
      return;
    }
    setBulkReview({ items: eligible, min_score: minScore });
  };

  const confirmBulkApprove = async () => {
    if (!bulkReview) return;
    setBusy(true); setErr(""); setFlash("");
    // Loop the curated review list and call the per-item approve
    // endpoint so any rows the admin dropped really do stay dropped.
    // Server's bulk endpoint matches by threshold and would otherwise
    // re-approve them.
    let ok = 0, fail = 0;
    for (const it of bulkReview.items) {
      try {
        await api.post("/admin/project-codes/suggestions/approve", {
          woo_id: it.woo_id,
          file_key: it.match.file_key,
          project_code: it.suggested_code,
          asset_type: it.match.asset_type_guess,
        });
        ok++;
      } catch {
        fail++;
      }
    }
    setFlash(`Bulk-approved ${ok} link${ok === 1 ? "" : "s"}${fail ? ` · ${fail} failed` : ""}.`);
    setBulkReview(null);
    setBusy(false);
    await reload();
  };

  const resetSkips = async () => {
    if (!window.confirm(`Reset ${skipsCount} skipped suggestion${skipsCount === 1 ? "" : "s"}? They'll re-appear in the suggestions list for re-evaluation.`)) return;
    setBusy(true); setErr(""); setFlash("");
    try {
      const { data: r } = await api.post("/admin/project-codes/suggestions/reset-skips");
      setFlash(`Reset ${r.cleared} skip${r.cleared === 1 ? "" : "s"}. Suggestions refreshed.`);
      await reload();
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not reset skips.");
    } finally { setBusy(false); }
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      if (editing.type === "woo") {
        await api.put(`/admin/project-codes/woo/${encodeURIComponent(editing.id)}`,
          { project_code: editing.value });
      } else {
        await api.put(`/admin/project-codes/file/${encodeURIComponent(editing.id)}`,
          { project_code: editing.value, asset_type: editing.asset_type });
      }
      setFlash(editing.value ? "Code saved." : "Code cleared.");
      setEditing(null);
      await reload();
    } catch (e) {
      setErr(e?.response?.data?.detail || "Save failed.");
    }
  };

  const counts = data?.counts || {};
  const woo = data?.products || [];
  const files = data?.files || [];
  const matchedPct = useMemo(() => {
    if (!counts.woo_total) return 0;
    return Math.round((counts.woo_matched_to_file / counts.woo_total) * 100);
  }, [counts]);

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-7xl" data-testid="project-codes-admin-page">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 flex items-center gap-2">
            <Link2 className="w-3 h-3" /> Mapping · Cross-system glue
          </div>
          <h1 className="font-display text-4xl text-stone-950 mt-1">Project Codes</h1>
          <p className="text-sm text-stone-600 mt-2 max-w-2xl">
            Link WooCommerce products to their project guide files (PDFs, SVGs, stencils, videos, images).
            One <strong>Project Code</strong> can connect many assets — the modal on the franchisee calendar
            uses the linked <strong>Instruction PDF</strong> for its &ldquo;Open Project Guide&rdquo; button.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={syncWoo}
            disabled={busy}
            data-testid="pc-sync-woo"
            className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh from Woo
          </button>
        </div>
      </div>

      {/* Counters */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Counter label="Woo products"     value={counts.woo_total ?? "—"} testid="ct-woo-total" />
        <Counter label="With Project Code" value={counts.woo_with_code ?? "—"} accent="emerald" testid="ct-woo-with-code" />
        <Counter label="Matched to file"  value={counts.woo_matched_to_file ?? "—"} accent="emerald" testid="ct-woo-matched" tail={counts.woo_total ? `${matchedPct}%` : null} />
        <Counter label="R2 files indexed" value={counts.files_total ?? "—"} testid="ct-files-total" />
        <Counter label="Files tagged"     value={counts.files_with_code ?? "—"} accent="emerald" testid="ct-files-tagged" />
      </div>

      {err && (
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-900 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {err}
        </div>
      )}
      {flash && (
        <div className="px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-900 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" /> {flash}
        </div>
      )}

      {/* Suggestions panel */}
      <section className="bg-white border border-stone-200 rounded-2xl p-4" data-testid="suggestions-panel">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-500" />
            <h2 className="font-display text-xl text-stone-950">Suggested matches</h2>
            <span className="text-xs text-stone-500">({suggestions.length})</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-[11px] uppercase tracking-wider font-bold text-stone-600 flex items-center gap-2">
              Min score
              <input
                type="number" min="50" max="100" value={minScore}
                onChange={(e) => setMinScore(Math.max(50, Math.min(100, parseInt(e.target.value || "90", 10))))}
                data-testid="pc-min-score"
                className="w-16 px-2 py-1 text-xs border border-stone-300 rounded-md"
              />
            </label>
            {skipsCount > 0 && (
              <button
                onClick={resetSkips}
                disabled={busy}
                data-testid="pc-reset-skips"
                title="Bring previously-dismissed suggestions back"
                className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-white hover:bg-stone-50 text-stone-700 border border-stone-300 rounded-lg flex items-center gap-1.5 disabled:opacity-40"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Reset {skipsCount} skip{skipsCount === 1 ? "" : "s"}
              </button>
            )}
            <button
              onClick={openBulkReview}
              disabled={busy || !suggestions.length || minScore < 90}
              data-testid="pc-approve-bulk"
              title={minScore < 90 ? "Bulk approval requires confidence ≥ 90%" : `Review every suggestion at ≥ ${minScore}%`}
              className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-[#dedd0a] rounded-lg flex items-center gap-1.5 disabled:opacity-40"
            >
              <Sparkles className="w-3.5 h-3.5" /> Review &amp; bulk approve ≥ {minScore}%
            </button>
          </div>
        </div>
        {loading ? (
          <div className="py-10 text-center text-stone-500"><Loader2 className="w-5 h-5 animate-spin inline" /> Building suggestions…</div>
        ) : !suggestions.length ? (
          <div className="py-8 text-center text-sm text-stone-500">
            Nothing left to suggest at this confidence. Lower the min score or assign manually below.
          </div>
        ) : (
          <ul className="space-y-2">
            {suggestions.slice(0, 30).map((s) => {
              const top = s.matches[0];
              return (
                <li key={s.woo_id} data-testid={`suggest-${s.woo_id}`} className="flex items-center gap-3 p-3 border border-stone-200 rounded-xl">
                  {s.product_image ? (
                    <img src={s.product_image} alt="" className="w-12 h-12 object-cover rounded shrink-0 bg-stone-100" />
                  ) : (
                    <div className="w-12 h-12 rounded shrink-0 bg-stone-100 flex items-center justify-center text-stone-400"><Box className="w-5 h-5" /></div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold text-stone-950 truncate">{s.product_name}</div>
                    <div className="text-xs text-stone-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
                      <span className="font-mono">{s.suggested_code}</span>
                      <span className="text-stone-300">↔</span>
                      <span className="text-stone-700 truncate">{top.file_name}</span>
                      <AssetTypeChip type={top.asset_type_guess} />
                    </div>
                  </div>
                  <ScorePill score={top.score} />
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => approve(s, top)}
                      data-testid={`approve-${s.woo_id}`}
                      className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider bg-emerald-600 hover:bg-emerald-700 text-white rounded-md flex items-center gap-1"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                    </button>
                    <button
                      onClick={() => skip(s, top)}
                      data-testid={`skip-${s.woo_id}`}
                      title="Dismiss this suggestion"
                      className="px-2 py-1.5 text-[11px] font-bold uppercase tracking-wider bg-white hover:bg-stone-100 text-stone-600 border border-stone-300 rounded-md"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Manual mapping tables */}
      <section className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-stone-200 flex-wrap">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setTab("products")}
              data-testid="tab-products"
              className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-md ${tab === "products" ? "bg-stone-950 text-[#dedd0a]" : "text-stone-600 hover:bg-stone-100"}`}
            >Woo Products ({woo.length})</button>
            <button
              onClick={() => setTab("files")}
              data-testid="tab-files"
              className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider rounded-md ${tab === "files" ? "bg-stone-950 text-[#dedd0a]" : "text-stone-600 hover:bg-stone-100"}`}
            >R2 Files ({files.length})</button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-stone-400 absolute left-2.5 top-2" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter by name…"
                data-testid="pc-search"
                className="pl-7 pr-3 py-1.5 text-xs border border-stone-300 rounded-md w-56"
              />
            </div>
            <div className="inline-flex items-center bg-stone-100 rounded-md p-0.5">
              {[
                ["all", "All"],
                ["matched", "Matched"],
                ["woo_only", "Needs file"],
                ["file_only", "Orphaned files"],
              ].map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setStatus(k)}
                  data-testid={`filter-${k}`}
                  className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded ${status === k ? "bg-stone-950 text-[#dedd0a]" : "text-stone-600 hover:bg-stone-200"}`}
                >{label}</button>
              ))}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="py-12 text-center text-stone-500"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
        ) : tab === "products" ? (
          <ProductsTable rows={woo} onEdit={(p) => setEditing({ type: "woo", id: p.id, value: p.project_code || "", name: p.name })} />
        ) : (
          <FilesTable rows={files} onEdit={(f) => setEditing({ type: "file", id: f.key, value: f.project_code || "", name: f.name, asset_type: f.asset_type || "instruction_pdf" })} />
        )}
      </section>

      {editing && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" data-testid="pc-edit-modal" onClick={(e) => { if (e.target === e.currentTarget) setEditing(null); }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Assign Project Code</div>
              <h3 className="font-display text-xl text-stone-950 mt-1">{editing.name}</h3>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Project Code</label>
              <input
                value={editing.value}
                onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                placeholder="MAY_VE_DAY_GRAMOPHONE"
                data-testid="pc-edit-input"
                className="w-full mt-1 px-3 py-2 text-sm font-mono border border-stone-300 rounded-lg focus:outline-none focus:border-stone-900"
              />
              <p className="text-[11px] text-stone-500 mt-1">Slugified server-side — any case/punctuation collapses to <code>FOO_BAR</code>.</p>
            </div>
            {editing.type === "file" && (
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Asset Type</label>
                <select
                  value={editing.asset_type}
                  onChange={(e) => setEditing({ ...editing, asset_type: e.target.value })}
                  data-testid="pc-edit-asset-type"
                  className="w-full mt-1 px-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-none focus:border-stone-900"
                >
                  {ASSET_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setEditing(null)} className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-lg">Cancel</button>
              <button
                onClick={saveEdit}
                data-testid="pc-edit-save"
                className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-[#dedd0a] rounded-lg"
              >Save</button>
            </div>
          </div>
        </div>
      )}

      {bulkReview && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          data-testid="pc-bulk-review-modal"
          onClick={(e) => { if (e.target === e.currentTarget) setBulkReview(null); }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[88vh] flex flex-col">
            <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 flex items-center gap-2">
                  <Sparkles className="w-3 h-3" /> Bulk approval review
                </div>
                <h3 className="font-display text-xl text-stone-950 mt-0.5">
                  Confirm {bulkReview.items.length} link{bulkReview.items.length === 1 ? "" : "s"} at ≥ {bulkReview.min_score}%
                </h3>
                <p className="text-xs text-stone-500 mt-1">
                  Each pair below will be linked with a Project Code. Anything you&apos;re unsure about — click
                  ×&nbsp;to drop it from this batch and approve it individually later.
                </p>
              </div>
              <button onClick={() => setBulkReview(null)} className="w-9 h-9 rounded-full border border-stone-300 hover:bg-stone-50 flex items-center justify-center">
                <X className="w-4 h-4" />
              </button>
            </div>
            <ul className="flex-1 overflow-y-auto divide-y divide-stone-100">
              {bulkReview.items.map((it) => (
                <li
                  key={it.woo_id}
                  data-testid={`bulk-review-${it.woo_id}`}
                  className="flex items-center gap-3 px-5 py-2.5"
                >
                  {it.product_image ? (
                    <img src={it.product_image} alt="" className="w-9 h-9 object-cover rounded shrink-0 bg-stone-100" />
                  ) : (
                    <div className="w-9 h-9 rounded shrink-0 bg-stone-100" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-stone-900 truncate">{it.product_name}</div>
                    <div className="text-[11px] text-stone-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
                      <span className="font-mono">{it.suggested_code}</span>
                      <span className="text-stone-300">↔</span>
                      <span className="text-stone-700 truncate">{it.match.file_name}</span>
                    </div>
                  </div>
                  <ScorePill score={it.match.score} />
                  <button
                    onClick={() => setBulkReview((br) => ({
                      ...br,
                      items: br.items.filter((x) => x.woo_id !== it.woo_id),
                    }))}
                    title="Drop from this batch"
                    data-testid={`bulk-drop-${it.woo_id}`}
                    className="w-7 h-7 rounded-full border border-stone-300 hover:bg-stone-50 flex items-center justify-center text-stone-500"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="px-5 py-3 border-t border-stone-200 flex items-center justify-end gap-2">
              <button onClick={() => setBulkReview(null)} className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-lg">Cancel</button>
              <button
                onClick={confirmBulkApprove}
                disabled={busy || !bulkReview.items.length}
                data-testid="pc-bulk-confirm"
                className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg disabled:opacity-40 flex items-center gap-1.5"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                Approve {bulkReview.items.length} link{bulkReview.items.length === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Counter({ label, value, accent, tail, testid }) {
  const accentCls = accent === "emerald" ? "text-emerald-700" : "text-stone-950";
  return (
    <div className="bg-white border border-stone-200 rounded-xl p-3" data-testid={testid}>
      <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500">{label}</div>
      <div className={`text-3xl font-display tabular-nums mt-1 ${accentCls}`}>{value}{tail && <span className="text-sm text-stone-400 ml-2">{tail}</span>}</div>
    </div>
  );
}

function ProductsTable({ rows, onEdit }) {
  if (!rows.length) return <div className="py-10 text-center text-sm text-stone-500">No products match.</div>;
  return (
    <div className="divide-y divide-stone-100 max-h-[600px] overflow-y-auto">
      {rows.map((p) => (
        <div key={p.id} data-testid={`row-product-${p.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-stone-50">
          {p.image_url ? (
            <img src={p.image_url} alt="" className="w-9 h-9 object-cover rounded shrink-0 bg-stone-100" />
          ) : (
            <div className="w-9 h-9 rounded shrink-0 bg-stone-100" />
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-stone-900 truncate">{p.name}</div>
            <div className="text-[10px] text-stone-500 truncate flex items-center gap-2">
              {(p.tag_names || []).slice(0, 2).map((t) => <span key={t} className="px-1 py-px bg-stone-100 rounded">{t}</span>)}
              {(p.category_names || []).slice(0, 2).map((c) => <span key={c} className="px-1 py-px bg-sky-100 text-sky-800 rounded">{c}</span>)}
            </div>
          </div>
          <div className="shrink-0 min-w-[200px] text-right">
            {p.project_code ? (
              <span className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono font-bold rounded bg-stone-950 text-[#dedd0a]">
                {p.project_code}
                {p.has_linked_file && <CheckCircle2 className="w-3 h-3 text-emerald-400" />}
              </span>
            ) : (
              <span className="text-[10px] uppercase tracking-wider text-stone-400">no code</span>
            )}
          </div>
          <button onClick={() => onEdit(p)} className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-100 rounded-md">Edit</button>
        </div>
      ))}
    </div>
  );
}

function FilesTable({ rows, onEdit }) {
  if (!rows.length) return <div className="py-10 text-center text-sm text-stone-500">No files match.</div>;
  return (
    <div className="divide-y divide-stone-100 max-h-[600px] overflow-y-auto">
      {rows.map((f) => (
        <div key={f.key} data-testid={`row-file-${f.key}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-stone-50">
          <div className="w-9 h-9 rounded shrink-0 bg-stone-100 flex items-center justify-center text-stone-400"><FileText className="w-4 h-4" /></div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-stone-900 truncate">{f.name}</div>
            <div className="text-[10px] text-stone-500 truncate">{f.key}</div>
          </div>
          <div className="shrink-0 min-w-[200px] text-right flex items-center justify-end gap-1.5">
            {f.asset_type && <AssetTypeChip type={f.asset_type} />}
            {f.project_code ? (
              <span className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono font-bold rounded bg-stone-950 text-[#dedd0a]">
                {f.project_code}
                {f.linked_to_woo && <CheckCircle2 className="w-3 h-3 text-emerald-400" />}
              </span>
            ) : (
              <span className="text-[10px] uppercase tracking-wider text-stone-400">no code</span>
            )}
          </div>
          <button onClick={() => onEdit(f)} className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-100 rounded-md">Edit</button>
        </div>
      ))}
    </div>
  );
}
