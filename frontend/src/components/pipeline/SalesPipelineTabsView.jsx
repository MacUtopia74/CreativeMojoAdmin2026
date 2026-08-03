// Sales Pipeline — Tabbed list view.
//
// One row = one `<li>` container. The top bar renders identically
// whether the row is collapsed or expanded (per Aug 2 spec — the two
// email actions must not move). Below the top bar, the expanded
// state reveals a 4-column grid: Summary | Move to Stage | Plan +
// Convert stack | Notes, with Follow-up Status spanning columns
// 2 + 3 beneath.
//
// The whole selected row + expanded content sits inside one
// container so the tinted background, rounded corners and thicker
// keyline wrap it as a single unit.

import React, { useState } from "react";
import api from "@/lib/api";
import {
  Flame, MapPin, MessageSquare, FileText, ChevronDown, ChevronUp,
  Mail, MailX, Send, Target, Award,
  Link2, CheckCircle2, Calendar, Phone, Pencil,
  User as UserIcon, Clock, Save, X as XIcon,
  ArrowDownCircle, ArrowRightLeft,
} from "lucide-react";
import { AdminNotesEditor, InterestedChecklist, TemperaturePicker } from "@/pages/ContactsPage";

const TABS = [
  { key: "qualified",     label: "Interested",     dot: "bg-emerald-500", bg: "bg-emerald-600", fg: "text-white" },
  { key: "new",           label: "New",            dot: "bg-stone-400",   bg: "bg-stone-900",   fg: "text-white" },
  { key: "contacted",     label: "Contacted",      dot: "bg-blue-400",    bg: "bg-blue-600",    fg: "text-white" },
  { key: "follow_up_due", label: "Follow-up Due",  dot: "bg-amber-500",   bg: "bg-amber-500",   fg: "text-stone-950" },
];

// Six stages. ``activeCls`` renders the selected pill as a solid
// coloured block matching the tab bar so admins instantly see which
// stage the contact sits in.
const STAGE = {
  new:           { label: "New",            cls: "bg-white text-stone-700 border-stone-300", activeCls: "bg-stone-900 text-white border-stone-900" },
  contacted:     { label: "Contacted",      cls: "bg-white text-stone-700 border-stone-300", activeCls: "bg-blue-600 text-white border-blue-600" },
  qualified:     { label: "Interested",     cls: "bg-white text-stone-700 border-stone-300", activeCls: "bg-emerald-600 text-white border-emerald-600" },
  dormant:       { label: "Dormant",        cls: "bg-white text-stone-700 border-stone-300", activeCls: "bg-orange-500 text-white border-orange-500" },
  follow_up_due: { label: "Follow-up Due",  cls: "bg-white text-stone-700 border-stone-300", activeCls: "bg-amber-500 text-stone-950 border-amber-500" },
  lost:          { label: "Lost",           cls: "bg-white text-stone-700 border-stone-300", activeCls: "bg-red-600 text-white border-red-600" },
};

// (STAGE_TOPBAR removed — mockup shows no stage pill in the top bar;
// the active tab implies the stage.)

// Three-tier heat scale — cold=blue, warm=purple, hot=orange (matches
// the flame swatches). ``card`` is the tint that wraps the entire
// selected row + expanded content as one unit.
// Row-tint palette keyed on the manual pipeline temperature (Hot / Keen /
// Lukewarm). Mirrors the flame colours used on the kanban card so the
// two views feel like the same data. `row` is the soft tint applied to
// each collapsed row when a temperature is set; `card` wraps the whole
// expanded card with a thicker tinted border.
const HEAT = {
  hot:      { label: "Hot",      row: "bg-orange-50", card: "border-orange-300" },
  keen:     { label: "Keen",     row: "bg-purple-50", card: "border-purple-300" },
  lukewarm: { label: "Lukewarm", row: "bg-blue-50",   card: "border-blue-300"   },
};

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

function displayNameFor(contact) {
  return [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "(no name)";
}

// ---------------------------------------------------------------------
// Top-level tabs view
// ---------------------------------------------------------------------
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
  onChangeSource,
  onTemperatureChange,
}) {
  void tempMap;
  const [activeTab, setActiveTab] = useState("qualified");
  const [userPickedTab, setUserPickedTab] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [correspondenceContact, setCorrespondenceContact] = useState(null);

  const buckets = React.useMemo(() => {
    const out = { new: [], contacted: [], follow_up_due: [], qualified: [] };
    for (const c of contacts) {
      if (!c.in_pipeline) continue;
      const s = c.pipeline_status || "new";
      if (out[s]) out[s].push(c);
    }
    return out;
  }, [contacts]);

  // Auto-pick the first non-empty tab on load so admins land on a
  // populated list instead of the empty "New" bucket. Stops as soon as
  // the user manually clicks a tab (userPickedTab flag) so this never
  // overrides an explicit choice.
  React.useEffect(() => {
    if (userPickedTab) return;
    if ((buckets[activeTab] || []).length > 0) return;
    const firstWithData = TABS.find((t) => (buckets[t.key] || []).length > 0);
    if (firstWithData && firstWithData.key !== activeTab) {
      setActiveTab(firstWithData.key);
    }
  }, [buckets, activeTab, userPickedTab]);

  const activeRows = buckets[activeTab] || [];

  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid="sales-pipeline-tabs">
      <div role="tablist" className="flex gap-1.5 p-1.5 bg-white border-b border-stone-200">
        {TABS.map((t) => {
          const isActive = t.key === activeTab;
          const count = (buckets[t.key] || []).length;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => { setActiveTab(t.key); setUserPickedTab(true); setExpandedId(null); }}
              data-testid={`pipeline-tab-${t.key}`}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-xs font-bold uppercase tracking-[0.18em] transition-colors rounded-lg ${
                isActive
                  ? `${t.bg} ${t.fg}`
                  : "bg-[#F2F2F0] text-stone-500 hover:text-stone-800 hover:bg-stone-100"
              }`}
            >
              <span className={`inline-block w-2 h-2 rounded-full ${isActive ? "bg-white/70" : t.dot}`} />
              <span>{t.label}</span>
              <span
                className={`text-[10px] tabular-nums px-1.5 py-0.5 rounded-full ${
                  isActive ? "bg-black/20 text-white" : "bg-stone-200 text-stone-700"
                } ${isActive && t.fg.includes("stone-950") ? "!bg-stone-900/15 !text-stone-950" : ""}`}
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
        <ul className="p-1.5 space-y-1.5" data-testid="pipeline-rows">
          {activeRows.map((c) => (
            <PipelineRow
              key={c.id}
              contact={c}
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
              onChangeSource={onChangeSource}
              onTemperatureChange={onTemperatureChange}
              onViewCorrespondence={() => setCorrespondenceContact(c)}
            />
          ))}
        </ul>
      )}

      {correspondenceContact && (
        <CorrespondenceModal
          contact={correspondenceContact}
          onClose={() => setCorrespondenceContact(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// A single row — unified container. Top bar renders in BOTH collapsed
// and expanded states with the same slot for the two email actions.
// Expanded content sits directly below the top bar inside the same
// tinted outer container so the keyline wraps them as one unit.
function PipelineRow({
  contact, isExpanded, onToggle,
  onOpenContact, onReplyContact, onContactUpdated, onOpenPostcodeMap,
  onStageChange, onDemote, onConvert, onLinkExisting, onMarkFollowUpSent,
  onChangeSource, onTemperatureChange,
  onViewCorrespondence,
}) {
  const c = contact;
  const heat = HEAT[c.temperature] || null;
  const emailed = (c.email_sends_count || 0) > 0;
  const daysInStage = daysSinceISO(c.pipeline_status_updated_at || c.updated_at || c.date_added);

  const rowTint = heat ? heat.row : "bg-white";
  const borderTint = heat ? heat.card : "border-stone-200";

  return (
    <li
      data-testid={`pipeline-row-${c.id}`}
      className={`${rowTint} border ${borderTint} rounded-xl overflow-hidden`}
    >
      {/* Single outer container. When expanded we thicken the keyline
          so the whole unit reads as one, but the fill stays the same
          tinted colour as the collapsed row so the heat is obvious. */}
      <div
        className={
          isExpanded
            ? `m-3 border-2 ${borderTint} rounded-2xl overflow-hidden shadow-sm bg-[#F2F2F0]`
            : "border-2 border-transparent rounded-xl"
        }
        data-testid={isExpanded ? `pipeline-row-expanded-${c.id}` : undefined}
      >
        <TopBar
          contact={c}
          emailed={emailed}
          daysInStage={daysInStage}
          isExpanded={isExpanded}
          onToggle={onToggle}
          onOpenPostcodeMap={onOpenPostcodeMap}
          onReplyContact={onReplyContact}
          onViewCorrespondence={() => onViewCorrespondence?.(c)}
          onTemperatureChange={onTemperatureChange}
        />

        {isExpanded && (
          <ExpandedBody
            contact={c}
            daysInStage={daysInStage}
            onOpenPostcodeMap={onOpenPostcodeMap}
            onContactUpdated={onContactUpdated}
            onOpenContact={onOpenContact}
            onStageChange={onStageChange}
            onDemote={onDemote}
            onConvert={onConvert}
            onLinkExisting={onLinkExisting}
            onMarkFollowUpSent={onMarkFollowUpSent}
            onChangeSource={onChangeSource}
          />
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------
// Top bar — identical layout in both collapsed and expanded states.
// Left cluster: avatar + name + days-in-stage + email.
// Right cluster: Reply-with-Template + View-Correspondence buttons,
// postcode + MAP, heat, emailed chip, chevron.
// ---------------------------------------------------------------------
// QUICK NOTE — single-line free-text visual reference. Persists via
// PATCH /contacts/{id}/details (whitelisted field on the backend). Not
// surfaced anywhere else in the app; not linked to templates, pipeline
// state, exports, or search. Uncontrolled input so it never re-renders
// while typing; saves on blur or Enter. Escape reverts.
function QuickNoteInput({ contact }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const ref = React.useRef(null);
  const initial = contact.quick_note || "";

  React.useEffect(() => {
    // Sync when the underlying contact swaps (parent re-fetches, etc.)
    if (ref.current && ref.current.value !== (contact.quick_note || "")) {
      ref.current.value = contact.quick_note || "";
    }
  }, [contact.id, contact.quick_note]);

  const commit = async () => {
    const next = (ref.current?.value || "").trim();
    if (next === (contact.quick_note || "")) return;
    setError(false);
    setSaving(true);
    try {
      await api.patch(`/contacts/${contact.id}/details`, { quick_note: next || null });
      // Reflect the saved value back onto the contact object so the
      // useEffect above doesn't overwrite it on the next render.
      contact.quick_note = next || null;
    } catch (e) {
      setError(true);
      // Revert visible input so the admin can retry
      if (ref.current) ref.current.value = contact.quick_note || "";
    } finally {
      setSaving(false);
    }
  };

  return (
    <input
      ref={ref}
      type="text"
      defaultValue={initial}
      placeholder="Quick note…"
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === "Escape") {
          if (ref.current) ref.current.value = contact.quick_note || "";
          e.currentTarget.blur();
        }
      }}
      onClick={(e) => e.stopPropagation()}
      disabled={saving}
      title={error ? "Save failed — try again" : "Free-text visual reference"}
      className={`w-full text-xs bg-white/70 border rounded-md px-2 py-1 placeholder:text-stone-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-stone-900 transition-colors ${
        error ? "border-red-300" : "border-stone-200 hover:border-stone-300"
      }`}
      data-testid={`pipeline-row-quicknote-${contact.id}`}
    />
  );
}

function TopBar({
  contact, emailed, daysInStage,
  isExpanded, onToggle, onOpenPostcodeMap, onReplyContact, onViewCorrespondence,
  onTemperatureChange,
}) {
  const c = contact;
  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-white/40 transition-colors ${
        isExpanded ? "border-b border-stone-200/70" : ""
      }`}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle?.(); } }}
      data-testid={`pipeline-row-toggle-${c.id}`}
    >
      {/* Avatar (only in expanded state — collapsed rows stay
          light to keep the list scannable). */}
      {isExpanded && (
        <div className="w-10 h-10 rounded-full bg-white/80 text-stone-800 font-bold text-sm flex items-center justify-center border border-white shrink-0">
          {initialsFor(c)}
        </div>
      )}

      {/* Left cluster — name + email. Fixed width so the middle
          quick-note area always starts at the same column. */}
      <div className="w-[240px] shrink-0 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`truncate font-bold text-stone-950 ${isExpanded ? "text-base" : "text-sm"}`}>
            {displayNameFor(c)}
          </span>
          {typeof daysInStage === "number" && (
            <span className="text-[11px] text-stone-500 shrink-0">
              {daysInStage} in stage
            </span>
          )}
        </div>
        <div className="text-[11px] text-stone-600 truncate mt-0.5">
          {c.email || <span className="italic text-stone-400">no email</span>}
        </div>
      </div>

      {/* Middle cluster — free-text quick note. Single line, saved
          on blur. Purely a visual reference for the admin; not
          linked to templates, pipeline logic, or exports. */}
      <div
        className="flex-1 min-w-0 px-2"
        onClick={(e) => e.stopPropagation()}
      >
        <QuickNoteInput contact={c} />
      </div>

      {/* Right cluster — persistent email actions + info chips.
          Each item lives in a fixed-width slot so columns line up
          neatly across every row. Stop-propagation so clicks don't
          collapse the row. */}
      <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
        <div className="hidden md:flex w-[172px] justify-start">
          <button
            type="button"
            onClick={() => onReplyContact?.(c, { mode: "template" })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-[#dddd16] text-stone-950 hover:bg-[#c9c914] rounded-full whitespace-nowrap"
            data-testid={`pipeline-row-template-reply-${c.id}`}
          >
            <Send className="w-3 h-3" /> Reply with Template
          </button>
        </div>

        <div className="hidden md:flex w-[180px] justify-start">
          <button
            type="button"
            onClick={onViewCorrespondence}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-white border border-stone-300 text-stone-800 hover:bg-stone-50 rounded-full whitespace-nowrap"
            data-testid={`pipeline-row-view-correspondence-${c.id}`}
          >
            <FileText className="w-3 h-3" /> View Correspondence
          </button>
        </div>

        <div className="w-[70px] text-right">
          {c.postcode ? (
            <span className="text-xs text-stone-800 tabular-nums">{c.postcode}</span>
          ) : (
            <span className="text-[11px] text-stone-400 italic">no postcode</span>
          )}
        </div>

        <div className="w-[62px] flex justify-start">
          {c.postcode ? (
            <button
              type="button"
              onClick={() => onOpenPostcodeMap?.(c)}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 rounded hover:bg-stone-100 text-stone-700"
              data-testid={`pipeline-row-postcode-map-btn-${c.id}`}
              title={`See ${c.postcode} on the UK territory atlas`}
            >
              <MapPin className="w-2.5 h-2.5" /> Map
            </button>
          ) : (
            <span className="text-[10px] text-stone-300">—</span>
          )}
        </div>

        <span
          className="inline-flex items-center justify-center w-[82px]"
          data-testid={`pipeline-row-temp-${c.id}`}
          onClick={(e) => e.stopPropagation()}
        >
          <TemperaturePicker
            value={c.temperature || null}
            onChange={(next) => onTemperatureChange?.(c.id, next)}
            size="sm"
            testidPrefix={`pipeline-row-temp-${c.id}`}
          />
        </span>

        <div className="w-[112px] flex justify-start">
          <span
            className={`inline-flex items-center justify-center gap-1 w-full text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full border ${
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

        <button
          type="button"
          onClick={onToggle}
          className="text-stone-500 hover:text-stone-800 shrink-0"
          data-testid={`pipeline-row-chevron-${c.id}`}
        >
          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Expanded body — 4 columns matching New visual.jpg.
// Grid layout:
//   Row 1: Summary (col 1, rows 1-2) | Move-to-Stage (col 2, row 1) |
//          Territory + Convert stack (col 3, row 1) | Notes (col 4,
//          rows 1-2)
//   Row 2: Follow-up Status spanning col 2-3
// This packs Notes into the full expanded height while keeping the
// central column controls compact.
function ExpandedBody({
  contact, daysInStage, onOpenPostcodeMap, onContactUpdated, onOpenContact,
  onStageChange, onDemote, onConvert, onLinkExisting, onMarkFollowUpSent,
  onChangeSource,
}) {
  const c = contact;
  return (
    <div
      className="p-4 grid gap-3 grid-cols-1 lg:grid-cols-4 lg:grid-rows-[auto_auto_auto]"
      data-testid={`pipeline-row-body-${c.id}`}
    >
      <div className="lg:col-start-1 lg:row-span-2 min-w-0">
        <SummaryPanel
          contact={c}
          daysInStage={daysInStage}
          onOpenPostcodeMap={onOpenPostcodeMap}
          onSaved={(patch) => onContactUpdated?.(c.id, patch)}
        />
      </div>

      <div className="lg:col-start-2 lg:row-start-1 min-w-0">
        <InterestedChecklist
          contact={c}
          onChanged={(patch) => onContactUpdated?.(c.id, patch)}
        />
      </div>

      <div className="lg:col-start-3 lg:row-start-1 min-w-0 flex flex-col gap-3">
        <TerritoryPanel contact={c} />
        {/* Convert + Change Type sit side-by-side: Convert narrows so the
            new Change Type dropdown gets breathing room per the Feb-2026
            layout tweak. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ConvertPanel
            contact={c}
            onConvert={onConvert}
            onLinkExisting={onLinkExisting}
          />
          <ChangeTypePanel
            contact={c}
            onChangeSource={onChangeSource}
          />
        </div>
      </div>

      <div className="lg:col-start-4 lg:row-span-2 min-w-0">
        <NotesPanel contact={c} onChanged={onContactUpdated} />
      </div>

      <div className="lg:col-start-2 lg:col-span-2 lg:row-start-2 min-w-0">
        <FollowUpPanel
          contact={c}
          onMarkFollowUpSent={onMarkFollowUpSent}
        />
      </div>

      {/* Move-to-Stage moved to the bottom and stretched full width so
          the six stage pills space out proportionally under the whole
          expanded card. */}
      <div className="lg:col-start-1 lg:col-span-4 lg:row-start-3 min-w-0">
        <StagePanel
          contact={c}
          onStageChange={onStageChange}
          onDemote={onDemote}
          stretch
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// (Historical ChecklistPanel removed — the tab view now renders the
// shared InterestedChecklist widget directly so the styling matches
// the Kanban modal exactly.)

// ---------------------------------------------------------------------
// Panel shell — a single card style used by every expanded panel so
// the layout reads as one composed unit rather than a collection of
// unrelated boxes.
// Per the Feb-2026 visual guide, every mini-panel in the expanded row
// wears a thicker blue keyline + soft blue tint so the four columns are
// visually parseable at a glance. Semantic tones (tinted/amber/emerald)
// still exist for backward-compat but now all map to the same blue
// treatment — the semantic meaning is carried by inner buttons/labels,
// not the panel chrome itself.
function PanelShell({ icon: Icon, title, action, children, testId, tone = "default", bodyClass = "" }) {
  void tone;
  const shellCls = "border-2";
  return (
    <section
      className={`h-full rounded-xl flex flex-col overflow-hidden ${shellCls}`}
      style={{ backgroundColor: "#fafbe9", borderColor: "#dddd16" }}
      data-testid={testId}
    >
      <header
        className="flex items-center gap-2 px-3 py-2 border-b"
        style={{ borderColor: "#e6e37f" }}
      >
        {Icon && <Icon className="w-3.5 h-3.5 text-stone-500" />}
        <h4 className="text-[11px] uppercase tracking-[0.16em] font-bold text-stone-700">{title}</h4>
        {action && <div className="ml-auto">{action}</div>}
      </header>
      <div className={`p-3 text-xs text-stone-800 flex-1 min-h-0 ${bodyClass}`}>
        {children}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------
// SUMMARY — matches the reference layout: email, phone, town, postcode
// with MAP button, then date + age at the BOTTOM, with breathing room
// in between. Edit lives top-right of the panel header.
function SummaryPanel({ contact, daysInStage, onOpenPostcodeMap, onSaved }) {
  const c = contact;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    email: c.email || "",
    telephone: c.telephone || c.phone || "",
    address_line_1: c.address_line_1 || "",
    address_line_2: c.address_line_2 || "",
    city: c.city || "",
    postcode: c.postcode || "",
    county: c.county || "",
    country: c.country || "",
  });

  async function save() {
    setSaving(true); setErr("");
    try {
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
      ><Save className="w-2.5 h-2.5" /> Save</button>
      <button
        type="button"
        onClick={() => { setEditing(false); setErr(""); }}
        className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-white text-stone-700 border border-stone-300 rounded hover:bg-stone-50"
        data-testid={`pipeline-panel-summary-cancel-${c.id}`}
      ><XIcon className="w-2.5 h-2.5" /> Cancel</button>
    </div>
  ) : (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-white text-stone-700 border border-stone-300 rounded hover:bg-stone-50"
      data-testid={`pipeline-panel-summary-edit-${c.id}`}
    ><Pencil className="w-2.5 h-2.5" /> Edit</button>
  );

  return (
    <PanelShell
      icon={UserIcon}
      title="Summary"
      testId="pipeline-panel-summary"
      action={editAction}
      bodyClass="flex flex-col"
    >
      {editing ? (
        <div className="space-y-2">
          <EditField label="Email"           value={form.email}          onChange={(v) => setForm({ ...form, email: v })} />
          <EditField label="Phone"           value={form.telephone}      onChange={(v) => setForm({ ...form, telephone: v })} />
          <EditField label="Address"         value={form.address_line_1} onChange={(v) => setForm({ ...form, address_line_1: v })} />
          <EditField label="2nd Line of Address" value={form.address_line_2} onChange={(v) => setForm({ ...form, address_line_2: v })} />
          <EditField label="Town/City"       value={form.city}           onChange={(v) => setForm({ ...form, city: v })} />
          <EditField label="County/State"    value={form.county}         onChange={(v) => setForm({ ...form, county: v })} />
          <EditField label="Postcode"        value={form.postcode}       onChange={(v) => setForm({ ...form, postcode: v.toUpperCase() })} />
          <EditField label="Country"         value={form.country}        onChange={(v) => setForm({ ...form, country: v })} />
          {err && <div className="text-[11px] text-red-600">{err}</div>}
        </div>
      ) : (
        <>
          {/* Contact block */}
          <div className="space-y-3 flex-1">
            <SummaryRow icon={Mail}  value={c.email} />
            <SummaryRow icon={Phone} value={c.telephone || c.phone} />
            <div className="flex items-start gap-2">
              <MapPin className="w-3.5 h-3.5 text-stone-400 mt-0.5 shrink-0" />
              <div className="min-w-0">
                {c.address_line_1 && <div className="truncate">{c.address_line_1}</div>}
                {c.address_line_2 && <div className="truncate">{c.address_line_2}</div>}
                {c.city && <div className="truncate">{c.city}</div>}
                {c.county && <div className="truncate">{c.county}</div>}
                {c.postcode && (
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span>{c.postcode}</span>
                    <button
                      type="button"
                      onClick={() => onOpenPostcodeMap?.(c)}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 rounded hover:bg-stone-100 text-stone-700"
                      data-testid={`pipeline-panel-summary-map-btn-${c.id}`}
                    ><MapPin className="w-2.5 h-2.5" /> Map</button>
                  </div>
                )}
                {c.country && <div className="truncate text-stone-500">{c.country}</div>}
                {!c.address_line_1 && !c.address_line_2 && !c.city && !c.county && !c.postcode && !c.country && (
                  <span className="text-stone-400 italic">no address on file</span>
                )}
              </div>
            </div>
          </div>
          {/* Date footer — sits at the bottom of the panel */}
          <div className="mt-4 pt-3 border-t border-stone-200/70 flex items-center gap-2 text-[11px] text-stone-600">
            <Calendar className="w-3.5 h-3.5 text-stone-400" />
            <span>
              {formatDate(c.date_added || c.date)}
              {typeof daysInStage === "number" && <span> · {daysInStage} days ago</span>}
            </span>
          </div>
        </>
      )}
    </PanelShell>
  );
}

function SummaryRow({ icon: Icon, value }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="w-3.5 h-3.5 text-stone-400 mt-0.5 shrink-0" />
      <span className="break-all">{value || <span className="text-stone-400">—</span>}</span>
    </div>
  );
}

function EditField({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider font-bold text-stone-500">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full text-xs border border-stone-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-stone-900"
      />
    </label>
  );
}

// ---------------------------------------------------------------------
// MOVE TO STAGE — 2 columns × 3 rows in the reference order.
const STAGE_GRID = [
  { key: "new",           label: "New" },
  { key: "contacted",     label: "Contacted" },
  { key: "qualified",     label: "Interested" },
  { key: "dormant",       label: "Dormant" },
  { key: "follow_up_due", label: "Follow-up Due" },
  { key: "lost",          label: "Lost" },
];

function StagePanel({ contact, onStageChange, onDemote, stretch = false }) {
  // In `stretch` mode the six pills spread out across a single row so
  // the panel can span the full width of the expanded card cleanly.
  const gridCls = stretch
    ? "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2"
    : "grid grid-cols-2 gap-2";
  return (
    <PanelShell icon={Clock} title="Move to Stage" testId="pipeline-panel-stage">
      <div className={gridCls}>
        {STAGE_GRID.map((s) => {
          const isCurrent = contact.pipeline_status === s.key;
          const spec = STAGE[s.key];
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => onStageChange?.(contact.id, s.key)}
              disabled={isCurrent}
              aria-current={isCurrent}
              className={`px-2 py-2 text-[10px] font-bold uppercase tracking-wider border rounded-full transition-colors ${
                isCurrent ? `${spec.activeCls} cursor-default` : `${spec.cls} hover:bg-stone-50`
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
// PLAN THEIR TERRITORY — compact panel; empty-state → OPEN BUILDER,
// linked → LINKED-PLAN card + SEE LINKED PLAN.
function TerritoryPanel({ contact }) {
  const lp = contact.linked_plan;
  const href = lp
    ? `/territory-builder?plan_id=${lp.id}`
    : `/territory-builder?contact_id=${contact.id}`;
  return (
    <PanelShell
      icon={Target}
      title="Plan Their Territory"
      testId="pipeline-panel-territory"
      action={
        <a
          href={href}
          className={`inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded ${
            lp ? "bg-emerald-700 text-white hover:bg-emerald-800" : "bg-stone-950 text-white hover:bg-stone-800"
          }`}
          data-testid={`pipeline-panel-territory-action-${contact.id}`}
        >
          <Target className="w-3 h-3" /> {lp ? "See linked plan" : "Open builder"}
        </a>
      }
    >
      {lp ? (
        <div className="text-stone-700">
          <div className="font-semibold text-stone-900">{lp.name || "Unnamed plan"}</div>
          <div className="text-[11px] text-stone-500 mt-0.5">
            {typeof lp.total_homes === "number" && <>{lp.total_homes} homes</>}
            {typeof lp.sectors_count === "number" && <> · {lp.sectors_count} sectors</>}
          </div>
        </div>
      ) : (
        <p className="text-stone-600">Build a mental territory plan for this contact.</p>
      )}
    </PanelShell>
  );
}

// ---------------------------------------------------------------------
// CONVERT TO FRANCHISEE — light tint, Convert + Link to Existing.
// Sits in a half-width column beside CHANGE TYPE so the two actions
// share the visual weight of the reclassification workflow. Buttons
// stack vertically so short labels don't wrap in the narrow column.
function ConvertPanel({ contact, onConvert, onLinkExisting }) {
  const [converting, setConverting] = useState(false);
  const isLicenceEnq = contact.source === "licence_enquiry";
  const label = isLicenceEnq ? "Convert to Licencee" : "Convert to Franchisee";
  const already = !!contact.converted_to_franchisee_id;
  return (
    <PanelShell
      icon={Award}
      title={already ? "Already converted" : label}
      testId="pipeline-panel-convert"
      tone={already ? "emerald" : "tinted"}
    >
      <div className="flex flex-col gap-1.5">
        {already ? (
          <button
            type="button"
            onClick={() => onConvert?.(contact, true)}
            data-testid={`pipeline-panel-convert-view-${contact.id}`}
            className="inline-flex items-center justify-center gap-1 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-white text-emerald-800 border border-emerald-300 hover:bg-emerald-100 rounded-full"
          >View {contact.converted_to_record_type === "licencee" ? "Licencee" : "Franchisee"}</button>
        ) : (
          <>
            <button
              type="button"
              onClick={async () => {
                const name = displayNameFor(contact);
                if (!window.confirm(`${label} for ${name}?`)) return;
                setConverting(true);
                try { await onConvert?.(contact, false); }
                finally { setConverting(false); }
              }}
              disabled={converting}
              data-testid={`pipeline-panel-convert-btn-${contact.id}`}
              className="inline-flex items-center justify-center gap-1 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-[#dddd16] text-stone-950 hover:bg-[#c9c914] rounded-full disabled:opacity-50"
            ><Award className="w-3 h-3" /> {converting ? "…" : "Convert"}</button>
            {onLinkExisting && (
              <button
                type="button"
                onClick={() => onLinkExisting?.(contact)}
                data-testid={`pipeline-panel-convert-link-existing-${contact.id}`}
                className="inline-flex items-center justify-center gap-1 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-white text-stone-800 border border-stone-300 hover:bg-stone-50 rounded-full"
              ><Link2 className="w-3 h-3" /> Link to existing</button>
            )}
          </>
        )}
      </div>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------
// CHANGE TYPE — reclassify the enquiry between Franchise / Licence /
// General without leaving the Sales Pipeline row. Backed by the same
// `/contacts/{id}/move` endpoint used by the drawer's "Change type"
// menu, so behaviour stays consistent across list + drawer views.
const CHANGE_TYPE_OPTIONS = [
  { key: "franchise", label: "Franchise", source: "franchise_enquiry" },
  { key: "licence",   label: "Licence",   source: "licence_enquiry" },
  { key: "general",   label: "General",   source: "general_enquiry" },
];

function ChangeTypePanel({ contact, onChangeSource }) {
  const currentSource = contact.source || "general_enquiry";
  const currentOpt = CHANGE_TYPE_OPTIONS.find((o) => o.source === currentSource);
  const [busy, setBusy] = useState(false);
  const canChange = !!onChangeSource;
  return (
    <PanelShell
      icon={ArrowRightLeft}
      title="Change Type"
      testId="pipeline-panel-change-type"
    >
      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500">
          Current: <span className="text-stone-800">{currentOpt?.label || "General"}</span>
        </div>
        <select
          value={currentOpt?.key || "general"}
          disabled={!canChange || busy}
          onChange={async (e) => {
            const target = e.target.value;
            if (target === currentOpt?.key) return;
            const label = CHANGE_TYPE_OPTIONS.find((o) => o.key === target)?.label || target;
            const name = displayNameFor(contact);
            if (!window.confirm(`Reclassify ${name} as a ${label} enquiry?`)) return;
            setBusy(true);
            try { await onChangeSource?.(contact, target); }
            finally { setBusy(false); }
          }}
          className="w-full text-xs border border-stone-300 rounded px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-stone-900 disabled:opacity-50"
          data-testid={`pipeline-panel-change-type-select-${contact.id}`}
        >
          {CHANGE_TYPE_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>{o.label} enquiry</option>
          ))}
        </select>
      </div>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------
// FOLLOW-UP STATUS — spans central columns 2 + 3. Compact vertical
// height with the action button aligned right so the panel doesn't
// feel left-heavy.
function FollowUpPanel({ contact, onMarkFollowUpSent }) {
  const recorded = Number(contact.follow_up_sent_count || 0) >= 1;
  if (recorded) {
    return (
      <PanelShell icon={Clock} title="Follow-up Status" testId="pipeline-panel-followup" tone="emerald">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-700" />
          <span className="text-emerald-900">Follow-up recorded on this contact.</span>
        </div>
      </PanelShell>
    );
  }
  return (
    <PanelShell icon={Clock} title="Follow-up Status" testId="pipeline-panel-followup" tone="amber">
      <div className="flex items-center justify-between gap-3">
        <p className="text-amber-900 min-w-0">
          Already sent a follow-up outside the system? Mark it as done so
          this contact won&apos;t drop into <strong>Follow-up Due</strong>.
        </p>
        <button
          type="button"
          onClick={() => onMarkFollowUpSent?.(contact.id)}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-amber-500 text-stone-950 hover:bg-amber-600 rounded-full"
          data-testid={`pipeline-panel-mark-followup-${contact.id}`}
        >
          <CheckCircle2 className="w-3 h-3" /> Mark follow-up already sent
        </button>
      </div>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------
// NOTES — right column, full expanded-body height. Textarea grows to
// fill the panel's available space so admins can jot running notes,
// call summaries, follow-up reminders in one place.
function NotesPanel({ contact, onChanged }) {
  return (
    <PanelShell
      icon={FileText}
      title="Notes"
      testId="pipeline-panel-notes"
      bodyClass="flex flex-col"
    >
      <div className="flex-1 min-h-[220px] flex">
        <AdminNotesEditor
          contact={contact}
          onUpdated={(id, notes, ts) =>
            onChanged?.(id, { admin_notes: notes, admin_notes_updated_at: ts })
          }
          fullHeight
        />
      </div>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------
// View-Correspondence full-screen modal (empty layout placeholder).
function CorrespondenceModal({ contact, onClose }) {
  const displayName = displayNameFor(contact);
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-stretch justify-center"
      onClick={onClose}
      data-testid="correspondence-modal-backdrop"
    >
      <div
        className="bg-white w-full h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        data-testid="correspondence-modal"
      >
        <header className="flex items-center justify-between gap-3 px-6 py-3 border-b border-stone-200 bg-stone-50">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-[0.2em] font-bold text-stone-500">Correspondence</div>
            <div className="text-lg font-bold text-stone-950 truncate">{displayName}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-700 hover:bg-stone-100 rounded-md"
            data-testid="correspondence-modal-close"
          ><XIcon className="w-3 h-3" /> Close</button>
        </header>
        <div className="flex-1 min-h-0 overflow-auto bg-stone-50/50">
          <div className="w-full h-full flex items-center justify-center text-sm text-stone-500 italic px-6 text-center">
            Email correspondence layout coming next — the modal is
            wired and ready.
          </div>
        </div>
      </div>
    </div>
  );
}
