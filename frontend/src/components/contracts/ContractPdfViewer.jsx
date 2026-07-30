// Portal contract signing PDF viewer.
//
// Renders a PDF from a signed URL as inline, scrollable pages using
// react-pdf (pdfjs). Provides zoom, full-screen and download controls,
// and fires ``onReachedLastPage`` the first time the final page
// becomes visible in the viewport — used to gate the acceptance form.
//
// Not a general-purpose viewer. Only used by the portal contract
// signing modal. Keep it focused: no thumbnails, no page picker.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { Download, Loader2, Maximize2, Minimize2, ZoomIn, ZoomOut } from "lucide-react";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

// Point pdfjs at its bundled worker. `.min.js` ships in
// pdfjs-dist v3 — matching the version pinned by react-pdf@7 which
// is the last CRA-compatible pair (v4 requires Node ≥ 22).
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.js",
  import.meta.url,
).toString();

const MIN_ZOOM = 0.6;
const MAX_ZOOM = 2.4;
const ZOOM_STEP = 0.2;

export default function ContractPdfViewer({
  fileUrl,
  downloadUrl,
  fileName = "contract.pdf",
  onReachedLastPage,
  minHeight = 560,
}) {
  const [numPages, setNumPages] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [loadError, setLoadError] = useState("");
  const containerRef = useRef(null);
  const lastPageRef = useRef(null);
  const scrollBoxRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const reachedRef = useRef(false);

  // Reset the "reached last page" latch whenever a new PDF URL is
  // handed in — critical because after signing we swap the fileUrl
  // from the personalised PDF to the signed one, but by then the
  // form is already unlocked so no need to re-fire.
  useEffect(() => {
    reachedRef.current = false;
    setNumPages(0);
    setLoadError("");
  }, [fileUrl]);

  const onLoadSuccess = useCallback(({ numPages: n }) => {
    setNumPages(n);
    // Single-page contracts should immediately unlock signing — the
    // IntersectionObserver below will also fire, but this belt-and-
    // braces guarantees the callback fires even if the observer is
    // debounced by an off-screen layout race.
    if (n === 1 && !reachedRef.current) {
      reachedRef.current = true;
      onReachedLastPage?.();
    }
  }, [onReachedLastPage]);

  // Attach an IntersectionObserver to the LAST rendered page. Fires
  // once, when the last page first becomes ≥ 20% visible in the
  // scroll container — that threshold is high enough to reject drive-
  // by scrolls but low enough that landing directly at the end
  // (browser back / anchor jump) still unlocks signing.
  useEffect(() => {
    if (!numPages) return undefined;
    const target = lastPageRef.current;
    const root = scrollBoxRef.current;
    if (!target || !root) return undefined;
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.2 && !reachedRef.current) {
          reachedRef.current = true;
          onReachedLastPage?.();
        }
      }
    }, { root, threshold: [0.2, 0.6, 1.0] });
    io.observe(target);
    return () => io.disconnect();
  }, [numPages, onReachedLastPage]);

  const options = useMemo(() => ({
    // Isolated cache so multiple viewers on the same page don't
    // cross-pollute pdf.js state.
    cMapUrl: "https://unpkg.com/pdfjs-dist@3.11.174/cmaps/",
    cMapPacked: true,
  }), []);

  function enterFullscreen() {
    const el = containerRef.current;
    if (!el) return;
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }
  function exitFullscreen() {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full bg-stone-100"
      data-testid="contract-pdf-viewer"
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-white flex-wrap">
        <div className="text-xs text-stone-500 flex items-center gap-2 tabular-nums">
          {numPages ? (
            <span data-testid="pdf-page-count">{numPages} {numPages === 1 ? "page" : "pages"}</span>
          ) : (
            <span>Loading…</span>
          )}
          <span className="text-stone-300">·</span>
          <span data-testid="pdf-zoom-level">{Math.round(zoom * 100)}%</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, +(z - ZOOM_STEP).toFixed(2)))}
            disabled={zoom <= MIN_ZOOM}
            className="p-1.5 rounded border border-stone-200 bg-white hover:bg-stone-50 disabled:opacity-40"
            data-testid="pdf-zoom-out-btn"
            title="Zoom out"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, +(z + ZOOM_STEP).toFixed(2)))}
            disabled={zoom >= MAX_ZOOM}
            className="p-1.5 rounded border border-stone-200 bg-white hover:bg-stone-50 disabled:opacity-40"
            data-testid="pdf-zoom-in-btn"
            title="Zoom in"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={isFullscreen ? exitFullscreen : enterFullscreen}
            className="p-1.5 rounded border border-stone-200 bg-white hover:bg-stone-50"
            data-testid="pdf-fullscreen-btn"
            title={isFullscreen ? "Exit full screen" : "Full screen"}
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          {downloadUrl && (
            <a
              href={downloadUrl}
              download={fileName}
              target="_blank"
              rel="noreferrer"
              className="p-1.5 rounded border border-stone-200 bg-white hover:bg-stone-50 inline-flex items-center gap-1 text-xs"
              data-testid="pdf-download-btn"
              title="Download PDF"
            >
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline">Download</span>
            </a>
          )}
        </div>
      </div>

      {/* Scroll container — this element is the IntersectionObserver
          root so the "last page visible" event only fires when the
          page is inside THIS box, not the outer viewport. */}
      <div
        ref={scrollBoxRef}
        className="flex-1 min-h-0 overflow-auto p-4 space-y-4"
        style={{ minHeight }}
        data-testid="pdf-scroll-container"
      >
        {loadError ? (
          <div className="text-red-800 bg-red-50 border border-red-200 rounded p-3 text-sm">
            Couldn&apos;t load PDF: {loadError}
          </div>
        ) : (
          <Document
            file={fileUrl}
            options={options}
            loading={
              <div className="flex items-center justify-center py-16 text-stone-500 text-sm gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading contract…
              </div>
            }
            onLoadSuccess={onLoadSuccess}
            onLoadError={(e) => setLoadError(e?.message || "PDF failed to load")}
          >
            {Array.from({ length: numPages }, (_, i) => {
              const pageNumber = i + 1;
              const isLast = pageNumber === numPages;
              return (
                <div
                  key={pageNumber}
                  ref={isLast ? lastPageRef : undefined}
                  className="mx-auto bg-white shadow-sm rounded overflow-hidden w-fit"
                  data-testid={`pdf-page-${pageNumber}`}
                  data-is-last-page={isLast ? "true" : "false"}
                >
                  <Page
                    pageNumber={pageNumber}
                    scale={zoom}
                    renderTextLayer={false}
                    renderAnnotationLayer={false}
                  />
                </div>
              );
            })}
          </Document>
        )}
      </div>
    </div>
  );
}
