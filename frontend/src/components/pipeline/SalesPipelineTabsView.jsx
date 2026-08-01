// Sales Pipeline — Tabbed list view.
//
// Replaces the flat Airtable-style list on the Sales Pipeline tab with a
// four-tab layout (NEW / CONTACTED / FOLLOW-UP DUE / INTERESTED) whose
// rows expand in place to reveal Summary / Checklist / Activity / Notes
// side-by-side plus quick-action buttons. Dormant + Lost stages remain
// on the kanban only (per PM decision, 2026-08-01).
//
// Design notes
// ------------
// * The row is a compact, at-a-glance summary — name, temperature flame,
//   postcode, "Emailed / Not emailed" chip and a chevron. Nothing else,
//   because the whole point of this view is to stay above the fold at
//   normal desktop widths.
// * Only one row expands at a time — collapsing a row keeps the view
//   uncluttered and matches the mockup exactly.
// * Reuses the existing `InterestedChecklist` + `AdminNotesEditor` widgets
//   (re-exported from ContactsPage.js) so the pipeline tabs never fall
//   out of sync with the drawer if the checklist schema evolves.
// * `EmailTimeline` mounts on demand inside the expanded row's Activity
//   panel so we don't hammer the backend with N GETs at list load.
// * The three action buttons (Quick reply / Reply with template / View
//   correspondence) call the callbacks the parent hands down —
//   `openDrawer`, `openTemplateReply`. Real reply UX will come in a
//   follow-up per user's note ("instructions for the email element will
//   follow once this is built").

import React, { useMemo, useState } from "react";
import {
  Flame, MapPin, MessageSquare, FileText, ChevronDown, ChevronUp,
  Mail, MailX, Send, ClipboardCheck, Activity as ActivityIcon,
  StickyNote,
} from "lucide-react";
import EmailTimeline from "@/components/EmailTimeline";
import { InterestedChecklist, AdminNotesEditor } from "@/pages/ContactsPage";

// Order matches the mockup left→right. Colours line up with STAGES in
// ContactsPage.js so the stage pill stays visually consistent between
// the tabs view and the kanban.
const TABS = [
  { key: "new",           label: "New",            accent: "bg-stone-800",    dot: "bg-stone-400", tint: "text-stone-700" },
  { key: "contacted",     label: "Contacted",      accent: "bg-blue-700",     dot: "bg-blue-400",  tint: "text-blue-700" },
  { key: "follow_up_due", label: "Follow-up Due",  accent: "bg-amber-700",    dot: "bg-amber-500", tint: "text-amber-800" },
  { key: "qualified",     label: "Interested",     accent: "bg-emerald-700",  dot: "bg-emerald-500", tint: "text-emerald-800" },
];

const FLAME_COLOUR = {
  cold: "text-blue-500",
  cool: "text-sky-500",
  warm: "text-amber-500",
  hot:  "text-red-600",
};

function daysSinceISO(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

function formatPostcodeLink(pc) {
  const clean = (pc || "").trim();
  if (!clean) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(clean)}`;
}

export default function SalesPipelineTabsView({
  contacts,
  tempMap,
  onOpenContact,
  onReplyContact,
  onContactUpdated,
}) {
  const [activeTab, setActiveTab] = useState("new");
  const [expandedId, setExpandedId] = useState(null);

  // Split contacts into buckets by pipeline_status once per render.
  // ``dormant`` / ``lost`` deliberately excluded — those stages stay on
  // the kanban only.
  const buckets = useMemo(() => {
    const out = { new: [], contacted: [], follow_up_due: [], qualified: [] };
    for (const c of contacts) {
      if (!c.in_pipeline) continue;
      const s = c.pipeline_status || "new";
      if (out[s]) out[s].push(c);
    }
    return out;
  }, [contacts]);

  const activeRows = buckets[activeTab] || [];

  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid="sales-pipeline-tabs">
      {/* Tab bar */}
      <div
        role="tablist"
        aria-label="Sales pipeline stages"
        className="flex border-b border-stone-200 bg-[#F2F2F0]"
      >
        {TABS.map((t) => {
          const isActive = t.key === activeTab;
          const count = (buckets[t.key] || []).length;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => { setActiveTab(t.key); setExpandedId(null); }}
              data-testid={`pipeline-tab-${t.key}`}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-xs font-bold uppercase tracking-[0.18em] transition-colors border-b-2 ${
                isActive
                  ? "border-stone-900 text-stone-900 bg-white"
                  : "border-transparent text-stone-500 hover:text-stone-800 hover:bg-white/60"
              }`}
            >
              <span className={`inline-block w-2 h-2 rounded-full ${t.dot}`} />
              <span>{t.label}</span>
              <span
                className={`text-[10px] tabular-nums px-1.5 py-0.5 rounded-full ${
                  isActive ? `${t.accent} text-white` : "bg-stone-200 text-stone-700"
                }`}
                data-testid={`pipeline-tab-count-${t.key}`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Rows */}
      {activeRows.length === 0 ? (
        <div className="py-16 text-center text-sm text-stone-500" data-testid={`pipeline-tab-empty-${activeTab}`}>
          No contacts in this stage right now.
        </div>
      ) : (
        <ul className="divide-y divide-stone-100">
          {activeRows.map((c) => (
            <PipelineRow
              key={c.id}
              contact={c}
              temp={tempMap?.[c.id]}
              isExpanded={expandedId === c.id}
              onToggle={() => setExpandedId(expandedId === c.id ? null : c.id)}
              onOpenContact={onOpenContact}
              onReplyContact={onReplyContact}
              onContactUpdated={onContactUpdated}
            />
          ))}
        </ul>
      )}
    </div>
  );
}


function PipelineRow({
  contact, temp, isExpanded, onToggle,
  onOpenContact, onReplyContact, onContactUpdated,
}) {
  const c = contact;
  const displayName = [c.first_name, c.last_name].filter(Boolean).join(" ") || "(no name)";
  const flameBand = temp?.band || "cold";
  const flameColour = FLAME_COLOUR[flameBand] || FLAME_COLOUR.cold;
  const emailed = (c.email_sends_count || 0) > 0;
  const postcodeLink = formatPostcodeLink(c.postcode);
  const daysInStage = daysSinceISO(c.pipeline_status_updated_at || c.updated_at || c.date_added);

  return (
    <li data-testid={`pipeline-row-${c.id}`} className="bg-white">
      {/* Compact row */}
      <button
        type="button"
        onClick={onToggle}
        className={`w-full flex items-center gap-4 px-4 py-3 hover:bg-stone-50 transition-colors text-left ${
          isExpanded ? "bg-stone-50" : ""
        }`}
        data-testid={`pipeline-row-toggle-${c.id}`}
      >
        {/* Name / establishment */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-stone-950 truncate">
            {displayName}
            {c.establishment_name && (
              <span className="ml-2 text-xs font-normal text-stone-500 truncate">
                · {c.establishment_name}
              </span>
            )}
          </div>
          <div className="text-[11px] text-stone-500 truncate mt-0.5">
            {c.email || <span className="italic">no email</span>}
            {typeof daysInStage === "number" && (
              <span className="ml-2 text-stone-400">· {daysInStage}d in stage</span>
            )}
          </div>
        </div>

        {/* Postcode */}
        {c.postcode && (
          <span className="hidden md:inline-flex items-center gap-1 text-xs text-stone-600 shrink-0">
            <MapPin className="w-3 h-3" />
            {c.postcode}
          </span>
        )}

        {/* Temperature flame */}
        <span
          className={`inline-flex items-center gap-1 text-xs shrink-0 ${flameColour}`}
          title={`Lead temperature: ${flameBand}`}
          data-testid={`pipeline-row-temp-${c.id}`}
        >
          <Flame className="w-4 h-4" />
          <span className="uppercase font-bold tracking-wider text-[10px]">{flameBand}</span>
        </span>

        {/* Emailed chip */}
        <span
          className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full border shrink-0 ${
            emailed
              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
              : "bg-stone-100 text-stone-500 border-stone-200"
          }`}
          data-testid={`pipeline-row-emailed-${c.id}`}
        >
          {emailed ? <Mail className="w-3 h-3" /> : <MailX className="w-3 h-3" />}
          {emailed ? "Emailed" : "Not emailed"}
        </span>

        {/* Chevron */}
        <span className="text-stone-400 shrink-0">
          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </span>
      </button>

      {/* Expanded panel — 4 sub-panels + actions row */}
      {isExpanded && (
        <div
          className="px-4 pb-5 pt-1 bg-stone-50/60 border-t border-stone-100"
          data-testid={`pipeline-row-expanded-${c.id}`}
        >
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-3 mt-3">
            <SummaryPanel contact={c} postcodeLink={postcodeLink} daysInStage={daysInStage} />
            <ChecklistPanel contact={c} onChanged={onContactUpdated} />
            <ActivityPanel contactId={c.id} />
            <NotesPanel contact={c} onChanged={onContactUpdated} />
          </div>

          {/* Actions row */}
          <div className="mt-4 flex flex-wrap gap-2 justify-end">
            <button
              type="button"
              onClick={() => onReplyContact?.(c, { mode: "quick" })}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-md bg-white text-stone-800 border-stone-300 hover:bg-stone-100"
              data-testid={`pipeline-row-quick-reply-${c.id}`}
            >
              <MessageSquare className="w-3 h-3" /> Quick Reply
            </button>
            <button
              type="button"
              onClick={() => onReplyContact?.(c, { mode: "template" })}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-md bg-stone-900 text-white border-stone-900 hover:bg-stone-800"
              data-testid={`pipeline-row-template-reply-${c.id}`}
            >
              <Send className="w-3 h-3" /> Reply with Template
            </button>
            <button
              type="button"
              onClick={() => onOpenContact?.(c)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-md bg-white text-stone-800 border-stone-300 hover:bg-stone-100"
              data-testid={`pipeline-row-view-correspondence-${c.id}`}
            >
              <FileText className="w-3 h-3" /> View Correspondence
            </button>
          </div>
        </div>
      )}
    </li>
  );
}


function PanelShell({ icon: Icon, title, children, testId }) {
  return (
    <section
      className="bg-white border border-stone-200 rounded-xl overflow-hidden flex flex-col"
      data-testid={testId}
    >
      <header className="flex items-center gap-1.5 px-3 py-2 border-b border-stone-100 bg-stone-50">
        {Icon && <Icon className="w-3 h-3 text-stone-500" />}
        <h4 className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">
          {title}
        </h4>
      </header>
      <div className="p-3 text-xs text-stone-800 flex-1 min-h-0">{children}</div>
    </section>
  );
}


function SummaryPanel({ contact, postcodeLink, daysInStage }) {
  const c = contact;
  const rows = [
    ["Email",    c.email],
    ["Phone",    c.telephone || c.phone],
    ["Postcode", c.postcode && postcodeLink
      ? <a href={postcodeLink} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">{c.postcode}</a>
      : c.postcode],
    ["First seen", c.date_added ? new Date(c.date_added).toLocaleDateString("en-GB") : (c.date || "—")],
    ["Days in stage", typeof daysInStage === "number" ? `${daysInStage}` : "—"],
  ];
  return (
    <PanelShell icon={FileText} title="Summary" testId="pipeline-panel-summary">
      <dl className="grid grid-cols-3 gap-y-1 gap-x-2">
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="col-span-1 text-stone-500">{k}</dt>
            <dd className="col-span-2 text-stone-900 truncate">{v || <span className="text-stone-400">—</span>}</dd>
          </React.Fragment>
        ))}
      </dl>
    </PanelShell>
  );
}


function ChecklistPanel({ contact, onChanged }) {
  // Only the Interested stage carries the real checklist today. For
  // NEW / CONTACTED / FOLLOW-UP DUE rows we still show the panel but
  // with a helper hint so the layout doesn't collapse asymmetrically.
  const isInterested = contact.pipeline_status === "qualified";
  return (
    <PanelShell icon={ClipboardCheck} title="Checklist" testId="pipeline-panel-checklist">
      {isInterested ? (
        <InterestedChecklist
          contact={contact}
          onChanged={(patch) => onChanged?.(contact.id, patch)}
        />
      ) : (
        <p className="text-stone-500 italic">
          Move this contact to <strong>Interested</strong> to enable the
          checklist (territory, contract, shadow day, training).
        </p>
      )}
    </PanelShell>
  );
}


function ActivityPanel({ contactId }) {
  return (
    <PanelShell icon={ActivityIcon} title="Activity" testId="pipeline-panel-activity">
      <div className="max-h-48 overflow-y-auto -mx-1 px-1">
        <EmailTimeline contactId={contactId} refreshSignal={0} />
      </div>
    </PanelShell>
  );
}


function NotesPanel({ contact, onChanged }) {
  return (
    <PanelShell icon={StickyNote} title="Notes" testId="pipeline-panel-notes">
      <AdminNotesEditor
        contact={contact}
        onUpdated={(id, notes, ts) =>
          onChanged?.(id, { admin_notes: notes, admin_notes_updated_at: ts })
        }
      />
    </PanelShell>
  );
}

