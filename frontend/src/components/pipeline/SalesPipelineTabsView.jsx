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
  ArrowDownCircle,
} from "lucide-react";
import { AdminNotesEditor } from "@/pages/ContactsPage";

const TABS = [
  { key: "new",           label: "New",            dot: "bg-stone-400",   bg: "bg-stone-900",   fg: "text-white" },
  { key: "contacted",     label: "Contacted",      dot: "bg-blue-400",    bg: "bg-blue-600",    fg: "text-white" },
  { key: "follow_up_due", label: "Follow-up Due",  dot: "bg-amber-500",   bg: "bg-amber-500",   fg: "text-stone-950" },
  { key: "qualified",     label: "Interested",     dot: "bg-emerald-500", bg: "bg-emerald-600", fg: "text-white" },
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
const HEAT = {
  cold: { label: "Cold", flame: "text-blue-500",   card: "bg-gradient-to-b from-blue-50 to-white   border-blue-300"   },
  warm: { label: "Warm", flame: "text-purple-500", card: "bg-gradient-to-b from-purple-50 to-white border-purple-300" },
  hot:  { label: "Hot",  flame: "text-orange-600", card: "bg-gradient-to-b from-orange-50 to-white border-orange-300" },
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
}) {
  const [activeTab, setActiveTab] = useState("new");
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

  const activeRows = buckets[activeTab] || [];

  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid="sales-pipeline-tabs">
      <div role="tablist" className="flex border-b border-stone-200 bg-[#F2F2F0]">
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
                  ? `border-stone-900 ${t.bg} ${t.fg}`
                  : "border-transparent text-stone-500 hover:text-stone-800 hover:bg-white/60"
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
        <ul className="divide-y divide-stone-200/80" data-testid="pipeline-rows">
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
  contact, temp, isExpanded, onToggle,
  onOpenContact, onReplyContact, onContactUpdated, onOpenPostcodeMap,
  onStageChange, onDemote, onConvert, onLinkExisting, onMarkFollowUpSent,
  onViewCorrespondence,
}) {
  const c = contact;
  const heatKey = heatFromScore(temp?.score);
  const heat = HEAT[heatKey];
  const emailed = (c.email_sends_count || 0) > 0;
  const daysInStage = daysSinceISO(c.pipeline_status_updated_at || c.updated_at || c.date_added);

  return (
    <li data-testid={`pipeline-row-${c.id}`} className="bg-white">
      {/* Single outer container. When expanded it picks up the heat
          wash and a thicker keyline so the whole unit reads as one. */}
      <div
        className={
          isExpanded
            ? `m-3 border-2 rounded-2xl overflow-hidden shadow-sm ${heat.card}`
            : "border-2 border-transparent"
        }
        data-testid={isExpanded ? `pipeline-row-expanded-${c.id}` : undefined}
      >
        <TopBar
          contact={c}
          heat={heat}
          emailed={emailed}
          daysInStage={daysInStage}
          isExpanded={isExpanded}
          onToggle={onToggle}
          onOpenPostcodeMap={onOpenPostcodeMap}
          onReplyContact={onReplyContact}
          onViewCorrespondence={() => onViewCorrespondence?.(c)}
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
function TopBar({
  contact, heat, emailed, daysInStage,
  isExpanded, onToggle, onOpenPostcodeMap, onReplyContact, onViewCorrespondence,
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

      {/* Left cluster — name + email */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`truncate font-semibold text-stone-950 ${isExpanded ? "text-base" : "text-sm"}`}>
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

      {/* Right cluster — persistent email actions + info chips.
          Stop-propagation so clicks don't collapse the row. */}
      <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => onReplyContact?.(c, { mode: "template" })}
          className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-[#dddd16] text-stone-950 hover:bg-[#c9c914] rounded-full"
          data-testid={`pipeline-row-template-reply-${c.id}`}
        >
          <Send className="w-3 h-3" /> Reply with Template
        </button>
        <button
          type="button"
          onClick={onViewCorrespondence}
          className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-white border border-stone-300 text-stone-800 hover:bg-stone-50 rounded-full"
          data-testid={`pipeline-row-view-correspondence-${c.id}`}
        >
          <FileText className="w-3 h-3" /> View Correspondence
        </button>

        {c.postcode ? (
          <>
            <span className="text-xs text-stone-800 shrink-0">{c.postcode}</span>
            <button
              type="button"
              onClick={() => onOpenPostcodeMap?.(c)}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 rounded hover:bg-stone-100 text-stone-700"
              data-testid={`pipeline-row-postcode-map-btn-${c.id}`}
              title={`See ${c.postcode} on the UK territory atlas`}
            >
              <MapPin className="w-2.5 h-2.5" /> Map
            </button>
          </>
        ) : (
          <span className="text-[11px] text-stone-400 italic">no postcode</span>
        )}

        <span
          className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider ${heat.flame}`}
          data-testid={`pipeline-row-temp-${c.id}`}
        >
          <Flame className="w-3.5 h-3.5" />
          {heat.label}
        </span>

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

        <button
          type="button"
          onClick={onToggle}
          className="text-stone-500 hover:text-stone-800"
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
}) {
  const c = contact;
  return (
    <div
      className="p-4 grid gap-3 grid-cols-1 lg:grid-cols-4 lg:grid-rows-[auto_auto]"
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
        <StagePanel
          contact={c}
          onStageChange={onStageChange}
          onDemote={onDemote}
        />
      </div>

      <div className="lg:col-start-3 lg:row-start-1 min-w-0 flex flex-col gap-3">
        <TerritoryPanel contact={c} />
        <ConvertPanel
          contact={c}
          onConvert={onConvert}
          onLinkExisting={onLinkExisting}
        />
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
    </div>
  );
}

// ---------------------------------------------------------------------
// Panel shell — a single card style used by every expanded panel so
// the layout reads as one composed unit rather than a collection of
// unrelated boxes.
function PanelShell({ icon: Icon, title, action, children, testId, tone = "default", bodyClass = "" }) {
  const toneCls = {
    default: "bg-white border-stone-200",
    tinted:  "bg-[#fbfbe8] border-[#e6e37f]",
    amber:   "bg-amber-50 border-amber-200",
    emerald: "bg-emerald-50 border-emerald-200",
  }[tone];
  return (
    <section
      className={`h-full border rounded-xl flex flex-col overflow-hidden ${toneCls}`}
      data-testid={testId}
    >
      <header className="flex items-center gap-2 px-3 py-2 border-b border-stone-200/70">
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
    city: c.city || "",
    postcode: c.postcode || "",
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
          <EditField label="Email"     value={form.email}          onChange={(v) => setForm({ ...form, email: v })} />
          <EditField label="Phone"     value={form.telephone}      onChange={(v) => setForm({ ...form, telephone: v })} />
          <EditField label="Address"   value={form.address_line_1} onChange={(v) => setForm({ ...form, address_line_1: v })} />
          <EditField label="Town"      value={form.city}           onChange={(v) => setForm({ ...form, city: v })} />
          <EditField label="Postcode"  value={form.postcode}       onChange={(v) => setForm({ ...form, postcode: v.toUpperCase() })} />
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
                {c.city && <div className="truncate">{c.city}</div>}
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
                {!c.address_line_1 && !c.city && !c.postcode && (
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

function StagePanel({ contact, onStageChange, onDemote }) {
  return (
    <PanelShell icon={Clock} title="Move to Stage" testId="pipeline-panel-stage">
      <div className="grid grid-cols-2 gap-2">
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
      <div className="flex items-center gap-2 flex-wrap">
        {already ? (
          <button
            type="button"
            onClick={() => onConvert?.(contact, true)}
            data-testid={`pipeline-panel-convert-view-${contact.id}`}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-white text-emerald-800 border border-emerald-300 hover:bg-emerald-100 rounded-full"
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
              className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-[#dddd16] text-stone-950 hover:bg-[#c9c914] rounded-full disabled:opacity-50"
            ><Award className="w-3 h-3" /> {converting ? "…" : "Convert"}</button>
            {onLinkExisting && (
              <button
                type="button"
                onClick={() => onLinkExisting?.(contact)}
                data-testid={`pipeline-panel-convert-link-existing-${contact.id}`}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-white text-stone-800 border border-stone-300 hover:bg-stone-50 rounded-full"
              ><Link2 className="w-3 h-3" /> Link to existing</button>
            )}
          </>
        )}
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
