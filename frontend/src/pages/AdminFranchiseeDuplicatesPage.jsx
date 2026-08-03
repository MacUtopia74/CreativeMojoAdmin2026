// Admin — Franchise Number Duplicates report.
//
// Enumerates every franchise_number that appears on ≥2 franchisee
// records. Read-only: no merge / delete / renumber happens from this
// page. Its job is to show the reconciler exactly what each record
// looks like (portal users, files, R2 prefixes, contact origin) so
// they can decide which record keeps the number.
import { useEffect, useState } from "react";
import api from "@/lib/api";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

export default function AdminFranchiseeDuplicatesPage() {
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState([]);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true); setError("");
    try {
      const { data } = await api.get("/admin/franchisees/duplicates");
      setGroups(data.groups || []);
    } catch (e) {
      setError(e?.response?.data?.detail || "Failed to load duplicates.");
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="max-w-6xl mx-auto py-8 px-6" data-testid="franchisee-duplicates-page">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] font-bold text-stone-500">Admin · Data integrity</div>
          <h1 className="text-2xl font-bold text-stone-900 mt-1">Duplicate franchise numbers</h1>
          <p className="text-sm text-stone-600 mt-2 leading-relaxed max-w-2xl">
            Every franchise number that is currently assigned to more than one franchisee record. Uploads
            into these prefixes are blocked at the API until reconciled. Nothing here mutates data — decide
            which record keeps the number, then renumber the other via the franchisee&apos;s admin page.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="shrink-0 inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-stone-900 text-white text-xs font-semibold hover:bg-stone-800 disabled:opacity-50"
          data-testid="duplicates-refresh"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>
      )}

      {!loading && groups.length === 0 && !error && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
             data-testid="duplicates-empty">
          ✅ No duplicate franchise numbers found. Once you&apos;re confident this stays clean, apply the
          unique index by running <code className="bg-white/60 px-1.5 py-0.5 rounded text-[11px]">python scripts/add_unique_franchise_number_index.py</code>.
        </div>
      )}

      {groups.map((g) => (
        <section
          key={g.franchise_number}
          className="mt-6 rounded-xl border-2 border-red-300 bg-red-50/30 overflow-hidden"
          data-testid={`duplicate-group-${g.franchise_number}`}
        >
          <div className="bg-red-100 px-5 py-3 flex items-center gap-3">
            <AlertTriangle className="w-4 h-4 text-red-800" />
            <div>
              <div className="text-lg font-bold text-red-950">
                Franchise number <code className="bg-white px-2 py-0.5 rounded font-mono">{g.franchise_number}</code>
                {" "}used by {g.record_count} records
              </div>
              <div className="text-xs text-red-900 mt-0.5">
                Renumber the record that should NOT keep this number via its detail page. All uploads and
                diagnostics referencing this number are hard-blocked until reconciled.
              </div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-stone-700 uppercase tracking-wider text-[10px] bg-white/80">
                <tr>
                  <th className="text-left py-2 px-3">Franchisee ID</th>
                  <th className="text-left py-2 px-3">Organisation</th>
                  <th className="text-left py-2 px-3">Name</th>
                  <th className="text-left py-2 px-3">Email</th>
                  <th className="text-left py-2 px-3">Status</th>
                  <th className="text-left py-2 px-3">Created</th>
                  <th className="text-left py-2 px-3">Portal user(s)</th>
                  <th className="text-right py-2 px-3">Files (visible)</th>
                  <th className="text-left py-2 px-3">Canonical R2 root</th>
                  <th className="text-left py-2 px-3">R2 prefixes seen</th>
                  <th className="text-left py-2 px-3">Contact origin</th>
                </tr>
              </thead>
              <tbody className="bg-white/70">
                {g.records.map((r) => (
                  <tr key={r.id} className="border-t border-stone-200 align-top">
                    <td className="py-2 px-3 font-mono text-[11px] break-all">{r.id}</td>
                    <td className="py-2 px-3">{r.organisation || "—"}</td>
                    <td className="py-2 px-3">{[r.first_name, r.last_name].filter(Boolean).join(" ") || "—"}</td>
                    <td className="py-2 px-3">{r.email || r.mojo_email || "—"}</td>
                    <td className="py-2 px-3">{r.status || "—"}</td>
                    <td className="py-2 px-3">{r.created_at ? new Date(r.created_at).toLocaleDateString() : "—"}</td>
                    <td className="py-2 px-3">
                      {Array.isArray(r.linked_portal_users) && r.linked_portal_users.length > 0
                        ? r.linked_portal_users.map((u) => u.email).join(", ")
                        : <span className="text-stone-400">— none —</span>}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {r.files_index?.visible ?? 0}
                      {r.files_index?.total > (r.files_index?.visible ?? 0) && (
                        <span className="text-stone-400 text-[10px] ml-1">
                          ({r.files_index.total} total)
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3 font-mono text-[10px]">
                      {r.canonical_r2_prefix || "—"}
                      {r.r2_root_prefix_persisted && (
                        <span className="ml-1 text-emerald-700 text-[10px] font-semibold">🔒</span>
                      )}
                    </td>
                    <td className="py-2 px-3 font-mono text-[10px]">
                      {(r.files_index?.top_level_r2_prefixes || []).length === 0
                        ? "—"
                        : r.files_index.top_level_r2_prefixes.map((p) => (
                            <div key={p.prefix}>{p.prefix} <span className="text-stone-500">({p.files})</span></div>
                          ))}
                    </td>
                    <td className="py-2 px-3 font-mono text-[10px] break-all">
                      {r.converted_from_contact_id || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
