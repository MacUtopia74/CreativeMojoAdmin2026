// Full-screen Correspondence modal — Feb 2026 build.
//
// Launched from the pipeline row's "View Correspondence" button. Shows
// the complete inbound + outbound email history for one contact,
// merged chronologically. Layout matches the reference visual: two
// sticky info cards at the top ("Plan their territory" + "Territory
// plan linked" mini-panels), a left sidebar with All / Sent by You /
// Received / Starred filters + a time filter + a sender filter, and
// the main list of messages with subject/from-or-to/status/date
// columns.
//
// Compose flow is delegated to `ReplyWithTemplateModal` — the
// "TEMPLATES" and "NEW EMAIL" buttons both open it. New Email starts
// blank, Templates jumps straight into template-picker mode. Sent
// messages append to the list without reloading.
import { useEffect, useMemo, useState } from "react";
import api from "@/lib/api";
import { toast } from "sonner";
import ReplyWithTemplateModal from "@/components/ReplyWithTemplateModal";
import {
  X, Mail, Phone, MapPin, FileText, Send, Star, Reply as ReplyIcon,
  Eye, CheckCircle2, AlertCircle, Loader2, Filter, Calendar as CalIcon, User,
  Paperclip, Target, Award,
} from "lucide-react";

// ---------------------------------------------------------------------
// Helpers
function fmtDate(iso) {
  if (!iso) return { date: "", time: "" };
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { date: iso, time: "" };
  const pad = (n) => String(n).padStart(2, "0");
  return {
    date: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

function displayName(c) {
  const parts = [c?.first_name, c?.last_name].filter(Boolean);
  return parts.join(" ") || c?.email || "Contact";
}

function toRecipientLine(msg) {
  if (msg.kind === "outbound") {
    const to = Array.isArray(msg.to) ? msg.to.join(", ") : msg.to || "";
    return { left: "You", right: `to ${to}` };
  }
  const from = msg.from || msg.from_email || "";
  return { left: from, right: "to You" };
}

const STATUS_PILL = {
  sent:      { label: "Sent",      cls: "bg-stone-100 text-stone-700" },
  delivered: { label: "Sent",      cls: "bg-stone-100 text-stone-700" },
  opened:    { label: "Sent",      cls: "bg-stone-100 text-stone-700" },
  clicked:   { label: "Sent",      cls: "bg-stone-100 text-stone-700" },
  bounced:   { label: "Bounced",   cls: "bg-red-100 text-red-700" },
  received:  { label: "Received",  cls: "bg-emerald-100 text-emerald-800" },
};

// ---------------------------------------------------------------------
// Left sidebar — filter buckets + time + sender filters
function SidebarBucket({ icon: Icon, label, count, active, onClick, testid }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg text-sm transition-colors ${
        active
          ? "bg-blue-50 text-blue-800 border border-blue-200"
          : "text-stone-700 hover:bg-stone-50 border border-transparent"
      }`}
    >
      <span className="flex items-center gap-2">
        <Icon className="w-4 h-4" />
        <span className="font-semibold uppercase tracking-wider text-[11px]">{label}</span>
      </span>
      <span className={`text-xs font-bold ${active ? "text-blue-700" : "text-stone-500"}`}>{count}</span>
    </button>
  );
}

// ---------------------------------------------------------------------
// A single message row in the main list
function MessageRow({ msg, onToggleStar, onExpand, expanded }) {
  const { date, time } = fmtDate(msg.date);
  const pill = STATUS_PILL[msg.status] || STATUS_PILL.sent;
  const isInbound = msg.kind === "inbound";
  const { left, right } = toRecipientLine(msg);
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  const opened = !!msg.opened;
  const bounced = !!msg.bounced;

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onExpand?.(msg)}
        onKeyDown={(e) => { if (e.key === "Enter") onExpand?.(msg); }}
        className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1fr)_auto] gap-4 items-start px-6 py-4 border-b border-stone-100 hover:bg-stone-50 cursor-pointer"
        data-testid={`correspondence-row-${msg.id}`}
      >
        {/* Subject + preview */}
        <div className="min-w-0 flex items-start gap-3">
          <div className={`w-9 h-9 rounded-full shrink-0 flex items-center justify-center ${
            isInbound ? "bg-emerald-50 text-emerald-700" : "bg-blue-50 text-blue-700"
          }`}>
            {isInbound ? <ReplyIcon className="w-4 h-4" /> : <Mail className="w-4 h-4" />}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold text-stone-900 truncate">
                {msg.subject || "(no subject)"}
              </span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onToggleStar?.(msg); }}
                className="shrink-0"
                data-testid={`correspondence-star-${msg.id}`}
              >
                <Star className={`w-3.5 h-3.5 ${msg.starred ? "fill-amber-400 text-amber-400" : "text-stone-300 hover:text-stone-500"}`} />
              </button>
            </div>
            <div className="text-xs text-stone-500 mt-0.5 line-clamp-2">
              {stripHtml(msg.text || msg.html) || <span className="italic">No preview</span>}
            </div>
          </div>
        </div>

        {/* From / To */}
        <div className="flex flex-col gap-1 text-xs">
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full font-bold uppercase tracking-wider text-[10px] w-fit ${pill.cls}`}>
            {isInbound ? "Received" : "Sent"}
          </span>
          <div className="text-stone-900">{left}</div>
          <div className="text-stone-500">{right}</div>
        </div>

        {/* Status */}
        <div className="flex flex-col gap-1 text-xs">
          {isInbound ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-emerald-700 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" /> Delivered
              </span>
              {msg.match_method && msg.match_method !== "plus_token" && (
                <span className="text-[10px] text-stone-400">via {msg.match_method}</span>
              )}
            </>
          ) : (
            <>
              {bounced && (
                <span className="inline-flex items-center gap-1.5 text-red-700 font-medium">
                  <AlertCircle className="w-3.5 h-3.5" /> Bounced
                </span>
              )}
              {!bounced && (
                <span className="inline-flex items-center gap-1.5 text-emerald-700 font-medium">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Delivered
                </span>
              )}
              {opened && !bounced && (
                <span className="inline-flex items-center gap-1.5 text-blue-700 font-medium">
                  <Eye className="w-3.5 h-3.5" /> Opened
                </span>
              )}
            </>
          )}
          {attachments.length > 0 && (
            <span className="inline-flex items-center gap-1 text-stone-500 text-[11px]">
              <Paperclip className="w-3 h-3" /> {attachments.length}
            </span>
          )}
        </div>

        {/* Date */}
        <div className="text-xs">
          <div className="text-stone-900 font-medium">{date}</div>
          <div className="text-stone-500">{time}</div>
        </div>

        <div className="text-stone-400 text-xs">···</div>
      </div>

      {expanded && (
        <div className="px-6 py-5 bg-stone-50 border-b border-stone-200" data-testid={`correspondence-body-${msg.id}`}>
          <div className="max-w-4xl">
            <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-stone-500 mb-3">
              <div>
                {isInbound ? "From " : "To "}
                <span className="text-stone-800 font-semibold normal-case">
                  {isInbound ? (msg.from || msg.from_email) : (Array.isArray(msg.to) ? msg.to.join(", ") : msg.to)}
                </span>
              </div>
              <div>{date} · {time}</div>
            </div>
            <div className="rounded-lg bg-white border border-stone-200 p-5 text-sm text-stone-900 whitespace-pre-wrap">
              {msg.html ? (
                <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(msg.html) }} />
              ) : (
                msg.text || <span className="italic text-stone-400">Empty message</span>
              )}
            </div>
            {attachments.length > 0 && (
              <div className="mt-4">
                <div className="text-[11px] uppercase tracking-wider text-stone-500 mb-2">Attachments</div>
                <div className="flex flex-wrap gap-2">
                  {attachments.map((a, i) => (
                    <AttachmentChip key={i} msg={msg} att={a} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function AttachmentChip({ msg, att }) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    if (msg.kind !== "inbound") return;
    setBusy(true);
    try {
      const { data } = await api.get(`/contacts/${msg.contact_id_hint || ""}/correspondence/attachments/${msg.id}/${encodeURIComponent(att.filename)}`);
      if (data?.url) window.open(data.url, "_blank");
    } catch {
      toast.error(`Could not download ${att.filename}`);
    } finally { setBusy(false); }
  };
  return (
    <button
      type="button"
      onClick={download}
      disabled={busy}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-stone-300 rounded-full text-xs hover:bg-stone-50"
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Paperclip className="w-3.5 h-3.5" />}
      {att.filename}
    </button>
  );
}

function stripHtml(input) {
  if (!input) return "";
  const s = String(input).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return s.slice(0, 220);
}

function sanitizeHtml(html) {
  // Very conservative — strip <script>, event handlers, javascript: hrefs.
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/on[a-z]+="[^"]*"/gi, "")
    .replace(/on[a-z]+='[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

// ---------------------------------------------------------------------
// Modal
export default function CorrespondenceModal({ open, contact, onClose, onOpenPostcodeMap }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState({ contact: null, messages: [] });
  const [error, setError] = useState("");
  const [bucket, setBucket] = useState("all"); // all | sent | received | starred
  const [timeFilter, setTimeFilter] = useState("all");
  const [senderFilter, setSenderFilter] = useState("all");
  const [expandedId, setExpandedId] = useState(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeMode, setComposeMode] = useState("blank"); // blank | template

  // Load correspondence whenever the modal opens for a new contact.
  useEffect(() => {
    if (!open || !contact?.id) return;
    setLoading(true); setError("");
    api.get(`/contacts/${contact.id}/correspondence`)
      .then(({ data: d }) => setData(d))
      .catch(() => setError("Could not load correspondence."))
      .finally(() => setLoading(false));
  }, [open, contact?.id]);

  const messages = useMemo(() => {
    // Stamp contact_id_hint on each row so nested attachment lookups
    // don't need to be re-plumbed through the row component.
    return (data.messages || []).map((m) => ({ ...m, contact_id_hint: contact?.id }));
  }, [data.messages, contact?.id]);

  const counts = useMemo(() => ({
    all:      messages.length,
    sent:     messages.filter((m) => m.kind === "outbound").length,
    received: messages.filter((m) => m.kind === "inbound").length,
    starred:  messages.filter((m) => m.starred).length,
  }), [messages]);

  const senders = useMemo(() => {
    const set = new Set();
    for (const m of messages) {
      if (m.kind === "inbound" && m.from_email) set.add(m.from_email);
      else if (m.kind === "outbound") set.add("You");
    }
    return ["all", ...Array.from(set)];
  }, [messages]);

  const filtered = useMemo(() => {
    let rows = messages;
    if (bucket === "sent") rows = rows.filter((m) => m.kind === "outbound");
    else if (bucket === "received") rows = rows.filter((m) => m.kind === "inbound");
    else if (bucket === "starred") rows = rows.filter((m) => m.starred);

    if (timeFilter !== "all") {
      const now = Date.now();
      const days = { "7d": 7, "30d": 30, "90d": 90 }[timeFilter] || 0;
      if (days) {
        const cutoff = now - days * 86400 * 1000;
        rows = rows.filter((m) => new Date(m.date || 0).getTime() >= cutoff);
      }
    }

    if (senderFilter !== "all") {
      rows = rows.filter((m) =>
        senderFilter === "You" ? m.kind === "outbound" : (m.from_email === senderFilter)
      );
    }

    return rows;
  }, [messages, bucket, timeFilter, senderFilter]);

  const toggleStar = async (msg) => {
    const kind = msg.kind;
    const nextStar = !msg.starred;
    // Optimistic
    setData((d) => ({ ...d, messages: d.messages.map((m) => m.id === msg.id ? { ...m, starred: nextStar } : m) }));
    try {
      await api.patch(`/contacts/${contact.id}/correspondence/${kind}/${msg.id}/star`, { starred: nextStar });
    } catch {
      setData((d) => ({ ...d, messages: d.messages.map((m) => m.id === msg.id ? { ...m, starred: !nextStar } : m) }));
      toast.error("Could not update starred");
    }
  };

  const openCompose = (mode) => { setComposeMode(mode); setComposeOpen(true); };
  const handleSent = () => {
    setComposeOpen(false);
    // Reload correspondence so the new outbound appears.
    if (contact?.id) {
      api.get(`/contacts/${contact.id}/correspondence`)
        .then(({ data: d }) => setData(d))
        .catch(() => {});
    }
  };

  if (!open) return null;

  const c = data.contact || contact || {};
  const territoryLinked = !!(c.territory_plan_id || contact?.territory_plan_id);

  return (
    <>
      <div className="fixed inset-0 z-50 bg-white overflow-y-auto" role="dialog" aria-modal="true" data-testid="correspondence-modal">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-white border-b border-stone-200">
          <div className="max-w-[1600px] mx-auto px-8 py-5 flex items-center gap-4">
            <h1 className="text-2xl font-bold text-stone-900 min-w-0 truncate flex items-center gap-3">
              Correspondence for <span className="text-stone-900">{displayName(c)}</span>
              {c.pipeline_status === "new" && (
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full bg-amber-100 text-amber-800">New</span>
              )}
            </h1>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => openCompose("template")}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold uppercase tracking-wider bg-white border border-stone-300 rounded-lg hover:bg-stone-50 text-stone-800"
                data-testid="correspondence-templates-btn"
              >
                <FileText className="w-3.5 h-3.5" /> Templates
              </button>
              <button
                type="button"
                onClick={() => openCompose("blank")}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-900 text-white rounded-lg hover:bg-stone-800"
                data-testid="correspondence-new-email-btn"
              >
                <Mail className="w-3.5 h-3.5" /> New Email
              </button>
              <button
                type="button"
                onClick={onClose}
                className="ml-2 p-2 text-stone-500 hover:text-stone-800"
                data-testid="correspondence-close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>

        {/* Contact strip + optional info cards */}
        <div className="max-w-[1600px] mx-auto px-8 pt-6 pb-4 flex items-start gap-4 flex-wrap">
          <div className="flex items-center gap-6 text-sm text-stone-700 flex-1 min-w-0">
            {c.email && (
              <span className="inline-flex items-center gap-2"><Mail className="w-4 h-4 text-stone-400" /> {c.email}</span>
            )}
            {c.telephone && (
              <span className="inline-flex items-center gap-2"><Phone className="w-4 h-4 text-stone-400" /> {c.telephone}</span>
            )}
            {c.postcode && (
              <span className="inline-flex items-center gap-2">
                <MapPin className="w-4 h-4 text-stone-400" /> {c.postcode}
                <button
                  type="button"
                  onClick={() => onOpenPostcodeMap?.(c)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 rounded hover:bg-stone-100 text-stone-700"
                >
                  <MapPin className="w-2.5 h-2.5" /> Map
                </button>
              </span>
            )}
          </div>

          {/* Two info cards from the reference visual */}
          <div className="flex items-stretch gap-3">
            <div className="rounded-xl border-2 border-[#dddd16] bg-[#fafbe9] p-3 pr-4 flex items-center gap-3 w-[280px]">
              <Target className="w-5 h-5 text-stone-700 shrink-0" />
              <div className="min-w-0">
                <div className="text-[11px] uppercase font-bold tracking-wider text-stone-700">Plan their territory</div>
                <div className="text-[11px] text-stone-600 mt-0.5 leading-tight">
                  Build a sample 150-home territory around their postcode.
                </div>
              </div>
            </div>
            {territoryLinked ? (
              <div className="rounded-xl border-2 border-emerald-300 bg-emerald-50/60 p-3 pr-4 flex items-center gap-3 w-[280px]">
                <Award className="w-5 h-5 text-emerald-700 shrink-0" />
                <div className="min-w-0">
                  <div className="text-[11px] uppercase font-bold tracking-wider text-emerald-800">Territory plan linked</div>
                  <div className="text-[11px] text-emerald-800 mt-0.5 truncate">Linked plan · {c.first_name || "this contact"}</div>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* Body */}
        <div className="max-w-[1600px] mx-auto px-8 pb-16">
          <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
            {/* Sidebar */}
            <aside className="space-y-1.5">
              <SidebarBucket
                icon={Mail} label="All Messages" count={counts.all}
                active={bucket === "all"} onClick={() => setBucket("all")}
                testid="correspondence-bucket-all"
              />
              <SidebarBucket
                icon={Send} label="Sent by you" count={counts.sent}
                active={bucket === "sent"} onClick={() => setBucket("sent")}
                testid="correspondence-bucket-sent"
              />
              <SidebarBucket
                icon={ReplyIcon} label="Received" count={counts.received}
                active={bucket === "received"} onClick={() => setBucket("received")}
                testid="correspondence-bucket-received"
              />
              <SidebarBucket
                icon={Star} label="Starred" count={counts.starred}
                active={bucket === "starred"} onClick={() => setBucket("starred")}
                testid="correspondence-bucket-starred"
              />

              <div className="mt-6">
                <div className="text-[11px] uppercase font-bold tracking-wider text-stone-500 mb-2 flex items-center gap-1.5">
                  <Filter className="w-3.5 h-3.5" /> Filters
                </div>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 border border-stone-200 rounded-lg px-2 py-2 bg-white">
                    <CalIcon className="w-4 h-4 text-stone-400" />
                    <select
                      value={timeFilter}
                      onChange={(e) => setTimeFilter(e.target.value)}
                      className="w-full bg-transparent focus:outline-none text-sm"
                      data-testid="correspondence-time-filter"
                    >
                      <option value="all">All time</option>
                      <option value="7d">Last 7 days</option>
                      <option value="30d">Last 30 days</option>
                      <option value="90d">Last 90 days</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2 border border-stone-200 rounded-lg px-2 py-2 bg-white">
                    <User className="w-4 h-4 text-stone-400" />
                    <select
                      value={senderFilter}
                      onChange={(e) => setSenderFilter(e.target.value)}
                      className="w-full bg-transparent focus:outline-none text-sm"
                      data-testid="correspondence-sender-filter"
                    >
                      {senders.map((s) => (
                        <option key={s} value={s}>{s === "all" ? "All senders" : s}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              <div className="mt-8 space-y-1.5 text-xs text-stone-600">
                <div className="flex items-center gap-2"><Eye className="w-3.5 h-3.5 text-blue-500" /> Opened</div>
                <div className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> Delivered</div>
                <div className="flex items-center gap-2"><ReplyIcon className="w-3.5 h-3.5 text-purple-600" /> Replied</div>
                <div className="flex items-center gap-2"><Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" /> Starred</div>
              </div>
            </aside>

            {/* Main list */}
            <main className="border border-stone-200 rounded-2xl bg-white overflow-hidden">
              <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1fr)_auto] gap-4 px-6 py-3 border-b border-stone-200 bg-stone-50 text-[10px] font-bold uppercase tracking-wider text-stone-500">
                <div>Subject</div>
                <div>From / To</div>
                <div>Status</div>
                <div>Date</div>
                <div>&nbsp;</div>
              </div>
              {loading ? (
                <div className="p-8 text-center text-stone-500 flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                </div>
              ) : error ? (
                <div className="p-8 text-center text-red-600">{error}</div>
              ) : filtered.length === 0 ? (
                <div className="p-10 text-center text-stone-500">
                  <Mail className="w-8 h-8 mx-auto mb-3 text-stone-300" />
                  <div className="text-sm">No messages yet</div>
                  <div className="text-xs mt-1">Send a new email above to start the conversation.</div>
                </div>
              ) : (
                filtered.map((msg) => (
                  <MessageRow
                    key={msg.id}
                    msg={msg}
                    expanded={expandedId === msg.id}
                    onExpand={(m) => setExpandedId(expandedId === m.id ? null : m.id)}
                    onToggleStar={toggleStar}
                  />
                ))
              )}
              {!loading && filtered.length > 0 && (
                <div className="text-center py-4 text-xs text-stone-500">
                  {filtered.length} message{filtered.length === 1 ? "" : "s"} in this conversation
                </div>
              )}
            </main>
          </div>
        </div>
      </div>

      <ReplyWithTemplateModal
        open={composeOpen}
        contact={{ ...contact, __initial_mode: composeMode }}
        onClose={() => setComposeOpen(false)}
        onSent={handleSent}
      />
    </>
  );
}
