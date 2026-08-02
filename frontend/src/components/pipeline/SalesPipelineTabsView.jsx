// Sales Pipeline — Tabbed list view.
//
// Replaces the flat list on the Sales Pipeline tab with a four-tab
// layout (NEW / CONTACTED / FOLLOW-UP DUE / INTERESTED) whose rows
// expand in place to surface every action the drawer offers: full
// contact card + edit, Interested checklist, Convert-to-franchisee /
// licencee card, Move-to-stage pills, mark-follow-up-already-sent
// amber panel, sales notes, admin notes. Dormant + Lost stay on the
// kanban only (per PM decision, 2026-08-01).
//
// Row layout mirrors the reference mockup:
//   Name/email | Stage pill | Postcode + Map | Heat + score | Emailed
//   chip | Territory-plan action card | Chevron
// The columns have fixed widths so they line up down the whole list.
//
// Reuses `InterestedChecklist`, `AdminNotesEditor` and `EmailTimeline`
// via named re-exports from `ContactsPage.js` so this view never drifts
// from the drawer if the checklist / notes / email schemas evolve.

import React, { useMemo, useState } from "react";
import {
  Flame, MapPin, MessageSquare, FileText, ChevronDown, ChevronUp,
  Mail, MailX, Send, Target, Award, ArrowRightLeft, ArrowDownCircle,
  Link2, CheckCircle2, Calendar, Phone, Pencil, StickyNote,
} from "lucide-react";
import { InterestedChecklist, AdminNotesEditor } from "@/pages/ContactsPage";

const TABS = [
  { key: "new",           label: "New",            accent: "bg-stone-800",    dot: "bg-stone-400" },
  { key: "contacted",     label: "Contacted",      accent: "bg-blue-700",     dot: "bg-blue-400" },
  { key: "follow_up_due", label: "Follow-up Due",  accent: "bg-amber-700",    dot: "bg-amber-500" },
  { key: "qualified",     label: "Interested",     accent: "bg-emerald-700",  dot: "bg-emerald-500" },
];

// Stage pill styling — kept in sync with STAGES in ContactsPage.js.
const STAGE_PILL = {
  new:           { label: "New",           cls: "bg-stone-50 text-stone-700 border-stone-300", dot: "bg-stone-500" },
  contacted:     { label: "Contacted",     cls: "bg-blue-50 text-blue-700 border-blue-200",    dot: "bg-blue-500" },
  follow_up_due: { label: "Follow-up Due", cls: "bg-amber-50 text-amber-800 border-amber-300", dot: "bg-amber-500" },
  qualified:     { label: "Interested",    cls: "bg-emerald-50 text-emerald-800 border-emerald-200", dot: "bg-emerald-500" },
  dormant:       { label: "Dormant",       cls: "bg-orange-50 text-orange-800 border-orange-200", dot: "bg-orange-500" },
  lost:          { label: "Lost",          cls: "bg-red-50 text-red-700 border-red-200",       dot: "bg-red-500" },
};

// Score buckets match the backend LeadTemperature engine.
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

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export default function SalesPipelineTabsView({
  contacts,
  tempMap,
  onOpenContact,
  onReplyContact,
  onContactUpdated,
  onOpenPostcodeMap,
  onStageChange,
  onDemote,
  onConvert,
  onLinkExisting,
  onMarkFollowUpSent,
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
              onStageChange={onStageChange}
              onDemote={onDemote}
              onConvert={onConvert}
              onLinkExisting={onLinkExisting}
              onMarkFollowUpSent={onMarkFollowUpSent}
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
  onStageChange, onDemote, onConvert, onLinkExisting, onMarkFollowUpSent,
}) {
  const c = contact;
  const displayName = [c.first_name, c.last_name].filter(Boolean).join(" ") || "(no name)";
  const stage = STAGE_PILL[c.pipeline_status] || STAGE_PILL.new;
  const heat = heatFromScore(temp?.score);
  const heatScore = temp?.score ?? null;
  const emailed = (c.email_sends_count || 0) > 0;
  const daysInStage = daysSinceISO(c.pipeline_status_updated_at || c.updated_at || c.date_added);
  const linkedPlan = c.linked_plan || null;

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

        <div className="flex items-center">
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold uppercase tracking-wider border rounded-full ${stage.cls}`}
            data-testid={`pipeline-row-stage-${c.id}`}
          >
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${stage.dot}`} />
            {stage.label}
          </span>
        </div>

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

        <TerritoryPlanCard contact={c} linkedPlan={linkedPlan} onClick={(e) => e.stopPropagation()} />

        <div className="text-stone-400 justify-self-end">
          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </div>

      {isExpanded && (
        <div
          className="px-4 pb-5 pt-1 bg-stone-50/60 border-t border-stone-100"
          data-testid={`pipeline-row-expanded-${c.id}`}
        >
          {/* Row 1 — 4 panels: Summary · Checklist · Convert · Notes.
              Mirrors the drawer's vertical stack, laid out horizontally
              here for at-a-glance actioning. */}
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-3 mt-3 items-start">
            <SummaryPanel contact={c} onOpenPostcodeMap={onOpenPostcodeMap} onEdit={() => onOpenContact?.(c)} />
            <ChecklistPanel contact={c} onChanged={onContactUpdated} />
            <ConvertPanel
              contact={c}
              onConvert={onConvert}
              onLinkExisting={onLinkExisting}
            />
            <NotesPanel contact={c} onChanged={onContactUpdated} />
          </div>

          {/* Row 2 — Move to Stage pills + Mark Follow-up amber panel +
              Remove from pipeline. Mirrors the drawer's action strip. */}
          <div className="mt-3 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 items-start">
            <StageActionsPanel
              contact={c}
              onStageChange={onStageChange}
              onDemote={onDemote}
            />
            <FollowUpPanel
              contact={c}
              onMarkFollowUpSent={onMarkFollowUpSent}
            />
          </div>

          {/* Action buttons — kept below so they don't compete with
              the panels above for visual weight. */}
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

// ---------------------------------------------------------------------
// Territory-plan action card ("Plan their territory" ↔ "Territory plan
// linked") — anchor so we can wrap the whole row in an <a> without
// swallowing the row's expand-toggle click.
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

// ---------------------------------------------------------------------
// Panel shell — matches the drawer's rounded-outline card style so the
// tabs view feels visually of-a-piece with the rest of the CRM.
function PanelShell({ icon: Icon, title, children, testId, tone = "default", noBodyPadding = false }) {
  const toneCls = {
    default: "bg-white border-stone-200",
    tinted:  "bg-gradient-to-br from-[#dddd16]/10 to-stone-50 border-stone-300",
    amber:   "bg-amber-50 border-amber-200",
    emerald: "bg-emerald-50 border-emerald-200",
  }[tone];
  return (
    <section
      className={`border rounded-xl overflow-hidden flex flex-col ${toneCls}`}
      data-testid={testId}
    >
      {title && (
        <header className="flex items-center gap-1.5 px-3 py-2 border-b border-stone-100/70 bg-white/40">
          {Icon && <Icon className="w-3 h-3 text-stone-500" />}
          <h4 className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">
            {title}
          </h4>
        </header>
      )}
      <div className={noBodyPadding ? "flex-1 min-h-0" : "p-3 text-xs text-stone-800 flex-1 min-h-0"}>
        {children}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------
// Summary — matches the drawer's contact card layout: email, phone,
// full address (street/city/country + postcode + MAP button), first-
// seen date and "days ago". EDIT button opens the drawer for full
// inline editing (no need to reimplement the address form here).
function SummaryPanel({ contact, onOpenPostcodeMap, onEdit }) {
  const c = contact;
  const addressLines = [
    c.address_line_1,
    c.address_line_2,
    c.city,
  ].filter(Boolean);
  const daysAgo = daysSinceISO(c.date_added || c.date);
  return (
    <PanelShell icon={FileText} title="Summary" testId="pipeline-panel-summary">
      <div className="flex items-start gap-2">
        <Mail className="w-3.5 h-3.5 text-stone-400 mt-0.5 shrink-0" />
        <span className="break-all">{c.email || <span className="text-stone-400">—</span>}</span>
      </div>
      <div className="flex items-start gap-2 mt-1.5">
        <Phone className="w-3.5 h-3.5 text-stone-400 mt-0.5 shrink-0" />
        <span>{c.telephone || c.phone || <span className="text-stone-400">—</span>}</span>
      </div>
      <div className="flex items-start gap-2 mt-1.5">
        <MapPin className="w-3.5 h-3.5 text-stone-400 mt-0.5 shrink-0" />
        <div className="min-w-0">
          {addressLines.map((ln) => <div key={ln} className="truncate">{ln}</div>)}
          {c.postcode && (
            <div className="flex items-center gap-1.5 mt-0.5">
              <span>{c.postcode}</span>
              <button
                type="button"
                onClick={() => onOpenPostcodeMap?.(c)}
                data-testid={`pipeline-panel-summary-map-btn-${c.id}`}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 rounded hover:bg-stone-100 text-stone-700"
              >
                <MapPin className="w-2.5 h-2.5" /> Map
              </button>
            </div>
          )}
          {c.country && <div className="text-stone-500">{c.country}</div>}
          {addressLines.length === 0 && !c.postcode && (
            <span className="text-stone-400 italic">no address on file</span>
          )}
        </div>
      </div>
      <div className="flex items-start gap-2 mt-1.5">
        <Calendar className="w-3.5 h-3.5 text-stone-400 mt-0.5 shrink-0" />
        <span>
          {formatDate(c.date_added || c.date)}
          {typeof daysAgo === "number" && <span className="text-stone-500"> · {daysAgo} days ago</span>}
        </span>
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider border border-stone-300 rounded hover:bg-stone-100 text-stone-700"
          data-testid={`pipeline-panel-summary-edit-${c.id}`}
        >
          <Pencil className="w-2.5 h-2.5" /> Edit
        </button>
      </div>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------
// Checklist — reuses the exact `<InterestedChecklist>` from the drawer.
// The widget carries its own heading + tinted blue border, so we
// intentionally render the panel WITHOUT its own title (no duplicate
// "CHECKLIST" label). The panel shell just gives it a rounded outer
// container consistent with the rest of the row.
function ChecklistPanel({ contact, onChanged }) {
  const isInterested = contact.pipeline_status === "qualified";
  if (isInterested) {
    return (
      <div data-testid="pipeline-panel-checklist" className="min-w-0">
        <InterestedChecklist
          contact={contact}
          onChanged={(patch) => onChanged?.(contact.id, patch)}
        />
      </div>
    );
  }
  return (
    <PanelShell icon={FileText} title="Checklist" testId="pipeline-panel-checklist">
      <p className="text-stone-500 italic">
        Move this contact to <strong>Interested</strong> to enable the
        checklist (territory, contract, shadow day, training).
      </p>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------
// Convert to Franchisee / Licencee — mirrors the drawer's yellow-tinted
// card. Confirms via window.confirm (same UX as the drawer) so an
// accidental click doesn't spawn a franchisee record.
function ConvertPanel({ contact, onConvert, onLinkExisting }) {
  const [converting, setConverting] = useState(false);
  const isLicenceEnq = contact.source === "licence_enquiry";
  const convertLabel = isLicenceEnq ? "Convert to Licencee" : "Convert to Franchisee";
  const alreadyConverted = !!contact.converted_to_franchisee_id;

  return (
    <PanelShell
      testId="pipeline-panel-convert"
      tone={alreadyConverted ? "emerald" : "tinted"}
      title={null}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-stone-950 flex items-center gap-1.5">
            <Award className={`w-3.5 h-3.5 ${alreadyConverted ? "text-emerald-700" : "text-stone-700"}`} />
            {alreadyConverted ? "Already converted" : convertLabel}
          </div>
          <div className="text-[11px] text-stone-600 mt-1">
            {alreadyConverted
              ? <>Converted to a {contact.converted_to_record_type === "licencee" ? "Licencee" : "Franchisee"} record.</>
              : <>Create a {isLicenceEnq ? "Licencee" : "Franchisee"} record from this enquiry.</>}
          </div>
        </div>
        {alreadyConverted ? (
          <button
            type="button"
            onClick={() => onConvert?.(contact, true)}
            data-testid={`pipeline-panel-convert-view-${contact.id}`}
            className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-white text-emerald-800 border border-emerald-300 hover:bg-emerald-100 rounded-lg"
          >
            <ArrowRightLeft className="w-3 h-3" /> View
          </button>
        ) : (
          <button
            type="button"
            onClick={async () => {
              const label = convertLabel;
              const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "this contact";
              if (!window.confirm(`${label} for ${name}?`)) return;
              setConverting(true);
              try { await onConvert?.(contact, false); }
              finally { setConverting(false); }
            }}
            disabled={converting}
            data-testid={`pipeline-panel-convert-btn-${contact.id}`}
            className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg disabled:opacity-50"
          >
            <Award className="w-3 h-3" /> {converting ? "Converting…" : "Convert"}
          </button>
        )}
      </div>
      {!alreadyConverted && onLinkExisting && (
        <div className="mt-3 pt-3 border-t border-stone-200/70">
          <div className="text-[11px] text-stone-600 mb-2">
            Already in the franchisees list? Link to the existing record.
          </div>
          <button
            type="button"
            onClick={() => onLinkExisting?.(contact)}
            data-testid={`pipeline-panel-convert-link-existing-${contact.id}`}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-white text-stone-800 border border-stone-300 hover:bg-stone-50 rounded-lg"
          >
            <Link2 className="w-3 h-3" /> Link to existing
          </button>
        </div>
      )}
    </PanelShell>
  );
}

// ---------------------------------------------------------------------
// Notes — reuses the drawer's `<AdminNotesEditor>` which brings its own
// header + save button. We skip the panel title to avoid the duplicate-
// heading trap that was flagged on the earlier draft.
function NotesPanel({ contact, onChanged }) {
  return (
    <div data-testid="pipeline-panel-notes" className="min-w-0 border border-stone-200 rounded-xl bg-white p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <StickyNote className="w-3 h-3 text-stone-500" />
        <h4 className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Notes</h4>
      </div>
      <AdminNotesEditor
        contact={contact}
        onUpdated={(id, notes, ts) =>
          onChanged?.(id, { admin_notes: notes, admin_notes_updated_at: ts })
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------
// Move-to-Stage pills — round buttons, one per stage. Current stage is
// highlighted with its stage colour; others sit in a neutral outline.
// Also carries the "Remove from sales pipeline" button, same as the
// drawer.
const MOVE_STAGES = [
  { key: "new",           label: "New" },
  { key: "contacted",     label: "Contacted" },
  { key: "follow_up_due", label: "Follow-up Due" },
  { key: "qualified",     label: "Interested" },
  { key: "dormant",       label: "Dormant" },
  { key: "lost",          label: "Lost" },
];

function StageActionsPanel({ contact, onStageChange, onDemote }) {
  return (
    <PanelShell testId="pipeline-panel-stage" title="Move to Stage">
      <div className="grid grid-cols-3 gap-2">
        {MOVE_STAGES.map((s) => {
          const isCurrent = contact.pipeline_status === s.key;
          const stagePill = STAGE_PILL[s.key] || STAGE_PILL.new;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => onStageChange?.(contact.id, s.key)}
              disabled={isCurrent}
              className={`px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider border rounded-full transition-colors ${
                isCurrent
                  ? `${stagePill.cls} border-current cursor-default`
                  : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"
              }`}
              data-testid={`pipeline-panel-stage-${s.key}-${contact.id}`}
            >
              {s.label}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => onDemote?.(contact.id)}
        className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 rounded-lg"
        data-testid={`pipeline-panel-demote-${contact.id}`}
      >
        <ArrowDownCircle className="w-3 h-3" /> Remove from sales pipeline
      </button>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------
// Mark Follow-up Already Sent — amber panel that only appears when the
// contact hasn't yet been logged as followed-up. Flips into an emerald
// "Follow-up recorded" chip after the click, matching the drawer.
function FollowUpPanel({ contact, onMarkFollowUpSent }) {
  const alreadyRecorded = Number(contact.follow_up_sent_count || 0) >= 1;
  if (!onMarkFollowUpSent) return <div aria-hidden />;
  if (alreadyRecorded) {
    return (
      <PanelShell testId="pipeline-panel-followup" tone="emerald" title="Follow-up status">
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-md">
          <CheckCircle2 className="w-3 h-3" /> Follow-up recorded
        </div>
      </PanelShell>
    );
  }
  return (
    <PanelShell testId="pipeline-panel-followup" tone="amber" title="Follow-up status">
      <div className="text-[11px] text-amber-900 mb-2">
        Already sent a follow-up outside the system? Mark it as done so
        this contact won&apos;t drop into <strong>Follow-up Due</strong>.
      </div>
      <button
        type="button"
        onClick={() => onMarkFollowUpSent?.(contact.id)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-amber-600 text-white hover:bg-amber-700 rounded-lg"
        data-testid={`pipeline-panel-mark-followup-${contact.id}`}
      >
        <CheckCircle2 className="w-3 h-3" /> Mark follow-up already sent
      </button>
    </PanelShell>
  );
}
