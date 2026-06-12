// Shared taxonomy + colour palette for the per-client Lead Status
// dropdown on the territory modal AND the "My Clients" list chip / row
// tint. One source of truth so the modal, the list chip and any future
// surface stay in lockstep.
//
// Display order matches the user's spec: cold leads at the top, warm
// leads in the middle, dead/blocked at the bottom of the warm block,
// and the "Regular Client" terminal-state at the very bottom (graduation).

export const LEAD_STATUS_OPTIONS = [
  { value: "not_contacted",      label: "Not Contacted",      tone: "orange" },
  { value: "contact_attempted",  label: "Contact Attempted",  tone: "sky"    },
  { value: "contacted",          label: "Contacted",          tone: "blue"   },
  { value: "interested",         label: "Interested",         tone: "purple" },
  { value: "follow_up_required", label: "Follow Up Required", tone: "yellow" },
  { value: "not_interested",     label: "Not Interested",     tone: "red"    },
  { value: "do_not_contact",     label: "Do Not Contact",     tone: "red"    },
  { value: "regular_client",     label: "Client",             tone: "green"  },
];

// Tailwind tokens per tone — kept in one place so the chip + the
// border colour on the select stay in lockstep.
// ``optionBg`` is the actual hex colour the native <option> element
// uses for its background (native <option> can't be styled via Tailwind
// classes — it has to be inline-styled with concrete colours).
// ``rowBg`` is the very faint hover/row tint used on the My Clients
// list so each row reads as the colour of its lead status at a glance.
export const TONE_STYLES = {
  orange: { dot: "bg-orange-500",  chip: "bg-orange-50 border-orange-300 text-orange-900", border: "border-orange-400", fill: "bg-orange-50", rowBg: "#fff7ed", optionBg: "#fff7ed", optionFg: "#7c2d12" },
  sky:    { dot: "bg-sky-400",     chip: "bg-sky-50 border-sky-300 text-sky-900",          border: "border-sky-400",    fill: "bg-sky-50",    rowBg: "#f0f9ff", optionBg: "#f0f9ff", optionFg: "#0c4a6e" },
  blue:   { dot: "bg-blue-500",    chip: "bg-blue-50 border-blue-300 text-blue-900",       border: "border-blue-400",   fill: "bg-blue-50",   rowBg: "#eff6ff", optionBg: "#eff6ff", optionFg: "#1e3a8a" },
  purple: { dot: "bg-purple-500",  chip: "bg-purple-50 border-purple-300 text-purple-900", border: "border-purple-400", fill: "bg-purple-50", rowBg: "#faf5ff", optionBg: "#faf5ff", optionFg: "#581c87" },
  yellow: { dot: "bg-amber-400",   chip: "bg-amber-50 border-amber-300 text-amber-900",    border: "border-amber-400",  fill: "bg-amber-50",  rowBg: "#fffbeb", optionBg: "#fffbeb", optionFg: "#78350f" },
  green:  { dot: "bg-emerald-500", chip: "bg-emerald-50 border-emerald-300 text-emerald-900", border: "border-emerald-400", fill: "bg-emerald-50", rowBg: "#ecfdf5", optionBg: "#ecfdf5", optionFg: "#064e3b" },
  red:    { dot: "bg-red-500",     chip: "bg-red-50 border-red-300 text-red-900",          border: "border-red-400",    fill: "bg-red-50",    rowBg: "#fef2f2", optionBg: "#fef2f2", optionFg: "#7f1d1d" },
  grey:   { dot: "bg-stone-300",   chip: "bg-stone-50 border-stone-300 text-stone-700",    border: "border-stone-300",  fill: "bg-stone-50",  rowBg: "transparent", optionBg: "#fafaf9", optionFg: "#44403c" },
};

// Resolve a stored ``lead_status`` value to its option + tone style.
// Falls back to a neutral grey "Not set" presentation so legacy or
// removed values (e.g. "meeting_booked", which was retired) don't blow
// up the UI — they just look unstyled.
export function getLeadStatusMeta(value) {
  const opt = LEAD_STATUS_OPTIONS.find((o) => o.value === value);
  if (!opt) return { option: null, tone: TONE_STYLES.grey, label: "" };
  return { option: opt, tone: TONE_STYLES[opt.tone], label: opt.label };
}
