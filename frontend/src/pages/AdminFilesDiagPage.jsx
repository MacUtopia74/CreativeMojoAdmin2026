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

  const run = async (rebind = false) => {
    const term = q.trim();
    if (!term) { setError("Enter a franchise number, name, or organisation"); return; }
    if (rebind) setRebinding(true); else setLoading(true);
    setError(""); setReport(null);
    try {
      const { data } = await api.get(`/admin/files/diag`, {
        params: { q: term, rebind_orphans: rebind || undefined },
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
            onKeyDown={(e) => { if (e.key === "Enter") run(false); }}
            placeholder="0095   or   Samantha Whiteman   or   Bexhill"
            className="w-full border border-stone-300 rounded-lg pl-9 pr-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-stone-900"
            data-testid="diag-input"
          />
        </div>
        <button
          type="button"
          onClick={() => run(false)}
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
                  onClick={() => { setQ(c.franchise_number || c.id); run(false); }}
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
                onClick={() => run(true)}
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
