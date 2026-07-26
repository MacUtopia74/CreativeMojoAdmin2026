// Colour palette for the "Display name" tag on email templates.
//
// Three greens, three oranges, three reds — surfaced in the template
// editor's picker AND on every row of the templates list AND inside the
// "Reply with template" dropdown. Kept in a single module so all three
// call-sites stay perfectly in sync, and any future palette tweaks
// happen in exactly one place.
//
// Each entry:
//   value  → matches backend ALLOWED_DISPLAY_COLORS
//   label  → shown as a tooltip when picking a colour
//   bg     → Tailwind class for the pill background
//   text   → Tailwind class for the pill text
//   border → Tailwind class for the pill border (kept subtle so the
//            hue reads before the outline)
export const DISPLAY_COLOR_OPTIONS = [
  { value: "green_1",  label: "Green — soft",   bg: "bg-emerald-100", text: "text-emerald-900", border: "border-emerald-300" },
  { value: "green_2",  label: "Green — mid",    bg: "bg-emerald-300", text: "text-emerald-950", border: "border-emerald-400" },
  { value: "green_3",  label: "Green — strong", bg: "bg-emerald-600", text: "text-white",       border: "border-emerald-700" },
  { value: "orange_1", label: "Orange — soft",   bg: "bg-orange-100",  text: "text-orange-900",  border: "border-orange-300" },
  { value: "orange_2", label: "Orange — mid",    bg: "bg-orange-300",  text: "text-orange-950",  border: "border-orange-400" },
  { value: "orange_3", label: "Orange — strong", bg: "bg-orange-600",  text: "text-white",       border: "border-orange-700" },
  { value: "red_1",    label: "Red — soft",   bg: "bg-red-100", text: "text-red-900", border: "border-red-300" },
  { value: "red_2",    label: "Red — mid",    bg: "bg-red-300", text: "text-red-950", border: "border-red-400" },
  { value: "red_3",    label: "Red — strong", bg: "bg-red-600", text: "text-white",   border: "border-red-700" },
];

// Neutral fallback — used when a template has no colour selected.
export const NEUTRAL_DISPLAY_COLOR = {
  bg: "bg-stone-100",
  text: "text-stone-800",
  border: "border-stone-300",
};

// Lookup for a specific colour value. Falls back to the neutral chip
// when the value is missing/unknown so a legacy row never renders as
// invisible text on a white background.
export function displayColorClasses(value) {
  if (!value) return NEUTRAL_DISPLAY_COLOR;
  const found = DISPLAY_COLOR_OPTIONS.find((o) => o.value === value);
  return found || NEUTRAL_DISPLAY_COLOR;
}

// Rendered pill component used by both the templates list rail AND the
// custom dropdown inside the Reply-with-template modal so the two views
// never drift.
export function DisplayNamePill({ displayName, color, size = "sm", className = "" }) {
  const c = displayColorClasses(color);
  const text = displayName || "";
  if (!text) return null;
  const sizeCls = size === "xs"
    ? "px-1.5 py-0.5 text-[9px]"
    : "px-2 py-0.5 text-[10px]";
  return (
    <span
      data-testid={`display-name-pill${color ? `-${color}` : ""}`}
      className={`inline-block ${sizeCls} font-bold uppercase tracking-wider border rounded ${c.bg} ${c.text} ${c.border} ${className}`}
    >
      {text}
    </span>
  );
}
