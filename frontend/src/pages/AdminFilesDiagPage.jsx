// Admin File Vault diagnostic UI — Feb 2026.
//
// Wraps the existing `/api/admin/files/diag` endpoint in a friendly
// form so admins can diagnose + auto-rebind orphaned rows without
// needing curl. Used when a franchisee's portal shows 0 files but
// admin's "Files admin" view shows their folder with content — the
// classic files_index.franchisee_id mismatch.
import { useState } from "react";
import api from "@/lib/api";
import { Search, AlertTriangle, CheckCircle2, Wrench, Loader2 } from "lucide-react";

export default function AdminFilesDiagPage() {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [rebinding, setRebinding] = useState(false);
  const [bulkHealing, setBulkHealing] = useState(false);
  const [bulkHealSummary, setBulkHealSummary] = useState(null);

  const bulkHeal = async () => {
    if (!window.confirm(
      "Bootstrap standard folders for every active franchisee?\n\n" +
      "This canonicalises each franchisee's R2 root prefix and creates any of the three standard sub-folders that are missing (Artwork, Franchise Documents, Other Files). It's idempotent — franchisees already set up will be skipped."
    )) return;
    setBulkHealing(true); setError(""); setBulkHealSummary(null);
    try {
      const { data } = await api.post("/franchisees/bootstrap-folders/all");
      setBulkHealSummary(data);
    } catch (e) {
      setError(e?.response?.data?.detail || "Bulk-heal request failed.");
    } finally { setBulkHealing(false); }
  };

  const run = async (opts = {}) => {
    const term = q.trim();
    if (!term) { setError("Enter a franchise number, name, or organisation"); return; }
    const { rebind = false, canonicalise = false } = opts;
    if (rebind) setRebinding(true); else setLoading(true);
    setError(""); setReport(null);
    try {
      const { data } = await api.get(`/admin/files/diag`, {
        params: {
          q: term,
          rebind_orphans: rebind || undefined,
          canonicalise: canonicalise || undefined,
        },
      });
      setReport(data);
    } catch (e) {
      setError(e?.response?.data?.detail || "Diagnostic call failed.");
    } finally {
      setLoading(false); setRebinding(false);
    }
  };

  const idx = report?.files_index || {};
  const nearbyPrefixesExist = (report?.nearby_prefixes_with_same_number || []).length > 0;

  return (
    <div className="max-w-5xl mx-auto py-8 px-6">
      <div className="mb-6">
        <div className="text-xs uppercase tracking-[0.2em] font-bold text-stone-500">Admin · Tools</div>
        <h1 className="text-2xl font-bold text-stone-900 mt-1">File Vault Diagnostic</h1>
        <p className="text-sm text-stone-600 mt-2 leading-relaxed">
          Find and fix cases where a franchisee&apos;s portal shows 0 files but the admin file vault
          shows their folder full. Enter their franchise number (e.g. <code className="px-1.5 py-0.5 bg-stone-100 rounded text-xs">0095</code>)
          or a name/organisation, then click <b>Diagnose</b>. If orphans are found, click <b>Auto-fix</b>.
        </p>
      </div>

      <div className="flex gap-2 items-center">
        <div className="flex-1 relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") run({}); }}
            placeholder="0095   or   Samantha Whiteman   or   Bexhill"
            className="w-full border border-stone-300 rounded-lg pl-9 pr-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-stone-900"
            data-testid="diag-input"
          />
        </div>
        <button
          type="button"
          onClick={() => run({})}
          disabled={loading || !q.trim()}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-stone-900 text-white rounded-lg text-sm font-semibold hover:bg-stone-800 disabled:opacity-50"
          data-testid="diag-run"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          Diagnose
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Bulk-heal button — runs POST /franchisees/bootstrap-folders/all
          which canonicalises every active franchisee's r2_root_prefix
          AND creates the three standard folders where missing. Safe to
          re-run — the endpoint is idempotent. Use this to fix the
          "franchise-level panel shows 3 folders but main Files admin
          is empty" divergence for legacy franchisees. */}
      <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3 flex items-center justify-between gap-3">
        <div className="text-xs text-stone-600">
          <span className="font-semibold text-stone-800">Bulk heal:</span>{" "}
          canonicalise every active franchisee&apos;s R2 root and ensure the three standard folders exist. Idempotent — skips franchisees already set up.
        </div>
        <button
          type="button"
          onClick={bulkHeal}
          disabled={bulkHealing}
          className="shrink-0 inline-flex items-center gap-2 px-3 py-1.5 bg-emerald-700 text-white rounded-md text-xs font-bold hover:bg-emerald-800 disabled:opacity-50"
          data-testid="diag-bulk-heal"
        >
          {bulkHealing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "🩹"}
          Bootstrap all franchisees
        </button>
      </div>
      {bulkHealSummary && (
        <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900"
             data-testid="diag-bulk-heal-summary">
          <div className="font-bold">✅ Bulk heal complete.</div>
          <div className="mt-1">
            Processed {bulkHealSummary.processed} franchisee{bulkHealSummary.processed === 1 ? "" : "s"} ·
            created {bulkHealSummary.created_total} standard folder{bulkHealSummary.created_total === 1 ? "" : "s"} ·
            skipped {bulkHealSummary.skipped_total} already-present ·
            {bulkHealSummary.without_prefix} franchisee{bulkHealSummary.without_prefix === 1 ? "" : "s"} missing name/number.
          </div>
          {Array.isArray(bulkHealSummary.results) && bulkHealSummary.results.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] font-semibold">Show franchisees that received new folders</summary>
              <ul className="mt-2 space-y-0.5 max-h-40 overflow-auto text-[11px]">
                {bulkHealSummary.results.map((r) => (
                  <li key={r.franchisee_id}>
                    <code className="bg-white/60 px-1 rounded">{r.franchise_number}</code>{" "}
                    {r.organisation} — added: {r.created.join(", ")}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {report?.matched_franchisees === 0 && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          No franchisee matched. Try their franchise number or a fuller name.
        </div>
      )}

      {Array.isArray(report?.candidates) && report.candidates.length > 1 && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Multiple matches — narrow with an exact franchise number:
          <ul className="mt-2 space-y-1">
            {report.candidates.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => { setQ(c.franchise_number || c.id); run({}); }}
                  className="underline"
                >
                  {c.franchise_number} · {c.organisation || c.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report?.franchisee && (
        <div className="mt-6 rounded-xl border border-stone-200 bg-white p-5">
          <div className="text-[11px] uppercase tracking-[0.2em] font-bold text-stone-500">Franchisee</div>
          <div className="text-lg font-bold text-stone-900 mt-1">
            {report.franchisee.franchise_number} · {report.franchisee.organisation || report.franchisee.name}
          </div>
          <div className="text-xs text-stone-500 mt-1">
            id: <code className="bg-stone-100 px-1.5 py-0.5 rounded">{report.franchisee.id}</code>
          </div>

          <div className="grid sm:grid-cols-2 gap-4 mt-5">
            <Stat label="R2 objects (physical files)" value={report.r2?.object_count} sub={`${((report.r2?.total_bytes || 0) / (1024*1024)).toFixed(1)} MB`} />
            <Stat label="Index rows under prefix" value={idx.under_expected_prefix_total} />
            <Stat label="Bound to this franchisee ✅" value={idx.under_expected_prefix_bound_to_this_franchisee} tone="ok" />
            <Stat label="Orphaned (null franchisee_id)" value={idx.under_expected_prefix_orphan_null_id} tone={idx.under_expected_prefix_orphan_null_id > 0 ? "warn" : "ok"} />
            <Stat label="Bound to WRONG franchisee" value={idx.under_expected_prefix_wrong_id} tone={idx.under_expected_prefix_wrong_id > 0 ? "warn" : "ok"} />
            <Stat label="Files visible to franchisee (portal)" value={idx.matching_franchisee_id_visible} tone={idx.matching_franchisee_id_visible === 0 ? "warn" : "ok"} />
          </div>

          {/* Canonical vs Fresh prefix — surfaces whether the panel's
              root has been "locked" (persisted r2_root_prefix) and
              flags mismatches between the persisted root and the slug
              you'd derive from the current fields (which is a rename
              indicator, not a bug). */}
          <div className="mt-5 rounded-lg border border-stone-200 bg-stone-50 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="text-[11px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">
                  Canonical R2 root
                </div>
                <dl className="text-xs text-stone-700 space-y-1.5">
                  <div className="flex gap-3">
                    <dt className="w-40 text-stone-500">Panel uses (canonical):</dt>
                    <dd>
                      <code className="bg-white px-1.5 py-0.5 rounded border border-stone-200 text-[11px]">
                        {report.canonical_r2_prefix || "— none —"}
                      </code>
                      {report.franchisee.r2_root_prefix_persisted ? (
                        <span className="ml-2 text-emerald-700 text-[11px] font-semibold">🔒 persisted</span>
                      ) : (
                        <span className="ml-2 text-amber-700 text-[11px] font-semibold">⚠ not yet persisted</span>
                      )}
                      {report.franchisee.r2_root_prefix_set_at && (
                        <span className="ml-2 text-stone-500 text-[11px]">
                          set {new Date(report.franchisee.r2_root_prefix_set_at).toLocaleString()}
                        </span>
                      )}
                    </dd>
                  </div>
                  <div className="flex gap-3">
                    <dt className="w-40 text-stone-500">Fresh from fields:</dt>
                    <dd>
                      <code className="bg-white px-1.5 py-0.5 rounded border border-stone-200 text-[11px]">
                        {report.fresh_r2_prefix_from_current_fields || "— unresolvable —"}
                      </code>
                      {report.canonical_matches_fresh === false && (
                        <span className="ml-2 text-amber-700 text-[11px] font-semibold">
                          ⚠ differs — franchisee was renamed after bootstrap
                        </span>
                      )}
                    </dd>
                  </div>
                </dl>
              </div>
              {!report.franchisee.r2_root_prefix_persisted && (
                <button
                  type="button"
                  onClick={() => run({ canonicalise: true })}
                  disabled={loading || rebinding}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-stone-900 text-white text-xs font-semibold hover:bg-stone-800 disabled:opacity-50"
                  data-testid="diag-canonicalise"
                >
                  🔒 Persist canonical root
                </button>
              )}
            </div>
            {report.canonicalise_applied && (
              <div className="mt-3 text-xs text-emerald-700">✅ Canonical R2 root was resolved and persisted. Future renames won&apos;t create a second root.</div>
            )}
          </div>

          {report.multiple_roots_detected && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-[11px] mb-2">
                <AlertTriangle className="w-3.5 h-3.5" /> Multiple R2 roots detected
              </div>
              This franchisee has files across more than one <code className="bg-white/60 px-1 py-0.5 rounded">franchisees/&lt;slug&gt;/</code> prefix.
              The panel will consistently pick the one flagged &quot;canonical&quot; above (either the persisted root, or the one with the most files if not yet persisted). Legacy roots remain browsable via
              <code className="bg-white/60 px-1 py-0.5 rounded mx-1">/files</code> but should eventually be migrated onto the canonical prefix so all uploads live together.
            </div>
          )}

          {nearbyPrefixesExist && (
            <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-[11px] mb-2">
                <AlertTriangle className="w-3.5 h-3.5" /> Renamed folder detected
              </div>
              This franchisee&apos;s organisation name changed at some point — files were uploaded under an old slug and
              live at a different R2 prefix. Nearby prefixes with the same franchise number:
              <ul className="mt-2 space-y-1 text-xs">
                {report.nearby_prefixes_with_same_number.map((n, i) => (
                  <li key={i}>
                    <code className="bg-white/60 px-1.5 py-0.5 rounded">{n._id}</code>
                    · {n.files} files · {((n.bytes || 0) / (1024*1024)).toFixed(1)} MB
                  </li>
                ))}
              </ul>
                Ask the developer to run the &quot;move to canonical prefix&quot; utility for this franchisee.
            </div>
          )}

          {/* Root-discovery simulation — what the FranchiseeFilesPanel's
              first call actually returns, and which folder it will pick
              as the panel's root. This is where the "0 files rendered"
              bug lived: the panel used to pick folders[0] alphabetically
              (returning the empty renamed slug) instead of the folder
              that actually contains files. */}
          {report.root_discovery_simulation && Array.isArray(report.root_discovery_simulation.folders) && (
            <div className="mt-5 rounded-lg border border-stone-200 bg-white p-4">
              <div className="text-[11px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">
                Panel root discovery
              </div>
              <div className="text-xs text-stone-600 mb-3">
                Simulating <code className="bg-stone-100 px-1.5 py-0.5 rounded">GET /files/tree?prefix=franchisees/&amp;franchisee_id={report.franchisee.id}</code> — the panel&apos;s <b>first</b> call.
              </div>
              {report.root_discovery_simulation.folders.length === 0 ? (
                <div className="text-sm text-amber-700">Backend returns 0 candidate folders — the panel would show &quot;No R2 folder mapped to this franchisee yet.&quot;</div>
              ) : (
                <>
                  <table className="w-full text-xs">
                    <thead className="text-stone-500 uppercase tracking-wider text-[10px]">
                      <tr>
                        <th className="text-left py-1">Folder</th>
                        <th className="text-right py-1">Files</th>
                        <th className="text-right py-1">MB</th>
                        <th className="text-right py-1">Picked?</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.root_discovery_simulation.folders.map((f) => {
                        const picked = report.root_discovery_simulation.panel_would_pick;
                        const isPicked = picked && picked.key === f.key;
                        return (
                          <tr key={f.key} className={`border-t border-stone-100 ${isPicked ? "bg-emerald-50" : ""}`}>
                            <td className="py-1.5 font-mono">{f.name}</td>
                            <td className="py-1.5 text-right tabular-nums">{f.files}</td>
                            <td className="py-1.5 text-right tabular-nums">{((f.bytes || 0) / (1024 * 1024)).toFixed(1)}</td>
                            <td className="py-1.5 text-right">{isPicked ? "✅" : ""}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {report.root_discovery_simulation.matches_expected_prefix === false && (
                    <div className="mt-3 text-xs text-amber-700">
                      ⚠️ The folder the panel would pick differs from the canonical prefix (<code className="bg-stone-100 px-1 py-0.5 rounded">{report.expected_r2_prefix}</code>). This is the rename scenario.
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Rows bound to this franchisee_id whose keys live OUTSIDE
              the current derived prefix. These are the "extra" rows
              that account for a discrepancy between the total
              franchisee_id count and what the panel sees. */}
          {report.files_index?.bound_to_this_franchisee_outside_prefix && (report.files_index.bound_to_this_franchisee_outside_prefix.total || 0) > 0 && (
            <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4">
              <div className="text-[11px] uppercase tracking-[0.2em] font-bold text-amber-800 mb-2">
                Rows bound to this franchisee but outside the canonical prefix
              </div>
              <div className="text-xs text-amber-900 mb-3">
                {report.files_index.bound_to_this_franchisee_outside_prefix.total} row(s) have this franchisee_id but a key that doesn&apos;t start with
                <code className="bg-white/60 px-1 py-0.5 rounded mx-1">{report.expected_r2_prefix}</code>.
                These usually appear when a franchisee&apos;s organisation slug or franchise number was changed after upload.
              </div>
              {(report.files_index.bound_to_this_franchisee_outside_prefix.grouped_by_prefix || []).map((g) => (
                <div key={g.prefix} className="mb-3">
                  <div className="text-xs font-bold text-stone-800">
                    <code className="bg-white/60 px-1.5 py-0.5 rounded">{g.prefix}</code>
                    · {g.files} file{g.files === 1 ? "" : "s"} · {((g.bytes || 0) / (1024 * 1024)).toFixed(1)} MB
                  </div>
                </div>
              ))}
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] text-stone-600 hover:text-stone-900">Show individual rows</summary>
                <ul className="mt-2 space-y-1 text-[11px] font-mono text-stone-700 max-h-60 overflow-auto">
                  {(report.files_index.bound_to_this_franchisee_outside_prefix.sample_rows || []).map((r) => (
                    <li key={r.key} className="truncate">
                      {r.hidden ? "🫥 " : "📄 "}
                      {r.key}
                      {r.size != null && <span className="text-stone-500"> · {((r.size || 0) / 1024).toFixed(1)} KB</span>}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          )}

          {report.tree_simulation && Array.isArray(report.tree_simulation.sub_folders) && (
            <div className="mt-5 rounded-lg border border-stone-200 bg-white p-4">
              <div className="text-[11px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">
                What the franchise-level page will render
              </div>
              <div className="text-xs text-stone-600 mb-3">
                Simulating <code className="bg-stone-100 px-1.5 py-0.5 rounded">GET /files/tree?prefix={report.tree_simulation.prefix_queried}</code> exactly
                as the panel would call it.
              </div>
              {report.tree_simulation.sub_folders.length === 0 && report.tree_simulation.root_level_files_count === 0 ? (
                <div className="text-sm text-amber-700">Backend returns 0 folders and 0 root-level files under this prefix.</div>
              ) : (
                <>
                  {report.tree_simulation.sub_folders.length > 0 && (
                    <table className="w-full text-xs">
                      <thead className="text-stone-500 uppercase tracking-wider text-[10px]">
                        <tr><th className="text-left py-1">Folder</th><th className="text-right py-1">Visible</th><th className="text-right py-1">Hidden</th><th className="text-right py-1">Wrong fid</th></tr>
                      </thead>
                      <tbody>
                        {report.tree_simulation.sub_folders.map((s) => (
                          <tr key={s.name} className="border-t border-stone-100">
                            <td className="py-1.5 font-semibold">{s.name}</td>
                            <td className="py-1.5 text-right tabular-nums">{s.visible_files}</td>
                            <td className="py-1.5 text-right tabular-nums text-stone-400">{s.hidden_files}</td>
                            <td className="py-1.5 text-right tabular-nums text-amber-700">{s.wrong_fid}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {report.tree_simulation.root_level_files_count > 0 && (
                    <div className="mt-3 text-xs text-stone-700">
                      + <b>{report.tree_simulation.root_level_files_count}</b> file{report.tree_simulation.root_level_files_count === 1 ? "" : "s"} directly at the root (not inside a sub-folder).
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {report.verdict && (
            <div className="mt-5 rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm text-stone-800">
              <div className="text-[11px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">Verdict</div>
              <div className="font-semibold">{report.verdict}</div>
              {report.hint && <div className="mt-1 text-stone-600">{report.hint}</div>}
            </div>
          )}

          {(idx.under_expected_prefix_orphan_null_id > 0 || idx.under_expected_prefix_wrong_id > 0) && (
            <div className="mt-6 rounded-lg border-2 border-amber-300 bg-amber-50 p-5">
              <div className="flex items-center gap-2 font-bold text-stone-900">
                <Wrench className="w-4 h-4" /> Auto-fix available
              </div>
              <div className="text-sm text-stone-700 mt-1">
                {idx.under_expected_prefix_orphan_null_id + idx.under_expected_prefix_wrong_id} rows can be re-bound to this franchisee.
                Files are already in the correct R2 folder — only the database link is missing.
              </div>
              <button
                type="button"
                onClick={() => run({ rebind: true })}
                disabled={rebinding}
                className="mt-3 inline-flex items-center gap-2 px-4 py-2 bg-amber-500 text-stone-950 rounded-lg text-sm font-bold hover:bg-amber-400 disabled:opacity-50"
                data-testid="diag-rebind"
              >
                {rebinding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wrench className="w-4 h-4" />}
                Auto-fix now
              </button>
            </div>
          )}

          {report.rebind && (
            <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-[11px] mb-1">
                <CheckCircle2 className="w-3.5 h-3.5" /> Rebind complete
              </div>
              Modified {report.rebind.modified} of {report.rebind.attempted} rows. Ask the franchisee to refresh their portal.
            </div>
          )}
        </div>
      )}

      {report && (
        <details className="mt-6">
          <summary className="cursor-pointer text-xs text-stone-500 hover:text-stone-800">
            Show raw diagnostic JSON
          </summary>
          <pre className="mt-2 text-[11px] bg-stone-950 text-emerald-300 p-4 rounded-lg overflow-auto">
            {JSON.stringify(report, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone = "neutral" }) {
  const toneCls = tone === "ok" ? "border-emerald-200 bg-emerald-50"
    : tone === "warn" ? "border-amber-200 bg-amber-50"
    : "border-stone-200 bg-white";
  return (
    <div className={`rounded-lg border ${toneCls} p-3`}>
      <div className="text-[11px] uppercase tracking-wider font-bold text-stone-500">{label}</div>
      <div className="text-2xl font-bold text-stone-900 mt-1">{value ?? 0}</div>
      {sub && <div className="text-[11px] text-stone-500 mt-0.5">{sub}</div>}
    </div>
  );
}
