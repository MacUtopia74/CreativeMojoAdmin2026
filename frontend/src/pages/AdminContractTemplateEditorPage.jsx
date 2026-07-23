// Admin — Contract Template Editor.
// Loads a single template, hosts the LegalDocEditor + right-hand
// sidebar with metadata, conversion report, version history, and
// action buttons (Save version, Approve conversion, Publish, PDF
// preview).  Debounced autosave persists edits without spawning a
// new immutable version — that only happens on an explicit "Save
// version" click, or automatically on Approve / Publish / Rollback.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import api from "@/lib/api";
import LegalDocEditor from "@/components/contracts/LegalDocEditor";
import {
  ArrowLeft, Save, FileDown, CheckCircle2, AlertTriangle, Loader2,
  History, RefreshCw, Rocket, Download, ShieldCheck,
} from "lucide-react";

const DEBOUNCE_MS = 3000;

function formatDate(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }); }
  catch { return iso; }
}

export default function AdminContractTemplateEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [tpl, setTpl] = useState(null);
  const [placeholders, setPlaceholders] = useState([]);
  const [html, setHtml] = useState("");
  const [savedAt, setSavedAt] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [versions, setVersions] = useState([]);
  const debounceRef = useRef(null);
  const dirtyRef = useRef(false);
  const [busyAction, setBusyAction] = useState("");

  const load = useCallback(async () => {
    setErr("");
    try {
      const [{ data: template }, { data: p }] = await Promise.all([
        api.get(`/admin/contract-templates/${id}`),
        api.get(`/admin/contract-templates/placeholders`),
      ]);
      setTpl(template);
      setPlaceholders(p.placeholders || []);
      setHtml(template.current_content_html || "");
      dirtyRef.current = false;
      const { data: v } = await api.get(`/admin/contract-templates/${id}/versions`);
      setVersions(v.items || []);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Failed to load template.");
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  // Autosave: PATCH /draft after DEBOUNCE_MS of inactivity. Does NOT
  // create a new immutable version — those come from "Save version".
  useEffect(() => {
    if (!tpl || !dirtyRef.current) return () => {};
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSaving(true);
      try {
        const { data } = await api.patch(`/admin/contract-templates/${id}/draft`, { content_html: html });
        setSavedAt(data.saved_at);
        dirtyRef.current = false;
      } catch (e) {
        setErr(e?.response?.data?.detail || "Autosave failed.");
      } finally {
        setSaving(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
  }, [html, tpl, id]);

  const saveVersion = async () => {
    const note = window.prompt("Change note for this version (optional):", "");
    if (note === null) return;
    setBusyAction("save");
    try {
      // Flush any pending autosave first so the version captures the
      // very latest content.
      await api.patch(`/admin/contract-templates/${id}/draft`, { content_html: html });
      const { data } = await api.post(`/admin/contract-templates/${id}/versions`,
                                      { content_html: html, change_note: note || "" });
      window.alert(`Version ${data.version_number} saved.`);
      await load();
    } catch (e) {
      window.alert(e?.response?.data?.detail || "Save version failed.");
    } finally {
      setBusyAction("");
    }
  };

  const approveConversion = async () => {
    if (!window.confirm("Approve conversion? Imported clause numbers will be stripped and authoritative numbering will take over on preview/PDF. This creates an automatic version.")) return;
    setBusyAction("approve");
    try {
      // Persist the current draft first.
      await api.patch(`/admin/contract-templates/${id}/draft`, { content_html: html });
      await api.post(`/admin/contract-templates/${id}/approve-conversion`);
      await load();
    } catch (e) {
      window.alert(e?.response?.data?.detail || "Approve failed.");
    } finally {
      setBusyAction("");
    }
  };

  const publish = async () => {
    if (!window.confirm("Publish this template (status → current)? An automatic version is created.")) return;
    setBusyAction("publish");
    try {
      await api.patch(`/admin/contract-templates/${id}/draft`, { content_html: html });
      await api.post(`/admin/contract-templates/${id}/publish`);
      await load();
    } catch (e) {
      window.alert(e?.response?.data?.detail || "Publish failed.");
    } finally {
      setBusyAction("");
    }
  };

  const rollback = async (versionNumber) => {
    if (!window.confirm(`Restore version ${versionNumber}? This creates a new version, keeping the current one intact.`)) return;
    setBusyAction("rollback");
    try {
      await api.post(`/admin/contract-templates/${id}/rollback/${versionNumber}`);
      await load();
    } catch (e) {
      window.alert(e?.response?.data?.detail || "Rollback failed.");
    } finally {
      setBusyAction("");
    }
  };

  const previewPdf = async () => {
    setBusyAction("preview");
    try {
      // Persist first so the preview reflects the freshest content.
      await api.patch(`/admin/contract-templates/${id}/draft`, { content_html: html });
      const res = await api.post(`/admin/contract-templates/${id}/preview-pdf`,
                                 null, { responseType: "blob" });
      const url = URL.createObjectURL(new Blob([res.data], { type: "application/pdf" }));
      window.open(url, "_blank");
    } catch (e) {
      window.alert(e?.response?.data?.detail || "Preview failed.");
    } finally {
      setBusyAction("");
    }
  };

  const downloadSource = () => {
    // Use the API base URL and add auth header via anchor? Simplest is
    // to open a new tab where the axios client will re-authenticate.
    const url = `${(process.env.REACT_APP_BACKEND_URL || "")}/api/admin/contract-templates/${id}/source-pdf`;
    window.open(url, "_blank");
  };

  if (!tpl) {
    return (
      <div className="p-8 text-center text-stone-500 text-sm">
        {err ? <span className="text-red-700">{err}</span> : (<><Loader2 className="inline w-4 h-4 animate-spin mr-1" /> Loading…</>)}
      </div>
    );
  }

  const conversionScore = tpl.conversion_report?.score;
  const flagsCount = (tpl.conversion_report?.total_missing || 0) + (tpl.conversion_report?.total_added || 0);

  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col bg-stone-50" data-testid="admin-contract-editor">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 bg-white border-b border-stone-200">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={() => navigate("/admin/contracts/templates")}
                  className="p-1.5 hover:bg-stone-100 rounded" title="Back to templates">
            <ArrowLeft className="w-4 h-4 text-stone-600" />
          </button>
          <div className="min-w-0">
            <h1 className="font-semibold text-lg text-stone-950 truncate">{tpl.name}</h1>
            <div className="text-xs text-stone-500 flex items-center gap-2">
              <span>v{tpl.current_version} · {tpl.status}</span>
              {saving && <span className="inline-flex items-center gap-1 text-stone-500"><Loader2 className="w-3 h-3 animate-spin" /> Autosaving</span>}
              {!saving && savedAt && <span>· Autosaved {formatDate(savedAt)}</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={saveVersion} disabled={!!busyAction}
                  data-testid="btn-save-version"
                  className="px-3 py-2 rounded text-xs font-bold uppercase tracking-widest bg-white border border-stone-300 hover:bg-stone-50 inline-flex items-center gap-1.5">
            <Save className="w-4 h-4" /> Save version
          </button>
          {!tpl.conversion_approved && (
            <button onClick={approveConversion} disabled={!!busyAction}
                    data-testid="btn-approve-conversion"
                    className="px-3 py-2 rounded text-xs font-bold uppercase tracking-widest bg-emerald-600 text-white hover:bg-emerald-700 inline-flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4" /> Approve conversion
            </button>
          )}
          {tpl.conversion_approved && tpl.status !== "current" && (
            <button onClick={publish} disabled={!!busyAction}
                    data-testid="btn-publish"
                    className="px-3 py-2 rounded text-xs font-bold uppercase tracking-widest bg-stone-950 text-white hover:bg-stone-800 inline-flex items-center gap-1.5">
              <Rocket className="w-4 h-4" /> Publish
            </button>
          )}
          <button onClick={previewPdf} disabled={!!busyAction}
                  data-testid="btn-preview-pdf"
                  className="px-3 py-2 rounded text-xs font-bold uppercase tracking-widest bg-white border border-stone-300 hover:bg-stone-50 inline-flex items-center gap-1.5">
            <FileDown className="w-4 h-4" /> PDF preview
          </button>
          {tpl.source_pdf?.r2_key && (
            <button onClick={downloadSource}
                    data-testid="btn-download-source"
                    className="px-3 py-2 rounded text-xs font-bold uppercase tracking-widest bg-white border border-stone-300 hover:bg-stone-50 inline-flex items-center gap-1.5">
              <Download className="w-4 h-4" /> Source PDF
            </button>
          )}
        </div>
      </div>

      {err && (
        <div className="px-6 py-2 border-b border-red-200 bg-red-50 text-red-700 text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {err}
        </div>
      )}

      {/* Body — editor + sidebar */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 p-4 overflow-hidden">
        <div className="min-h-0">
          <LegalDocEditor
            initialHtml={html}
            placeholders={placeholders}
            onUpdateHtml={(next) => { setHtml(next); dirtyRef.current = true; }}
          />
        </div>
        {/* Sidebar */}
        <aside className="flex flex-col gap-3 overflow-y-auto">
          {/* Conversion status */}
          {!tpl.conversion_approved && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <div className="font-bold flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> Conversion under review</div>
              <p className="mt-1 text-xs">Imported clause numbers remain visible until you approve. Authoritative numbering is disabled on preview.</p>
              {conversionScore !== undefined && (
                <div className="mt-2 text-xs">
                  <div>Verbatim match: <strong>{Math.round((conversionScore || 0) * 100)}%</strong></div>
                  <div>{flagsCount} phrase{flagsCount === 1 ? "" : "s"} flagged for review</div>
                </div>
              )}
            </div>
          )}
          {tpl.conversion_approved && (
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-bold">Conversion approved</div>
                <div className="text-xs mt-0.5">Authoritative numbering is now active on preview / PDF output.</div>
              </div>
            </div>
          )}

          {/* Diff details */}
          {tpl.conversion_report && (tpl.conversion_report.missing?.length || tpl.conversion_report.added?.length) ? (
            <div className="rounded-xl border border-stone-200 bg-white p-3 text-sm">
              <div className="text-xs font-bold uppercase tracking-widest text-stone-600 mb-2">Flagged phrases</div>
              {tpl.conversion_report.missing?.length > 0 && (
                <div className="mb-2">
                  <div className="text-[10px] uppercase tracking-widest font-bold text-red-700 mb-1">Missing from HTML</div>
                  <ul className="text-xs space-y-1">
                    {tpl.conversion_report.missing.map((m, i) => (
                      <li key={i} className="border-l-2 border-red-300 pl-2 text-stone-700">&ldquo;{m}&rdquo;</li>
                    ))}
                  </ul>
                </div>
              )}
              {tpl.conversion_report.added?.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-widest font-bold text-amber-700 mb-1">Added in HTML</div>
                  <ul className="text-xs space-y-1">
                    {tpl.conversion_report.added.map((m, i) => (
                      <li key={i} className="border-l-2 border-amber-300 pl-2 text-stone-700">&ldquo;{m}&rdquo;</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : null}

          {/* Version history */}
          <div className="rounded-xl border border-stone-200 bg-white p-3 text-sm">
            <div className="text-xs font-bold uppercase tracking-widest text-stone-600 mb-2 flex items-center gap-1.5">
              <History className="w-3.5 h-3.5" /> Version history
            </div>
            <ul className="space-y-1.5" data-testid="versions-list">
              {versions.map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-2 text-xs text-stone-700">
                  <div className="min-w-0">
                    <div className="font-bold">v{v.version_number}</div>
                    <div className="text-[11px] text-stone-500 truncate" title={v.change_note}>{v.change_note}</div>
                    <div className="text-[10px] text-stone-400">{formatDate(v.created_at)}</div>
                  </div>
                  {v.version_number !== tpl.current_version && (
                    <button
                      onClick={() => rollback(v.version_number)}
                      title="Restore this version"
                      className="p-1.5 hover:bg-stone-100 rounded text-stone-500"
                      data-testid={`rollback-${v.version_number}`}
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
