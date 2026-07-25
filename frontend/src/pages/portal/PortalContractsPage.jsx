// Franchisee Portal — Contracts (accept flow)
// One page: list issued contracts + an "Open" button that shows the
// PDF preview + acceptance form. No wizard, no drawn signature.
import { useCallback, useEffect, useState } from "react";
import api from "@/lib/api";
import { Loader2, FileText, Download, AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react";

const ACCEPTANCE_WORDING =
  "I confirm that I have read and agree to the terms of this franchise agreement.";

function StatusPill({ status }) {
  const styles = {
    issued:     "bg-emerald-50 text-emerald-800 border-emerald-300",
    signed:     "bg-sky-50 text-sky-800 border-sky-300",
    superseded: "bg-stone-50 text-stone-500 border-stone-200",
  };
  const labels = { issued: "Awaiting your acceptance", signed: "Signed", superseded: "Superseded" };
  return (
    <span data-testid={`portal-contract-status-${status}`}
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs border font-medium ${styles[status] || ""}`}>
      {labels[status] || status}
    </span>
  );
}

export default function PortalContractsPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [active, setActive] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const { data } = await api.get("/portal/contracts");
      setRows(data.items || []);
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="p-6 max-w-5xl mx-auto" data-testid="portal-contracts-page">
      <h1 className="text-2xl font-semibold mb-4" data-testid="portal-contracts-heading">My Contracts</h1>

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
        <div className="p-8 text-center text-stone-500 border border-dashed rounded-md" data-testid="portal-contracts-empty">
          You don&apos;t have any contracts yet.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((c) => (
            <div key={c.id} className="border rounded-lg bg-white p-4 flex items-center justify-between gap-4"
                 data-testid={`portal-contract-row-${c.id}`}>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <StatusPill status={c.status} />
                  <span className="text-xs text-stone-500">{c.contract_reference || c.id.slice(0, 12)}</span>
                </div>
                <div className="text-sm text-stone-700 mt-1">
                  Issued: {c.issued_at ? new Date(c.issued_at).toLocaleString("en-GB") : "—"}
                  {c.signed_at && (
                    <span className="ml-3">Signed: {new Date(c.signed_at).toLocaleString("en-GB")}</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => setActive(c)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-md bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700"
                data-testid={`portal-contract-open-${c.id}`}>
                <ExternalLink className="h-3.5 w-3.5" /> Open
              </button>
            </div>
          ))}
        </div>
      )}

      {active && (
        <ContractDetail
          contract={active}
          onClose={() => setActive(null)}
          onSigned={async () => { setActive(null); await load(); }}
        />
      )}
    </div>
  );
}

function ContractDetail({ contract, onClose, onSigned }) {
  const [pdfUrl, setPdfUrl] = useState("");
  const [checkbox, setCheckbox] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [signing, setSigning] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const endpoint = contract.status === "signed"
          ? `/portal/contracts/${contract.id}/signed-pdf`
          : `/portal/contracts/${contract.id}/personalised-pdf`;
        const { data } = await api.get(endpoint);
        setPdfUrl(data.url);
      } catch (e) {
        setErr(e?.response?.data?.detail || e.message);
      }
    })();
  }, [contract.id, contract.status]);

  async function accept() {
    setErr(""); setSigning(true);
    try {
      await api.post(`/portal/contracts/${contract.id}/accept`, {
        checkbox_confirmed: true,
        typed_name: typedName.trim(),
      });
      await onSigned();
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message);
    } finally { setSigning(false); }
  }

  const canAccept = checkbox && typedName.trim().length >= 2 && !signing && contract.status === "issued";

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-stretch p-4" data-testid="portal-contract-detail">
      <div className="bg-white rounded-lg shadow-xl m-auto w-full max-w-6xl flex flex-col" style={{ maxHeight: "94vh" }}>
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <div className="flex items-center gap-2">
              <StatusPill status={contract.status} />
              <span className="text-sm text-stone-700">{contract.contract_reference || contract.id.slice(0, 12)}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {pdfUrl && (
              <a href={pdfUrl} target="_blank" rel="noreferrer"
                 className="inline-flex items-center gap-1 px-3 py-1.5 text-sm border rounded-md bg-white hover:bg-stone-50"
                 data-testid="portal-contract-download-btn">
                <Download className="h-3.5 w-3.5" /> Download
              </a>
            )}
            <button onClick={onClose} className="text-stone-500 hover:text-stone-800 text-sm border rounded-md px-3 py-1.5"
                    data-testid="portal-contract-close-btn">Close</button>
          </div>
        </div>
        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-3">
          {/* PDF viewer */}
          <div className="md:col-span-2 border-r bg-stone-100">
            {pdfUrl ? (
              <iframe title="contract" src={pdfUrl} className="w-full h-full min-h-[560px]" data-testid="portal-contract-pdf-iframe" />
            ) : (
              <div className="p-8 text-stone-500 text-sm">Loading PDF…</div>
            )}
          </div>
          {/* Acceptance form */}
          <div className="p-5">
            {contract.status === "signed" ? (
              <div className="text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md p-3 text-sm flex items-start gap-2"
                   data-testid="portal-contract-signed-notice">
                <CheckCircle2 className="h-4 w-4 mt-0.5" />
                <div>
                  <div className="font-semibold">Signed on {new Date(contract.signed_at).toLocaleString("en-GB")}</div>
                  <div className="text-xs text-emerald-700 mt-1">
                    Accepted by {contract.acceptance_record?.typed_name || "franchisee"}
                  </div>
                </div>
              </div>
            ) : (
              <>
                <h2 className="text-lg font-semibold mb-2">Accept and sign contract</h2>
                <p className="text-sm text-stone-600 mb-4">
                  Please read the contract above carefully. When you&apos;re ready,
                  tick the confirmation box, type your full name, and click
                  <em> Accept and sign contract</em>.
                </p>
                <label className="flex items-start gap-2 text-sm mb-3 cursor-pointer" data-testid="portal-contract-agree-wrap">
                  <input
                    type="checkbox"
                    checked={checkbox}
                    onChange={(e) => setCheckbox(e.target.checked)}
                    className="mt-1"
                    data-testid="portal-contract-agree-checkbox" />
                  <span>{ACCEPTANCE_WORDING}</span>
                </label>
                <label className="block text-sm mb-4">
                  <span className="text-stone-700">Your full name</span>
                  <input
                    type="text"
                    value={typedName}
                    onChange={(e) => setTypedName(e.target.value)}
                    placeholder="Type your full name"
                    className="w-full mt-1 border rounded-md px-2 py-1.5 text-sm"
                    data-testid="portal-contract-name-input" />
                </label>
                {err && (
                  <div className="mb-3 text-xs bg-red-50 border border-red-200 text-red-800 rounded p-2 flex items-center gap-1.5">
                    <AlertTriangle className="h-3 w-3" /> {err}
                  </div>
                )}
                <button
                  onClick={accept}
                  disabled={!canAccept}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-sm border rounded-md bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700 disabled:opacity-50"
                  data-testid="portal-contract-accept-btn">
                  {signing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  Accept and sign contract
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
