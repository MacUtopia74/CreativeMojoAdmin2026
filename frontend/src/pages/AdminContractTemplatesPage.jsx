// Admin — Contract Templates list.
// Phase 1A only: template CRUD + PDF upload + status/default toggles.
// Contract issuance / signing lands in later phases.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api from "@/lib/api";
import {
  FileText, Plus, Upload, Loader2, AlertTriangle, CheckCircle2, Archive,
  Copy, Pencil, Star, StarOff, X, Check,
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

function StatusPill({ status }) {
  return (
    <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest rounded border ${STATUS_STYLES[status] || STATUS_STYLES.draft}`}>
      {status || "draft"}
    </span>
  );
}

function DefaultPill({ isDefault }) {
  if (!isDefault) return null;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest rounded bg-amber-100 text-amber-800 border border-amber-300">
      <Star className="w-3 h-3" /> Default
    </span>
  );
}

export default function AdminContractTemplatesPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [showBlank, setShowBlank] = useState(false);
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

  const filtered = useMemo(() => items, [items]);

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-6" data-testid="admin-contracts-page">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl text-stone-950 flex items-center gap-2">
            <FileText className="w-7 h-7 text-stone-700" /> Contract Templates
          </h1>
          <p className="text-sm text-stone-600 mt-1 max-w-2xl">
            Master library of Creative Mojo legal templates. Upload an existing PDF to convert it into an
            editable HTML template, or start blank. Issued contracts are drafted from these templates in
            a later phase.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="upload-pdf-btn"
            onClick={() => setShowUpload(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold uppercase tracking-widest rounded-lg bg-stone-950 text-white hover:bg-stone-800"
          >
            <Upload className="w-4 h-4" /> Upload PDF
          </button>
          <button
            type="button"
            data-testid="new-blank-btn"
            onClick={() => setShowBlank(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold uppercase tracking-widest rounded-lg bg-white text-stone-800 border border-stone-300 hover:bg-stone-50"
          >
            <Plus className="w-4 h-4" /> New blank
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center border-b border-stone-200 pb-3">
        <label className="text-xs font-bold uppercase tracking-widest text-stone-600 mr-2">Filter:</label>
        {["", "draft", "current", "archived"].map((s) => (
          <button
            key={s || "all"}
            type="button"
            data-testid={`filter-status-${s || "all"}`}
            onClick={() => setStatusFilter(s)}
            className={`px-2 py-1 rounded border text-[11px] font-bold uppercase tracking-widest ${
              statusFilter === s
                ? "bg-stone-950 text-white border-stone-950"
                : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"
            }`}
          >
            {s ? s : "All"}
          </button>
        ))}
        <span className="w-px h-6 bg-stone-200 mx-1" />
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          data-testid="filter-type"
          className="px-2 py-1 border border-stone-300 rounded text-xs"
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

      {/* Table */}
      <div className="border border-stone-200 rounded-xl bg-white overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-stone-500 text-sm">
            <Loader2 className="inline w-4 h-4 animate-spin mr-1" /> Loading templates…
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-stone-500 text-sm">
            No templates yet. Upload a PDF or click &ldquo;New blank&rdquo; to get started.
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-stone-50 border-b border-stone-200">
              <tr>
                <th className="text-left px-4 py-2 text-[10px] uppercase tracking-widest font-bold text-stone-600">Name</th>
                <th className="text-left px-4 py-2 text-[10px] uppercase tracking-widest font-bold text-stone-600">Type</th>
                <th className="text-left px-4 py-2 text-[10px] uppercase tracking-widest font-bold text-stone-600">Status</th>
                <th className="text-left px-4 py-2 text-[10px] uppercase tracking-widest font-bold text-stone-600">Version</th>
                <th className="text-left px-4 py-2 text-[10px] uppercase tracking-widest font-bold text-stone-600">Conversion</th>
                <th className="text-left px-4 py-2 text-[10px] uppercase tracking-widest font-bold text-stone-600">Updated</th>
                <th className="text-right px-4 py-2 text-[10px] uppercase tracking-widest font-bold text-stone-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <TemplateRow key={t.id} t={t} onChange={load} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showBlank && <BlankModal onClose={() => setShowBlank(false)} onCreated={(id) => navigate(`/admin/contracts/templates/${id}`)} />}
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

function TemplateRow({ t, onChange }) {
  const [busy, setBusy] = useState(false);
  const setDefault = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/contract-templates/${t.id}/set-default`, { is_default: !t.is_default });
      onChange();
    } catch (e) {
      window.alert(e?.response?.data?.detail || "Failed to change default.");
    } finally { setBusy(false); }
  };
  const archive = async () => {
    if (!window.confirm("Archive this template? It will disappear from active lists.")) return;
    setBusy(true);
    try { await api.post(`/admin/contract-templates/${t.id}/archive`); onChange(); }
    catch (e) { window.alert(e?.response?.data?.detail || "Failed."); }
    finally { setBusy(false); }
  };
  const duplicate = async () => {
    setBusy(true);
    try { const { data } = await api.post(`/admin/contract-templates/${t.id}/duplicate`); onChange(); window.location.href = `/admin/contracts/templates/${data.id}`; }
    catch (e) { window.alert(e?.response?.data?.detail || "Failed."); }
    finally { setBusy(false); }
  };

  return (
    <tr className="border-b border-stone-100 hover:bg-stone-50" data-testid={`template-row-${t.id}`}>
      <td className="px-4 py-3">
        <Link to={`/admin/contracts/templates/${t.id}`} className="text-sm font-semibold text-stone-900 hover:underline">
          {t.name || "(untitled)"}
        </Link>
        <div className="flex items-center gap-1.5 mt-1">
          <DefaultPill isDefault={t.is_default} />
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-stone-700">{CONTRACT_TYPE_LABEL[t.contract_type] || t.contract_type}</td>
      <td className="px-4 py-3"><StatusPill status={t.status} /></td>
      <td className="px-4 py-3 text-sm tabular-nums">v{t.current_version || 0}</td>
      <td className="px-4 py-3 text-sm">
        {t.conversion_approved ? (
          <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" /> Approved</span>
        ) : (
          <span className="text-stone-500">Review pending</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-stone-500 tabular-nums">{formatDate(t.updated_at)}</td>
      <td className="px-4 py-3 text-right">
        <div className="inline-flex items-center gap-1">
          <button disabled={busy || t.status === "archived"} onClick={setDefault}
                  data-testid={`toggle-default-${t.id}`}
                  className="p-1.5 hover:bg-stone-100 rounded disabled:opacity-40" title={t.is_default ? "Remove default" : "Set as default"}>
            {t.is_default ? <StarOff className="w-4 h-4 text-amber-600" /> : <Star className="w-4 h-4 text-stone-500" />}
          </button>
          <Link to={`/admin/contracts/templates/${t.id}`} className="p-1.5 hover:bg-stone-100 rounded" title="Open">
            <Pencil className="w-4 h-4 text-stone-500" />
          </Link>
          <button disabled={busy} onClick={duplicate}
                  data-testid={`duplicate-${t.id}`}
                  className="p-1.5 hover:bg-stone-100 rounded disabled:opacity-40" title="Duplicate">
            <Copy className="w-4 h-4 text-stone-500" />
          </button>
          <button disabled={busy || t.status === "archived"} onClick={archive}
                  data-testid={`archive-${t.id}`}
                  className="p-1.5 hover:bg-stone-100 rounded disabled:opacity-40" title="Archive">
            <Archive className="w-4 h-4 text-stone-500" />
          </button>
        </div>
      </td>
    </tr>
  );
}

function BlankModal({ onClose, onCreated }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("other");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    if (!name.trim()) { setErr("Name required."); return; }
    setBusy(true); setErr("");
    try {
      const { data } = await api.post("/admin/contract-templates", { name: name.trim(), contract_type: type });
      onCreated(data.id);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Failed to create template.");
    } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" data-testid="blank-modal">
      <div className="bg-white rounded-2xl border border-stone-200 shadow-xl p-6 w-full max-w-md">
        <h2 className="font-display text-2xl">New blank template</h2>
        <div className="mt-4 space-y-3">
          <div>
            <label className="text-xs font-bold uppercase tracking-widest text-stone-600">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} data-testid="blank-name"
                   className="mt-1 w-full px-3 py-2 border border-stone-300 rounded" />
          </div>
          <div>
            <label className="text-xs font-bold uppercase tracking-widest text-stone-600">Contract type</label>
            <select value={type} onChange={(e) => setType(e.target.value)} data-testid="blank-type"
                    className="mt-1 w-full px-3 py-2 border border-stone-300 rounded">
              {CONTRACT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          {err && <div className="text-sm text-red-700">{err}</div>}
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-3 py-2 border border-stone-300 rounded text-sm">Cancel</button>
          <button onClick={submit} disabled={busy}
                  data-testid="blank-create"
                  className="px-3 py-2 rounded text-sm font-bold uppercase tracking-widest bg-stone-950 text-white disabled:opacity-40">
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload modal — async job with staged progress polling.
// Stages returned by the backend:
//   uploading → extracting → converting → verifying → creating → complete
// (or 'failed' at any point).
// ---------------------------------------------------------------------------
const STAGES = [
  { code: "uploading",  label: "Uploading PDF" },
  { code: "extracting", label: "Extracting text" },
  { code: "converting", label: "Converting document" },
  { code: "verifying",  label: "Running verbatim comparison" },
  { code: "creating",   label: "Creating editable template" },
  { code: "complete",   label: "Complete" },
];

function UploadModal({ onClose, onCreated, onRefresh }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("other");
  const [file, setFile] = useState(null);
  const [err, setErr] = useState("");
  const [job, setJob] = useState(null);         // {job_id, stage, status, progress, message, template_id, error}
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
      const { data } = await api.post("/admin/contract-templates/upload-pdf-async", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setJob(data);
      poll(data.job_id);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Failed to start upload.");
    }
  };

  const poll = (jobId) => {
    const tick = async () => {
      try {
        const { data } = await api.get(`/admin/contract-templates/upload-jobs/${jobId}`);
        setJob(data);
        if (data.status === "complete" && data.template_id) {
          onRefresh?.();
          setTimeout(() => onCreated?.(data.template_id), 400);
          return;
        }
        if (data.status === "failed") return;
        pollRef.current = setTimeout(tick, 1500);
      } catch (e) {
        setErr(e?.response?.data?.detail || "Lost connection to conversion job.");
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
              We&rsquo;ll extract the text, run a Claude cleanup pass, verify verbatim, and
              hand you an editable template. Large PDFs may take a minute or two.
            </p>
          </div>
          <button onClick={onClose} data-testid="upload-close"
                  className="p-1.5 hover:bg-stone-100 rounded">
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
                <div className="text-[11px] text-stone-500 mt-1">
                  {file.name} · {(file.size / 1024).toFixed(1)} KB
                </div>
              )}
            </div>
            {err && (
              <div className="text-sm text-red-700 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" /> {err}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={onClose}
                      className="px-3 py-2 border border-stone-300 rounded text-sm">Cancel</button>
              <button onClick={start}
                      data-testid="upload-start"
                      className="px-3 py-2 rounded text-sm font-bold uppercase tracking-widest bg-stone-950 text-white">
                Start upload
              </button>
            </div>
          </div>
        )}

        {job && (
          <div className="space-y-4" data-testid="upload-progress">
            {/* Progress bar */}
            <div className="h-2 bg-stone-100 rounded overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${
                  failed ? "bg-red-500" : complete ? "bg-emerald-500" : "bg-stone-950"
                }`}
                style={{ width: `${Math.max(4, job.progress || 0)}%` }}
                data-testid="upload-progress-bar"
              />
            </div>

            {/* Stage list */}
            <ol className="space-y-1.5" data-testid="upload-stage-list">
              {STAGES.map((s, i) => {
                const done = !failed && (complete || (currentStageIdx > i));
                const active = !failed && !complete && currentStageIdx === i;
                const pending = !failed && !complete && currentStageIdx < i;
                return (
                  <li key={s.code}
                      data-testid={`upload-stage-${s.code}`}
                      className={`flex items-center gap-2 text-sm ${
                        done ? "text-emerald-700"
                        : active ? "text-stone-950 font-semibold"
                        : failed ? "text-stone-400"
                        : "text-stone-400"
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
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
                {job.error}
              </div>
            )}
            {complete && (
              <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" /> Template ready. Opening editor…
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
