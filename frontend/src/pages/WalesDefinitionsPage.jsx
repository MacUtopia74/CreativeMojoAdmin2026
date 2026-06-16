// Admin tool: define which CIW (Wales) services count as "your kind of
// home". Mirrors NiDefinitionsPage but for the wales_care_services
// collection — CSV-driven, incremental upsert (vs the NI full-swap),
// no polygon importer (Welsh sectors already live in the GB-wide
// postcode_sector_polygons collection).
//
// Layout:
//   • Import banner (CSV upload + last-import meta with full incremental summary)
//   • Multi-select chip groups: Service Sub-Type / Categories / Provider
//   • Min places filter + "Hide inactive" toggle
//   • Live preview panel: count + breakdown by local authority + sample services
//   • Save button (PUT /wales/definition)
import { useEffect, useState, useCallback, useRef } from "react";
import api from "@/lib/api";
import {
  Loader2, Save, Upload, Plus, X, AlertCircle,
  CheckCircle2, RotateCcw, MapPin, Flag, EyeOff,
} from "lucide-react";

const empty = {
  include_service_types: [],
  exclude_service_types: [],
  include_subtypes: [],
  exclude_subtypes: [],
  include_categories: [],
  exclude_categories: [],
  include_providers: [],
  min_places: null,
  hide_inactive: false,
};

export default function WalesDefinitionsPage() {
  const [def, setDef] = useState(empty);
  const [saved, setSaved] = useState(empty);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState("");
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [importState, setImportState] = useState(null);
  const [lastImportSummary, setLastImportSummary] = useState(null);

  const [serviceSubTypes, setServiceSubTypes] = useState([]);
  const [categories, setCategories] = useState([]);
  const [providers, setProviders] = useState([]);

  const fileRef = useRef(null);

  const reloadFacets = useCallback(async () => {
    const [st, sub, cat, prov] = await Promise.all([
      api.get("/wales/import/status"),
      api.get("/wales/distinct", { params: { field: "serviceSubType" } }),
      api.get("/wales/distinct", { params: { field: "categoriesOfCare" } }),
      api.get("/wales/distinct", { params: { field: "provider" } }),
    ]);
    setImportState(st.data);
    setServiceSubTypes(sub.data.values || []);
    setCategories(cat.data.values || []);
    setProviders(prov.data.values || []);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const d = await api.get("/wales/definition");
        const merged = { ...empty, ...d.data };
        setDef(merged); setSaved(merged);
        await reloadFacets();
      } catch (e) {
        setErr(e?.response?.data?.detail || "Failed to load Wales definitions.");
      } finally { setBusy(false); }
    })();
  }, [reloadFacets]);

  const runPreview = useCallback(async () => {
    setPreviewing(true);
    try {
      const params = {
        include_service_types: (def.include_service_types || []).join(","),
        exclude_service_types: (def.exclude_service_types || []).join(","),
        include_subtypes: (def.include_subtypes || []).join(","),
        exclude_subtypes: (def.exclude_subtypes || []).join(","),
        include_categories: (def.include_categories || []).join(","),
        exclude_categories: (def.exclude_categories || []).join(","),
        include_providers: (def.include_providers || []).join(","),
        min_places: def.min_places ?? "",
        hide_inactive: def.hide_inactive ? "true" : "false",
      };
      const { data } = await api.get("/wales/definition/preview", { params });
      setPreview(data);
    } catch { /* ignore preview errors */ }
    finally { setPreviewing(false); }
  }, [def]);

  useEffect(() => { if (!busy) { const t = setTimeout(runPreview, 350); return () => clearTimeout(t); } }, [busy, runPreview]);

  const save = async () => {
    setSaving(true); setErr("");
    try {
      const { data } = await api.put("/wales/definition", def);
      const merged = { ...empty, ...data };
      setSaved(merged);
      setErr("Saved.");
      setTimeout(() => setErr(""), 4000);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not save.");
    } finally { setSaving(false); }
  };

  const reset = () => setDef(saved);

  const onUpload = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true); setErr(""); setLastImportSummary(null);
    try {
      const form = new FormData(); form.append("file", f);
      const { data } = await api.post("/wales/import", form, { headers: { "Content-Type": "multipart/form-data" } });
      await reloadFacets();
      setLastImportSummary(data);
      setErr(
        `Imported ${data.filename}: ${data.inserted} new · ` +
        `${data.updated} updated · ${data.reactivated} reactivated · ` +
        `${data.inactivated} flagged closed.`
      );
      setTimeout(() => setErr(""), 6000);
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

  const fmtDate = (iso) => {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString("en-GB"); } catch { return iso; }
  };

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-7xl" data-testid="wales-definitions-page">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 flex items-center gap-2">
            <Flag className="w-3 h-3" /> CIW · Wales
          </div>
          <h1 className="font-display text-4xl text-stone-950 mt-1">Wales Services Rule</h1>
          <p className="text-sm text-stone-600 mt-2 max-w-2xl">
            Care Inspectorate Wales (CIW) publishes a CSV of every regulated service across Wales. Upload below —
            only <strong>Care Home Service</strong> rows are kept; childcare, fostering and adoption services
            are filtered out automatically. Imports are incremental: new URNs are added, existing ones updated,
            and any URN missing from the file is flagged <strong>closed</strong> rather than deleted.
          </p>
        </div>
        {dirty && (
          <div className="flex items-center gap-2">
            <button onClick={reset} className="px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-lg flex items-center gap-1.5" data-testid="wales-reset">
              <RotateCcw className="w-3.5 h-3.5" /> Reset
            </button>
            <button onClick={save} disabled={saving} data-testid="wales-save" className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-lg flex items-center gap-1.5 disabled:opacity-50">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save rule
            </button>
          </div>
        )}
      </div>

      {/* Import banner */}
      <div className="bg-white border border-stone-200 rounded-2xl p-4 flex items-center justify-between gap-4 flex-wrap">
        <div className="text-sm">
          <div className="text-stone-900 font-semibold flex items-center gap-3 flex-wrap" data-testid="wales-loaded-summary">
            <span>{(importState?.live_count || 0).toLocaleString()} Welsh services loaded</span>
            {(importState?.inactive_count || 0) > 0 && (
              <>
                <span className="text-stone-300">·</span>
                <span className="text-stone-500 inline-flex items-center gap-1">
                  <EyeOff className="w-3 h-3" />
                  {importState.inactive_count.toLocaleString()} flagged closed
                </span>
              </>
            )}
          </div>
          <div className="text-xs text-stone-500 mt-0.5">
            {importState?.last_import
              ? <>Last import: <strong>{importState.last_import.filename}</strong> · {fmtDate(importState.last_import.imported_at)} · {importState.last_import.rows_in_file?.toLocaleString?.()} care-home rows</>
              : "No data loaded yet. Upload a CIW CSV file."}
          </div>
          {lastImportSummary && (
            <div className="text-[11px] text-emerald-800 mt-1 flex items-center gap-2 flex-wrap" data-testid="wales-import-summary">
              <span><strong>{lastImportSummary.inserted.toLocaleString()}</strong> new</span>
              <span className="text-stone-300">·</span>
              <span><strong>{lastImportSummary.updated.toLocaleString()}</strong> updated</span>
              <span className="text-stone-300">·</span>
              <span><strong>{lastImportSummary.reactivated.toLocaleString()}</strong> reactivated</span>
              <span className="text-stone-300">·</span>
              <span><strong>{lastImportSummary.inactivated.toLocaleString()}</strong> flagged closed</span>
              {(lastImportSummary.skipped_wrong_type > 0) && (
                <>
                  <span className="text-stone-300">·</span>
                  <span className="text-stone-600">{lastImportSummary.skipped_wrong_type.toLocaleString()} non-care-home rows ignored</span>
                </>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <label className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-white rounded-lg flex items-center gap-1.5 cursor-pointer" data-testid="wales-upload-btn">
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            {uploading ? "Uploading…" : "Upload CIW CSV"}
            <input ref={fileRef} type="file" accept=".csv" disabled={uploading} onChange={onUpload} className="hidden" data-testid="wales-upload-input" />
          </label>
        </div>
      </div>

      {err && (
        <div className={`px-4 py-3 border rounded-xl text-sm flex items-center gap-2 ${err.toLowerCase().startsWith("saved") || err.toLowerCase().startsWith("imported") ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-amber-300 bg-amber-50 text-amber-900"}`}>
          {err.toLowerCase().startsWith("saved") || err.toLowerCase().startsWith("imported") ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {err}
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <ChipGroup
            label="Service Sub-Type"
            options={serviceSubTypes}
            value={def.include_subtypes}
            exclude={def.exclude_subtypes}
            onIncludeChange={(v) => setDef((d) => ({ ...d, include_subtypes: v }))}
            onExcludeChange={(v) => setDef((d) => ({ ...d, exclude_subtypes: v }))}
            testidPrefix="wales-subtype"
          />
          <ChipGroup
            label="Provision For (Categories)"
            options={categories}
            value={def.include_categories}
            exclude={def.exclude_categories}
            onIncludeChange={(v) => setDef((d) => ({ ...d, include_categories: v }))}
            onExcludeChange={(v) => setDef((d) => ({ ...d, exclude_categories: v }))}
            testidPrefix="wales-category"
          />
          <ChipGroup
            label="Provider"
            options={providers}
            value={def.include_providers}
            exclude={[]}
            onIncludeChange={(v) => setDef((d) => ({ ...d, include_providers: v }))}
            onExcludeChange={null}
            testidPrefix="wales-provider"
          />

          <div className="bg-white border border-stone-200 rounded-2xl p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Min approved places</label>
              <input
                type="number"
                min="0"
                value={def.min_places ?? ""}
                onChange={(e) => setDef((d) => ({ ...d, min_places: e.target.value ? parseInt(e.target.value, 10) : null }))}
                data-testid="wales-min-places"
                className="w-full mt-1 px-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-none focus:border-stone-900"
              />
              <p className="text-[11px] text-stone-500 mt-1">Filters to services with at least this many approved places.</p>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Closed homes</label>
              <label className="mt-2 flex items-center gap-2 text-sm text-stone-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!def.hide_inactive}
                  onChange={(e) => setDef((d) => ({ ...d, hide_inactive: e.target.checked }))}
                  data-testid="wales-hide-inactive"
                  className="w-4 h-4 accent-stone-950"
                />
                Hide closed/removed homes from My Territory
              </label>
              <p className="text-[11px] text-stone-500 mt-1">
                Default: keep closed homes visible (dimmed) so franchisees see why a familiar home disappeared from CIW.
              </p>
            </div>
          </div>
        </div>

        {/* Live preview panel */}
        <div className="bg-white border border-stone-200 rounded-2xl p-4 self-start sticky top-6">
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 flex items-center justify-between">
            <span>Live preview</span>
            {previewing && <Loader2 className="w-3 h-3 animate-spin text-stone-400" />}
          </div>
          <div className="mt-2 text-4xl font-display text-stone-950 tabular-nums" data-testid="wales-preview-count">
            {preview?.count?.toLocaleString() ?? "—"}
          </div>
          <div className="text-xs text-stone-500">services match this rule</div>
          {preview?.by_la?.length > 0 && (
            <div className="mt-4">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1.5">Top local authorities</div>
              <ul className="text-xs divide-y divide-stone-100">
                {preview.by_la.slice(0, 8).map((r) => (
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
                  <li
                    key={h.serviceUrn}
                    className={`px-2 py-1 border rounded-md ${h.active === false ? "bg-stone-100 border-stone-200 opacity-60" : "bg-stone-50 border-stone-200"}`}
                  >
                    <div className="font-semibold text-stone-900 truncate flex items-center gap-1.5">
                      {h.name || h.serviceUrn}
                      {h.active === false && (
                        <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-stone-200 text-stone-700 rounded">closed</span>
                      )}
                    </div>
                    <div className="text-stone-500 truncate">
                      {h.town}{h.postalCode ? ` · ${h.postalCode}` : ""}
                      {h.localAuthority ? ` · ${h.localAuthority}` : ""}
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
// (Kept inline rather than shared so each definition page can evolve
// its layout without coupling.)
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
        {options.length === 0 && <div className="text-xs text-stone-400">No options yet — upload a CIW CSV first.</div>}
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
