// AnnouncementsPage — `/admin/announcements`. Composer + history for
// "HQ Updates" published to the franchisee portal feed at
// `/portal/updates`. Recipients see an unread badge on their HQ
// Updates menu item — no email is sent.
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
  Search, FileText, Folder, RefreshCw, Calendar, Image as ImageIcon, Eye, Upload,
  PinOff, Briefcase, Users as UsersIcon, Sparkles, Link as LinkIcon, Youtube, Pencil,
} from "lucide-react";
import api from "@/lib/api";
import FileThumbnail from "@/components/files/FileThumbnail";
import MarketingIntroEditor from "@/components/portal/marketing/MarketingIntroEditor";

// ---------------------------------------------------------------------------
// HQ Updates support 3 categories. The portal groups updates under
// matching section headings. Keeping the registry inline so styling
// stays consistent across admin (list pill, composer radio) and portal.
// ---------------------------------------------------------------------------
export const ANNOUNCEMENT_CATEGORIES = [
  { id: "project",  label: "Project",  icon: Briefcase, tone: "bg-sky-100 text-sky-900 border-sky-300" },
  { id: "meetings", label: "Meetings", icon: UsersIcon, tone: "bg-violet-100 text-violet-900 border-violet-300" },
  { id: "general",  label: "General",  icon: Sparkles,  tone: "bg-stone-100 text-stone-900 border-stone-300" },
];
const CATEGORY_BY_ID = Object.fromEntries(ANNOUNCEMENT_CATEGORIES.map((c) => [c.id, c]));
function CategoryPill({ id }) {
  const c = CATEGORY_BY_ID[id || "general"] || CATEGORY_BY_ID.general;
  const Icon = c.icon;
  return (
    <span
      data-testid={`category-pill-${id || "general"}`}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider border rounded ${c.tone}`}
    >
      <Icon className="w-2.5 h-2.5" />
      {c.label}
    </span>
  );
}

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return "—"; }
}

function fmtBytes(b) {
  if (b == null) return null;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

// =====================================================================
// LIST view
// =====================================================================
function AnnouncementsList({ onCompose, onView, refresh }) {
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  // Drafts (auto-created e.g. by the Calendar "Mojo Grow Meeting" button)
  // live behind a tab so they don't clutter the sent list but are easy
  // to find when reviewing before broadcast.
  const [tab, setTab] = useState("sent");
  const [drafts, setDrafts] = useState({ items: [], total: 0 });
  const [draftsLoading, setDraftsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/admin/announcements");
      setData(data);
    } finally { setLoading(false); }
  }, []);
  const loadDrafts = useCallback(async () => {
    setDraftsLoading(true);
    try {
      const { data } = await api.get("/admin/announcements", { params: { status: "draft" } });
      setDrafts(data);
    } finally { setDraftsLoading(false); }
  }, []);
  useEffect(() => { load(); loadDrafts(); }, [refresh, load, loadDrafts]);

  return (
    <div className="px-8 py-6">
      <div className="flex items-end justify-between mb-6 gap-4 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-1.5">
            <Megaphone className="w-3 h-3" /> HQ Updates
          </div>
          <h1 className="font-display text-4xl font-black text-stone-950 mt-1">HQ Updates</h1>
          <p className="text-sm text-stone-600 mt-1 max-w-2xl">
            Publish updates to franchisees&rsquo;
            <code className="px-1 py-0.5 bg-stone-100 rounded mx-1">/portal/updates</code>
            page. Recipients see an unread badge on their HQ Updates menu — no email is sent.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} data-testid="announcements-refresh"
            className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-lg flex items-center gap-1.5">
            <RefreshCw className="w-3 h-3" /> Refresh
          </button>
          <button onClick={onCompose} data-testid="announcements-compose-btn"
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-[#dddd16] hover:bg-stone-800 rounded-lg flex items-center gap-1.5">
            <Send className="w-3.5 h-3.5" /> New Update
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-3" data-testid="announcement-tabs">
        <button
          onClick={() => setTab("sent")}
          data-testid="announcement-tab-sent"
          className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded-lg transition-colors ${tab === "sent" ? "bg-stone-950 text-white" : "bg-white text-stone-700 border border-stone-300 hover:bg-stone-50"}`}
        >
          Sent ({data.total ?? data.items.length})
        </button>
        <button
          onClick={() => setTab("drafts")}
          data-testid="announcement-tab-drafts"
          className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded-lg transition-colors inline-flex items-center gap-1.5 ${tab === "drafts" ? "bg-stone-950 text-white" : "bg-white text-stone-700 border border-stone-300 hover:bg-stone-50"}`}
        >
          Drafts ({drafts.total ?? drafts.items.length})
          {drafts.items.length > 0 && tab !== "drafts" && (
            <span className="w-2 h-2 rounded-full bg-amber-500" />
          )}
        </button>
      </div>

      {tab === "drafts" ? (
        <div className="bg-white border border-stone-200 rounded-xl overflow-hidden" data-testid="drafts-panel">
          {draftsLoading && drafts.items.length === 0 ? (
            <div className="px-4 py-12 text-center text-stone-500">
              <Loader2 className="w-4 h-4 animate-spin inline" /> Loading drafts…
            </div>
          ) : drafts.items.length === 0 ? (
            <div className="px-4 py-12 text-center text-stone-500 text-sm">
              No drafts. Drafts are auto-created when you set up a Mojo Grow Meeting from the Calendar.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-stone-50 border-b border-stone-200">
                <tr className="text-left text-[10px] uppercase tracking-wider text-stone-500">
                  <th className="px-4 py-2 font-bold">Title</th>
                  <th className="px-3 py-2 font-bold">Category</th>
                  <th className="px-3 py-2 font-bold">Created</th>
                  <th className="px-3 py-2 font-bold">Source</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {drafts.items.map((it) => (
                  <tr key={it.id} className="border-t border-stone-100 hover:bg-stone-50/50 cursor-pointer" onClick={() => onView(it)} data-testid={`draft-row-${it.id}`}>
                    <td className="px-4 py-3 font-medium text-stone-950">{it.title}</td>
                    <td className="px-3 py-3"><CategoryPill id={it.category} /></td>
                    <td className="px-3 py-3 text-stone-700 whitespace-nowrap">{fmtDate(it.created_at)}</td>
                    <td className="px-3 py-3 text-stone-500 text-[11px]">
                      {it.source === "mojo_grow_meeting" ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider bg-[#dddd16]/30 text-stone-800 border border-[#dddd16] rounded">
                          Mojo Grow
                        </span>
                      ) : "Manual"}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        onClick={(e) => { e.stopPropagation(); onView(it); }}
                        data-testid={`draft-review-${it.id}`}
                        className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md"
                      >
                        Review &amp; Send
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (

      <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 border-b border-stone-200">
            <tr className="text-left text-[10px] uppercase tracking-wider text-stone-500">
              <th className="px-4 py-2 font-bold">Title</th>
              <th className="px-3 py-2 font-bold">Category</th>
              <th className="px-3 py-2 font-bold">Sent</th>
              <th className="px-3 py-2 font-bold">Panels</th>
              <th className="px-3 py-2 font-bold">Recipients</th>
              <th className="px-3 py-2 font-bold">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && data.items.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-stone-500"><Loader2 className="w-4 h-4 animate-spin inline" /> Loading…</td></tr>
            ) : data.items.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-12 text-center text-stone-500 text-xs">No updates yet. Click <strong>New Update</strong> to publish your first.</td></tr>
            ) : data.items.map((it) => {
              const s = it.delivery?.status || "unknown";
              const colour = s === "sent" ? "bg-emerald-50 text-emerald-900 border-emerald-200"
                : s === "partial" ? "bg-amber-50 text-amber-900 border-amber-200"
                : "bg-rose-50 text-rose-900 border-rose-200";
              return (
                <tr key={it.id} className="border-t border-stone-100 hover:bg-stone-50/50 cursor-pointer" onClick={() => onView(it)} data-testid={`announcement-row-${it.id}`}>
                  <td className="px-4 py-3 font-medium text-stone-950">
                    <div className="flex items-center gap-2">
                      {it.is_pinned && (
                        <span
                          data-testid={`announcement-pinned-badge-${it.id}`}
                          title={`Pinned until ${(it.pinned_until || "").slice(0, 10)}`}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider bg-amber-100 text-amber-900 border border-amber-300 rounded"
                        >
                          📌 Pinned
                        </span>
                      )}
                      <span>{it.title}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                    <select
                      value={it.category || "general"}
                      onChange={async (e) => {
                        const newCat = e.target.value;
                        try {
                          await api.post(`/admin/announcements/${it.id}/category`, { category: newCat });
                          load();
                        } catch { /* swallow */ }
                      }}
                      data-testid={`announcement-category-${it.id}`}
                      className="text-[10px] font-bold uppercase tracking-wider bg-white border border-stone-300 rounded px-1.5 py-0.5 cursor-pointer hover:border-stone-500">
                      {ANNOUNCEMENT_CATEGORIES.map((c) => (
                        <option key={c.id} value={c.id}>{c.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-3 text-stone-700 whitespace-nowrap">{fmtDate(it.sent_at || it.created_at)}</td>
                  <td className="px-3 py-3 text-stone-700">{(it.panels || []).length}</td>
                  <td className="px-3 py-3 text-stone-700">
                    {(() => {
                      const total = it.recipient_count ?? 0;
                      const latest = it.last_send_recipient_count;
                      const history = it.send_history || [];
                      const tooltip = history.length
                        ? history.map((h) => `${fmtDate(h.sent_at)} — ${h.recipient_count}`).join("\n")
                        : "";
                      return (
                        <span
                          data-testid={`announcement-recipients-${it.id}`}
                          title={tooltip || undefined}
                          className="inline-flex items-baseline gap-1 cursor-help">
                          <span className="font-bold text-stone-950 tabular-nums">{total}</span>
                          {latest != null && latest !== total && (
                            <span className="text-[10px] text-stone-500">
                              (latest {latest})
                            </span>
                          )}
                          {history.length > 1 && (
                            <span
                              data-testid={`announcement-sendcount-${it.id}`}
                              className="ml-1 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-stone-100 text-stone-600 border border-stone-200 rounded">
                              ×{history.length}
                            </span>
                          )}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-3 py-3"><span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border rounded ${colour}`}>{s}</span></td>
                  <td className="px-3 py-3 text-right">
                    <div className="inline-flex items-center gap-2">
                      {it.is_pinned && (
                        <button onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm("Unpin this update from the top of the portal?")) {
                            api.post(`/admin/announcements/${it.id}/unpin`).then(load);
                          }
                        }}
                          title="Unpin from top"
                          data-testid={`announcement-unpin-${it.id}`}
                          className="text-amber-600 hover:text-amber-800">
                          <PinOff className="w-4 h-4" />
                        </button>
                      )}
                      <button onClick={(e) => { e.stopPropagation(); if (window.confirm("Remove this update from the franchisee portal? Recipients will no longer see it.")) { api.delete(`/admin/announcements/${it.id}`).then(load); } }}
                        title="Delete from archive" data-testid={`announcement-delete-${it.id}`} className="text-stone-400 hover:text-rose-600">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
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
        // Use the same /files/recent endpoint that powers the main
        // Recently-added strip on /files. This gives us the actual
        // project folders (e.g. "Hello Summer", "Game Set and Match")
        // not just top-level shared/franchisees prefixes, plus inline
        // preview URLs for file thumbnails.
        const { data } = await api.get("/files/recent", { params: { days: 30, limit: 200 } });
        if (kind === "folder") {
          // Folder shape from /files/recent: { key, name, file_count, bytes, ... }
          // Normalise to { prefix, name, file_count, bytes } so the
          // downstream picker + onPick handler keeps working.
          setRecents((data.folders || []).map((f) => ({
            prefix: f.key,
            name: f.name,
            file_count: f.file_count,
            bytes: f.bytes,
          })));
        } else {
          // file + thumb modes both browse files.
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
                const subtitle = isFolderPicker
                  ? (it.file_count != null
                      ? `+${it.file_count} file${it.file_count === 1 ? "" : "s"}${it.bytes ? " · " + fmtBytes(it.bytes) : ""}`
                      : null)
                  : (it.size != null ? fmtBytes(it.size) : null);
                return (
                  <button key={key} onClick={() => onPick(it)}
                    data-testid={`picker-tile-${key}`}
                    className="group text-left bg-white border border-stone-200 rounded-xl overflow-hidden hover:border-stone-400 hover:shadow-md transition-all">
                    <div className={`aspect-[3/4] flex items-center justify-center ${isFolderPicker ? "bg-[#f6f6cd]" : "bg-stone-50"}`}>
                      {isFolderPicker ? (
                        <Folder className="w-14 h-14 text-emerald-700" strokeWidth={1.5} />
                      ) : (
                        <FileThumbnail file={it} className="w-full h-full object-cover" />
                      )}
                    </div>
                    <div className="px-2.5 py-2 border-t border-stone-100">
                      <div className="text-xs font-medium text-stone-900 truncate">{it.name || it.prefix?.split("/").filter(Boolean).pop()}</div>
                      {subtitle && <div className="text-[10px] text-stone-500 truncate mt-0.5">{subtitle}</div>}
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
function ComposeModal({ open, onClose, onSent, seed }) {
  const [title, setTitle] = useState("");
  const [intro, setIntro] = useState("");
  const [panels, setPanels] = useState([]);
  const [recipients, setRecipients] = useState([]);
  const [recipientFilter, setRecipientFilter] = useState("all");
  const [selectedRecipients, setSelectedRecipients] = useState(new Set());

  const [picker, setPicker] = useState(null); // { kind, panelIdx | null }
  const [testTo, setTestTo] = useState("");
  const [recipientSearch, setRecipientSearch] = useState("");
  const [sending, setSending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const [previewHtml, setPreviewHtml] = useState("");
  // Pin-to-top: a tick + date input on the composer. Defaults to a
  // 14-day window from today when the admin ticks the box, but they
  // can shorten/extend it (e.g. set it to the day of an upcoming Zoom).
  // Empty = not pinned. Once the date is past, the portal naturally
  // drops the announcement back into the chronological list.
  const [pinned, setPinned] = useState(false);
  const [pinnedUntil, setPinnedUntil] = useState("");
  // Category dropdown — defaults to "general". The franchisee portal
  // groups HQ Updates by this value so each section has its own
  // heading (Project / Meetings / General).
  const [category, setCategory] = useState("general");
  // Rich-text body — only used when category === "general". Lives
  // outside the panel grid so switching categories doesn't lose work
  // on either side. Sanitised on the server before storage.
  const [bodyHtml, setBodyHtml] = useState("");

  // Mode: 'new' (default), 'edit' (PATCH replaces the original), or
  // 'duplicate' (POST creates a fresh announcement).
  const mode = seed?.mode || "new";
  const seededAnn = seed?.ann || null;

  // Reset on open — seeded from the supplied announcement when in
  // edit/duplicate mode. Otherwise blank.
  useEffect(() => {
    if (!open) return;
    setError(""); setInfo(""); setPreviewHtml(""); setRecipientSearch("");
    setTestTo("");
    if (seededAnn) {
      setTitle(seededAnn.title || "");
      setIntro(seededAnn.intro || "");
      // Seed pin state from the original. The composer treats blank /
      // past dates as "not pinned" so re-editing a stale pin doesn't
      // accidentally resurrect it.
      const seededPin = (seededAnn.pinned_until || "").slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      if (seededPin && seededPin >= today) {
        setPinned(true); setPinnedUntil(seededPin);
      } else {
        setPinned(false); setPinnedUntil("");
      }
      // Seed category from the original (fallback to "general" so old
      // pre-categorised announcements still load cleanly).
      setCategory(seededAnn.category || "general");
      setBodyHtml(seededAnn.body_html || "");
      // Strip server-minted resolved_url + thumbnail_url so a fresh send
      // re-mints them (avoids re-using a revoked or stale share token).
      setPanels((seededAnn.panels || []).map((p) => ({
        kind: p.kind,
        key: p.key,
        prefix: p.prefix,
        title: p.title || "",
        blurb: p.blurb || "",
        thumbnail_key: p.thumbnail_key || "",
        thumbnail_url: "",
      })));
      // For edit, default to the original recipients; for duplicate,
      // default to All so the admin actively chooses.
      if (mode === "edit" && Array.isArray(seededAnn.sent_to) && seededAnn.sent_to.length) {
        setRecipientFilter("subset");
        setSelectedRecipients(new Set(seededAnn.sent_to));
      } else {
        setRecipientFilter("all");
        setSelectedRecipients(new Set());
      }
    } else {
      setTitle(""); setIntro(""); setPanels([]); setSelectedRecipients(new Set());
      setRecipientFilter("all");
      setPinned(false); setPinnedUntil("");
      setCategory("general");
      setBodyHtml("");
    }
    api.get("/admin/announcements/recipients").then(({ data }) => setRecipients(data.items || []));
  }, [open, seededAnn, mode]);

  // Live preview — re-render whenever title/intro/panels/body change (debounced)
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      try {
        const { data } = await api.post("/admin/announcements/preview-html", {
          title, intro,
          panels: panels.map((p) => ({ ...p })),
          body_html: bodyHtml,
          category,
          sample_first_name: "Sandra",
        });
        setPreviewHtml(data.html || "");
      } catch (e) { /* swallow — preview is best-effort */ }
    }, 300);
    return () => clearTimeout(t);
  }, [open, title, intro, panels, bodyHtml, category]);

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
  // Meetings panels carry an external URL (YouTube replay, Zoom recording
  // public link, etc.). Title/blurb/thumbnail are all optional.
  const addLinkPanel = () => {
    setPanels((p) => [...p, {
      kind: "link", url: "", title: "", blurb: "",
      thumbnail_url: "", thumbnail_key: "",
    }]);
  };
  const updatePanel = (idx, patch) => setPanels((arr) => arr.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  const removePanel = (idx) => setPanels((arr) => arr.filter((_, i) => i !== idx));

  // Upload an image file from the user's computer as the thumbnail for a panel.
  const uploadThumbForPanel = async (idx, fileObj) => {
    if (!fileObj) return;
    const fd = new FormData();
    fd.append("file", fileObj);
    try {
      const { data } = await api.post("/admin/announcements/upload-thumbnail", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      updatePanel(idx, { thumbnail_key: data.key, thumbnail_url: "" });
    } catch (e) {
      setError(e?.response?.data?.detail || "Thumbnail upload failed");
    }
  };
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
  const buildBody = (opts = {}) => ({
    // Browser-truth origin so the backend can mint share links that
    // point back at THIS host. Without this, links default to the
    // backend's FRONTEND_URL env var which can drift between preview
    // and production deployments.
    frontend_origin: typeof window !== "undefined" ? window.location.origin : "",
    title: title.trim(),
    intro: intro.trim(),
    panels: panels.map((p) => ({
      kind: p.kind,
      key: p.key || undefined,
      prefix: p.prefix || undefined,
      url: p.url || undefined,
      title: p.title,
      blurb: p.blurb,
      thumbnail_url: p.thumbnail_url || undefined,
      thumbnail_key: p.thumbnail_key || undefined,
    })),
    body_html: bodyHtml || "",
    recipient_ids: recipientFilter === "subset" ? Array.from(selectedRecipients) : null,
    // Pin metadata — admin sets the date via the composer; backend
    // treats `pinned: true` without an explicit `pinned_until` as a
    // 14-day default.
    pinned: pinned,
    pinned_until: pinned ? (pinnedUntil || null) : null,
    category: category,
    // Explicit acknowledgement that we mean to broadcast to everyone.
    // Backend rejects "send to all" without this flag — guardrail against
    // accidental fan-outs from curl tests or stale UI state.
    confirm_send_all: opts.confirm_send_all === true,
  });

  const send = async () => {
    // Guardrail: explicit confirm when sending to ALL active franchisees.
    // Stops the muscle-memory "title → send" muscle-memory from blasting
    // every franchisee by accident.
    let confirm_send_all = false;
    if (recipientFilter !== "subset") {
      const ok = window.confirm(
        `You are about to send "${title.trim() || "(no subject)"}" to ALL ${recipients.length} active franchisees.\n\n` +
        "Click OK to confirm, or Cancel to go back and pick a subset."
      );
      if (!ok) return;
      confirm_send_all = true;
    }
    setSending(true); setError(""); setInfo("");
    try {
      const body = buildBody({ confirm_send_all });
      if (mode === "edit" && seededAnn?.id) {
        const { data } = await api.put(`/admin/announcements/${seededAnn.id}`, body);
        setInfo(data.status === "sent"
          ? `Resent to ${data.succeeded} franchisee(s).`
          : `${data.succeeded} sent · ${data.failed} failed.`);
      } else {
        const { data } = await api.post("/admin/announcements", body);
        setInfo(data.status === "sent"
          ? `Sent to ${data.succeeded} franchisee(s).`
          : `${data.succeeded} sent · ${data.failed} failed.`);
      }
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
      <div className="bg-white w-full max-w-[1400px] rounded-2xl border border-stone-200 shadow-2xl my-auto flex flex-col max-h-[95vh]" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-stone-200 flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-1.5"><Megaphone className="w-3 h-3" /> {mode === "edit" ? "Edit Update" : mode === "duplicate" ? "Duplicate Update" : "New Update"}</div>
            <h2 className="font-display text-2xl font-black text-stone-950 mt-1">{mode === "edit" ? "Edit & Republish" : mode === "duplicate" ? "Duplicate Update" : "New HQ Update"}</h2>
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

            {/* Category — controls which section the update is filed
                under on the franchisee portal page. Each portal section
                renders with its own heading (Project / Meetings /
                General). */}
            <div className="mb-4">
              <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mb-1.5">Category</div>
              <div className="flex items-center gap-2 flex-wrap" data-testid="announcement-category-group">
                {ANNOUNCEMENT_CATEGORIES.map((c) => {
                  const Icon = c.icon;
                  const active = category === c.id;
                  return (
                    <button
                      type="button"
                      key={c.id}
                      onClick={() => setCategory(c.id)}
                      data-testid={`announcement-category-${c.id}`}
                      className={`px-3 py-1.5 text-xs font-bold uppercase tracking-wider border rounded-lg flex items-center gap-1.5 transition-colors ${
                        active
                          ? "bg-stone-950 text-[#dddd16] border-stone-950"
                          : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"
                      }`}>
                      <Icon className="w-3.5 h-3.5" />
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Pin-to-top: tick the box to lift this announcement to
                the top of the portal HQ Updates list. Once the date
                passes the announcement slides back into the regular
                chronological list — no admin action required. */}
            <div className="mb-4 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={pinned}
                  onChange={(e) => {
                    setPinned(e.target.checked);
                    if (e.target.checked && !pinnedUntil) {
                      // Default the unpin date to 14 days from today so
                      // ticking the box has a sensible auto-expiry.
                      const d = new Date();
                      d.setDate(d.getDate() + 14);
                      setPinnedUntil(d.toISOString().slice(0, 10));
                    }
                  }}
                  data-testid="announcement-pinned"
                  className="w-4 h-4 accent-amber-500"
                />
                <span className="text-xs font-bold uppercase tracking-wider text-amber-900">📌 Pin to top of HQ Updates</span>
              </label>
              {pinned && (
                <div className="mt-2 flex items-center gap-2 text-xs text-amber-900">
                  <span>Unpin on:</span>
                  <input
                    type="date"
                    value={pinnedUntil}
                    min={new Date().toISOString().slice(0, 10)}
                    onChange={(e) => setPinnedUntil(e.target.value)}
                    data-testid="announcement-pinned-until"
                    className="px-2 py-1 text-xs bg-white border border-amber-300 rounded-md"
                  />
                  <span className="text-amber-700">— stays at the top until this date passes.</span>
                </div>
              )}
            </div>

            {/* Panels — the editor surface changes per category:
                  • PROJECT  → File/Folder picker (existing UX)
                  • MEETINGS → External-link panels (YouTube etc.)
                  • GENERAL  → Single rich-text body, no panels
                The Recipients/Pin/Send block below stays identical
                across all three so admins keep one mental model. */}
            {category === "general" ? (
              <div className="mb-4" data-testid="announcement-general-body">
                <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mb-1.5">Body</div>
                <MarketingIntroEditor
                  value={bodyHtml}
                  onChange={setBodyHtml}
                  placeholder="Write your update… Use the toolbar for bold, colour, alignment and the franchisee's first name."
                  testid="announcement-body-editor"
                />
                <p className="mt-1.5 text-[11px] text-stone-500">
                  This is a free-text update — no files, folders or links needed.
                </p>
              </div>
            ) : category === "meetings" ? (
              <div className="mb-4" data-testid="announcement-meetings-panels">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500">Meeting links ({panels.length})</div>
                  <button onClick={addLinkPanel} data-testid="add-link-panel"
                    className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-md flex items-center gap-1">
                    <Plus className="w-3 h-3" /> Link
                  </button>
                </div>
                {panels.length === 0 ? (
                  <div className="px-4 py-8 text-center border-2 border-dashed border-stone-200 rounded-lg text-stone-500 text-xs">
                    Add a YouTube replay, Zoom recording or any URL above.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {panels.map((p, idx) => (
                      <div key={idx} className="border border-stone-200 rounded-lg p-3" data-testid={`panel-${idx}`}>
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div className="flex items-center gap-1.5 text-xs text-stone-600 min-w-0">
                            {(p.url || "").toLowerCase().includes("youtu") ? (
                              <Youtube className="w-3.5 h-3.5 shrink-0 text-rose-600" />
                            ) : (
                              <LinkIcon className="w-3.5 h-3.5 shrink-0" />
                            )}
                            <span className="font-mono truncate">{p.url || "(no URL yet)"}</span>
                          </div>
                          <button onClick={() => removePanel(idx)} className="text-stone-400 hover:text-rose-600 shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                        <label className="block mb-2">
                          <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mb-1">URL <span className="text-rose-600">*</span></div>
                          <input
                            type="url" value={p.url || ""}
                            onChange={(e) => updatePanel(idx, { url: e.target.value })}
                            placeholder="https://youtu.be/…"
                            data-testid={`panel-${idx}-url`}
                            className="w-full px-2 py-1.5 text-sm bg-white border border-stone-300 rounded font-mono" />
                        </label>
                        <label className="block mb-1">
                          <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mb-1">Title</div>
                          <input
                            value={p.title || ""}
                            onChange={(e) => updatePanel(idx, { title: e.target.value })}
                            placeholder="e.g. June Team Meeting Replay"
                            data-testid={`panel-${idx}-title`}
                            className="w-full px-2 py-1.5 text-sm bg-white border border-stone-300 rounded" />
                        </label>
                        <label className="block mb-2">
                          <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mb-1">Blurb</div>
                          <textarea rows={2} value={p.blurb || ""}
                            onChange={(e) => updatePanel(idx, { blurb: e.target.value })}
                            placeholder="One or two lines of context shown beneath the title."
                            data-testid={`panel-${idx}-blurb`}
                            className="w-full px-2 py-1.5 text-sm bg-white border border-stone-300 rounded" />
                        </label>
                        <div className="flex items-center justify-between gap-2 pt-1 border-t border-stone-100">
                          <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 flex items-center gap-1.5 min-w-0">
                            <ImageIcon className="w-3 h-3 shrink-0" />
                            <span>Thumbnail</span>
                            {p.thumbnail_key ? (
                              <span className="font-mono normal-case text-stone-400 truncate">· {p.thumbnail_key.split("/").pop()}</span>
                            ) : (
                              <span className="normal-case text-stone-400">· optional</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <label className="px-2 py-0.5 text-[10px] uppercase font-bold tracking-wider text-stone-700 border border-stone-300 hover:bg-stone-50 rounded cursor-pointer inline-flex items-center gap-1"
                              data-testid={`panel-${idx}-upload-thumb`}>
                              <Upload className="w-3 h-3" /> Upload
                              <input type="file" accept="image/*" className="hidden"
                                onChange={(e) => {
                                  const f = e.target.files?.[0];
                                  if (f) uploadThumbForPanel(idx, f);
                                  e.target.value = "";
                                }} />
                            </label>
                            {p.thumbnail_key && (
                              <button onClick={() => updatePanel(idx, { thumbnail_key: "" })} className="text-stone-400 hover:text-rose-600"><X className="w-3.5 h-3.5" /></button>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                    <div className="mt-2 flex items-center justify-center py-2 border-t border-stone-200">
                      <button onClick={addLinkPanel} data-testid="add-another-link"
                        className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-full flex items-center gap-1">
                        <Plus className="w-3 h-3" /> Add another link
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
            /* PROJECT — original file/folder picker UX */
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
                            <label className="px-2 py-0.5 text-[10px] uppercase font-bold tracking-wider text-stone-700 border border-stone-300 hover:bg-stone-50 rounded cursor-pointer inline-flex items-center gap-1"
                              data-testid={`panel-${idx}-upload-thumb`}>
                              <Upload className="w-3 h-3" /> Upload
                              <input type="file" accept="image/*" className="hidden"
                                onChange={(e) => {
                                  const f = e.target.files?.[0];
                                  if (f) uploadThumbForPanel(idx, f);
                                  e.target.value = "";
                                }} />
                            </label>
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
            )}

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
                {recipientFilter === "subset" && selectedRecipients.size > 0 && (
                  <span className="text-[10px] uppercase tracking-wider font-bold text-stone-500">{selectedRecipients.size} selected</span>
                )}
              </div>
              {recipientFilter === "subset" && (() => {
                const q = recipientSearch.trim().toLowerCase();
                const filtered = q
                  ? recipients.filter((r) =>
                      (r.first_name || "").toLowerCase().includes(q)
                      || (r.last_name || "").toLowerCase().includes(q)
                      || (r.organisation || "").toLowerCase().includes(q)
                      || (r.email || "").toLowerCase().includes(q))
                  : recipients;
                return (
                  <div className="border border-stone-200 rounded-lg overflow-hidden bg-white">
                    <div className="px-2 py-2 border-b border-stone-100 flex items-center gap-2">
                      <div className="relative flex-1">
                        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
                        <input
                          value={recipientSearch}
                          onChange={(e) => setRecipientSearch(e.target.value)}
                          placeholder="Search franchisees by name, org or email…"
                          data-testid="recipients-search"
                          className="w-full pl-7 pr-2 py-1.5 text-xs bg-stone-50 border border-stone-200 rounded focus:outline-none focus:border-stone-400 focus:bg-white"
                        />
                      </div>
                      <button onClick={() => setSelectedRecipients(new Set(filtered.map((r) => r.id)))}
                        type="button"
                        className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-stone-600 border border-stone-200 hover:bg-stone-50 rounded">
                        Select all{q ? " shown" : ""}
                      </button>
                      <button onClick={() => setSelectedRecipients(new Set())}
                        type="button"
                        className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-stone-600 border border-stone-200 hover:bg-stone-50 rounded">
                        Clear
                      </button>
                    </div>
                    <div className="max-h-72 overflow-y-auto p-1" data-testid="recipients-list">
                      {filtered.length === 0 ? (
                        <div className="px-3 py-6 text-center text-stone-500 text-xs">No franchisees match &ldquo;{recipientSearch}&rdquo;.</div>
                      ) : filtered.map((r) => {
                        const checked = selectedRecipients.has(r.id);
                        return (
                        <label key={r.id} data-testid={`recipient-row-${r.id}`}
                          className={`flex items-start gap-2 px-2 py-2 hover:bg-stone-50 text-xs cursor-pointer rounded border ${checked ? "bg-stone-50 border-stone-300" : "border-transparent"}`}>
                          <input type="checkbox" checked={checked}
                            className="mt-0.5"
                            onChange={(e) => setSelectedRecipients((s) => { const n = new Set(s); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-stone-900 truncate">{r.first_name} {r.last_name} <span className="text-stone-400">·</span> <span className="text-stone-600">{r.organisation}</span></div>
                            <div className="text-xs text-stone-700 font-mono break-all leading-tight mt-0.5">{r.email || <span className="italic text-stone-400">no email on file</span>}</div>
                          </div>
                        </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
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

        {/* Footer — HQ Updates publish straight to the franchisee
            portal feed (no email sent). The "Send test" route was
            removed because the live preview above shows the same
            rendering. */}
        <div className="px-5 py-3 border-t border-stone-200 bg-stone-50 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-xs text-stone-500 flex items-center gap-1.5">
            <Megaphone className="w-3.5 h-3.5" />
            <span>Publishes directly to the franchisee portal — no email is sent.</span>
          </div>
          <button onClick={send} disabled={!canSend}
            data-testid="announcement-send"
            className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-[#dddd16] hover:bg-stone-800 rounded-lg flex items-center gap-1.5 disabled:bg-stone-300 disabled:text-stone-500">
            {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
            {sending ? (mode === "edit" ? "Updating…" : "Publishing…") : (mode === "edit" ? "Save & republish" : "Publish to portal")}
          </button>
        </div>
      </div>

      <PickerModal open={!!picker} kind={picker?.kind} onPick={handlePick} onClose={() => setPicker(null)} />
    </div>
  );
}

// =====================================================================
// VIEW modal — read-only summary of a past announcement, with EDIT and
// DUPLICATE shortcuts that hand the data off to the compose modal.
// Thumbnails render via the authed /files/thumbnail proxy (using the
// panel's thumbnail_key when present, otherwise the file key for
// file-panels) — that way the view modal never depends on the brittle
// share-thumb URL stored in `thumbnail_url`.
// =====================================================================
// Defensive: rewrite an absolute share URL so the host matches the
// current window. Old announcements may have been minted with the
// wrong host (preview ↔ production drift); the share TOKEN itself is
// still valid against whichever backend matches the current host.
function shareUrlOnCurrentHost(url) {
  if (!url || typeof window === "undefined") return url;
  try {
    const u = new URL(url, window.location.origin);
    return window.location.origin + u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

function PanelThumb({ panel }) {
  // Prefer the explicit thumbnail_key (admin upload or pick); fall back
  // to the file panel's own key. Folder panels with no thumbnail_key
  // show a placeholder.
  const key = panel.thumbnail_key || (panel.kind === "file" ? panel.key : null);
  if (!key) {
    return (
      <div className="w-full aspect-[4/3] bg-stone-100 rounded-lg flex items-center justify-center text-stone-400">
        <ImageIcon className="w-6 h-6" />
      </div>
    );
  }
  // FileThumbnail uses the authed /files/thumbnail proxy via Bearer token.
  return (
    <FileThumbnail
      file={{ key, name: panel.title || "thumb.jpg", content_type: "image/jpeg" }}
      className="w-full aspect-[4/3] rounded-lg border border-stone-200 overflow-hidden"
    />
  );
}

function ViewModal({ ann, onClose, onEdit, onDuplicate, onPublished }) {
  const [publishing, setPublishing] = useState(false);
  if (!ann) return null;
  const isDraft = ann.status === "draft";

  const publish = async () => {
    if (!window.confirm(`Publish this update to ALL ACTIVE franchisees now? They'll see it on their portal HQ Updates page.`)) return;
    setPublishing(true);
    try {
      await api.post(`/admin/announcements/${ann.id}/publish`, {
        confirm_send_all: true,
        frontend_origin: window.location.origin,
      });
      onPublished?.();
      onClose?.();
    } catch (e) {
      alert(e?.response?.data?.detail || "Publish failed.");
    } finally { setPublishing(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-stone-950/40 backdrop-blur-sm flex items-start justify-center px-4 py-8 overflow-y-auto" onClick={onClose}>
      <div className="bg-white w-full max-w-3xl rounded-2xl border border-stone-200 my-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-5 border-b border-stone-200 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-2">
              {isDraft ? (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-amber-100 text-amber-900 border border-amber-300 rounded">DRAFT — not yet sent</span>
              ) : "Update"}
            </div>
            <h2 className="font-display text-2xl font-black text-stone-950 truncate">{ann.title}</h2>
            <div className="text-xs text-stone-500 mt-1 flex items-center gap-3">
              <Calendar className="w-3 h-3" /> {fmtDate(ann.sent_at || ann.created_at)}
              {!isDraft && <> · {ann.recipient_count} recipients · {ann.delivery?.status}</>}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {isDraft ? (
              <>
                <button onClick={() => onEdit?.(ann)} data-testid="ann-view-edit"
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-lg flex items-center gap-1">
                  <Pencil className="w-3 h-3" /> Edit
                </button>
                <button onClick={publish} disabled={publishing} data-testid="ann-view-publish"
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-emerald-600 text-white hover:bg-emerald-700 rounded-lg flex items-center gap-1 disabled:opacity-60">
                  {publishing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />} Publish now
                </button>
              </>
            ) : (
              <>
                <button onClick={() => onDuplicate?.(ann)} data-testid="ann-view-duplicate"
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-lg flex items-center gap-1">
                  <Plus className="w-3 h-3" /> Duplicate
                </button>
                <button onClick={() => onEdit?.(ann)} data-testid="ann-view-edit"
                  className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-stone-950 text-[#dddd16] hover:bg-stone-800 rounded-lg flex items-center gap-1">
                  <Send className="w-3 h-3" /> Edit / Resend
                </button>
              </>
            )}
            <button onClick={onClose} className="w-9 h-9 rounded-full border border-stone-300 hover:bg-stone-50 flex items-center justify-center"><X className="w-4 h-4" /></button>
          </div>
        </div>
        <div className="px-6 py-4">
          {ann.intro && <p className="text-sm text-stone-700 whitespace-pre-line mb-4">{ann.intro}</p>}
          {(ann.panels || []).map((p, i) => (
            <div key={i} className="grid grid-cols-[160px_1fr] gap-4 mb-4 border-t border-stone-100 pt-3 first:border-t-0 first:pt-0">
              <PanelThumb panel={p} />
              <div>
                <div className="font-display text-xl font-bold text-stone-950">{p.title}</div>
                <p className="text-sm text-stone-700 whitespace-pre-line mt-1">{p.blurb}</p>
                <a href={shareUrlOnCurrentHost(p.resolved_url)} target="_blank" rel="noopener noreferrer" className="inline-block mt-2 px-3 py-1.5 bg-[#dddd16] text-stone-950 font-bold text-xs uppercase tracking-wider rounded-md">Open {p.kind} →</a>
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
  // ``seed`` carries the announcement we're editing OR duplicating into
  // the compose modal. When mode='edit' a PATCH replaces the original
  // and (optionally) re-sends to the chosen recipients; when 'duplicate'
  // a fresh announcement is created — handy for "send the same update
  // to a different cohort".
  const [composeSeed, setComposeSeed] = useState(null); // { mode, ann } | null
  const [viewing, setViewing] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const openBlank = () => setComposeSeed({ mode: "new", ann: null });
  const openEdit = (ann) => { setViewing(null); setComposeSeed({ mode: "edit", ann }); };
  const openDuplicate = (ann) => { setViewing(null); setComposeSeed({ mode: "duplicate", ann }); };

  return (
    <>
      <AnnouncementsList onCompose={openBlank} onView={setViewing} refresh={refreshKey} />
      <ComposeModal
        open={!!composeSeed}
        seed={composeSeed}
        onClose={() => setComposeSeed(null)}
        onSent={() => { setComposeSeed(null); setRefreshKey((k) => k + 1); }}
      />
      <ViewModal ann={viewing} onClose={() => setViewing(null)} onEdit={openEdit} onDuplicate={openDuplicate} onPublished={() => setRefreshKey((k) => k + 1)} />
    </>
  );
}
