// Sales Pipeline — Tabbed list view.
//
// Replaces the flat list on the Sales Pipeline tab with four full-
// width tabs (NEW / CONTACTED / FOLLOW-UP DUE / INTERESTED). Rows
// expand in place. Expanded rows surface every drawer action inline:
// contact card + inline edit, Plan-their-territory, running notes,
// Convert-to-franchisee, Move-to-stage pills, mark-follow-up-already-
// sent. Dormant + Lost stay on the kanban only (per PM decision).
//
// Row layout (compact):
//   Name/email | Stage pill | Postcode + Map | Heat + score | Emailed
//   | Territory-plan card | Chevron
//
// Expanded layout (matching the reference mockup):
//   Header strip tinted by lead temperature (blue = cold, purple =
//       warm, orange = hot) — carries the same info as the compact
//       row but bigger + with a subject-initials avatar.
//   Row 1 (4 columns): Summary + inline edit | Plan territory |
//       Notes | Convert to franchisee/licencee
//   Row 2 (2 columns): Move to Stage pills   | Follow-up status
//   Action buttons: Quick reply / Reply with template / View
//       correspondence
//
// Reuses `AdminNotesEditor` via named re-export from `ContactsPage.js`.

import React, { useState } from "react";
import api from "@/lib/api";
import {
  Flame, MapPin, MessageSquare, FileText, ChevronDown, ChevronUp,
  Mail, MailX, Send, Target, Award, ArrowDownCircle,
  Link2, CheckCircle2, Calendar, Phone, Pencil, StickyNote,
  User as UserIcon, Clock, Save, X as XIcon,
} from "lucide-react";
import { AdminNotesEditor } from "@/pages/ContactsPage";

const TABS = [
  { key: "new",           label: "New",            accent: "bg-stone-800",    dot: "bg-stone-400" },
  { key: "contacted",     label: "Contacted",      accent: "bg-blue-700",     dot: "bg-blue-400" },
  { key: "follow_up_due", label: "Follow-up Due",  accent: "bg-amber-700",    dot: "bg-amber-500" },
  { key: "qualified",     label: "Interested",     accent: "bg-emerald-700",  dot: "bg-emerald-500" },
];

// Stage pill styling — kept in sync with STAGES in ContactsPage.js.
// Each entry also declares an ``activeCls`` used to highlight the
// current stage in the Move-to-Stage pill grid (per Aug 2 spec).
const STAGE_PILL = {
  new: {
    label: "New",           cls: "bg-stone-50 text-stone-700 border-stone-300",   dot: "bg-stone-500",
    activeCls: "bg-white text-stone-900 border-stone-900 ring-1 ring-stone-900/40",
  },
  contacted: {
    label: "Contacted",     cls: "bg-blue-50 text-blue-700 border-blue-200",      dot: "bg-blue-500",
    activeCls: "bg-blue-50 text-blue-900 border-blue-600 ring-1 ring-blue-600/40",
  },
  follow_up_due: {
    label: "Follow-up Due", cls: "bg-amber-50 text-amber-800 border-amber-300",   dot: "bg-amber-500",
    activeCls: "bg-amber-50 text-amber-900 border-amber-600 ring-1 ring-amber-600/40",
  },
  qualified: {
    label: "Interested",    cls: "bg-emerald-50 text-emerald-800 border-emerald-200", dot: "bg-emerald-500",
    activeCls: "bg-emerald-50 text-emerald-900 border-emerald-600 ring-1 ring-emerald-600/40",
  },
  dormant: {
    label: "Dormant",       cls: "bg-orange-50 text-orange-800 border-orange-200", dot: "bg-orange-500",
    activeCls: "bg-orange-50 text-orange-900 border-orange-600 ring-1 ring-orange-600/40",
  },
  lost: {
    label: "Lost",          cls: "bg-red-50 text-red-700 border-red-200",         dot: "bg-red-500",
    activeCls: "bg-red-50 text-red-900 border-red-600 ring-1 ring-red-600/40",
  },
};

// Three-tier heat scale matching the flame-swatch reference (Aug 2):
//   COLD → blue, WARM → purple, HOT → orange.
// The `header` classes tint the expanded-panel header strip so the
// admin can gauge lead temperature at a glance without reading the
// flame label.
const HEAT = {
  cold: {
    label: "Cold",
    flame:  "text-blue-500",
    // Whole-card tint applied to the expanded panel — mockup shows the
    // heat colour wrapping the entire contact card, not just the
    // header. Panels inside sit on white so content stays readable.
    header: "bg-gradient-to-b from-blue-100 via-blue-50 to-white border-blue-200",
    card:   "bg-gradient-to-b from-blue-100/70 via-blue-50/40 to-white border-blue-200",
  },
  warm: {
    label: "Warm",
    flame:  "text-purple-500",
    header: "bg-gradient-to-b from-purple-100 via-purple-50 to-white border-purple-200",
    card:   "bg-gradient-to-b from-purple-100/70 via-purple-50/40 to-white border-purple-200",
  },
  hot: {
    label: "Hot",
    flame:  "text-orange-600",
    header: "bg-gradient-to-b from-orange-100 via-orange-50 to-white border-orange-200",
    card:   "bg-gradient-to-b from-orange-100/70 via-orange-50/40 to-white border-orange-200",
  },
};

function heatFromScore(score) {
  const s = Number(score) || 0;
  if (s >= 50) return "hot";
  if (s >= 20) return "warm";
  return "cold";
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

function initialsFor(contact) {
  const parts = [contact.first_name, contact.last_name].filter(Boolean);
  if (parts.length === 0) return (contact.email || "??")[0].toUpperCase() + "?";
  return parts.map((p) => p[0]).join("").slice(0, 2).toUpperCase();
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

  const buckets = React.useMemo(() => {
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
  const heatKey = heatFromScore(temp?.score);
  const heat = HEAT[heatKey];
  const heatScore = temp?.score ?? null;
  const emailed = (c.email_sends_count || 0) > 0;
  const daysInStage = daysSinceISO(c.pipeline_status_updated_at || c.updated_at || c.date_added);

  // Two render paths — a compact row when collapsed, and a full-
  // width tinted card when expanded (matches the Aug 2 mockup).
  return (
    <li
      data-testid={`pipeline-row-${c.id}`}
      className="bg-white"
    >
      {!isExpanded && (
        <CompactRow
          contact={c}
          stage={stage}
          heat={heat}
          heatScore={heatScore}
          emailed={emailed}
          daysInStage={daysInStage}
          onToggle={onToggle}
          onOpenPostcodeMap={onOpenPostcodeMap}
        />
      )}
      {isExpanded && (
        <ExpandedCard
          contact={c}
          stage={stage}
          heatKey={heatKey}
          heat={heat}
          heatScore={heatScore}
          emailed={emailed}
          daysInStage={daysInStage}
          displayName={displayName}
          onToggle={onToggle}
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
      )}
    </li>
  );
}

// ---------------------------------------------------------------------
// Compact row — the default 7-column layout for un-expanded contacts.
function CompactRow({ contact, stage, heat, heatScore, emailed, daysInStage, onToggle, onOpenPostcodeMap }) {
  const c = contact;
  const displayName = [c.first_name, c.last_name].filter(Boolean).join(" ") || "(no name)";
  const linkedPlan = c.linked_plan || null;
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_130px_150px_100px_130px_260px_28px] gap-3 items-center px-4 py-3 cursor-pointer hover:bg-stone-50 transition-colors"
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
        className={`flex items-center gap-1.5 text-xs ${heat.flame}`}
        data-testid={`pipeline-row-temp-${c.id}`}
        title={heatScore != null ? `Auto-score: ${heatScore}` : "No heat yet"}
      >
        <Flame className="w-4 h-4" />
        <span className="uppercase font-bold tracking-wider text-[10px]">{heat.label}</span>
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
        <ChevronDown className="w-4 h-4" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Expanded card — full-width tinted panel matching the mockup.
function ExpandedCard({
  contact, stage, heatKey, heat, heatScore, emailed, daysInStage, displayName,
  onToggle, onOpenContact, onReplyContact, onContactUpdated, onOpenPostcodeMap,
  onStageChange, onDemote, onConvert, onLinkExisting, onMarkFollowUpSent,
}) {
  const c = contact;
  return (
    <div
      className={`border rounded-2xl m-3 overflow-hidden shadow-sm ${heat.card}`}
      data-testid={`pipeline-row-expanded-${c.id}`}
    >
      {/* Header strip — sits inside the heat-tinted card. Extra border-
          below adds separation before the white body panels below. */}
      <div className="flex items-center gap-4 px-5 py-4 border-b border-stone-200/60">
        <div className="w-11 h-11 rounded-full bg-white/70 text-stone-800 font-bold text-sm flex items-center justify-center border border-white/50 shrink-0">
          {initialsFor(c)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <div className="text-lg font-bold text-stone-950 truncate">{displayName}</div>
            {typeof daysInStage === "number" && (
              <div className="text-xs text-stone-600 shrink-0">{daysInStage} in stage</div>
            )}
          </div>
          <div className="text-xs text-stone-700 truncate">{c.email}</div>
        </div>
        <span className={`inline-flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold uppercase tracking-wider border rounded-full ${stage.cls}`}>
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${stage.dot}`} />
          {stage.label}
        </span>
        {c.postcode && (
          <div className="flex items-center gap-2 text-xs text-stone-800">
            <span className="font-semibold">{c.postcode}</span>
            <button
              type="button"
              onClick={() => onOpenPostcodeMap?.(c)}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider border border-stone-400 rounded hover:bg-white/60 text-stone-700"
              data-testid={`pipeline-expanded-postcode-map-${c.id}`}
            >
              <MapPin className="w-2.5 h-2.5" /> Map
            </button>
          </div>
        )}
        <div className={`flex items-center gap-1.5 text-xs ${heat.flame}`}>
          <Flame className="w-4 h-4" />
          <span className="uppercase font-bold tracking-wider text-[10px]">{heat.label}</span>
        </div>
        <span
          className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full border ${
            emailed
              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
              : "bg-white/70 text-stone-600 border-stone-300"
          }`}
        >
          {emailed ? <Mail className="w-3 h-3" /> : <MailX className="w-3 h-3" />}
          {emailed ? "Emailed" : "Not emailed"}
        </span>
        <button
          type="button"
          onClick={onToggle}
          className="text-stone-500 hover:text-stone-800"
          data-testid={`pipeline-expanded-collapse-${c.id}`}
        >
          <ChevronUp className="w-5 h-5" />
        </button>
      </div>

      {/* Body — sits directly on the heat-tinted card so the wash is
          visible around each white panel, matching the mockup. */}
      <div className="p-4 space-y-4">
        {/* Row 1 — 4 columns */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-3 items-start">
          <SummaryPanel
            contact={c}
            daysInStage={daysInStage}
            onOpenPostcodeMap={onOpenPostcodeMap}
            onSaved={(patch) => onContactUpdated?.(c.id, patch)}
          />
          <TerritoryPanel contact={c} />
          <NotesPanel contact={c} onChanged={onContactUpdated} />
          <ConvertPanel
            contact={c}
            onConvert={onConvert}
            onLinkExisting={onLinkExisting}
          />
        </div>

        {/* Row 2 — Stage pills + follow-up */}
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] gap-3 items-start">
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

        {/* Actions */}
        <div className="flex flex-wrap gap-2 justify-end pt-2">
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
    </div>
  );
}

// ---------------------------------------------------------------------
// Compact territory-plan card (shown in the collapsed row).
function TerritoryPlanCard({ contact, linkedPlan, onClick }) {
  const href = linkedPlan
    ? `/territory-builder?plan_id=${linkedPlan.id}`
    : `/territory-builder?contact_id=${contact.id}`;
  const label = linkedPlan ? "Territory plan linked" : "Plan their territory";
  const cta   = linkedPlan ? "See linked plan"       : "Open builder";
  const sub = linkedPlan
    ? [
        linkedPlan.name ? `Linked: ${linkedPlan.name}` : "Linked plan",
        typeof linkedPlan.total_homes === "number" ? `${linkedPlan.total_homes} homes` : null,
      ].filter(Boolean).join(" · ")
    : "Build a mental territory plan for this contact.";
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
          <div className={`font-semibold truncate ${linkedPlan ? "text-emerald-900" : "text-stone-900"}`}>{label}</div>
          <div className={`truncate text-[10px] ${linkedPlan ? "text-emerald-700" : "text-stone-500"}`}>{sub}</div>
        </div>
      </div>
      <span
        className={`shrink-0 px-2 py-1 text-[9px] font-bold uppercase tracking-wider rounded ${
          linkedPlan ? "bg-emerald-700 text-white" : "bg-stone-900 text-white"
        }`}
      >{cta}</span>
    </a>
  );
}

// ---------------------------------------------------------------------
// Panel shell — matches the drawer's rounded-outline card style so the
// tabs view feels visually of-a-piece with the rest of the CRM.
function PanelShell({ icon: Icon, title, action, children, testId, tone = "default" }) {
  const toneCls = {
    default: "bg-white border-stone-200",
    tinted:  "bg-gradient-to-br from-[#dddd16]/25 to-white border-[#dddd16]/40",
    amber:   "bg-amber-50 border-amber-200",
    emerald: "bg-emerald-50 border-emerald-200",
  }[tone];
  return (
    <section
      className={`border rounded-xl overflow-hidden flex flex-col ${toneCls}`}
      data-testid={testId}
    >
      <header className="flex items-center gap-1.5 px-3 py-2 border-b border-stone-100/70 bg-white/40">
        {Icon && <Icon className="w-3.5 h-3.5 text-stone-500" />}
        <h4 className="text-[11px] uppercase tracking-[0.14em] font-bold text-stone-700">{title}</h4>
        {action && <div className="ml-auto">{action}</div>}
      </header>
      <div className="p-3 text-xs text-stone-800 flex-1 min-h-0">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------
// Summary + inline edit — replaces the drawer-opening Edit button so
// admins can fix typos without leaving the tabs view. Uses the same
// PATCH /contacts/{id}/details endpoint the drawer uses.
function SummaryPanel({ contact, daysInStage, onOpenPostcodeMap, onSaved }) {
  const c = contact;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    email: c.email || "",
    telephone: c.telephone || c.phone || "",
    address_line_1: c.address_line_1 || "",
    city: c.city || "",
    postcode: c.postcode || "",
  });

  async function save() {
    setSaving(true); setErr("");
    try {
      // Only send fields that actually changed — smaller payload, and
      // avoids overwriting drawer-side edits made moments before.
      const diff = {};
      for (const k of Object.keys(form)) {
        const prev = c[k] || (k === "telephone" ? c.phone || "" : "");
        if (form[k] !== prev) diff[k] = form[k] || null;
      }
      if (Object.keys(diff).length === 0) { setEditing(false); return; }
      const { data } = await api.patch(`/contacts/${c.id}/details`, diff);
      onSaved?.(data || diff);
      setEditing(false);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Save failed. Please retry.");
    } finally { setSaving(false); }
  }

  const editAction = editing ? (
    <div className="flex gap-1">
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white rounded hover:bg-stone-800 disabled:opacity-50"
        data-testid={`pipeline-panel-summary-save-${c.id}`}
      >
        <Save className="w-2.5 h-2.5" /> Save
      </button>
      <button
        type="button"
        onClick={() => { setEditing(false); setErr(""); }}
        className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-white text-stone-700 border border-stone-300 rounded hover:bg-stone-50"
        data-testid={`pipeline-panel-summary-cancel-${c.id}`}
      >
        <XIcon className="w-2.5 h-2.5" /> Cancel
      </button>
    </div>
  ) : (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-white text-stone-700 border border-stone-300 rounded hover:bg-stone-50"
      data-testid={`pipeline-panel-summary-edit-${c.id}`}
    >
      <Pencil className="w-2.5 h-2.5" /> Edit
    </button>
  );

  return (
    <PanelShell icon={UserIcon} title="Summary" testId="pipeline-panel-summary" action={editAction}>
      {editing ? (
        <div className="space-y-2">
          <EditField label="Email"       value={form.email}          onChange={(v) => setForm({ ...form, email: v })}      testId={`pipeline-summary-edit-email-${c.id}`} />
          <EditField label="Phone"       value={form.telephone}      onChange={(v) => setForm({ ...form, telephone: v })}  testId={`pipeline-summary-edit-phone-${c.id}`} />
          <EditField label="Address"     value={form.address_line_1} onChange={(v) => setForm({ ...form, address_line_1: v })} testId={`pipeline-summary-edit-address-${c.id}`} />
          <EditField label="City"        value={form.city}           onChange={(v) => setForm({ ...form, city: v })}       testId={`pipeline-summary-edit-city-${c.id}`} />
          <EditField label="Postcode"    value={form.postcode}       onChange={(v) => setForm({ ...form, postcode: v.toUpperCase() })} testId={`pipeline-summary-edit-postcode-${c.id}`} />
          {err && <div className="text-[11px] text-red-600">{err}</div>}
        </div>
      ) : (
        <div className="space-y-2">
          <ReadRow icon={Mail}     value={c.email} />
          <ReadRow icon={Phone}    value={c.telephone || c.phone} />
          <div className="flex items-start gap-2">
            <MapPin className="w-3.5 h-3.5 text-stone-400 mt-0.5 shrink-0" />
            <div className="min-w-0">
              {c.address_line_1 && <div className="truncate">{c.address_line_1}</div>}
              {c.city && <div className="truncate">{c.city}</div>}
              {c.postcode && (
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span>{c.postcode}</span>
                  <button
                    type="button"
                    onClick={() => onOpenPostcodeMap?.(c)}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 rounded hover:bg-stone-100 text-stone-700"
                    data-testid={`pipeline-panel-summary-map-btn-${c.id}`}
                  >
                    <MapPin className="w-2.5 h-2.5" /> Map
                  </button>
                </div>
              )}
              {!c.address_line_1 && !c.city && !c.postcode && (
                <span className="text-stone-400 italic">no address on file</span>
              )}
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Calendar className="w-3.5 h-3.5 text-stone-400 mt-0.5 shrink-0" />
            <span>
              {formatDate(c.date_added || c.date)}
              {typeof daysInStage === "number" && <span className="text-stone-500"> · {daysInStage} days ago</span>}
            </span>
          </div>
        </div>
      )}
    </PanelShell>
  );
}

function ReadRow({ icon: Icon, value }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="w-3.5 h-3.5 text-stone-400 mt-0.5 shrink-0" />
      <span className="break-all">{value || <span className="text-stone-400">—</span>}</span>
    </div>
  );
}

function EditField({ label, value, onChange, testId }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider font-bold text-stone-500">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        className="mt-0.5 w-full text-xs border border-stone-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-stone-900"
      />
    </label>
  );
}

// ---------------------------------------------------------------------
// Territory panel — inline "Plan their territory" callout that mirrors
// the drawer version. If a plan is already linked we flip to an
// emerald "Territory plan linked" pill; if not, the CTA opens the
// builder pre-scoped to this contact.
function TerritoryPanel({ contact }) {
  const linkedPlan = contact.linked_plan || null;
  const href = linkedPlan
    ? `/territory-builder?plan_id=${linkedPlan.id}`
    : `/territory-builder?contact_id=${contact.id}`;
  return (
    <PanelShell icon={Target} title="Plan their territory" testId="pipeline-panel-territory">
      {linkedPlan ? (
        <>
          <p className="mb-2 text-stone-700">
            Linked plan: <strong>{linkedPlan.name || "Unnamed plan"}</strong>
            {typeof linkedPlan.total_homes === "number" && (
              <> · {linkedPlan.total_homes} homes</>
            )}
          </p>
          <a
            href={href}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-emerald-700 text-white hover:bg-emerald-800 rounded-lg"
            data-testid={`pipeline-panel-territory-see-linked-${contact.id}`}
          >
            <Target className="w-3 h-3" /> See linked plan
          </a>
        </>
      ) : (
        <>
          <p className="mb-2 text-stone-700">Build a mental territory plan for this contact.</p>
          <a
            href={href}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg"
            data-testid={`pipeline-panel-territory-open-builder-${contact.id}`}
          >
            <Target className="w-3 h-3" /> Open builder
          </a>
        </>
      )}
    </PanelShell>
  );
}

// ---------------------------------------------------------------------
// Convert to Franchisee / Licencee — yellow-tinted card mirroring the
// drawer's card exactly.
function ConvertPanel({ contact, onConvert, onLinkExisting }) {
  const [converting, setConverting] = useState(false);
  const isLicenceEnq = contact.source === "licence_enquiry";
  const convertLabel = isLicenceEnq ? "Convert to Licencee" : "Convert to Franchisee";
  const alreadyConverted = !!contact.converted_to_franchisee_id;

  const headerAction = alreadyConverted ? (
    <button
      type="button"
      onClick={() => onConvert?.(contact, true)}
      data-testid={`pipeline-panel-convert-view-${contact.id}`}
      className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-white text-emerald-800 border border-emerald-300 hover:bg-emerald-100 rounded-lg"
    >
      View
    </button>
  ) : (
    <button
      type="button"
      onClick={async () => {
        const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "this contact";
        if (!window.confirm(`${convertLabel} for ${name}?`)) return;
        setConverting(true);
        try { await onConvert?.(contact, false); }
        finally { setConverting(false); }
      }}
      disabled={converting}
      data-testid={`pipeline-panel-convert-btn-${contact.id}`}
      className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-[#dddd16] text-stone-950 hover:bg-[#c9c914] rounded-lg disabled:opacity-50"
    >
      <Award className="w-3 h-3" /> {converting ? "…" : "Convert"}
    </button>
  );

  return (
    <PanelShell
      icon={Award}
      title={alreadyConverted ? "Already converted" : convertLabel}
      testId="pipeline-panel-convert"
      tone={alreadyConverted ? "emerald" : "tinted"}
      action={headerAction}
    >
      <p className="text-stone-700 mb-2">
        {alreadyConverted
          ? <>Converted to a {contact.converted_to_record_type === "licencee" ? "Licencee" : "Franchisee"} record.</>
          : <>Create a {isLicenceEnq ? "Licencee" : "Franchisee"} record from this enquiry.</>}
      </p>
      {!alreadyConverted && onLinkExisting && (
        <>
          <p className="text-[11px] text-stone-600 mb-1.5">
            Already in the franchisees list? Link to the existing record.
          </p>
          <button
            type="button"
            onClick={() => onLinkExisting?.(contact)}
            data-testid={`pipeline-panel-convert-link-existing-${contact.id}`}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-white text-stone-800 border border-stone-300 hover:bg-stone-50 rounded-lg"
          >
            <Link2 className="w-3 h-3" /> Link to existing
          </button>
        </>
      )}
    </PanelShell>
  );
}

// ---------------------------------------------------------------------
// Notes — reuses the drawer's `<AdminNotesEditor>`.
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

// ---------------------------------------------------------------------
// Move-to-Stage pills — current stage is coloured / ringed with its
// stage colour so admins can instantly see where the contact sits.
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
    <PanelShell testId="pipeline-panel-stage" title="Move to Stage" icon={Clock}>
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
              aria-current={isCurrent}
              className={`px-2 py-2 text-[10px] font-bold uppercase tracking-wider border rounded-full transition-colors ${
                isCurrent
                  ? `${stagePill.activeCls} cursor-default`
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
// Mark Follow-up Already Sent — amber panel, only appears when the
// contact hasn't yet been logged as followed-up.
function FollowUpPanel({ contact, onMarkFollowUpSent }) {
  const alreadyRecorded = Number(contact.follow_up_sent_count || 0) >= 1;
  if (!onMarkFollowUpSent) return <div aria-hidden />;
  if (alreadyRecorded) {
    return (
      <PanelShell testId="pipeline-panel-followup" tone="emerald" title="Follow-up Status" icon={Clock}>
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-md">
          <CheckCircle2 className="w-3 h-3" /> Follow-up recorded
        </div>
      </PanelShell>
    );
  }
  return (
    <PanelShell testId="pipeline-panel-followup" tone="amber" title="Follow-up Status" icon={Clock}>
      <div className="text-[11px] text-amber-900 mb-2">
        Already sent a follow-up outside the system? Mark it as done so
        this contact won&apos;t drop into <strong>Follow-up Due</strong>.
      </div>
      <button
        type="button"
        onClick={() => onMarkFollowUpSent?.(contact.id)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-amber-500 text-stone-950 hover:bg-amber-600 rounded-lg"
        data-testid={`pipeline-panel-mark-followup-${contact.id}`}
      >
        <CheckCircle2 className="w-3 h-3" /> Mark follow-up already sent
      </button>
    </PanelShell>
  );
}
