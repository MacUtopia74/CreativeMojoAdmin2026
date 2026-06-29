// EmailTimeline — slim "Recent emails" rail used inside the contact
// drawer. Pulls from /api/email/sends?contact_id=... and shows the
// most recent 5 sends with their latest event (sent / delivered /
// opened / clicked / bounced / complained) and a relative timestamp.
//
// Designed to live under the AdminNotesEditor so Paul can see at a
// glance whether his templated reply has been read without leaving
// the drawer.
import { useCallback, useEffect, useState } from "react";
import api from "@/lib/api";
import {
  Mail, Eye, MousePointerClick, AlertTriangle, CheckCircle2,
  ChevronDown, ChevronRight, Loader2, Reply, Undo2,
} from "lucide-react";
import { toast } from "sonner";

const EVENT_META = {
  sent:       { label: "Sent",       icon: Mail,             classes: "text-stone-600 bg-stone-100" },
  delivered:  { label: "Delivered",  icon: CheckCircle2,     classes: "text-emerald-700 bg-emerald-50" },
  opened:     { label: "Opened",     icon: Eye,              classes: "text-blue-700 bg-blue-50" },
  clicked:    { label: "Clicked",    icon: MousePointerClick,classes: "text-amber-700 bg-amber-50" },
  replied:    { label: "Replied",    icon: Reply,            classes: "text-emerald-700 bg-emerald-50" },
  bounced:    { label: "Bounced",    icon: AlertTriangle,    classes: "text-red-700 bg-red-50" },
  complained: { label: "Spam",       icon: AlertTriangle,    classes: "text-red-700 bg-red-50" },
  delivery_delayed: { label: "Delayed", icon: AlertTriangle, classes: "text-amber-700 bg-amber-50" },
};

function relative(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const diffSec = Math.max(0, (Date.now() - then) / 1000);
  if (diffSec < 60) return `${Math.round(diffSec)}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

export default function EmailTimeline({ contactId, refreshSignal }) {
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);
    try {
      const { data } = await api.get("/email/sends", { params: { contact_id: contactId } });
      setItems(data.items || []);
    } catch (e) {
      console.error("[EmailTimeline] load failed", e);
      setItems([]);
    } finally { setLoading(false); }
  }, [contactId]);

  useEffect(() => { load(); }, [load, refreshSignal]);

  if (items === null) {
    return loading ? (
      <div className="text-xs text-stone-400 flex items-center gap-1.5">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading email history…
      </div>
    ) : null;
  }
  if (items.length === 0) {
    // Empty state is silent — we only show the rail if there's actual
    // history. Avoids cluttering the drawer for cold contacts.
    return null;
  }

  return (
    <div data-testid="email-timeline">
      <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2 flex items-center gap-1.5">
        <Mail className="w-3 h-3" /> Recent emails ({items.length})
      </div>
      <ul className="space-y-1.5">
        {items.slice(0, 5).map((s) => {
          const meta = EVENT_META[s.last_event] || EVENT_META.sent;
          const Icon = meta.icon;
          const isOpen = openId === s.id;
          return (
            <li key={s.id} className="border border-stone-200 rounded-lg bg-white">
              <button
                type="button"
                onClick={() => setOpenId(isOpen ? null : s.id)}
                data-testid={`email-timeline-row-${s.id}`}
                className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-stone-50 rounded-lg">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 ${meta.classes}`}>
                  <Icon className="w-3 h-3" /> {meta.label}
                </span>
                <span className="text-sm text-stone-900 truncate flex-1 font-medium">{s.subject || "(no subject)"}</span>
                <span className="text-[11px] text-stone-500 shrink-0 tabular-nums">{relative(s.last_event_at || s.sent_at)}</span>
                {isOpen ? <ChevronDown className="w-3 h-3 text-stone-400" /> : <ChevronRight className="w-3 h-3 text-stone-400" />}
              </button>
              {isOpen && (
                <div className="px-3 pb-3 pt-1 border-t border-stone-100 text-[11px] text-stone-600 space-y-1.5">
                  <div><span className="text-stone-400">To:</span> {(s.to || []).join(", ") || "—"}</div>
                  {s.cc?.length > 0 && <div><span className="text-stone-400">Cc:</span> {s.cc.join(", ")}</div>}
                  <div><span className="text-stone-400">Sent by:</span> {s.sent_by || "—"} · {new Date(s.sent_at).toLocaleString("en-GB")}</div>
                  {/* Phase 5a — manual "Mark as Replied" button. Until
                      Resend Inbound + Outlook forwarding lands we rely
                      on the admin to flag a reply themselves. Idempotent
                      server-side; the button flips to "Undo" once
                      marked. */}
                  {(() => {
                    const alreadyReplied = (s.events || []).some((e) => e.type === "replied");
                    return (
                      <div className="pt-1">
                        {alreadyReplied ? (
                          <button
                            type="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                await api.delete(`/email/sends/${s.id}/mark-replied`);
                                toast.success("Reply marker removed");
                                load();
                              } catch (err) {
                                toast.error(err?.response?.data?.detail || "Could not undo");
                              }
                            }}
                            data-testid={`unmark-replied-${s.id}`}
                            className="px-2 py-1 text-[10px] uppercase tracking-wider font-bold bg-white border border-stone-200 hover:bg-stone-50 rounded-md inline-flex items-center gap-1 text-stone-700"
                          >
                            <Undo2 className="w-3 h-3" /> Undo &ldquo;Replied&rdquo;
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                await api.post(`/email/sends/${s.id}/mark-replied`);
                                toast.success("Marked as replied — Lead Temperature will lift");
                                load();
                              } catch (err) {
                                toast.error(err?.response?.data?.detail || "Could not mark");
                              }
                            }}
                            data-testid={`mark-replied-${s.id}`}
                            className="px-2 py-1 text-[10px] uppercase tracking-wider font-bold bg-emerald-600 hover:bg-emerald-700 text-white rounded-md inline-flex items-center gap-1"
                          >
                            <Reply className="w-3 h-3" /> Mark as Replied
                          </button>
                        )}
                      </div>
                    );
                  })()}
                  {/* Mini event ladder so admins can see the full progression.
                      Webhook noise from BCC fan-out (every BCC'd copy fires
                      its own Resend ``delivered`` / ``opened`` / ``clicked``
                      event within seconds of the recipient interaction) is
                      collapsed by bucketing events into 60-second windows
                      and dropping same-bucket duplicates entirely — so a
                      single human interaction shows as ONE row, not ×N. */}
                  {Array.isArray(s.events) && s.events.length > 1 && (
                    <div className="pt-1 mt-1 border-t border-stone-100">
                      <div className="text-stone-400 mb-1">Activity:</div>
                      <ul className="space-y-0.5">
                        {(() => {
                          // 60-second bucket — catches BCC simultaneous
                          // fires (3 recipients × same physical open = 3
                          // webhooks within ~5s) but still separates a
                          // legitimate re-open hours later as its own row.
                          const grouped = [];
                          const seen = new Map();
                          for (const e of s.events) {
                            const bucket = Math.floor(new Date(e.at).getTime() / 60000);
                            const key = `${e.type}|${e.link || ""}|${bucket}`;
                            if (seen.has(key)) {
                              // Same physical event re-fired by another
                              // BCC copy — silently drop, don't inflate
                              // the count. The first webhook in the
                              // bucket already represents this open/click.
                              continue;
                            }
                            seen.set(key, grouped.length);
                            grouped.push({ ...e, count: 1 });
                          }
                          return grouped.map((e, i) => {
                            const m = EVENT_META[e.type] || { label: e.type, icon: Mail, classes: "text-stone-600" };
                            const EvIcon = m.icon;
                            // Distinguish auto-detected inbound replies
                            // (Phase 5b webhook) from manual "Mark as
                            // Replied" so admins know which they are
                            // looking at without opening the contact.
                            const isAutoReply = e.type === "replied" && e.direction === "inbound" && e.auto_matched;
                            const isManualReply = e.type === "replied" && !e.direction;
                            return (
                              <li key={`${s.id}-ev-${i}`} className="flex items-center gap-1.5 flex-wrap">
                                <EvIcon className="w-3 h-3 text-stone-400" />
                                <span>{m.label}{e.count > 1 ? ` ×${e.count}` : ""}</span>
                                {isAutoReply && (
                                  <span title="Reply auto-detected via Resend Inbound webhook" className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded bg-emerald-100 text-emerald-800">
                                    auto
                                  </span>
                                )}
                                {isManualReply && (
                                  <span title="Marked manually by an admin" className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded bg-stone-200 text-stone-700">
                                    manual
                                  </span>
                                )}
                                <span className="text-stone-400">· {new Date(e.at).toLocaleString("en-GB")}</span>
                                {e.from && isAutoReply && (
                                  <span className="text-stone-500 truncate max-w-[200px]">from {e.from}</span>
                                )}
                                {e.preview && isAutoReply && (
                                  <div className="basis-full pl-4 text-stone-600 italic line-clamp-2">{e.preview}</div>
                                )}
                                {e.link && <a href={e.link} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline truncate max-w-[200px]">{e.link}</a>}
                              </li>
                            );
                          });
                        })()}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
