// Admin page — cross-franchisee contact-leak audit + one-click clear.
//
// Companion UI for /api/admin/website-profile-audit. Built Feb 2026
// after Monica's map popup was found displaying Bel's admin email on
// production. The API blocks the leak at runtime and this page lets
// HQ see the full scope + suppress the underlying `show_website_*`
// flags without touching a terminal.
import { useCallback, useEffect, useState } from "react";
import api from "@/lib/api";
import {
  ShieldAlert, RefreshCw, CheckCircle2, AlertTriangle, Loader2, Eye, EyeOff,
} from "lucide-react";

export default function AdminWebsiteProfileAuditPage() {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [clearing, setClearing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearResult, setClearResult] = useState(null);
  const [showRaw, setShowRaw] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(""); setClearResult(null);
    try {
      const { data } = await api.get("/admin/website-profile-audit");
      setReport(data);
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function clearLeaks() {
    setClearing(true); setErr("");
    try {
      const { data } = await api.post(
        "/admin/website-profile-audit/clear-leaks",
        { confirm: "CLEAR-LEAKS" },
      );
      setClearResult(data);
      await load();
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message);
    } finally {
      setClearing(false);
      setConfirmOpen(false);
    }
  }

  const totals = report?.totals || {};
  const leaks = report?.leaks || [];
  const published = leaks.filter((l) => l.is_published);

  return (
    <div className="p-6 max-w-6xl mx-auto" data-testid="admin-website-profile-audit-page">
      <div className="flex items-center gap-3 mb-6">
        <ShieldAlert className="w-7 h-7 text-red-600" />
        <div>
          <h1 className="text-2xl font-bold text-stone-900">Public-profile contact-leak audit</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            Flags any franchisee whose Mojo-map <code>website_email</code> or <code>website_phone</code> matches another franchisee&apos;s admin contact.
          </p>
        </div>
      </div>

      {err && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 text-sm rounded flex items-center gap-2"
             data-testid="admin-website-profile-audit-error">
          <AlertTriangle className="h-4 w-4" /> {err}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-stone-500 py-16 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" /> Scanning franchisees…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <StatCard label="Franchisees scanned" value={totals.franchisees_scanned} />
            <StatCard label="Total leaks" value={totals.leaks_total} tone={totals.leaks_total > 0 ? "warn" : "ok"} />
            <StatCard label="Currently visible on map" value={totals.leaks_published_and_currently_visible} tone={totals.leaks_published_and_currently_visible > 0 ? "danger" : "ok"} />
            <StatCard label="Latent (not yet published)" value={totals.leaks_total - (totals.leaks_published_and_currently_visible || 0)} />
          </div>

          <div className="flex items-center justify-between mb-4">
            <button
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-sm border rounded-md bg-white hover:bg-stone-50"
              data-testid="admin-website-profile-audit-refresh">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh scan
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowRaw((v) => !v)}
                className="inline-flex items-center gap-1 px-2 py-1.5 text-xs border rounded-md bg-white hover:bg-stone-50"
                data-testid="admin-website-profile-audit-toggle-raw">
                {showRaw ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />} Raw JSON
              </button>
              <button
                onClick={() => setConfirmOpen(true)}
                disabled={published.length === 0 || clearing}
                className="inline-flex items-center gap-2 px-4 py-1.5 text-sm border rounded-md bg-red-600 text-white border-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="admin-website-profile-audit-clear-btn">
                <ShieldAlert className="h-4 w-4" />
                Suppress {published.length} published leak{published.length === 1 ? "" : "s"}
              </button>
            </div>
          </div>

          {clearResult && (
            <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded flex items-start gap-2"
                 data-testid="admin-website-profile-audit-clear-result">
              <CheckCircle2 className="h-4 w-4 mt-0.5" />
              <div>
                <div className="font-semibold">Suppressed {clearResult.cleared_count} published leak{clearResult.cleared_count === 1 ? "" : "s"}.</div>
                <div className="text-xs mt-0.5">
                  The underlying <code>website_email</code>/<code>website_phone</code> values are preserved for forensics; only the <code>show_website_*</code> flag was set to false.
                </div>
              </div>
            </div>
          )}

          {leaks.length === 0 ? (
            <div className="p-8 text-center text-stone-500 border border-dashed rounded-md"
                 data-testid="admin-website-profile-audit-empty">
              <CheckCircle2 className="mx-auto h-6 w-6 text-emerald-500 mb-2" />
              No leaks found. All franchisees&apos; public profiles look clean.
            </div>
          ) : (
            <div className="overflow-x-auto border rounded-lg bg-white">
              <table className="w-full text-sm">
                <thead className="bg-stone-50 text-stone-600 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Franchisee</th>
                    <th className="text-left px-3 py-2 font-medium">Field</th>
                    <th className="text-left px-3 py-2 font-medium">Leaked value</th>
                    <th className="text-left px-3 py-2 font-medium">Actually belongs to</th>
                    <th className="text-left px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {leaks.map((l, i) => (
                    <tr key={i} className="border-t border-stone-100" data-testid={`leak-row-${i}`}>
                      <td className="px-3 py-2">
                        <div className="font-medium text-stone-900">{l.franchisee.name}</div>
                        <div className="text-xs text-stone-500">#{l.franchisee.franchise_number}</div>
                      </td>
                      <td className="px-3 py-2 text-stone-700">{l.field}</td>
                      <td className="px-3 py-2 font-mono text-xs">{l.leaked_value}</td>
                      <td className="px-3 py-2">
                        <div className="text-stone-800">{l.belongs_to.name}</div>
                        <div className="text-xs text-stone-500">#{l.belongs_to.franchise_number}</div>
                      </td>
                      <td className="px-3 py-2">
                        {l.is_published ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs border font-medium bg-red-50 text-red-800 border-red-300">
                            Visible on map
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs border font-medium bg-stone-50 text-stone-600 border-stone-200">
                            Latent
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {showRaw && (
            <pre className="mt-6 p-4 bg-stone-900 text-stone-100 rounded-md text-xs overflow-auto max-h-96"
                 data-testid="admin-website-profile-audit-raw">
              {JSON.stringify(report, null, 2)}
            </pre>
          )}

          <div className="mt-8 p-4 bg-blue-50 border border-blue-200 rounded-md text-xs text-blue-900">
            <p className="font-semibold mb-1">How the suppress action works</p>
            <ul className="list-disc pl-5 space-y-0.5">
              <li>Only currently-visible (published) leaks are affected — latent leaks stay as-is.</li>
              <li>For each affected franchisee, only <code>show_website_email</code> or <code>show_website_phone</code> is set to <code>false</code>.</li>
              <li>The underlying <code>website_email</code> / <code>website_phone</code> value is <strong>preserved</strong> so HQ can inspect it later.</li>
              <li>No other franchisee field is touched. No CRM, notes, or CQC data is touched.</li>
              <li>Every action is written to the <code>website_profile_audit_log</code> collection with an actor + timestamp.</li>
            </ul>
          </div>
        </>
      )}

      {confirmOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" data-testid="admin-website-profile-audit-confirm-modal">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-6 h-6 text-red-600 mt-0.5 shrink-0" />
              <div>
                <h3 className="font-semibold text-lg mb-1">Suppress {published.length} published leak{published.length === 1 ? "" : "s"}?</h3>
                <p className="text-sm text-stone-600">
                  Each affected franchisee&apos;s <code>show_website_email</code> or <code>show_website_phone</code> flag will be set to false. The underlying values are preserved. This is fully reversible — franchisees can re-tick the flag from their <em>My Franchise</em> page once you&apos;ve confirmed the correct email/phone.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setConfirmOpen(false)} disabled={clearing}
                      className="px-4 py-1.5 text-sm border rounded-md bg-white hover:bg-stone-50"
                      data-testid="admin-website-profile-audit-confirm-cancel">Cancel</button>
              <button onClick={clearLeaks} disabled={clearing}
                      className="inline-flex items-center gap-2 px-4 py-1.5 text-sm border rounded-md bg-red-600 text-white border-red-600 hover:bg-red-700 disabled:opacity-50"
                      data-testid="admin-website-profile-audit-confirm-run">
                {clearing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
                Suppress all published leaks
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, tone }) {
  const toneClass = {
    ok:     "bg-emerald-50 border-emerald-200 text-emerald-900",
    warn:   "bg-amber-50 border-amber-200 text-amber-900",
    danger: "bg-red-50 border-red-200 text-red-900",
  }[tone] || "bg-white border-stone-200 text-stone-900";
  return (
    <div className={`border rounded-lg px-3 py-3 ${toneClass}`}>
      <div className="text-xs uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-2xl font-bold tabular-nums">{value ?? "—"}</div>
    </div>
  );
}
