// Admin tool: define which CQC locations count as "your kind of home".
// All territory home counts in the system re-derive from this rule.
//
// Layout:
//   - Sync banner (status + "Run sync now" button)
//   - 4 multi-select chip groups: Service Types | Specialisms |
//     Regulated Activities | Region (latter informational)
//   - Care-home Y/N toggle, min beds, required ratings
//   - Live preview panel: count + breakdown by region + sample homes
//   - Save button (PUT /cqc/definition → triggers franchisee home-count
//     refresh on the backend)
import { useEffect, useMemo, useState, useCallback } from "react";
import api from "@/lib/api";
import {
  Loader2, Save, RefreshCw, Target, Plus, X, AlertCircle,
  CheckCircle2, RotateCcw, MapPin, Building2, Stethoscope,
} from "lucide-react";

const empty = {
  include_service_types: [],
  exclude_service_types: [],
  include_specialisms: [],
  exclude_specialisms: [],
  include_regulated_activities: [],
  require_care_home: null,
  registration_statuses: ["Registered"],
  min_beds: null,
  require_rating: [],
};

const RATING_OPTIONS = ["Outstanding", "Good", "Requires improvement", "Inadequate"];

export default function CqcDefinitionsPage() {
  const [def, setDef] = useState(empty);
  const [saved, setSaved] = useState(empty);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [sync, setSync] = useState(null);

  // Distinct facet values + frequencies
  const [serviceTypes, setServiceTypes] = useState([]);
  const [specialisms, setSpecialisms] = useState([]);
  const [activities, setActivities] = useState([]);

  // Load definition + facets + sync state
  useEffect(() => {
    (async () => {
      try {
        const [d, s, st, sp, ra] = await Promise.all([
          api.get("/cqc/definition"),
          api.get("/cqc/sync/status"),
          api.get("/cqc/distinct", { params: { field: "gacServiceTypes.name" } }),
          api.get("/cqc/distinct", { params: { field: "specialisms.name" } }),
          api.get("/cqc/distinct", { params: { field: "regulatedActivities.name" } }),
        ]);
        setDef(d.data);
        setSaved(d.data);
        setSync(s.data);
        setServiceTypes(st.data.values || []);
        setSpecialisms(sp.data.values || []);
        setActivities(ra.data.values || []);
      } catch (e) {
        setErr(e?.response?.data?.detail || "Could not load");
      } finally { setBusy(false); }
    })();
  }, []);

  // Live preview (debounced) — translates the rule to query params. Empty
  // values are stripped so FastAPI's int/str coercion doesn't 422 on
  // `min_beds=` etc., which previously made the count silently stick at 0.
  const previewParams = useMemo(() => {
    const raw = {
      include_service_types: def.include_service_types.join(","),
      exclude_service_types: def.exclude_service_types.join(","),
      include_specialisms: def.include_specialisms.join(","),
      exclude_specialisms: def.exclude_specialisms.join(","),
      include_regulated_activities: def.include_regulated_activities.join(","),
      require_care_home: def.require_care_home || "",
      registration_statuses: (def.registration_statuses || []).join(","),
      min_beds: def.min_beds || "",
      require_rating: (def.require_rating || []).join(","),
    };
    return Object.fromEntries(
      Object.entries(raw).filter(([, v]) => v !== "" && v != null),
    );
  }, [def]);

  const refreshPreview = useCallback(async () => {
    setPreviewing(true);
    try {
      const { data } = await api.get("/cqc/definition/preview", { params: previewParams });
      setPreview(data);
    } catch (e) {
      setPreview({ error: e?.response?.data?.detail || "Preview failed" });
    } finally { setPreviewing(false); }
  }, [previewParams]);
  useEffect(() => {
    const t = setTimeout(refreshPreview, 350);
    return () => clearTimeout(t);
  }, [refreshPreview]);

  // Sync state poller
  useEffect(() => {
    if (!sync?.running) return;
    const t = setInterval(async () => {
      try { const { data } = await api.get("/cqc/sync/status"); setSync(data); } catch {/* ignore */}
    }, 4000);
    return () => clearInterval(t);
  }, [sync?.running]);

  const startSync = async () => {
    try { await api.post("/cqc/sync/start"); }
    finally {
      const { data } = await api.get("/cqc/sync/status");
      setSync(data);
    }
  };

  const save = async () => {
    setSaving(true); setErr("");
    try {
      const { data } = await api.put("/cqc/definition", def);
      setSaved(data);
    } catch (e) { setErr(e?.response?.data?.detail || "Save failed"); }
    finally { setSaving(false); }
  };

  const reset = () => setDef(saved);
  const dirty = JSON.stringify(def) !== JSON.stringify(saved);

  if (busy) {
    return (
      <div className="p-6 flex items-center justify-center h-[60vh] text-stone-500">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-[1500px] mx-auto space-y-5" data-testid="cqc-definitions">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.3em] font-bold text-stone-500 mb-1">
            <Target className="w-3.5 h-3.5" /> CQC Definitions
          </div>
          <h1 className="font-display text-3xl text-stone-950">Which homes count as ours?</h1>
          <p className="text-sm text-stone-600 mt-1 max-w-2xl">
            One central rule that decides which CQC-registered locations are counted in every franchisee's territory.
            Adjust the filters below — your live preview updates instantly. Save to lock the rule in and re-count every franchisee.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <button onClick={reset} data-testid="def-reset" className="px-3 py-2 text-xs font-bold rounded-lg border border-stone-300 hover:bg-stone-50 flex items-center gap-1.5">
              <RotateCcw className="w-3.5 h-3.5" /> Revert
            </button>
          )}
          <button onClick={save} disabled={!dirty || saving} data-testid="def-save"
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-[#D4FF00] text-stone-950 hover:bg-[#BDE600] rounded-lg disabled:opacity-50 flex items-center gap-1.5">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save & re-count
          </button>
        </div>
      </div>

      {/* Sync banner */}
      <SyncBanner sync={sync} onStart={startSync} />

      {err && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-xl flex items-center gap-1.5">
          <AlertCircle className="w-4 h-4" /> {err}
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-5">
        {/* Filters */}
        <div className="lg:col-span-2 space-y-4">
          <Facet
            title="Service types — INCLUDE"
            help="Only homes registered for these service types will be counted."
            icon={Building2}
            options={serviceTypes}
            selected={def.include_service_types}
            onChange={(arr) => setDef((d) => ({ ...d, include_service_types: arr }))}
            testid="facet-include-service-types"
          />
          <Facet
            title="Service types — EXCLUDE"
            help="Anything tagged with these is dropped, even if it also matches above."
            icon={Building2}
            options={serviceTypes}
            selected={def.exclude_service_types}
            onChange={(arr) => setDef((d) => ({ ...d, exclude_service_types: arr }))}
            testid="facet-exclude-service-types"
            tone="red"
          />
          <Facet
            title="Specialisms — INCLUDE"
            help="Optional. If set, homes must offer at least one of these specialisms."
            icon={Stethoscope}
            options={specialisms}
            selected={def.include_specialisms}
            onChange={(arr) => setDef((d) => ({ ...d, include_specialisms: arr }))}
            testid="facet-include-specialisms"
          />
          <Facet
            title="Specialisms — EXCLUDE"
            help="Useful for skipping children's services, mental health units, etc."
            icon={Stethoscope}
            options={specialisms}
            selected={def.exclude_specialisms}
            onChange={(arr) => setDef((d) => ({ ...d, exclude_specialisms: arr }))}
            testid="facet-exclude-specialisms"
            tone="red"
          />
          <Facet
            title="Regulated activities — INCLUDE"
            help="Optional. The activities CQC licenses each home to perform."
            icon={Stethoscope}
            options={activities}
            selected={def.include_regulated_activities}
            onChange={(arr) => setDef((d) => ({ ...d, include_regulated_activities: arr }))}
            testid="facet-include-regulated-activities"
          />

          <div className="bg-white border border-stone-200 rounded-2xl p-4 grid sm:grid-cols-3 gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 mb-1">Care home flag</div>
              <select value={def.require_care_home || ""}
                onChange={(e) => setDef((d) => ({ ...d, require_care_home: e.target.value || null }))}
                className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg bg-white"
                data-testid="def-care-home">
                <option value="">Either</option>
                <option value="Y">Care home only (Y)</option>
                <option value="N">Non-care-home only (N)</option>
              </select>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 mb-1">Min beds</div>
              <input type="number" min="0" value={def.min_beds || ""}
                onChange={(e) => setDef((d) => ({ ...d, min_beds: e.target.value ? +e.target.value : null }))}
                className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg" placeholder="(no minimum)"
                data-testid="def-min-beds" />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 mb-1">Required ratings</div>
              <div className="flex flex-wrap gap-1">
                {RATING_OPTIONS.map((r) => {
                  const active = (def.require_rating || []).includes(r);
                  return (
                    <button key={r} data-testid={`def-rating-${r}`}
                      onClick={() => setDef((d) => ({
                        ...d,
                        require_rating: active ? d.require_rating.filter((x) => x !== r) : [...(d.require_rating || []), r],
                      }))}
                      className={`px-2 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md border ${active ? "bg-stone-950 text-white border-stone-950" : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"}`}>
                      {r}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Live preview */}
        <PreviewPanel preview={preview} previewing={previewing} />
      </div>
    </div>
  );
}

function SyncBanner({ sync, onStart }) {
  if (!sync) return null;
  const running = sync.running;
  const pct = sync.total ? Math.round((sync.done / sync.total) * 100) : 0;
  const last = sync.last_full_sync;
  return (
    <div className={`rounded-2xl px-5 py-4 ${running ? "bg-amber-50 border border-amber-300" : "bg-emerald-50 border border-emerald-300"}`} data-testid="cqc-sync-banner">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          {running
            ? <Loader2 className="w-5 h-5 animate-spin text-amber-700" />
            : <CheckCircle2 className="w-5 h-5 text-emerald-700" />}
          <div>
            <div className="text-sm font-bold text-stone-950">
              {running ? "CQC sync running…" : sync.live_count ? "CQC data ready" : "CQC sync not started"}
            </div>
            <div className="text-xs text-stone-600">
              {running && <>Page {sync.current_page} · {sync.done.toLocaleString()} / {sync.total.toLocaleString()} ({pct}%) · {sync.errors} errors</>}
              {!running && sync.live_count > 0 && <>{sync.live_count.toLocaleString()} live locations indexed{last?.finished_at ? ` · last sync ${new Date(last.finished_at).toLocaleString()}` : ""}</>}
              {!running && !sync.live_count && <>Click "Sync now" to import all CQC-registered locations.</>}
            </div>
          </div>
        </div>
        {!running && (
          <button onClick={onStart} data-testid="cqc-sync-start"
            className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" /> Sync now
          </button>
        )}
      </div>
      {running && (
        <div className="mt-3 h-2 bg-white rounded-full overflow-hidden">
          <div className="h-full bg-amber-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function PreviewPanel({ preview, previewing }) {
  return (
    <div className="bg-white border border-stone-200 rounded-2xl p-5 sticky top-4 self-start" data-testid="def-preview">
      <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 mb-1">Live preview</div>
      <div className="flex items-center gap-2 mb-1">
        <span className="font-display text-4xl text-stone-950 tabular-nums">{(preview?.count || 0).toLocaleString()}</span>
        <span className="text-sm text-stone-600">homes match</span>
        {previewing && <Loader2 className="w-3.5 h-3.5 animate-spin text-stone-400" />}
      </div>
      {preview?.error && (
        <div className="mt-2 px-3 py-2 text-xs bg-red-50 border border-red-200 text-red-800 rounded-lg flex items-start gap-1.5" data-testid="preview-error">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> <span>{preview.error}</span>
        </div>
      )}
      <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 mt-4 mb-2">By region</div>
      <div className="space-y-1">
        {(preview?.by_region || []).map((r) => (
          <div key={r._id || "unknown"} className="flex items-center justify-between text-xs">
            <span className="text-stone-700">{r._id || "Unknown"}</span>
            <span className="tabular-nums font-bold text-stone-900">{r.n.toLocaleString()}</span>
          </div>
        ))}
      </div>
      <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 mt-4 mb-2">Sample matches</div>
      <div className="space-y-2 max-h-72 overflow-auto">
        {(preview?.sample || []).map((h) => (
          <div key={h.locationId} className="text-xs border border-stone-100 rounded-lg p-2 hover:bg-stone-50">
            <div className="font-bold text-stone-900 truncate">{h.name}</div>
            <div className="text-stone-500 truncate flex items-center gap-1"><MapPin className="w-3 h-3" /> {h.postalCode}</div>
            <div className="text-[10px] text-stone-500 mt-0.5 line-clamp-2">
              {(h.gacServiceTypes || []).map((s) => s.name).join(" · ") || "—"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Facet({ title, help, icon: Icon, options, selected, onChange, testid, tone = "neutral" }) {
  const [query, setQuery] = useState("");
  const lower = query.toLowerCase();
  const filtered = useMemo(() => options.filter((o) => o.value.toLowerCase().includes(lower)), [options, lower]);
  const accent = tone === "red" ? "border-red-200 bg-red-50" : "border-stone-200 bg-white";
  return (
    <div className={`rounded-2xl border ${accent}`} data-testid={testid}>
      <div className="px-4 py-3 border-b border-stone-100 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-bold text-stone-950 flex items-center gap-1.5"><Icon className="w-4 h-4 text-stone-600" /> {title}</div>
          <div className="text-[11px] text-stone-500 max-w-xl">{help}</div>
        </div>
        <input value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          className="px-2.5 py-1 text-xs bg-white border border-stone-300 rounded-md w-44 focus:outline-none focus:ring-2 focus:ring-stone-900/10" />
      </div>
      {selected.length > 0 && (
        <div className="px-4 py-2 border-b border-stone-100 flex flex-wrap gap-1">
          {selected.map((v) => (
            <button key={v} onClick={() => onChange(selected.filter((x) => x !== v))}
              data-testid={`${testid}-chip-${v}`}
              className="group inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider rounded-md bg-stone-950 text-white">
              {v}
              <X className="w-3 h-3 opacity-70 group-hover:opacity-100" />
            </button>
          ))}
        </div>
      )}
      <div className="p-2 max-h-56 overflow-y-auto grid grid-cols-1 md:grid-cols-2 gap-1">
        {filtered.length === 0 && <div className="text-xs text-stone-500 px-2 py-1">No matches.</div>}
        {filtered.map((o) => {
          const active = selected.includes(o.value);
          return (
            <button key={o.value} onClick={() => onChange(active ? selected.filter((x) => x !== o.value) : [...selected, o.value])}
              data-testid={`${testid}-opt-${o.value}`}
              className={`flex items-center justify-between gap-2 px-2 py-1 text-xs rounded-md text-left ${active ? "bg-stone-950 text-white" : "hover:bg-white text-stone-800"}`}>
              <span className="truncate">{o.value}</span>
              <span className="tabular-nums shrink-0 text-[10px] opacity-70">{o.count.toLocaleString()}</span>
              {active ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <Plus className="w-3.5 h-3.5 shrink-0 opacity-50" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
