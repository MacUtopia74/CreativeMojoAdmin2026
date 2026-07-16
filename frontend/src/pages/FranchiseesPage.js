import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import { Search, AlertCircle, RefreshCw, CreditCard, CheckCircle2, X, ChevronDown, LayoutGrid, List as ListIcon, Mail, Phone, ArrowRight, Columns3, GripVertical, ExternalLink, FileText, Facebook as FacebookIcon, RotateCcw, Upload, FileCode } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDate } from "@/lib/date";

// Live GoCardless mandate pill — mirrors the one on FranchiseeDetailPage so the
// list and detail views stay visually in sync.
const MANDATE_STYLE = {
  active: "bg-emerald-100 text-emerald-800 border-emerald-300",
  pending_submission: "bg-blue-100 text-blue-800 border-blue-300",
  submitted: "bg-blue-100 text-blue-800 border-blue-300",
  pending_customer_approval: "bg-amber-100 text-amber-800 border-amber-300",
  cancelled: "bg-red-100 text-red-800 border-red-300",
  failed: "bg-red-100 text-red-800 border-red-300",
  expired: "bg-stone-200 text-stone-700 border-stone-300",
  consumed: "bg-stone-200 text-stone-700 border-stone-300",
};
const MANDATE_LABEL = {
  active: "Active",
  pending_submission: "Pending",
  submitted: "Submitted",
  pending_customer_approval: "Awaiting",
  cancelled: "Cancelled",
  failed: "Failed",
  expired: "Expired",
  consumed: "Consumed",
};
function MandateCell({ franchisee }) {
  const s = franchisee.gocardless_mandate_status;
  if (!s) {
    if (franchisee.gocardless_customer_id) {
      return <span className="text-stone-400 text-[10px] uppercase tracking-wider">No mandate</span>;
    }
    return <span className="text-stone-300 text-xs">—</span>;
  }
  const href = franchisee.gocardless_mandate_id
    ? `https://manage.gocardless.com/mandates/${franchisee.gocardless_mandate_id}`
    : "https://manage.gocardless.com/sign-in";
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      data-testid={`mandate-${franchisee.id}`}
      title={franchisee.gocardless_mandate_id ? `Open ${franchisee.gocardless_mandate_id} on GoCardless` : "Open GoCardless"}
      className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border rounded-md hover:opacity-80 transition-opacity ${MANDATE_STYLE[s] || "bg-stone-100 text-stone-600 border-stone-200"}`}>
      {MANDATE_LABEL[s] || s} ↗
    </a>
  );
}

const SEGMENTS = [
  { key: "active", label: "Active", tag: "Franchisee" },
  { key: "ex", label: "Ex-Franchises/Licences", tag: "EX-Franchisee" },
  { key: "licencee", label: "Worldwide Licencees", tag: "Worldwide Licencee" },
  { key: "other", label: "Other", tag: null },   // Demo / HQ — see isOther()
  { key: "all", label: "All", tag: null },
];

function hasTag(franchisee, tag) {
  const tags = franchisee.tags || [];
  return Array.isArray(tags) ? tags.includes(tag) : tags === tag;
}

// "Other" = internal/training/sandbox accounts that shouldn't be counted
// against real franchise totals on the Active/Ex/Licencee tabs. Today
// that's the Demo seat and Sandra's own HQ account. Use a tag-based
// filter so the admin can tag any future account "Demo" or "HQ" to
// move it here without a code change.
function isOther(franchisee) {
  return hasTag(franchisee, "Demo") || hasTag(franchisee, "HQ");
}

// Phase 1.5 — GoCardless sync modal. Defaults to DRY-RUN until the operator
// explicitly hits "Commit to database".
function GoCardlessSyncModal({ open, onClose, onCommitted }) {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);
  const [err, setErr] = useState("");

  const run = async (dryRun) => {
    setBusy(true); setErr("");
    try {
      const { data } = await api.post(`/gocardless/mandates/sync?dry_run=${dryRun ? "true" : "false"}`);
      setReport(data);
      if (!dryRun) onCommitted?.();
    } catch (e) {
      setErr(e?.response?.data?.detail || "Sync failed.");
    } finally { setBusy(false); }
  };

  if (!open) return null;
  const committed = report && report.dry_run === false;

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 bg-stone-950/40 backdrop-blur-sm flex items-start justify-center p-6 overflow-y-auto" data-testid="gc-sync-modal">
      <div onClick={(e) => e.stopPropagation()} className="bg-white border border-stone-200 max-w-2xl w-full rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200">
          <div className="flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-stone-700" />
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">GoCardless Sync</div>
          </div>
          <button onClick={onClose} data-testid="gc-sync-close" className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {!report && !err && !busy && (
            <>
              <p className="text-sm text-stone-700">
                Read every active GoCardless customer and link them to franchisees by email
                (<code className="text-xs bg-stone-100 px-1 rounded">email</code>,
                <code className="text-xs bg-stone-100 px-1 rounded ml-1">mojo_email</code>,
                <code className="text-xs bg-stone-100 px-1 rounded ml-1">secondary_email</code>).
              </p>
              <p className="text-xs text-stone-500">A dry-run scans everything but writes nothing to the database — review the matches first, then commit.</p>
              <div className="flex items-center gap-2 pt-2">
                <button onClick={() => run(true)} data-testid="gc-sync-dryrun"
                  className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg flex items-center gap-1.5">
                  <RefreshCw className="w-3.5 h-3.5" /> Run Dry-Run
                </button>
              </div>
            </>
          )}
          {busy && (
            <div className="text-sm text-stone-600 flex items-center gap-2 py-6">
              <RefreshCw className="w-4 h-4 animate-spin" /> Talking to GoCardless…
            </div>
          )}
          {err && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg" data-testid="gc-sync-error">
              <AlertCircle className="w-4 h-4 inline mr-1" /> {err}
            </div>
          )}
          {report && (
            <div className="space-y-3" data-testid="gc-sync-report">
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-stone-50 border border-stone-200 rounded-lg p-3">
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">GC Customers</div>
                  <div className="font-display text-2xl text-stone-950 mt-1 tabular-nums">{report.customers_scanned}</div>
                </div>
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-emerald-700">Matched</div>
                  <div className="font-display text-2xl text-emerald-900 mt-1 tabular-nums" data-testid="gc-matched-count">{report.matched_count}</div>
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-amber-700">Unmatched</div>
                  <div className="font-display text-2xl text-amber-900 mt-1 tabular-nums">{report.unmatched_count}</div>
                </div>
              </div>
              {report.matched_preview?.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">Sample Matches</div>
                  <div className="border border-stone-200 rounded-lg divide-y divide-stone-100 max-h-56 overflow-y-auto text-xs">
                    {report.matched_preview.map((m) => (
                      <div key={m.franchisee_id + (m.mandate?.mandate_id || "")} className="px-3 py-2 flex items-center justify-between">
                        <span className="text-stone-700">{m.franchisee_email}</span>
                        <span className="text-stone-500 tabular-nums">{m.mandate?.mandate_id || "no mandate"} · {m.mandate?.status || "—"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {committed ? (
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 flex items-center gap-2 text-sm text-emerald-800" data-testid="gc-sync-committed">
                  <CheckCircle2 className="w-4 h-4" /> Committed {report.committed_count} franchisee link(s) to the database.
                </div>
              ) : (
                <div className="flex items-center justify-between pt-2 border-t border-stone-200">
                  <button onClick={() => { setReport(null); setErr(""); }} className="text-xs text-stone-500 hover:text-stone-900">Reset</button>
                  <button onClick={() => run(false)} disabled={busy} data-testid="gc-sync-commit"
                    className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] text-stone-950 hover:bg-[#aaaa11] rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Commit to database
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// One-off migration modal — accepts the WordPress WXR (XML) export
// Sandra downloads from WP admin → Tools → Export, previews match
// counts in dry-run, then commits (which stamps ``website_bio`` and
// flips ``show_website_bio=true`` on every matched franchisee so the
// bio appears on the public creativemojo.co.uk map popup immediately).
function WPBioImportModal({ open, onClose, onCommitted, allFranchisees = [] }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);
  const [err, setErr] = useState("");
  const [committed, setCommitted] = useState(false);
  // Per-row picker/assignment state for the "Couldn't auto-match"
  // section. Keyed by the post's slug (fallback: title). Value shape:
  // { fid: string, publishing: boolean, done: boolean, error?: string, activate?: bool }
  const [manual, setManual] = useState({});
  // Set of matched franchisee IDs Paul has UNticked "Publish live" for
  // — values still import, but the show_* toggles stay off (used for
  // franchisees like Samantha Whiteman who want to log in and activate
  // fields themselves).
  const [heldMatchedIds, setHeldMatchedIds] = useState(() => new Set());

  // Fresh state whenever the modal is (re-)opened so users don't see
  // a stale report from a previous session.
  useEffect(() => {
    if (open) {
      setFile(null); setBusy(false); setReport(null); setErr(""); setCommitted(false);
      setManual({}); setHeldMatchedIds(new Set());
    }
  }, [open]);

  // Alphabetical franchisee options for the manual-match dropdown.
  // Only live franchisees (parent already filters ex-franchisees out
  // of `all` by default). Cached across renders for perf on 100+ rows.
  const franchiseeOptions = useMemo(() => {
    const opts = (allFranchisees || [])
      .filter((f) => (f.lifecycle_status || "").toLowerCase() !== "ex")
      .map((f) => ({
        id: f.id,
        label: [
          [f.first_name, f.last_name].filter(Boolean).join(" "),
          f.organisation ? `(${f.organisation})` : "",
        ].filter(Boolean).join(" ").trim(),
      }))
      .filter((o) => o.label);
    opts.sort((a, b) => a.label.localeCompare(b.label));
    return opts;
  }, [allFranchisees]);

  const assignManual = async (postKey, post) => {
    const chosenId = manual[postKey]?.fid;
    if (!chosenId) return;
    setManual((m) => ({ ...m, [postKey]: { ...m[postKey], publishing: true, error: undefined } }));
    try {
      await api.post(`/admin/franchisees/${chosenId}/set-website-bio`, {
        bio: post.bio,
        email: post.email || undefined,
        phone: post.phone || undefined,
        activate: manual[postKey]?.activate !== false,
      });
      setManual((m) => ({ ...m, [postKey]: { ...m[postKey], publishing: false, done: true } }));
      onCommitted?.();
    } catch (e) {
      setManual((m) => ({ ...m, [postKey]: {
        ...m[postKey], publishing: false,
        error: e?.response?.data?.detail || "Couldn't publish. Try again.",
      } }));
    }
  };

  const run = async (dryRun) => {
    if (!file) { setErr("Choose the WordPress XML export file first."); return; }
    setBusy(true); setErr("");
    try {
      const form = new FormData();
      form.append("file", file);
      const holdParam = Array.from(heldMatchedIds).join(",");
      const url = `/admin/franchisees/import-website-bios?dry_run=${dryRun ? "true" : "false"}${holdParam ? `&hold_ids=${encodeURIComponent(holdParam)}` : ""}`;
      const { data } = await api.post(url, form, { headers: { "Content-Type": "multipart/form-data" } });
      setReport(data);
      if (!dryRun) { setCommitted(true); onCommitted?.(); }
    } catch (e) {
      setErr(e?.response?.data?.detail || "Import failed. Check the file is a valid WordPress XML export.");
    } finally { setBusy(false); }
  };

  if (!open) return null;

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 bg-stone-950/40 backdrop-blur-sm flex items-start justify-center p-6 overflow-y-auto" data-testid="wp-bio-modal">
      <div onClick={(e) => e.stopPropagation()} className="bg-white border border-stone-200 max-w-3xl w-full rounded-2xl shadow-2xl my-4">
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200">
          <div className="flex items-center gap-2">
            <FileCode className="w-4 h-4 text-stone-700" />
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">Import Biographies from WordPress</div>
          </div>
          <button onClick={onClose} data-testid="wp-bio-close" className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* Step-by-step help — kept on-screen the whole time so
              it's clear what dry-run vs commit means. */}
          {!committed && (
            <div className="bg-stone-50 border border-stone-200 rounded-lg p-4 text-sm text-stone-700 space-y-2">
              <div className="font-bold text-stone-950">How this works</div>
              <ol className="list-decimal list-inside space-y-1 leading-relaxed">
                <li>
                  In WordPress admin, go to{" "}
                  <span className="font-mono text-xs bg-white px-1 rounded border border-stone-200">Tools → Export</span>{" "}
                  and choose <strong>Franchise</strong> (or All content), then click <strong>Download Export File</strong>.
                </li>
                <li>Pick the downloaded <code className="text-xs bg-white px-1 rounded border border-stone-200">.xml</code> file below.</li>
                <li>Click <strong>Preview matches</strong> — nothing is saved yet. Eyeball the match list.</li>
                <li>If the preview looks right, click <strong>Import and publish live</strong>. Each matched franchisee&apos;s biography goes live on the map popup.</li>
              </ol>
            </div>
          )}

          {/* File picker */}
          {!committed && (
            <label className="block cursor-pointer border-2 border-dashed border-stone-300 hover:border-stone-500 rounded-xl px-4 py-6 text-center transition-colors" data-testid="wp-bio-file-drop">
              <input
                type="file"
                accept=".xml,application/xml,text/xml"
                onChange={(e) => { setFile(e.target.files?.[0] || null); setReport(null); setErr(""); }}
                className="hidden"
                data-testid="wp-bio-file-input"
              />
              <Upload className="w-6 h-6 mx-auto text-stone-500" />
              <div className="mt-2 text-sm font-bold text-stone-950">
                {file ? file.name : "Choose your WordPress XML export"}
              </div>
              <div className="text-xs text-stone-500 mt-1">
                {file ? `${(file.size / 1024).toFixed(1)} KB · click to swap` : ".xml file from WP admin → Tools → Export"}
              </div>
            </label>
          )}

          {busy && (
            <div className="text-sm text-stone-600 flex items-center gap-2 py-4">
              <RefreshCw className="w-4 h-4 animate-spin" /> {report ? "Publishing to franchisees…" : "Parsing WordPress export…"}
            </div>
          )}

          {err && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg" data-testid="wp-bio-error">
              <AlertCircle className="w-4 h-4 inline mr-1" /> {err}
            </div>
          )}

          {/* Preview / result */}
          {report && (
            <div className="space-y-4" data-testid="wp-bio-report">
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-stone-50 border border-stone-200 rounded-lg p-3">
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">WP Posts</div>
                  <div className="font-display text-2xl text-stone-950 mt-1 tabular-nums">{report.posts_in_export}</div>
                </div>
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-emerald-700">Matched</div>
                  <div className="font-display text-2xl text-emerald-900 mt-1 tabular-nums" data-testid="wp-bio-matched-count">{report.matched_count}</div>
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-amber-700">Unmatched Posts</div>
                  <div className="font-display text-2xl text-amber-900 mt-1 tabular-nums">{report.unmatched_post_count}</div>
                </div>
              </div>

              {report.matched?.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">
                    Matches ({report.matched.length})
                  </div>
                  <div className="border border-stone-200 rounded-lg divide-y divide-stone-100 max-h-64 overflow-y-auto text-xs">
                    {report.matched.map((m) => {
                      const held = heldMatchedIds.has(m.franchisee_id);
                      return (
                      <div key={m.franchisee_id} className={`px-3 py-2 ${held ? "bg-amber-50/40" : ""}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold text-stone-900 truncate">
                            {m.franchisee_name} <span className="text-stone-400">·</span> <span className="text-stone-600 font-normal">{m.organisation}</span>
                          </span>
                          <span className="text-stone-400 tabular-nums shrink-0">{m.bio_length} chars{m.already_had_bio ? " · overwrites" : ""}</span>
                        </div>
                        <div className="text-stone-500 mt-0.5 line-clamp-2">← “{m.post_title}”</div>
                        {(m.email || m.phone) && (
                          <div className="mt-1 flex gap-3 text-[10px] text-stone-600">
                            {m.email && <span data-testid={`wp-bio-match-email-${m.franchisee_id}`}>✉ {m.email}</span>}
                            {m.phone && <span data-testid={`wp-bio-match-phone-${m.franchisee_id}`}>✆ {m.phone}</span>}
                          </div>
                        )}
                        {/* Publish-live checkbox — untick to import
                            values but keep them OFF the map until the
                            franchisee opts in themselves. */}
                        <label className="mt-1.5 flex items-center gap-2 text-[10px] text-stone-700 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            data-testid={`wp-bio-publish-live-${m.franchisee_id}`}
                            checked={!held}
                            onChange={(e) => setHeldMatchedIds((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.delete(m.franchisee_id);
                              else next.add(m.franchisee_id);
                              return next;
                            })}
                            className="w-3 h-3 accent-emerald-600"
                          />
                          <span className={held ? "text-amber-700 font-bold" : ""}>
                            {held ? "Held — values imported but hidden on map" : "Publish live on the Mojo map"}
                          </span>
                        </label>
                      </div>
                    );})}
                  </div>
                </div>
              )}

              {report.unmatched_posts?.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-amber-700 mb-2">
                    Couldn&apos;t auto-match ({report.unmatched_posts.filter((u) => !manual[u.slug || u.title]?.done).length})
                  </div>
                  <div className="border border-amber-200 bg-amber-50/40 rounded-lg divide-y divide-amber-100 max-h-[420px] overflow-y-auto text-xs">
                    {report.unmatched_posts.map((u) => {
                      const key = u.slug || u.title;
                      const state = manual[key] || {};
                      return (
                        <div key={key} className={`px-3 py-2.5 ${state.done ? "opacity-60" : ""}`} data-testid={`wp-bio-unmatched-${key}`}>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="font-bold text-stone-900">{u.title || u.slug}</div>
                              <div className="text-stone-600 mt-0.5 leading-relaxed line-clamp-3">{u.bio_preview}…</div>
                              {(u.email || u.phone) && (
                                <div className="mt-1 flex gap-3 text-[10px] text-stone-600">
                                  {u.email && <span>✉ {u.email}</span>}
                                  {u.phone && <span>✆ {u.phone}</span>}
                                </div>
                              )}
                            </div>
                          </div>
                          {state.done ? (
                            <div className="mt-2 text-emerald-700 flex items-center gap-1.5 font-bold" data-testid={`wp-bio-manual-done-${key}`}>
                              <CheckCircle2 className="w-3.5 h-3.5" /> Published live
                            </div>
                          ) : (
                            <>
                              <div className="mt-2 flex items-center gap-2 flex-wrap">
                                <span className="text-[10px] uppercase tracking-[0.15em] font-bold text-stone-500 shrink-0">Assign to</span>
                                <select
                                  value={state.fid || ""}
                                  onChange={(e) => setManual((m) => ({ ...m, [key]: { ...m[key], fid: e.target.value, error: undefined } }))}
                                  data-testid={`wp-bio-picker-${key}`}
                                  className="flex-1 min-w-[220px] max-w-full px-2 py-1.5 text-xs border border-stone-300 rounded-md bg-white focus:outline-none focus:border-stone-900"
                                >
                                  <option value="">— pick a franchisee —</option>
                                  {franchiseeOptions.map((o) => (
                                    <option key={o.id} value={o.id}>{o.label}</option>
                                  ))}
                                </select>
                                <button
                                  onClick={() => assignManual(key, u)}
                                  disabled={!state.fid || state.publishing}
                                  data-testid={`wp-bio-publish-${key}`}
                                  className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-[#dddd16] text-stone-950 hover:bg-[#aaaa11] rounded-md flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                                >
                                  {state.publishing ? <RefreshCw className="w-3 h-3 animate-spin" /> : <ArrowRight className="w-3 h-3" />}
                                  Publish
                                </button>
                              </div>
                              <label className="mt-1.5 flex items-center gap-2 text-[10px] text-stone-700 cursor-pointer select-none">
                                <input
                                  type="checkbox"
                                  data-testid={`wp-bio-manual-live-${key}`}
                                  checked={state.activate !== false}
                                  onChange={(e) => setManual((m) => ({ ...m, [key]: { ...m[key], activate: e.target.checked } }))}
                                  className="w-3 h-3 accent-emerald-600"
                                />
                                <span className={state.activate === false ? "text-amber-700 font-bold" : ""}>
                                  {state.activate === false ? "Held — values assigned but hidden on map" : "Publish live on the Mojo map"}
                                </span>
                              </label>
                            </>
                          )}
                          {state.error && (
                            <div className="mt-1.5 text-red-700 text-[11px]">{state.error}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="text-[11px] text-stone-500 mt-1.5 leading-relaxed">
                    Pick the correct franchisee for each unmatched post and click <strong>Publish</strong>. The biography goes live on the map popup instantly.
                  </div>
                </div>
              )}

              {report.franchisees_still_missing_bio?.length > 0 && !committed && (
                <div className="text-[11px] text-stone-500 leading-relaxed">
                  {report.franchisees_still_missing_bio.length} live franchisee(s) still won&apos;t have a biography after this import — they can add one themselves via their portal &quot;My Franchise&quot; page.
                </div>
              )}

              {committed ? (
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 flex items-center gap-2 text-sm text-emerald-800" data-testid="wp-bio-committed">
                  <CheckCircle2 className="w-4 h-4" /> Published {report.matched_count} biograph{report.matched_count === 1 ? "y" : "ies"} live to the Mojo map popup.
                </div>
              ) : (
                <div className="flex items-center justify-between pt-2 border-t border-stone-200">
                  <button onClick={() => { setReport(null); setErr(""); }} className="text-xs text-stone-500 hover:text-stone-900">Reset</button>
                  <button onClick={() => run(false)} disabled={busy || report.matched_count === 0} data-testid="wp-bio-commit"
                    className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] text-stone-950 hover:bg-[#aaaa11] rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Import and publish live ({report.matched_count})
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Preview button — only when we have a file and no report yet */}
          {!report && !busy && (
            <div className="flex items-center justify-end pt-2">
              <button onClick={() => run(true)} disabled={!file || busy} data-testid="wp-bio-dryrun"
                className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed">
                <RefreshCw className="w-3.5 h-3.5" /> Preview matches
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}



function MissingMandateRow({ item, onResolved }) {
  const [showLink, setShowLink] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    const e = (email || "").trim().toLowerCase();
    if (!e || !e.includes("@")) {
      setErr("Enter a valid email.");
      return;
    }
    setBusy(true); setErr("");
    try {
      const { data } = await api.post(`/franchisees/${item.id}/link-gocardless-by-email`, { email: e });
      if (data?.linked) {
        onResolved && onResolved(item.id);
      } else {
        setErr(data?.refresh?.reason || "No matching GoCardless customer for that email.");
      }
    } catch (ex) {
      setErr(ex?.response?.data?.detail || "Could not link.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-5 py-2.5 hover:bg-red-100/40" data-testid={`missing-mandate-row-${item.id}`}>
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <Link
            to={`/franchisees/${item.id}`}
            className="font-semibold text-stone-950 hover:underline text-sm truncate">
            {item.name}{item.franchise_number ? ` · #${item.franchise_number}` : ""}
          </Link>
          <div className="text-xs text-stone-600 truncate">
            {[item.organisation, item.email, item.postcode].filter(Boolean).join(" · ")}
          </div>
        </div>
        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-red-700 bg-red-100 border border-red-200 px-2 py-0.5 rounded-md tabular-nums">
          Live {item.days_live}d · No mandate
        </span>
        <button
          type="button"
          onClick={() => setShowLink((v) => !v)}
          data-testid={`missing-mandate-link-toggle-${item.id}`}
          className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-stone-900 bg-white border border-stone-300 hover:bg-stone-50 px-2 py-1 rounded-md">
          Link by email
        </button>
        <a
          href="https://manage.gocardless.com/sign-in"
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`missing-mandate-gc-${item.id}`}
          className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-stone-900 bg-white border border-stone-300 hover:bg-stone-50 px-2 py-1 rounded-md">
          Open GoCardless ↗
        </a>
      </div>
      {showLink && (
        <div className="mt-2 flex items-center gap-2" data-testid={`missing-mandate-link-form-${item.id}`}>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="GoCardless customer email (e.g. lucy91@gmail.com)"
            data-testid={`missing-mandate-email-${item.id}`}
            className="flex-1 px-3 py-1.5 text-xs bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-stone-900"
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            data-testid={`missing-mandate-link-submit-${item.id}`}
            className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 disabled:opacity-40 rounded-lg">
            {busy ? "Linking…" : "Add + Re-sync"}
          </button>
          {err && (
            <span className="text-[11px] text-red-700">{err}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Current Contract pill — green if >60d remaining, amber when due soon
// (0–60d), red when overdue/expired, stone "No contract on file" when no
// active contract has been linked. Tooltip surfaces the exact day count.
// ---------------------------------------------------------------------------
function ContractPill({ franchisee }) {
  const cc = franchisee.current_contract || { status: "none" };
  if (cc.status === "none" || !cc.renewal_date) {
    return (
      <span
        data-testid={`contract-pill-${franchisee.id}`}
        className="inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-amber-50 text-amber-800 border border-amber-200 rounded-md whitespace-nowrap"
        title="No active contract is linked to this franchisee.">
        No contract
      </span>
    );
  }
  const days = cc.days_remaining;
  let cls = "bg-emerald-100 text-emerald-800 border-emerald-300";
  let label = `${days}d left`;
  if (cc.status === "expired") {
    cls = "bg-red-100 text-red-800 border-red-300";
    label = `Expired ${Math.abs(days)}d ago`;
  } else if (cc.status === "due_soon") {
    cls = "bg-amber-100 text-amber-800 border-amber-300";
    label = `${days}d left`;
  }
  return (
    <span
      data-testid={`contract-pill-${franchisee.id}`}
      className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border rounded-md whitespace-nowrap ${cls}`}
      title={`Renews ${cc.renewal_date}`}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Column registry — every column the admin can choose from for the
// Franchises / Licences table. Each entry is { label, w (tailwind width),
// sortKey (optional — enables click-to-sort on the header), render(f) }.
// New columns can be appended without touching the picker UI.
// ---------------------------------------------------------------------------
function tenureLabel(startIso) {
  if (!startIso) return "—";
  try {
    const start = new Date(startIso);
    const now = new Date();
    const months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
    if (months < 0) return "—";
    const years = Math.floor(months / 12);
    const rem = months % 12;
    if (years === 0) return `${months} mo`;
    if (rem === 0) return `${years} yr${years > 1 ? "s" : ""}`;
    return `${years}y ${rem}m`;
  } catch { return "—"; }
}

function ExternalLinkChip({ href, label, testid }) {
  if (!href) return <span className="text-stone-300 text-xs">—</span>;
  let url = href;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      data-testid={testid}
      className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-white text-stone-700 border border-stone-300 rounded-md hover:bg-stone-50">
      {label} <ExternalLink className="w-2.5 h-2.5" />
    </a>
  );
}

const COLUMN_DEFS = {
  photo: {
    label: "Photo", w: "w-36",
    render: (f) => {
      const photo = f.photos?.[0]?.url;
      return photo ? (
        <img src={photo} alt="" className="w-32 h-32 object-cover rounded-2xl" />
      ) : (
        <div className="w-32 h-32 bg-stone-100 rounded-2xl flex items-center justify-center text-3xl font-bold text-stone-400">
          {(f.first_name?.[0] || "?") + (f.last_name?.[0] || "")}
        </div>
      );
    },
  },
  number: {
    label: "No.", w: "w-16", sortKey: "franchise_number",
    render: (f) => <span className="text-xs text-stone-500 tabular-nums">{f.franchise_number || "—"}</span>,
  },
  organisation: {
    label: "Organisation", w: "w-64", sortKey: "organisation",
    render: (f) => (
      <Link to={`/franchisees/${f.id}`} className="text-sm font-semibold text-stone-950 hover:text-stone-700 leading-snug line-clamp-2" data-testid={`franchisee-link-${f.id}`}>
        {f.organisation || "(no organisation)"}
      </Link>
    ),
  },
  name: {
    label: "Name", w: "w-40", sortKey: "last_name",
    render: (f) => <span className="text-sm text-stone-700">{[f.first_name, f.last_name].filter(Boolean).join(" ") || "—"}</span>,
  },
  mojo_email: {
    label: "Mojo Email", w: "w-64",
    render: (f) => f.mojo_email ? (
      <a href={`mailto:${f.mojo_email}`} className="text-xs text-stone-700 hover:text-stone-950 hover:underline underline-offset-2 break-all" data-testid={`mailto-${f.id}`}>
        {f.mojo_email}
      </a>
    ) : <span className="text-stone-300 text-xs">—</span>,
  },
  mobile: {
    label: "Mobile", w: "w-36",
    render: (f) => f.mobile_phone ? (
      <a href={`tel:${(f.mobile_phone || "").replace(/\s+/g, "")}`} className="text-xs text-stone-700 hover:text-stone-950 hover:underline underline-offset-2 tabular-nums whitespace-nowrap" data-testid={`tel-${f.id}`}>
        {f.mobile_phone}
      </a>
    ) : <span className="text-stone-300 text-xs">—</span>,
  },
  postcode: {
    label: "Postcode", w: "w-24",
    render: (f) => <span className="text-xs text-stone-700 tabular-nums">{f.postcode || "—"}</span>,
  },
  date_added: {
    label: "Added", w: "w-28", sortKey: "date_added",
    render: (f) => <span className="text-xs text-stone-500 tabular-nums">{formatDate(f.date_added)}</span>,
  },
  mandate: {
    label: "Mandate", w: "w-28",
    render: (f) => <MandateCell franchisee={f} />,
  },
  // ----- Additional optional columns (hidden by default) ----------------
  secondary_email: {
    label: "Secondary Email", w: "w-64", defaultHidden: true,
    render: (f) => f.secondary_email ? (
      <a href={`mailto:${f.secondary_email}`} className="text-xs text-stone-700 hover:text-stone-950 hover:underline underline-offset-2 break-all" data-testid={`mailto2-${f.id}`}>
        {f.secondary_email}
      </a>
    ) : <span className="text-stone-300 text-xs">—</span>,
  },
  street: {
    label: "Street Address", w: "w-56", defaultHidden: true,
    render: (f) => <span className="text-xs text-stone-700 line-clamp-2">{f.address_street || "—"}</span>,
  },
  contracts_count: {
    label: "Contracts (#)", w: "w-24", defaultHidden: true,
    render: (f) => {
      const n = f.contracts_count ?? (Array.isArray(f.contract_ids) ? f.contract_ids.length : 0);
      return <span className="text-xs font-bold text-stone-900 tabular-nums">{n || 0}</span>;
    },
  },
  current_contract: {
    label: "Current Contract", w: "w-36", defaultHidden: true,
    render: (f) => <ContractPill franchisee={f} />,
  },
  xero: {
    label: "Xero", w: "w-20", defaultHidden: true,
    render: (f) => (
      <ExternalLinkChip
        href={f.xero_contact_id ? `https://go.xero.com/Contacts/View/${f.xero_contact_id}` : null}
        label="Xero"
        testid={`xero-link-${f.id}`}
      />
    ),
  },
  tenure: {
    label: "Tenure", w: "w-24", defaultHidden: true,
    render: (f) => <span className="text-xs text-stone-700 tabular-nums whitespace-nowrap">{tenureLabel(f.tenure_start || f.date_added)}</span>,
  },
  facebook: {
    label: "Facebook", w: "w-24", defaultHidden: true,
    render: (f) => <ExternalLinkChip href={f.facebook} label="FB" testid={`fb-link-${f.id}`} />,
  },
  biography: {
    label: "Mojo Page", w: "w-24", defaultHidden: true,
    render: (f) => <ExternalLinkChip href={f.wp_page_url} label="Bio" testid={`bio-link-${f.id}`} />,
  },
};

const DEFAULT_COLUMN_ORDER = [
  "photo", "number", "organisation", "name", "mojo_email",
  "mobile", "postcode", "date_added", "mandate",
  "current_contract", "tenure", "contracts_count",
  "secondary_email", "street", "xero", "facebook", "biography",
];

const COLUMNS_LS_KEY = "cm.franchisees.columns.v1";

function useColumnsConfig() {
  const initial = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(COLUMNS_LS_KEY) || "null");
      if (raw?.order && raw?.hidden) {
        // Heal: append any new columns added since last save.
        const order = raw.order.filter((id) => COLUMN_DEFS[id]);
        for (const id of DEFAULT_COLUMN_ORDER) if (!order.includes(id)) order.push(id);
        return { order, hidden: new Set(raw.hidden.filter((id) => COLUMN_DEFS[id])) };
      }
    } catch { /* fall through */ }
    const hidden = new Set(
      Object.entries(COLUMN_DEFS).filter(([, def]) => def.defaultHidden).map(([id]) => id)
    );
    return { order: [...DEFAULT_COLUMN_ORDER], hidden };
  };
  const [config, setConfig] = useState(initial);
  useEffect(() => {
    try {
      localStorage.setItem(COLUMNS_LS_KEY, JSON.stringify({
        order: config.order,
        hidden: Array.from(config.hidden),
      }));
    } catch (e) { console.debug("[FranchiseesPage] columns LS write blocked", e); }
  }, [config]);
  const toggle = (id) => setConfig((c) => {
    const hidden = new Set(c.hidden);
    if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
    return { ...c, hidden };
  });
  const move = (fromIdx, toIdx) => setConfig((c) => {
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return c;
    const order = [...c.order];
    const [it] = order.splice(fromIdx, 1);
    order.splice(toIdx, 0, it);
    return { ...c, order };
  });
  const reset = () => {
    const hidden = new Set(
      Object.entries(COLUMN_DEFS).filter(([, def]) => def.defaultHidden).map(([id]) => id)
    );
    setConfig({ order: [...DEFAULT_COLUMN_ORDER], hidden });
  };
  const visibleOrder = useMemo(() => config.order.filter((id) => !config.hidden.has(id)), [config]);
  return { order: config.order, hidden: config.hidden, visibleOrder, toggle, move, reset };
}

function ColumnPicker({ cfg }) {
  const [dragId, setDragId] = useState(null);
  const onDragStart = (id) => (e) => { setDragId(id); e.dataTransfer.effectAllowed = "move"; };
  const onDragOver = (overId) => (e) => {
    e.preventDefault();
    if (!dragId || dragId === overId) return;
    const fromIdx = cfg.order.indexOf(dragId);
    const toIdx = cfg.order.indexOf(overId);
    if (fromIdx >= 0 && toIdx >= 0) cfg.move(fromIdx, toIdx);
  };
  const onDragEnd = () => setDragId(null);
  const visibleCount = cfg.order.length - cfg.hidden.size;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="columns-picker-trigger"
          className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-900 hover:bg-stone-50 rounded-lg flex items-center gap-1.5">
          <Columns3 className="w-3.5 h-3.5" />
          Columns <span className="text-stone-500 normal-case font-medium">({visibleCount})</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0 rounded-xl border border-stone-200 shadow-xl">
        <div className="px-3 py-2 border-b border-stone-200 flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Show & order columns</div>
          <button
            type="button"
            onClick={cfg.reset}
            data-testid="columns-reset"
            className="text-[10px] font-bold uppercase tracking-wider text-stone-500 hover:text-stone-950 flex items-center gap-1">
            <RotateCcw className="w-3 h-3" /> Reset
          </button>
        </div>
        <div className="max-h-80 overflow-y-auto py-1" data-testid="columns-picker-list">
          {cfg.order.map((id) => {
            const def = COLUMN_DEFS[id];
            if (!def) return null;
            const hidden = cfg.hidden.has(id);
            const isDragging = dragId === id;
            return (
              <div
                key={id}
                draggable
                onDragStart={onDragStart(id)}
                onDragOver={onDragOver(id)}
                onDragEnd={onDragEnd}
                onDrop={onDragEnd}
                data-testid={`columns-picker-item-${id}`}
                className={`flex items-center gap-2 px-3 py-1.5 hover:bg-stone-50 cursor-move group ${isDragging ? "opacity-40" : ""}`}>
                <GripVertical className="w-3.5 h-3.5 text-stone-300 group-hover:text-stone-500 shrink-0" />
                <label className="flex-1 flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!hidden}
                    onChange={() => cfg.toggle(id)}
                    onClick={(e) => e.stopPropagation()}
                    data-testid={`columns-picker-check-${id}`}
                    className="rounded border-stone-300 accent-stone-950"
                  />
                  <span className={`text-sm ${hidden ? "text-stone-400" : "text-stone-900"}`}>{def.label}</span>
                </label>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default function FranchiseesPage() {
  const [all, setAll] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [segment, setSegment] = useState("active");
  const [sortBy, setSortBy] = useState("franchise_number");
  const [sortDir, setSortDir] = useState(1);
  const [gcSyncOpen, setGcSyncOpen] = useState(false);
  // Admin one-off: import biographies from WordPress export.
  const [wpBioOpen, setWpBioOpen] = useState(false);
  const [missingMandate, setMissingMandate] = useState({ count: 0, items: [], threshold_days: 14 });
  const [missingMandateExpanded, setMissingMandateExpanded] = useState(false);
  // Card vs table view. Persisted so admins land on their last-chosen
  // layout on subsequent visits.
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem("cm.franchisees.view") === "grid" ? "grid" : "list"; }
    catch { return "list"; }
  });
  useEffect(() => {
    try { localStorage.setItem("cm.franchisees.view", viewMode); }
    catch (e) { console.debug("[FranchiseesPage] localStorage write blocked", e); }
  }, [viewMode]);
  // Card click → quick-preview popover instead of a full page nav.
  const [previewId, setPreviewId] = useState(null);
  const columnsCfg = useColumnsConfig();
  const reload = async () => {
    try {
      const { data } = await api.get("/franchisees", { params: { limit: 500, sort_by: "franchise_number", sort_dir: 1 } });
      setAll(data.items || []);
    } catch (e) { setError("Could not load franchisees."); }
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { data } = await api.get("/franchisees", { params: { limit: 500, sort_by: "franchise_number", sort_dir: 1 } });
        setAll(data.items || []);
      } catch (e) {
        setError("Could not load franchisees.");
      } finally {
        setLoading(false);
      }
    })();
    // Missing-mandate alerts — loaded in parallel, non-blocking.
    api.get("/franchisees/alerts/missing-mandate")
      .then(({ data }) => setMissingMandate(data || { count: 0, items: [], threshold_days: 14 }))
      .catch(() => {/* non-fatal */});
  }, []);

  // Segment counts — "Other" accounts (Demo/HQ) are kept out of the
  // Active/Ex/Licencee totals so the headline numbers reflect real
  // franchise activity, not sandbox/training seats.
  const counts = useMemo(() => {
    const c = { active: 0, ex: 0, licencee: 0, other: 0, all: all.length };
    for (const f of all) {
      if (isOther(f)) { c.other += 1; continue; }
      if (hasTag(f, "Franchisee")) c.active += 1;
      if (hasTag(f, "EX-Franchisee")) c.ex += 1;
      if (hasTag(f, "Worldwide Licencee")) c.licencee += 1;
    }
    return c;
  }, [all]);

  const filtered = useMemo(() => {
    const seg = SEGMENTS.find((s) => s.key === segment);
    let items;
    if (seg && seg.key === "other") {
      items = all.filter(isOther);
    } else if (seg && seg.tag) {
      // Strip Other accounts from the tag-based tabs.
      items = all.filter((f) => hasTag(f, seg.tag) && !isOther(f));
    } else {
      items = [...all];
    }
    if (search) {
      const q = search.toLowerCase();
      items = items.filter((f) =>
        [f.organisation, f.first_name, f.last_name, f.mojo_email, f.franchise_number, f.city, f.postcode]
          .filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
      );
    }
    items.sort((a, b) => {
      const va = a[sortBy] ?? "";
      const vb = b[sortBy] ?? "";
      if (va < vb) return -1 * sortDir;
      if (va > vb) return 1 * sortDir;
      return 0;
    });
    return items;
  }, [all, segment, search, sortBy, sortDir]);

  const headerClick = (col) => () => {
    if (sortBy === col) setSortDir(-sortDir);
    else { setSortBy(col); setSortDir(1); }
  };

  return (
    <div className="min-h-screen">
      <div className="h-16 border-b border-stone-200 bg-white flex items-center px-8 sticky top-0 z-10" data-testid="topbar">
        <div className="flex items-baseline gap-3 flex-1">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">CRM</div>
          <h1 className="font-display text-xl text-stone-950">Franchises / Licences</h1>
          <span className="text-xs text-stone-500">{filtered.length} of {all.length} records</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setGcSyncOpen(true)} data-testid="gc-sync-button"
            className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-900 hover:bg-stone-50 rounded-lg flex items-center gap-1.5">
            <CreditCard className="w-3.5 h-3.5" /> Sync GoCardless
          </button>
          <button onClick={() => setWpBioOpen(true)} data-testid="wp-bio-open"
            title="One-off migration: pull franchisee biographies from a WordPress XML export"
            className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-900 hover:bg-stone-50 rounded-lg flex items-center gap-1.5">
            <FileCode className="w-3.5 h-3.5" /> Import WP Bios
          </button>
          {viewMode === "list" && <ColumnPicker cfg={columnsCfg} />}
          {/* View toggle: list / grid */}
          <div className="inline-flex border border-stone-300 rounded-lg overflow-hidden" data-testid="view-toggle">
            <button
              onClick={() => setViewMode("list")}
              data-testid="view-list"
              title="List view"
              className={`px-2.5 py-2 flex items-center justify-center ${viewMode === "list" ? "bg-stone-950 text-white" : "bg-white text-stone-700 hover:bg-stone-50"}`}
            >
              <ListIcon className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode("grid")}
              data-testid="view-grid"
              title="Card view"
              className={`px-2.5 py-2 flex items-center justify-center border-l border-stone-300 ${viewMode === "grid" ? "bg-stone-950 text-white" : "bg-white text-stone-700 hover:bg-stone-50"}`}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
          </div>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="franchisee-search"
              placeholder="Search name, org, email, postcode…"
              className="pl-10 pr-4 py-2 w-80 bg-stone-50 border border-stone-300 text-sm focus:outline-none focus:border-stone-900 rounded-lg"
            />
          </div>
        </div>
      </div>

      <GoCardlessSyncModal open={gcSyncOpen} onClose={() => setGcSyncOpen(false)} onCommitted={reload} />
      <WPBioImportModal open={wpBioOpen} onClose={() => setWpBioOpen(false)} onCommitted={reload} allFranchisees={all} />

      {missingMandate.count > 0 && (
        <div className="px-8 pt-6" data-testid="missing-mandate-banner">
          <div className="border border-red-300 bg-red-50 rounded-2xl overflow-hidden">
            <button
              type="button"
              onClick={() => setMissingMandateExpanded((v) => !v)}
              data-testid="missing-mandate-toggle"
              className="w-full flex items-center justify-between gap-3 px-5 py-3 hover:bg-red-100/40 transition-colors text-left">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <span className="shrink-0 w-7 h-7 rounded-full bg-red-600 text-white flex items-center justify-center text-xs font-bold tabular-nums">
                  {missingMandate.count}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-red-700">GoCardless mandate missing</div>
                  <div className="text-sm font-semibold text-red-900 truncate">
                    {missingMandate.count === 1
                      ? "1 active franchisee has been live ≥ "
                      : `${missingMandate.count} active franchisees have been live ≥ `}
                    {missingMandate.threshold_days || 14} days without a Direct Debit mandate.
                  </div>
                </div>
              </div>
              <ChevronDown className={`w-4 h-4 text-red-700 transition-transform ${missingMandateExpanded ? "rotate-180" : ""}`} />
            </button>
            {missingMandateExpanded && (
              <div className="border-t border-red-200 divide-y divide-red-200/60" data-testid="missing-mandate-list">
                {missingMandate.items.map((m) => (
                  <MissingMandateRow
                    key={m.id}
                    item={m}
                    onResolved={(updatedId) => {
                      // Remove from local banner state — next page refresh /
                      // 5-min sidebar poll will reconcile the rest.
                      setMissingMandate((prev) => ({
                        ...prev,
                        count: Math.max(0, prev.count - 1),
                        items: prev.items.filter((x) => x.id !== updatedId),
                      }));
                      reload();
                    }} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Segment tabs */}
      <div className="px-8 pt-6">
        <div className="flex border-b border-stone-200 -mb-px" data-testid="segment-tabs">
          {SEGMENTS.map((s) => {
            const active = segment === s.key;
            const count = counts[s.key];
            return (
              <button
                key={s.key}
                onClick={() => setSegment(s.key)}
                data-testid={`segment-${s.key}`}
                className={`px-5 py-3 text-sm font-bold transition-colors border-b-2 ${
                  active
                    ? "border-stone-950 text-stone-950"
                    : "border-transparent text-stone-500 hover:text-stone-900"
                }`}
              >
                {s.label}
                <span className={`ml-2 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-md ${
                  active ? "bg-[#dddd16] text-stone-950" : "bg-stone-100 text-stone-600"
                }`}>{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="p-8 pt-6">
        {error && (
          <div className="mb-4 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2 rounded-xl">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}
        {loading ? (
          <div className="text-center text-stone-500 text-sm uppercase tracking-widest p-12" data-testid="franchisees-loading">Loading…</div>
        ) : viewMode === "grid" ? (
          <FranchiseeGrid items={filtered} onPreview={setPreviewId} />
        ) : (
          <div className="bg-white border border-stone-200 overflow-hidden rounded-2xl" data-testid="franchisees-table">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-[#F2F2F0] border-b border-stone-200">
                  <tr>
                    {columnsCfg.visibleOrder.map((id) => {
                      const def = COLUMN_DEFS[id];
                      if (!def) return null;
                      const sortable = Boolean(def.sortKey);
                      const isSorted = sortable && sortBy === def.sortKey;
                      return (
                        <th
                          key={id}
                          onClick={sortable ? headerClick(def.sortKey) : undefined}
                          className={`text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 ${def.w || ""} ${sortable ? "cursor-pointer hover:bg-stone-200/50" : ""}`}
                          data-testid={`th-${id}`}>
                          {def.label}
                          {sortable && (isSorted ? (
                            <span className="text-stone-950 ml-1">{sortDir === 1 ? "↑" : "↓"}</span>
                          ) : <span className="text-stone-300 ml-1">↕</span>)}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr><td colSpan={columnsCfg.visibleOrder.length} className="px-3 py-10 text-center text-sm text-stone-500">No franchisees in this view.</td></tr>
                  ) : filtered.map((f) => (
                    <tr key={f.id} className="border-b border-stone-100 hover:bg-stone-50 transition-colors" data-testid={`franchisee-row-${f.id}`}>
                      {columnsCfg.visibleOrder.map((id) => {
                        const def = COLUMN_DEFS[id];
                        if (!def) return null;
                        return (
                          <td key={id} className="px-3 py-2 align-middle">
                            {def.render(f)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      {/* Quick-preview popover triggered from the grid view */}
      {previewId && (
        <FranchiseePreview
          franchisee={filtered.find((f) => f.id === previewId)}
          onClose={() => setPreviewId(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card / grid view — 5 columns on wide screens.
// Shows photo, organisation, Mojo email, mobile (per Paul's spec).
// Cards open the quick-preview popover instead of navigating away, so
// admins can scan many franchisees fast without losing their filter state.
// ---------------------------------------------------------------------------
function FranchiseeGrid({ items, onPreview }) {
  if (!items.length) {
    return (
      <div className="bg-white border border-stone-200 rounded-2xl p-10 text-center text-sm text-stone-500" data-testid="franchisees-grid-empty">
        No franchisees in this view.
      </div>
    );
  }
  return (
    <div
      className="grid gap-4 grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
      data-testid="franchisees-grid"
    >
      {items.map((f) => {
        const photo = f.photos?.[0]?.url;
        const name = f.organisation || [f.first_name, f.last_name].filter(Boolean).join(" ") || "(no organisation)";
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => onPreview(f.id)}
            data-testid={`franchisee-card-${f.id}`}
            className="bg-white border border-stone-200 rounded-2xl overflow-hidden text-left hover:border-stone-950 hover:shadow-md transition-all flex flex-col group"
          >
            <div className="relative aspect-square bg-stone-100 overflow-hidden">
              {photo ? (
                <img
                  src={photo}
                  alt=""
                  loading="lazy"
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-4xl font-bold text-stone-300">
                  {(f.first_name?.[0] || "?") + (f.last_name?.[0] || "")}
                </div>
              )}
              {f.franchise_number && (
                <div className="absolute top-2 left-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950/85 text-white rounded-md tabular-nums">
                  #{f.franchise_number}
                </div>
              )}
            </div>
            <div className="p-3 flex-1 flex flex-col gap-1.5 min-w-0">
              <div className="font-semibold text-sm text-stone-950 leading-snug line-clamp-2">
                {name}
              </div>
              <div className="text-xs text-stone-600 truncate flex items-center gap-1.5">
                <Mail className="w-3 h-3 shrink-0 text-stone-400" />
                <span className="truncate">{f.mojo_email || "—"}</span>
              </div>
              <div className="text-xs text-stone-600 truncate flex items-center gap-1.5">
                <Phone className="w-3 h-3 shrink-0 text-stone-400" />
                <span className="truncate tabular-nums">{f.mobile_phone || "—"}</span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick-preview popover for the grid view.
// Mirrors the card content but adds a clear "Open detail" CTA so admins
// can decide whether to dive in. Closes on backdrop click or Esc.
// ---------------------------------------------------------------------------
function FranchiseePreview({ franchisee, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!franchisee) return null;
  const f = franchisee;
  const photo = f.photos?.[0]?.url;
  const name = f.organisation || [f.first_name, f.last_name].filter(Boolean).join(" ") || "(no organisation)";
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in"
      data-testid="franchisee-preview-backdrop"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden"
        data-testid="franchisee-preview"
      >
        <div className="relative aspect-[16/10] bg-stone-100">
          {photo ? (
            <img src={photo} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-6xl font-bold text-stone-300">
              {(f.first_name?.[0] || "?") + (f.last_name?.[0] || "")}
            </div>
          )}
          <button
            onClick={onClose}
            className="absolute top-3 right-3 w-8 h-8 rounded-full bg-white/95 text-stone-900 flex items-center justify-center hover:bg-white shadow"
            data-testid="franchisee-preview-close"
          >
            <X className="w-4 h-4" />
          </button>
          {f.franchise_number && (
            <div className="absolute top-3 left-3 px-2.5 py-1 text-xs font-bold uppercase tracking-wider bg-stone-950/85 text-white rounded-md tabular-nums">
              #{f.franchise_number}
            </div>
          )}
        </div>
        <div className="p-5 space-y-3">
          <div>
            <h2 className="font-display text-2xl text-stone-950 leading-tight">{name}</h2>
            {f.organisation && (f.first_name || f.last_name) && (
              <div className="text-sm text-stone-600 mt-0.5">
                {[f.first_name, f.last_name].filter(Boolean).join(" ")}
              </div>
            )}
          </div>
          <dl className="space-y-2 text-sm">
            <div className="flex items-start gap-2">
              <Mail className="w-4 h-4 text-stone-400 mt-0.5 shrink-0" />
              {f.mojo_email ? (
                <a href={`mailto:${f.mojo_email}`} className="text-stone-700 hover:text-stone-950 hover:underline underline-offset-2 break-all">
                  {f.mojo_email}
                </a>
              ) : <span className="text-stone-400">No Mojo email</span>}
            </div>
            <div className="flex items-start gap-2">
              <Phone className="w-4 h-4 text-stone-400 mt-0.5 shrink-0" />
              {f.mobile_phone ? (
                <a href={`tel:${(f.mobile_phone || "").replace(/\s+/g, "")}`} className="text-stone-700 hover:text-stone-950 hover:underline underline-offset-2 tabular-nums">
                  {f.mobile_phone}
                </a>
              ) : <span className="text-stone-400">No mobile on file</span>}
            </div>
            {(f.city || f.postcode) && (
              <div className="text-stone-600 pl-6 tabular-nums">
                {[f.city, f.postcode].filter(Boolean).join(" · ")}
              </div>
            )}
          </dl>
          <Link
            to={`/franchisees/${f.id}`}
            data-testid={`franchisee-preview-open-${f.id}`}
            className="mt-2 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 font-bold text-sm uppercase tracking-wider rounded-lg"
          >
            Open detail <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}
