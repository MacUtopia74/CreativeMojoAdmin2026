// Admin — Marker Library (Phase 1A basic UI).
// Manage the global [[MARKER]] catalogue. Soft-delete only. Full visual
// PDF placement editor lives in Phase 1B.
import { useCallback, useEffect, useMemo, useState } from "react";
import api from "@/lib/api";
import {
  BookOpen, Loader2, AlertTriangle, EyeOff, Eye, Plus, Save, X,
  Info, RefreshCw, Search,
} from "lucide-react";

const CONTRACT_TYPES = [
  { value: "new_franchise",       label: "New franchise" },
  { value: "franchise_renewal",   label: "Franchise renewal" },
  { value: "licence",             label: "Licence" },
  { value: "licence_renewal",     label: "Licence renewal" },
  { value: "territory_amendment", label: "Territory amendment" },
  { value: "other",               label: "Other" },
];

const VALUE_SOURCE_BADGES = {
  automatic:        "bg-emerald-100 text-emerald-800 border-emerald-200",
  manual:           "bg-amber-100 text-amber-800 border-amber-200",
  system_generated: "bg-sky-100 text-sky-800 border-sky-200",
  calculated:       "bg-violet-100 text-violet-800 border-violet-200",
};

const DATA_TYPES = ["string", "multiline_text", "date", "currency", "integer", "decimal"];
const VALUE_SOURCES = ["automatic", "manual", "system_generated", "calculated"];

export default function AdminMarkerLibraryPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [includeHidden, setIncludeHidden] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState(null); // marker doc or null

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const { data } = await api.get("/admin/markers-library", { params: { include_hidden: includeHidden } });
      setItems(data.items || []);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Failed to load Marker Library.");
    } finally { setLoading(false); }
  }, [includeHidden]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!searchQ) return items;
    const q = searchQ.toLowerCase();
    return items.filter((m) => m.code.toLowerCase().includes(q) || (m.label || "").toLowerCase().includes(q));
  }, [items, searchQ]);

  const stats = useMemo(() => {
    const counts = { automatic: 0, manual: 0, system_generated: 0, calculated: 0 };
    for (const m of items) if (!m.hidden) counts[m.value_source] = (counts[m.value_source] || 0) + 1;
    return counts;
  }, [items]);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5" data-testid="admin-marker-library">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-3xl text-stone-950 flex items-center gap-2">
            <BookOpen className="w-6 h-6" /> Marker Library
          </h1>
          <p className="text-sm text-stone-500 mt-1 max-w-2xl">
            Global catalogue of <code className="bg-stone-100 rounded px-1">[[MARKER]]</code> tokens available across contract templates. Automatic markers pull from the Hub; manual markers are entered by HQ at issue time; system-generated markers use a deterministic default; calculated markers evaluate a formula.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} data-testid="library-refresh"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold uppercase tracking-widest rounded-lg bg-white border border-stone-300 hover:bg-stone-50">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          <button onClick={() => setShowNew(true)} data-testid="library-new"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold uppercase tracking-widest rounded-lg bg-stone-950 text-white">
            <Plus className="w-3.5 h-3.5" /> New marker
          </button>
        </div>
      </div>

      {/* Counts */}
      <div className="flex items-center gap-3 flex-wrap">
        {Object.entries(stats).map(([src, n]) => (
          <span key={src}
                data-testid={`library-count-${src}`}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold border ${VALUE_SOURCE_BADGES[src]}`}>
            {src.replace("_", " ")}: {n}
          </span>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-stone-400" />
          <input placeholder="Search marker code or label"
                 value={searchQ} onChange={(e) => setSearchQ(e.target.value)}
                 data-testid="library-search"
                 className="pl-7 pr-3 py-1.5 border border-stone-300 rounded text-sm w-64" />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-stone-600">
          <input type="checkbox" checked={includeHidden}
                 onChange={(e) => setIncludeHidden(e.target.checked)}
                 data-testid="library-include-hidden" />
          Show hidden
        </label>
      </div>

      {err && (
        <div className="border border-red-200 bg-red-50 text-red-700 text-sm rounded p-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {err}
        </div>
      )}
      {loading && <div className="flex items-center gap-2 text-stone-500 text-sm py-6"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}

      {!loading && (
        <div className="border border-stone-200 rounded-lg overflow-hidden" data-testid="library-table">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-xs uppercase tracking-widest text-stone-500">
              <tr>
                <th className="text-left px-3 py-2">Marker</th>
                <th className="text-left px-3 py-2">Source</th>
                <th className="text-left px-3 py-2">Type</th>
                <th className="text-left px-3 py-2">Data field / formula</th>
                <th className="text-left px-3 py-2">Repeat</th>
                <th className="text-left px-3 py-2">Eligible types</th>
                <th className="text-right px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => (
                <tr key={m.id} className={`border-t border-stone-200 ${m.hidden ? "opacity-50" : ""}`}
                    data-testid={`library-row-${m.code}`}>
                  <td className="px-3 py-2">
                    <div>
                      <code className="font-mono text-stone-950">[[{m.code}]]</code>
                      {m.system_seeded && <span className="ml-1.5 inline-block px-1 py-0.5 rounded text-[9px] font-bold uppercase tracking-widest bg-stone-100 text-stone-500 border border-stone-200">seed</span>}
                    </div>
                    <div className="text-[11px] text-stone-500">{m.label}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest border ${VALUE_SOURCE_BADGES[m.value_source]}`}>{m.value_source.replace("_", " ")}</span>
                  </td>
                  <td className="px-3 py-2 text-stone-700">{m.data_type}</td>
                  <td className="px-3 py-2 text-stone-500 text-[11px]"><code>{m.data_field || m.formula || "—"}</code></td>
                  <td className="px-3 py-2 text-stone-700 text-[11px]">{m.repeat_allowed ? "yes" : "no"}</td>
                  <td className="px-3 py-2 text-stone-500 text-[11px]">
                    {(m.eligible_contract_types || []).length === CONTRACT_TYPES.length ? "All types" : (m.eligible_contract_types || []).join(", ")}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button onClick={() => setEditing(m)}
                              data-testid={`library-edit-${m.code}`}
                              className="p-1.5 rounded border border-stone-300 hover:bg-white text-stone-700 text-[11px]">Edit</button>
                      {m.hidden ? (
                        <button onClick={async () => { await api.post(`/admin/markers-library/${m.id}/unhide`); load(); }}
                                data-testid={`library-unhide-${m.code}`}
                                className="p-1.5 rounded border border-stone-300 hover:bg-white text-stone-700"><Eye className="w-3.5 h-3.5" /></button>
                      ) : (
                        <button onClick={async () => { await api.post(`/admin/markers-library/${m.id}/hide`); load(); }}
                                data-testid={`library-hide-${m.code}`}
                                className="p-1.5 rounded border border-stone-300 hover:bg-white text-stone-700"><EyeOff className="w-3.5 h-3.5" /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && (
        <MarkerEditor mode="create" onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(); }} />
      )}
      {editing && (
        <MarkerEditor mode="edit" marker={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
    </div>
  );
}


function MarkerEditor({ mode, marker, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    code: marker?.code || "",
    label: marker?.label || "",
    description: marker?.description || "",
    value_source: marker?.value_source || "manual",
    data_field: marker?.data_field || "",
    formula: marker?.formula || "",
    data_type: marker?.data_type || "string",
    repeat_allowed: marker?.repeat_allowed ?? false,
    eligible_contract_types: marker?.eligible_contract_types || CONTRACT_TYPES.map(t => t.value),
  }));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr(""); setBusy(true);
    try {
      const payload = { ...form };
      if (payload.value_source !== "automatic") payload.data_field = null;
      if (payload.value_source !== "calculated" && payload.value_source !== "system_generated") payload.formula = null;
      if (mode === "create") await api.post("/admin/markers-library", payload);
      else await api.patch(`/admin/markers-library/${marker.id}`, payload);
      onSaved?.();
    } catch (e) {
      setErr(e?.response?.data?.detail || "Save failed.");
    } finally { setBusy(false); }
  };

  const toggleType = (t) => {
    const next = form.eligible_contract_types.includes(t)
      ? form.eligible_contract_types.filter((x) => x !== t)
      : [...form.eligible_contract_types, t];
    setForm({ ...form, eligible_contract_types: next });
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4"
         role="dialog" data-testid="marker-editor">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between mb-4">
          <h2 className="font-display text-2xl text-stone-950">{mode === "create" ? "New marker" : `Edit ${marker?.code}`}</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-stone-100 rounded"><X className="w-4 h-4 text-stone-600" /></button>
        </div>
        <div className="space-y-3">
          {mode === "create" && (
            <Field label="Code (UPPER_SNAKE_CASE)">
              <input value={form.code}
                     onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                     data-testid="marker-editor-code"
                     placeholder="e.g. NEW_MARKER_NAME"
                     className="w-full px-3 py-2 border border-stone-300 rounded text-sm font-mono" />
            </Field>
          )}
          <Field label="Label"><input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })}
                                     data-testid="marker-editor-label"
                                     className="w-full px-3 py-2 border border-stone-300 rounded text-sm" /></Field>
          <Field label="Description">
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                      rows={2}
                      data-testid="marker-editor-description"
                      className="w-full px-3 py-2 border border-stone-300 rounded text-sm" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Value source">
              <select value={form.value_source} onChange={(e) => setForm({ ...form, value_source: e.target.value })}
                      data-testid="marker-editor-source"
                      className="w-full px-3 py-2 border border-stone-300 rounded text-sm">
                {VALUE_SOURCES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
              </select>
            </Field>
            <Field label="Data type">
              <select value={form.data_type} onChange={(e) => setForm({ ...form, data_type: e.target.value })}
                      data-testid="marker-editor-type"
                      className="w-full px-3 py-2 border border-stone-300 rounded text-sm">
                {DATA_TYPES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
          </div>
          {form.value_source === "automatic" && (
            <Field label="Data field (dot-path)">
              <input value={form.data_field} onChange={(e) => setForm({ ...form, data_field: e.target.value })}
                     data-testid="marker-editor-field"
                     placeholder="e.g. franchisees.mojo_email"
                     className="w-full px-3 py-2 border border-stone-300 rounded text-sm font-mono" />
            </Field>
          )}
          {(form.value_source === "calculated" || form.value_source === "system_generated") && (
            <Field label="Formula / default handler">
              <input value={form.formula} onChange={(e) => setForm({ ...form, formula: e.target.value })}
                     data-testid="marker-editor-formula"
                     placeholder="e.g. cm_year_franchise_ref"
                     className="w-full px-3 py-2 border border-stone-300 rounded text-sm font-mono" />
              <div className="text-[11px] text-stone-500 mt-1 flex items-center gap-1"><Info className="w-3 h-3" /> Named handlers are resolved by the engine at issue time.</div>
            </Field>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.repeat_allowed} onChange={(e) => setForm({ ...form, repeat_allowed: e.target.checked })}
                   data-testid="marker-editor-repeat" />
            Repeat allowed — this marker can appear more than once in a template
          </label>
          <Field label="Eligible contract types">
            <div className="flex flex-wrap gap-1.5">
              {CONTRACT_TYPES.map((t) => (
                <button
                  key={t.value}
                  onClick={() => toggleType(t.value)}
                  data-testid={`marker-editor-type-${t.value}`}
                  className={`px-2 py-1 rounded text-[11px] font-semibold border ${
                    form.eligible_contract_types.includes(t.value)
                      ? "bg-stone-950 text-white border-stone-950"
                      : "bg-white text-stone-600 border-stone-300"
                  }`}
                >{t.label}</button>
              ))}
            </div>
          </Field>

          {err && <div className="text-sm text-red-700 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> {err}</div>}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="px-3 py-2 border border-stone-300 rounded text-sm">Cancel</button>
            <button onClick={submit} disabled={busy}
                    data-testid="marker-editor-save"
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-bold uppercase tracking-widest bg-stone-950 text-white disabled:opacity-40">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-xs font-bold uppercase tracking-widest text-stone-600">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}
