import { useEffect, useState } from "react";
import api from "@/lib/api";
import { Download, Eye, EyeOff, Copy, Check, ExternalLink, AlertCircle, Inbox, Activity } from "lucide-react";

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
