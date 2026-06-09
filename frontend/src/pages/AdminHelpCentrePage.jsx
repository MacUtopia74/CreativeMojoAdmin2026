// Admin Help Centre — upload one OR MORE marked-up screenshots per
// portal page. The portal Help button reads from this same data and
// shows a carousel (thumbnails + big arrows) in a full-screen modal.
//
// Each page card has:
//   • Page-level intro caption (shown above the carousel)
//   • A horizontal strip of slide thumbnails — each with per-slide
//     caption, reorder arrows, and a delete button
//   • An "+ Add slide" upload tile
import { useEffect, useState, useCallback, useRef } from "react";
import {
  Loader2, Upload, Trash2, CheckCircle2, AlertCircle, ImageOff,
  Save, Sparkles, LifeBuoy, ExternalLink, ChevronLeft, ChevronRight,
  Plus, Images,
} from "lucide-react";
import api from "@/lib/api";

export default function AdminHelpCentrePage() {
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  // Page-level caption drafts keyed by slug.
  const [drafts, setDrafts] = useState({});
  // Per-slide caption drafts keyed by `${slug}::${slideId}`.
  const [slideDrafts, setSlideDrafts] = useState({});
  const [savingSlug, setSavingSlug] = useState(null);
  const [savingSlideKey, setSavingSlideKey] = useState(null);
  const [uploadingSlug, setUploadingSlug] = useState(null);
  const [busySlideKey, setBusySlideKey] = useState(null);
  const fileRefs = useRef({});

  const seedDraftsFromPages = (arr) => {
    const pageDrafts = {};
    const sDrafts = {};
    arr.forEach((p) => {
      pageDrafts[p.slug] = p.caption || "";
      (p.slides || []).forEach((s) => { sDrafts[`${p.slug}::${s.id}`] = s.caption || ""; });
    });
    setDrafts(pageDrafts);
    setSlideDrafts(sDrafts);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/admin/help-centre/pages");
      const arr = data.pages || [];
      setPages(arr);
      seedDraftsFromPages(arr);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't load Help Centre.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]); // eslint-disable-line

  const flash = (msg) => { setErr(msg); setTimeout(() => setErr(""), 3500); };

  const saveCaption = async (slug) => {
    setSavingSlug(slug);
    try {
      await api.patch(`/admin/help-centre/pages/${slug}`, { caption: drafts[slug] || "" });
      setPages((arr) => arr.map((p) => p.slug === slug ? { ...p, caption: drafts[slug] || "" } : p));
      flash(`Saved intro for "${slug}".`);
    } catch (e) {
      flash(e?.response?.data?.detail || "Couldn't save caption.");
    } finally { setSavingSlug(null); }
  };

  const uploadSlide = async (slug, file) => {
    if (!file) return;
    setUploadingSlug(slug);
    try {
      const form = new FormData();
      form.append("file", file);
      const { data } = await api.post(`/admin/help-centre/pages/${slug}/slides`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setPages((arr) => arr.map((p) => p.slug === slug
        ? { ...p, slides: [...(p.slides || []), data.slide], slide_count: data.slide_count }
        : p));
      setSlideDrafts((d) => ({ ...d, [`${slug}::${data.slide.id}`]: "" }));
      flash(`Added slide ${data.slide_count} to "${slug}".`);
    } catch (e) {
      flash(e?.response?.data?.detail || "Upload failed.");
    } finally {
      setUploadingSlug(null);
      if (fileRefs.current[slug]) fileRefs.current[slug].value = "";
    }
  };

  const saveSlideCaption = async (slug, slideId) => {
    const key = `${slug}::${slideId}`;
    setSavingSlideKey(key);
    try {
      await api.patch(`/admin/help-centre/pages/${slug}/slides/${slideId}`, {
        caption: slideDrafts[key] || "",
      });
      setPages((arr) => arr.map((p) => p.slug === slug
        ? { ...p, slides: (p.slides || []).map((s) => s.id === slideId ? { ...s, caption: slideDrafts[key] || "" } : s) }
        : p));
      flash("Slide caption saved.");
    } catch (e) {
      flash(e?.response?.data?.detail || "Couldn't save slide caption.");
    } finally { setSavingSlideKey(null); }
  };

  const deleteSlide = async (slug, slideId) => {
    if (!window.confirm("Delete this slide? This can't be undone.")) return;
    const key = `${slug}::${slideId}`;
    setBusySlideKey(key);
    try {
      await api.delete(`/admin/help-centre/pages/${slug}/slides/${slideId}`);
      setPages((arr) => arr.map((p) => p.slug === slug
        ? { ...p, slides: (p.slides || []).filter((s) => s.id !== slideId), slide_count: Math.max(0, (p.slide_count || 0) - 1) }
        : p));
      flash("Slide removed.");
    } catch (e) {
      flash(e?.response?.data?.detail || "Delete failed.");
    } finally { setBusySlideKey(null); }
  };

  const reorderSlide = async (slug, slideId, direction) => {
    const page = pages.find((p) => p.slug === slug);
    if (!page) return;
    const slides = [...(page.slides || [])];
    const idx = slides.findIndex((s) => s.id === slideId);
    if (idx < 0) return;
    const swap = direction === "left" ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= slides.length) return;
    [slides[idx], slides[swap]] = [slides[swap], slides[idx]];
    // Optimistic update
    setPages((arr) => arr.map((p) => p.slug === slug ? { ...p, slides } : p));
    try {
      await api.patch(`/admin/help-centre/pages/${slug}/reorder`, {
        order: slides.map((s) => s.id),
      });
    } catch (e) {
      flash(e?.response?.data?.detail || "Reorder failed.");
      load();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-stone-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8 space-y-5 max-w-6xl" data-testid="admin-help-centre">
      <div>
        <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 flex items-center gap-1.5">
          <LifeBuoy className="w-3 h-3" /> Help Centre
        </div>
        <h1 className="font-display text-4xl text-stone-950 mt-1">Portal help screenshots</h1>
        <p className="text-sm text-stone-600 mt-2 max-w-2xl">
          Add one <strong>or more</strong> marked-up screenshots per portal page.
          When a franchisee clicks the <strong className="mx-1">Help</strong>button in their
          sidebar, the slides appear as a carousel (arrows + thumbnails) in a full-screen modal.
          Add a per-slide caption to walk them through each step.
        </p>
      </div>

      {err && (
        <div className={`px-4 py-3 border rounded-xl text-sm flex items-center gap-2 ${err.toLowerCase().startsWith("saved") || err.toLowerCase().startsWith("added") || err.toLowerCase().startsWith("slide") || err.toLowerCase().startsWith("image") ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-amber-300 bg-amber-50 text-amber-900"}`}>
          {err.toLowerCase().startsWith("saved") || err.toLowerCase().startsWith("added") || err.toLowerCase().startsWith("slide") || err.toLowerCase().startsWith("image") ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {err}
        </div>
      )}

      <div className="space-y-5" data-testid="admin-help-pages-list">
        {pages.map((p) => {
          const slides = p.slides || [];
          return (
            <div key={p.slug} className="bg-white border border-stone-200 rounded-2xl p-5 space-y-4" data-testid={`admin-help-row-${p.slug}`}>
              {/* ------- Header ------- */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <h2 className="font-display text-2xl text-stone-950">{p.title}</h2>
                  <code className="text-[10px] font-mono text-stone-400">{p.match_paths?.[0]}</code>
                  <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-stone-100 text-stone-600 border border-stone-200 rounded-md">
                    <Images className="w-3 h-3" /> {slides.length} slide{slides.length === 1 ? "" : "s"}
                  </span>
                </div>
              </div>

              {/* ------- Page-level intro caption ------- */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Intro caption (above carousel)</label>
                  <div className="flex items-center gap-3">
                    {p.suggested_caption && drafts[p.slug] !== p.suggested_caption && (
                      <button
                        type="button"
                        onClick={() => setDrafts((d) => ({ ...d, [p.slug]: p.suggested_caption }))}
                        data-testid={`admin-help-suggest-${p.slug}`}
                        className="text-[11px] text-stone-700 hover:text-stone-950 inline-flex items-center gap-1"
                        title={p.suggested_caption}
                      >
                        <Sparkles className="w-3 h-3" /> Use suggested
                      </button>
                    )}
                    <button
                      onClick={() => saveCaption(p.slug)}
                      disabled={savingSlug === p.slug || (drafts[p.slug] || "") === (p.caption || "")}
                      data-testid={`admin-help-save-${p.slug}`}
                      className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-[#dddd16] rounded-md flex items-center gap-1 disabled:opacity-40"
                    >
                      {savingSlug === p.slug ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                      Save
                    </button>
                  </div>
                </div>
                <textarea
                  rows={2}
                  value={drafts[p.slug] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [p.slug]: e.target.value }))}
                  placeholder={p.suggested_caption || "Optional intro shown above the slides"}
                  data-testid={`admin-help-caption-${p.slug}`}
                  className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-none focus:border-stone-900"
                />
              </div>

              {/* ------- Slides strip ------- */}
              <div>
                <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-2">Slides</div>
                <div className="flex gap-3 overflow-x-auto pb-2">
                  {slides.map((s, idx) => {
                    const key = `${p.slug}::${s.id}`;
                    return (
                      <div key={s.id} className="w-64 shrink-0 bg-stone-50 border border-stone-200 rounded-xl p-2 flex flex-col gap-2" data-testid={`admin-help-slide-${p.slug}-${idx}`}>
                        <div className="relative">
                          {s.image_url ? (
                            <a href={s.image_url} target="_blank" rel="noopener noreferrer" className="block">
                              <img src={s.image_url} alt={`${p.title} slide ${idx + 1}`} className="w-full h-32 object-cover rounded-md border border-stone-200" />
                            </a>
                          ) : (
                            <div className="w-full h-32 flex items-center justify-center bg-stone-100 border border-dashed border-stone-300 rounded-md text-stone-400 text-[11px]">
                              <ImageOff className="w-4 h-4 mr-1" /> Missing
                            </div>
                          )}
                          <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 text-[10px] font-bold bg-stone-950/80 text-white rounded">
                            {idx + 1}
                          </span>
                        </div>

                        <textarea
                          rows={2}
                          value={slideDrafts[key] ?? ""}
                          onChange={(e) => setSlideDrafts((d) => ({ ...d, [key]: e.target.value }))}
                          placeholder="Per-slide caption…"
                          data-testid={`admin-help-slide-caption-${p.slug}-${idx}`}
                          className="w-full px-2 py-1.5 text-xs border border-stone-300 rounded-md focus:outline-none focus:border-stone-900 bg-white"
                        />

                        <div className="flex items-center justify-between gap-1">
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => reorderSlide(p.slug, s.id, "left")}
                              disabled={idx === 0}
                              data-testid={`admin-help-slide-left-${p.slug}-${idx}`}
                              className="p-1.5 border border-stone-300 rounded-md text-stone-600 hover:bg-white disabled:opacity-30"
                              title="Move left"
                            >
                              <ChevronLeft className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => reorderSlide(p.slug, s.id, "right")}
                              disabled={idx === slides.length - 1}
                              data-testid={`admin-help-slide-right-${p.slug}-${idx}`}
                              className="p-1.5 border border-stone-300 rounded-md text-stone-600 hover:bg-white disabled:opacity-30"
                              title="Move right"
                            >
                              <ChevronRight className="w-3 h-3" />
                            </button>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => saveSlideCaption(p.slug, s.id)}
                              disabled={savingSlideKey === key || (slideDrafts[key] || "") === (s.caption || "")}
                              data-testid={`admin-help-slide-save-${p.slug}-${idx}`}
                              className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-[#dddd16] rounded-md flex items-center gap-1 disabled:opacity-40"
                              title="Save caption"
                            >
                              {savingSlideKey === key ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                            </button>
                            <button
                              onClick={() => deleteSlide(p.slug, s.id)}
                              disabled={busySlideKey === key}
                              data-testid={`admin-help-slide-delete-${p.slug}-${idx}`}
                              className="p-1.5 border border-stone-300 hover:bg-rose-50 hover:border-rose-200 hover:text-rose-700 text-stone-600 rounded-md disabled:opacity-40"
                              title="Delete slide"
                            >
                              {busySlideKey === key ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                            </button>
                            {s.image_url && (
                              <a
                                href={s.image_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="Open full size"
                                className="p-1.5 border border-stone-300 rounded-md text-stone-600 hover:bg-white"
                              >
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {/* "Add slide" tile */}
                  <label className="w-64 shrink-0 h-[230px] flex flex-col items-center justify-center bg-stone-50 border border-dashed border-stone-300 hover:border-stone-900 hover:bg-stone-100 rounded-xl cursor-pointer text-stone-500 hover:text-stone-900 transition" data-testid={`admin-help-upload-${p.slug}`}>
                    {uploadingSlug === p.slug ? (
                      <>
                        <Loader2 className="w-6 h-6 animate-spin mb-2" />
                        <span className="text-xs font-bold uppercase tracking-wider">Uploading…</span>
                      </>
                    ) : (
                      <>
                        <Plus className="w-6 h-6 mb-1" />
                        <span className="text-xs font-bold uppercase tracking-wider">Add slide</span>
                        <span className="text-[10px] mt-1 text-stone-400">PNG / JPG, max 25 MB</span>
                      </>
                    )}
                    <input
                      ref={(el) => { fileRefs.current[p.slug] = el; }}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => uploadSlide(p.slug, e.target.files?.[0])}
                      disabled={uploadingSlug === p.slug}
                    />
                  </label>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
