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
import FilePreviewModal from "@/components/files/FilePreviewModal";
import {
  Loader2, Search, Link2, CheckCircle2, X, AlertCircle,
  RefreshCw, Sparkles, FileText, Box, FileImage, Film,
  Layers, Hash, Filter, Eye, ExternalLink,
} from "lucide-react";

// Woo product names sometimes arrive with raw HTML (``<br>``, ``</p>``,
// stray ``&amp;``) because the storefront editor lets HTML through.
// Render them safely as plain text by stripping tags and decoding the
// handful of entities we actually see in practice.
function stripHtml(raw) {
  if (raw == null) return "";
  const s = String(raw)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return s.replace(/\s+/g, " ").trim();
}

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

// Inline file finder used inside the Edit modal. Mirrors the Files
// page search: type a few characters, see matching files with their
// parent folder for context, click any row to preview the file
// inline (PDF/image/video via FilePreviewModal), then "Approve" to
// link the product.
function WooFilePicker({ initialQuery, busy, onApprove }) {
  const [q, setQ] = useState(initialQuery || "");
  const [results, setResults] = useState([]);
  const [previewFile, setPreviewFile] = useState(null);

  // Debounced search — same shape as the Files page so admins are
  // never wondering "is this the same search?". 250ms is brisk
  // enough that admins barely register the wait.
  useEffect(() => {
    const trimmed = q.trim();
    if (trimmed.length < 2) { setResults([]); return; }
    let cancelled = false;
    const id = setTimeout(() => {
      api.get("/files/search", { params: { q: trimmed, limit: 20 } })
        .then(({ data }) => { if (!cancelled) setResults(data?.items || []); })
        .catch(() => { if (!cancelled) setResults([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(id); };
  }, [q]);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-3" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search files by name (e.g. 'Flying Scotsman')…"
          data-testid="pc-file-picker-search"
          className="w-full pl-9 pr-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-none focus:border-stone-900"
        />
      </div>
      <div className="max-h-80 overflow-y-auto border border-stone-100 rounded-lg divide-y divide-stone-100" data-testid="pc-file-picker-results">
        {q.trim().length < 2 ? (
          <div className="py-6 text-center text-xs text-stone-400">
            Type a few words from the file name to search the vault.<br />
            Tip: shorter is better &mdash; e.g. <em>&ldquo;Flying Scotsman&rdquo;</em> not the full product title.
          </div>
        ) : !results.length ? (
          <div className="py-6 text-center text-xs text-stone-500">No files match &ldquo;{q}&rdquo;.</div>
        ) : (
          results.map((f) => (
            <div
              key={f.key}
              onClick={() => setPreviewFile(f)}
              data-testid={`pc-file-result-${f.key}`}
              title="Click to preview this file"
              className="px-3 py-2 flex items-center gap-3 hover:bg-stone-50 cursor-pointer group"
            >
              <FileText className="w-5 h-5 text-stone-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-stone-900 truncate group-hover:text-stone-950">{f.name}</div>
                <div className="text-[10px] text-stone-500 truncate">{f.parent_prefix}</div>
                {f.project_code && (
                  <div className="text-[10px] font-mono text-emerald-700 mt-0.5">↪ {f.project_code}</div>
                )}
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); setPreviewFile(f); }}
                title="Preview file"
                data-testid={`pc-file-preview-${f.key}`}
                className="w-7 h-7 rounded-md border border-stone-300 hover:bg-stone-100 flex items-center justify-center text-stone-600"
              >
                <Eye className="w-3.5 h-3.5" />
              </button>
              <a
                href={`/files?prefix=${encodeURIComponent(f.parent_prefix || "")}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title="Open the containing folder in the Files page (new tab)"
                data-testid={`pc-file-open-files-${f.key}`}
                className="w-7 h-7 rounded-md border border-stone-300 hover:bg-stone-100 flex items-center justify-center text-stone-600"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
              <button
                onClick={(e) => { e.stopPropagation(); onApprove(f); }}
                disabled={busy}
                data-testid={`pc-file-approve-${f.key}`}
                className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-emerald-600 hover:bg-emerald-700 text-white rounded-md flex items-center gap-1 disabled:opacity-40"
              >
                <CheckCircle2 className="w-3 h-3" /> Approve
              </button>
            </div>
          ))
        )}
      </div>
      {previewFile && (
        <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
      )}
    </div>
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
  const [month, setMonth] = useState("");        // "" | "1".."12" — narrows Woo to a single month
  // Asset-type chip filter — toggle on = exclude that category from
  // both the Suggested Matches list and the manual-mapping Files
  // table. Free-text custom terms supplement the chips (so admins can
  // add one-off noise patterns without committing them to the preset
  // list). Both are persisted across reloads.
  //
  // Legacy `pc_exclude_files` (a single comma-separated string) is
  // auto-migrated on first load: known chip labels move into the
  // chip set, everything else falls through to the custom field.
  const EXCLUDE_CHIP_OPTIONS = [
    "PDF", "SVG", "Stencil", "Video", "Image", "Template",
  ];
  const [excludeChips, setExcludeChips] = useState(() => {
    const raw = localStorage.getItem("pc_exclude_chips");
    if (raw !== null) { try { return new Set(JSON.parse(raw)); } catch { /* fall through */ } }
    // Migrate from the old single-string key.
    const legacy = (localStorage.getItem("pc_exclude_files") || "Stencil,Template")
      .split(",").map((t) => t.trim()).filter(Boolean);
    const chips = new Set();
    for (const t of legacy) {
      const hit = EXCLUDE_CHIP_OPTIONS.find((c) => c.toLowerCase() === t.toLowerCase());
      if (hit) chips.add(hit);
    }
    // Ensure Template is excluded by default — it's the most common
    // false-positive in the suggestion list.
    if (!localStorage.getItem("pc_exclude_chips_migrated")) {
      chips.add("Stencil");
      chips.add("Template");
    }
    return chips;
  });
  const [excludeCustom, setExcludeCustom] = useState(() => {
    if (localStorage.getItem("pc_exclude_custom") !== null) {
      return localStorage.getItem("pc_exclude_custom") || "";
    }
    // Pull non-chip leftovers from the legacy key into the custom field.
    const legacy = (localStorage.getItem("pc_exclude_files") || "")
      .split(",").map((t) => t.trim()).filter(Boolean);
    const remainder = legacy.filter(
      (t) => !EXCLUDE_CHIP_OPTIONS.some((c) => c.toLowerCase() === t.toLowerCase()),
    );
    return remainder.join(", ");
  });
  useEffect(() => {
    localStorage.setItem("pc_exclude_chips", JSON.stringify([...excludeChips]));
    localStorage.setItem("pc_exclude_chips_migrated", "1");
  }, [excludeChips]);
  useEffect(() => { localStorage.setItem("pc_exclude_custom", excludeCustom); }, [excludeCustom]);
  // Combined comma-separated string sent to the backend. Order is
  // chips first, then custom, then dedupe — keeps the API contract
  // unchanged while giving us nicer UX on top.
  const excludeFiles = (() => {
    const terms = [
      ...excludeChips,
      ...excludeCustom.split(",").map((t) => t.trim()).filter(Boolean),
    ];
    return [...new Set(terms.map((t) => t.toLowerCase()))]
      .map((lc) => terms.find((t) => t.toLowerCase() === lc))
      .join(",");
  })();
  const toggleExcludeChip = (chip) => {
    setExcludeChips((prev) => {
      const next = new Set(prev);
      if (next.has(chip)) next.delete(chip); else next.add(chip);
      return next;
    });
  };
  const [minScore, setMinScore] = useState(90);
  const [editing, setEditing] = useState(null);  // {type:'woo'|'file', id, value, asset_type}
  const [bulkReview, setBulkReview] = useState(null);  // null | { items, min_score }
  const [skipsCount, setSkipsCount] = useState(0);

  const reload = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const params = {
        q: q || undefined,
        status,
        // Convert select-string → number; "" means no month filter.
        month: month ? parseInt(month, 10) : undefined,
        exclude_files: excludeFiles || undefined,
      };
      const [main, sug, skips] = await Promise.all([
        api.get("/admin/project-codes", { params }),
        api.get("/admin/project-codes/suggestions", {
          params: { min_score: minScore, exclude_files: excludeFiles || undefined },
        }),
        api.get("/admin/project-codes/suggestions/skipped"),
      ]);
      setData(main.data);
      // If the admin has chosen a month, narrow the suggestions list
      // client-side to only that month's products. (The suggestion
      // engine itself is global so we keep its endpoint unchanged.)
      let suggestions = sug.data.items || [];
      if (month) {
        const allowedIds = new Set((main.data?.products || []).map((p) => p.id));
        suggestions = suggestions.filter((s) => allowedIds.has(s.woo_id));
      }
      setSuggestions(suggestions);
      setSkipsCount(skips.data.count || 0);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't load project codes.");
    } finally { setLoading(false); }
  }, [q, status, month, excludeFiles, minScore]);

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
      setFlash(`Linked "${stripHtml(sug.product_name)}" → ${match.file_name}`);
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
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not dismiss suggestion.");
    }
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

  // When the admin clicks the product thumbnail in the modal header
  // we open the Woo storefront image at native size — purely visual
  // confirmation that this is the right product before they Approve a
  // file. Closed by clicking the backdrop or the X.
  const [productImagePreview, setProductImagePreview] = useState(null);

  // One-click "Approve" inside the Woo edit modal: link a Woo product
  // to whichever R2 file the admin just previewed. The Project Code
  // is decided in this order so neither side ever drifts:
  //   1) the file's own project_code (if it already has one)
  //   2) the product's current project_code
  //   3) the slug derived from the product name (fallback)
  // Both records are PUT in sequence so the resulting link is
  // symmetric — refreshing the page shows them paired immediately.
  const approveFileForProduct = async (file) => {
    if (!editing || editing.type !== "woo" || !file) return;
    const productName = editing.name || "";
    const slug = (s) => (s || "")
      .toString()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const code = file.project_code || editing.value || slug(productName);
    if (!code) {
      setErr("Couldn't derive a Project Code from this product name.");
      return;
    }
    try {
      setBusy(true);
      // Update both sides so the link is symmetric. The backend
      // re-slugifies the code on each PUT, so casing/punctuation
      // drift between the two payloads is harmless.
      await Promise.all([
        api.put(`/admin/project-codes/woo/${encodeURIComponent(editing.id)}`,
          { project_code: code }),
        api.put(`/admin/project-codes/file/${encodeURIComponent(file.key)}`,
          { project_code: code }),
      ]);
      setFlash(`Linked "${productName}" → ${file.name}`);
      setEditing(null);
      await reload();
    } catch (e) {
      setErr(e?.response?.data?.detail || "Approve failed.");
    } finally {
      setBusy(false);
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
        {/* Asset-type chip filter — chips highlighted = excluded.
            Adding terms to the custom field appends one-off
            substring matchers (case-insensitive). Both are persisted
            in localStorage and shared between the suggestion engine
            and the manual mapping Files list. */}
        <div className="flex items-center gap-2 flex-wrap mb-3 pb-3 border-b border-stone-100" data-testid="pc-exclude-chip-row">
          <span className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mr-1">Hide</span>
          {EXCLUDE_CHIP_OPTIONS.map((chip) => {
            const on = excludeChips.has(chip);
            return (
              <button
                key={chip}
                onClick={() => toggleExcludeChip(chip)}
                data-testid={`pc-chip-${chip.toLowerCase()}`}
                title={on ? `Stop hiding "${chip}" files` : `Hide files whose name contains "${chip}"`}
                className={`px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider rounded-full border transition ${on
                  ? "bg-stone-950 text-[#dedd0a] border-stone-950"
                  : "bg-white text-stone-600 border-stone-300 hover:border-stone-500"}`}
              >
                {chip}
              </button>
            );
          })}
          <input
            value={excludeCustom}
            onChange={(e) => setExcludeCustom(e.target.value)}
            placeholder="Custom (comma-separated)…"
            data-testid="pc-exclude-custom"
            title="Files whose name contains any of these substrings are also hidden. Case-insensitive."
            className="ml-1 px-2.5 py-1 text-[11px] border border-stone-300 rounded-full w-56 focus:outline-none focus:border-stone-500"
          />
          {(excludeChips.size > 0 || excludeCustom.trim()) && (
            <button
              onClick={() => { setExcludeChips(new Set()); setExcludeCustom(""); }}
              data-testid="pc-chip-clear"
              className="text-[10px] uppercase tracking-wider font-bold text-stone-500 hover:text-stone-800 ml-1"
            >Clear</button>
          )}
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
                    <div className="text-sm font-bold text-stone-950 truncate">{stripHtml(s.product_name)}</div>
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
                placeholder="Search by name (Woo or file)…"
                data-testid="pc-search"
                className="pl-7 pr-3 py-1.5 text-xs border border-stone-300 rounded-md w-64"
              />
            </div>
            <select
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              data-testid="pc-month-filter"
              title="Filter Woo products by category month"
              className="px-2 py-1.5 text-xs border border-stone-300 rounded-md bg-white"
            >
              <option value="">All months</option>
              {[
                ["1", "January"], ["2", "February"], ["3", "March"],
                ["4", "April"], ["5", "May"], ["6", "June"],
                ["7", "July"], ["8", "August"], ["9", "September"],
                ["10", "October"], ["11", "November"], ["12", "December"],
              ].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <div className="relative" title="Use the chip filter above the Suggested Matches panel to exclude noisy file types.">
              <X className="w-3.5 h-3.5 text-stone-400 absolute left-2.5 top-2" />
              <input
                value={excludeFiles}
                readOnly
                placeholder="Exclude filter active (see chips above)"
                data-testid="pc-exclude-files"
                className="pl-7 pr-3 py-1.5 text-xs border border-stone-200 bg-stone-50 text-stone-500 rounded-md w-56 cursor-not-allowed"
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
          <ProductsTable rows={woo} onEdit={(p) => setEditing({ type: "woo", id: p.id, value: p.project_code || "", name: stripHtml(p.name), image: p.image_url || p.image || null })} />
        ) : (
          <FilesTable rows={files} onEdit={(f) => setEditing({ type: "file", id: f.key, value: f.project_code || "", name: f.name, asset_type: f.asset_type || "instruction_pdf" })} />
        )}
      </section>

      {editing && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" data-testid="pc-edit-modal" onClick={(e) => { if (e.target === e.currentTarget) setEditing(null); }}>
          <div className={`bg-white rounded-2xl shadow-2xl w-full ${editing.type === "woo" ? "max-w-2xl" : "max-w-md"} p-6 space-y-4`}>
            <div className="flex items-start gap-3">
              {editing.image && (
                <button
                  type="button"
                  onClick={() => setProductImagePreview(editing.image)}
                  title="Click to view the storefront image at full size"
                  data-testid="pc-product-thumb"
                  className="shrink-0 rounded-lg overflow-hidden ring-1 ring-stone-200 hover:ring-stone-900 transition focus:outline-none"
                >
                  <img src={editing.image} alt="" className="w-14 h-14 object-cover bg-stone-100" />
                </button>
              )}
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">
                  {editing.type === "woo" ? "Link product to a file" : "Assign Project Code"}
                </div>
                <h3 className="font-display text-xl text-stone-950 mt-1 truncate">{editing.name}</h3>
                {editing.type === "woo" && editing.value && (
                  <div className="text-[11px] text-stone-500 mt-1 flex items-center gap-1.5">
                    <Link2 className="w-3 h-3" /> Currently linked: <span className="font-mono text-stone-800">{editing.value}</span>
                  </div>
                )}
              </div>
            </div>

            {editing.type === "woo" && (
              <div className="border-t border-stone-200 pt-4 space-y-2">
                <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">
                  Step 1 — Find &amp; preview the file
                </div>
                <WooFilePicker
                  initialQuery={(() => {
                    // Seed with the first ~3 meaningful words of the
                    // product name. Long full-titles like "12 Days of
                    // Christmas Advent Colouring In A3 Booklet" yield
                    // zero matches; the file is usually called e.g.
                    // "12 Days of Christmas.pdf". 3 words is the
                    // sweet spot — admin can refine immediately.
                    const clean = stripHtml(editing.name || "")
                      .replace(/\b(Project Kit|Project|Kit|Standard|Boxed|Set|Cards?|Booklet|A3|A4)\b/gi, " ")
                      .replace(/\s+/g, " ")
                      .trim();
                    return clean.split(" ").slice(0, 3).join(" ");
                  })()}
                  busy={busy}
                  onApprove={approveFileForProduct}
                />
              </div>
            )}

            <div className={editing.type === "woo" ? "border-t border-stone-200 pt-4" : ""}>
              {editing.type === "woo" && (
                <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-2">
                  Or — set the Project Code manually
                </div>
              )}
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

      {productImagePreview && (
        <div
          onClick={() => setProductImagePreview(null)}
          className="fixed inset-0 z-[70] bg-stone-950/85 backdrop-blur-sm flex items-center justify-center p-4 sm:p-8"
          data-testid="pc-product-image-lightbox"
        >
          <button
            onClick={() => setProductImagePreview(null)}
            aria-label="Close storefront image"
            data-testid="pc-product-image-close"
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
          >
            <X className="w-5 h-5" />
          </button>
          <img
            src={productImagePreview}
            alt="Product storefront image"
            onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-full object-contain rounded-xl shadow-2xl"
          />
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
                    <div className="text-sm font-semibold text-stone-900 truncate">{stripHtml(it.product_name)}</div>
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
            <div className="text-sm font-semibold text-stone-900 truncate">{stripHtml(p.name)}</div>
            <div className="text-[10px] text-stone-500 truncate flex items-center gap-2">
              {(p.tag_names || []).slice(0, 2).map((t) => <span key={t} className="px-1 py-px bg-stone-100 rounded">{stripHtml(t)}</span>)}
              {(p.category_names || []).slice(0, 2).map((c) => <span key={c} className="px-1 py-px bg-sky-100 text-sky-800 rounded">{stripHtml(c)}</span>)}
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
