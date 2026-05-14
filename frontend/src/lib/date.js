// Site-wide UK date formatting helpers (DD/MM/YYYY).

export function formatDate(value, fallback = "—") {
  if (!value) return fallback;
  const s = String(value);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = new Date(s);
  if (!isNaN(d)) {
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  }
  return s.slice(0, 10);
}

export function daysBetween(fromValue, toValue) {
  if (!fromValue || !toValue) return null;
  const a = new Date(fromValue);
  const b = new Date(toValue);
  if (isNaN(a) || isNaN(b)) return null;
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

export function daysFromToday(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d)) return null;
  return Math.floor((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

export function daysSinceToday(value) {
  const d = daysFromToday(value);
  return d == null ? null : -d;
}
