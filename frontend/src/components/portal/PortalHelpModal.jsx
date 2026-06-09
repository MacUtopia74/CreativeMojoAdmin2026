// Context-aware portal Help modal — clicking the Help button in the
// sidebar opens a full-screen overlay showing the carousel of marked-up
// screenshots HQ uploaded for the current page.
//
// Multi-slide UX: big ◀ ▶ arrows on either side of the image, thumbnail
// strip at the bottom for direct nav, keyboard arrows + ESC supported.
//
// Path resolution: walks the index returned by /api/portal/help/index
// from the longest match_paths down so that "/portal/territory/basic"
// resolves to "my-territory" not "my-territory-plus".
import { useEffect, useState, useMemo, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { X, Loader2, LifeBuoy, ImageOff, ChevronLeft, ChevronRight } from "lucide-react";
import api from "@/lib/api";

export default function PortalHelpModal({ open, onClose }) {
  const { pathname } = useLocation();
  const [index, setIndex] = useState([]);
  const [page, setPage] = useState(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  // Load the page index once per session — it's tiny and stable enough
  // to cache for the lifetime of the modal mount.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await api.get("/portal/help/index");
        if (alive) setIndex(data.pages || []);
      } catch { /* fail silently — fallback path below still works */ }
    })();
    return () => { alive = false; };
  }, []);

  const resolvedSlug = useMemo(() => {
    if (!index.length) return null;
    // Prefer longest path prefix match so /portal/territory/basic does
    // not get hijacked by /portal/territory.
    const sorted = [...index].sort((a, b) => {
      const maxA = Math.max(...(a.match_paths || []).map((p) => p.length));
      const maxB = Math.max(...(b.match_paths || []).map((p) => p.length));
      return maxB - maxA;
    });
    for (const p of sorted) {
      for (const path of p.match_paths || []) {
        if (pathname === path || pathname.startsWith(path + "/") || pathname.startsWith(path + "?")) {
          return p.slug;
        }
      }
    }
    return "home";
  }, [index, pathname]);

  const fetchPage = useCallback(async (slug) => {
    if (!slug) return;
    setLoading(true); setErr(""); setActiveIdx(0);
    try {
      const { data } = await api.get(`/portal/help/pages/${slug}`);
      setPage(data);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't load help for this page.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (open && resolvedSlug) fetchPage(resolvedSlug); }, [open, resolvedSlug, fetchPage]); // eslint-disable-line react-hooks/set-state-in-effect

  const slides = page?.slides || [];
  const hasSlides = slides.length > 0;
  const slide = hasSlides ? slides[Math.min(activeIdx, slides.length - 1)] : null;

  const goPrev = useCallback(() => {
    if (!hasSlides) return;
    setActiveIdx((i) => (i - 1 + slides.length) % slides.length);
  }, [hasSlides, slides.length]);
  const goNext = useCallback(() => {
    if (!hasSlides) return;
    setActiveIdx((i) => (i + 1) % slides.length);
  }, [hasSlides, slides.length]);

  // ESC closes; arrow keys flip slides.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
      else if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "ArrowRight") goNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, goPrev, goNext]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[120] bg-stone-950/70 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
      onClick={onClose}
      data-testid="portal-help-modal"
    >
      <div
        className="bg-white rounded-2xl shadow-2xl max-w-5xl w-full overflow-hidden my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 flex items-center justify-between border-b border-stone-200 bg-[#dddd16]">
          <div className="flex items-center gap-2 text-stone-950">
            <LifeBuoy className="w-4 h-4" />
            <div>
              <div className="text-[10px] uppercase tracking-[0.3em] font-bold opacity-70">Help guide</div>
              <div className="font-display text-lg font-black leading-tight" data-testid="portal-help-title">
                {page?.title || "Loading…"}
              </div>
            </div>
            {hasSlides && slides.length > 1 && (
              <span className="ml-3 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-[#dddd16] rounded-md" data-testid="portal-help-slide-counter">
                {activeIdx + 1} / {slides.length}
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-2 hover:bg-stone-950/10 rounded-lg" data-testid="portal-help-close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 bg-stone-50 max-h-[80vh] overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-10 text-stone-500">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading help guide…
            </div>
          )}
          {!loading && err && (
            <div className="text-center py-10 text-amber-700">{err}</div>
          )}
          {!loading && !err && page && (
            <>
              {page.caption && (
                <p
                  className="text-sm text-stone-700 leading-relaxed mb-4 max-w-3xl"
                  data-testid="portal-help-caption"
                >
                  {page.caption}
                </p>
              )}

              {hasSlides ? (
                <>
                  {/* Big image + arrows */}
                  <div className="relative bg-white rounded-lg border border-stone-200 shadow-sm overflow-hidden">
                    {slide?.image_url ? (
                      <img
                        key={slide.id}
                        src={slide.image_url}
                        alt={`${page.title} step ${activeIdx + 1}`}
                        className="w-full max-h-[60vh] object-contain bg-white"
                        data-testid="portal-help-image"
                      />
                    ) : (
                      <div className="w-full h-64 flex items-center justify-center text-stone-400">
                        <ImageOff className="w-8 h-8" />
                      </div>
                    )}

                    {slides.length > 1 && (
                      <>
                        <button
                          onClick={goPrev}
                          aria-label="Previous slide"
                          data-testid="portal-help-prev"
                          className="absolute left-3 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center bg-stone-950/80 hover:bg-stone-950 text-white rounded-full shadow-lg transition"
                        >
                          <ChevronLeft className="w-6 h-6" />
                        </button>
                        <button
                          onClick={goNext}
                          aria-label="Next slide"
                          data-testid="portal-help-next"
                          className="absolute right-3 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center bg-stone-950/80 hover:bg-stone-950 text-white rounded-full shadow-lg transition"
                        >
                          <ChevronRight className="w-6 h-6" />
                        </button>
                      </>
                    )}
                  </div>

                  {/* Per-slide caption */}
                  {slide?.caption && (
                    <p
                      className="text-sm text-stone-800 leading-relaxed mt-3 px-2 max-w-3xl"
                      data-testid="portal-help-slide-caption"
                    >
                      <span className="font-bold mr-1">Step {activeIdx + 1}:</span>
                      {slide.caption}
                    </p>
                  )}

                  {/* Thumbnail strip */}
                  {slides.length > 1 && (
                    <div className="mt-4 flex gap-2 overflow-x-auto pb-1" data-testid="portal-help-thumbs">
                      {slides.map((s, i) => (
                        <button
                          key={s.id}
                          onClick={() => setActiveIdx(i)}
                          data-testid={`portal-help-thumb-${i}`}
                          className={`relative shrink-0 w-24 h-16 rounded-md overflow-hidden border-2 transition ${i === activeIdx ? "border-stone-950 ring-2 ring-[#dddd16]" : "border-stone-200 hover:border-stone-400"}`}
                          title={s.caption || `Step ${i + 1}`}
                        >
                          {s.image_url ? (
                            <img src={s.image_url} alt={`thumb ${i + 1}`} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center bg-stone-100 text-stone-400">
                              <ImageOff className="w-3 h-3" />
                            </div>
                          )}
                          <span className="absolute bottom-0.5 left-0.5 px-1 text-[9px] font-bold bg-stone-950/80 text-white rounded">
                            {i + 1}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-center py-10 text-stone-500 border-2 border-dashed border-stone-200 rounded-xl bg-white">
                  <ImageOff className="w-8 h-8 mx-auto mb-2 text-stone-300" />
                  <p className="font-semibold text-stone-700">Help guide coming soon</p>
                  <p className="text-xs mt-1">HQ hasn&apos;t uploaded a marked-up screenshot for this page yet — speak to your franchise manager if you need a hand.</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
