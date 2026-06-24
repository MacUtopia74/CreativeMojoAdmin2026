// Email Templates admin page — list + edit + duplicate + delete + create.
// Body editing now uses a proper WYSIWYG (Tiptap) so Paul + Sandra never
// touch raw HTML. The {{first_name}} and {{file:*}} tokens still flow
// through unchanged because we render them as plain text inside the
// editor — Tiptap preserves them verbatim through copy/paste/save.
import { useCallback, useEffect, useMemo, useState } from "react";
import api from "@/lib/api";
import DOMPurify from "dompurify";
import RichTextEditor from "@/components/RichTextEditor";
import {
  Loader2, Plus, Copy, Trash2, Save, X, Mail,
  Paperclip, FileText, ChevronRight, Search, AlertTriangle, CheckCircle2,
  Folder, FolderOpen, Home, ArrowLeft, Users, Globe, Lock,
} from "lucide-react";
import { toast } from "sonner";

export default function EmailTemplatesPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/email-templates");
      setItems(data.items || []);
      if (!selectedId && data.items?.length) setSelectedId(data.items[0].id);
    } finally { setLoading(false); }
  }, [selectedId]);
  useEffect(() => { load(); }, [load]);

  const selected = useMemo(() => items.find((t) => t.id === selectedId), [items, selectedId]);

  const createNew = async () => {
    const { data } = await api.post("/email-templates", { name: "New template", subject: "", body_html: "" });
    setItems((arr) => [data, ...arr]);
    setSelectedId(data.id);
  };
  const duplicate = async (id) => {
    const { data } = await api.post(`/email-templates/${id}/duplicate`);
    setItems((arr) => [data, ...arr]);
    setSelectedId(data.id);
    toast.success("Template duplicated");
  };
  const remove = async (id) => {
    if (!window.confirm("Delete this template? This can't be undone.")) return;
    await api.delete(`/email-templates/${id}`);
    setItems((arr) => arr.filter((t) => t.id !== id));
    if (selectedId === id) setSelectedId(null);
    toast.success("Template deleted");
  };

  if (loading) return <div className="flex items-center justify-center min-h-[60vh] text-stone-500"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…</div>;

  return (
    <div className="flex h-[calc(100vh-4rem)]" data-testid="email-templates-page">
      {/* Left rail — list */}
      <div className="w-72 border-r border-stone-200 flex flex-col bg-stone-50">
        <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between">
          <h2 className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-700 flex items-center gap-1.5">
            <Mail className="w-3 h-3" /> Email Templates
          </h2>
          <button onClick={createNew} data-testid="template-new"
            className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-[#dddd16] rounded flex items-center gap-1">
            <Plus className="w-3 h-3" /> New
          </button>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {items.length === 0 && <li className="px-4 py-6 text-xs text-stone-500 text-center">No templates yet.</li>}
          {items.map((t) => {
            const active = t.id === selectedId;
            return (
              <li key={t.id}>
                <button onClick={() => setSelectedId(t.id)}
                  data-testid={`template-row-${t.id}`}
                  className={`w-full text-left px-4 py-3 border-b border-stone-200 transition-colors ${active ? "bg-white" : "hover:bg-white"}`}>
                  <div className="text-sm font-semibold text-stone-900 truncate">{t.name}</div>
                  <div className="text-[11px] text-stone-500 truncate mt-0.5">{t.subject || "— no subject —"}</div>
                  {t.category && (
                    <span className="inline-block mt-1 px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-bold bg-stone-200 text-stone-700 rounded">
                      {t.category}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Right pane — editor or empty state */}
      <div className="flex-1 overflow-y-auto">
        {!selected ? (
          <div className="flex items-center justify-center h-full text-stone-500">Select a template, or click "New".</div>
        ) : (
          <TemplateEditor
            key={selected.id}
            template={selected}
            onChanged={(patched) => setItems((arr) => arr.map((t) => t.id === patched.id ? patched : t))}
            onDuplicate={() => duplicate(selected.id)}
            onDelete={() => remove(selected.id)}
          />
        )}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// TemplateEditor — one selected template. Lazy save: dirty flag + manual
// Save button to keep the wire-traffic low (these are long HTML bodies).
// ---------------------------------------------------------------------------
function TemplateEditor({ template, onChanged, onDuplicate, onDelete }) {
  const [draft, setDraft] = useState(template);
  const [saving, setSaving] = useState(false);
  const [showFilePicker, setShowFilePicker] = useState(false);
  // When the file picker is opened from a CTA toolbar button we capture
  // which button-style ("cta" / "outline") was clicked, so the chosen
  // R2 file becomes an inline yellow or outline button.
  const [filePickerMode, setFilePickerMode] = useState("cta");

  useEffect(() => { setDraft(template); }, [template]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(template);
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  const setCsv = (k) => (e) =>
    setDraft((d) => ({ ...d, [k]: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) }));

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.patch(`/email-templates/${template.id}`, draft);
      onChanged(data);
      // Re-sync local draft so the preview pulls the freshly built
      // ``rendered_html`` (editable body + system signature).
      setDraft(data);
      toast.success("Template saved");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not save");
    } finally { setSaving(false); }
  };

  // Append a snippet at the cursor — falls back to end-of-document
  // for the WYSIWYG editor (we don't have direct caret access through
  // the Tiptap React wrapper for token strings, so trailing-append
  // matches user expectations: they click "Insert" after positioning
  // their cursor and the token appears at the bottom for them to
  // grab if needed). This is good enough — Paul edits templates
  // rarely.
  const insertAtCursor = (snippet) => {
    setDraft((d) => ({ ...d, body_html: (d.body_html || "") + snippet }));
  };

  const insertFirstName = () => insertAtCursor("{{first_name}}");

  // Insert a yellow CTA button. Pops the link dialog asking for label +
  // URL; if the admin wants to attach an R2 file instead, they can use
  // the "Pick from File Vault" file-picker (re-uses same code path).
  const promptCta = (label, style) => {
    const text = window.prompt(`Button label (e.g. ${label})`, label);
    if (!text) return null;
    const wantFile = window.confirm("Pick from R2 File Vault? Click Cancel to type an external URL instead.");
    if (wantFile) {
      // Defer to the file picker — it inserts the styled button itself.
      setFilePickerMode(style);
      setShowFilePicker(true);
      return { text, style, deferred: true };
    }
    const url = window.prompt("Button URL (e.g. https://…)", "https://");
    if (!url) return null;
    const normalised = /^https?:\/\//i.test(url) || url.startsWith("mailto:") || url.startsWith("{{") ? url : `https://${url}`;
    return { text, url: normalised, style };
  };
  const buildButtonHtml = ({ text, url, style }) => {
    const cls = style === "outline" ? "cm-btn-outline" : "cm-btn-cta";
    return `<p><a href="${url}" class="${cls}" target="_blank" rel="noopener noreferrer">${text}</a></p>`;
  };
  const insertCta = () => {
    const r = promptCta("Click here to download", "cta");
    if (!r || r.deferred) return;
    insertAtCursor(buildButtonHtml(r));
  };
  const insertOutline = () => {
    const r = promptCta("Watch the video", "outline");
    if (!r || r.deferred) return;
    insertAtCursor(buildButtonHtml(r));
  };

  const onPickFile = (f) => {
    const slug = (f.name || "file").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `file_${Math.random().toString(36).slice(2, 7)}`;
    setDraft((d) => {
      const existing = d.attachments || [];
      const dedup = [...existing.filter((a) => a.placeholder !== slug),
        { key: f.key, name: f.name, placeholder: slug }];
      return { ...d, attachments: dedup };
    });
    // Use the styled button class so it picks up the WYSIWYG editor's
    // canvas CSS — no inline styles needed, and the backend's send-time
    // resolver still substitutes {{file:…}} for the live R2 share URL.
    const cls = filePickerMode === "outline" ? "cm-btn-outline" : "cm-btn-cta";
    const label = filePickerMode === "outline" ? `Watch ${f.name}` : `Click here to download ${f.name}`;
    insertAtCursor(`<p><a href="{{file:${slug}}}" class="${cls}" target="_blank" rel="noopener noreferrer">${label}</a></p>`);
    setShowFilePicker(false);
    setFilePickerMode("cta");
  };

  return (
    <div className="p-6 max-w-4xl space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <input
            value={draft.name || ""}
            onChange={set("name")}
            placeholder="Template name"
            data-testid="template-name"
            className="text-2xl font-display text-stone-950 w-full bg-transparent border-0 focus:outline-none focus:ring-0"
          />
          <div className="text-xs text-stone-500 mt-1">
            {template.updated_at && <>Last saved {new Date(template.updated_at).toLocaleString("en-GB")}{template.updated_by ? ` · ${template.updated_by}` : ""}</>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={onDuplicate} data-testid="template-duplicate" className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-lg flex items-center gap-1">
            <Copy className="w-3 h-3" /> Duplicate
          </button>
          <button onClick={onDelete} data-testid="template-delete" className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-red-300 text-red-700 hover:bg-red-50 rounded-lg flex items-center gap-1">
            <Trash2 className="w-3 h-3" /> Delete
          </button>
          {dirty && (
            <button onClick={save} disabled={saving} data-testid="template-save"
              className="px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-lg flex items-center gap-1 disabled:opacity-50">
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Save
            </button>
          )}
        </div>
      </div>

      {/* Fields */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1">Subject</label>
          <input
            value={draft.subject || ""}
            onChange={set("subject")}
            placeholder="Your Creative Mojo Franchise Enquiry"
            data-testid="template-subject"
            className="w-full px-3 py-2 bg-white border border-stone-300 text-sm rounded-lg focus:outline-none focus:border-stone-900"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1">From (sender email)</label>
          <input value={draft.default_from || ""} onChange={set("default_from")} placeholder="paul@creativemojo.co.uk" data-testid="template-from"
            className="w-full px-3 py-2 bg-white border border-stone-300 text-sm rounded-lg focus:outline-none focus:border-stone-900" />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1">Sender display name</label>
          <input value={draft.sender_name || ""} onChange={set("sender_name")} placeholder="Paul Caldeira-Dunkerley" data-testid="template-sender-name"
            className="w-full px-3 py-2 bg-white border border-stone-300 text-sm rounded-lg focus:outline-none focus:border-stone-900" />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1">Default Cc (comma separated)</label>
          <input value={(draft.default_cc || []).join(", ")} onChange={setCsv("default_cc")} data-testid="template-cc"
            className="w-full px-3 py-2 bg-white border border-stone-300 text-sm rounded-lg focus:outline-none focus:border-stone-900" />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1">Default Bcc (comma separated)</label>
          <input value={(draft.default_bcc || []).join(", ")} onChange={setCsv("default_bcc")} data-testid="template-bcc"
            className="w-full px-3 py-2 bg-white border border-stone-300 text-sm rounded-lg focus:outline-none focus:border-stone-900" />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1">Category (optional tag)</label>
          <input value={draft.category || ""} onChange={set("category")} placeholder="franchise / licence / shadow-day" data-testid="template-category"
            className="w-full px-3 py-2 bg-white border border-stone-300 text-sm rounded-lg focus:outline-none focus:border-stone-900" />
        </div>
      </div>

      {/* Body — WYSIWYG canvas matches the final email layout exactly:
          logo at the top, your editable body, and the locked Creative
          Mojo signature beneath. No more "Preview" toggle — what you
          see is what gets sent. */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Email body (live preview)</label>
          <div className="flex items-center gap-2">
            <button type="button" onClick={insertFirstName} data-testid="template-insert-firstname"
              className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-100 hover:bg-stone-200 text-stone-800 rounded inline-flex items-center gap-1">
              + {`{{first_name}}`}
            </button>
            <button type="button" onClick={() => { setFilePickerMode("cta"); setShowFilePicker(true); }} data-testid="template-insert-file"
              className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-100 hover:bg-stone-200 text-stone-800 rounded inline-flex items-center gap-1">
              <Paperclip className="w-3 h-3" /> Insert R2 file link
            </button>
          </div>
        </div>
        <RichTextEditor
          value={draft.body_html || ""}
          onChange={(html) => setDraft((d) => ({ ...d, body_html: html }))}
          placeholder="Write your email here. Use the toolbar — bold, CTA buttons, lists, links."
          testIdPrefix="template-body"
          onInsertCta={insertCta}
          onInsertOutline={insertOutline}
          signatureHtml={draft.signature_html || ""}
          logoUrl="https://creativemojo.co.uk/wp-content/uploads/2023/05/creative-mojo-logo.png"
        />
      </div>

      {/* Attached files */}
      {(draft.attachments || []).length > 0 && (
        <div className="border border-stone-200 rounded-lg p-3 bg-stone-50">
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-2">Linked files</div>
          <ul className="space-y-1.5">
            {draft.attachments.map((a, i) => (
              <li key={`${a.placeholder}-${i}`} className="flex items-center gap-2 text-xs">
                <FileText className="w-3 h-3 text-stone-400 shrink-0" />
                <span className="font-mono text-stone-700 truncate flex-1">{a.placeholder ? `{{file:${a.placeholder}}}` : "(no placeholder)"}</span>
                <span className="text-stone-500 truncate">→ {a.name}</span>
                <span className="text-stone-400 truncate text-[10px]">{a.key || "(no R2 key set — pick a file)"}</span>
                <button type="button" onClick={() => setDraft((d) => ({ ...d, attachments: (d.attachments || []).filter((_, idx) => idx !== i) }))}
                  data-testid={`template-attach-remove-${i}`}
                  className="text-stone-400 hover:text-red-700">
                  <X className="w-3 h-3" />
                </button>
              </li>
            ))}
          </ul>
          {draft.attachments.some((a) => !a.key) && (
            <div className="mt-2 text-[11px] text-amber-800 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              Some files don't have an R2 key set — click "Insert R2 file link" to pick from your storage and overwrite the placeholder.
            </div>
          )}
        </div>
      )}

      {showFilePicker && <FilePickerModal onClose={() => setShowFilePicker(false)} onPick={onPickFile} />}
    </div>
  );
}


// ---------------------------------------------------------------------------
// PreviewHtml — renders the template body with {{first_name}} replaced
// and {{file:*}} links shown as friendly chip text.
//
// We wrap the rendered HTML in a div whose CSS gives `<p>` real
// margin-bottom so empty paragraphs (a single Enter-Enter blank line)
// show visible vertical space — matching how Gmail/Outlook will render
// the same markup. Without this the preview collapses every paragraph
// flush against the next, which doesn't reflect the actual email.
// ---------------------------------------------------------------------------
function PreviewHtml({ html, sampleFirstName }) {
  const rendered = useMemo(() => {
    let h = html || "";
    h = h.replace(/\{\{\s*first_name\s*\}\}/g, sampleFirstName);
    // {{file:*}} placeholders → fake share URL so the styled button renders.
    h = h.replace(/\{\{\s*file:([^}]+)\s*\}\}/g, (_, slug) => `#preview-${slug}`);
    return h;
  }, [html, sampleFirstName]);
  // eslint-disable-next-line react/no-danger
  return (
    <div
      className="email-preview-body text-stone-900"
      // Inline styles so we don't fight Tailwind's preflight on `<p>`.
      style={{ fontFamily: "Helvetica, Arial, sans-serif", lineHeight: 1.55, fontSize: 15 }}
    >
      <style>{`
        .email-preview-body p { margin: 0 0 14px 0; min-height: 1em; }
        .email-preview-body p:last-child { margin-bottom: 0; }
        .email-preview-body h1 { font-size: 22px; font-weight: 700; margin: 18px 0 10px 0; }
        .email-preview-body h2 { font-size: 18px; font-weight: 700; margin: 16px 0 8px 0; }
        .email-preview-body h3 { font-size: 16px; font-weight: 600; margin: 14px 0 6px 0; }
        .email-preview-body ul, .email-preview-body ol { margin: 0 0 14px 22px; }
        .email-preview-body li { margin: 4px 0; }
        .email-preview-body a { color: #1a1a1a; text-decoration: underline; }
      `}</style>
      <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(rendered) }} />
    </div>
  );
}


// ---------------------------------------------------------------------------
// FilePickerModal — Search + Browse the entire R2 index (admin scope).
// Search mode: /api/files/search?q=
// Browse mode: /api/files/tree?prefix=  with breadcrumb navigation, so admins
// can drill into private folders like admin/franchise-sales-pdf/ that get
// buried in search results.
// ---------------------------------------------------------------------------
function FilePickerModal({ onClose, onPick }) {
  const [tab, setTab] = useState("browse"); // "browse" | "search"
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState("");

  // Browse state
  const [prefix, setPrefix] = useState(""); // current folder prefix
  const [tree, setTree] = useState({ folders: [], files: [] });
  const [browsing, setBrowsing] = useState(false);

  // Debounced search
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

  // Load tree for current prefix
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

  // Breadcrumbs derived from current prefix
  const crumbs = useMemo(() => {
    if (!prefix) return [];
    const parts = prefix.replace(/\/$/, "").split("/");
    return parts.map((seg, i) => ({
      name: seg,
      prefix: parts.slice(0, i + 1).join("/") + "/",
    }));
  }, [prefix]);

  // Icon for a top-level folder name (only at root)
  const rootIcon = (name) => {
    if (name === "admin") return <Lock className="w-4 h-4 text-orange-500 shrink-0" />;
    if (name === "shared") return <Globe className="w-4 h-4 text-emerald-600 shrink-0" />;
    if (name === "franchisees") return <Users className="w-4 h-4 text-stone-600 shrink-0" />;
    return <Folder className="w-4 h-4 text-stone-400 shrink-0" />;
  };

  return (
    <div onClick={onClose} className="fixed inset-0 z-[80] bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-6" data-testid="file-picker-modal">
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl max-w-2xl w-full max-h-[80vh] flex flex-col shadow-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
          <h3 className="font-bold text-stone-900 flex items-center gap-2"><Paperclip className="w-4 h-4" /> Pick a file from R2</h3>
          <button onClick={onClose} className="w-9 h-9 hover:bg-stone-100 rounded-lg flex items-center justify-center" data-testid="file-picker-close"><X className="w-4 h-4" /></button>
        </div>

        {/* Tabs */}
        <div className="px-5 pt-3 border-b border-stone-200 flex items-center gap-1">
          <button
            onClick={() => setTab("browse")}
            data-testid="file-picker-tab-browse"
            className={`px-3 py-1.5 text-xs font-semibold rounded-t-md border-b-2 transition-colors ${tab === "browse" ? "border-stone-900 text-stone-900" : "border-transparent text-stone-500 hover:text-stone-800"}`}>
            <FolderOpen className="w-3.5 h-3.5 inline mr-1.5" />Browse
          </button>
          <button
            onClick={() => setTab("search")}
            data-testid="file-picker-tab-search"
            className={`px-3 py-1.5 text-xs font-semibold rounded-t-md border-b-2 transition-colors ${tab === "search" ? "border-stone-900 text-stone-900" : "border-transparent text-stone-500 hover:text-stone-800"}`}>
            <Search className="w-3.5 h-3.5 inline mr-1.5" />Search
          </button>
        </div>

        {tab === "search" && (
          <div className="px-5 py-3 border-b border-stone-200">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus
                placeholder="Search files by name (try .pdf)…" data-testid="file-picker-search"
                className="w-full pl-9 pr-3 py-2 bg-stone-50 border border-stone-300 text-sm rounded-lg focus:outline-none focus:border-stone-900" />
            </div>
          </div>
        )}

        {tab === "browse" && (
          <div className="px-5 py-2.5 border-b border-stone-200 flex items-center gap-1.5 text-xs overflow-x-auto">
            <button
              onClick={() => setPrefix("")}
              data-testid="file-picker-crumb-root"
              className={`px-2 py-1 rounded flex items-center gap-1 shrink-0 ${prefix === "" ? "bg-stone-900 text-white" : "hover:bg-stone-100 text-stone-700"}`}>
              <Home className="w-3 h-3" /> Root
            </button>
            {crumbs.map((c, i) => (
              <div key={c.prefix} className="flex items-center gap-1 shrink-0">
                <ChevronRight className="w-3 h-3 text-stone-400" />
                <button
                  onClick={() => setPrefix(c.prefix)}
                  data-testid={`file-picker-crumb-${i}`}
                  className={`px-2 py-1 rounded ${i === crumbs.length - 1 ? "bg-stone-900 text-white" : "hover:bg-stone-100 text-stone-700"}`}>
                  {c.name}
                </button>
              </div>
            ))}
            {prefix && (
              <button
                onClick={() => {
                  const parts = prefix.replace(/\/$/, "").split("/");
                  parts.pop();
                  setPrefix(parts.length ? parts.join("/") + "/" : "");
                }}
                data-testid="file-picker-up"
                className="ml-auto px-2 py-1 rounded hover:bg-stone-100 text-stone-700 flex items-center gap-1 shrink-0">
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
              {!searching && !err && q.length >= 2 && results.length === 0 && (
                <div className="p-6 text-center text-stone-500 text-sm">No files match — try a different search or switch to Browse.</div>
              )}
              {!searching && !err && q.length < 2 && (
                <div className="p-6 text-center text-stone-500 text-sm">Type at least 2 characters to search.</div>
              )}
              <ul className="divide-y divide-stone-100">
                {results.map((f) => (
                  <li key={f.key}>
                    <button onClick={() => onPick(f)} data-testid={`file-pick-${f.key.replace(/[^a-z0-9]+/gi, "-")}`}
                      className="w-full text-left px-5 py-2.5 hover:bg-stone-50 flex items-center gap-3">
                      <FileText className="w-4 h-4 text-stone-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-stone-900 truncate">{f.name}</div>
                        <div className="text-[10px] text-stone-500 truncate font-mono">{f.key}</div>
                      </div>
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
              {!browsing && !err && tree.folders.length === 0 && tree.files.length === 0 && (
                <div className="p-6 text-center text-stone-500 text-sm">This folder is empty.</div>
              )}
              <ul className="divide-y divide-stone-100">
                {tree.folders.map((d) => (
                  <li key={d.key}>
                    <button
                      onClick={() => setPrefix(d.key)}
                      data-testid={`file-picker-folder-${d.name.replace(/[^a-z0-9]+/gi, "-")}`}
                      className="w-full text-left px-5 py-2.5 hover:bg-stone-50 flex items-center gap-3">
                      {prefix === "" ? rootIcon(d.name) : <Folder className="w-4 h-4 text-stone-400 shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-stone-900 truncate font-medium">{d.name}</div>
                        <div className="text-[10px] text-stone-500 truncate">{d.files} file{d.files === 1 ? "" : "s"}</div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-stone-400 shrink-0" />
                    </button>
                  </li>
                ))}
                {tree.files.map((f) => (
                  <li key={f.key}>
                    <button onClick={() => onPick(f)} data-testid={`file-pick-${f.key.replace(/[^a-z0-9]+/gi, "-")}`}
                      className="w-full text-left px-5 py-2.5 hover:bg-stone-50 flex items-center gap-3">
                      <FileText className="w-4 h-4 text-stone-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-stone-900 truncate">{f.name}</div>
                        <div className="text-[10px] text-stone-500 truncate font-mono">{f.key}</div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-stone-400 shrink-0" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="px-5 py-3 border-t border-stone-200 bg-stone-50 text-[11px] text-stone-500">
          Picked file's R2 key + name will be stored on the template. A fresh signed URL is minted at send time.
        </div>
      </div>
    </div>
  );
}
