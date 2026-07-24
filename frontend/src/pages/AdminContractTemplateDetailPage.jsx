// Admin — Contract Template detail (Phase 1A).
// Read-only marker summary: PDF metadata, SHA-256, per-marker layout,
// library reconciliation. No editing, no personalisation.
import { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api from "@/lib/api";
import {
  ArrowLeft, Loader2, Download, AlertTriangle, CheckCircle2, RefreshCw,
  FileText, Hash, Shield, LayoutTemplate,
} from "lucide-react";
import MarkerReviewModal from "./MarkerReviewModal";

const STATUS_STYLES = {
  draft:    "bg-stone-100 text-stone-700 border-stone-300",
  current:  "bg-emerald-50 text-emerald-800 border-emerald-300",
  archived: "bg-stone-50 text-stone-400 border-stone-200",
};

export default function AdminContractTemplateDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [tpl, setTpl] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [integrity, setIntegrity] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const [tplR, sumR] = await Promise.all([
        api.get(`/admin/contract-templates/${id}`),
        api.get(`/admin/contract-templates/${id}/marker-summary`),
      ]);
      setTpl(tplR.data);
      setSummary(sumR.data);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Failed to load template.");
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const runIntegrityCheck = async () => {
    setBusy(true);
    try {
      const { data } = await api.get(`/admin/contract-templates/${id}/integrity-check`);
      setIntegrity(data);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Integrity check failed.");
    } finally { setBusy(false); }
  };

  const downloadSource = () => {
    const url = `${process.env.REACT_APP_BACKEND_URL || ""}/api/admin/contract-templates/${id}/source-pdf`;
    window.open(url, "_blank");
  };

  const downloadSamplePreview = async () => {
    setBusy(true); setErr("");
    try {
      const resp = await api.post(
        `/admin/contract-templates/${id}/sample-preview.pdf`,
        {},
        { responseType: "blob" },
      );
      // Filename comes from the endpoint's Content-Disposition header
      const disp = resp.headers?.["content-disposition"] || "";
      const match = /filename="([^"]+)"/i.exec(disp);
      const filename = match ? match[1] : `PREVIEW_${tpl?.name || "template"}.pdf`;
      const blobUrl = URL.createObjectURL(new Blob([resp.data], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Sample preview generation failed.");
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true);
    try { await api.post(`/admin/contract-templates/${id}/publish`); await load(); }
    catch (e) { setErr(e?.response?.data?.detail || "Publish failed."); }
    finally { setBusy(false); }
  };

  if (loading) return <div className="p-6 flex items-center gap-2 text-stone-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>;
  if (err) return <div className="p-6 text-red-700 flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> {err}</div>;
  if (!tpl || !summary) return null;

  const s = summary.summary;
  const ready = s.ready_for_approval;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6" data-testid="admin-template-detail">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <button onClick={() => navigate("/admin/contracts/templates")}
                  data-testid="back-to-list"
                  className="p-2 rounded border border-stone-300 hover:bg-stone-50">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="font-display text-2xl text-stone-950">{tpl.name}</h1>
            <div className="text-xs text-stone-500 flex items-center gap-2 flex-wrap mt-1">
              <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest border ${STATUS_STYLES[tpl.status]}`}>{tpl.status}</span>
              <span>v{tpl.current_version}</span>
              <span>· {tpl.contract_type}</span>
              <span>· {summary.pdf_page_count} pages</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={load} data-testid="refresh-btn"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold uppercase tracking-widest rounded-lg bg-white border border-stone-300 hover:bg-stone-50">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          <button onClick={downloadSource} data-testid="download-source"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold uppercase tracking-widest rounded-lg bg-white border border-stone-300 hover:bg-stone-50">
            <Download className="w-3.5 h-3.5" /> Source PDF
          </button>
          <button onClick={downloadSamplePreview} disabled={busy}
                  data-testid="download-sample-preview"
                  title="Download a sample-value populated preview of the whole PDF. PREVIEW — NOT FOR ISSUE."
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold uppercase tracking-widest rounded-lg bg-white border border-amber-300 text-amber-900 hover:bg-amber-50 disabled:opacity-50">
            <Download className="w-3.5 h-3.5" /> {busy ? "Generating…" : "Sample Preview PDF"}
          </button>
          <button onClick={() => setReviewOpen(true)}
                  data-testid="open-marker-review"
                  title="Open the visual Marker Review workspace — drag/resize marker boxes, edit properties, acknowledge substitutions."
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold uppercase tracking-widest rounded-lg bg-stone-950 text-white hover:bg-stone-800">
            <LayoutTemplate className="w-3.5 h-3.5" /> Marker Review
          </button>
          {tpl.status === "draft" && ready && (
            <button onClick={publish} disabled={busy} data-testid="publish-btn"
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold uppercase tracking-widest rounded-lg bg-emerald-600 text-white">
              Publish
            </button>
          )}
        </div>
      </div>

      {/* Summary banner */}
      <div
        data-testid="summary-banner"
        className={`rounded-lg border p-4 flex items-start gap-3 ${
          ready ? "bg-emerald-50 border-emerald-200 text-emerald-900" : "bg-amber-50 border-amber-200 text-amber-900"
        }`}
      >
        {ready ? <CheckCircle2 className="w-5 h-5 mt-0.5" /> : <AlertTriangle className="w-5 h-5 mt-0.5" />}
        <div>
          <div className="font-semibold">
            {ready ? "Ready for approval." : "Not ready for approval."}
          </div>
          <div className="text-sm mt-0.5">
            {s.total_occurrences} occurrences · {s.unique_codes} unique codes · {s.recognised.length} recognised
            {s.unrecognised.length > 0 && <> · <strong>{s.unrecognised.length} unrecognised</strong></>}
            {s.duplicate_offenders.length > 0 && <> · <strong>{s.duplicate_offenders.length} duplicate offender</strong></>}
            {s.cross_line_errors_count > 0 && <> · <strong>{s.cross_line_errors_count} cross-line error</strong></>}
            {s.template_required_missing.length > 0 && <> · <strong>{s.template_required_missing.length} template-required missing</strong></>}
          </div>
        </div>
      </div>

      {/* Integrity + provenance */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <InfoCard icon={FileText} label="Source PDF" value={tpl.source_pdf?.filename || "—"} sub={`${((tpl.source_pdf?.byte_size || 0) / 1024).toFixed(1)} KB · ${summary.pdf_page_count} pages`} />
        <InfoCard icon={Hash} label="SHA-256" value={<code className="text-[11px] break-all">{summary.pdf_sha256}</code>} />
        <div className="border border-stone-200 rounded-lg p-3 text-xs" data-testid="integrity-card">
          <div className="flex items-center gap-1.5 text-stone-500 font-bold uppercase tracking-widest text-[10px]">
            <Shield className="w-3 h-3" /> Storage integrity
          </div>
          {!integrity && (
            <button onClick={runIntegrityCheck} disabled={busy}
                    data-testid="integrity-run"
                    className="mt-2 px-2 py-1 rounded bg-stone-950 text-white text-[11px] font-bold uppercase tracking-widest">
              Verify against R2
            </button>
          )}
          {integrity && (
            <div className={`mt-2 ${integrity.ok ? "text-emerald-700" : "text-red-700"}`}>
              {integrity.ok ? "Hash matches — R2 object unmodified." : "Hash mismatch. Storage integrity check FAILED."}
              <div className="text-[10px] text-stone-500 mt-0.5">{integrity.byte_size} bytes verified</div>
            </div>
          )}
        </div>
      </div>

      {/* Categorised marker lists */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <ListCard title="Recognised markers" tone="ok" codes={s.recognised} testid="list-recognised" />
        <ListCard title="Unrecognised" tone="warn" codes={s.unrecognised} testid="list-unrecognised"
                  emptyLabel="No unrecognised markers." />
        <ListCard title="Not eligible for contract type" tone="warn" codes={s.not_eligible_for_type} testid="list-not-eligible"
                  emptyLabel="All recognised markers are eligible for this contract type." />
        <ListCard title="Template-required missing" tone="warn"
                  codes={s.template_required_missing} testid="list-template-required-missing"
                  emptyLabel="No missing template-required markers." />
      </div>

      {/* Cross-line errors */}
      {summary.cross_line_errors.length > 0 && (
        <div className="border border-red-200 bg-red-50 rounded-lg p-3" data-testid="cross-line-errors">
          <div className="font-semibold text-red-800 text-sm">Cross-line marker errors — {summary.cross_line_errors.length}</div>
          <ul className="mt-2 text-xs text-red-800 space-y-1">
            {summary.cross_line_errors.map((e, i) => (
              <li key={i}><strong>Page {e.page}, line {e.line_no}</strong> ({e.kind}): <code>{e.snippet}</code></li>
            ))}
          </ul>
        </div>
      )}

      {/* Per-page marker overlay thumbnails */}
      <div>
        <div className="text-xs font-bold uppercase tracking-widest text-stone-500 mb-2">
          Marker overlay thumbnails ({summary.pdf_page_count} pages)
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3" data-testid="thumbnails">
          {Array.from({ length: summary.pdf_page_count }, (_, i) => i + 1).map((p) => (
            <div key={p} className="border border-stone-200 rounded-lg overflow-hidden bg-stone-50">
              <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-stone-500 bg-white border-b border-stone-200">Page {p}</div>
              <img
                src={`${process.env.REACT_APP_BACKEND_URL || ""}/api/admin/contract-templates/${id}/pages/${p}/thumbnail.png`}
                alt={`Page ${p} with marker overlay`}
                data-testid={`thumbnail-${p}`}
                className="w-full h-auto"
                loading="lazy"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Full marker occurrences */}
      <div>
        <div className="text-xs font-bold uppercase tracking-widest text-stone-500 mb-2">
          All detected occurrences ({summary.markers.length})
        </div>
        <div className="border border-stone-200 rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-stone-50 text-stone-500 uppercase tracking-widest">
              <tr>
                <th className="text-left px-3 py-2">Code</th>
                <th className="text-left px-3 py-2">Page</th>
                <th className="text-left px-3 py-2">Bounding box</th>
                <th className="text-left px-3 py-2">Font</th>
                <th className="text-left px-3 py-2">Size</th>
                <th className="text-left px-3 py-2">Embed</th>
              </tr>
            </thead>
            <tbody data-testid="marker-list">
              {summary.markers.map((m, i) => (
                <tr key={i} className="border-t border-stone-200">
                  <td className="px-3 py-1.5 font-mono text-stone-900">[[{m.code}]]</td>
                  <td className="px-3 py-1.5">{m.page}</td>
                  <td className="px-3 py-1.5 text-stone-500 text-[11px]">
                    x0={m.bbox[0].toFixed(1)}, y0={m.bbox[1].toFixed(1)}, x1={m.bbox[2].toFixed(1)}, y1={m.bbox[3].toFixed(1)}
                  </td>
                  <td className="px-3 py-1.5">{m.font_family || "—"}</td>
                  <td className="px-3 py-1.5">{m.font_size ?? "—"}</td>
                  <td className="px-3 py-1.5">
                    {m.is_embedded ? (m.is_reusable ? <span className="text-emerald-700">reusable</span> : <span className="text-amber-700">subset</span>) : <span className="text-stone-500">not embedded</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {reviewOpen && (
        <MarkerReviewModal
          templateId={id}
          onClose={() => { setReviewOpen(false); load(); }}
        />
      )}
    </div>
  );
}


function InfoCard({ icon: Icon, label, value, sub }) {
  return (
    <div className="border border-stone-200 rounded-lg p-3 text-xs">
      <div className="flex items-center gap-1.5 text-stone-500 font-bold uppercase tracking-widest text-[10px]">
        <Icon className="w-3 h-3" /> {label}
      </div>
      <div className="mt-1 text-stone-950 font-medium break-all">{value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-stone-500">{sub}</div>}
    </div>
  );
}

function ListCard({ title, tone, codes, testid, emptyLabel }) {
  const toneClass = tone === "ok"
    ? "border-emerald-200 bg-emerald-50/50"
    : "border-amber-200 bg-amber-50/40";
  return (
    <div className={`border rounded-lg p-3 ${toneClass}`} data-testid={testid}>
      <div className="text-xs font-bold uppercase tracking-widest text-stone-600">{title} ({codes.length})</div>
      {codes.length === 0 ? (
        <div className="text-[11px] text-stone-500 mt-1">{emptyLabel || "None."}</div>
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {codes.map((c) => (
            <code key={c} className="text-[11px] bg-white border border-stone-200 rounded px-1.5 py-0.5">[[{c}]]</code>
          ))}
        </div>
      )}
    </div>
  );
}
