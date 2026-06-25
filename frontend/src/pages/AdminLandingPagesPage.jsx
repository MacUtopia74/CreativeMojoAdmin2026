// Admin CRUD for public PDF landing pages.
//
// One-list-one-detail screen: pick a page on the left, edit on the
// right (slug, title, intro, bullets, CTA label, R2 file). The R2 file
// picker re-uses the same browser/search component as the Email
// Templates editor — paths look the same from /admin/files.
//
// Stats: each row shows live view + download counts (server-aggregated)
// so admins can quickly spot which packs are landing.
import { useCallback, useEffect, useMemo, useState } from "react";
import api from "@/lib/api";
import {
  Plus, Trash2, Save, Loader2, AlertTriangle, FileText, Eye, Download,
  ExternalLink, Folder, FolderOpen, Search, Home, ArrowLeft, ChevronRight, X,
  Paperclip, Globe, Lock, Users,
} from "lucide-react";
import { toast } from "sonner";

// Public-facing production URL — what recipients see when an email link
// resolves. We deliberately don't use REACT_APP_BACKEND_URL here because
// that points at the preview origin (licensee-vault.preview…) in this
// environment, and we want the admin to always see the canonical
// production URL alongside any links they share.
const HUB_PUBLIC_BASE = "https://hub.creativemojo.co.uk";

// ---------------------------------------------------------------------------
// R2 file picker — identical UX to the Email Templates page (folder
// browser + search). Kept inline here to avoid sharing component state
// across surfaces; copy-pasted intentionally.
// ---------------------------------------------------------------------------
function FilePickerModal({ onClose, onPick }) {
  const [tab, setTab] = useState("browse");
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState("");
  const [prefix, setPrefix] = useState("");
  const [tree, setTree] = useState({ folders: [], files: [] });
  const [browsing, setBrowsing] = useState(false);

  useEffect(() => {
    if (tab !== "search") return;
    if ((q || "").length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      setSearching(true); setErr("");
      try {
        const { data } = await api.get("/files/search", { params: { q, limit: 60 } });
        setResults(data.items || []);
      } catch (e) {
        setErr(e?.response?.data?.detail || "Search failed");
      } finally { setSearching(false); }
    }, 200);
    return () => clearTimeout(t);
  }, [q, tab]);

  useEffect(() => {
    if (tab !== "browse") return;
    let cancelled = false;
    (async () => {
      setBrowsing(true); setErr("");
      try {
        const { data } = await api.get("/files/tree", { params: { prefix } });
        if (!cancelled) setTree({ folders: data.folders || [], files: data.files || [] });
      } catch (e) {
        if (!cancelled) setErr(e?.response?.data?.detail || "Could not load folder");
      } finally { if (!cancelled) setBrowsing(false); }
    })();
    return () => { cancelled = true; };
  }, [prefix, tab]);

  const crumbs = useMemo(() => {
    if (!prefix) return [];
    const parts = prefix.replace(/\/$/, "").split("/");
    return parts.map((seg, i) => ({ name: seg, prefix: parts.slice(0, i + 1).join("/") + "/" }));
  }, [prefix]);
  const rootIcon = (name) => {
    if (name === "admin") return <Lock className="w-4 h-4 text-orange-500 shrink-0" />;
    if (name === "shared") return <Globe className="w-4 h-4 text-emerald-600 shrink-0" />;
    if (name === "franchisees") return <Users className="w-4 h-4 text-stone-600 shrink-0" />;
    return <Folder className="w-4 h-4 text-stone-400 shrink-0" />;
  };

  return (
    <div onClick={onClose} className="fixed inset-0 z-[80] bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-6">
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl max-w-2xl w-full max-h-[80vh] flex flex-col shadow-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
          <h3 className="font-bold text-stone-900 flex items-center gap-2"><Paperclip className="w-4 h-4" /> Pick a file from R2</h3>
          <button onClick={onClose} className="w-9 h-9 hover:bg-stone-100 rounded-lg flex items-center justify-center"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-5 pt-3 border-b border-stone-200 flex items-center gap-1">
          <button onClick={() => setTab("browse")} className={`px-3 py-1.5 text-xs font-semibold rounded-t-md border-b-2 transition-colors ${tab === "browse" ? "border-stone-900 text-stone-900" : "border-transparent text-stone-500 hover:text-stone-800"}`}>
            <FolderOpen className="w-3.5 h-3.5 inline mr-1.5" />Browse
          </button>
          <button onClick={() => setTab("search")} className={`px-3 py-1.5 text-xs font-semibold rounded-t-md border-b-2 transition-colors ${tab === "search" ? "border-stone-900 text-stone-900" : "border-transparent text-stone-500 hover:text-stone-800"}`}>
            <Search className="w-3.5 h-3.5 inline mr-1.5" />Search
          </button>
        </div>
        {tab === "search" && (
          <div className="px-5 py-3 border-b border-stone-200">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Search files by name…"
                className="w-full pl-9 pr-3 py-2 bg-stone-50 border border-stone-300 text-sm rounded-lg focus:outline-none focus:border-stone-900" />
            </div>
          </div>
        )}
        {tab === "browse" && (
          <div className="px-5 py-2.5 border-b border-stone-200 flex items-center gap-1.5 text-xs overflow-x-auto">
            <button onClick={() => setPrefix("")} className={`px-2 py-1 rounded flex items-center gap-1 shrink-0 ${prefix === "" ? "bg-stone-900 text-white" : "hover:bg-stone-100 text-stone-700"}`}>
              <Home className="w-3 h-3" /> Root
            </button>
            {crumbs.map((c, i) => (
              <div key={c.prefix} className="flex items-center gap-1 shrink-0">
                <ChevronRight className="w-3 h-3 text-stone-400" />
                <button onClick={() => setPrefix(c.prefix)} className={`px-2 py-1 rounded ${i === crumbs.length - 1 ? "bg-stone-900 text-white" : "hover:bg-stone-100 text-stone-700"}`}>{c.name}</button>
              </div>
            ))}
            {prefix && (
              <button onClick={() => { const p = prefix.replace(/\/$/, "").split("/"); p.pop(); setPrefix(p.length ? p.join("/") + "/" : ""); }} className="ml-auto px-2 py-1 rounded hover:bg-stone-100 text-stone-700 flex items-center gap-1 shrink-0">
                <ArrowLeft className="w-3 h-3" /> Up
              </button>
            )}
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          {err && <div className="p-4 text-red-700 bg-red-50 text-sm">{err}</div>}
          {tab === "search" && (
            <>
              {searching && <div className="p-6 text-center text-stone-500"><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Searching…</div>}
              {!searching && !err && q.length >= 2 && results.length === 0 && <div className="p-6 text-center text-stone-500 text-sm">No files match.</div>}
              {!searching && !err && q.length < 2 && <div className="p-6 text-center text-stone-500 text-sm">Type at least 2 characters.</div>}
              <ul className="divide-y divide-stone-100">
                {results.map((f) => (
                  <li key={f.key}>
                    <button onClick={() => onPick(f)} className="w-full text-left px-5 py-2.5 hover:bg-stone-50 flex items-center gap-3">
                      <FileText className="w-4 h-4 text-stone-400 shrink-0" />
                      <div className="flex-1 min-w-0"><div className="text-sm text-stone-900 truncate">{f.name}</div><div className="text-[10px] text-stone-500 truncate font-mono">{f.key}</div></div>
                      <ChevronRight className="w-4 h-4 text-stone-400 shrink-0" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {tab === "browse" && (
            <>
              {browsing && <div className="p-6 text-center text-stone-500"><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading…</div>}
              {!browsing && !err && tree.folders.length === 0 && tree.files.length === 0 && <div className="p-6 text-center text-stone-500 text-sm">Empty.</div>}
              <ul className="divide-y divide-stone-100">
                {tree.folders.map((d) => (
                  <li key={d.key}>
                    <button onClick={() => setPrefix(d.key)} className="w-full text-left px-5 py-2.5 hover:bg-stone-50 flex items-center gap-3">
                      {prefix === "" ? rootIcon(d.name) : <Folder className="w-4 h-4 text-stone-400 shrink-0" />}
                      <div className="flex-1 min-w-0"><div className="text-sm text-stone-900 truncate font-medium">{d.name}</div><div className="text-[10px] text-stone-500 truncate">{d.files} file{d.files === 1 ? "" : "s"}</div></div>
                      <ChevronRight className="w-4 h-4 text-stone-400 shrink-0" />
                    </button>
                  </li>
                ))}
                {tree.files.map((f) => (
                  <li key={f.key}>
                    <button onClick={() => onPick(f)} className="w-full text-left px-5 py-2.5 hover:bg-stone-50 flex items-center gap-3">
                      <FileText className="w-4 h-4 text-stone-400 shrink-0" />
                      <div className="flex-1 min-w-0"><div className="text-sm text-stone-900 truncate">{f.name}</div><div className="text-[10px] text-stone-500 truncate font-mono">{f.key}</div></div>
                      <ChevronRight className="w-4 h-4 text-stone-400 shrink-0" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor panel — controlled by the parent. Saves a draft via PATCH.
// ---------------------------------------------------------------------------
function LandingPageEditor({ page, onSaved, onDeleted }) {
  const [draft, setDraft] = useState(page);
  const [saving, setSaving] = useState(false);
  const [showFilePicker, setShowFilePicker] = useState(false);

  useEffect(() => { setDraft(page); }, [page]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(page);
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.patch(`/admin/landing-pages/${page.id}`, {
        slug: draft.slug,
        title: draft.title,
        intro_html: draft.intro_html,
        cta_label: draft.cta_label,
        file_key: draft.file_key,
        file_name: draft.file_name,
        active: draft.active,
      });
      onSaved(data);
      setDraft(data);
      toast.success("Page saved");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not save");
    } finally { setSaving(false); }
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${page.title}"? Visit history will be kept, but the URL /info/${page.slug} will go 404.`)) return;
    try {
      await api.delete(`/admin/landing-pages/${page.id}`);
      onDeleted(page.id);
      toast.success("Page deleted");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not delete");
    }
  };

  const onPickFile = (f) => {
    setDraft((d) => ({ ...d, file_key: f.key, file_name: f.name }));
    setShowFilePicker(false);
  };

  const publicUrl = `${HUB_PUBLIC_BASE}/info/${draft.slug}`;

  return (
    <div className="space-y-4">
      {/* Title bar */}
      <div className="flex items-center justify-between gap-3 pb-3 border-b border-stone-200">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-0.5">Landing page</div>
          <div className="text-lg font-bold text-stone-900 truncate">{draft.title || "Untitled"}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a href={publicUrl} target="_blank" rel="noopener noreferrer"
            className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-stone-100 hover:bg-stone-200 text-stone-800 rounded inline-flex items-center gap-1.5"
            data-testid="landing-preview-link">
            <ExternalLink className="w-3 h-3" /> Preview
          </a>
          <button onClick={save} disabled={!dirty || saving} data-testid="landing-save-btn"
            className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-stone-900 hover:bg-stone-800 disabled:bg-stone-300 disabled:cursor-not-allowed text-white rounded inline-flex items-center gap-1.5">
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Save
          </button>
          <button onClick={remove} title="Delete this page" data-testid="landing-delete-btn"
            className="px-2 py-1.5 text-xs bg-rose-50 hover:bg-rose-100 text-rose-700 rounded inline-flex items-center"><Trash2 className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Title">
          <input value={draft.title || ""} onChange={set("title")} data-testid="landing-title-input"
            className="w-full px-3 py-2 bg-stone-50 border border-stone-300 text-sm rounded-lg focus:outline-none focus:border-stone-900" />
        </Field>
        <Field label="Slug (URL)" hint={`Public URL: ${publicUrl}`}>
          <input value={draft.slug || ""} onChange={set("slug")} data-testid="landing-slug-input"
            className="w-full px-3 py-2 bg-stone-50 border border-stone-300 text-sm rounded-lg font-mono focus:outline-none focus:border-stone-900" />
        </Field>
      </div>

      <Field label="Intro (rich text — basic HTML allowed)" hint="Tip: short and warm. 1–3 sentences works best.">
        <textarea value={draft.intro_html || ""} onChange={set("intro_html")} rows={5} data-testid="landing-intro-input"
          className="w-full px-3 py-2 bg-stone-50 border border-stone-300 text-sm rounded-lg focus:outline-none focus:border-stone-900 font-mono" />
      </Field>

      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="CTA button label">
          <input value={draft.cta_label || ""} onChange={set("cta_label")} data-testid="landing-cta-input"
            className="w-full px-3 py-2 bg-stone-50 border border-stone-300 text-sm rounded-lg focus:outline-none focus:border-stone-900" />
        </Field>
        <Field label="Active">
          <label className="flex items-center gap-2 text-sm font-medium pt-1.5">
            <input type="checkbox" checked={!!draft.active} onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))}
              data-testid="landing-active-checkbox" className="w-4 h-4" />
            {draft.active ? "Published — link is live" : "Hidden — link returns 404"}
          </label>
        </Field>
      </div>

      <Field label="Attached PDF (from R2)">
        <div className="flex items-center gap-2">
          <div className="flex-1 px-3 py-2 bg-stone-50 border border-stone-300 text-sm rounded-lg truncate font-mono text-stone-700" data-testid="landing-file-display">
            {draft.file_key || <span className="text-stone-400 italic">No file picked yet</span>}
          </div>
          <button type="button" onClick={() => setShowFilePicker(true)} data-testid="landing-pick-file-btn"
            className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-stone-100 hover:bg-stone-200 text-stone-800 rounded inline-flex items-center gap-1.5">
            <Paperclip className="w-3 h-3" /> {draft.file_key ? "Change" : "Pick"}
          </button>
        </div>
        {draft.file_name && (
          <div className="mt-1.5 text-xs text-stone-500 truncate">→ {draft.file_name}</div>
        )}
      </Field>

      <div className="bg-stone-100 border border-stone-200 rounded-lg p-3 text-[11px] text-stone-600">
        <div className="font-semibold uppercase tracking-wider text-stone-800 mb-1">Use this in an email</div>
        <div>Insert the token <code className="bg-white px-1 py-0.5 rounded font-mono">{`{{landing:${draft.slug || ""}}}`}</code> into any email template&apos;s CTA &mdash; it resolves at send time to the public URL with a tracking token.</div>
      </div>

      <PageStats pageId={page.id} />

      {showFilePicker && <FilePickerModal onClose={() => setShowFilePicker(false)} onPick={onPickFile} />}
    </div>
  );
}

function PageStats({ pageId }) {
  const [stats, setStats] = useState(null);
  const [open, setOpen] = useState(false);

  const load = async () => {
    try {
      const { data } = await api.get(`/admin/landing-pages/${pageId}/stats`);
      setStats(data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not load stats");
    }
  };

  useEffect(() => {
    if (open && !stats) load();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="border border-stone-200 rounded-lg overflow-hidden">
      <button type="button" onClick={() => setOpen((v) => !v)} data-testid="landing-stats-toggle"
        className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-stone-50 text-left">
        <Eye className="w-4 h-4 text-stone-500" />
        <div className="flex-1"><div className="text-sm font-bold text-stone-900">Visit log</div><div className="text-[11px] text-stone-500">Views &amp; downloads &mdash; track who&apos;s engaging</div></div>
        <ChevronRight className={`w-4 h-4 text-stone-400 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-stone-200 p-3">
          {!stats ? (
            <div className="text-center py-3 text-stone-500 text-sm"><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading…</div>
          ) : (
            <>
              <div className="flex items-center gap-4 mb-3 text-sm">
                <div><span className="font-bold text-stone-900">{stats.views}</span> <span className="text-stone-500">views</span></div>
                <div><span className="font-bold text-stone-900">{stats.downloads}</span> <span className="text-stone-500">downloads</span></div>
              </div>
              {stats.visits.length === 0 ? (
                <div className="text-center py-4 text-xs text-stone-500">No visits yet &mdash; share the link to start tracking.</div>
              ) : (
                <div className="max-h-72 overflow-y-auto text-xs">
                  <table className="w-full">
                    <thead className="text-[10px] uppercase tracking-wider text-stone-600 font-bold">
                      <tr><th className="text-left px-2 py-1">When</th><th className="text-left px-2 py-1">Outcome</th><th className="text-left px-2 py-1">IP</th><th className="text-left px-2 py-1">Source</th></tr>
                    </thead>
                    <tbody>
                      {stats.visits.map((v) => (
                        <tr key={v.id} className="border-t border-stone-100">
                          <td className="px-2 py-1 font-mono text-stone-700">{new Date(v.at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                          <td className="px-2 py-1">
                            {v.outcome === "download"
                              ? <span className="px-1.5 py-0.5 bg-emerald-50 text-emerald-800 border border-emerald-200 rounded font-semibold text-[10px] uppercase">Download</span>
                              : <span className="px-1.5 py-0.5 bg-stone-100 text-stone-700 border border-stone-200 rounded font-semibold text-[10px] uppercase">View</span>}
                          </td>
                          <td className="px-2 py-1 font-mono text-stone-500">{v.ip || "—"}</td>
                          <td className="px-2 py-1 text-stone-500 truncate">{v.token ? `via email · ${v.token.slice(0, 8)}…` : (v.referrer || "direct")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1">{label}</div>
      {children}
      {hint && <div className="text-[10px] text-stone-500 mt-1">{hint}</div>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------
export default function AdminLandingPagesPage() {
  const [items, setItems] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/admin/landing-pages");
      setItems(data.items || []);
      if (!selectedId && data.items?.length) setSelectedId(data.items[0].id);
    } finally { setLoading(false); }
  }, [selectedId]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    const title = window.prompt("Title for the new landing page?", "New Landing Page");
    if (!title) return;
    try {
      const { data } = await api.post("/admin/landing-pages", {
        title, intro_html: "<p>Welcome — download the pack below.</p>",
        cta_label: "Download the Info Pack", active: true,
      });
      setItems((prev) => [data, ...prev]);
      setSelectedId(data.id);
      toast.success("Page created");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not create");
    }
  };

  const selected = items.find((p) => p.id === selectedId);

  return (
    <div className="px-4 sm:px-8 py-6 max-w-7xl mx-auto" data-testid="admin-landing-pages">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-stone-900">PDF Landing Pages</h1>
        <p className="text-sm text-stone-500 mt-1">Public, branded landing pages for sales packs and brochures. Each page tracks views &amp; downloads — share via emails with <code className="bg-stone-100 px-1 py-0.5 rounded font-mono text-xs">{`{{landing:<slug>}}`}</code> tokens for per-contact attribution.</p>
      </div>

      {loading ? (
        <div className="text-center py-12 text-stone-500"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
      ) : (
        <div className="grid lg:grid-cols-[280px_1fr] gap-5">
          <aside className="space-y-2">
            <button onClick={create} data-testid="landing-create-btn"
              className="w-full px-3 py-2 text-xs font-bold uppercase tracking-wider bg-stone-900 hover:bg-stone-800 text-white rounded inline-flex items-center justify-center gap-2">
              <Plus className="w-3.5 h-3.5" /> New page
            </button>
            {items.length === 0 ? (
              <div className="text-center py-8 px-4 text-sm text-stone-500 bg-white border border-stone-200 rounded-lg">
                <AlertTriangle className="w-5 h-5 mx-auto mb-2 text-stone-400" />
                No landing pages yet — create your first one.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {items.map((p) => (
                  <li key={p.id}>
                    <button onClick={() => setSelectedId(p.id)} data-testid={`landing-row-${p.slug}`}
                      className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${selectedId === p.id ? "bg-stone-900 text-white border-stone-900" : "bg-white border-stone-200 hover:bg-stone-50"}`}>
                      <div className={`text-sm font-semibold truncate ${selectedId === p.id ? "text-white" : "text-stone-900"}`}>
                        {p.title} {!p.active && <span className="text-[9px] uppercase tracking-wider opacity-70">(hidden)</span>}
                      </div>
                      <div className={`text-[10px] font-mono truncate ${selectedId === p.id ? "text-stone-300" : "text-stone-500"}`}>/info/{p.slug}</div>
                      <div className="mt-1 flex items-center gap-2 text-[10px]">
                        <span className={selectedId === p.id ? "text-stone-300" : "text-stone-500"}><Eye className="w-3 h-3 inline" /> {p.views}</span>
                        <span className={selectedId === p.id ? "text-stone-300" : "text-stone-500"}><Download className="w-3 h-3 inline" /> {p.downloads}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <main className="bg-white rounded-2xl border border-stone-200 p-5">
            {selected ? (
              <LandingPageEditor
                page={selected}
                onSaved={(d) => setItems((prev) => prev.map((p) => (p.id === d.id ? { ...p, ...d } : p)))}
                onDeleted={(id) => {
                  setItems((prev) => prev.filter((p) => p.id !== id));
                  setSelectedId((curr) => (curr === id ? null : curr));
                }}
              />
            ) : (
              <div className="text-center py-12 text-stone-500 text-sm">Pick a page on the left to edit, or create a new one.</div>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
