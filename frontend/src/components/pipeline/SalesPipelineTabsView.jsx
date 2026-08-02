// Sales Pipeline — Tabbed list view.
//
// Replaces the flat list on the Sales Pipeline tab with a four-tab
// layout (NEW / CONTACTED / FOLLOW-UP DUE / INTERESTED) whose rows
// expand in place to reveal Summary / Checklist / Activity / Notes
// side-by-side plus quick-action buttons. Dormant + Lost stay on the
// kanban only (per PM decision, 2026-08-01).
//
// Row layout mirrors the reference mockup:
//   Name/email | Stage pill | Postcode + Map | Heat + score | Emailed
//   | Territory plan action card | Chevron
// The columns have fixed widths so they line up down the whole list
// (bunched-up-on-the-right was the first-pass mistake — fixed here).
//
// Reuses `InterestedChecklist`, `AdminNotesEditor` and `EmailTimeline`
// via named re-exports from `ContactsPage.js` so this view never
// drifts from the drawer if the checklist / notes schema evolves.

import React, { useMemo, useState } from "react";
import {
  Flame, MapPin, MessageSquare, FileText, ChevronDown, ChevronUp,
  Mail, MailX, Send, ClipboardCheck, Activity as ActivityIcon,
  StickyNote, Target,
} from "lucide-react";
import EmailTimeline from "@/components/EmailTimeline";
import { InterestedChecklist, AdminNotesEditor } from "@/pages/ContactsPage";

// Order matches the mockup left→right. Colours line up with STAGES in
// ContactsPage.js so the stage pill stays visually consistent between
// the tabs view and the kanban.
const TABS = [
  { key: "new",           label: "New",            accent: "bg-stone-800",    dot: "bg-stone-400" },
  { key: "contacted",     label: "Contacted",      accent: "bg-blue-700",     dot: "bg-blue-400" },
  { key: "follow_up_due", label: "Follow-up Due",  accent: "bg-amber-700",    dot: "bg-amber-500" },
  { key: "qualified",     label: "Interested",     accent: "bg-emerald-700",  dot: "bg-emerald-500" },
];

// Kept in sync with STAGES in ContactsPage.js — see comment there.
const STAGE_PILL = {
  new:           { label: "New",           cls: "bg-stone-50 text-stone-700 border-stone-300", dot: "bg-stone-500" },
  contacted:     { label: "Contacted",     cls: "bg-blue-50 text-blue-700 border-blue-200",    dot: "bg-blue-500" },
  follow_up_due: { label: "Follow-up Due", cls: "bg-amber-50 text-amber-800 border-amber-300", dot: "bg-amber-500" },
  qualified:     { label: "Interested",    cls: "bg-emerald-50 text-emerald-800 border-emerald-200", dot: "bg-emerald-500" },
};

// Heat score → flame colour + band label. Score buckets match the
// backend LeadTemperature engine (see `contacts/{id}/temperature`).
function heatFromScore(score) {
  const s = Number(score) || 0;
  if (s >= 60) return { label: "Hot",  colour: "text-red-600" };
  if (s >= 30) return { label: "Warm", colour: "text-amber-500" };
  if (s >= 10) return { label: "Cool", colour: "text-sky-500" };
  return         { label: "Cold", colour: "text-blue-500" };
}

function daysSinceISO(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000));
}

export default function SalesPipelineTabsView({
  contacts,
  tempMap,
  onOpenContact,
  onReplyContact,
  onContactUpdated,
  onOpenPostcodeMap,
}) {
  const [activeTab, setActiveTab] = useState("new");
  const [expandedId, setExpandedId] = useState(null);

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
              onOpenPostcodeMap={onOpenPostcodeMap}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PipelineRow({
  contact, temp, isExpanded, onToggle,
  onOpenContact, onReplyContact, onContactUpdated, onOpenPostcodeMap,
}) {
  const c = contact;
  const displayName = [c.first_name, c.last_name].filter(Boolean).join(" ") || "(no name)";
  const stage = STAGE_PILL[c.pipeline_status] || STAGE_PILL.new;
  const heat = heatFromScore(temp?.score);
  const heatScore = temp?.score ?? null;
  const emailed = (c.email_sends_count || 0) > 0;
  const daysInStage = daysSinceISO(c.pipeline_status_updated_at || c.updated_at || c.date_added);
  const linkedPlan = c.linked_plan || null;

  // Rendered as two rows inside a single container so the compact
  // row + expanded panels share a hover / focus outline. The header
  // itself is a <div> (not a <button>) so we can nest interactive
  // elements — MAP, Territory-plan links, action buttons — without
  // breaking a11y.
  return (
    <li data-testid={`pipeline-row-${c.id}`} className="bg-white">
      <div
        className={`grid grid-cols-[minmax(0,1fr)_130px_150px_100px_130px_260px_28px] gap-3 items-center px-4 py-3 cursor-pointer hover:bg-stone-50 transition-colors ${
          isExpanded ? "bg-stone-50" : ""
        }`}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        data-testid={`pipeline-row-toggle-${c.id}`}
      >
        {/* Name / email / days-in-stage */}
        <div className="min-w-0">
          <div className="text-sm font-semibold text-stone-950 truncate">
            {displayName}
            {typeof daysInStage === "number" && (
              <span className="ml-2 text-[11px] font-normal text-stone-400">
                · {daysInStage}d in stage
              </span>
            )}
          </div>
          <div className="text-[11px] text-stone-500 truncate mt-0.5">
            {c.email || <span className="italic">no email</span>}
            {c.establishment_name && <span className="ml-1 text-stone-400"> · {c.establishment_name}</span>}
          </div>
        </div>

        {/* Stage pill */}
        <div className="flex items-center">
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold uppercase tracking-wider border rounded-full ${stage.cls}`}
            data-testid={`pipeline-row-stage-${c.id}`}
          >
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${stage.dot}`} />
            {stage.label}
          </span>
        </div>

        {/* Postcode + MAP button */}
        <div className="flex items-center gap-2 text-xs text-stone-700 min-w-0">
          {c.postcode ? (
            <>
              <span className="truncate" data-testid={`pipeline-row-postcode-${c.id}`}>{c.postcode}</span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onOpenPostcodeMap?.(c); }}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 rounded hover:bg-stone-100 text-stone-700 shrink-0"
                data-testid={`pipeline-row-postcode-map-btn-${c.id}`}
                title={`See ${c.postcode} on the UK territory atlas`}
              >
                <MapPin className="w-2.5 h-2.5" /> Map
              </button>
            </>
          ) : (
            <span className="text-stone-400 italic text-[11px]">no postcode</span>
          )}
        </div>

        {/* Heat — flame + score number */}
        <div
          className={`flex items-center gap-1.5 text-xs ${heat.colour}`}
          data-testid={`pipeline-row-temp-${c.id}`}
          title={heatScore != null ? `Auto-score: ${heatScore}` : "No heat yet"}
        >
          <Flame className="w-4 h-4" />
          <span className="tabular-nums font-bold text-sm">
            {heatScore != null ? heatScore : "—"}
          </span>
          <span className="uppercase font-bold tracking-wider text-[9px] text-stone-500">
            {heat.label}
          </span>
        </div>

        {/* Email status chip */}
        <div>
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full border ${
              emailed
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : "bg-stone-100 text-stone-500 border-stone-200"
            }`}
            data-testid={`pipeline-row-emailed-${c.id}`}
          >
            {emailed ? <Mail className="w-3 h-3" /> : <MailX className="w-3 h-3" />}
            {emailed ? "Emailed" : "Not emailed"}
          </span>
        </div>

        {/* Territory plan action card */}
        <TerritoryPlanCard contact={c} linkedPlan={linkedPlan} onClick={(e) => e.stopPropagation()} />

        {/* Chevron */}
        <div className="text-stone-400 justify-self-end">
          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </div>

      {isExpanded && (
        <div
          className="px-4 pb-5 pt-1 bg-stone-50/60 border-t border-stone-100"
          data-testid={`pipeline-row-expanded-${c.id}`}
        >
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-3 mt-3">
            <SummaryPanel contact={c} daysInStage={daysInStage} onOpenPostcodeMap={onOpenPostcodeMap} />
            <ChecklistPanel contact={c} onChanged={onContactUpdated} />
            <ActivityPanel contactId={c.id} />
            <NotesPanel contact={c} onChanged={onContactUpdated} />
          </div>

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

// "Plan their territory" / "Territory plan linked" — flips its CTA
// based on whether the contact has a linked plan (surfaced by the
// backend `linked_plan` enrichment). Anchors so we can wrap it in an
// <a> without swallowing the row's click handler.
function TerritoryPlanCard({ contact, linkedPlan, onClick }) {
  const href = linkedPlan
    ? `/territory-builder?plan_id=${linkedPlan.id}`
    : `/territory-builder?contact_id=${contact.id}`;
  const label = linkedPlan ? "Territory plan linked" : "Plan their territory";
  const cta   = linkedPlan ? "See linked plan"       : "Open builder";
  const sub = linkedPlan
    ? [
        linkedPlan.name ? `Linked plan: ${linkedPlan.name}` : "Linked plan",
        typeof linkedPlan.total_homes === "number" ? `${linkedPlan.total_homes} homes` : null,
        typeof linkedPlan.sectors_count === "number" ? `${linkedPlan.sectors_count} sectors` : null,
      ].filter(Boolean).join(" · ")
    : "Build a sample territory plan for this contact.";
  return (
    <a
      href={href}
      onClick={onClick}
      className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg border text-[11px] ${
        linkedPlan
          ? "bg-emerald-50 border-emerald-200 hover:bg-emerald-100"
          : "bg-stone-50 border-stone-200 hover:bg-stone-100"
      }`}
      data-testid={`pipeline-row-territory-plan-${contact.id}`}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <Target className={`w-3.5 h-3.5 shrink-0 ${linkedPlan ? "text-emerald-700" : "text-stone-500"}`} />
        <div className="min-w-0">
          <div className={`font-semibold truncate ${linkedPlan ? "text-emerald-900" : "text-stone-900"}`}>
            {label}
          </div>
          <div className={`truncate text-[10px] ${linkedPlan ? "text-emerald-700" : "text-stone-500"}`}>
            {sub}
          </div>
        </div>
      </div>
      <span
        className={`shrink-0 px-2 py-1 text-[9px] font-bold uppercase tracking-wider rounded ${
          linkedPlan ? "bg-emerald-700 text-white" : "bg-stone-900 text-white"
        }`}
      >
        {cta}
      </span>
    </a>
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

function SummaryPanel({ contact, daysInStage, onOpenPostcodeMap }) {
  const c = contact;
  const rows = [
    ["Email",    c.email],
    ["Phone",    c.telephone || c.phone],
    ["Postcode", c.postcode ? (
      <span className="inline-flex items-center gap-1.5">
        {c.postcode}
        <button
          type="button"
          onClick={() => onOpenPostcodeMap?.(c)}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 rounded hover:bg-stone-100 text-stone-700"
          data-testid={`pipeline-panel-summary-map-btn-${c.id}`}
        >
          <MapPin className="w-2.5 h-2.5" /> Map
        </button>
      </span>
    ) : null],
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
