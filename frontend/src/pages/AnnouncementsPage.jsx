// AnnouncementsPage — `/admin/announcements`. Lets Paul send branded
// "Updates" e-shots to franchisees with one or more file/folder panels,
// and browse / re-open all past announcements.
//
// Two views in one page:
//   • LIST  — table of past announcements, newest first
//   • COMPOSE — modal opened via the "Send Update" button
//
// Each composer panel pulls from either the existing R2 file index
// (with a "Recently added" quick-pick) or a folder prefix. The
// thumbnail URL is auto-derived from the file's lifetime share token —
// the admin only needs to set blurb + title + pick recipients.
import { useEffect, useMemo, useState } from "react";
import {
  Megaphone, Send, Loader2, AlertCircle, Plus, Trash2, X, CheckCircle2,
  Search, FileText, Folder, Image as ImageIcon, RefreshCw, Calendar,
} from "lucide-react";
import api from "@/lib/api";

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return "—"; }
}

// --------------------------------------------------------------- LIST
function AnnouncementsList({ onCompose, onView, refresh, busyRefresh }) {
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/admin/announcements");
      setData(data);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [refresh]);

  return (
    <div className="px-8 py-6">
      <div className="flex items-end justify-between mb-6 gap-4 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-1.5">
            <Megaphone className="w-3 h-3" /> Updates & Announcements
          </div>
          <h1 className="font-display text-4xl font-black text-stone-950 mt-1">Updates</h1>
          <p className="text-sm text-stone-600 mt-1 max-w-2xl">
            Send a branded "What's New" e-shot to franchisees announcing new files,
            folders or project drops. They'll see the same list at
            <code className="px-1 py-0.5 bg-stone-100 rounded">/portal/updates</code>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            data-testid="announcements-refresh"
            className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-lg flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3 h-3 ${busyRefresh ? "animate-spin" : ""}`} /> Refresh
          </button>
          <button
            onClick={onCompose}
            data-testid="announcements-compose-btn"
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-[#dddd16] hover:bg-stone-800 rounded-lg flex items-center gap-1.5"
          >
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
            ) : (
              data.items.map((it) => {
                const status = it.delivery?.status || "unknown";
                const colour = status === "sent" ? "bg-emerald-50 text-emerald-900 border-emerald-200"
                  : status === "partial" ? "bg-amber-50 text-amber-900 border-amber-200"
                  : "bg-rose-50 text-rose-900 border-rose-200";
                return (
                  <tr key={it.id} className="border-t border-stone-100 hover:bg-stone-50/50 cursor-pointer" onClick={() => onView(it)} data-testid={`announcement-row-${it.id}`}>
                    <td className="px-4 py-3 font-medium text-stone-950">{it.title}</td>
                    <td className="px-3 py-3 text-stone-700 whitespace-nowrap">{fmtDate(it.sent_at || it.created_at)}</td>
                    <td className="px-3 py-3 text-stone-700">{(it.panels || []).length}</td>
                    <td className="px-3 py-3 text-stone-700">{it.recipient_count}</td>
                    <td className="px-3 py-3"><span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border rounded ${colour}`}>{status}</span></td>
                    <td className="px-3 py-3 text-right">
                      <button onClick={(e) => { e.stopPropagation(); if (window.confirm("Delete this announcement from the archive? Franchisees will lose it from /portal/updates. The original email already sent cannot be unsent.")) { api.delete(`/admin/announcements/${it.id}`).then(load); } }}
                        title="Delete from archive"
                        data-testid={`announcement-delete-${it.id}`}
                        className="text-stone-400 hover:text-rose-600">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ----------------------------------------------------- COMPOSE MODAL
function ComposeModal({ open, onClose, onSent }) {
  const [title, setTitle] = useState("");
  const [intro, setIntro] = useState("");
  const [panels, setPanels] = useState([]);

  const [recipients, setRecipients] = useState([]);
  const [recipientFilter, setRecipientFilter] = useState("all"); // "all" | "subset"
  const [selectedRecipients, setSelectedRecipients] = useState(new Set());

  const [recents, setRecents] = useState([]);
  const [picker, setPicker] = useState(null); // {kind, query, panelIdx}
  const [pickerResults, setPickerResults] = useState([]);

  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  // Initial load
  useEffect(() => {
    if (!open) return;
    setTitle(""); setIntro(""); setPanels([]); setSelectedRecipients(new Set());
    setError(""); setResult(null); setRecipientFilter("all");
    api.get("/admin/announcements/recipients").then(({ data }) => setRecipients(data.items || []));
    api.get("/admin/announcements/recent-files?limit=20").then(({ data }) => setRecents(data.items || []));
  }, [open]);

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

  const openPicker = (kind, panelIdx) => {
    setPicker({ kind, query: "", panelIdx });
    setPickerResults([]);
  };
  const runPickerSearch = async (q) => {
    setPicker((p) => ({ ...p, query: q }));
    if (!q || q.length < 2) { setPickerResults([]); return; }
    try {
      const { data } = await api.get("/files/search", { params: { q, limit: 20 } });
      setPickerResults(picker?.kind === "folder"
        ? (data.folders || []).map((f) => ({ prefix: f.prefix, name: f.prefix.split("/").filter(Boolean).pop() }))
        : (data.files || []));
    } catch (e) {
      setPickerResults([]);
    }
  };
  const choosePicker = (item) => {
    if (picker.panelIdx == null) {
      addPanel(picker.kind, item);
    } else {
      updatePanel(picker.panelIdx, picker.kind === "file"
        ? { kind: "file", key: item.key, prefix: undefined, title: item.name }
        : { kind: "folder", prefix: item.prefix, key: undefined, title: item.name });
    }
    setPicker(null);
    setPickerResults([]);
  };

  const send = async () => {
    setSending(true); setError(""); setResult(null);
    try {
      const body = {
        title: title.trim(),
        intro: intro.trim(),
        panels: panels.map((p) => ({
          kind: p.kind,
          key: p.key || undefined,
          prefix: p.prefix || undefined,
          title: p.title,
          blurb: p.blurb,
          thumbnail_url: p.thumbnail_url || undefined,
        })),
        recipient_ids: recipientFilter === "subset" ? Array.from(selectedRecipients) : null,
      };
      const { data } = await api.post("/admin/announcements", body);
      setResult(data);
      onSent?.();
    } catch (e) {
      setError(e?.response?.data?.detail || "Send failed.");
    } finally {
      setSending(false);
    }
  };

  const canSend = title.trim().length > 0 && panels.length > 0 && !sending
    && (recipientFilter === "all" || selectedRecipients.size > 0);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-stone-950/40 backdrop-blur-sm flex items-start justify-center px-4 py-8 overflow-y-auto"
      onClick={onClose} data-testid="announcement-modal-backdrop">
      <div className="bg-white w-full max-w-4xl rounded-2xl border border-stone-200 shadow-2xl my-auto"
        onClick={(e) => e.stopPropagation()} data-testid="announcement-modal">
        {/* Header */}
        <div className="px-6 py-5 border-b border-stone-200 flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-1.5">
              <Megaphone className="w-3 h-3" /> Send Update
            </div>
            <h2 className="font-display text-2xl font-black text-stone-950 mt-1">Compose Announcement</h2>
            <p className="text-sm text-stone-600 mt-1">Branded e-shot sent via Resend. Goes straight to your franchisees' inboxes and archives to <code>/portal/updates</code>.</p>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-full border border-stone-300 hover:bg-stone-50 flex items-center justify-center" data-testid="announcement-modal-close"><X className="w-4 h-4" /></button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-6">
          {error && <div className="px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-900 flex items-center gap-2"><AlertCircle className="w-4 h-4" /> {error}</div>}
          {result && (
            <div className="px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-900 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" />
              {result.status === "sent"
                ? `Sent to ${result.succeeded} franchisee(s).`
                : `${result.succeeded} sent, ${result.failed} failed.`}
            </div>
          )}

          {/* Title + intro */}
          <div className="grid gap-3">
            <label className="block">
              <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mb-1">Title (subject line)</div>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 2 NEW Projects for June 2026"
                data-testid="announcement-title"
                className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-stone-500" />
            </label>
            <label className="block">
              <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mb-1">Intro text</div>
              <textarea rows={3} value={intro} onChange={(e) => setIntro(e.target.value)} placeholder="Here are two new projects for June 2026 with File Camp links.&#10;All projects include stencils for A4 and A3 printers."
                data-testid="announcement-intro"
                className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-stone-500" />
            </label>
          </div>

          {/* Panels */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500">Project panels ({panels.length})</div>
              <div className="flex items-center gap-2">
                <button onClick={() => openPicker("file", null)}
                  data-testid="add-file-panel"
                  className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-md flex items-center gap-1"><Plus className="w-3 h-3" /> Add file</button>
                <button onClick={() => openPicker("folder", null)}
                  data-testid="add-folder-panel"
                  className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-md flex items-center gap-1"><Plus className="w-3 h-3" /> Add folder</button>
              </div>
            </div>

            {/* Recently added quick-add */}
            {recents.length > 0 && (
              <div className="mb-3 px-3 py-2 bg-stone-50 border border-stone-200 rounded-lg">
                <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mb-2">Recently added (click to add as a panel)</div>
                <div className="flex flex-wrap gap-1">
                  {recents.slice(0, 12).map((r) => (
                    <button key={r.key}
                      onClick={() => addPanel("file", r)}
                      data-testid={`recent-add-${r.key}`}
                      className="px-2 py-1 text-[10px] font-medium bg-white border border-stone-300 hover:bg-stone-100 text-stone-700 rounded">
                      {r.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {panels.length === 0 ? (
              <div className="px-6 py-10 text-center border-2 border-dashed border-stone-200 rounded-lg text-stone-500 text-sm">No panels yet. Add one above.</div>
            ) : (
              <div className="space-y-3">
                {panels.map((p, idx) => (
                  <div key={idx} className="border border-stone-200 rounded-lg p-3" data-testid={`panel-${idx}`}>
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="flex items-center gap-1.5 text-xs text-stone-600">
                        {p.kind === "file" ? <FileText className="w-3.5 h-3.5" /> : <Folder className="w-3.5 h-3.5" />}
                        <span className="font-mono truncate max-w-md">{p.key || p.prefix || "(no target picked yet)"}</span>
                        <button onClick={() => openPicker(p.kind, idx)} className="ml-1 text-stone-500 hover:text-stone-900 text-[10px] uppercase font-bold tracking-wider">Change</button>
                      </div>
                      <button onClick={() => removePanel(idx)} className="text-stone-400 hover:text-rose-600" title="Remove"><Trash2 className="w-4 h-4" /></button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mb-1">Panel title</div>
                        <input value={p.title} onChange={(e) => updatePanel(idx, { title: e.target.value })}
                          className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg" />
                      </label>
                      <label className="block">
                        <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mb-1">Thumbnail URL (optional — auto for files)</div>
                        <input value={p.thumbnail_url} onChange={(e) => updatePanel(idx, { thumbnail_url: e.target.value })}
                          placeholder={p.kind === "file" ? "Leave blank to use file thumbnail" : "https://…"}
                          className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg" />
                      </label>
                      <label className="block col-span-2">
                        <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mb-1">Blurb</div>
                        <textarea rows={2} value={p.blurb} onChange={(e) => updatePanel(idx, { blurb: e.target.value })}
                          className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg" />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recipients */}
          <div>
            <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mb-2">Recipients</div>
            <div className="flex items-center gap-3 mb-3">
              <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input type="radio" checked={recipientFilter === "all"} onChange={() => setRecipientFilter("all")} data-testid="recipients-all" />
                All active franchisees ({recipients.length})
              </label>
              <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input type="radio" checked={recipientFilter === "subset"} onChange={() => setRecipientFilter("subset")} data-testid="recipients-subset" />
                Pick recipients
              </label>
            </div>
            {recipientFilter === "subset" && (
              <div className="border border-stone-200 rounded-lg max-h-48 overflow-y-auto p-2 grid grid-cols-2 gap-1">
                {recipients.map((r) => (
                  <label key={r.id} className="flex items-center gap-2 px-2 py-1 hover:bg-stone-50 text-xs cursor-pointer">
                    <input type="checkbox" checked={selectedRecipients.has(r.id)}
                      onChange={(e) => setSelectedRecipients((s) => { const n = new Set(s); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })}
                      data-testid={`recipient-${r.id}`} />
                    <span className="truncate">{r.organisation} · {r.first_name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-stone-200 bg-stone-50 flex items-center justify-between">
          <div className="text-[11px] text-stone-500">Sent via Resend from <strong>Creative Mojo</strong></div>
          <button onClick={send} disabled={!canSend}
            data-testid="announcement-send"
            className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-[#dddd16] hover:bg-stone-800 rounded-lg flex items-center gap-1.5 disabled:bg-stone-300 disabled:text-stone-500">
            {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
            {sending ? "Sending…" : "Send announcement"}
          </button>
        </div>

        {/* File picker overlay */}
        {picker && (
          <div className="absolute inset-0 z-10 bg-black/40 flex items-center justify-center px-4" onClick={() => setPicker(null)}>
            <div className="bg-white w-full max-w-2xl rounded-xl p-4" onClick={(e) => e.stopPropagation()} data-testid="picker">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-bold">Pick a {picker.kind}</div>
                <button onClick={() => setPicker(null)}><X className="w-4 h-4" /></button>
              </div>
              <div className="relative mb-3">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
                <input autoFocus placeholder={`Search ${picker.kind}s by name…`} value={picker.query}
                  onChange={(e) => runPickerSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-sm bg-stone-50 border border-stone-200 rounded-lg" />
              </div>
              <div className="max-h-72 overflow-y-auto">
                {pickerResults.length === 0 ? (
                  <div className="text-xs text-stone-500 p-3 text-center">Type at least 2 characters to search.</div>
                ) : (
                  pickerResults.map((it, i) => (
                    <button key={(it.key || it.prefix) + i} onClick={() => choosePicker(it)}
                      data-testid={`picker-item-${i}`}
                      className="w-full text-left px-3 py-2 hover:bg-stone-50 border-b border-stone-100 text-sm flex items-center gap-2">
                      {picker.kind === "file" ? <FileText className="w-3.5 h-3.5 text-stone-500" /> : <Folder className="w-3.5 h-3.5 text-stone-500" />}
                      <span className="truncate">{it.name || it.prefix}</span>
                      <span className="ml-auto text-[10px] text-stone-400 font-mono truncate max-w-[50%]">{it.key || it.prefix}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------- VIEW MODAL
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
              <div>{p.thumbnail_url ? <img src={p.thumbnail_url} alt={p.title} className="w-full rounded-lg border border-stone-200" /> : <div className="w-full aspect-video bg-stone-100 rounded-lg flex items-center justify-center text-stone-400"><ImageIcon className="w-6 h-6" /></div>}</div>
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

// --------------------------------------------------------- ROOT PAGE
export default function AnnouncementsPage() {
  const [composeOpen, setComposeOpen] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <>
      <AnnouncementsList
        onCompose={() => setComposeOpen(true)}
        onView={setViewing}
        refresh={refreshKey}
      />
      <ComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        onSent={() => setRefreshKey((k) => k + 1)}
      />
      <ViewModal ann={viewing} onClose={() => setViewing(null)} />
    </>
  );
}
