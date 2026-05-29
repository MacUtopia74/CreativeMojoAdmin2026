// AnnouncementsPage — `/admin/announcements`. Composer + history for
// branded "Updates" e-shots sent to franchisees via Resend.
//
// Layout (after rebuild):
//   • LIST view (default) — table of past announcements, newest first.
//   • COMPOSE modal — two-pane layout: left = editor (title, intro,
//     selected panels with edit fields), right = LIVE email preview
//     rendered server-side by /admin/announcements/preview-html.
//   • PICKER modal — visual thumbnail grid for choosing a file OR
//     folder, with a Recently-added quick-tile section and a search box.
import { useEffect, useState, useMemo, useCallback } from "react";
import {
  Megaphone, Send, Loader2, AlertCircle, Plus, Trash2, X, CheckCircle2,
  Search, FileText, Folder, RefreshCw, Calendar, Image as ImageIcon, Eye,
} from "lucide-react";
import api from "@/lib/api";
import FileThumbnail from "@/components/files/FileThumbnail";

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return "—"; }
}

// =====================================================================
// LIST view
// =====================================================================
function AnnouncementsList({ onCompose, onView, refresh }) {
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/admin/announcements");
      setData(data);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [refresh, load]);

  return (
    <div className="px-8 py-6">
      <div className="flex items-end justify-between mb-6 gap-4 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-1.5">
            <Megaphone className="w-3 h-3" /> Updates & Announcements
          </div>
          <h1 className="font-display text-4xl font-black text-stone-950 mt-1">Updates</h1>
          <p className="text-sm text-stone-600 mt-1 max-w-2xl">
            Send a branded "What's New" e-shot to franchisees. Each one is archived to
            <code className="px-1 py-0.5 bg-stone-100 rounded mx-1">/portal/updates</code>
            so they can refer back any time.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} data-testid="announcements-refresh"
            className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-lg flex items-center gap-1.5">
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
          <button onClick={onCompose} data-testid="announcements-compose-btn"
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-[#dddd16] hover:bg-stone-800 rounded-lg flex items-center gap-1.5">
            <Send className="w-3.5 h-3.5" /> Send Update
          </button>
        </div>
      </div>

      <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 border-b border-stone-200">
            <tr className="text-left text-[10px] uppercase tracking-wider text-stone-500">
              <th className="px-4 py-2 font-bold">Title</th>
              <th className="px-3 py-2 font-bold">Sent</th>
              <th className="px-3 py-2 font-bold">Panels</th>
              <th className="px-3 py-2 font-bold">Recipients</th>
              <th className="px-3 py-2 font-bold">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && data.items.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-stone-500"><Loader2 className="w-4 h-4 animate-spin inline" /> Loading…</td></tr>
            ) : data.items.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-12 text-center text-stone-500 text-xs">No announcements yet. Click <strong>Send Update</strong> to send your first.</td></tr>
            ) : data.items.map((it) => {
              const s = it.delivery?.status || "unknown";
              const colour = s === "sent" ? "bg-emerald-50 text-emerald-900 border-emerald-200"
                : s === "partial" ? "bg-amber-50 text-amber-900 border-amber-200"
                : "bg-rose-50 text-rose-900 border-rose-200";
              return (
                <tr key={it.id} className="border-t border-stone-100 hover:bg-stone-50/50 cursor-pointer" onClick={() => onView(it)} data-testid={`announcement-row-${it.id}`}>
                  <td className="px-4 py-3 font-medium text-stone-950">{it.title}</td>
                  <td className="px-3 py-3 text-stone-700 whitespace-nowrap">{fmtDate(it.sent_at || it.created_at)}</td>
                  <td className="px-3 py-3 text-stone-700">{(it.panels || []).length}</td>
                  <td className="px-3 py-3 text-stone-700">{it.recipient_count}</td>
                  <td className="px-3 py-3"><span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border rounded ${colour}`}>{s}</span></td>
                  <td className="px-3 py-3 text-right">
                    <button onClick={(e) => { e.stopPropagation(); if (window.confirm("Remove from /portal/updates? The original email already sent cannot be unsent.")) { api.delete(`/admin/announcements/${it.id}`).then(load); } }}
                      title="Delete from archive" data-testid={`announcement-delete-${it.id}`} className="text-stone-400 hover:text-rose-600">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// =====================================================================
// PICKER modal (visual thumbnail grid for file or folder)
// =====================================================================
function PickerModal({ open, kind, onPick, onClose }) {
  const [q, setQ] = useState("");
  const [recents, setRecents] = useState([]);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQ(""); setResults([]);
    (async () => {
      try {
        if (kind === "file" || kind === "thumb") {
          // Thumb mode reuses recent-files but the UI badges/labels it as
          // a thumbnail pick. We rely on FileThumbnail to render a preview
          // so non-thumbnailable files just look like a paper icon — fine.
          const { data } = await api.get("/admin/announcements/recent-files?limit=24");
          setRecents(data.items || []);
        } else {
          const { data } = await api.get("/admin/announcements/recent-folders?limit=24");
          setRecents(data.items || []);
        }
      } catch { setRecents([]); }
    })();
  }, [open, kind]);

  // Debounced search
  useEffect(() => {
    if (!open) return;
    if (!q || q.length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const { data } = await api.get("/files/search", { params: { q, limit: 40 } });
        const list = kind === "folder"
          ? (data.folders || [])
          : (data.files || []);
        setResults(list);
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [q, open, kind]);

  if (!open) return null;

  const showList = q.length >= 2 ? results : recents;
  const isFolderPicker = kind === "folder";
  const kindLabel = kind === "thumb" ? "thumbnail" : kind;
  const sectionLabel = q.length >= 2
    ? (loading ? "Searching…" : `${results.length} match${results.length === 1 ? "" : "es"}`)
    : (isFolderPicker ? "Recently added folders" : (kind === "thumb" ? "Recently added images" : "Recently added files"));

  return (
    <div className="fixed inset-0 z-[60] bg-stone-950/50 backdrop-blur-sm flex items-start justify-center px-4 py-8 overflow-y-auto"
      onClick={onClose} data-testid="picker-modal">
      <div className="bg-white w-full max-w-4xl rounded-2xl border border-stone-200 shadow-2xl my-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-5 border-b border-stone-200 flex items-start justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-1.5">
              {isFolderPicker ? <Folder className="w-3 h-3" /> : (kind === "thumb" ? <ImageIcon className="w-3 h-3" /> : <FileText className="w-3 h-3" />)}
              Pick a {kindLabel}
            </div>
            <h2 className="font-display text-xl font-black text-stone-950 mt-1">
              {kind === "thumb" ? "Choose a file as the panel thumbnail" : (isFolderPicker ? "Choose a folder to share" : "Choose a file to share")}
            </h2>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-full border border-stone-300 hover:bg-stone-50 flex items-center justify-center"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-6 py-4 border-b border-stone-100">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-stone-400" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${kindLabel}s by name…`}
              data-testid="picker-search"
              className="w-full pl-10 pr-9 py-2.5 text-sm bg-stone-50 border border-stone-200 rounded-lg focus:outline-none focus:border-stone-400 focus:bg-white" />
          </div>
        </div>

        <div className="px-6 py-4">
          <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mb-3">{sectionLabel}</div>

          {showList.length === 0 ? (
            <div className="px-6 py-12 text-center text-stone-500 text-xs">
              {q.length >= 2 ? "No results — try a different search." : "Nothing yet."}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 max-h-[55vh] overflow-y-auto">
              {showList.map((it) => {
                const key = isFolderPicker ? it.prefix : it.key;
                return (
                  <button key={key} onClick={() => onPick(it)}
                    data-testid={`picker-tile-${key}`}
                    className="group text-left bg-white border border-stone-200 rounded-xl overflow-hidden hover:border-stone-400 hover:shadow-md transition-all">
                    <div className="aspect-square bg-stone-50 flex items-center justify-center">
                      {isFolderPicker ? (
                        <div className="flex flex-col items-center gap-2">
                          <Folder className="w-10 h-10 text-[#dddd16]" />
                          {it.file_count != null && <div className="text-[10px] text-stone-500">{it.file_count} files</div>}
                        </div>
                      ) : (
                        <FileThumbnail file={it} className="w-full h-full object-cover" />
                      )}
                    </div>
                    <div className="px-2.5 py-2 border-t border-stone-100">
                      <div className="text-xs font-medium text-stone-900 truncate">{it.name || it.prefix?.split("/").filter(Boolean).pop()}</div>
                      <div className="text-[10px] text-stone-500 truncate font-mono mt-0.5">{key}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// COMPOSE modal — two-pane (editor | live preview)
// =====================================================================
function ComposeModal({ open, onClose, onSent }) {
  const [title, setTitle] = useState("");
  const [intro, setIntro] = useState("");
  const [panels, setPanels] = useState([]);
  const [recipients, setRecipients] = useState([]);
  const [recipientFilter, setRecipientFilter] = useState("all");
  const [selectedRecipients, setSelectedRecipients] = useState(new Set());

  const [picker, setPicker] = useState(null); // { kind, panelIdx | null }
  const [testTo, setTestTo] = useState("");
  const [sending, setSending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const [previewHtml, setPreviewHtml] = useState("");

  // Reset on open
  useEffect(() => {
    if (!open) return;
    setTitle(""); setIntro(""); setPanels([]); setSelectedRecipients(new Set());
    setError(""); setInfo(""); setRecipientFilter("all"); setPreviewHtml("");
    api.get("/admin/announcements/recipients").then(({ data }) => setRecipients(data.items || []));
    // Default test recipient is the current admin (no fetch needed; use Resend FROM safely)
    setTestTo("");
  }, [open]);

  // Live preview — re-render whenever title/intro/panels change (debounced)
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      try {
        const { data } = await api.post("/admin/announcements/preview-html", {
          title, intro,
          panels: panels.map((p) => ({ ...p })),
          sample_first_name: "Sandra",
        });
        setPreviewHtml(data.html || "");
      } catch (e) { /* swallow — preview is best-effort */ }
    }, 300);
    return () => clearTimeout(t);
  }, [open, title, intro, panels]);

  // ---- panel operations ----
  const addPanel = (kind, ref) => {
    setPanels((p) => [...p, {
      kind,
      key: kind === "file" ? ref?.key : undefined,
      prefix: kind === "folder" ? ref?.prefix : undefined,
      title: ref?.name || ref?.prefix || "",
      blurb: "",
      thumbnail_url: "",
    }]);
  };
  const updatePanel = (idx, patch) => setPanels((arr) => arr.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  const removePanel = (idx) => setPanels((arr) => arr.filter((_, i) => i !== idx));
  const handlePick = (item) => {
    if (!picker) return;
    if (picker.kind === "thumb") {
      // Picker is being used to select a thumbnail file for an existing panel.
      updatePanel(picker.panelIdx, { thumbnail_key: item.key, thumbnail_url: "" });
    } else if (picker.panelIdx == null) {
      addPanel(picker.kind, item);
    } else {
      updatePanel(picker.panelIdx, picker.kind === "file"
        ? { kind: "file", key: item.key, prefix: undefined, title: item.name }
        : { kind: "folder", prefix: item.prefix, key: undefined, title: item.name });
    }
    setPicker(null);
  };

  // ---- send + test ----
  const buildBody = () => ({
    title: title.trim(),
    intro: intro.trim(),
    panels: panels.map((p) => ({
      kind: p.kind,
      key: p.key || undefined,
      prefix: p.prefix || undefined,
      title: p.title,
      blurb: p.blurb,
      thumbnail_url: p.thumbnail_url || undefined,
      thumbnail_key: p.thumbnail_key || undefined,
    })),
    recipient_ids: recipientFilter === "subset" ? Array.from(selectedRecipients) : null,
  });

  const send = async () => {
    setSending(true); setError(""); setInfo("");
    try {
      const { data } = await api.post("/admin/announcements", buildBody());
      setInfo(data.status === "sent"
        ? `Sent to ${data.succeeded} franchisee(s).`
        : `${data.succeeded} sent · ${data.failed} failed.`);
      onSent?.();
    } catch (e) {
      setError(e?.response?.data?.detail || "Send failed.");
    } finally { setSending(false); }
  };

  const sendTest = async () => {
    setTesting(true); setError(""); setInfo("");
    try {
      const body = buildBody();
      if (testTo.trim()) body.to = testTo.trim();
      const { data } = await api.post("/admin/announcements/test-send", body);
      setInfo(`Test email sent to ${data.to}.`);
    } catch (e) {
      setError(e?.response?.data?.detail || "Test send failed.");
    } finally { setTesting(false); }
  };

  const canSend = title.trim().length > 0 && panels.length > 0 && !sending
    && (recipientFilter === "all" || selectedRecipients.size > 0);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-stone-950/40 backdrop-blur-sm flex items-stretch justify-center p-4 overflow-y-auto" onClick={onClose} data-testid="announcement-modal">
      <div className="bg-white w-full max-w-6xl rounded-2xl border border-stone-200 shadow-2xl my-auto flex flex-col max-h-[95vh]" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-stone-200 flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-1.5"><Megaphone className="w-3 h-3" /> Send Update</div>
            <h2 className="font-display text-2xl font-black text-stone-950 mt-1">Compose Announcement</h2>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-full border border-stone-300 hover:bg-stone-50 flex items-center justify-center" data-testid="announcement-modal-close"><X className="w-4 h-4" /></button>
        </div>

        {/* Body — two columns */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 overflow-y-auto">
          {/* LEFT: editor */}
          <div className="p-5 overflow-y-auto border-r border-stone-200">
            {error && <div className="px-3 py-2 mb-3 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-900 flex items-center gap-2"><AlertCircle className="w-4 h-4" /> {error}</div>}
            {info && <div className="px-3 py-2 mb-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-900 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> {info}</div>}

            <label className="block mb-3">
              <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mb-1">Title (subject line)</div>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="2 NEW Projects for June 2026"
                data-testid="announcement-title"
                className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg" />
            </label>
            <label className="block mb-4">
              <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mb-1">Intro text</div>
              <textarea rows={3} value={intro} onChange={(e) => setIntro(e.target.value)}
                placeholder="Here are two new projects for June 2026 with File Camp links."
                data-testid="announcement-intro"
                className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg" />
            </label>

            {/* Panels */}
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500">Project panels ({panels.length})</div>
                <div className="flex items-center gap-1">
                  <button onClick={() => setPicker({ kind: "file", panelIdx: null })} data-testid="add-file-panel"
                    className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-md flex items-center gap-1"><Plus className="w-3 h-3" /> File</button>
                  <button onClick={() => setPicker({ kind: "folder", panelIdx: null })} data-testid="add-folder-panel"
                    className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-md flex items-center gap-1"><Plus className="w-3 h-3" /> Folder</button>
                </div>
              </div>

              {panels.length === 0 ? (
                <div className="px-4 py-8 text-center border-2 border-dashed border-stone-200 rounded-lg text-stone-500 text-xs">
                  Add at least one File or Folder panel above.
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    {panels.map((p, idx) => (
                      <div key={idx} className="border border-stone-200 rounded-lg p-3" data-testid={`panel-${idx}`}>
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div className="flex items-center gap-1.5 text-xs text-stone-600 min-w-0">
                            {p.kind === "file" ? <FileText className="w-3.5 h-3.5 shrink-0" /> : <Folder className="w-3.5 h-3.5 shrink-0" />}
                            <span className="font-mono truncate">{p.key || p.prefix || "(no target)"}</span>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button onClick={() => setPicker({ kind: p.kind, panelIdx: idx })}
                              className="text-stone-500 hover:text-stone-900 text-[10px] uppercase font-bold tracking-wider">Change</button>
                            <button onClick={() => removePanel(idx)} className="text-stone-400 hover:text-rose-600"><Trash2 className="w-3.5 h-3.5" /></button>
                          </div>
                        </div>
                        <label className="block mb-1">
                          <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mb-1">Panel title</div>
                          <input value={p.title} onChange={(e) => updatePanel(idx, { title: e.target.value })}
                            className="w-full px-2 py-1.5 text-sm bg-white border border-stone-300 rounded" />
                        </label>
                        <label className="block mb-2">
                          <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mb-1">Blurb</div>
                          <textarea rows={2} value={p.blurb} onChange={(e) => updatePanel(idx, { blurb: e.target.value })}
                            className="w-full px-2 py-1.5 text-sm bg-white border border-stone-300 rounded" />
                        </label>
                        {/* Thumbnail picker — required for folder panels, optional override for file panels. */}
                        <div className="flex items-center justify-between gap-2 pt-1 border-t border-stone-100">
                          <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 flex items-center gap-1.5 min-w-0">
                            <ImageIcon className="w-3 h-3 shrink-0" />
                            <span>Thumbnail</span>
                            {p.thumbnail_key ? (
                              <span className="font-mono normal-case text-stone-400 truncate">· {p.thumbnail_key.split("/").pop()}</span>
                            ) : p.kind === "file" ? (
                              <span className="normal-case text-stone-400">· auto</span>
                            ) : (
                              <span className="normal-case text-stone-400">· none picked</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button onClick={() => setPicker({ kind: "thumb", panelIdx: idx })}
                              data-testid={`panel-${idx}-pick-thumb`}
                              className="px-2 py-0.5 text-[10px] uppercase font-bold tracking-wider text-stone-700 border border-stone-300 hover:bg-stone-50 rounded">
                              {p.thumbnail_key ? "Change" : "Pick"}
                            </button>
                            {p.thumbnail_key && (
                              <button onClick={() => updatePanel(idx, { thumbnail_key: "" })} className="text-stone-400 hover:text-rose-600"><X className="w-3.5 h-3.5" /></button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* Add-another row: makes the multi-panel affordance obvious. */}
                  <div className="mt-3 flex items-center gap-2 justify-center py-2 border-t border-stone-200">
                    <span className="text-[10px] uppercase tracking-wider font-bold text-stone-400 mr-1">Add another</span>
                    <button onClick={() => setPicker({ kind: "file", panelIdx: null })} data-testid="add-another-file"
                      className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-full flex items-center gap-1"><Plus className="w-3 h-3" /> File</button>
                    <button onClick={() => setPicker({ kind: "folder", panelIdx: null })} data-testid="add-another-folder"
                      className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-full flex items-center gap-1"><Plus className="w-3 h-3" /> Folder</button>
                  </div>
                </>
              )}
            </div>

            {/* Recipients */}
            <div className="mb-2">
              <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mb-2">Recipients</div>
              <div className="flex items-center gap-3 mb-2 text-sm">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={recipientFilter === "all"} onChange={() => setRecipientFilter("all")} data-testid="recipients-all" />
                  All active ({recipients.length})
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={recipientFilter === "subset"} onChange={() => setRecipientFilter("subset")} data-testid="recipients-subset" />
                  Pick recipients
                </label>
              </div>
              {recipientFilter === "subset" && (
                <div className="border border-stone-200 rounded-lg max-h-40 overflow-y-auto p-2 grid grid-cols-2 gap-1">
                  {recipients.map((r) => (
                    <label key={r.id} className="flex items-center gap-2 px-2 py-1 hover:bg-stone-50 text-xs cursor-pointer">
                      <input type="checkbox" checked={selectedRecipients.has(r.id)}
                        onChange={(e) => setSelectedRecipients((s) => { const n = new Set(s); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />
                      <span className="truncate">{r.organisation} · {r.first_name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* RIGHT: live preview */}
          <div className="bg-stone-100 overflow-y-auto" data-testid="email-preview">
            <div className="px-4 py-2 sticky top-0 bg-stone-100 border-b border-stone-200 flex items-center justify-between gap-2 z-10">
              <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 flex items-center gap-1.5"><Eye className="w-3 h-3" /> Live preview</div>
              <div className="text-[10px] text-stone-500">Rendered as recipients will see it</div>
            </div>
            <div className="p-3">
              {previewHtml ? (
                <iframe
                  title="email-preview"
                  className="w-full bg-white border border-stone-200 rounded shadow-sm"
                  style={{ minHeight: 720 }}
                  srcDoc={previewHtml}
                />
              ) : (
                <div className="flex items-center justify-center min-h-[400px] text-stone-400 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin mr-2" /> Building preview…
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-stone-200 bg-stone-50 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-1 min-w-[280px]">
            <input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)}
              placeholder="Send a test to (defaults to your admin email)…"
              data-testid="announcement-test-to"
              className="flex-1 px-3 py-1.5 text-sm bg-white border border-stone-300 rounded-lg" />
            <button onClick={sendTest} disabled={testing || panels.length === 0 || !title.trim()}
              data-testid="announcement-send-test"
              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-white border border-stone-300 text-stone-900 hover:bg-stone-100 rounded-lg flex items-center gap-1.5 disabled:opacity-50">
              {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
              Send test
            </button>
          </div>
          <button onClick={send} disabled={!canSend}
            data-testid="announcement-send"
            className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-[#dddd16] hover:bg-stone-800 rounded-lg flex items-center gap-1.5 disabled:bg-stone-300 disabled:text-stone-500">
            {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
            {sending ? "Sending…" : "Send to franchisees"}
          </button>
        </div>
      </div>

      <PickerModal open={!!picker} kind={picker?.kind} onPick={handlePick} onClose={() => setPicker(null)} />
    </div>
  );
}

// =====================================================================
// VIEW modal
// =====================================================================
function ViewModal({ ann, onClose }) {
  if (!ann) return null;
  return (
    <div className="fixed inset-0 z-50 bg-stone-950/40 backdrop-blur-sm flex items-start justify-center px-4 py-8 overflow-y-auto" onClick={onClose}>
      <div className="bg-white w-full max-w-3xl rounded-2xl border border-stone-200 my-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-5 border-b border-stone-200 flex items-start justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Update</div>
            <h2 className="font-display text-2xl font-black text-stone-950">{ann.title}</h2>
            <div className="text-xs text-stone-500 mt-1 flex items-center gap-3"><Calendar className="w-3 h-3" /> {fmtDate(ann.sent_at || ann.created_at)} · {ann.recipient_count} recipients · {ann.delivery?.status}</div>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-full border border-stone-300 hover:bg-stone-50 flex items-center justify-center"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-6 py-4">
          {ann.intro && <p className="text-sm text-stone-700 whitespace-pre-line mb-4">{ann.intro}</p>}
          {(ann.panels || []).map((p, i) => (
            <div key={i} className="grid grid-cols-[160px_1fr] gap-4 mb-4 border-t border-stone-100 pt-3 first:border-t-0 first:pt-0">
              <div>{p.thumbnail_url
                ? <img src={p.thumbnail_url} alt={p.title} className="w-full rounded-lg border border-stone-200" />
                : <div className="w-full aspect-video bg-stone-100 rounded-lg flex items-center justify-center text-stone-400"><ImageIcon className="w-6 h-6" /></div>}</div>
              <div>
                <div className="font-display text-xl font-bold text-stone-950">{p.title}</div>
                <p className="text-sm text-stone-700 whitespace-pre-line mt-1">{p.blurb}</p>
                <a href={p.resolved_url} target="_blank" rel="noopener noreferrer" className="inline-block mt-2 px-3 py-1.5 bg-[#dddd16] text-stone-950 font-bold text-xs uppercase tracking-wider rounded-md">Open {p.kind} →</a>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// ROOT
// =====================================================================
export default function AnnouncementsPage() {
  const [composeOpen, setComposeOpen] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <>
      <AnnouncementsList onCompose={() => setComposeOpen(true)} onView={setViewing} refresh={refreshKey} />
      <ComposeModal open={composeOpen} onClose={() => setComposeOpen(false)} onSent={() => setRefreshKey((k) => k + 1)} />
      <ViewModal ann={viewing} onClose={() => setViewing(null)} />
    </>
  );
}
