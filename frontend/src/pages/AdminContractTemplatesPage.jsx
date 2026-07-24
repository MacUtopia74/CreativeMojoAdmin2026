// Admin — Contract Templates list (Phase 1A, fixed-PDF marker approach).
// Scope: upload PDF → deterministic marker detection → library reconciliation.
// No editor, no personalised generation, no issuance.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "@/lib/api";
import {
  FileText, Upload, Loader2, AlertTriangle, CheckCircle2, Archive,
  Copy, Pencil, Star, StarOff, X, Check, ExternalLink,
} from "lucide-react";

const CONTRACT_TYPES = [
  { value: "new_franchise",       label: "New franchise" },
  { value: "franchise_renewal",   label: "Franchise renewal" },
  { value: "licence",             label: "Licence" },
  { value: "licence_renewal",     label: "Licence renewal" },
  { value: "territory_amendment", label: "Territory amendment" },
  { value: "other",               label: "Other" },
];
const CONTRACT_TYPE_LABEL = Object.fromEntries(CONTRACT_TYPES.map((t) => [t.value, t.label]));

const STATUS_STYLES = {
  draft:    "bg-stone-100 text-stone-700 border-stone-300",
  current:  "bg-emerald-50 text-emerald-800 border-emerald-300",
  archived: "bg-stone-50 text-stone-400 border-stone-200",
};

function formatDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }); }
  catch { return iso; }
}

const STAGES = [
  { code: "uploading",         label: "Uploading PDF" },
  { code: "extracting-text",   label: "Extracting text" },
  { code: "detecting-markers", label: "Detecting markers" },
  { code: "validating",        label: "Validating against library" },
  { code: "creating",          label: "Creating template record" },
  { code: "complete",          label: "Complete" },
];

export default function AdminContractTemplatesPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [showUpload, setShowUpload] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (typeFilter) params.contract_type = typeFilter;
      const { data } = await api.get("/admin/contract-templates", { params });
      setItems(data.items || []);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Failed to load templates.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5" data-testid="admin-contract-templates">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-3xl text-stone-950">Contract templates</h1>
          <p className="text-sm text-stone-500 mt-1 max-w-2xl">
            Upload the approved fixed PDF exported from Word. The Hub detects every <code className="text-xs bg-stone-100 rounded px-1">[[MARKER]]</code>,
            records its position, and reconciles the set against the Marker Library. Nothing else about the PDF is altered.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="upload-pdf-btn"
            onClick={() => setShowUpload(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold uppercase tracking-widest rounded-lg bg-stone-950 text-white hover:bg-stone-800"
          >
            <Upload className="w-4 h-4" /> Upload PDF
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="text-xs font-bold uppercase tracking-widest text-stone-500 mr-1">Status:</div>
        {["", "draft", "current", "archived"].map((s) => (
          <button
            key={s || "all"}
            data-testid={`status-filter-${s || "all"}`}
            onClick={() => setStatusFilter(s)}
            className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${
              statusFilter === s ? "bg-stone-950 text-white border-stone-950" : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"
            }`}
          >
            {s === "" ? "All" : s}
          </button>
        ))}
        <div className="text-xs font-bold uppercase tracking-widest text-stone-500 ml-4 mr-1">Type:</div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          data-testid="type-filter"
          className="px-2 py-1 text-xs rounded border border-stone-300"
        >
          <option value="">All types</option>
          {CONTRACT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>

      {err && (
        <div className="border border-red-200 bg-red-50 text-red-700 text-sm rounded p-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {err}
        </div>
      )}

      {loading && items.length === 0 && (
        <div className="flex items-center gap-2 text-stone-500 text-sm py-8"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      )}

      {!loading && items.length === 0 && (
        <div className="border border-dashed border-stone-300 rounded-lg p-10 text-center">
          <FileText className="w-8 h-8 mx-auto text-stone-400" />
          <p className="mt-2 text-sm text-stone-500">No contract templates yet. Upload the approved fixed PDF exported from Word to get started.</p>
        </div>
      )}

      {items.length > 0 && (
        <div className="border border-stone-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-xs uppercase tracking-widest text-stone-500">
              <tr>
                <th className="text-left px-4 py-2">Template</th>
                <th className="text-left px-4 py-2">Type</th>
                <th className="text-left px-4 py-2">Status</th>
                <th className="text-left px-4 py-2">Marker summary</th>
                <th className="text-left px-4 py-2">Version</th>
                <th className="text-left px-4 py-2">Updated</th>
                <th className="text-right px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => <TemplateRow key={t.id} t={t} onChanged={load} navigate={navigate} />)}
            </tbody>
          </table>
        </div>
      )}

      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onCreated={(id) => { setShowUpload(false); navigate(`/admin/contracts/templates/${id}`); }}
          onRefresh={load}
        />
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Template row
// ---------------------------------------------------------------------------
function TemplateRow({ t, onChanged, navigate }) {
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(t.name);

  const summary = t.marker_summary || {};
  const ready = summary.ready_for_approval;
  const bg = ready ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-amber-50 text-amber-800 border-amber-200";
  const detected = summary.total_occurrences ?? 0;
  const unrecognised = (summary.unrecognised || []).length;
  const dup = (summary.duplicate_offenders || []).length;
  const cle = summary.cross_line_errors_count ?? 0;

  const wrap = async (fn) => {
    setBusy(true);
    try { await fn(); await onChanged?.(); } finally { setBusy(false); }
  };

  return (
    <tr className="border-t border-stone-200 hover:bg-stone-50">
      <td className="px-4 py-2">
        {renaming ? (
          <div className="flex items-center gap-1.5">
            <input value={name} onChange={(e) => setName(e.target.value)}
                   data-testid={`rename-input-${t.id}`}
                   className="px-2 py-1 text-sm border border-stone-300 rounded w-64" />
            <button
              data-testid={`rename-save-${t.id}`}
              onClick={() => wrap(async () => { await api.patch(`/admin/contract-templates/${t.id}`, { name }); setRenaming(false); })}
              className="p-1.5 rounded bg-stone-950 text-white"><Check className="w-3.5 h-3.5" /></button>
            <button onClick={() => { setName(t.name); setRenaming(false); }} className="p-1.5 rounded border border-stone-300"><X className="w-3.5 h-3.5" /></button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              data-testid={`open-template-${t.id}`}
              onClick={() => navigate(`/admin/contracts/templates/${t.id}`)}
              className="text-stone-950 hover:underline font-medium"
            >
              {t.name}
            </button>
            {t.is_default && <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-amber-800 bg-amber-100 border border-amber-200 rounded px-1.5 py-0.5"><Star className="w-3 h-3 fill-current" /> default</span>}
          </div>
        )}
      </td>
      <td className="px-4 py-2 text-stone-600">{CONTRACT_TYPE_LABEL[t.contract_type] || t.contract_type}</td>
      <td className="px-4 py-2">
        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest border ${STATUS_STYLES[t.status] || STATUS_STYLES.draft}`}>{t.status}</span>
      </td>
      <td className="px-4 py-2">
        <span data-testid={`marker-summary-${t.id}`} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border ${bg}`}>
          {ready ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
          {detected} detected · {(summary.recognised || []).length} recognised
          {unrecognised > 0 && <> · <span className="text-red-700">{unrecognised} unknown</span></>}
          {dup > 0 && <> · <span className="text-red-700">{dup} duplicate</span></>}
          {cle > 0 && <> · <span className="text-red-700">{cle} cross-line</span></>}
        </span>
      </td>
      <td className="px-4 py-2 text-stone-600">v{t.current_version || 1}</td>
      <td className="px-4 py-2 text-stone-500 text-xs">{formatDate(t.updated_at)}</td>
      <td className="px-4 py-2 text-right">
        <div className="inline-flex items-center gap-1">
          <button title="Rename" data-testid={`rename-btn-${t.id}`}
                  onClick={() => setRenaming(true)} className="p-1.5 rounded border border-stone-300 hover:bg-white"><Pencil className="w-3.5 h-3.5 text-stone-600" /></button>
          {!t.is_default && (
            <button title="Set as default" data-testid={`default-btn-${t.id}`}
                    disabled={busy}
                    onClick={() => wrap(() => api.post(`/admin/contract-templates/${t.id}/set-default`))}
                    className="p-1.5 rounded border border-stone-300 hover:bg-white"><StarOff className="w-3.5 h-3.5 text-stone-600" /></button>
          )}
          <button title="Duplicate" data-testid={`duplicate-btn-${t.id}`}
                  disabled={busy}
                  onClick={() => wrap(async () => { const { data } = await api.post(`/admin/contract-templates/${t.id}/duplicate`); navigate(`/admin/contracts/templates/${data.id}`); })}
                  className="p-1.5 rounded border border-stone-300 hover:bg-white"><Copy className="w-3.5 h-3.5 text-stone-600" /></button>
          {t.status !== "current" && ready && (
            <button title="Publish (make current)" data-testid={`publish-btn-${t.id}`}
                    disabled={busy}
                    onClick={() => wrap(() => api.post(`/admin/contract-templates/${t.id}/publish`))}
                    className="px-2 py-1 rounded bg-emerald-600 text-white text-[11px] font-bold uppercase tracking-widest">Publish</button>
          )}
          {t.status !== "archived" && (
            <button title="Archive" data-testid={`archive-btn-${t.id}`}
                    disabled={busy}
                    onClick={() => wrap(() => api.post(`/admin/contract-templates/${t.id}/archive`))}
                    className="p-1.5 rounded border border-stone-300 hover:bg-white"><Archive className="w-3.5 h-3.5 text-stone-600" /></button>
          )}
        </div>
      </td>
    </tr>
  );
}


// ---------------------------------------------------------------------------
// Upload modal — PDF only, staged progress polling.
// ---------------------------------------------------------------------------
function UploadModal({ onClose, onCreated, onRefresh }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("franchise_renewal");
  const [file, setFile] = useState(null);
  const [err, setErr] = useState("");
  const [job, setJob] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);

  const start = async () => {
    setErr("");
    if (!file) { setErr("Please choose a PDF file."); return; }
    if (!file.name.toLowerCase().endsWith(".pdf")) { setErr("Only PDF files are supported."); return; }
    if (!name.trim()) { setErr("Please give the template a name."); return; }
    const fd = new FormData();
    fd.append("pdf", file);
    fd.append("name", name.trim());
    fd.append("contract_type", type);
    try {
      const { data } = await api.post("/admin/contract-templates/upload-marker-pdf", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setJob(data);
      poll(data.job_id);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Failed to start upload.");
    }
  };

  const poll = (jobId) => {
    let failures = 0;
    const tick = async () => {
      try {
        const { data } = await api.get(`/admin/contract-templates/upload-jobs/${jobId}`);
        failures = 0;
        setJob(data);
        if (data.status === "complete" && data.template_id) {
          onRefresh?.();
          setTimeout(() => onCreated?.(data.template_id), 400);
          return;
        }
        if (data.status === "failed") return;
        pollRef.current = setTimeout(tick, 1500);
      } catch {
        failures += 1;
        if (failures >= 5) {
          setErr("Temporarily lost connection to the conversion job — refresh the list in a minute.");
          return;
        }
        pollRef.current = setTimeout(tick, 3000);
      }
    };
    tick();
  };

  const running = job && job.status === "running";
  const complete = job && job.status === "complete";
  const failed = job && job.status === "failed";
  const currentStageIdx = job ? STAGES.findIndex((s) => s.code === job.stage) : -1;

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4"
         role="dialog" data-testid="upload-modal">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="font-display text-2xl text-stone-950">Upload contract PDF</h2>
            <p className="text-xs text-stone-500 mt-1">
              Upload the approved PDF exported from Word. The Hub will detect every <code className="bg-stone-100 rounded px-1">[[MARKER]]</code> and record its position — nothing else about the PDF is altered.
            </p>
          </div>
          <button onClick={onClose} data-testid="upload-close" className="p-1.5 hover:bg-stone-100 rounded">
            <X className="w-4 h-4 text-stone-600" />
          </button>
        </div>

        {!job && (
          <div className="space-y-3">
            <div>
              <label className="text-xs font-bold uppercase tracking-widest text-stone-600">Template name</label>
              <input value={name} onChange={(e) => setName(e.target.value)}
                     data-testid="upload-name" placeholder="e.g. Franchise renewal — 2026"
                     className="mt-1 w-full px-3 py-2 border border-stone-300 rounded text-sm" />
            </div>
            <div>
              <label className="text-xs font-bold uppercase tracking-widest text-stone-600">Contract type</label>
              <select value={type} onChange={(e) => setType(e.target.value)} data-testid="upload-type"
                      className="mt-1 w-full px-3 py-2 border border-stone-300 rounded text-sm">
                {CONTRACT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-bold uppercase tracking-widest text-stone-600">PDF file</label>
              <input type="file" accept="application/pdf,.pdf"
                     data-testid="upload-file"
                     onChange={(e) => {
                       const f = e.target.files?.[0];
                       setFile(f || null);
                       if (f && !name) setName(f.name.replace(/\.pdf$/i, ""));
                     }}
                     className="mt-1 w-full text-sm" />
              {file && (
                <div className="text-[11px] text-stone-500 mt-1">{file.name} · {(file.size / 1024).toFixed(1)} KB</div>
              )}
            </div>
            {err && (
              <div className="text-sm text-red-700 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" /> {err}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={onClose} className="px-3 py-2 border border-stone-300 rounded text-sm">Cancel</button>
              <button onClick={start} data-testid="upload-start"
                      className="px-3 py-2 rounded text-sm font-bold uppercase tracking-widest bg-stone-950 text-white">Start upload</button>
            </div>
          </div>
        )}

        {job && (
          <div className="space-y-4" data-testid="upload-progress">
            <div className="h-2 bg-stone-100 rounded overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${failed ? "bg-red-500" : complete ? "bg-emerald-500" : "bg-stone-950"}`}
                style={{ width: `${Math.max(4, job.progress || 0)}%` }}
                data-testid="upload-progress-bar" />
            </div>
            <ol className="space-y-1.5" data-testid="upload-stage-list">
              {STAGES.map((s, i) => {
                const done = !failed && (complete || currentStageIdx > i);
                const active = !failed && !complete && currentStageIdx === i;
                return (
                  <li key={s.code}
                      data-testid={`upload-stage-${s.code}`}
                      className={`flex items-center gap-2 text-sm ${
                        done ? "text-emerald-700" : active ? "text-stone-950 font-semibold" : "text-stone-400"
                      }`}>
                    {done ? <Check className="w-4 h-4 text-emerald-600" />
                      : active ? <Loader2 className="w-4 h-4 animate-spin" />
                      : failed ? <X className="w-4 h-4 text-stone-300" />
                      : <span className="inline-block w-4 h-4 rounded-full border border-stone-300" />}
                    {s.label}
                  </li>
                );
              })}
              {failed && (
                <li className="flex items-center gap-2 text-sm text-red-700 font-semibold">
                  <AlertTriangle className="w-4 h-4" /> Failed
                </li>
              )}
            </ol>
            {failed && job.error && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">{job.error}</div>
            )}
            {complete && (
              <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" /> Template ready. Opening summary…
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              {failed && (
                <button onClick={() => { setJob(null); setErr(""); }}
                        data-testid="upload-retry"
                        className="px-3 py-2 rounded text-sm font-bold uppercase tracking-widest bg-stone-950 text-white">
                  Try again
                </button>
              )}
              {!complete && (
                <button onClick={onClose}
                        className="px-3 py-2 border border-stone-300 rounded text-sm">
                  {running ? "Close (job continues)" : "Close"}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
