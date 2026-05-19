// Admin → "Find a Class" page
//
// Three jobs:
//   1. Live preview of the public lookup (admin can sanity-check a postcode
//      without leaving the console).
//   2. Analytics — how many searches, hits vs misses, top postcodes
//      visitors are searching for that we DON'T cover (territory expansion
//      signal).
//   3. Embed code + HQ fallback editor — everything the admin needs to
//      manage the public Find-a-Class on creativemojo.com.
import { useEffect, useState } from "react";
import api from "@/lib/api";
import {
  Search, Loader2, Code, AlertCircle, CheckCircle2, MapPin, Phone, Mail,
  Save, Copy, Info, ExternalLink, TrendingDown, TrendingUp,
} from "lucide-react";

export default function FindClassAdminPage() {
  const [tab, setTab] = useState("overview");
  return (
    <div className="min-h-screen">
      <div className="h-16 border-b border-stone-200 bg-white flex items-center px-8 sticky top-0 z-10">
        <div className="flex items-baseline gap-3 flex-1">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">Public site</div>
          <h1 className="font-display text-xl text-stone-950">Find a Class</h1>
        </div>
        <div className="flex bg-stone-100 rounded-lg p-0.5" data-testid="findclass-tabs">
          {[
            ["overview", "Overview"],
            ["preview", "Live preview"],
            ["hq", "HQ fallback"],
            ["embed", "Embed code"],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              data-testid={`findclass-tab-${id}`}
              className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded-md transition ${
                tab === id ? "bg-stone-950 text-white" : "text-stone-600 hover:text-stone-950"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="p-8 max-w-[1500px] space-y-6">
        {tab === "overview" && <Overview />}
        {tab === "preview" && <LivePreview />}
        {tab === "hq" && <HQFallback />}
        {tab === "embed" && <Embed />}
      </div>
    </div>
  );
}

// =================== Overview =============================================
function Overview() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/find-class/analytics");
        setData(data);
      } finally { setLoading(false); }
    })();
  }, []);
  if (loading) {
    return <Loader2 className="w-5 h-5 animate-spin text-stone-400" />;
  }
  if (!data) return null;
  const t = data.totals;
  const pct = (n) => `${Math.round(n * 100)}%`;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" data-testid="findclass-totals">
        <Stat label="Searches · last 7 days" value={t.last_7_days} testid="stat-7" />
        <Stat label="Searches · last 30 days" value={t.last_30_days} testid="stat-30" />
        <Stat
          label="Miss rate · 7d"
          value={pct(t.miss_rate_7)}
          sub={`${t.misses_7_days} of ${t.last_7_days} unmatched`}
          tone={t.miss_rate_7 > 0.2 ? "warn" : "ok"}
          icon={t.miss_rate_7 > 0.2 ? TrendingUp : TrendingDown}
          testid="stat-miss7"
        />
        <Stat
          label="Miss rate · 30d"
          value={pct(t.miss_rate_30)}
          sub={`${t.misses_30_days} of ${t.last_30_days} unmatched`}
          tone={t.miss_rate_30 > 0.2 ? "warn" : "ok"}
          icon={t.miss_rate_30 > 0.2 ? TrendingUp : TrendingDown}
          testid="stat-miss30"
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="bg-white border border-stone-200 rounded-2xl p-5" data-testid="findclass-misses">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 mb-1">Top missed sectors · 30d</div>
          <p className="text-xs text-stone-500 mb-3">Postcodes visitors searched where we have no coverage. Strong signal for territory expansion.</p>
          {!data.top_missed_sectors.length && (
            <div className="text-sm text-stone-500 italic">No misses in the last 30 days. 🎉</div>
          )}
          <ul className="space-y-1.5">
            {data.top_missed_sectors.map((m) => (
              <li key={m.sector} className="flex items-center justify-between text-sm">
                <span className="font-mono font-bold text-stone-800">{m.sector}</span>
                <span className="tabular-nums text-stone-600">{m.count} searches</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="bg-white border border-stone-200 rounded-2xl p-5" data-testid="findclass-hits">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 mb-1">Most-found franchisees · 30d</div>
          <p className="text-xs text-stone-500 mb-3">Public traffic landing on each franchisee's territory.</p>
          {!data.top_hit_areas.length && (
            <div className="text-sm text-stone-500 italic">No hits yet.</div>
          )}
          <ul className="space-y-1.5">
            {data.top_hit_areas.map((m) => (
              <li key={m.area} className="flex items-center justify-between text-sm gap-2">
                <span className="text-stone-800 truncate">{m.area || "(no area name)"}</span>
                <span className="tabular-nums text-stone-600 shrink-0">{m.count}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="bg-white border border-stone-200 rounded-2xl p-5" data-testid="findclass-recent">
        <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 mb-3">Recent lookups</div>
        {!data.recent.length && <div className="text-sm text-stone-500 italic">No lookups yet.</div>}
        <table className="w-full text-sm">
          <thead className="text-[10px] uppercase tracking-wider text-stone-500">
            <tr>
              <th className="text-left py-1.5">Postcode</th>
              <th className="text-left py-1.5">Result</th>
              <th className="text-left py-1.5">Franchisee</th>
              <th className="text-right py-1.5">When</th>
            </tr>
          </thead>
          <tbody>
            {data.recent.map((r, i) => (
              <tr key={i} className="border-t border-stone-100">
                <td className="py-1.5 font-mono">{r.postcode}</td>
                <td className="py-1.5">
                  {r.match
                    ? <span className="text-[10px] font-bold uppercase tracking-wider bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded">Match</span>
                    : <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-50 text-amber-700 px-2 py-0.5 rounded">No match</span>}
                </td>
                <td className="py-1.5 text-stone-700 truncate max-w-[420px]">{r.franchisee_name || "—"}</td>
                <td className="py-1.5 text-right text-stone-500 tabular-nums">{new Date(r.ts).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone, icon: Icon, testid }) {
  const toneCls = tone === "warn"
    ? "border-amber-300 bg-amber-50/40"
    : tone === "ok"
      ? "border-emerald-300 bg-emerald-50/40"
      : "border-stone-200 bg-white";
  return (
    <div className={`border rounded-2xl p-4 ${toneCls}`} data-testid={testid}>
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">{label}</div>
        {Icon && <Icon className="w-3.5 h-3.5 text-stone-500" />}
      </div>
      <div className="font-display text-3xl text-stone-950 tabular-nums mt-1">{value}</div>
      {sub && <div className="text-[11px] text-stone-500 mt-1">{sub}</div>}
    </div>
  );
}

// =================== Live preview ========================================
function LivePreview() {
  const [postcode, setPostcode] = useState("RG1 2DG");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const search = async () => {
    setLoading(true); setErr(""); setResult(null);
    try {
      const { data } = await api.get(`/public/find-class?postcode=${encodeURIComponent(postcode)}`);
      setResult(data);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Lookup failed");
    } finally { setLoading(false); }
  };
  return (
    <div className="bg-white border border-stone-200 rounded-2xl p-6 max-w-3xl">
      <p className="text-sm text-stone-600 mb-4">Test the public lookup with any UK postcode. This calls the same endpoint as the live site.</p>
      <div className="flex gap-2 mb-4">
        <input
          value={postcode}
          onChange={(e) => setPostcode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          data-testid="preview-postcode"
          placeholder="e.g. RG1 2DG"
          className="flex-1 px-4 py-2 border border-stone-300 rounded-lg text-sm font-mono"
        />
        <button
          onClick={search}
          data-testid="preview-go"
          disabled={loading}
          className="px-4 py-2 bg-stone-950 text-white text-xs font-bold uppercase tracking-wider rounded-lg disabled:opacity-50 flex items-center gap-1.5"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          Look up
        </button>
      </div>
      {err && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-center gap-1.5">
          <AlertCircle className="w-4 h-4" /> {err}
        </div>
      )}
      {result && (
        <div className="border border-stone-200 rounded-xl p-4 space-y-2" data-testid="preview-result">
          <div className="flex items-center gap-2">
            {result.match
              ? <span className="text-[10px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded">Match</span>
              : <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-700 px-2 py-0.5 rounded">No match</span>}
            <span className="text-xs text-stone-500 font-mono">{result.postcode} · {result.sector}</span>
          </div>
          {result.pin && (
            <div className="text-xs text-stone-700 flex items-center gap-1.5">
              <MapPin className="w-3 h-3" /> {result.pin.lat.toFixed(4)}, {result.pin.lng.toFixed(4)}
            </div>
          )}
          {result.franchisee && (
            <div className="border-t border-stone-100 pt-3 mt-3 grid grid-cols-[100px_1fr] gap-3">
              {result.franchisee.photo_url && (
                <img src={result.franchisee.photo_url} alt="" className="w-24 h-24 object-cover rounded-md" />
              )}
              <div className="space-y-0.5 text-sm">
                <div className="font-bold text-stone-950">{result.franchisee.area}</div>
                <div className="text-pink-700 font-bold">{result.franchisee.name}</div>
                {result.franchisee.phone && <div className="text-pink-700 flex items-center gap-1.5"><Phone className="w-3 h-3" /> {result.franchisee.phone}</div>}
                {result.franchisee.email && <div className="text-pink-700 flex items-center gap-1.5"><Mail className="w-3 h-3" /> {result.franchisee.email}</div>}
                {result.franchisee.wp_page_url && (
                  <div className="mt-1">
                    <a href={result.franchisee.wp_page_url} target="_blank" rel="noopener noreferrer"
                       className="text-xs text-pink-700 hover:underline flex items-center gap-1">
                      <ExternalLink className="w-3 h-3" /> Visit page
                    </a>
                  </div>
                )}
              </div>
            </div>
          )}
          {result.fallback && (
            <div className="border-t border-stone-100 pt-3 mt-3 text-sm">
              <div className="text-stone-700 mb-2">{result.fallback.message}</div>
              <div className="font-bold text-pink-700">{result.fallback.name}</div>
              {result.fallback.phone && <div className="text-pink-700">{result.fallback.phone}</div>}
              {result.fallback.email && <div className="text-pink-700">{result.fallback.email}</div>}
            </div>
          )}
          {result.territory && (
            <div className="text-[11px] text-stone-500 border-t border-stone-100 pt-2">
              Territory polygon returned · {result.territory.properties?.sector_count || "?"} sectors · {result.territory.geometry?.type}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =================== HQ fallback editor ===================================
function HQFallback() {
  const [hq, setHq] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    (async () => {
      const { data } = await api.get("/find-class/hq");
      setHq(data);
    })();
  }, []);
  const save = async () => {
    setSaving(true); setErr(""); setSaved(false);
    try {
      const { data } = await api.put("/find-class/hq", hq);
      setHq(data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Save failed");
    } finally { setSaving(false); }
  };
  if (!hq) return <Loader2 className="w-5 h-5 animate-spin text-stone-400" />;
  return (
    <div className="bg-white border border-stone-200 rounded-2xl p-6 max-w-3xl">
      <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 mb-1">HQ Fallback Contact</div>
      <p className="text-sm text-stone-600 mb-5">Shown on the public site when a visitor's postcode is outside every active franchise territory. This is exactly the popup that appears today on creativemojo.com.</p>
      <div className="space-y-4">
        {[
          ["name", "Name"],
          ["phone", "Phone"],
          ["email", "Email"],
          ["wp_page_url", "Visit Page URL"],
          ["photo_url", "Photo URL (optional)"],
        ].map(([k, label]) => (
          <Field key={k} label={label} value={hq[k] || ""} onChange={(v) => setHq({ ...hq, [k]: v })} testid={`hq-${k}`} />
        ))}
        <div>
          <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">Message shown above contact details</label>
          <textarea
            rows={3}
            value={hq.message || ""}
            onChange={(e) => setHq({ ...hq, message: e.target.value })}
            data-testid="hq-message"
            className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
          />
        </div>
        {err && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-center gap-1.5"><AlertCircle className="w-4 h-4" /> {err}</div>}
        {saved && <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded-lg flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" /> Saved.</div>}
        <button
          onClick={save}
          disabled={saving}
          data-testid="hq-save"
          className="px-4 py-2 bg-stone-950 text-white text-xs font-bold uppercase tracking-wider rounded-lg flex items-center gap-1.5 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Save HQ fallback
        </button>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, testid }) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testid}
        className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
      />
    </div>
  );
}

// =================== Embed code ==========================================
function Embed() {
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/find-class/embed.html", { responseType: "text" });
        setCode(typeof data === "string" ? data : JSON.stringify(data));
      } catch (e) {
        setErr(e?.response?.data?.detail || "Could not load embed code");
      }
    })();
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {/* ignore */}
  };
  return (
    <div className="space-y-4 max-w-5xl">
      <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5">
        <div className="flex items-start gap-3">
          <Info className="w-5 h-5 text-blue-700 shrink-0 mt-0.5" />
          <div className="text-sm text-blue-900 space-y-2">
            <div className="font-bold">How to deploy this on creativemojo.com</div>
            <ol className="list-decimal pl-5 space-y-1">
              <li>Edit the <em>Find a Class</em> page on WordPress.</li>
              <li>Delete the existing search form / map block.</li>
              <li>Add a <strong>Custom HTML</strong> block.</li>
              <li>Paste the code below in.</li>
              <li>Update the two values at the top: <code className="font-mono text-xs bg-white px-1.5 py-0.5 rounded">API_BASE</code> (already pointing at this admin) and <code className="font-mono text-xs bg-white px-1.5 py-0.5 rounded">MAPBOX_TOKEN</code> (a public <code>pk.*</code> token for the WP site).</li>
              <li>Preview → search a postcode → publish.</li>
            </ol>
          </div>
        </div>
      </div>
      {err && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg flex items-center gap-1.5">
          <AlertCircle className="w-4 h-4" /> {err}
        </div>
      )}
      <div className="border border-stone-300 rounded-2xl overflow-hidden">
        <div className="bg-stone-100 border-b border-stone-200 px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-bold text-stone-700">
            <Code className="w-3.5 h-3.5" /> WordPress embed · find_class_embed.html
          </div>
          <button
            onClick={copy}
            data-testid="embed-copy"
            className="px-3 py-1 bg-stone-950 text-white text-[11px] font-bold uppercase tracking-wider rounded flex items-center gap-1.5"
          >
            <Copy className="w-3 h-3" />
            {copied ? "Copied" : "Copy code"}
          </button>
        </div>
        <pre className="text-[11px] leading-relaxed bg-stone-50 p-4 max-h-[60vh] overflow-auto font-mono text-stone-800" data-testid="embed-code">
{code}
        </pre>
      </div>
    </div>
  );
}
