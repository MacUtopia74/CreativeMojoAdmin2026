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
import { useCallback, useEffect, useRef, useState } from "react";
import api, { API_BASE as API, getAccessToken } from "@/lib/api";
import ContractPdfViewer from "@/components/contracts/ContractPdfViewer";
import SignatureCanvas from "react-signature-canvas";
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
  const [signing, setSigning] = useState(false);
  const [err, setErr] = useState("");
  // Ref to the signature canvas so accept() can read the drawn PNG
  // on submit without every stroke re-rendering the parent.
  const sigPadRef = useRef(null);
  const [sigEmpty, setSigEmpty] = useState(true);
  // Set to true the first time the viewer reports the last page has
  // become visible. Never unset — a signer who scrolls back up is
  // still trusted to have read the contract.
  const [reachedEnd, setReachedEnd] = useState(false);
  // Sticky flag set when the PDF viewer itself is broken (worker
  // load failed, network error, etc). While true we NEVER allow the
  // sign button to enable — even if reachedEnd flips somehow.
  const [viewerBroken, setViewerBroken] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        // Same-origin streaming endpoint. Prev version handed the
        // R2 pre-signed URL directly to pdfjs; the browser's PDF.js
        // worker fetch was blocked by R2 CORS ("Failed to fetch").
        // Streaming through the Hub keeps the request same-origin
        // and picks up the session cookie / bearer automatically.
        const variant = row.status === "signed" ? "signed" : "personalised";
        const streamUrl = `${API}/portal/contracts/${row.id}/pdf?variant=${variant}`;
        // Also fetch the R2 pre-signed URL — used ONLY as the
        // "Download" affordance where a direct link is fine (a
        // top-level <a href> download isn't subject to CORS).
        const legacyEndpoint = row.status === "signed"
          ? `/portal/contracts/${row.id}/signed-pdf`
          : `/portal/contracts/${row.id}/personalised-pdf`;
        const { data } = await api.get(legacyEndpoint);
        // TEMP DIAGNOSTIC — logs the exact URL + HTTP status the
        // viewer will use so we can spot auth/CORS/redirect issues
        // in the wild. Safe to remove once the fix is stable.
        try {
          const probe = await fetch(streamUrl, {
            credentials: "include",
            headers: { Authorization: `Bearer ${getAccessToken() || ""}` },
          });
          console.info(
            "[ContractPdfViewer] resolved PDF URL",
            { url: streamUrl, status: probe.status, contentType: probe.headers.get("content-type") },
          );
        } catch (probeErr) {
          console.warn("[ContractPdfViewer] PDF URL probe failed", streamUrl, probeErr);
        }
        setPdfUrl(streamUrl);
        setDownloadUrl(data.url);
      } catch (e) {
        setErr(e?.response?.data?.detail || e.message);
      }
    })();
  }, [row.id, row.status]);

  async function accept() {
    setErr(""); setSigning(true);
    try {
      const pad = sigPadRef.current;
      if (!pad || pad.isEmpty()) {
        setErr("Please draw your signature to sign.");
        setSigning(false);
        return;
      }
      // Capture the drawn signature as a transparent PNG data URL.
      // ``toDataURL()`` on the trimmed canvas returns the full canvas
      // but signature-canvas exposes ``getTrimmedCanvas()`` which
      // crops to the ink bounds — keeps the payload small and lines
      // up perfectly when the server-side scaler crops any remaining
      // padding.
      const dataUrl = pad.getTrimmedCanvas().toDataURL("image/png");
      await api.post(`/portal/contracts/${row.id}/accept`, {
        checkbox_confirmed: true,
        signature_png_b64: dataUrl,
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
  const hasSignatureAnchor = row.has_signature_anchor !== false; // undefined = permissive for legacy list rows; server does the real gate
  // Sign button stays disabled whenever the viewer itself is broken —
  // we can't legitimately claim the signer "read the contract" if
  // pdfjs never rendered it. Also disabled without a drawn signature
  // and without a signature anchor on the contract.
  const canAccept =
    checkbox && !sigEmpty && reachedEnd &&
    !signing && !viewerBroken && hasSignatureAnchor &&
    row.status === "issued";
  const lockedReasons = [];
  if (!hasSignatureAnchor) lockedReasons.push("this contract needs to be reissued by HQ");
  if (viewerBroken) lockedReasons.push("PDF viewer failed — refresh the page");
  if (!reachedEnd) lockedReasons.push("scroll to the final page");
  if (!checkbox) lockedReasons.push("tick the confirmation box");
  if (sigEmpty && hasSignatureAnchor) lockedReasons.push("draw your signature");

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
                fileHeaders={{
                  // Same-origin authenticated PDF endpoint — pass
                  // the current bearer so pdfjs' fetch is
                  // authorised. Cookies would work too, but the
                  // Hub is JWT-in-header only.
                  Authorization: `Bearer ${getAccessToken() || ""}`,
                }}
                downloadUrl={downloadUrl}
                fileName={`${row.contract_reference || row.id}.pdf`}
                // Only listen for last-page while the contract is still
                // awaiting signature — once signed we don't need the
                // gate anymore.
                onReachedLastPage={isSigned ? undefined : () => setReachedEnd(true)}
                // If the viewer itself fails to boot (missing worker,
                // corrupt PDF, ingress rewriting the worker URL to
                // index.html) we latch ``viewerBroken`` so the sign
                // button stays hard-disabled regardless of whether
                // the intersection observer misfires. Preserves the
                // spec rule "Do not enable signing when the viewer
                // fails to load."
                onViewerError={() => setViewerBroken(true)}
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
                    Accepted by {row.acceptance_record?.signer_identity?.full_name
                      || row.acceptance_record?.franchisee_full_name
                      || "franchisee"}
                  </div>
                  <div className="text-xs text-emerald-700 mt-2">
                    The signed PDF above is the immutable record. Download or
                    print it for your files.
                  </div>
                </div>
              </div>
            ) : !hasSignatureAnchor ? (
              // Legacy contract issued before the
              // [[FRANCHISEE_SIGNATURE_POSITION]] marker was added to
              // the template. HARD block — no fallback, no text
              // detection, no boxed overlay. HQ must reissue.
              <div
                className="text-amber-900 bg-amber-50 border border-amber-300 rounded-md p-4 text-sm"
                data-testid="portal-contract-reissue-required"
              >
                <div className="font-semibold mb-1 flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4" />
                  Contract needs to be reissued
                </div>
                <div className="text-xs mt-1 text-amber-800 leading-relaxed">
                  This contract was issued before our new electronic signature
                  workflow. It doesn&apos;t include a signature position marker,
                  so we can&apos;t place your drawn signature on the correct line.
                  <br/><br/>
                  Please contact Creative Mojo to have the contract reissued from
                  an updated template.
                </div>
              </div>
            ) : (
              <>
                <h2 className="text-lg font-semibold mb-2">Accept and sign contract</h2>
                <p className="text-sm text-stone-600 mb-4">
                  Please read the contract in full — signing is only available
                  once you&apos;ve scrolled to the final page. When you&apos;re
                  ready, tick the confirmation box, draw your signature and click
                  <em> Accept and sign contract</em>.
                </p>

                {/* Progress cue */}
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

                {/* Signature pad */}
                <div className={`mb-4 ${reachedEnd ? "" : "opacity-50 pointer-events-none"}`}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm text-stone-700 font-medium">
                      Draw your signature
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        sigPadRef.current?.clear();
                        setSigEmpty(true);
                      }}
                      className="text-xs text-stone-500 hover:text-stone-800 underline"
                      data-testid="portal-contract-signature-clear-btn"
                    >
                      Clear signature
                    </button>
                  </div>
                  <div
                    className="rounded-md border border-stone-300 bg-white touch-none"
                    // ``touch-none`` disables browser scroll gestures
                    // on touch devices so a signer can drag their
                    // finger without accidentally scrolling the panel.
                    data-testid="portal-contract-signature-pad"
                  >
                    <SignatureCanvas
                      ref={sigPadRef}
                      penColor="#0f172a"
                      onEnd={() => setSigEmpty(!!sigPadRef.current?.isEmpty())}
                      canvasProps={{
                        width: 380,
                        height: 140,
                        className: "w-full h-[140px] rounded-md",
                      }}
                    />
                  </div>
                  <div className="text-[11px] text-stone-500 mt-1">
                    Works with mouse, trackpad, touchscreen and stylus.
                  </div>
                </div>

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
