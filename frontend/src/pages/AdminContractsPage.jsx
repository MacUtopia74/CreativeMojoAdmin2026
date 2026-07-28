// Admin — Contracts (Phase 1C MVP)
// Single-page CRUD + issue + upload-signed for contract records.
// No wizard, no evidence pack UI, no audit-trail viewer.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "@/lib/api";
import {
  Loader2, Plus, FileText, Download, Upload, RefreshCw, X,
  CheckCircle2, AlertTriangle, ExternalLink,
} from "lucide-react";

const STATUS_STYLES = {
  draft:         { label: "Draft",       cls: "bg-stone-100 text-stone-700 border-stone-300" },
  pending_issue: { label: "Issuing…",    cls: "bg-amber-50 text-amber-800 border-amber-300" },
  issued:        { label: "Issued",      cls: "bg-emerald-50 text-emerald-800 border-emerald-300" },
  signed:        { label: "Signed",      cls: "bg-sky-50 text-sky-800 border-sky-300" },
  superseded:    { label: "Superseded",  cls: "bg-stone-50 text-stone-500 border-stone-200" },
  retired:       { label: "Retired",     cls: "bg-stone-50 text-stone-400 border-stone-200" },
};

function fmt(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }); }
  catch { return iso; }
}

export function StatusPill({ status }) {
  const s = STATUS_STYLES[status] || { label: status || "?", cls: "bg-stone-100 text-stone-700 border-stone-300" };
  return (
    <span data-testid={`contract-status-${status}`}
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs border font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}

export default function AdminContractsPage() {
  const [rows, setRows] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [franchisees, setFranchisees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [busyRow, setBusyRow] = useState(null);
  const uploadInputRef = useRef(null);
  const [uploadTargetCid, setUploadTargetCid] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const [c, t, f] = await Promise.all([
        api.get("/admin/contracts"),
        api.get("/admin/contract-templates"),
        api.get("/franchisees", { params: { limit: 500 } }),
      ]);
      setRows(c.data.items || []);
      setTemplates((t.data.items || []).filter((x) => ["approved", "current"].includes(x.status)));
      setFranchisees(f.data.items || f.data || []);
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const templateById = useMemo(() =>
    Object.fromEntries(templates.map((t) => [t.id, t])), [templates]);
  const franchiseeById = useMemo(() =>
    Object.fromEntries(franchisees.map((f) => [f.id, f])), [franchisees]);

  async function resolveAndIssue(cid) {
    setBusyRow(cid);
    try {
      // Resolve variables first (safe if already resolved — the endpoint
      // will 400 with a "use refresh-variables" message which we ignore
      // for the MVP happy path)
      const c = rows.find((r) => r.id === cid);
      if (!c?.contract_variables) {
        try {
          await api.post(`/admin/contracts/${cid}/resolve-variables`);
        } catch (e) {
          const detail = e?.response?.data?.detail;
          if (typeof detail === "object" && detail?.errors?.length) {
            const msg = detail.errors.map((x) => `${x.code}: ${x.reason}`).join("\n");
            alert(`Cannot issue — missing values:\n\n${msg}`);
            setBusyRow(null);
            return;
          }
          throw e;
        }
      }
      await api.post(`/admin/contracts/${cid}/issue`);
      await load();
    } catch (e) {
      const d = e?.response?.data?.detail;
      alert(`Issue failed: ${typeof d === "string" ? d : JSON.stringify(d || e.message)}`);
    } finally { setBusyRow(null); }
  }

  async function downloadDraftPreview(cid) {
    try {
      const resp = await api.post(
        `/admin/contracts/${cid}/preview-pdf`,
        null,
        { responseType: "blob" },
      );
      const url = window.URL.createObjectURL(
        new Blob([resp.data], { type: "application/pdf" }),
      );
      // Open in a new tab. The watermark is baked into every page and
      // the URL is a short-lived object URL that is revoked on unload.
      window.open(url, "_blank", "noopener");
      // Revoke after a beat so the new tab has time to grab the blob.
      setTimeout(() => window.URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      alert(`Preview failed: ${e?.response?.data?.detail || e.message}`);
    }
  }

  async function downloadPersonalised(cid) {
    try {
      const { data } = await api.get(`/admin/contracts/${cid}/personalised-pdf`);
      window.open(data.url, "_blank");
    } catch (e) {
      alert(`Download failed: ${e?.response?.data?.detail || e.message}`);
    }
  }

  async function downloadSigned(cid) {
    try {
      const { data } = await api.get(`/admin/contracts/${cid}/signed-pdf`);
      window.open(data.url, "_blank");
    } catch (e) {
      alert(`Download failed: ${e?.response?.data?.detail || e.message}`);
    }
  }

  function openUploadPicker(cid) {
    setUploadTargetCid(cid);
    setTimeout(() => uploadInputRef.current?.click(), 0);
  }

  async function onUploadPicked(ev) {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file || !uploadTargetCid) return;
    const cid = uploadTargetCid;
    setBusyRow(cid);
    try {
      const fd = new FormData();
      fd.append("pdf", file);
      await api.post(`/admin/contracts/${cid}/upload-signed`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      await load();
    } catch (e) {
      alert(`Upload failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setBusyRow(null);
      setUploadTargetCid(null);
    }
  }

  return (
    <div className="p-6 max-w-7xl mx-auto" data-testid="admin-contracts-page">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold" data-testid="contracts-heading">Contracts</h1>
        <div className="flex gap-2">
          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border rounded-md bg-white hover:bg-stone-50"
            data-testid="contracts-refresh-btn">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button
            onClick={() => setShowNew(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border rounded-md bg-emerald-600 text-white hover:bg-emerald-700 border-emerald-600"
            data-testid="contracts-new-btn">
            <Plus className="h-4 w-4" /> New contract
          </button>
        </div>
      </div>

      {err && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 text-sm rounded flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" /> {err}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-stone-500 py-16 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="p-8 text-center text-stone-500 border border-dashed rounded-md" data-testid="contracts-empty">
          No contracts yet — click <em>New contract</em> above.
        </div>
      ) : (
        <div className="border rounded-lg bg-white overflow-hidden" data-testid="contracts-table">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 border-b text-left text-xs uppercase text-stone-600">
              <tr>
                <th className="p-3">Status</th>
                <th className="p-3">Franchisee</th>
                <th className="p-3">Template</th>
                <th className="p-3">Monthly fee</th>
                <th className="p-3">Created</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const tpl = templateById[c.template_id];
                const fr = franchiseeById[c.franchisee_id];
                const isBusy = busyRow === c.id;
                return (
                  <tr key={c.id} className="border-b last:border-0 hover:bg-stone-50" data-testid={`contract-row-${c.id}`}>
                    <td className="p-3"><StatusPill status={c.status} /></td>
                    <td className="p-3">
                      {fr ? `${fr.first_name || ""} ${fr.last_name || ""}`.trim() || fr.organisation : c.franchisee_id?.slice(0, 8)}
                      {fr?.organisation && (
                        <div className="text-xs text-stone-500">{fr.organisation}</div>
                      )}
                    </td>
                    <td className="p-3">
                      <div className="text-stone-900">{tpl?.name || c.template_id?.slice(0, 8)}</div>
                      <div className="text-xs text-stone-500">{tpl?.contract_type}</div>
                    </td>
                    <td className="p-3">{c.monthly_fee != null ? `£${Number(c.monthly_fee).toFixed(2)}` : "—"}</td>
                    <td className="p-3 text-xs text-stone-500">{fmt(c.created_at)}</td>
                    <td className="p-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {c.status === "draft" && (
                          <button
                            onClick={() => downloadDraftPreview(c.id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs border rounded bg-white hover:bg-stone-50"
                            data-testid={`contract-preview-btn-${c.id}`}
                            title="Render the draft with a PREVIEW watermark. Does not change status or make the contract visible to the franchisee.">
                            <FileText className="h-3 w-3" /> Preview
                          </button>
                        )}
                        {c.status === "draft" && (
                          <button
                            onClick={() => resolveAndIssue(c.id)}
                            disabled={isBusy}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs border rounded bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                            data-testid={`contract-issue-btn-${c.id}`}>
                            {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                            Issue
                          </button>
                        )}
                        {(c.status === "issued" || c.status === "signed" || c.status === "superseded") && c.personalised_pdf_r2_key && (
                          <button
                            onClick={() => downloadPersonalised(c.id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs border rounded bg-white hover:bg-stone-50"
                            data-testid={`contract-download-btn-${c.id}`}>
                            <Download className="h-3 w-3" /> PDF
                          </button>
                        )}
                        {c.status === "issued" && (
                          <button
                            onClick={() => openUploadPicker(c.id)}
                            disabled={isBusy}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs border rounded bg-sky-600 border-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
                            data-testid={`contract-upload-signed-btn-${c.id}`}>
                            {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                            Upload signed
                          </button>
                        )}
                        {(c.status === "signed") && c.signed_pdf_r2_key && (
                          <button
                            onClick={() => downloadSigned(c.id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs border rounded bg-white hover:bg-stone-50"
                            data-testid={`contract-download-signed-btn-${c.id}`}>
                            <Download className="h-3 w-3" /> Signed
                          </button>
                        )}
                        {c.status === "superseded" && c.superseded_by_contract_id && (
                          <span className="text-xs text-stone-500" data-testid={`contract-superseded-note-${c.id}`}>
                            → {c.superseded_by_contract_id.slice(0, 8)}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <input
        ref={uploadInputRef}
        type="file"
        accept="application/pdf"
        onChange={onUploadPicked}
        className="hidden"
        data-testid="contracts-hidden-upload-input"
      />

      {showNew && (
        <NewContractModal
          templates={templates}
          franchisees={franchisees}
          onClose={() => setShowNew(false)}
          onCreated={async () => { setShowNew(false); await load(); }}
        />
      )}
    </div>
  );
}

export function NewContractModal({ templates, franchisees, onClose, onCreated, lockedFranchiseeId, renewalOf }) {
  const [templateId, setTemplateId] = useState(templates[0]?.id || "");
  const [franchiseeId, setFranchiseeId] = useState(lockedFranchiseeId || "");
  const [monthlyFee, setMonthlyFee] = useState("");
  const lockedFr = lockedFranchiseeId
    ? franchisees.find((f) => f.id === lockedFranchiseeId)
    : null;
  // Legal name is now AUTO-RESOLVED at issuance from the franchisee's
  // First name + Last name. Leave this field blank — it's an optional
  // per-contract OVERRIDE for LLC / limited-company edge cases. Never
  // pre-fill from ``organisation`` because that silently made the
  // legal name and trading name resolve identically on the PDF.
  const [franchiseeLegalName, setFranchiseeLegalName] = useState("");
  const [hqSignatoryName, setHqSignatoryName] = useState("");
  const [hqSignatoryTitle, setHqSignatoryTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  // Contract dates + term. All backed by ``contracts.*`` fields on
  // the draft doc and freezable via the CMS marker resolver
  // ({{COMMENCEMENT_DATE}}, {{RENEWAL_DATE}}, {{CONTRACT_TERM_YEARS}}).
  // Renewal drafts also take a renewal_fee; new drafts take an
  // initial_franchise_fee. All optional at draft time; issuance
  // validates whichever markers the template embeds.
  const [contractTermYears, setContractTermYears] = useState("");
  const [commencementDate, setCommencementDate] = useState("");
  const [renewalDate, setRenewalDate] = useState("");
  const [renewalFee, setRenewalFee] = useState("");
  // Auto-populate renewal_date from commencement + term when both
  // are set and HQ hasn't manually overridden it. Manual edits win —
  // once the user types in the renewal_date field we stop auto-syncing
  // (tracked by ``renewalDateManual``).
  const [renewalDateManual, setRenewalDateManual] = useState(false);
  useEffect(() => {
    if (renewalDateManual) return;
    if (!commencementDate || !contractTermYears) return;
    try {
      const d = new Date(commencementDate);
      if (isNaN(d.getTime())) return;
      const years = Number(contractTermYears);
      if (!Number.isFinite(years) || years <= 0) return;
      d.setFullYear(d.getFullYear() + years);
      const iso = d.toISOString().slice(0, 10);
      setRenewalDate(iso);
    } catch { /* ignore */ }
  }, [commencementDate, contractTermYears, renewalDateManual]);
  // "Renewal — supersedes #X" auto-links this draft to a prior CMS
  // contract for the same franchisee. Defaults ON when the caller
  // passes a ``renewalOf`` reference (franchisee page always does).
  const [renewalOn, setRenewalOn] = useState(Boolean(renewalOf));
  // Initial Franchise Fee (GBP, ex-VAT). Only surfaced when the
  // draft is NOT a renewal. Pre-populated from the franchisee's
  // canonical ``bought_for`` field when present so HQ just confirms
  // rather than re-typing a historic amount.
  const currentFr = franchiseeId
    ? franchisees.find((f) => f.id === franchiseeId)
    : lockedFr;
  const [initialFranchiseFee, setInitialFranchiseFee] = useState(() => {
    const v = currentFr?.bought_for;
    return v == null || v === "" ? "" : String(v);
  });
  // Keep the field in sync when the selected franchisee changes
  // (open modal from Admin Contracts page where the picker is live).
  useEffect(() => {
    const v = currentFr?.bought_for;
    setInitialFranchiseFee(v == null || v === "" ? "" : String(v));
  }, [franchiseeId, currentFr]);

  const franchiseesSorted = useMemo(() =>
    [...franchisees].sort((a, b) => {
      const an = `${a.first_name || ""} ${a.last_name || ""}`.trim();
      const bn = `${b.first_name || ""} ${b.last_name || ""}`.trim();
      return an.localeCompare(bn);
    }), [franchisees]);

  async function submit() {
    setSaving(true); setErr("");
    try {
      const body = {
        template_id: templateId,
        franchisee_id: franchiseeId,
      };
      if (monthlyFee) body.monthly_fee = Number(monthlyFee);
      if (franchiseeLegalName) body.franchisee_legal_name = franchiseeLegalName;
      if (hqSignatoryName) body.hq_signatory_name = hqSignatoryName;
      if (hqSignatoryTitle) body.hq_signatory_title = hqSignatoryTitle;
      if (renewalOn && renewalOf?.id) body.supersedes_id = renewalOf.id;
      // Dates & term — always pass through when set. Backend accepts
      // ISO date strings; empty strings are dropped so a partially
      // filled draft can still be saved for later completion.
      if (contractTermYears) body.contract_term_years = Number(contractTermYears);
      if (commencementDate) {
        body.commencement_date = commencementDate;
        // Legacy alias — some template markers still reference the
        // older ``term_start_date`` field name. Keeping both in sync
        // avoids "missing value" issues at issuance for older PDFs.
        body.term_start_date = commencementDate;
      }
      if (renewalDate) body.renewal_date = renewalDate;
      // Initial Franchise Fee — only sent on non-renewal drafts, so
      // renewals never carry (or overwrite) the historic amount.
      const isRenewal = renewalOn && renewalOf?.id;
      if (!isRenewal && initialFranchiseFee !== "") {
        body.initial_franchise_fee = Number(initialFranchiseFee);
      }
      // Renewal fee — only on renewals.
      if (isRenewal && renewalFee !== "") {
        body.renewal_fee = Number(renewalFee);
      }
      await api.post("/admin/contracts", body);
      await onCreated();
    } catch (e) {
      const d = e?.response?.data?.detail;
      setErr(typeof d === "string" ? d : JSON.stringify(d || e.message));
    } finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" data-testid="new-contract-modal">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-2xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b sticky top-0 bg-white z-10">
          <h2 className="text-lg font-semibold">
            {renewalOn && renewalOf ? "Renew contract" : "New contract"}
          </h2>
          <button onClick={onClose} className="text-stone-500 hover:text-stone-800" data-testid="new-contract-close-btn">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          {renewalOf && (
            <label className="flex items-start gap-2 text-xs bg-amber-50 border border-amber-200 rounded p-2 cursor-pointer"
                   data-testid="new-contract-renewal-toggle-row">
              <input
                type="checkbox"
                checked={renewalOn}
                onChange={(e) => setRenewalOn(e.target.checked)}
                className="mt-0.5"
                data-testid="new-contract-renewal-toggle" />
              <span className="text-amber-900">
                <strong>Renewal</strong> — this draft supersedes
                <code className="mx-1 px-1 bg-white border border-amber-200 rounded">
                  {renewalOf.contract_reference || `#${renewalOf.id.slice(0, 8)}`}
                </code>
                when it is issued.
              </span>
            </label>
          )}
          <label className="block text-sm">
            <span className="text-stone-700">Template</span>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="w-full mt-1 border rounded-md px-2 py-1.5 text-sm"
              data-testid="new-contract-template-select">
              <option value="">— select template —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-stone-700">Franchisee{lockedFranchiseeId && " (locked to this record)"}</span>
            <select
              value={franchiseeId}
              onChange={(e) => setFranchiseeId(e.target.value)}
              disabled={Boolean(lockedFranchiseeId)}
              className="w-full mt-1 border rounded-md px-2 py-1.5 text-sm disabled:bg-stone-100 disabled:text-stone-500"
              data-testid="new-contract-franchisee-select">
              <option value="">— select franchisee —</option>
              {franchiseesSorted.map((f) => (
                <option key={f.id} value={f.id}>
                  {`${f.first_name || ""} ${f.last_name || ""}`.trim() || f.organisation || f.id}
                  {f.organisation ? ` — ${f.organisation}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-stone-700">Monthly fee (£)</span>
            <input
              type="number" step="0.01" min="0"
              value={monthlyFee}
              onChange={(e) => setMonthlyFee(e.target.value)}
              className="w-full mt-1 border rounded-md px-2 py-1.5 text-sm"
              data-testid="new-contract-monthly-fee-input" />
          </label>
          {/* Initial Franchise Fee — first-contract only, ex-VAT.
              Renewal drafts never see this field so the historic
              amount recorded on the initial contract stays frozen. */}
          {!(renewalOn && renewalOf?.id) && (
            <label className="block text-sm" data-testid="new-contract-initial-franchise-fee-row">
              <span className="text-stone-700">Initial Franchise Fee (£)</span>
              <input
                type="number" step="0.01" min="0"
                value={initialFranchiseFee}
                onChange={(e) => setInitialFranchiseFee(e.target.value)}
                placeholder="e.g. 3500"
                className="w-full mt-1 border rounded-md px-2 py-1.5 text-sm"
                data-testid="new-contract-initial-franchise-fee-input" />
              <span className="block mt-1 text-[11px] text-stone-500">
                Enter the initial franchise purchase fee excluding VAT.
                {currentFr?.bought_for != null && currentFr?.bought_for !== "" && (
                  <> This franchisee&apos;s recorded &ldquo;Bought For&rdquo; value has been pre-filled — amend if the historic contract used a different figure.</>
                )}
              </span>
            </label>
          )}
          {/* Renewal fee — only surfaced when the draft supersedes an
              earlier CMS contract. Freezes into the renewal PDF via
              the {{RENEWAL_FEE}} marker (Bucket A). */}
          {(renewalOn && renewalOf?.id) && (
            <label className="block text-sm" data-testid="new-contract-renewal-fee-row">
              <span className="text-stone-700">Renewal fee (£)</span>
              <input
                type="number" step="0.01" min="0"
                value={renewalFee}
                onChange={(e) => setRenewalFee(e.target.value)}
                placeholder="e.g. 500"
                className="w-full mt-1 border rounded-md px-2 py-1.5 text-sm"
                data-testid="new-contract-renewal-fee-input" />
              <span className="block mt-1 text-[11px] text-stone-500">
                One-off renewal fee for the next term (excluding VAT).
              </span>
            </label>
          )}
          {/* Dates & term — populates the ``{{COMMENCEMENT_DATE}}``,
              ``{{RENEWAL_DATE}}`` and ``{{CONTRACT_TERM_YEARS}}``
              markers on the PDF. Renewal-date auto-computes from
              commencement + term until HQ manually overrides it. */}
          <fieldset className="border border-stone-200 rounded-lg p-3 space-y-3" data-testid="new-contract-dates-fieldset">
            <legend className="px-1 text-[10px] uppercase tracking-widest font-bold text-stone-500">Dates &amp; term</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="text-stone-700">Commencement date</span>
                <input
                  type="date"
                  value={commencementDate}
                  onChange={(e) => setCommencementDate(e.target.value)}
                  className="w-full mt-1 border rounded-md px-2 py-1.5 text-sm"
                  data-testid="new-contract-commencement-date-input" />
                <span className="block mt-1 text-[11px] text-stone-500">
                  The date the term starts. Also used as <code className="bg-stone-100 rounded px-1">term_start_date</code>.
                </span>
              </label>
              <label className="block text-sm">
                <span className="text-stone-700">Term (years)</span>
                <input
                  type="number" min="1" max="20" step="1"
                  value={contractTermYears}
                  onChange={(e) => setContractTermYears(e.target.value)}
                  placeholder="e.g. 5"
                  className="w-full mt-1 border rounded-md px-2 py-1.5 text-sm"
                  data-testid="new-contract-term-years-input" />
                <span className="block mt-1 text-[11px] text-stone-500">
                  Length of the agreement in whole years.
                </span>
              </label>
              <label className="block text-sm sm:col-span-2">
                <span className="text-stone-700">Renewal / expiry date</span>
                <input
                  type="date"
                  value={renewalDate}
                  onChange={(e) => { setRenewalDate(e.target.value); setRenewalDateManual(true); }}
                  className="w-full mt-1 border rounded-md px-2 py-1.5 text-sm"
                  data-testid="new-contract-renewal-date-input" />
                <span className="block mt-1 text-[11px] text-stone-500">
                  {renewalDateManual
                    ? "Manual — auto-sync from commencement + term is disabled."
                    : "Auto-computed from Commencement + Term. Edit to override."}
                </span>
              </label>
            </div>
          </fieldset>
          <label className="block text-sm">
            <span className="text-stone-700">Franchisee legal name <span className="text-stone-400 font-normal">(optional override)</span></span>
            <input
              type="text"
              value={franchiseeLegalName}
              onChange={(e) => setFranchiseeLegalName(e.target.value)}
              placeholder={
                currentFr
                  ? `${currentFr.first_name || ""} ${currentFr.last_name || ""}`.trim() || "e.g. Paloma Ibarra"
                  : "e.g. Paloma Ibarra"
              }
              className="w-full mt-1 border rounded-md px-2 py-1.5 text-sm"
              data-testid="new-contract-legal-name-input" />
            <span className="block mt-1 text-[11px] text-stone-500">
              Leave blank to auto-resolve to the franchisee&apos;s <strong>First name + Last name</strong> on the Hub profile.
              Only enter a value here if the signing entity is a limited company or otherwise differs from the natural person&apos;s name.
              <strong> The trading / organisation name resolves separately via <code className="bg-stone-100 rounded px-1">[[FRANCHISEE_ORGANISATION]]</code>.</strong>
            </span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="text-stone-700">HQ signatory name</span>
              <input
                type="text"
                value={hqSignatoryName}
                onChange={(e) => setHqSignatoryName(e.target.value)}
                className="w-full mt-1 border rounded-md px-2 py-1.5 text-sm"
                data-testid="new-contract-hq-name-input" />
            </label>
            <label className="block text-sm">
              <span className="text-stone-700">HQ signatory title</span>
              <input
                type="text"
                value={hqSignatoryTitle}
                onChange={(e) => setHqSignatoryTitle(e.target.value)}
                className="w-full mt-1 border rounded-md px-2 py-1.5 text-sm"
                data-testid="new-contract-hq-title-input" />
            </label>
          </div>
          {err && (
            <div className="p-2 text-xs bg-red-50 border border-red-200 text-red-800 rounded flex items-center gap-1.5">
              <AlertTriangle className="h-3 w-3" /> {err}
            </div>
          )}
        </div>
        <div className="p-4 border-t bg-stone-50 rounded-b-lg flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm border rounded-md bg-white hover:bg-stone-100"
            data-testid="new-contract-cancel-btn">Cancel</button>
          <button
            onClick={submit}
            disabled={saving || !templateId || !franchiseeId}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-md bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
            data-testid="new-contract-save-btn">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Save draft
          </button>
        </div>
      </div>
    </div>
  );
}
