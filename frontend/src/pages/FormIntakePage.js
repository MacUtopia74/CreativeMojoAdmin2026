import { useEffect, useState } from "react";
import api from "@/lib/api";
import { Download, Eye, EyeOff, Copy, Check, ExternalLink, AlertCircle, Inbox, Activity, RefreshCw, Archive, Stethoscope } from "lucide-react";

function Panel({ icon: Icon, title, action, children, testid }) {
  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid={testid}>
      <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="w-3.5 h-3.5 text-stone-500" />}
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">{title}</div>
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function CopyButton({ value, testid }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) { /* noop */ }
  };
  return (
    <button onClick={copy} data-testid={testid} className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider border border-stone-300 bg-white hover:bg-stone-50 flex items-center gap-1 rounded-md">
      {copied ? <><Check className="w-3 h-3 text-emerald-600" /> Copied</> : <><Copy className="w-3 h-3" /> Copy</>}
    </button>
  );
}

export default function FormIntakePage() {
  const [config, setConfig] = useState(null);
  const [recent, setRecent] = useState([]);
  const [error, setError] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busyAction, setBusyAction] = useState("");        // "refresh" | "dormant" | "diagnose"
  const [actionResult, setActionResult] = useState(null);  // last operation summary
  const [diagnoseFormId, setDiagnoseFormId] = useState(33);

  const refresh = async () => {
    try {
      const { data } = await api.get("/intake/config");
      setConfig(data);
    } catch (e) { setError("Could not load intake config."); }
    try {
      const { data } = await api.get("/intake/recent", { params: { limit: 20 } });
      setRecent(data.items || []);
    } catch (e) { /* noop */ }
  };

  useEffect(() => { refresh(); const i = setInterval(refresh, 15000); return () => clearInterval(i); }, []);

  const downloadPlugin = async () => {
    try {
      const resp = await api.get("/intake/download-plugin", { responseType: "blob" });
      const url = URL.createObjectURL(resp.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = "creative-mojo-intake.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError("Could not download plugin ZIP.");
    }
  };

  const sourceLabel = (s) => ({
    general_enquiry: "General",
    franchise_enquiry: "Franchise",
    licence_enquiry: "Licence",
  }[s] || s || "Other");

  const runMaintenance = async (kind) => {
    setBusyAction(kind);
    setActionResult(null);
    setError("");
    try {
      let resp;
      if (kind === "refresh") {
        resp = await api.post("/intake/backfill/run", null, { params: { limit: 50, repair: true } });
        const errs = resp.data.errors || [];
        const traces = resp.data.traces || [];
        const formIds = resp.data.form_ids_used || [];
        const errSuffix = errs.length ? ` ⚠️ ${errs.length} error(s) — see details.` : "";
        const byOutcome = traces.reduce((acc, t) => {
          acc[t.outcome] = (acc[t.outcome] || 0) + 1;
          return acc;
        }, {});
        const outcomeLine = Object.keys(byOutcome).length
          ? ` Per-entry: ${Object.entries(byOutcome).map(([k, v]) => `${k}=${v}`).join(", ")}.`
          : "";
        const formsLine = formIds.length ? ` Forms pulled: [${formIds.join(", ")}].` : "";
        setActionResult({ kind, ok: errs.length === 0, summary:
          `Pulled ${resp.data.checked || 0} entries from Gravity Forms.${formsLine} ${resp.data.inserted || 0} new, ${resp.data.updated || 0} repaired/promoted.${outcomeLine}${errSuffix}`,
          raw: { entries: traces.concat(errs.map((e, i) => ({ idx: i, error: e }))) }});
      } else if (kind === "dormant") {
        if (!window.confirm("Move all 'Contacted' leads that haven't been touched in 60 days into 'Dormant'? This is safe — only changes the stage, no data deleted.")) {
          setBusyAction(""); return;
        }
        resp = await api.post("/intake/backfill/contacted-to-dormant", null, { params: { cutoff_days: 60 } });
        setActionResult({ kind, ok: true, summary:
          `Moved ${(resp.data.web_moved || 0) + (resp.data.legacy_moved || 0)} stale 'Contacted' leads into 'Dormant'.` });
      } else if (kind === "cleanup_bad_promo") {
        if (!window.confirm("Remove any non-franchise / non-licence rows that got wrongly pulled into the NEW column? Reversible.")) {
          setBusyAction(""); return;
        }
        resp = await api.post("/intake/backfill/undo-bad-art-kit-promotion");
        setActionResult({ kind, ok: true, summary:
          `Removed ${resp.data.moved_out_of_new || 0} non-pipeline rows from the NEW column.` });
      } else if (kind === "diagnose") {
        resp = await api.get(`/intake/backfill/diagnose/${diagnoseFormId}`, { params: { limit: 20 } });
        const d = resp.data;
        if (!d.ok) {
          setActionResult({ kind, ok: false, summary: d.error || d.diagnosis || "Diagnostic failed.", raw: d });
        } else if (d.wp_entries === 0) {
          setActionResult({ kind, ok: false, summary:
            `Form ${diagnoseFormId} has ZERO submissions on the WP side. Either the form has no entries yet, or the form_id is wrong.`, raw: d });
        } else {
          const s = d.summary || {};
          setActionResult({ kind, ok: true, summary:
            `Form ${diagnoseFormId}: ${d.wp_entries} entries on WP — ${s.would_insert || 0} would insert, ${s.already_in_db || 0} already in DB, ${s.duplicate_email_would_promote || 0} duplicate-email (would promote to NEW), ${s.duplicate_email_already_in_pipeline || 0} duplicate-email (already in pipeline), ${s.skip_spam_filter || 0} filtered as spam, ${s.skip_tombstoned || 0} tombstoned.`, raw: d });
        }
      }
      // refresh recent feed after a maintenance op
      try { const { data } = await api.get("/intake/recent", { params: { limit: 20 } }); setRecent(data.items || []); } catch (e) {/* noop */}
    } catch (e) {
      setError(`Maintenance failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setBusyAction("");
    }
  };

  return (
    <div className="min-h-screen">
      <div className="h-16 border-b border-stone-200 bg-white flex items-center px-8 sticky top-0 z-10" data-testid="topbar">
        <div className="flex items-baseline gap-3 flex-1">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">CRM · Intake</div>
          <h1 className="font-display text-xl text-stone-950">Form Intake</h1>
        </div>
        <button onClick={downloadPlugin} data-testid="download-plugin-button"
          className="px-4 py-2 bg-stone-950 text-white text-xs font-bold uppercase tracking-wider hover:bg-stone-800 transition-colors flex items-center gap-2 rounded-lg">
          <Download className="w-3.5 h-3.5" /> Download WordPress Plugin
        </button>
      </div>

      <div className="p-8 space-y-6 max-w-[1300px]">
        {error && <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2 rounded-xl"><AlertCircle className="w-4 h-4" />{error}</div>}

        {/* Intro */}
        <Panel title="What this does" testid="panel-intro">
          <p className="text-sm text-stone-700 leading-relaxed">
            This page replaces your Zapier setup. A free WordPress plugin (download above) listens for Gravity Forms submissions on creativemojo.com and posts them straight into this CRM. No third-party services, no monthly fees, no Zap limits.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-stone-200 border border-stone-200 mt-5 rounded-xl overflow-hidden">
            {config?.form_mapping?.map((f) => (
              <div key={f.form_id} className="bg-white p-4">
                <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Form ID {f.form_id}</div>
                <div className="text-sm font-semibold text-stone-950 mt-1">{f.name}</div>
                <div className="text-xs text-stone-600 mt-1">→ tagged <code className="bg-stone-100 px-1">{f.source_tag}</code></div>
              </div>
            ))}
          </div>
        </Panel>

        {/* Credentials */}
        <Panel title="Plugin Configuration" testid="panel-credentials">
          <div className="space-y-5">
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1.5">Endpoint URL</div>
              <div className="flex items-center gap-2">
                <input readOnly value={config?.endpoint_url || ""} data-testid="endpoint-url-input"
                  className="flex-1 px-3 py-2 bg-stone-50 border border-stone-200 text-sm tabular-nums rounded-lg" />
                <CopyButton value={config?.endpoint_url || ""} testid="copy-endpoint" />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Intake Token <span className="text-red-600">(treat like a password)</span></div>
                <button onClick={() => setShowToken(!showToken)} data-testid="toggle-token-visibility" className="text-xs text-stone-600 hover:text-stone-950 flex items-center gap-1">
                  {showToken ? <><EyeOff className="w-3 h-3" /> Hide</> : <><Eye className="w-3 h-3" /> Show</>}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <input readOnly type={showToken ? "text" : "password"} value={config?.intake_token || ""} data-testid="intake-token-input"
                  className="flex-1 px-3 py-2 bg-stone-50 border border-stone-200 text-sm tabular-nums rounded-lg" />
                <CopyButton value={config?.intake_token || ""} testid="copy-token" />
              </div>
            </div>
          </div>
        </Panel>

        {/* Install steps */}
        <Panel title="5-Minute Install" testid="panel-install">
          <ol className="space-y-4">
            {[
              { t: "Download the plugin", d: <>Click the <strong>Download WordPress Plugin</strong> button (top right). You'll get <code className="bg-stone-100 px-1">creative-mojo-intake.zip</code>.</> },
              { t: "Upload to WordPress", d: <>In WordPress admin: <strong>Plugins → Add New → Upload Plugin → Choose File → Install Now → Activate</strong>.</> },
              { t: "Open the settings page", d: <>In WordPress admin: <strong>Settings → Creative Mojo Intake</strong>.</> },
              { t: "Paste the Endpoint URL and Intake Token", d: <>Both shown in the panel above. Copy buttons next to each. Save settings.</> },
              { t: "Test it", d: <>Submit a test entry on the Franchise Enquiry form. Within seconds it should appear in the "Recent Submissions" feed below and on the <a href="/contacts" className="text-stone-950 underline">Enquiries page</a>.</> },
              { t: "(Optional) Turn off the old Zapier Zap", d: <>Once you've seen a few live submissions land successfully, deactivate the Zap pointing to Airtable. You can keep it for a few weeks as a safety net if you prefer.</> },
            ].map((step, i) => (
              <li key={step.t} className="flex items-start gap-3">
                <div className="w-6 h-6 bg-[#dddd16] flex items-center justify-center text-xs font-bold text-stone-950 shrink-0 rounded-lg">{i + 1}</div>
                <div>
                  <div className="text-sm font-semibold text-stone-950">{step.t}</div>
                  <div className="text-sm text-stone-600 mt-0.5 leading-relaxed">{step.d}</div>
                </div>
              </li>
            ))}
          </ol>
        </Panel>

        {/* Maintenance — manual triggers for the GF backfill, stale-lead cleanup, and per-form diagnostic */}
        <Panel icon={Activity} title="Pipeline Maintenance" testid="panel-maintenance">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <button
              onClick={() => runMaintenance("refresh")}
              disabled={!!busyAction}
              data-testid="btn-backfill-refresh"
              className="text-left p-4 border border-stone-200 rounded-xl bg-white hover:border-stone-400 hover:bg-stone-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
              <div className="flex items-center gap-2 text-stone-950 mb-2">
                <RefreshCw className={`w-3.5 h-3.5 ${busyAction === "refresh" ? "animate-spin" : ""}`} />
                <span className="text-[10px] uppercase tracking-[0.2em] font-bold">Refresh from Gravity Forms</span>
              </div>
              <div className="text-xs text-stone-600 leading-relaxed">
                Pull the most recent 50 entries per pipeline form (17, 32, 33) and ingest anything missed by the live webhook. Safe to run any time.
              </div>
            </button>

            <button
              onClick={() => runMaintenance("dormant")}
              disabled={!!busyAction}
              data-testid="btn-contacted-to-dormant"
              className="text-left p-4 border border-stone-200 rounded-xl bg-white hover:border-stone-400 hover:bg-stone-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
              <div className="flex items-center gap-2 text-stone-950 mb-2">
                <Archive className={`w-3.5 h-3.5 ${busyAction === "dormant" ? "animate-pulse" : ""}`} />
                <span className="text-[10px] uppercase tracking-[0.2em] font-bold">Archive Contacted &gt; 60d → Dormant</span>
              </div>
              <div className="text-xs text-stone-600 leading-relaxed">
                Move any {String.fromCharCode(8220)}Contacted{String.fromCharCode(8221)} lead that hasn{String.fromCharCode(8217)}t been touched in 60 days into the {String.fromCharCode(8220)}Dormant{String.fromCharCode(8221)} stage. Reversible — only changes the stage label.
              </div>
            </button>

            <button
              onClick={() => runMaintenance("cleanup_bad_promo")}
              disabled={!!busyAction}
              data-testid="btn-cleanup-bad-promo"
              className="text-left p-4 border border-red-200 rounded-xl bg-red-50/40 hover:border-red-400 hover:bg-red-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
              <div className="flex items-center gap-2 text-red-900 mb-2">
                <AlertCircle className={`w-3.5 h-3.5 ${busyAction === "cleanup_bad_promo" ? "animate-pulse" : ""}`} />
                <span className="text-[10px] uppercase tracking-[0.2em] font-bold">Remove non-pipeline rows from NEW</span>
              </div>
              <div className="text-xs text-red-700 leading-relaxed">
                Cleanup for the v24.2 over-promotion bug. Removes any art-kit / care-home / general rows that got wrongly pulled into NEW. Safe — only changes the stage.
              </div>
            </button>

            <div className="p-4 border border-stone-200 rounded-xl bg-white">
              <div className="flex items-center gap-2 text-stone-950 mb-2">
                <Stethoscope className="w-3.5 h-3.5" />
                <span className="text-[10px] uppercase tracking-[0.2em] font-bold">Diagnose a Form</span>
              </div>
              <div className="text-xs text-stone-600 leading-relaxed mb-3">
                Show the latest 20 entries that Gravity Forms reports for a specific form, and whether each would be inserted, skipped, or already exists in the CRM.
              </div>
              <div className="flex gap-2">
                <input
                  type="number"
                  value={diagnoseFormId}
                  onChange={(e) => setDiagnoseFormId(Number(e.target.value) || 0)}
                  data-testid="input-diagnose-form-id"
                  className="w-20 px-2 py-1.5 text-sm border border-stone-300 rounded-md tabular-nums"
                  placeholder="Form ID" />
                <button
                  onClick={() => runMaintenance("diagnose")}
                  disabled={!!busyAction || !diagnoseFormId}
                  data-testid="btn-diagnose-form"
                  className="flex-1 px-3 py-1.5 bg-stone-950 text-white text-xs font-bold uppercase tracking-wider rounded-md hover:bg-stone-800 disabled:opacity-50">
                  {busyAction === "diagnose" ? "Diagnosing…" : "Diagnose"}
                </button>
              </div>
            </div>
          </div>

          {actionResult && (
            <div className={`mt-4 px-4 py-3 rounded-xl text-sm border ${actionResult.ok ? "bg-emerald-50 border-emerald-200 text-emerald-900" : "bg-red-50 border-red-200 text-red-900"}`}
              data-testid="maintenance-result">
              <div className="font-semibold mb-1">{actionResult.ok ? "Done" : "Result"}</div>
              <div>{actionResult.summary}</div>
              {actionResult.raw?.entries && actionResult.raw.entries.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-bold uppercase tracking-wider">Show entries ({actionResult.raw.entries.length})</summary>
                  <pre className="mt-2 p-2 bg-white border border-stone-200 rounded text-[11px] overflow-auto max-h-80">
{JSON.stringify(actionResult.raw.entries, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          )}
        </Panel>

        {/* Recent submissions */}
        <Panel icon={Inbox} title={`Recent Submissions${recent.length ? ` (${recent.length})` : ""}`} action={
          <div className="flex items-center gap-1.5 text-xs text-stone-500">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live · refreshes every 15s
          </div>
        } testid="panel-recent">
          {recent.length === 0 ? (
            <div className="text-center py-8 text-stone-500">
              <Activity className="w-8 h-8 mx-auto text-stone-300 mb-2" />
              <div className="text-sm">No submissions received yet.</div>
              <div className="text-xs mt-1">Once the plugin is installed and a form is submitted, entries will appear here in real-time.</div>
            </div>
          ) : (
            <table className="w-full" data-testid="recent-table">
              <thead className="border-b border-stone-200">
                <tr>
                  <th className="text-left px-0 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-44">Received</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-28">Source</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Name</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Contact</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-28">Form ID</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className="border-b border-stone-100 last:border-0 hover:bg-stone-50">
                    <td className="px-0 py-2 text-xs text-stone-600 tabular-nums">{r.received_at ? new Date(r.received_at).toLocaleString("en-GB") : "—"}</td>
                    <td className="px-3 py-2">
                      <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-stone-100 text-stone-700 border border-stone-200 rounded-md">
                        {sourceLabel(r.source)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-sm text-stone-900 font-semibold">{[r.first_name, r.last_name].filter(Boolean).join(" ") || "(no name)"}</td>
                    <td className="px-3 py-2 text-xs text-stone-600">
                      <div>{r.email || "—"}</div>
                      <div className="text-stone-400">{r.telephone || ""}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-stone-700 tabular-nums">#{r.form_id || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
