// Marker Review Modal — Phase 1B Turn C.
//
// Full-screen review workspace for a single contract template. Pairs the
// pdf.js-rendered page canvas with react-rnd overlays over each detected
// marker's `render_bbox`, exposes a property panel for the selected
// occurrence, a substitution-ack side panel with per-family and bulk
// acknowledgement, and the whole-document sample preview refresh /
// download controls. `token_bbox` is treated as read-only (character-tight
// against the source glyphs — never draggable or resizable).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Rnd } from "react-rnd";
import * as pdfjsLib from "pdfjs-dist";
import api, { formatError } from "@/lib/api";
import {
  X, Loader2, Plus, Trash2, RefreshCw, Download, ChevronLeft,
  ChevronRight, ZoomIn, ZoomOut, Check, AlertTriangle, ImageIcon,
  Copy, FileArchive, Clock, Zap, Eye,
} from "lucide-react";

// Worker served from /public — see contract_preview_generator docs.
if (typeof window !== "undefined" && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
}

const ALIGN_VALUES = ["left", "center", "right", "justify"];

async function fetchAuthedImage(path) {
  const r = await api.get(path, { responseType: "blob" });
  return URL.createObjectURL(new Blob([r.data], { type: "image/png" }));
}

export default function MarkerReviewModal({ templateId, onClose }) {
  const [summary, setSummary] = useState(null);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pageNum, setPageNum] = useState(1);
  const [scale, setScale] = useState(1.4);
  const [selectedOid, setSelectedOid] = useState(null);
  const [addMode, setAddMode] = useState(false);
  const [addCode, setAddCode] = useState("");
  const [libraryCodes, setLibraryCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [showBulkAckConfirm, setShowBulkAckConfirm] = useState(null);
  const [deleteConfirmOid, setDeleteConfirmOid] = useState(null);
  const [duplicatePreview, setDuplicatePreview] = useState(null);
  const [showAuditLog, setShowAuditLog] = useState(false);
  const [matchSourcePreview, setMatchSourcePreview] = useState(null);
  const [inlinePreviewOn, setInlinePreviewOn] = useState(true);
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);

  const loadSummary = useCallback(async () => {
    const { data } = await api.get(`/admin/contract-templates/${templateId}/marker-summary`);
    setSummary(data);
    return data;
  }, [templateId]);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true); setErr("");
        const s = await loadSummary();
        const lib = await api.get(`/admin/markers-library?include_hidden=false`);
        const codes = (lib.data.items || []).map((m) => m.code).sort();
        setLibraryCodes(codes);
        if (codes.length) setAddCode(codes[0]);
        const pdfResp = await api.get(
          `/admin/contract-templates/${templateId}/source-pdf`,
          { responseType: "arraybuffer" },
        );
        const doc = await pdfjsLib.getDocument({ data: pdfResp.data }).promise;
        setPdfDoc(doc);
        const firstPage = (s.markers?.[0]?.page) || 1;
        setPageNum(firstPage);
      } catch (e) {
        setErr(formatError(e));
      } finally {
        setLoading(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return undefined;
    let cancelled = false;
    (async () => {
      const page = await pdfDoc.getPage(pageNum);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      await page.render({ canvasContext: ctx, viewport }).promise;
      setPageSize({
        width: viewport.width, height: viewport.height,
        ptHeight: page.view[3], ptWidth: page.view[2],
      });
    })();
    return () => { cancelled = true; };
  }, [pdfDoc, pageNum, scale]);

  const markers = summary?.markers || [];
  const pageMarkers = useMemo(
    () => markers.filter((m) => m.page === pageNum),
    [markers, pageNum],
  );
  const selectedMarker = useMemo(
    () => markers.find((m) => m.occurrence_id === selectedOid) || null,
    [markers, selectedOid],
  );

  const toPx = useCallback((bbox) => {
    if (!bbox || bbox.length !== 4) return null;
    const [x0, y0, x1, y1] = bbox;
    return { x: x0 * scale, y: y0 * scale, w: (x1 - x0) * scale, h: (y1 - y0) * scale };
  }, [scale]);
  const toPt = useCallback((rect) => [
    rect.x / scale, rect.y / scale, (rect.x + rect.w) / scale, (rect.y + rect.h) / scale,
  ], [scale]);

  const persistOccurrence = async (oid, patch) => {
    setBusy(true); setErr("");
    try {
      await api.patch(`/admin/contract-templates/${templateId}/markers/${oid}`, patch);
      await loadSummary();
    } catch (e) { setErr(formatError(e)); }
    finally { setBusy(false); }
  };

  const addOccurrence = async (bboxPt) => {
    if (!addCode) return;
    setBusy(true); setErr("");
    try {
      const { data } = await api.post(
        `/admin/contract-templates/${templateId}/markers`,
        { code: addCode, page: pageNum, render_bbox: bboxPt, font_size: 11, alignment: "left" },
      );
      await loadSummary();
      setSelectedOid(data.occurrence?.occurrence_id);
      setAddMode(false);
    } catch (e) { setErr(formatError(e)); }
    finally { setBusy(false); }
  };

  const deleteOccurrence = async (oid) => {
    setBusy(true); setErr("");
    try {
      await api.delete(`/admin/contract-templates/${templateId}/markers/${oid}`);
      await loadSummary();
      if (selectedOid === oid) setSelectedOid(null);
      setDeleteConfirmOid(null);
    } catch (e) { setErr(formatError(e)); }
    finally { setBusy(false); }
  };

  const toggleAck = async (fontFamily, acknowledged) => {
    setBusy(true); setErr("");
    try {
      await api.post(
        `/admin/contract-templates/${templateId}/substitution-acknowledgements`,
        { font_family: fontFamily, acknowledged },
      );
      await loadSummary();
    } catch (e) { setErr(formatError(e)); }
    finally { setBusy(false); }
  };

  const bulkAckSameOverlay = async (overlayFamily) => {
    const targets = (summary?.substitution_groups || []).filter(
      (g) => g.substitution_family === overlayFamily && g.substitution_required && !g.acknowledged,
    );
    setBusy(true); setErr("");
    try {
      for (const t of targets) {
        // eslint-disable-next-line no-await-in-loop
        await api.post(
          `/admin/contract-templates/${templateId}/substitution-acknowledgements`,
          { font_family: t.font_family, acknowledged: true },
        );
      }
      await loadSummary();
      setShowBulkAckConfirm(null);
    } catch (e) { setErr(formatError(e)); }
    finally { setBusy(false); }
  };

  const downloadWholeDoc = async () => {
    setBusy(true); setErr("");
    try {
      const resp = await api.post(
        `/admin/contract-templates/${templateId}/sample-preview.pdf`,
        {}, { responseType: "blob" },
      );
      const disp = resp.headers?.["content-disposition"] || "";
      const match = /filename="([^"]+)"/i.exec(disp);
      const filename = match ? match[1] : `PREVIEW_${templateId}.pdf`;
      const blobUrl = URL.createObjectURL(new Blob([resp.data], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = blobUrl; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
    } catch (e) { setErr(formatError(e)); }
    finally { setBusy(false); }
  };

  // Turn D — Stop Point 3 evidence pack
  const downloadEvidencePack = async () => {
    setBusy(true); setErr("");
    try {
      const resp = await api.post(
        `/admin/contract-templates/${templateId}/evidence-pack`,
        {}, { responseType: "blob", timeout: 60000 },
      );
      const disp = resp.headers?.["content-disposition"] || "";
      const match = /filename="([^"]+)"/i.exec(disp);
      const filename = match ? match[1] : `EVIDENCE_PACK_${templateId}.zip`;
      const blobUrl = URL.createObjectURL(new Blob([resp.data], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = blobUrl; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
    } catch (e) { setErr(formatError(e)); }
    finally { setBusy(false); }
  };

  // Turn C.5 — request duplicate preview from backend, then let the
  // confirmation dialog show target list before committing.
  const requestDuplicatePreview = async (oid, scope) => {
    setBusy(true); setErr("");
    try {
      const { data } = await api.get(
        `/admin/contract-templates/${templateId}/markers/${oid}/duplicate-preview?scope=${scope}`,
      );
      setDuplicatePreview({ ...data, oid, scope });
    } catch (e) { setErr(formatError(e)); }
    finally { setBusy(false); }
  };

  const applyDuplicate = async () => {
    if (!duplicatePreview) return;
    setBusy(true); setErr("");
    try {
      await api.post(
        `/admin/contract-templates/${templateId}/markers/${duplicatePreview.oid}/duplicate-settings`,
        { scope: duplicatePreview.scope },
      );
      await loadSummary();
      setDuplicatePreview(null);
    } catch (e) { setErr(formatError(e)); }
    finally { setBusy(false); }
  };

  // Phase 1B refinement — bulk Match Source
  const requestMatchSourcePreview = async () => {
    setBusy(true); setErr("");
    try {
      const { data } = await api.get(
        `/admin/contract-templates/${templateId}/match-source-preview`,
      );
      setMatchSourcePreview(data);
    } catch (e) { setErr(formatError(e)); }
    finally { setBusy(false); }
  };

  const applyMatchSource = async () => {
    setBusy(true); setErr("");
    try {
      await api.post(
        `/admin/contract-templates/${templateId}/match-source-apply`,
      );
      // Regenerate whole-doc preview to refresh last_render_report so
      // overflow badges reflect the new state instantly.
      try {
        await api.post(
          `/admin/contract-templates/${templateId}/sample-preview.pdf`,
          {}, { responseType: "blob" },
        );
      } catch { /* preview regen is best-effort */ }
      await loadSummary();
      setMatchSourcePreview(null);
    } catch (e) { setErr(formatError(e)); }
    finally { setBusy(false); }
  };

  const handleCanvasClick = (e) => {
    if (!addMode || !overlayRef.current) return;
    const rect = overlayRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const w = 140, h = 20;
    addOccurrence(toPt({ x: x - w / 2, y: y - h / 2, w, h }));
  };

  if (loading) {
    return (
      <ModalShell onClose={onClose}>
        <div className="flex items-center justify-center h-full text-stone-500 gap-2 p-6">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading Marker Review…
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell onClose={onClose}>
      <div className="flex flex-col h-full">
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-3 p-3 border-b border-stone-200 bg-stone-50 flex-wrap">
          <div className="flex items-center gap-2">
            <button onClick={onClose} data-testid="mr-close"
                    className="p-1.5 rounded border border-stone-300 hover:bg-white">
              <X className="w-4 h-4" />
            </button>
            <h2 className="font-display text-lg text-stone-900">Marker Review</h2>
            <span className="text-xs text-stone-500">
              {markers.length} occurrences · {summary?.pdf_page_count} pages
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1 border border-stone-300 rounded-md bg-white px-1">
              <button onClick={() => setPageNum((p) => Math.max(1, p - 1))}
                      disabled={pageNum <= 1} data-testid="mr-prev-page"
                      className="p-1 hover:bg-stone-100 rounded disabled:opacity-30">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs font-medium min-w-[4rem] text-center" data-testid="mr-page-indicator">
                Page {pageNum} / {summary?.pdf_page_count}
              </span>
              <button onClick={() => setPageNum((p) => Math.min(summary?.pdf_page_count || 1, p + 1))}
                      disabled={pageNum >= (summary?.pdf_page_count || 1)} data-testid="mr-next-page"
                      className="p-1 hover:bg-stone-100 rounded disabled:opacity-30">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center gap-1 border border-stone-300 rounded-md bg-white px-1">
              <button onClick={() => setScale((s) => Math.max(0.5, +(s - 0.2).toFixed(2)))} data-testid="mr-zoom-out"
                      className="p-1 hover:bg-stone-100 rounded"><ZoomOut className="w-4 h-4" /></button>
              <span className="text-xs w-12 text-center" data-testid="mr-zoom-indicator">{Math.round(scale * 100)}%</span>
              <button onClick={() => setScale((s) => Math.min(3, +(s + 0.2).toFixed(2)))} data-testid="mr-zoom-in"
                      className="p-1 hover:bg-stone-100 rounded"><ZoomIn className="w-4 h-4" /></button>
            </div>
            <button onClick={() => setInlinePreviewOn((v) => !v)} disabled={busy}
                    data-testid="mr-inline-preview-toggle"
                    title="Toggle inline live-render preview inside each marker box. Handy when the sample values obscure surrounding contract wording."
                    className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold uppercase tracking-widest rounded-md border ${
                      inlinePreviewOn
                        ? "bg-stone-100 border-stone-400 text-stone-900"
                        : "bg-white border-stone-300 text-stone-500 hover:bg-stone-50"
                    }`}>
              <Eye className="w-3.5 h-3.5" /> Live
            </button>
            <button onClick={() => setAddMode((v) => !v)} disabled={busy}
                    data-testid="mr-add-toggle"
                    className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold uppercase tracking-widest rounded-md border ${
                      addMode
                        ? "bg-amber-600 text-white border-amber-600"
                        : "bg-white border-stone-300 hover:bg-stone-50"
                    }`}>
              <Plus className="w-3.5 h-3.5" /> {addMode ? "Cancel" : "Add"}
            </button>
            {addMode && (
              <select value={addCode} onChange={(e) => setAddCode(e.target.value)}
                      data-testid="mr-add-code-select"
                      className="text-xs border border-stone-300 rounded-md px-2 py-1.5 bg-white">
                {libraryCodes.map((c) => (
                  <option key={c} value={c}>[[{c}]]</option>
                ))}
              </select>
            )}
            <button onClick={downloadWholeDoc} disabled={busy}
                    data-testid="mr-download-preview"
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold uppercase tracking-widest rounded-md bg-white border border-amber-300 text-amber-900 hover:bg-amber-50 disabled:opacity-50">
              <Download className="w-3.5 h-3.5" /> {busy ? "…" : "Preview PDF"}
            </button>
            <button onClick={requestMatchSourcePreview} disabled={busy}
                    data-testid="mr-bulk-match-source"
                    title="Set font_size_override AND min_font_size to the detected source font size on every occurrence that doesn't already have an HQ override."
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold uppercase tracking-widest rounded-md bg-white border border-stone-300 hover:bg-stone-50 disabled:opacity-50">
              <Zap className="w-3.5 h-3.5" /> Match all
            </button>
            <button onClick={() => setShowAuditLog(true)} disabled={busy}
                    data-testid="mr-open-audit-log"
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold uppercase tracking-widest rounded-md bg-white border border-stone-300 hover:bg-stone-50 disabled:opacity-50">
              <Clock className="w-3.5 h-3.5" /> Audit
            </button>
            <button onClick={downloadEvidencePack} disabled={busy}
                    data-testid="mr-evidence-pack"
                    title="Generate the Stop Point 3 evidence pack ZIP — manifest + source PDF + preview + markers.csv + audit log."
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold uppercase tracking-widest rounded-md bg-stone-950 text-white hover:bg-stone-800 disabled:opacity-50">
              <FileArchive className="w-3.5 h-3.5" /> Evidence Pack
            </button>
          </div>
        </div>

        {err && (
          <div className="p-2 bg-red-50 border-b border-red-200 text-xs text-red-800 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" /> {err}
          </div>
        )}
        {addMode && (
          <div className="p-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-900" data-testid="mr-add-instructions">
            <strong>Add mode:</strong> click anywhere on the page to place a new
            <code className="mx-1 px-1 bg-white border border-stone-200 rounded">[[{addCode}]]</code>
            occurrence. You can drag/resize it afterwards.
          </div>
        )}

        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-auto bg-stone-100 p-6" data-testid="mr-canvas-wrap">
            <div className="mx-auto shadow-xl bg-white inline-block relative"
                 style={{ width: pageSize.width, height: pageSize.height }}>
              <canvas ref={canvasRef} data-testid="mr-pdf-canvas" className="block" />
              <div ref={overlayRef}
                   data-testid="mr-overlay-layer"
                   onClick={handleCanvasClick}
                   className={`absolute inset-0 ${addMode ? "cursor-crosshair" : ""}`}
                   style={{ zIndex: 5 }}>
                {pageMarkers.map((m) => (
                  <MarkerBox
                    key={m.occurrence_id}
                    marker={m}
                    px={toPx(m.render_bbox || m.bbox)}
                    tokenPx={toPx(m.token_bbox || m.bbox)}
                    selected={selectedOid === m.occurrence_id}
                    inlinePreviewOn={inlinePreviewOn}
                    scale={scale}
                    onSelect={() => setSelectedOid(m.occurrence_id)}
                    onChange={(rect) => persistOccurrence(m.occurrence_id, { render_bbox: toPt(rect) })}
                    disabled={busy}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="w-96 border-l border-stone-200 bg-white overflow-y-auto flex flex-col" data-testid="mr-sidebar">
            {selectedMarker ? (
              <MarkerPropertyPanel
                marker={selectedMarker}
                templateId={templateId}
                onChange={(patch) => persistOccurrence(selectedMarker.occurrence_id, patch)}
                onDelete={() => setDeleteConfirmOid(selectedMarker.occurrence_id)}
                onDuplicate={(scope) => requestDuplicatePreview(selectedMarker.occurrence_id, scope)}
                busy={busy}
              />
            ) : (
              <div className="p-4 text-xs text-stone-500 border-b border-stone-200">
                Select an occurrence on the page canvas to edit its properties, or use <strong>Add</strong> to place a new one.
              </div>
            )}
            <SubstitutionAckPanel
              groups={summary?.substitution_groups || []}
              allAcked={summary?.all_substitutions_acknowledged}
              onToggle={toggleAck}
              onBulkForOverlay={(overlay) => setShowBulkAckConfirm(overlay)}
              busy={busy}
            />
            <OccurrenceList
              markers={markers}
              selectedOid={selectedOid}
              onSelect={(m) => { setSelectedOid(m.occurrence_id); setPageNum(m.page); }}
            />
          </div>
        </div>

        {showBulkAckConfirm && (
          <BulkAckConfirm
            overlayFamily={showBulkAckConfirm}
            groups={summary?.substitution_groups || []}
            onConfirm={() => bulkAckSameOverlay(showBulkAckConfirm)}
            onCancel={() => setShowBulkAckConfirm(null)}
            busy={busy}
          />
        )}
        {deleteConfirmOid && (
          <DeleteConfirm
            marker={markers.find((m) => m.occurrence_id === deleteConfirmOid)}
            onConfirm={() => deleteOccurrence(deleteConfirmOid)}
            onCancel={() => setDeleteConfirmOid(null)}
            busy={busy}
          />
        )}
        {duplicatePreview && (
          <DuplicateConfirm
            preview={duplicatePreview}
            onConfirm={applyDuplicate}
            onCancel={() => setDuplicatePreview(null)}
            busy={busy}
          />
        )}
        {showAuditLog && (
          <AuditLogDrawer
            templateId={templateId}
            onClose={() => setShowAuditLog(false)}
          />
        )}
        {matchSourcePreview && (
          <MatchSourceConfirm
            preview={matchSourcePreview}
            onConfirm={applyMatchSource}
            onCancel={() => setMatchSourcePreview(null)}
            busy={busy}
          />
        )}
      </div>
    </ModalShell>
  );
}


function ModalShell({ onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 bg-stone-950/60 backdrop-blur-sm flex items-stretch justify-stretch p-4"
         data-testid="marker-review-modal"
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex-1 bg-white rounded-lg shadow-2xl overflow-hidden">
        {children}
      </div>
    </div>
  );
}

// Approximate PDF font-family → CSS font-stack mapping. Helvetica base14
// families are Arial-metric-compatible; Times and Courier are as-is.
const OVERLAY_CSS_FONT = {
  helv: "Arial, Helvetica, sans-serif", hebo: "Arial, Helvetica, sans-serif",
  heit: "Arial, Helvetica, sans-serif", hebi: "Arial, Helvetica, sans-serif",
  tiro: "'Times New Roman', Times, serif", tibo: "'Times New Roman', Times, serif",
  tiit: "'Times New Roman', Times, serif", tibi: "'Times New Roman', Times, serif",
  cour: "'Courier New', Courier, monospace", cobo: "'Courier New', Courier, monospace",
  coit: "'Courier New', Courier, monospace", cobi: "'Courier New', Courier, monospace",
};
const CSS_ALIGN = { left: "left", center: "center", right: "right", justify: "justify" };
const CSS_TRANSFORM = { upper: "uppercase", lower: "lowercase", title: "capitalize" };

function applyCasingClientSide(value, casing) {
  if (!value) return value;
  if (casing === "upper") return value.toUpperCase();
  if (casing === "lower") return value.toLowerCase();
  if (casing === "title") return value.replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
  if (casing === "sentence") return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  return value;
}

function MarkerBox({ marker, px, tokenPx, selected, inlinePreviewOn, scale, onSelect, onChange, disabled }) {
  // Local drag/resize state — kept purely visual during motion so the
  // server call only fires on ``onDragStop`` / ``onResizeStop``. This
  // gives smooth interaction and the debounce the spec asks for; the
  // property panel's per-marker PNG then refreshes with the accurate
  // server-rendered image once the drag ends.
  const [live, setLive] = useState(null);
  const currentPx = live || px;
  if (!currentPx) return null;

  const overflowed = marker.last_render_report?.overflow === true;
  const value = applyCasingClientSide(marker.sample_value || `[[${marker.code}]]`, marker.casing);
  const overlayFamily = marker.overlay_font_family_override || marker.last_render_report?.overlay_family || "helv";
  const fontSizePt = marker.font_size_override || marker.font_size || 11;
  const fontSizePx = fontSizePt * (scale || 1);
  const cssAlign = CSS_ALIGN[marker.alignment || "left"] || "left";
  const cssTransform = CSS_TRANSFORM[marker.casing] || "none";
  // If casing is applied client-side, we don't also want CSS transform;
  // but we keep the transform as a defensive fallback in case value
  // arrives untransformed.
  const wrapMode = marker.wrapping || "wrap";
  const whiteSpace = wrapMode === "no_wrap" ? "nowrap" : "normal";
  const overflowMode = wrapMode === "clip" ? "hidden" : "visible";

  return (
    <>
      {/* Read-only token_bbox indicator (redaction zone) */}
      {tokenPx && selected && (
        <div
          data-testid={`mr-token-bbox-${marker.occurrence_id}`}
          className="absolute pointer-events-none border-2 border-dashed border-red-500 bg-red-500/10"
          style={{
            left: tokenPx.x, top: tokenPx.y, width: tokenPx.w, height: tokenPx.h,
            zIndex: 6,
          }}
          title="token_bbox (redaction zone) — read-only"
        />
      )}
      <Rnd
        position={{ x: currentPx.x, y: currentPx.y }}
        size={{ width: currentPx.w, height: currentPx.h }}
        disableDragging={disabled}
        enableResizing={!disabled}
        bounds="parent"
        onDrag={(_e, d) => setLive({ x: d.x, y: d.y, w: currentPx.w, h: currentPx.h })}
        onResize={(_e, _dir, ref, _delta, pos) => setLive({
          x: pos.x, y: pos.y,
          w: parseFloat(ref.style.width),
          h: parseFloat(ref.style.height),
        })}
        onDragStop={(_e, d) => {
          setLive(null);
          onChange({ x: d.x, y: d.y, w: currentPx.w, h: currentPx.h });
        }}
        onResizeStop={(_e, _dir, ref, _delta, pos) => {
          setLive(null);
          onChange({
            x: pos.x, y: pos.y,
            w: parseFloat(ref.style.width),
            h: parseFloat(ref.style.height),
          });
        }}
        onClick={(e) => { e.stopPropagation(); onSelect(); }}
        data-testid={`mr-marker-box-${marker.occurrence_id}`}
        style={{ zIndex: selected ? 8 : 7 }}
        className={`border-2 ${
          overflowed
            ? "border-red-500 bg-red-400/10 animate-pulse"
            : selected
              ? "border-amber-500 bg-amber-400/15"
              : "border-amber-400/70 bg-amber-300/10 hover:bg-amber-300/20"
        }`}
      >
        <div className="absolute -top-4 left-0 text-[10px] font-mono text-amber-900 bg-white/90 border border-amber-200 rounded px-1 whitespace-nowrap pointer-events-none">
          [[{marker.code}]]{marker.manually_added && <span title="manually added"> +</span>}
          {overflowed && (
            <span className="ml-1 text-red-700 font-bold" title="Overflow — value doesn't fit at min_font_size">⚠</span>
          )}
        </div>
        {/* Inline live-render preview — pure CSS, no server call while
            dragging. The accurate PyMuPDF-rendered PNG in the property
            panel takes over after onDragStop / onResizeStop. */}
        {inlinePreviewOn && (
          <div
            data-testid={`mr-inline-preview-${marker.occurrence_id}`}
            className="absolute inset-0 pointer-events-none flex px-[2px]"
            style={{
              fontFamily: OVERLAY_CSS_FONT[overlayFamily] || OVERLAY_CSS_FONT.helv,
              fontSize: `${fontSizePx}px`,
              lineHeight: 1.1,
              textAlign: cssAlign,
              textTransform: cssTransform,
              whiteSpace: whiteSpace,
              overflow: overflowMode,
              color: "#111",
              fontStyle: overlayFamily.endsWith("it") || overlayFamily.endsWith("bi") ? "italic" : "normal",
              fontWeight: overlayFamily.endsWith("bo") || overlayFamily.endsWith("bi") ? "bold" : "normal",
              alignItems: "center",
              justifyContent: cssAlign === "center" ? "center" : cssAlign === "right" ? "flex-end" : "flex-start",
            }}
          >
            <span className="w-full block" style={{ textAlign: cssAlign }}>
              {value}
            </span>
          </div>
        )}
      </Rnd>
    </>
  );
}

function MarkerPropertyPanel({ marker, templateId, onChange, onDelete, onDuplicate, busy }) {
  const [previewSrc, setPreviewSrc] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [alignment, setAlignment] = useState(marker.alignment || "left");
  const [override, setOverride] = useState(marker.font_size_override ?? "");
  const [minSize, setMinSize] = useState(marker.min_font_size ?? "");
  const lastReport = marker.last_render_report;
  const overflowed = lastReport?.overflow === true;

  const matchSource = () => {
    const src = marker.font_size;
    if (!src) return;
    setOverride(src);
    setMinSize(src);
    onChange({ font_size_override: src, min_font_size: src });
  };

  useEffect(() => {
    setAlignment(marker.alignment || "left");
    setOverride(marker.font_size_override ?? "");
    setMinSize(marker.min_font_size ?? "");
  }, [marker.occurrence_id, marker.alignment, marker.font_size_override, marker.min_font_size]);

  const refreshPreview = useCallback(async () => {
    setPreviewLoading(true);
    try {
      const url = await fetchAuthedImage(
        `/admin/contract-templates/${templateId}/markers/${marker.occurrence_id}/sample-preview.png?dpi=180&pad=24&_t=${Date.now()}`,
      );
      setPreviewSrc((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
    } catch (e) {
      // preview is a nice-to-have; ignore
    } finally {
      setPreviewLoading(false);
    }
  }, [templateId, marker.occurrence_id]);

  useEffect(() => { refreshPreview(); }, [refreshPreview, marker.render_bbox, marker.alignment, marker.font_size_override]);

  return (
    <div className="p-4 border-b border-stone-200 space-y-3" data-testid="mr-property-panel">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-stone-500">Occurrence</div>
          <code className="text-sm font-mono text-stone-900">[[{marker.code}]]</code>
          <div className="text-[10px] text-stone-500 mt-0.5">
            Page {marker.page} · {marker.font_family || "(no font)"}
            {marker.manually_added && <span className="ml-1 text-amber-700">· manually added</span>}
          </div>
        </div>
        <button onClick={onDelete} disabled={busy}
                data-testid="mr-delete-btn"
                className="p-1.5 rounded border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="border border-stone-200 rounded bg-stone-50 min-h-[80px] flex items-center justify-center overflow-hidden">
        {previewLoading ? (
          <Loader2 className="w-4 h-4 animate-spin text-stone-400" />
        ) : previewSrc ? (
          <img src={previewSrc} alt="preview" data-testid="mr-marker-preview-img" className="max-w-full max-h-40" />
        ) : (
          <div className="text-[10px] text-stone-400 flex items-center gap-1"><ImageIcon className="w-3 h-3" /> preview…</div>
        )}
      </div>
      <button onClick={refreshPreview} disabled={previewLoading}
              data-testid="mr-preview-refresh"
              className="w-full inline-flex items-center justify-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-widest rounded border border-stone-300 hover:bg-stone-50 disabled:opacity-50">
        <RefreshCw className={`w-3 h-3 ${previewLoading ? "animate-spin" : ""}`} /> Refresh preview
      </button>

      {/* Overflow warning banner */}
      {overflowed && (
        <div className="border border-red-300 bg-red-50 rounded p-2 text-[11px] text-red-900 space-y-1"
             data-testid="mr-overflow-warning">
          <div className="flex items-center gap-1 font-bold">
            <AlertTriangle className="w-3.5 h-3.5" />
            Overflow at {lastReport.final_size}pt
          </div>
          <div className="text-[10px] text-red-800">
            The value does not fit inside <code>render_bbox</code> at the minimum
            font size ({marker.min_font_size ?? 7}pt). Enlarge the box (drag
            the yellow handles), reposition it, enable wrapping, or lower
            the minimum size — but do NOT let it silently shrink below the
            contract&apos;s specified size.
          </div>
        </div>
      )}
      {lastReport && !overflowed && (
        <div className="text-[10px] text-emerald-700 flex items-center gap-1" data-testid="mr-fit-ok">
          <Check className="w-3 h-3" /> Fits at {lastReport.final_size}pt · overlay {lastReport.overlay_family}
        </div>
      )}

      {/* Match source quick action */}
      {marker.font_size && (
        <button onClick={matchSource} disabled={busy}
                data-testid="mr-match-source"
                title={`Set size override and min size to ${marker.font_size}pt — engine will refuse to shrink below the contract's specified size.`}
                className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded border border-stone-950 bg-stone-950 text-white hover:bg-stone-800 disabled:opacity-50">
          <Zap className="w-3 h-3" /> Match source ({marker.font_size}pt)
        </button>
      )}

      <div>
        <div className="text-[10px] font-bold uppercase tracking-widest text-stone-500 mb-1">Alignment</div>
        <div className="grid grid-cols-4 gap-1" data-testid="mr-alignment-group">
          {ALIGN_VALUES.map((v) => (
            <button key={v}
                    onClick={() => { setAlignment(v); onChange({ alignment: v }); }}
                    disabled={busy}
                    data-testid={`mr-alignment-${v}`}
                    className={`px-1 py-1 text-[10px] font-bold uppercase tracking-widest rounded border ${
                      alignment === v
                        ? "bg-stone-950 text-white border-stone-950"
                        : "bg-white border-stone-300 hover:bg-stone-50"
                    }`}>{v}</button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Size override" value={override} testid="mr-font-override"
          onCommit={(v) => { setOverride(v); onChange({ font_size_override: v === "" ? null : Number(v) }); }}
          min={4} max={96} step={0.5}
          placeholder={String(marker.font_size ?? "")}
        />
        <NumberField
          label="Min size" value={minSize} testid="mr-min-size"
          onCommit={(v) => { setMinSize(v); onChange({ min_font_size: v === "" ? null : Number(v) }); }}
          min={4} max={96} step={0.5}
          placeholder="7"
        />
      </div>

      {/* Turn C.5 presentation controls */}
      <div className="grid grid-cols-2 gap-2 pt-2 border-t border-stone-200">
        <SelectField
          label="Wrapping" testid="mr-wrapping"
          value={marker.wrapping ?? ""}
          onChange={(v) => onChange({ wrapping: v || null })}
          options={[["", "default (wrap)"], ["wrap", "wrap"], ["no_wrap", "no wrap"], ["clip", "clip w/ ellipsis"]]}
        />
        <NumberField
          label="Max lines" testid="mr-max-lines"
          value={marker.max_lines ?? ""}
          onCommit={(v) => onChange({ max_lines: v === "" ? null : Number(v) })}
          min={0} max={200} step={1} placeholder="0"
        />
        <SelectField
          label="Casing" testid="mr-casing"
          value={marker.casing ?? ""}
          onChange={(v) => onChange({ casing: v || null })}
          options={[["", "default"], ["none", "none"], ["upper", "UPPER"], ["lower", "lower"], ["title", "Title"], ["sentence", "Sentence"]]}
        />
        <SelectField
          label="Overlay font" testid="mr-overlay-font"
          value={marker.overlay_font_family_override ?? ""}
          onChange={(v) => onChange({ overlay_font_family_override: v || null })}
          options={[
            ["", "auto"],
            ["helv", "Helvetica"], ["hebo", "Helvetica Bold"],
            ["heit", "Helvetica Italic"], ["hebi", "Helvetica Bold-Italic"],
            ["tiro", "Times"], ["tibo", "Times Bold"],
            ["tiit", "Times Italic"], ["tibi", "Times Bold-Italic"],
            ["cour", "Courier"], ["cobo", "Courier Bold"],
            ["coit", "Courier Italic"], ["cobi", "Courier Bold-Italic"],
          ]}
        />
      </div>

      {/* Turn C.5 duplicate-settings shortcuts */}
      <div className="pt-2 border-t border-stone-200">
        <div className="text-[10px] font-bold uppercase tracking-widest text-stone-500 mb-1">
          Duplicate presentation to same code
        </div>
        <div className="grid grid-cols-2 gap-1">
          <button
            onClick={() => onDuplicate("next")} disabled={busy}
            data-testid="mr-duplicate-next"
            className="inline-flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50">
            <Copy className="w-3 h-3" /> to next
          </button>
          <button
            onClick={() => onDuplicate("all_later")} disabled={busy}
            data-testid="mr-duplicate-all-later"
            className="inline-flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50">
            <Copy className="w-3 h-3" /> to all later
          </button>
        </div>
        <div className="text-[10px] text-stone-500 mt-1">
          Copies alignment, size override, min size, wrapping, max lines,
          casing, overlay font. <strong>Never</strong> alters bboxes,
          page, code, or data binding.
        </div>
      </div>

      <div className="text-[10px] text-stone-500 space-y-0.5 pt-2 border-t border-stone-200">
        <div>token_bbox <em>(read-only)</em>: {(marker.token_bbox || marker.bbox || []).map((n) => n?.toFixed(1)).join(", ")}</div>
        <div>render_bbox: {(marker.render_bbox || marker.bbox || []).map((n) => n?.toFixed(1)).join(", ")}</div>
      </div>
    </div>
  );
}

function SelectField({ label, value, onChange, options, testid }) {
  return (
    <label className="block">
      <div className="text-[10px] font-bold uppercase tracking-widest text-stone-500 mb-1">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testid}
        className="w-full text-xs border border-stone-300 rounded px-2 py-1 bg-white"
      >
        {options.map(([v, label]) => (
          <option key={v} value={v}>{label}</option>
        ))}
      </select>
    </label>
  );
}

function NumberField({ label, value, onCommit, testid, ...rest }) {
  const [local, setLocal] = useState(value);
  useEffect(() => { setLocal(value); }, [value]);
  return (
    <label className="block">
      <div className="text-[10px] font-bold uppercase tracking-widest text-stone-500 mb-1">{label}</div>
      <input
        type="number"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => onCommit(local)}
        data-testid={testid}
        className="w-full text-xs border border-stone-300 rounded px-2 py-1"
        {...rest}
      />
    </label>
  );
}

function SubstitutionAckPanel({ groups, allAcked, onToggle, onBulkForOverlay, busy }) {
  const overlayBuckets = useMemo(() => {
    const b = {};
    for (const g of groups) {
      if (!g.substitution_required) continue;
      const key = g.substitution_family || "(unknown)";
      if (!b[key]) b[key] = { overlay: key, groups: [], pendingCount: 0 };
      b[key].groups.push(g);
      if (!g.acknowledged) b[key].pendingCount += g.occurrence_count;
    }
    return Object.values(b);
  }, [groups]);

  return (
    <div className="p-4 border-b border-stone-200" data-testid="mr-subst-panel">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] font-bold uppercase tracking-widest text-stone-500">
          Substitution acknowledgements
        </div>
        {allAcked && (
          <span className="inline-flex items-center gap-1 text-emerald-700 text-[10px] font-bold uppercase tracking-widest">
            <Check className="w-3 h-3" /> all cleared
          </span>
        )}
      </div>

      {groups.length === 0 && (
        <div className="text-[11px] text-stone-500">No font substitutions detected.</div>
      )}

      {groups.map((g) => (
        <div key={g.font_family} className="border border-stone-200 rounded mb-1.5 p-2" data-testid={`mr-subst-group-${g.font_family}`}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-mono text-stone-900 truncate">{g.font_family}</div>
              <div className="text-[10px] text-stone-500">
                → {g.substitution_family || "(unresolved)"} · {g.occurrence_count} occurrence{g.occurrence_count !== 1 ? "s" : ""}
                {!g.substitution_required && <> · <span className="text-emerald-700">not required</span></>}
              </div>
            </div>
            {g.substitution_required && (
              <label className="inline-flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={g.acknowledged}
                  onChange={(e) => onToggle(g.font_family, e.target.checked)}
                  disabled={busy}
                  data-testid={`mr-ack-toggle-${g.font_family}`}
                  className="w-3.5 h-3.5"
                />
                <span className="text-[10px] font-bold uppercase tracking-widest text-stone-700">Ack</span>
              </label>
            )}
          </div>
          {g.acknowledged && g.acknowledged_by && (
            <div className="text-[10px] text-emerald-700 mt-1">
              ✓ {g.acknowledged_by} · {new Date(g.acknowledged_at).toLocaleString()}
            </div>
          )}
        </div>
      ))}

      {overlayBuckets.filter((b) => b.pendingCount > 0).map((b) => (
        <button
          key={b.overlay}
          onClick={() => onBulkForOverlay(b.overlay)}
          disabled={busy}
          data-testid={`mr-bulk-ack-${b.overlay}`}
          className="w-full mt-1.5 inline-flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded border border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 disabled:opacity-50"
        >
          Acknowledge all → {b.overlay} ({b.pendingCount} occurrence{b.pendingCount !== 1 ? "s" : ""})
        </button>
      ))}
    </div>
  );
}

function OccurrenceList({ markers, selectedOid, onSelect }) {
  return (
    <div className="p-4 flex-1 overflow-y-auto">
      <div className="text-[10px] font-bold uppercase tracking-widest text-stone-500 mb-2">
        All occurrences ({markers.length})
      </div>
      <ul className="space-y-1" data-testid="mr-occurrence-list">
        {markers.map((m) => {
          const overflow = m.last_render_report?.overflow === true;
          return (
            <li key={m.occurrence_id}>
              <button
                onClick={() => onSelect(m)}
                data-testid={`mr-occurrence-item-${m.occurrence_id}`}
                className={`w-full text-left px-2 py-1 rounded text-[11px] flex items-center justify-between gap-2 ${
                  selectedOid === m.occurrence_id
                    ? "bg-amber-100 border border-amber-300"
                    : "hover:bg-stone-50 border border-transparent"
                }`}
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  {overflow && (
                    <span
                      data-testid={`mr-overflow-dot-${m.occurrence_id}`}
                      className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0"
                      title={`Overflow at ${m.last_render_report?.final_size}pt`}
                    />
                  )}
                  <code className="font-mono truncate">[[{m.code}]]</code>
                </span>
                <span className="text-[10px] text-stone-500 whitespace-nowrap">
                  p{m.page}{m.manually_added && " +"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function BulkAckConfirm({ overlayFamily, groups, onConfirm, onCancel, busy }) {
  const affected = groups.filter(
    (g) => g.substitution_family === overlayFamily && g.substitution_required && !g.acknowledged,
  );
  const occurrenceCount = affected.reduce((n, g) => n + g.occurrence_count, 0);
  const familyCount = affected.length;
  return (
    <div className="fixed inset-0 z-[60] bg-stone-950/60 flex items-center justify-center p-4"
         onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
         data-testid="mr-bulk-ack-confirm">
      <div className="bg-white rounded-lg shadow-2xl max-w-md w-full p-5 space-y-3">
        <h3 className="font-display text-lg text-stone-900">Acknowledge all substitutions → {overlayFamily}</h3>
        <p className="text-sm text-stone-700">
          This will acknowledge <strong>{familyCount}</strong> source font famil{familyCount === 1 ? "y" : "ies"} affecting
          &nbsp;<strong>{occurrenceCount}</strong> occurrence{occurrenceCount !== 1 ? "s" : ""} on this template.
          Each acknowledgement is recorded separately with your email and timestamp — the audit trail is preserved.
        </p>
        <div className="text-xs text-stone-500 border border-stone-200 rounded p-2 space-y-0.5">
          {affected.map((g) => (
            <div key={g.font_family}>
              <code>{g.font_family}</code> · {g.occurrence_count} occurrence{g.occurrence_count !== 1 ? "s" : ""}
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onCancel} disabled={busy}
                  data-testid="mr-bulk-ack-cancel"
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-widest rounded border border-stone-300 hover:bg-stone-50">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={busy}
                  data-testid="mr-bulk-ack-apply"
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-widest rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50">
            {busy ? "Acknowledging…" : `Acknowledge ${familyCount}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteConfirm({ marker, onConfirm, onCancel, busy }) {
  if (!marker) return null;
  return (
    <div className="fixed inset-0 z-[60] bg-stone-950/60 flex items-center justify-center p-4"
         onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
         data-testid="mr-delete-confirm">
      <div className="bg-white rounded-lg shadow-2xl max-w-md w-full p-5 space-y-3">
        <h3 className="font-display text-lg text-stone-900">Delete this occurrence?</h3>
        <p className="text-sm text-stone-700">
          You&apos;re about to remove <code className="bg-stone-100 px-1 rounded">[[{marker.code}]]</code>
          {" "}on page {marker.page}. The source PDF is not modified — only this template&apos;s
          detected occurrence record. You can add it back later via the <strong>Add</strong> tool.
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onCancel} disabled={busy}
                  data-testid="mr-delete-cancel"
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-widest rounded border border-stone-300 hover:bg-stone-50">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={busy}
                  data-testid="mr-delete-apply"
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-widest rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}


function DuplicateConfirm({ preview, onConfirm, onCancel, busy }) {
  if (!preview) return null;
  const { scope, source, settings_to_copy: copied, targets, affected_count } = preview;
  const scopeLabel = scope === "next" ? "next occurrence" : "all later occurrences";
  return (
    <div className="fixed inset-0 z-[60] bg-stone-950/60 flex items-center justify-center p-4"
         onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
         data-testid="mr-duplicate-confirm">
      <div className="bg-white rounded-lg shadow-2xl max-w-lg w-full p-5 space-y-3">
        <h3 className="font-display text-lg text-stone-900">
          Duplicate presentation settings → {scopeLabel}
        </h3>
        <p className="text-sm text-stone-700">
          Source: <code className="bg-stone-100 px-1 rounded">[[{source.code}]]</code>
          {" "}on page {source.page}. This will apply the presentation settings below
          to <strong>{affected_count}</strong> occurrence{affected_count !== 1 ? "s" : ""}
          {" "}of the same code.
        </p>
        {affected_count === 0 ? (
          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
            No later occurrences of <code>[[{source.code}]]</code> found — nothing to do.
          </div>
        ) : (
          <>
            <div className="text-[11px] border border-stone-200 rounded p-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
              {Object.entries(copied).map(([k, v]) => (
                <div key={k} className="text-stone-600">
                  <span className="font-mono">{k}</span>:{" "}
                  <span className="text-stone-900">{v === null || v === "" ? "—" : String(v)}</span>
                </div>
              ))}
            </div>
            <div className="text-[11px] text-stone-500">
              <strong>Target occurrences</strong> (in reading order):
              <ul className="mt-1 space-y-0.5">
                {targets.map((t) => (
                  <li key={t.occurrence_id} data-testid={`mr-dup-target-${t.occurrence_id}`}>
                    · page {t.page} · <code className="font-mono">{t.occurrence_id.slice(0, 8)}</code>
                  </li>
                ))}
              </ul>
            </div>
            <div className="text-[10px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded p-2">
              <strong>Never altered:</strong> token_bbox, render_bbox, page,
              occurrence_id, code, data binding, substitution acknowledgement.
            </div>
          </>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onCancel} disabled={busy}
                  data-testid="mr-dup-cancel"
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-widest rounded border border-stone-300 hover:bg-stone-50">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={busy || affected_count === 0}
                  data-testid="mr-dup-apply"
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-widest rounded bg-stone-950 text-white hover:bg-stone-800 disabled:opacity-40">
            {busy ? "Applying…" : `Apply to ${affected_count}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function AuditLogDrawer({ templateId, onClose }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get(
          `/admin/contract-templates/${templateId}/audit-log?limit=200`,
        );
        if (!cancelled) setRows(data.items || []);
      } catch (e) {
        if (!cancelled) setErr(formatError(e));
      }
    })();
    return () => { cancelled = true; };
  }, [templateId]);

  return (
    <div className="fixed inset-0 z-[60] bg-stone-950/60 flex items-stretch justify-end"
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
         data-testid="mr-audit-drawer">
      <div className="w-[560px] bg-white shadow-2xl overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-stone-200 bg-stone-50 sticky top-0">
          <div>
            <h3 className="font-display text-lg text-stone-900">Audit log</h3>
            <div className="text-[11px] text-stone-500">
              Every mutating action against this template. Bundled into the Evidence Pack.
            </div>
          </div>
          <button onClick={onClose} data-testid="mr-audit-close"
                  className="p-1.5 rounded border border-stone-300 hover:bg-white">
            <X className="w-4 h-4" />
          </button>
        </div>
        {err && <div className="p-3 bg-red-50 text-red-800 text-xs">{err}</div>}
        {rows === null ? (
          <div className="p-4 flex items-center gap-2 text-xs text-stone-500">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading audit log…
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4 text-xs text-stone-500">
            No audit entries yet. Actions performed in this workspace will appear here.
          </div>
        ) : (
          <ul className="divide-y divide-stone-100">
            {rows.map((r) => (
              <li key={r.id || `${r.at}-${r.action}`} className="p-3">
                <div className="flex items-center justify-between gap-2">
                  <code className="text-[11px] font-mono text-stone-900">{r.action}</code>
                  <span className="text-[10px] text-stone-500">
                    {new Date(r.at).toLocaleString()}
                  </span>
                </div>
                <div className="text-[10px] text-stone-600 mt-0.5">
                  by <strong>{r.actor || "system"}</strong>
                </div>
                {r.extra && Object.keys(r.extra).length > 0 && (
                  <pre className="text-[10px] mt-1 bg-stone-50 border border-stone-100 rounded p-1.5 overflow-x-auto max-h-32">
                    {JSON.stringify(r.extra, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function MatchSourceConfirm({ preview, onConfirm, onCancel, busy }) {
  if (!preview) return null;
  const { eligible_count, skipped_count, will_overflow_count, eligible, will_overflow_after } = preview;
  return (
    <div className="fixed inset-0 z-[60] bg-stone-950/60 flex items-center justify-center p-4"
         onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
         data-testid="mr-match-source-confirm">
      <div className="bg-white rounded-lg shadow-2xl max-w-xl w-full p-5 space-y-3">
        <h3 className="font-display text-lg text-stone-900">
          Bulk Match Source
        </h3>
        <p className="text-sm text-stone-700">
          Set <code>font_size_override</code> AND <code>min_font_size</code> to
          the detected source font size on <strong>{eligible_count}</strong>{" "}
          occurrence{eligible_count !== 1 ? "s" : ""} that don&apos;t already carry
          an HQ font-size override.
          {skipped_count > 0 && (
            <> <strong>{skipped_count}</strong> occurrence{skipped_count !== 1 ? "s" : ""} with
              existing overrides will be left untouched.</>
          )}
        </p>

        {eligible_count === 0 ? (
          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
            Nothing to do — every occurrence already has an HQ override or no
            detected source size.
          </div>
        ) : (
          <>
            <div className="text-[11px] border border-stone-200 rounded p-2 max-h-40 overflow-y-auto"
                 data-testid="mr-match-eligible-list">
              {eligible.map((e) => (
                <div key={e.occurrence_id} className="flex justify-between gap-2">
                  <code className="font-mono truncate">[[{e.code}]]</code>
                  <span className="text-stone-500 whitespace-nowrap">
                    p{e.page} · src {e.source_font_size}pt
                  </span>
                </div>
              ))}
            </div>

            {will_overflow_count > 0 && (
              <div className="text-[11px] border border-red-300 bg-red-50 rounded p-2"
                   data-testid="mr-match-overflow-warning">
                <div className="font-bold text-red-900 flex items-center gap-1 mb-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {will_overflow_count} occurrence{will_overflow_count !== 1 ? "s" : ""} will start overflowing:
                </div>
                <ul className="space-y-0.5 text-red-800">
                  {will_overflow_after.map((o) => (
                    <li key={o.occurrence_id}>
                      · <code>[[{o.code}]]</code> p{o.page} at {o.would_overflow_at}pt
                    </li>
                  ))}
                </ul>
                <div className="text-[10px] text-red-800 mt-1">
                  This is the intended safety signal — after applying, use the
                  overflow badges to enlarge each affected <code>render_bbox</code>.
                </div>
              </div>
            )}

            <div className="text-[10px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded p-2">
              <strong>Never altered:</strong> token_bbox, render_bbox, page,
              occurrence_id, code, alignment, wrapping, casing, font-family
              override, data binding. HQ-set font-size overrides are preserved.
            </div>
          </>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onCancel} disabled={busy}
                  data-testid="mr-match-cancel"
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-widest rounded border border-stone-300 hover:bg-stone-50">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={busy || eligible_count === 0}
                  data-testid="mr-match-apply"
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-widest rounded bg-stone-950 text-white hover:bg-stone-800 disabled:opacity-40">
            {busy ? "Applying…" : `Apply to ${eligible_count}`}
          </button>
        </div>
      </div>
    </div>
  );
}

