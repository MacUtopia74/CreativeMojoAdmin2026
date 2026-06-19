/* eslint-disable react/no-unescaped-entities */
import { useEffect, useState } from "react";
import api from "@/lib/api";
import { Plus, Pencil, Trash2, Wand2, Beaker, Save, X, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

// CRM-side standard fields the admin can map. Mirrors STANDARD_FIELDS
// in /app/backend/gf_form_config_db.py — keep in sync.
const STD_FIELDS = [
  { key: "first_name", label: "First Name", help: "Use this OR Full Name. If a form uses a single 'Name' field, leave blank and use Full Name." },
  { key: "last_name",  label: "Last Name",  help: "Optional. Surname / family name." },
  { key: "full_name",  label: "Full Name",  help: "For forms with one combined 'Name' field (e.g. Form 33's 5.3). We'll split on whitespace." },
  { key: "email",      label: "Email",      help: "REQUIRED. Used to deduplicate against existing CRM records." },
  { key: "phone",      label: "Phone",      help: "Optional." },
  { key: "postcode",   label: "Postcode",   help: "Optional." },
  { key: "message",    label: "Message / Notes", help: "Optional. Free-text enquiry body." },
];

// Display labels for the source dropdown. Mirrors KNOWN_SOURCES.
const SOURCE_OPTIONS = [
  { value: "franchise_enquiry",  label: "Franchise",         in_pipeline: true,  badge: "FRANCHISE" },
  { value: "licence_enquiry",    label: "Licence",           in_pipeline: true,  badge: "LICENCE" },
  { value: "care_home_enquiry",  label: "Care Home",         in_pipeline: false, badge: "CARE HOME" },
  { value: "art_kit_enquiry",    label: "Art Kit",           in_pipeline: false, badge: "ART KIT" },
  { value: "general_enquiry",    label: "General (no pipeline)", in_pipeline: false, badge: "GENERAL" },
];

const empty = () => ({
  form_id: "",
  form_title: "",
  source: "franchise_enquiry",
  in_pipeline: true,
  field_map: { first_name: "", last_name: "", full_name: "", email: "", phone: "", postcode: "", message: "" },
});

const Pill = ({ children, tone = "stone" }) => {
  const tones = {
    stone: "bg-stone-100 text-stone-700 border-stone-200",
    green: "bg-emerald-50 text-emerald-800 border-emerald-200",
    amber: "bg-amber-50 text-amber-800 border-amber-200",
    red:   "bg-red-50 text-red-800 border-red-200",
  };
  return <span className={`px-2 py-0.5 text-[10px] uppercase tracking-wider font-bold border rounded-md ${tones[tone]}`}>{children}</span>;
};

export default function ManageFormsPanel({ onAfterChange }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);    // form_config being edited, or empty() for new
  const [previewing, setPreviewing] = useState(null); // form_id currently previewed
  const [previewData, setPreviewData] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = async () => {
    setLoading(true); setErr("");
    try {
      const { data } = await api.get("/intake/forms-config");
      setRows(data.configs || []);
    } catch (e) {
      setErr("Could not load form configs.");
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const startEdit = (row) => setEditing({ ...empty(), ...row, field_map: { ...empty().field_map, ...(row?.field_map || {}) } });
  const startAdd = () => setEditing(empty());
  const cancel = () => setEditing(null);

  const save = async () => {
    if (!editing.form_id) { setErr("Form ID is required."); return; }
    const payload = { ...editing, form_id: Number(editing.form_id) };
    payload.in_pipeline = SOURCE_OPTIONS.find(s => s.value === editing.source)?.in_pipeline ?? editing.in_pipeline;
    try {
      const existing = rows.find(r => Number(r.form_id) === payload.form_id);
      if (existing) {
        await api.put(`/intake/forms-config/${payload.form_id}`, payload);
      } else {
        await api.post(`/intake/forms-config`, payload);
      }
      setEditing(null); setErr("");
      await load();
      if (onAfterChange) onAfterChange();
    } catch (e) {
      setErr(`Save failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const remove = async (form_id) => {
    if (!window.confirm(`Remove Form ${form_id} from intake config? This stops the backfill from pulling it. Reversible — just re-add it.`)) return;
    try {
      await api.delete(`/intake/forms-config/${form_id}`);
      await load();
      if (onAfterChange) onAfterChange();
    } catch (e) {
      setErr(`Delete failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  // Autodetect field IDs by calling the discover endpoint
  const autodetect = async () => {
    const fid = Number(editing.form_id);
    if (!fid) { setErr("Enter the Form ID first."); return; }
    try {
      const { data } = await api.get(`/intake/forms-config/${fid}/discover`);
      const guesses = data.guessed_field_map || {};
      const fm = { ...editing.field_map };
      for (const k of Object.keys(empty().field_map)) {
        if (!fm[k] && guesses[k]) fm[k] = guesses[k];
      }
      setEditing(prev => ({
        ...prev,
        form_title: prev.form_title || data.form_title || prev.form_title,
        field_map: fm,
      }));
      setErr("");
    } catch (e) {
      setErr(`Auto-detect failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  // Dry-run preview using the *current* form values (unsaved OK)
  const runPreview = async (row) => {
    setPreviewBusy(true);
    setPreviewing(row.form_id);
    setPreviewData(null);
    try {
      const payload = row.form_id ? row : editing;
      const { data } = await api.post(`/intake/forms-config/${payload.form_id}/preview`, payload || {});
      setPreviewData(data);
    } catch (e) {
      setPreviewData({ ok: false, error: e?.response?.data?.detail || e.message });
    } finally { setPreviewBusy(false); }
  };

  const closePreview = () => { setPreviewing(null); setPreviewData(null); };

  const tonForOutcome = (oc) => {
    if (oc === "would_insert" || oc === "would_promote_existing") return "green";
    if (oc === "skip_already_active") return "amber";
    if (oc === "would_insert_or_update_non_pipeline") return "stone";
    if (oc === "already_in_db") return "stone";
    return "red";
  };

  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid="panel-manage-forms">
      <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wand2 className="w-3.5 h-3.5 text-stone-500" />
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Manage Gravity Forms</div>
        </div>
        <button onClick={startAdd} disabled={!!editing}
          data-testid="btn-add-form"
          className="px-3 py-1.5 bg-stone-950 text-white text-[10px] font-bold uppercase tracking-wider rounded-md hover:bg-stone-800 disabled:opacity-50 flex items-center gap-1.5">
          <Plus className="w-3 h-3" /> Add form
        </button>
      </div>

      <div className="p-5 space-y-4">
        {err && (
          <div className="px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-900 text-xs flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5" /> {err}
          </div>
        )}

        {loading && <div className="text-xs text-stone-500 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</div>}

        {/* ---- LIST ---- */}
        {!editing && (
          <div className="border border-stone-200 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-stone-50">
                <tr className="text-left">
                  <th className="px-3 py-2 font-bold uppercase tracking-wider text-[10px] text-stone-500">Form ID</th>
                  <th className="px-3 py-2 font-bold uppercase tracking-wider text-[10px] text-stone-500">Title</th>
                  <th className="px-3 py-2 font-bold uppercase tracking-wider text-[10px] text-stone-500">Category</th>
                  <th className="px-3 py-2 font-bold uppercase tracking-wider text-[10px] text-stone-500">Pipeline?</th>
                  <th className="px-3 py-2 font-bold uppercase tracking-wider text-[10px] text-stone-500">Field map</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-stone-500">No forms configured yet. Click <span className="font-bold">Add form</span> to configure one.</td></tr>
                )}
                {rows.map(r => {
                  const src = SOURCE_OPTIONS.find(s => s.value === r.source);
                  return (
                    <tr key={r.form_id} className="border-t border-stone-200" data-testid={`row-form-${r.form_id}`}>
                      <td className="px-3 py-3 font-mono tabular-nums">#{r.form_id}</td>
                      <td className="px-3 py-3">{r.form_title || <span className="text-stone-400 italic">untitled</span>}</td>
                      <td className="px-3 py-3"><Pill tone={r.in_pipeline ? "green" : "stone"}>{src?.badge || r.source}</Pill></td>
                      <td className="px-3 py-3">{r.in_pipeline ? <Pill tone="green">In pipeline</Pill> : <Pill tone="stone">Contacts only</Pill>}</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1 text-[10px] text-stone-600">
                          {STD_FIELDS.filter(f => r.field_map?.[f.key]).map(f => (
                            <span key={f.key} className="px-1.5 py-0.5 bg-stone-100 rounded border border-stone-200">
                              <span className="font-bold">{f.label}</span>:&nbsp;<span className="font-mono">{r.field_map[f.key]}</span>
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        <button onClick={() => runPreview(r)} data-testid={`btn-preview-form-${r.form_id}`}
                          className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-md mr-1 inline-flex items-center gap-1">
                          <Beaker className="w-3 h-3" /> Preview
                        </button>
                        <button onClick={() => startEdit(r)} data-testid={`btn-edit-form-${r.form_id}`}
                          className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-md mr-1 inline-flex items-center gap-1">
                          <Pencil className="w-3 h-3" /> Edit
                        </button>
                        <button onClick={() => remove(r.form_id)} data-testid={`btn-delete-form-${r.form_id}`}
                          className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider border border-red-300 text-red-800 hover:bg-red-50 rounded-md inline-flex items-center gap-1">
                          <Trash2 className="w-3 h-3" /> Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ---- EDIT / ADD FORM ---- */}
        {editing && (
          <div className="border border-stone-300 rounded-xl p-4 bg-stone-50/50 space-y-3" data-testid="form-editor">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <label className="block">
                <div className="text-[10px] uppercase tracking-wider font-bold text-stone-600 mb-1">Form ID (GF)</div>
                <input type="number" value={editing.form_id}
                  onChange={e => setEditing({ ...editing, form_id: e.target.value })}
                  data-testid="input-form-id"
                  className="w-full px-2 py-1.5 text-sm border border-stone-300 rounded-md" />
              </label>
              <label className="block">
                <div className="text-[10px] uppercase tracking-wider font-bold text-stone-600 mb-1">Title (optional)</div>
                <input value={editing.form_title || ""}
                  onChange={e => setEditing({ ...editing, form_title: e.target.value })}
                  data-testid="input-form-title"
                  className="w-full px-2 py-1.5 text-sm border border-stone-300 rounded-md"
                  placeholder="e.g. Franchise Enquiry (Long Form)" />
              </label>
              <label className="block">
                <div className="text-[10px] uppercase tracking-wider font-bold text-stone-600 mb-1">Category / Pipeline type</div>
                <select value={editing.source}
                  onChange={e => {
                    const src = SOURCE_OPTIONS.find(s => s.value === e.target.value);
                    setEditing({ ...editing, source: e.target.value, in_pipeline: src?.in_pipeline ?? false });
                  }}
                  data-testid="select-form-source"
                  className="w-full px-2 py-1.5 text-sm border border-stone-300 rounded-md bg-white">
                  {SOURCE_OPTIONS.map(s => (
                    <option key={s.value} value={s.value}>{s.label} {s.in_pipeline ? "(pipeline)" : "(contacts only)"}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex items-center gap-2">
              <button onClick={autodetect}
                data-testid="btn-autodetect-fields"
                className="px-3 py-1.5 bg-white border border-stone-300 hover:bg-stone-50 text-[10px] font-bold uppercase tracking-wider rounded-md inline-flex items-center gap-1.5">
                <Wand2 className="w-3 h-3" /> Auto-detect fields from Gravity Forms
              </button>
              <span className="text-[11px] text-stone-500">Pulls the live form metadata + a sample entry, then prefills any blank rows below.</span>
            </div>

            <div className="border border-stone-200 rounded-md overflow-hidden bg-white">
              <table className="w-full text-xs">
                <thead className="bg-stone-50">
                  <tr className="text-left">
                    <th className="px-3 py-2 text-[10px] uppercase tracking-wider font-bold text-stone-500 w-40">CRM Field</th>
                    <th className="px-3 py-2 text-[10px] uppercase tracking-wider font-bold text-stone-500 w-40">Gravity Forms ID</th>
                    <th className="px-3 py-2 text-[10px] uppercase tracking-wider font-bold text-stone-500">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {STD_FIELDS.map(f => (
                    <tr key={f.key} className="border-t border-stone-100">
                      <td className="px-3 py-2 font-bold">{f.label}{f.key === "email" && <span className="text-red-600 ml-0.5">*</span>}</td>
                      <td className="px-3 py-2">
                        <input value={editing.field_map[f.key] || ""}
                          onChange={e => setEditing({ ...editing, field_map: { ...editing.field_map, [f.key]: e.target.value } })}
                          data-testid={`input-field-${f.key}`}
                          placeholder="e.g. 4 or 5.3"
                          className="w-full px-2 py-1 text-xs border border-stone-300 rounded font-mono" />
                      </td>
                      <td className="px-3 py-2 text-stone-500 text-[11px] leading-tight">{f.help}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between pt-2">
              <button onClick={() => runPreview(editing)}
                disabled={!editing.form_id}
                data-testid="btn-test-import"
                className="px-3 py-1.5 bg-white border border-stone-300 hover:bg-stone-50 text-[10px] font-bold uppercase tracking-wider rounded-md inline-flex items-center gap-1.5 disabled:opacity-50">
                <Beaker className="w-3 h-3" /> Test import / preview
              </button>
              <div className="flex items-center gap-2">
                <button onClick={cancel}
                  data-testid="btn-cancel-edit"
                  className="px-3 py-1.5 bg-white border border-stone-300 hover:bg-stone-50 text-[10px] font-bold uppercase tracking-wider rounded-md inline-flex items-center gap-1.5">
                  <X className="w-3 h-3" /> Cancel
                </button>
                <button onClick={save}
                  data-testid="btn-save-form"
                  className="px-3 py-1.5 bg-stone-950 text-white hover:bg-stone-800 text-[10px] font-bold uppercase tracking-wider rounded-md inline-flex items-center gap-1.5">
                  <Save className="w-3 h-3" /> Save
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ---- PREVIEW MODAL (inline panel) ---- */}
        {previewing !== null && (
          <div className="border border-emerald-300 rounded-xl p-4 bg-emerald-50/40 space-y-3" data-testid="preview-panel">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Beaker className="w-4 h-4 text-emerald-700" />
                <span className="text-xs font-bold uppercase tracking-wider text-emerald-900">Preview — Form {previewing}</span>
                <span className="text-[11px] text-stone-600">(dry-run, nothing imported)</span>
              </div>
              <button onClick={closePreview} className="text-stone-500 hover:text-stone-900" data-testid="btn-close-preview">
                <X className="w-4 h-4" />
              </button>
            </div>
            {previewBusy && <div className="text-xs text-stone-500 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Fetching latest entries from Gravity Forms…</div>}
            {previewData && !previewData.ok && (
              <div className="text-xs text-red-700">{previewData.error}</div>
            )}
            {previewData?.ok && (
              <>
                <div className="text-xs text-stone-700">
                  Summary: {Object.entries(previewData.summary || {}).map(([k, v]) => `${k}=${v}`).join(", ") || "no entries"}
                </div>
                <div className="border border-emerald-200 rounded-md overflow-x-auto bg-white">
                  <table className="w-full text-xs">
                    <thead className="bg-emerald-50">
                      <tr className="text-left">
                        <th className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-stone-600">Entry</th>
                        <th className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-stone-600">Name</th>
                        <th className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-stone-600">Email</th>
                        <th className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-stone-600">Phone</th>
                        <th className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-stone-600">Postcode</th>
                        <th className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-stone-600">Category</th>
                        <th className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-stone-600">Outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(previewData.preview || []).map(r => (
                        <tr key={r.entry_id} className="border-t border-emerald-100">
                          <td className="px-3 py-2 font-mono tabular-nums">#{r.entry_id}</td>
                          <td className="px-3 py-2">{r.name || <span className="text-red-600">— missing —</span>}</td>
                          <td className="px-3 py-2 text-stone-600">{r.email || <span className="text-red-600">— missing —</span>}</td>
                          <td className="px-3 py-2 text-stone-600">{r.phone || "—"}</td>
                          <td className="px-3 py-2 text-stone-600">{r.postcode || "—"}</td>
                          <td className="px-3 py-2"><Pill tone={r.in_pipeline ? "green" : "stone"}>{r.source}</Pill></td>
                          <td className="px-3 py-2"><Pill tone={tonForOutcome(r.outcome)}>{r.outcome}</Pill></td>
                        </tr>
                      ))}
                      {(previewData.preview || []).length === 0 && (
                        <tr><td colSpan={7} className="px-3 py-6 text-center text-stone-500">No entries from Gravity Forms yet — submit a test entry on your site, then click Preview again.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="text-[11px] text-stone-500 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> When you Save, this form will be included in <span className="font-bold">Refresh from Gravity Forms</span> + the every-10-minute scheduled backfill.
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
