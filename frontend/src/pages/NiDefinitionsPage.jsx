// Admin tool: define which RQIA (Northern Ireland) services count as
// "your kind of home". Mirrors ScotlandDefinitionsPage but for the
// ni_care_services collection (XLSX-driven; monthly refresh from
// OpenDataNI's CKAN portal).
//
// Layout:
//   • Import banner (XLSX upload + Refresh-from-OpenDataNI + last-import meta)
//   • Multi-select chip groups: Service Type / Categories of Care / Provider
//   • Min places filter
//   • Live preview panel: count + breakdown by town + sample services
//   • Save button (PUT /ni/definition)
import { useEffect, useState, useCallback, useRef } from "react";
import api from "@/lib/api";
import {
  Loader2, Save, Upload, Plus, X, AlertCircle,
  CheckCircle2, RotateCcw, MapPin, Flag, RefreshCw,
} from "lucide-react";

const empty = {
  include_service_types: [],
  exclude_service_types: [],
  include_categories: [],
  exclude_categories: [],
  include_providers: [],
  min_places: null,
};

export default function NiDefinitionsPage() {
  const [def, setDef] = useState(empty);
  const [saved, setSaved] = useState(empty);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState("");
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [importState, setImportState] = useState(null);

  const [serviceTypes, setServiceTypes] = useState([]);
  const [categories, setCategories] = useState([]);
  const [providers, setProviders] = useState([]);

  const fileRef = useRef(null);

  const reloadFacets = useCallback(async () => {
    const [st, sv, cat, prov] = await Promise.all([
      api.get("/ni/import/status"),
      api.get("/ni/distinct", { params: { field: "serviceType" } }),
      api.get("/ni/distinct", { params: { field: "categoriesOfCare" } }),
      api.get("/ni/distinct", { params: { field: "provider" } }),
    ]);
    setImportState(st.data);
    setServiceTypes(sv.data.values || []);
    setCategories(cat.data.values || []);
    setProviders(prov.data.values || []);
  }, []);

  // Load definition + facets + import state
  useEffect(() => {
    (async () => {
      try {
        const d = await api.get("/ni/definition");
        const merged = { ...empty, ...d.data };
        setDef(merged); setSaved(merged);
        await reloadFacets();
      } catch (e) {
        setErr(e?.response?.data?.detail || "Failed to load Northern Ireland definitions.");
      } finally { setBusy(false); }
    })();
  }, [reloadFacets]);

  // Live preview — debounced via effect dep tracking
  const runPreview = useCallback(async () => {
    setPreviewing(true);
    try {
      const params = {
        include_service_types: (def.include_service_types || []).join(","),
        exclude_service_types: (def.exclude_service_types || []).join(","),
        include_categories: (def.include_categories || []).join(","),
        exclude_categories: (def.exclude_categories || []).join(","),
        include_providers: (def.include_providers || []).join(","),
        min_places: def.min_places ?? "",
      };
      const { data } = await api.get("/ni/definition/preview", { params });
      setPreview(data);
    } catch { /* ignore preview errors */ }
    finally { setPreviewing(false); }
  }, [def]);

  useEffect(() => { if (!busy) { const t = setTimeout(runPreview, 350); return () => clearTimeout(t); } }, [busy, runPreview]);

  const save = async () => {
    setSaving(true); setErr("");
    try {
      const { data } = await api.put("/ni/definition", def);
      const merged = { ...empty, ...data };
      setSaved(merged);
      setErr("Saved.");
      setTimeout(() => setErr(""), 3000);
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
      const { data } = await api.post("/ni/import", form, { headers: { "Content-Type": "multipart/form-data" } });
      await reloadFacets();
      setErr(`Imported ${data.rows_loaded.toLocaleString()} services from ${data.filename}.`);
      setTimeout(() => setErr(""), 4000);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Upload failed.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onRefreshFromOpenDataNI = async () => {
    setRefreshing(true); setErr("");
    try {
      const { data } = await api.post("/ni/import/refresh");
      await reloadFacets();
      setErr(`Refreshed ${data.rows_loaded.toLocaleString()} services from OpenDataNI (${data.filename}).`);
      setTimeout(() => setErr(""), 4500);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Refresh failed.");
    } finally {
      setRefreshing(false);
    }
  };

  const dirty = JSON.stringify(def) !== JSON.stringify(saved);

  if (busy) {
    return <div className="flex items-center justify-center min-h-[60vh] text-stone-500"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…</div>;
  }

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-7xl" data-testid="ni-definitions-page">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 flex items-center gap-2">
            <Flag className="w-3 h-3" /> RQIA · Northern Ireland
          </div>
          <h1 className="font-display text-4xl text-stone-950 mt-1">Northern Ireland Services Rule</h1>
          <p className="text-sm text-stone-600 mt-2 max-w-2xl">
            The Regulation &amp; Quality Improvement Authority (RQIA) publishes a monthly XLSX of every regulated
            service in Northern Ireland via OpenDataNI. Refresh on demand below — or upload a file manually —
            and pick which service types count as a &ldquo;home&rdquo; for your NI franchisees (Belfast, Antrim, Banbridge,
            Craigavon &amp; Dungannon).
          </p>
        </div>
        {dirty && (
          <div className="flex items-center gap-2">
            <button onClick={reset} className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-lg flex items-center gap-1.5" data-testid="ni-reset">
              <RotateCcw className="w-3.5 h-3.5" /> Reset
            </button>
            <button onClick={save} disabled={saving} data-testid="ni-save" className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-lg flex items-center gap-1.5 disabled:opacity-50">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save rule
            </button>
          </div>
        )}
      </div>

      {/* Import banner */}
      <div className="bg-white border border-stone-200 rounded-2xl p-4 flex items-center justify-between gap-4 flex-wrap">
        <div className="text-sm">
          <div className="text-stone-900 font-semibold">{importState?.live_count?.toLocaleString() || 0} NI services loaded</div>
          <div className="text-xs text-stone-500 mt-0.5">
            {importState?.last_import
              ? <>Last import: <strong>{importState.last_import.filename}</strong> · {new Date(importState.last_import.imported_at).toLocaleString("en-GB")} · {importState.last_import.rows_loaded?.toLocaleString?.()} rows · <span className="uppercase tracking-wider text-[10px] font-bold text-stone-600">{importState.last_import.source === "opendatani" ? "OpenDataNI" : "Manual upload"}</span></>
              : "No data loaded yet. Click \u201cRefresh from OpenDataNI\u201d or upload an RQIA XLSX file."}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefreshFromOpenDataNI}
            disabled={refreshing || uploading}
            data-testid="ni-refresh-opendatani-btn"
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-white rounded-lg flex items-center gap-1.5 disabled:opacity-50"
          >
            {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {refreshing ? "Refreshing…" : "Refresh from OpenDataNI"}
          </button>
          <label className="px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 text-stone-800 rounded-lg flex items-center gap-1.5 cursor-pointer" data-testid="ni-upload-btn">
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            {uploading ? "Uploading…" : "Upload XLSX"}
            <input ref={fileRef} type="file" accept=".xlsx" disabled={uploading || refreshing} onChange={onUpload} className="hidden" data-testid="ni-upload-input" />
          </label>
        </div>
      </div>

      {err && (
        <div className={`px-4 py-3 border rounded-xl text-sm flex items-center gap-2 ${err.toLowerCase().startsWith("saved") || err.toLowerCase().startsWith("imported") || err.toLowerCase().startsWith("refreshed") ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-amber-300 bg-amber-50 text-amber-900"}`}>
          {err.toLowerCase().startsWith("saved") || err.toLowerCase().startsWith("imported") || err.toLowerCase().startsWith("refreshed") ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {err}
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <ChipGroup label="Service Type" options={serviceTypes} value={def.include_service_types} exclude={def.exclude_service_types}
            onIncludeChange={(v) => setDef((d) => ({ ...d, include_service_types: v }))}
            onExcludeChange={(v) => setDef((d) => ({ ...d, exclude_service_types: v }))} testidPrefix="ni-servicetype" />
          <ChipGroup label="Categories of Care" options={categories} value={def.include_categories} exclude={def.exclude_categories}
            onIncludeChange={(v) => setDef((d) => ({ ...d, include_categories: v }))}
            onExcludeChange={(v) => setDef((d) => ({ ...d, exclude_categories: v }))} testidPrefix="ni-category" />
          <ChipGroup label="Provider" options={providers} value={def.include_providers} exclude={[]}
            onIncludeChange={(v) => setDef((d) => ({ ...d, include_providers: v }))}
            onExcludeChange={null} testidPrefix="ni-provider" />

          <div className="bg-white border border-stone-200 rounded-2xl p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Min approved places</label>
              <input type="number" min="0" value={def.min_places ?? ""} onChange={(e) => setDef((d) => ({ ...d, min_places: e.target.value ? parseInt(e.target.value, 10) : null }))} data-testid="ni-min-places"
                className="w-full mt-1 px-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-none focus:border-stone-900" />
              <p className="text-[11px] text-stone-500 mt-1">Filters to services with at least this many approved places.</p>
            </div>
          </div>
        </div>

        {/* Live preview panel */}
        <div className="bg-white border border-stone-200 rounded-2xl p-4 self-start sticky top-6">
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 flex items-center justify-between">
            <span>Live preview</span>
            {previewing && <Loader2 className="w-3 h-3 animate-spin text-stone-400" />}
          </div>
          <div className="mt-2 text-4xl font-display text-stone-950 tabular-nums" data-testid="ni-preview-count">
            {preview?.count?.toLocaleString() ?? "—"}
          </div>
          <div className="text-xs text-stone-500">services match this rule</div>
          {preview?.by_town?.length > 0 && (
            <div className="mt-4">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1.5">Top towns</div>
              <ul className="text-xs divide-y divide-stone-100">
                {preview.by_town.slice(0, 8).map((r) => (
                  <li key={r._id || "—"} className="py-1.5 flex items-center justify-between gap-2">
                    <span className="truncate text-stone-800 flex items-center gap-1.5"><MapPin className="w-3 h-3 text-stone-400 shrink-0" /> {r._id || "—"}</span>
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
                  <li key={h.serviceId} className="px-2 py-1 bg-stone-50 border border-stone-200 rounded-md">
                    <div className="font-semibold text-stone-900 truncate">{h.name || h.serviceId}</div>
                    <div className="text-stone-500 truncate">
                      {h.town}{h.postalCode ? ` · ${h.postalCode}` : ""}
                      {h.maxApprovedPlaces ? ` · ${h.maxApprovedPlaces} places` : ""}
                    </div>
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
        {options.length === 0 && <div className="text-xs text-stone-400">No options yet — refresh from OpenDataNI or upload an XLSX first.</div>}
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
