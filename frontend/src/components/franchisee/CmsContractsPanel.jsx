// Franchisee CMS Contracts panel — a compact, franchisee-scoped view
// of the central Contracts collection that lives on the franchisee
// detail page. Reuses the same NewContractModal and StatusPill exported
// by AdminContractsPage so we never duplicate the underlying workflow
// (create draft → preview → issue → upload signed / signed via portal).
//
// UX responsibilities:
//   * List every contract for this franchisee (draft/issued/signed/
//     superseded) with the same status pills as the central page.
//   * Provide Preview / Issue / Download / Upload-signed actions for
//     each row — identical behaviour to the central Admin Contracts
//     page, exercised against the same endpoints.
//   * Wire the "Add / Renew Contract" button on the franchisee page:
//     open the shared NewContractModal with the franchisee **locked**
//     and (when a prior CMS contract exists) the renewal toggle
//     pre-selected so `supersedes_id` is set on save.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "@/lib/api";
import { resolveAndIssueContract } from "@/lib/contractIssuance";
import {
  Loader2, FileText, Download, Upload, CheckCircle2, AlertTriangle, Trash2,
} from "lucide-react";
import { NewContractModal, StatusPill } from "@/pages/AdminContractsPage";

function fmt(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }); }
  catch { return iso; }
}

export default function CmsContractsPanel({
  franchiseeId, openSignal, onModalHandled,
}) {
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
        api.get("/admin/contracts", { params: { franchisee_id: franchiseeId } }),
        api.get("/admin/contract-templates"),
        api.get("/franchisees", { params: { limit: 500 } }),
      ]);
      setRows(c.data.items || []);
      setTemplates((t.data.items || []).filter((x) => ["approved", "current"].includes(x.status)));
      setFranchisees(f.data.items || f.data || []);
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message || "Failed to load contracts");
    } finally {
      setLoading(false);
    }
  }, [franchiseeId]);

  useEffect(() => { load(); }, [load]);

  // Parent-controlled trigger — the franchisee page's Contracts panel
  // already has an "Add / Renew contract" button. When it toggles
  // ``openSignal`` we open this modal, then acknowledge back so the
  // parent can reset its trigger.
  useEffect(() => {
    if (openSignal) {
      setShowNew(true);
      onModalHandled?.();
    }
  }, [openSignal, onModalHandled]);

  const templateById = useMemo(() =>
    Object.fromEntries(templates.map((t) => [t.id, t])), [templates]);

  // Pick the most-recent renewable predecessor for the renewal toggle.
  // Issued OR signed contracts (but not superseded/draft) can be the
  // target of a supersede. Order by created_at desc.
  const renewalOf = useMemo(() => {
    const candidates = rows
      .filter((r) => r.status === "issued" || r.status === "signed")
      .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    return candidates[0] || null;
  }, [rows]);

  async function resolveAndIssue(cid) {
    setBusyRow(cid);
    try {
      const c = rows.find((r) => r.id === cid);
      const result = await resolveAndIssueContract(cid, {
        hasResolvedVariables: !!c?.contract_variables,
      });
      if (!result.ok) {
        alert(result.message);
        return;
      }
      await load();
    } finally { setBusyRow(null); }
  }

  async function downloadDraftPreview(cid) {
    try {
      const resp = await api.post(
        `/admin/contracts/${cid}/preview-pdf`, null, { responseType: "blob" },
      );
      const url = window.URL.createObjectURL(
        new Blob([resp.data], { type: "application/pdf" }),
      );
      // Popup blockers routinely reject ``window.open`` after ``await``
      // — the click event context is lost. Use a hidden <a download>
      // anchor so the browser treats it as a same-tick download / navigation
      // and never silently ignores it.
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      a.download = `contract-${cid.slice(0, 8)}-preview.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => window.URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      alert(`Preview failed: ${e?.response?.data?.detail || e.message}`);
    }
  }

  async function deleteContract(cid) {
    if (!window.confirm(
      "Delete this draft contract?\n\nThis removes the draft, its preview PDFs and its audit trail. Only available for drafts — issued or signed contracts cannot be deleted.",
    )) return;
    try {
      await api.delete(`/admin/contracts/${cid}`);
      await load();
    } catch (e) {
      alert(`Delete failed: ${e?.response?.data?.detail || e.message}`);
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

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-stone-500 py-3" data-testid="cms-contracts-loading">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading contract records…
      </div>
    );
  }

  return (
    <div data-testid="cms-contracts-panel">
      {err && (
        <div className="mb-2 p-2 bg-red-50 border border-red-200 text-red-800 text-xs rounded flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5" /> {err}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="text-xs text-stone-500 py-2" data-testid="cms-contracts-empty">
          No contracts on the central Contracts register yet. Use
          <strong> Add / Renew contract</strong> to create a draft — you&apos;ll be
          able to preview it before issuing to the franchisee.
        </div>
      ) : (
        <div className="border border-stone-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm" data-testid="cms-contracts-table">
            <thead className="bg-stone-50 border-b border-stone-200">
              <tr className="text-left text-[10px] uppercase tracking-widest text-stone-600 font-bold">
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Reference</th>
                <th className="px-3 py-2">Template</th>
                <th className="px-3 py-2">Monthly fee</th>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const tpl = templateById[c.template_id];
                const isBusy = busyRow === c.id;
                const ref = c.contract_reference
                  || c.contract_variables?.values?.CONTRACT_REFERENCE?.value
                  || `#${c.id.slice(0, 8)}`;
                return (
                  <tr key={c.id} className="border-b border-stone-100 last:border-0 hover:bg-stone-50"
                      data-testid={`cms-contract-row-${c.id}`}>
                    <td className="px-3 py-2"><StatusPill status={c.status} /></td>
                    <td className="px-3 py-2 text-xs font-mono text-stone-700">{ref}</td>
                    <td className="px-3 py-2 text-xs text-stone-700">
                      <div>{tpl?.name || c.template_id?.slice(0, 8)}</div>
                      {tpl?.contract_type && (
                        <div className="text-[10px] text-stone-500">{tpl.contract_type}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-stone-700">
                      {c.monthly_fee != null ? `£${Number(c.monthly_fee).toFixed(2)}` : "—"}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-stone-500 tabular-nums">
                      {fmt(c.created_at)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-1.5 flex-wrap">
                        {c.status === "draft" && (
                          <button
                            onClick={() => downloadDraftPreview(c.id)}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border rounded bg-white hover:bg-stone-50"
                            data-testid={`cms-contract-preview-btn-${c.id}`}
                            title="Preview draft with a PREVIEW watermark. Does not change status or expose to the franchisee.">
                            <FileText className="h-3 w-3" /> Preview
                          </button>
                        )}
                        {c.status === "draft" && (
                          <button
                            onClick={() => resolveAndIssue(c.id)}
                            disabled={isBusy}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border rounded bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                            data-testid={`cms-contract-issue-btn-${c.id}`}>
                            {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                            Issue
                          </button>
                        )}
                        {c.status === "draft" && (
                          <button
                            onClick={() => deleteContract(c.id)}
                            disabled={isBusy}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border border-red-300 rounded bg-white text-red-700 hover:bg-red-50 disabled:opacity-50"
                            data-testid={`cms-contract-delete-btn-${c.id}`}
                            title="Delete this draft contract (irreversible).">
                            <Trash2 className="h-3 w-3" /> Delete
                          </button>
                        )}
                        {(c.status === "issued" || c.status === "signed" || c.status === "superseded") && c.personalised_pdf_r2_key && (
                          <button
                            onClick={() => downloadPersonalised(c.id)}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border rounded bg-white hover:bg-stone-50"
                            data-testid={`cms-contract-download-btn-${c.id}`}>
                            <Download className="h-3 w-3" /> PDF
                          </button>
                        )}
                        {c.status === "issued" && (
                          <button
                            onClick={() => openUploadPicker(c.id)}
                            disabled={isBusy}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border rounded bg-sky-600 border-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
                            data-testid={`cms-contract-upload-signed-btn-${c.id}`}>
                            {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                            Upload signed
                          </button>
                        )}
                        {c.status === "signed" && c.signed_pdf_r2_key && (
                          <button
                            onClick={() => downloadSigned(c.id)}
                            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border rounded bg-white hover:bg-stone-50"
                            data-testid={`cms-contract-download-signed-btn-${c.id}`}>
                            <Download className="h-3 w-3" /> Signed
                          </button>
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
        data-testid="cms-contracts-hidden-upload-input"
      />

      {showNew && (
        <NewContractModal
          templates={templates}
          franchisees={franchisees}
          lockedFranchiseeId={franchiseeId}
          renewalOf={renewalOf}
          onClose={() => setShowNew(false)}
          onCreated={async () => { setShowNew(false); await load(); }}
        />
      )}
    </div>
  );
}
