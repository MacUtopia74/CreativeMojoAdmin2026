// Display-only title casing for slugged folder names brought across from
// FileCamp (and elsewhere). Underlying R2 keys stay URL-safe (lowercase,
// dash-separated); the UI shows them in human form.
//
// Rules:
//   - If the input already contains any uppercase letter, we assume it's
//     already cased correctly (e.g. "All Projects & Templates (Guides)").
//   - Otherwise split on `-` / `_` / whitespace, then capitalise each
//     token. Known acronyms stay fully uppercase. Common connector words
//     ("and", "or", "of"…) stay lowercase mid-string.

const ACRONYMS = new Set([
  "PDF", "UK", "USA", "US", "FAQ", "CEO", "CFO", "COO",
  "ID", "TV", "UI", "UX", "CSV", "KPI", "WIP", "R2",
  "AGM", "HR", "IT", "PR", "CRM", "API", "SDK", "QR",
  "PNG", "JPG", "JPEG", "GIF", "DOC", "DOCX", "XLS",
  "XLSX", "PPT", "PPTX", "ZIP", "MP3", "MP4", "WAV", "SVG",
  "NHS", "BBC", "ITV", "EU", "GB", "AI", "VAT", "GDPR",
]);

const SMALL = new Set([
  "and", "or", "of", "the", "a", "an", "for",
  "in", "on", "to", "at", "by", "with", "from",
  "as", "but", "vs",
]);

function capWord(low) {
  // Capitalise the first ALPHABETIC character so leading punctuation like
  // "(guides" → "(Guides" survives.
  return low.replace(/[a-z]/, (c) => c.toUpperCase());
}

export function prettyFolderName(raw) {
  if (raw === null || raw === undefined) return raw;
  const s = String(raw);
  if (!s) return s;
  // Already contains an uppercase letter → assume properly cased.
  if (/[A-Z]/.test(s)) return s;
  const text = s.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return text;
  const tokens = text.split(" ");
  return tokens
    .map((tok, i) => {
      const up = tok.toUpperCase();
      if (ACRONYMS.has(up)) return up;
      const low = tok.toLowerCase();
      if (i > 0 && i < tokens.length - 1 && SMALL.has(low)) return low;
      return capWord(low);
    })
    .join(" ");
}
