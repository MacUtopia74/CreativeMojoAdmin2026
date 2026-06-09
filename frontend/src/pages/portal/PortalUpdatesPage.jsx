// PortalUpdatesPage — `/portal/updates`. Franchisees see every
// announcement they were a recipient of, newest first. Each card
// expands inline to show the original panels with working file/folder
// links (the same lifetime share token Paul emailed them).
//
// Read tracking: items come back with `is_unread`. We show a NEW
// lozenge while unread, fire POST /portal/announcements/{id}/read
// when the user expands the row, and tell the shell to re-fetch the
// sidebar badge so it clears instantly (no 60s poll wait).
import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Megaphone, Calendar, Loader2, AlertCircle, ChevronDown, Image as ImageIcon } from "lucide-react";
import api from "@/lib/api";
import FileThumbnail from "@/components/files/FileThumbnail";

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

// Render a panel's thumbnail via the authed /files/thumbnail proxy so
// it never depends on the brittle public share-token URL stored in
// `thumbnail_url`. Falls back to a placeholder when no key is set.
function PanelThumb({ panel }) {
  const key = panel.thumbnail_key || (panel.kind === "file" ? panel.key : null);
  if (!key) {
    return (
      <div className="w-full h-full flex items-center justify-center text-stone-400">
        <ImageIcon className="w-6 h-6" />
      </div>
    );
  }
  return (
    <FileThumbnail
      file={{ key, name: panel.title || "thumb.jpg", content_type: "image/jpeg" }}
      className="w-full h-full"
    />
  );
}

function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "long", year: "numeric" }); }
  catch { return "—"; }
}

export default function PortalUpdatesPage() {
  const ctx = useOutletContext() || {};
  const refreshUnreadUpdates = ctx.refreshUnreadUpdates;
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null);
  // Track IDs we've already POSTed /read for in this session — keeps
  // the NEW lozenge gone after re-collapse, and prevents redundant
  // network chatter when the user fan-toggles a row.
  const [readNow, setReadNow] = useState(() => new Set());

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { data } = await api.get("/portal/announcements");
        setItems(data.items || []);
      } catch (e) {
        setError(e?.response?.data?.detail || "Could not load updates.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const markRead = async (id) => {
    if (!id || readNow.has(id)) return;
    // Optimistically mark in local state so the lozenge clears even
    // if the request stalls. If the request fails (offline, etc.) we
    // simply leave it — the next page load will re-derive from the
    // server, and the user can still open the link.
    setReadNow((s) => { const n = new Set(s); n.add(id); return n; });
    try {
      await api.post(`/portal/announcements/${id}/read`);
      refreshUnreadUpdates?.();
    } catch {
      // Swallow — non-critical, retry happens next mount.
    }
  };

  const toggleOpen = (it) => {
    const nextOpen = openId === it.id ? null : it.id;
    setOpenId(nextOpen);
    if (nextOpen) {
      markRead(it.id);
    }
  };

  return (
    <div className="px-6 md:px-10 py-8 max-w-5xl mx-auto" data-testid="portal-updates-page">
      <div className="mb-6">
        <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-1.5">
          <Megaphone className="w-3 h-3" /> Updates from Creative Mojo
        </div>
        <h1 className="font-display text-4xl font-black text-stone-950 mt-1">HQ Updates</h1>
        <p className="text-sm text-stone-600 mt-1">All the announcements we've sent you. Tap one to re-open the linked file or folder.</p>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-900 flex items-center gap-2 mb-4">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {loading ? (
        <div className="text-stone-500 text-sm flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading updates…</div>
      ) : items.length === 0 ? (
        <div className="px-6 py-16 border-2 border-dashed border-stone-200 rounded-2xl text-center text-stone-500 text-sm">
          No updates yet. When we share new files or projects, they'll appear here.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((it) => {
            const isOpen = openId === it.id;
            const isUnread = (it.is_unread === true) && !readNow.has(it.id);
            return (
              <div
                key={it.id}
                className={`bg-white border rounded-2xl overflow-hidden ${
                  it.is_pinned ? "border-amber-400 ring-2 ring-amber-200"
                    : isUnread ? "border-rose-300 ring-1 ring-rose-100"
                    : "border-stone-200"
                }`}
                data-testid={`portal-update-${it.id}`}
              >
                <button
                  onClick={() => toggleOpen(it)}
                  data-testid={`portal-update-toggle-${it.id}`}
                  className="w-full flex items-center gap-4 px-5 py-4 hover:bg-stone-50/60 text-left transition-colors"
                >
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                    it.is_pinned ? "bg-amber-100 text-amber-800"
                      : isUnread ? "bg-rose-100 text-rose-700"
                      : "bg-[#dddd16]/20 text-stone-900"
                  }`}>
                    <Megaphone className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {it.is_pinned && (
                        <span
                          data-testid={`portal-update-pinned-${it.id}`}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-amber-400 text-stone-950 rounded-full shadow-sm"
                          title={`Pinned until ${(it.pinned_until || "").slice(0, 10)}`}
                        >
                          📌 Pinned
                        </span>
                      )}
                      <div className="font-display text-xl font-bold text-stone-950 truncate">{it.title}</div>
                      {isUnread && (
                        <span
                          data-testid={`portal-update-new-${it.id}`}
                          className="inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-rose-600 text-white rounded-full shadow-sm"
                        >
                          New
                        </span>
                      )}
                    </div>
                    {/* Date — bumped up to text-sm and the brand font
                        so it reads as proper metadata not micro-print.
                        (Was text-xs in the previous build.) */}
                    <div className="text-sm font-semibold text-stone-700 mt-1 flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-stone-500" />
                      <span data-testid={`portal-update-date-${it.id}`}>
                        {fmtDate(it.sent_at || it.created_at)}
                      </span>
                      <span className="text-stone-400">·</span>
                      <span className="text-stone-500 font-normal">
                        {(it.panels || []).length} item{(it.panels || []).length === 1 ? "" : "s"}
                      </span>
                    </div>
                  </div>
                  <ChevronDown className={`w-4 h-4 text-stone-500 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                </button>
                {isOpen && (
                  <div className="px-5 pb-5 border-t border-stone-100">
                    {it.intro && <p className="text-sm text-stone-700 whitespace-pre-line mt-3 mb-4">{it.intro}</p>}
                    {(it.panels || []).map((p, i) => (
                      <div key={i} className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-4 mb-4 last:mb-0">
                        <div className="rounded-lg overflow-hidden border border-stone-200 bg-stone-50 aspect-video sm:aspect-square">
                          <PanelThumb panel={p} />
                        </div>
                        <div>
                          <div className="font-display text-lg font-bold text-stone-950">{p.title}</div>
                          {p.blurb && <p className="text-sm text-stone-700 whitespace-pre-line mt-1">{p.blurb}</p>}
                          <a href={shareUrlOnCurrentHost(p.resolved_url)} target="_blank" rel="noopener noreferrer"
                            data-testid={`portal-update-link-${it.id}-${i}`}
                            className="inline-block mt-3 px-4 py-2 bg-[#dddd16] text-stone-950 font-bold text-xs uppercase tracking-wider rounded-md hover:brightness-95">
                            Open {p.kind === "folder" ? "folder" : "file"} →
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
