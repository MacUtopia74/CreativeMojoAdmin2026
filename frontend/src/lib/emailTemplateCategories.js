// Group email templates into UX-friendly buckets based on the free-text
// "Category (optional tag)" field on each template. Case-insensitive
// keyword match — this keeps things flexible for HQ without forcing a
// strict enum, while still surfacing clear headings in the sidebar and
// the reply-with-template dropdowns.
//
// Buckets (in display order):
//   FRANCHISE ENQUIRIES   — enquiry/lead-facing templates
//   FRANCHISE SETUP       — onboarding/launch-facing templates
//   OTHER                 — everything else
//
// Extend the keyword arrays below if new template types come along.

export const CATEGORY_BUCKETS = [
  { id: "franchise_enquiries", label: "FRANCHISE ENQUIRIES", keywords: ["enquiry", "enquiries", "lead", "prospect", "franchise enquiry", "licence"] },
  { id: "franchise_setup",     label: "FRANCHISE SETUP",     keywords: ["setup", "onboarding", "launch", "mandate", "welcome", "new franchise", "dbs"] },
  { id: "other",               label: "OTHER",               keywords: [] }, // fallback
];

export function bucketForCategory(rawCategory) {
  const c = String(rawCategory || "").trim().toLowerCase();
  if (!c) return "other";
  for (const b of CATEGORY_BUCKETS) {
    if (b.id === "other") continue;
    if (b.keywords.some((k) => c.includes(k))) return b.id;
  }
  return "other";
}

// Group a flat list of templates into { bucketId → templates[] }.
// Preserves the original array order within each bucket.
export function groupTemplatesByBucket(templates) {
  const out = Object.fromEntries(CATEGORY_BUCKETS.map((b) => [b.id, []]));
  for (const t of templates || []) {
    out[bucketForCategory(t.category)].push(t);
  }
  return out;
}
