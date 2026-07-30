// Franchisee-facing contracts list + acceptance flow.
//
// Two exports:
//   * PortalContractsPage — the full standalone page (kept for deep
//     links from HQ emails: /portal/contracts and
//     /portal/contracts?open=<id>). Also honours the existing route.
//   * PortalContractsSection — the same list + accept flow but wrapped
//     to slot inline as a "My Contracts" section on the My Franchise
//     page (per Paul's spec: no separate tab, live alongside the
//     current-contract mini row).
//
// Both share the same list/detail internals. Only the outer chrome
// differs (page heading + centred container vs. section card).
import { useCallback, useEffect, useState } from "react";
import api from "@/lib/api";
import ContractPdfViewer from "@/components/contracts/ContractPdfViewer";
import {
  Loader2, AlertTriangle, CheckCircle2, ExternalLink, FileSignature, Lock,
} from "lucide-react";

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

// Shared body: list of contracts + accept modal. Rendered without any
// outer heading/container — the caller wraps it however it likes.
function ContractsBody() {
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

  if (err) {
    return (
      <div className="p-3 bg-red-50 border border-red-200 text-red-800 text-sm rounded flex items-center gap-2"
           data-testid="portal-contracts-error">
        <AlertTriangle className="h-4 w-4" /> {err}
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-stone-500 py-10 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="p-6 text-center text-stone-500 border border-dashed rounded-md text-sm"
           data-testid="portal-contracts-empty">
        You don&apos;t have any contracts yet.
      </div>
    );
  }
  return (
    <>
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
      {active && (
        <ContractDetail
          contract={active}
          onClose={() => setActive(null)}
          onSigned={async (updatedContract) => {
            // Keep the modal open — swap `active` to the freshly-signed
            // row so the viewer re-fetches the /signed-pdf URL and the
            // right-hand pane flips to the signed confirmation card.
            // We still refresh the outer list so status pills update in
            // the background.
            setActive(updatedContract);
            await load();
          }}
        />
      )}
    </>
  );
}

// Standalone page (kept for HQ email deep-links).
export default function PortalContractsPage() {
  return (
    <div className="p-6 max-w-5xl mx-auto" data-testid="portal-contracts-page">
      <h1 className="text-2xl font-semibold mb-4" data-testid="portal-contracts-heading">My Contracts</h1>
      <ContractsBody />
    </div>
  );
}

// Inline section (used on the My Franchise page).
export function PortalContractsSection() {
  return (
    <section
      className="bg-white border border-stone-200 rounded-2xl px-4 sm:px-6 py-5 sm:py-6"
      data-testid="portal-my-contracts-section"
    >
      <div className="flex items-center gap-3 mb-5 pb-4 border-b border-stone-200">
        <FileSignature className="w-6 h-6 text-stone-700 shrink-0" />
        <h1 className="font-display text-2xl sm:text-3xl font-black text-stone-950 tracking-tight">
          My Contracts
        </h1>
      </div>
      <ContractsBody />
    </section>
  );
}

function ContractDetail({ contract, onClose, onSigned }) {
  // Local snapshot of the row — starts as the row from the outer list
  // and gets replaced by the fresh /portal/contracts/{id} record after
  // signing so the pane flips to the signed confirmation without the
  // modal ever closing.
  const [row, setRow] = useState(contract);
  const [pdfUrl, setPdfUrl] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [checkbox, setCheckbox] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [signing, setSigning] = useState(false);
  const [err, setErr] = useState("");
  // Set to true the first time the viewer reports the last page has
  // become visible. Never unset — a signer who scrolls back up is
  // still trusted to have read the contract.
  const [reachedEnd, setReachedEnd] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const endpoint = row.status === "signed"
          ? `/portal/contracts/${row.id}/signed-pdf`
          : `/portal/contracts/${row.id}/personalised-pdf`;
        const { data } = await api.get(endpoint);
        setPdfUrl(data.url);
        setDownloadUrl(data.url);
      } catch (e) {
        setErr(e?.response?.data?.detail || e.message);
      }
    })();
  }, [row.id, row.status]);

  async function accept() {
    setErr(""); setSigning(true);
    try {
      await api.post(`/portal/contracts/${row.id}/accept`, {
        checkbox_confirmed: true,
        typed_name: typedName.trim(),
      });
      // Fetch the fresh contract row (now status=signed) so the modal
      // re-renders with the signed confirmation + signed PDF URL.
      const { data } = await api.get("/portal/contracts");
      const updated = (data.items || []).find((c) => c.id === row.id) || { ...row, status: "signed" };
      // Reset the PDF URL so useEffect above re-fires against the new
      // /signed-pdf endpoint (avoids showing the pre-stamp PDF for a
      // frame while the request is in flight).
      setPdfUrl("");
      setRow(updated);
      // Notify parent so its list refreshes in the background.
      onSigned?.(updated);
    } catch (e) {
      // Keep the modal open, surface the error, allow retry — spec
      // requirement. No modal close, no toast.
      setErr(e?.response?.data?.detail || e.message || "Signing failed. Please try again.");
    } finally { setSigning(false); }
  }

  const isSigned = row.status === "signed";
  const nameLongEnough = typedName.trim().length >= 2;
  const canAccept = checkbox && nameLongEnough && reachedEnd && !signing && row.status === "issued";
  const lockedReasons = [];
  if (!reachedEnd) lockedReasons.push("scroll to the final page");
  if (!checkbox) lockedReasons.push("tick the confirmation box");
  if (!nameLongEnough) lockedReasons.push("type your full name");

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-stretch p-2 sm:p-4" data-testid="portal-contract-detail">
      <div className="bg-white rounded-lg shadow-xl m-auto w-full max-w-7xl flex flex-col" style={{ maxHeight: "96vh", height: "96vh" }}>
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusPill status={row.status} />
            <span className="text-sm text-stone-700">
              {row.contract_reference || row.id.slice(0, 12)}
            </span>
          </div>
          <button onClick={onClose} className="text-stone-500 hover:text-stone-800 text-sm border rounded-md px-3 py-1.5"
                  data-testid="portal-contract-close-btn">Close</button>
        </div>
        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-3">
          <div className="md:col-span-2 border-r min-h-0 flex flex-col">
            {pdfUrl ? (
              <ContractPdfViewer
                fileUrl={pdfUrl}
                downloadUrl={downloadUrl}
                fileName={`${row.contract_reference || row.id}.pdf`}
                // Only listen for last-page while the contract is still
                // awaiting signature — once signed we don't need the
                // gate anymore.
                onReachedLastPage={isSigned ? undefined : () => setReachedEnd(true)}
              />
            ) : (
              <div className="p-8 text-stone-500 text-sm flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading contract PDF…
              </div>
            )}
          </div>
          <div className="p-5 overflow-auto">
            {isSigned ? (
              <div className="text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md p-3 text-sm flex items-start gap-2"
                   data-testid="portal-contract-signed-notice">
                <CheckCircle2 className="h-4 w-4 mt-0.5" />
                <div>
                  <div className="font-semibold">
                    Signed on {new Date(row.signed_at).toLocaleString("en-GB")}
                  </div>
                  <div className="text-xs text-emerald-700 mt-1">
                    Accepted by {row.acceptance_record?.typed_name || "franchisee"}
                  </div>
                  <div className="text-xs text-emerald-700 mt-2">
                    The signed PDF above is the immutable record. Download or
                    print it for your files.
                  </div>
                </div>
              </div>
            ) : (
              <>
                <h2 className="text-lg font-semibold mb-2">Accept and sign contract</h2>
                <p className="text-sm text-stone-600 mb-4">
                  Please read the contract in full — signing is only available
                  once you&apos;ve scrolled to the final page. When you&apos;re
                  ready, tick the confirmation box, type your full name and
                  click <em>Accept and sign contract</em>.
                </p>

                {/* "Reached the end?" progress row — the visible cue
                    that flips green once the viewer observes the last
                    page. Sits above the form so it's the first thing
                    the eye lands on. */}
                <div
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 mb-3 text-xs ${
                    reachedEnd
                      ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                      : "bg-amber-50 border-amber-200 text-amber-800"
                  }`}
                  data-testid="portal-contract-scroll-progress"
                  data-reached-end={reachedEnd ? "true" : "false"}
                >
                  {reachedEnd
                    ? <CheckCircle2 className="h-3.5 w-3.5" />
                    : <Lock className="h-3.5 w-3.5" />}
                  <span>
                    {reachedEnd
                      ? "You've reached the end of the contract — signing unlocked."
                      : "Scroll to the final page to unlock signing."}
                  </span>
                </div>

                <label
                  className={`flex items-start gap-2 text-sm mb-3 ${reachedEnd ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}
                  data-testid="portal-contract-agree-wrap"
                >
                  <input
                    type="checkbox"
                    checked={checkbox}
                    disabled={!reachedEnd}
                    onChange={(e) => setCheckbox(e.target.checked)}
                    className="mt-1"
                    data-testid="portal-contract-agree-checkbox"
                  />
                  <span>{ACCEPTANCE_WORDING}</span>
                </label>
                <label className={`block text-sm mb-4 ${reachedEnd ? "" : "opacity-50"}`}>
                  <span className="text-stone-700">Your full name</span>
                  <input
                    type="text"
                    value={typedName}
                    disabled={!reachedEnd}
                    onChange={(e) => setTypedName(e.target.value)}
                    placeholder="Type your full name"
                    className="w-full mt-1 border rounded-md px-2 py-1.5 text-sm disabled:bg-stone-50"
                    data-testid="portal-contract-name-input"
                  />
                </label>
                {err && (
                  <div className="mb-3 text-xs bg-red-50 border border-red-200 text-red-800 rounded p-2 flex items-start gap-1.5"
                       data-testid="portal-contract-sign-error">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                    <div>
                      <div className="font-semibold mb-0.5">Signing failed</div>
                      <div>{err}</div>
                    </div>
                  </div>
                )}
                <button
                  onClick={accept}
                  disabled={!canAccept}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-sm border rounded-md bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="portal-contract-accept-btn"
                >
                  {signing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  Accept and sign contract
                </button>
                {!canAccept && !signing && lockedReasons.length > 0 && (
                  <div className="mt-2 text-[11px] text-stone-500" data-testid="portal-contract-locked-hint">
                    Still needed: {lockedReasons.join(" · ")}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
