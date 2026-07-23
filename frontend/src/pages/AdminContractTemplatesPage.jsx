// Admin — Contract Templates list.
// Phase 1A only: template CRUD + PDF upload + status/default toggles.
// Contract issuance / signing lands in later phases.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api from "@/lib/api";
import {
  FileText, Plus, Upload, Loader2, AlertTriangle, CheckCircle2, Archive,
  Copy, Pencil, Star, StarOff,
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
  const [busy, setBusy] = useState(false);
  const [showBlank, setShowBlank] = useState(false);
  const fileInputRef = useRef(null);

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

  const onUpload = async (file, name, contract_type) => {
    if (!file) return;
    const fd = new FormData();
    fd.append("pdf", file);
    fd.append("name", name || file.name.replace(/\.pdf$/i, ""));
    fd.append("contract_type", contract_type || "other");
    setBusy(true); setErr("");
    try {
      const { data } = await api.post("/admin/contract-templates/upload-pdf", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      navigate(`/admin/contracts/templates/${data.id}`);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

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
            onClick={() => fileInputRef.current?.click()}
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

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) {
            const name = window.prompt(
              "Template name?",
              f.name.replace(/\.pdf$/i, ""),
            );
            if (name === null) return;
            const type = window.prompt(
              "Contract type — one of: new_franchise, franchise_renewal, licence, licence_renewal, territory_amendment, other",
              "other",
            );
            onUpload(f, name, type);
          }
        }}
      />

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
      {busy && (
        <div className="border border-stone-200 bg-white text-stone-700 text-sm rounded p-3 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Uploading & converting… this can take up to a minute for large PDFs.
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
