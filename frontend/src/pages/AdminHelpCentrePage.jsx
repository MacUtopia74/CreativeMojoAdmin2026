// Admin Help Centre — upload + caption one marked-up screenshot per
// portal page. The portal Help button reads from this same data and
// shows the right image in a full-screen modal.
//
// Layout: single-column list, one row per page. Each row has:
//   • Thumbnail (or empty-state pill)
//   • Caption textarea (with "use suggested" shortcut)
//   • Upload / replace / remove image controls
import { useEffect, useState, useCallback, useRef } from "react";
import {
  Loader2, Upload, Trash2, CheckCircle2, AlertCircle, ImageOff,
  Save, Sparkles, LifeBuoy, ExternalLink,
} from "lucide-react";
import api from "@/lib/api";

export default function AdminHelpCentrePage() {
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  // Local caption draft state keyed by slug — so admin can edit one
  // page without it triggering re-renders on others.
  const [drafts, setDrafts] = useState({});
  const [savingSlug, setSavingSlug] = useState(null);
  const [uploadingSlug, setUploadingSlug] = useState(null);
  const fileRefs = useRef({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/admin/help-centre/pages");
      setPages(data.pages || []);
      const seedDrafts = {};
      (data.pages || []).forEach((p) => { seedDrafts[p.slug] = p.caption || ""; });
      setDrafts(seedDrafts);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't load Help Centre.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const flash = (msg) => { setErr(msg); setTimeout(() => setErr(""), 3500); };

  const saveCaption = async (slug) => {
    setSavingSlug(slug);
    try {
      await api.patch(`/admin/help-centre/pages/${slug}`, { caption: drafts[slug] || "" });
      setPages((arr) => arr.map((p) => p.slug === slug ? { ...p, caption: drafts[slug] || "" } : p));
      flash(`Saved caption for "${slug}".`);
    } catch (e) {
      flash(e?.response?.data?.detail || "Couldn't save caption.");
    } finally { setSavingSlug(null); }
  };

  const uploadImage = async (slug, file) => {
    if (!file) return;
    setUploadingSlug(slug);
    try {
      const form = new FormData();
      form.append("file", file);
      // Persist the current caption draft alongside the upload so it
      // commits in a single round-trip.
      if (drafts[slug] != null) form.append("caption", drafts[slug]);
      const { data } = await api.post(`/admin/help-centre/pages/${slug}/upload`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setPages((arr) => arr.map((p) => p.slug === slug ? { ...p, image_url: data.image_url, has_image: true, caption: data.caption } : p));
      flash(`Uploaded help screenshot for "${slug}".`);
    } catch (e) {
      flash(e?.response?.data?.detail || "Upload failed.");
    } finally {
      setUploadingSlug(null);
      if (fileRefs.current[slug]) fileRefs.current[slug].value = "";
    }
  };

  const deleteImage = async (slug) => {
    if (!window.confirm("Remove this help screenshot? The caption will stay.")) return;
    try {
      await api.delete(`/admin/help-centre/pages/${slug}/image`);
      setPages((arr) => arr.map((p) => p.slug === slug ? { ...p, image_url: null, has_image: false } : p));
      flash("Image removed.");
    } catch (e) {
      flash(e?.response?.data?.detail || "Delete failed.");
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
    <div className="p-6 md:p-8 space-y-5 max-w-5xl" data-testid="admin-help-centre">
      <div>
        <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 flex items-center gap-1.5">
          <LifeBuoy className="w-3 h-3" /> Help Centre
        </div>
        <h1 className="font-display text-4xl text-stone-950 mt-1">Portal help screenshots</h1>
        <p className="text-sm text-stone-600 mt-2 max-w-2xl">
          Upload one marked-up screenshot per portal page. When a franchisee clicks the
          <strong className="mx-1">Help</strong>button in their sidebar, this image
          appears in a full-screen modal. Captions are optional but show above the image.
          Click <em>Use suggested</em> if you want a quick starting line you can edit.
        </p>
      </div>

      {err && (
        <div className={`px-4 py-3 border rounded-xl text-sm flex items-center gap-2 ${err.toLowerCase().startsWith("saved") || err.toLowerCase().startsWith("upload") || err.toLowerCase().startsWith("image") ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-amber-300 bg-amber-50 text-amber-900"}`}>
          {err.toLowerCase().startsWith("saved") || err.toLowerCase().startsWith("upload") || err.toLowerCase().startsWith("image") ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {err}
        </div>
      )}

      <div className="space-y-3" data-testid="admin-help-pages-list">
        {pages.map((p) => (
          <div key={p.slug} className="bg-white border border-stone-200 rounded-2xl p-4 flex gap-4 flex-wrap items-start" data-testid={`admin-help-row-${p.slug}`}>
            <div className="w-40 shrink-0">
              {p.image_url ? (
                <a href={p.image_url} target="_blank" rel="noopener noreferrer" className="block">
                  <img src={p.image_url} alt={p.title} className="w-full h-24 object-cover rounded-lg border border-stone-200" />
                </a>
              ) : (
                <div className="w-full h-24 flex items-center justify-center bg-stone-50 border border-dashed border-stone-300 rounded-lg text-stone-400 text-[11px]">
                  <ImageOff className="w-4 h-4 mr-1" /> No image
                </div>
              )}
            </div>

            <div className="flex-1 min-w-[260px] space-y-2">
              <div className="flex items-center gap-2">
                <h2 className="font-display text-xl text-stone-950">{p.title}</h2>
                <code className="text-[10px] font-mono text-stone-400">{p.match_paths?.[0]}</code>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Caption</label>
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
                </div>
                <textarea
                  rows={2}
                  value={drafts[p.slug] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [p.slug]: e.target.value }))}
                  placeholder={p.suggested_caption || "Optional caption shown above the help screenshot"}
                  data-testid={`admin-help-caption-${p.slug}`}
                  className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-none focus:border-stone-900"
                />
              </div>
            </div>

            <div className="flex flex-col gap-2 w-44 shrink-0">
              <button
                onClick={() => saveCaption(p.slug)}
                disabled={savingSlug === p.slug || (drafts[p.slug] || "") === (p.caption || "")}
                data-testid={`admin-help-save-${p.slug}`}
                className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-[#dddd16] rounded-lg flex items-center justify-center gap-1.5 disabled:opacity-40"
              >
                {savingSlug === p.slug ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save caption
              </button>
              <label className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 text-stone-800 rounded-lg flex items-center justify-center gap-1.5 cursor-pointer" data-testid={`admin-help-upload-${p.slug}`}>
                {uploadingSlug === p.slug ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                {p.has_image ? "Replace image" : "Upload image"}
                <input
                  ref={(el) => { fileRefs.current[p.slug] = el; }}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => uploadImage(p.slug, e.target.files?.[0])}
                  disabled={uploadingSlug === p.slug}
                />
              </label>
              {p.has_image && (
                <button
                  onClick={() => deleteImage(p.slug)}
                  data-testid={`admin-help-delete-${p.slug}`}
                  className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-rose-50 hover:border-rose-200 hover:text-rose-700 text-stone-600 rounded-lg flex items-center justify-center gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Remove
                </button>
              )}
              {p.has_image && (
                <a
                  href={p.image_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-center text-stone-500 hover:text-stone-900 inline-flex items-center justify-center gap-1"
                >
                  <ExternalLink className="w-3 h-3" /> Open full size
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
