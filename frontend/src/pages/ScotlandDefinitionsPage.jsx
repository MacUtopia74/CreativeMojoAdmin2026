// Admin tool: define which Scottish Care Inspectorate services count as
// "your kind of home". Mirrors CqcDefinitionsPage but for the
// scotland_care_services collection (CSV-driven; no live API).
//
// Layout:
//   • Import banner (CSV upload + last-import meta + row count)
//   • Multi-select chip groups: Care Service / Subtype / Client Group / Council Area
//   • Active / Inactive status toggle, min beds, min grade
//   • Live preview panel: count + breakdown by council + sample services
//   • Save button (PUT /scotland/definition → triggers home-count refresh)
import { useEffect, useState, useCallback, useRef } from "react";
import api from "@/lib/api";
import {
  Loader2, Save, Upload, Plus, X, AlertCircle,
  CheckCircle2, RotateCcw, Building2, Flag,
} from "lucide-react";

const empty = {
  include_care_services: [],
  exclude_care_services: [],
  include_subtypes: [],
  exclude_subtypes: [],
  include_client_groups: [],
  statuses: ["Active"],
  min_beds: null,
  min_grade: null,
  require_main_area_care_home: false,
};

export default function ScotlandDefinitionsPage() {
  const [def, setDef] = useState(empty);
  const [saved, setSaved] = useState(empty);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState("");
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [importState, setImportState] = useState(null);

  const [careServices, setCareServices] = useState([]);
  const [subtypes, setSubtypes] = useState([]);
  const [clientGroups, setClientGroups] = useState([]);

  const fileRef = useRef(null);

  // Load definition + facets + import state
  useEffect(() => {
    (async () => {
      try {
        const [d, st, cs, sub, cg] = await Promise.all([
          api.get("/scotland/definition"),
          api.get("/scotland/import/status"),
          api.get("/scotland/distinct", { params: { field: "careService" } }),
          api.get("/scotland/distinct", { params: { field: "subtype" } }),
          api.get("/scotland/distinct", { params: { field: "clientGroup" } }),
        ]);
        const merged = { ...empty, ...d.data };
        setDef(merged); setSaved(merged); setImportState(st.data);
        setCareServices(cs.data.values || []);
        setSubtypes(sub.data.values || []);
        setClientGroups(cg.data.values || []);
      } catch (e) {
        setErr(e?.response?.data?.detail || "Failed to load Scotland definitions.");
      } finally { setBusy(false); }
    })();
  }, []);

  // Live preview — debounced via effect dep tracking
  const runPreview = useCallback(async () => {
    setPreviewing(true);
    try {
      const params = {
        include_care_services: (def.include_care_services || []).join(","),
        exclude_care_services: (def.exclude_care_services || []).join(","),
        include_subtypes: (def.include_subtypes || []).join(","),
        exclude_subtypes: (def.exclude_subtypes || []).join(","),
        include_client_groups: (def.include_client_groups || []).join(","),
        statuses: (def.statuses || []).join(","),
        min_beds: def.min_beds ?? "",
        min_grade: def.min_grade ?? "",
        require_main_area_care_home: def.require_main_area_care_home ? true : false,
      };
      const { data } = await api.get("/scotland/definition/preview", { params });
      setPreview(data);
    } catch (e) { /* ignore preview errors */ }
    finally { setPreviewing(false); }
  }, [def]);

  useEffect(() => { if (!busy) { const t = setTimeout(runPreview, 350); return () => clearTimeout(t); } }, [busy, runPreview]);

  const save = async () => {
    setSaving(true); setErr("");
    try {
      const { data } = await api.put("/scotland/definition", def);
      const merged = { ...empty, ...data };
      setSaved(merged);
      // Show recount toast inline
      if (data?._recount) {
        setErr(`Saved — refreshed ${data._recount.franchisees_updated} franchisee count${data._recount.franchisees_updated === 1 ? "" : "s"}.`);
        setTimeout(() => setErr(""), 4000);
      }
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not save.");
    } finally { setSaving(false); }
  };

  const reset = () => setDef(saved);

  const onUpload = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true); setErr("");
    try {
      const form = new FormData(); form.append("file", f);
      const { data } = await api.post("/scotland/import", form, { headers: { "Content-Type": "multipart/form-data" } });
      // Refresh state + facets
      const [st, cs, sub, cg] = await Promise.all([
        api.get("/scotland/import/status"),
        api.get("/scotland/distinct", { params: { field: "careService" } }),
        api.get("/scotland/distinct", { params: { field: "subtype" } }),
        api.get("/scotland/distinct", { params: { field: "clientGroup" } }),
      ]);
      setImportState(st.data);
      setCareServices(cs.data.values || []);
      setSubtypes(sub.data.values || []);
      setClientGroups(cg.data.values || []);
      setErr(`Imported ${data.rows_loaded.toLocaleString()} services from ${data.filename}.`);
      setTimeout(() => setErr(""), 4000);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Upload failed.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const dirty = JSON.stringify(def) !== JSON.stringify(saved);

  if (busy) {
    return <div className="flex items-center justify-center min-h-[60vh] text-stone-500"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…</div>;
  }

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-7xl" data-testid="scotland-definitions-page">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 flex items-center gap-2">
            <Flag className="w-3 h-3" /> Care Inspectorate · Scotland
          </div>
          <h1 className="font-display text-4xl text-stone-950 mt-1">Scottish Services Rule</h1>
          <p className="text-sm text-stone-600 mt-2 max-w-2xl">
            Care Inspectorate publishes a quarterly Datastore CSV — there is no live API. Upload the latest file
            and pick which service types count as a "home" for Scottish franchisees. All territory home counts
            for postcodes north of the border re-derive from this rule automatically.
          </p>
        </div>
        {dirty && (
          <div className="flex items-center gap-2">
            <button onClick={reset} className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-lg flex items-center gap-1.5" data-testid="scot-reset">
              <RotateCcw className="w-3.5 h-3.5" /> Reset
            </button>
            <button onClick={save} disabled={saving} data-testid="scot-save" className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-lg flex items-center gap-1.5 disabled:opacity-50">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save rule
            </button>
          </div>
        )}
      </div>

      {/* Import banner */}
      <div className="bg-white border border-stone-200 rounded-2xl p-4 flex items-center justify-between gap-4 flex-wrap">
        <div className="text-sm">
          <div className="text-stone-900 font-semibold">{importState?.live_count?.toLocaleString() || 0} Scottish services loaded</div>
          <div className="text-xs text-stone-500 mt-0.5">
            {importState?.last_import
              ? <>Last upload: <strong>{importState.last_import.filename}</strong> · {new Date(importState.last_import.imported_at).toLocaleString("en-GB")} · {importState.last_import.rows_loaded.toLocaleString()} rows</>
              : "No data loaded yet. Upload a Datastore CSV to begin."}
          </div>
        </div>
        <label className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-white rounded-lg flex items-center gap-1.5 cursor-pointer" data-testid="scot-upload-btn">
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
          {uploading ? "Uploading…" : "Upload CSV"}
          <input ref={fileRef} type="file" accept=".csv,text/csv" disabled={uploading} onChange={onUpload} className="hidden" data-testid="scot-upload-input" />
        </label>
      </div>

      {err && (
        <div className={`px-4 py-3 border rounded-xl text-sm flex items-center gap-2 ${err.toLowerCase().startsWith("saved") || err.toLowerCase().startsWith("imported") ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-amber-300 bg-amber-50 text-amber-900"}`}>
          {err.toLowerCase().startsWith("saved") || err.toLowerCase().startsWith("imported") ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {err}
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <ChipGroup label="Care Service" options={careServices} value={def.include_care_services} exclude={def.exclude_care_services}
            onIncludeChange={(v) => setDef((d) => ({ ...d, include_care_services: v }))}
            onExcludeChange={(v) => setDef((d) => ({ ...d, exclude_care_services: v }))} testidPrefix="careservice" />
          <ChipGroup label="Subtype" options={subtypes} value={def.include_subtypes} exclude={def.exclude_subtypes}
            onIncludeChange={(v) => setDef((d) => ({ ...d, include_subtypes: v }))}
            onExcludeChange={(v) => setDef((d) => ({ ...d, exclude_subtypes: v }))} testidPrefix="subtype" />
          <ChipGroup label="Client Group" options={clientGroups} value={def.include_client_groups} exclude={[]}
            onIncludeChange={(v) => setDef((d) => ({ ...d, include_client_groups: v }))}
            onExcludeChange={null} testidPrefix="clientgroup" />

          <div className="bg-white border border-stone-200 rounded-2xl p-4 grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Min beds</label>
              <input type="number" min="0" value={def.min_beds ?? ""} onChange={(e) => setDef((d) => ({ ...d, min_beds: e.target.value ? parseInt(e.target.value, 10) : null }))} data-testid="scot-min-beds"
                className="w-full mt-1 px-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-none focus:border-stone-900" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Min grade (1–6)</label>
              <input type="number" min="1" max="6" value={def.min_grade ?? ""} onChange={(e) => setDef((d) => ({ ...d, min_grade: e.target.value ? parseInt(e.target.value, 10) : null }))} data-testid="scot-min-grade"
                className="w-full mt-1 px-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-none focus:border-stone-900" />
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer mt-5">
              <input type="checkbox" checked={!!def.require_main_area_care_home} onChange={(e) => setDef((d) => ({ ...d, require_main_area_care_home: e.target.checked }))} data-testid="scot-require-care-home" />
              <span>Must have CareHome main area</span>
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer mt-5">
              <input type="checkbox" checked={(def.statuses || []).includes("Active")} onChange={(e) => setDef((d) => ({ ...d, statuses: e.target.checked ? ["Active"] : [] }))} data-testid="scot-active-only" />
              <span>Active services only</span>
            </label>
          </div>
        </div>

        {/* Live preview panel */}
        <div className="bg-white border border-stone-200 rounded-2xl p-4 self-start sticky top-6">
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 flex items-center justify-between">
            <span>Live preview</span>
            {previewing && <Loader2 className="w-3 h-3 animate-spin text-stone-400" />}
          </div>
          <div className="mt-2 text-4xl font-display text-stone-950 tabular-nums" data-testid="scot-preview-count">
            {preview?.count?.toLocaleString() ?? "—"}
          </div>
          <div className="text-xs text-stone-500">services match this rule</div>
          {preview?.by_council?.length > 0 && (
            <div className="mt-4">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1.5">Top councils</div>
              <ul className="text-xs divide-y divide-stone-100">
                {preview.by_council.slice(0, 8).map((r) => (
                  <li key={r._id || "—"} className="py-1.5 flex items-center justify-between gap-2">
                    <span className="truncate text-stone-800 flex items-center gap-1.5"><Building2 className="w-3 h-3 text-stone-400 shrink-0" /> {r._id || "—"}</span>
                    <span className="tabular-nums font-bold text-stone-700">{r.n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview?.sample?.length > 0 && (
            <div className="mt-4">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1.5">Sample</div>
              <ul className="text-xs space-y-1">
                {preview.sample.slice(0, 6).map((h) => (
                  <li key={h.csNumber} className="px-2 py-1 bg-stone-50 border border-stone-200 rounded-md">
                    <div className="font-semibold text-stone-900 truncate">{h.name || h.csNumber}</div>
                    <div className="text-stone-500 truncate">{h.town} · {h.postalCode}{h.totalBeds ? ` · ${h.totalBeds} beds` : ""}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Reusable chip selector — include / exclude toggles for one facet.
function ChipGroup({ label, options, value, exclude, onIncludeChange, onExcludeChange, testidPrefix }) {
  const incSet = new Set(value || []);
  const excSet = new Set(exclude || []);
  const toggleInc = (v) => {
    const next = new Set(incSet);
    if (next.has(v)) next.delete(v); else { next.add(v); excSet.delete(v); }
    onIncludeChange(Array.from(next));
    if (onExcludeChange) onExcludeChange(Array.from(excSet));
  };
  const toggleExc = (v) => {
    if (!onExcludeChange) return;
    const next = new Set(excSet);
    if (next.has(v)) next.delete(v); else { next.add(v); incSet.delete(v); }
    onExcludeChange(Array.from(next));
    onIncludeChange(Array.from(incSet));
  };
  return (
    <div className="bg-white border border-stone-200 rounded-2xl p-4">
      <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-2 flex items-center justify-between">
        <span>{label}</span>
        <span className="font-normal normal-case tracking-normal text-stone-400">{incSet.size} included{onExcludeChange ? ` · ${excSet.size} excluded` : ""}</span>
      </div>
      <div className="flex flex-wrap gap-1.5 max-h-56 overflow-y-auto">
        {options.length === 0 && <div className="text-xs text-stone-400">No options yet — upload a CSV first.</div>}
        {options.map(({ value: v, count }) => {
          const inc = incSet.has(v);
          const exc = excSet.has(v);
          return (
            <span key={v} className="inline-flex items-center" data-testid={`${testidPrefix}-${v.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
              <button
                onClick={() => toggleInc(v)}
                className={`px-2.5 py-1 text-[11px] font-semibold border rounded-l-md transition ${
                  inc ? "bg-emerald-100 border-emerald-300 text-emerald-900"
                       : "bg-white border-stone-300 text-stone-700 hover:bg-stone-50"
                }`}>
                {inc ? <CheckCircle2 className="w-3 h-3 mr-1 inline" /> : <Plus className="w-3 h-3 mr-1 inline" />}
                {v} <span className="ml-1 text-stone-400">{count}</span>
              </button>
              {onExcludeChange && (
                <button
                  onClick={() => toggleExc(v)}
                  title="Exclude"
                  className={`px-1.5 py-1 text-[11px] font-semibold border-y border-r rounded-r-md transition ${
                    exc ? "bg-red-100 border-red-300 text-red-800"
                        : "bg-white border-stone-300 text-stone-500 hover:bg-stone-50"
                  }`}>
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
