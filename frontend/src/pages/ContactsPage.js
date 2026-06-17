import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import api from "@/lib/api";
import LinkExistingFranchiseeModal from "@/components/contacts/LinkExistingFranchiseeModal";
import MergeContactsModal from "@/components/contacts/MergeContactsModal";
import DuplicatesModal from "@/components/contacts/DuplicatesModal";
import { Search, AlertCircle, LayoutList, Kanban, X, Mail, Phone, MapPin, Calendar, Trash2, ArrowUpCircle, ArrowDownCircle, Loader2, Users, Briefcase, ArrowRightLeft, ChevronDown, ChevronsLeft, ChevronsRight, CheckSquare, Square, Instagram, Facebook, Twitter, Globe, HelpCircle, UserPlus, Plus, Sparkles, Upload, FileText, CheckCircle2, Send, Award, Target, Link2, GitMerge, Home, Package, Flame, Clock, Pencil, RefreshCw } from "lucide-react";
import ReplyWithTemplateModal from "@/components/ReplyWithTemplateModal";
import EmailTimeline from "@/components/EmailTimeline";

const STAGES = [
  { key: "new", label: "New", color: "bg-stone-100 text-stone-700 border-stone-300", barColor: "bg-stone-400" },
  { key: "contacted", label: "Contacted", color: "bg-blue-50 text-blue-700 border-blue-200", barColor: "bg-blue-400" },
  { key: "qualified", label: "Interested", color: "bg-amber-50 text-amber-800 border-amber-200", barColor: "bg-amber-400" },
  { key: "dormant", label: "Dormant", color: "bg-orange-50 text-orange-800 border-orange-200", barColor: "bg-orange-400" },
  { key: "lost", label: "Lost", color: "bg-red-50 text-red-700 border-red-200", barColor: "bg-red-400" },
];

// "Shadow Day Booked" and "Territory Map" are no longer top-level pipeline
// stages — the equivalent steps live on the per-contact Interested-stage
// checklist (territory_defined, contract_sent, shadow_day_booked) so the
// admin can track them as small ticks rather than full stage transitions.
// FRANCHISE_ONLY_STAGES is kept as an empty Set for backwards-compat in
// any helper that still references it.
const FRANCHISE_ONLY_STAGES = new Set();

// Legacy stages we still need to *recognise* (e.g. a contact moved to
// "demo_booked" before this restructure) so we don't break their badge
// rendering. Anyone landing in these now is auto-shown the "Interested"
// stage label in the drawer.
const LEGACY_STAGE_FALLBACK = { demo_booked: "qualified", converted: "qualified" };

function stagesForContact(contact) {
  if (!contact) return STAGES;
  return STAGES;
}

const STAGE_MAP = Object.fromEntries(STAGES.map((s) => [s.key, s]));

// Pipeline lead-temperature tag. Re-introduced May 22 2026 at the
// pipeline level: a quick read of how "warm" a lead is, displayed as a
// coloured Flame icon on the kanban card AND in the drawer header (the
// drawer copy is read-only — change it from the card to save space).
const TEMPERATURES = [
  { key: "hot",      label: "Hot",      colour: "text-orange-500", fill: "#F97316", ring: "ring-orange-300" },
  { key: "keen",     label: "Keen",     colour: "text-purple-500", fill: "#A855F7", ring: "ring-purple-300" },
  { key: "lukewarm", label: "Lukewarm", colour: "text-blue-500",   fill: "#3B82F6", ring: "ring-blue-300" },
];
const TEMP_MAP = Object.fromEntries(TEMPERATURES.map((t) => [t.key, t]));

// Small reusable picker — three coloured flames. Active flame is filled,
// the others outlined. Click on the active flame clears it. Used on
// every kanban card so Sandra can grade leads with one click.
function TemperaturePicker({ value, onChange, size = "sm", testidPrefix = "temp" }) {
  const dim = size === "xs" ? "w-3.5 h-3.5" : size === "lg" ? "w-5 h-5" : "w-4 h-4";
  return (
    <div className="inline-flex items-center gap-0.5" data-testid={`${testidPrefix}-picker`}>
      {TEMPERATURES.map((t) => {
        const active = value === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange(active ? null : t.key);
            }}
            title={`${t.label}${active ? " · click to clear" : ""}`}
            aria-label={t.label}
            data-testid={`${testidPrefix}-${t.key}${active ? "-active" : ""}`}
            className={`p-0.5 rounded-md transition-all ${active ? `bg-white ring-1 ${t.ring}` : "opacity-30 hover:opacity-100"}`}>
            <Flame
              className={`${dim} ${t.colour}`}
              fill={active ? t.fill : "none"}
              strokeWidth={active ? 1.5 : 2}
            />
          </button>
        );
      })}
    </div>
  );
}

// Read-only flame for places like the drawer header where we want to
// show the current grade without offering the picker. Returns null when
// no temperature is set.
function TemperatureFlame({ value, size = "md" }) {
  if (!value || !TEMP_MAP[value]) return null;
  const t = TEMP_MAP[value];
  const dim = size === "sm" ? "w-3.5 h-3.5" : size === "lg" ? "w-5 h-5" : "w-4 h-4";
  return (
    <span title={t.label} data-testid={`temperature-flame-${t.key}`} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-white border border-stone-200">
      <Flame className={`${dim} ${t.colour}`} fill={t.fill} strokeWidth={1.5} />
      <span className={`text-[10px] font-bold uppercase tracking-wider ${t.colour}`}>{t.label}</span>
    </span>
  );
}

// LocalStorage-backed "Recent Searches" cache (last 10 distinct queries,
// most-recent first). Keyed per-user-agent — quick, no backend needed.
// SECURITY NOTE: this stores only the admin user's *own search terms*
// (names they've typed into the contacts filter). No PII beyond what
// they've already chosen to look up; no auth tokens, no secrets. The
// scanner's general "localStorage is unencrypted" warning doesn't apply
// to this use case.
const RECENT_SEARCH_KEY = "contactsRecentSearches";
const RECENT_SEARCH_LIMIT = 10;
function loadRecentSearches() {
  try {
    const raw = localStorage.getItem(RECENT_SEARCH_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string" && s.trim()) : [];
  } catch { return []; }
}
function saveRecentSearch(q) {
  const v = (q || "").trim();
  if (!v) return;
  try {
    const cur = loadRecentSearches();
    // De-dupe case-insensitively but preserve the user's original casing.
    const lower = v.toLowerCase();
    const filtered = cur.filter((s) => s.toLowerCase() !== lower);
    const next = [v, ...filtered].slice(0, RECENT_SEARCH_LIMIT);
    localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(next));
  } catch { /* localStorage full / disabled — silently ignore */ }
}
function clearRecentSearches() {
  try { localStorage.removeItem(RECENT_SEARCH_KEY); } catch { /* noop */ }
}

const TABS = [
  { key: "pipeline", label: "Sales Pipeline", hint: "Leads being actively worked", icon: Briefcase },
  { key: "franchise", label: "Franchise Contacts", hint: "Franchise enquiries not in the pipeline", icon: Users, accent: "stone" },
  { key: "licence", label: "Licence Contacts", hint: "Licence enquiries not in the pipeline", icon: UserPlus, accent: "indigo" },
  { key: "care_home", label: "Care Home Contacts", hint: "Care-home class enquiries (reference only)", icon: Home, accent: "teal" },
  { key: "art_kit", label: "Art Kit Contacts", hint: "Deliverable Art Kit enquiries (reference only)", icon: Package, accent: "amber" },
  { key: "general", label: "General Contacts", hint: "General enquiries & legacy contacts", icon: Users },
];

// Visual differentiation for franchise vs licence enquiries throughout the app.
// Used in pipeline kanban cards (border colour), list view source pills, and the drawer.
const SOURCE_STYLE = {
  franchise_enquiry:        { label: "Franchise", pill: "bg-stone-100 text-stone-800 border-stone-300", barColor: "bg-stone-500", border: "border-l-4 border-l-stone-500" },
  licence_enquiry:          { label: "Licence",   pill: "bg-indigo-50 text-indigo-800 border-indigo-300", barColor: "bg-indigo-500", border: "border-l-4 border-l-indigo-500" },
  care_home_enquiry:        { label: "Care Home", pill: "bg-teal-50 text-teal-800 border-teal-300", barColor: "bg-teal-500", border: "border-l-4 border-l-teal-500" },
  art_kit_enquiry:          { label: "Art Kit",   pill: "bg-amber-50 text-amber-900 border-amber-300", barColor: "bg-amber-500", border: "border-l-4 border-l-amber-500" },
  general_enquiry:          { label: "General",   pill: "bg-stone-100 text-stone-700 border-stone-200", barColor: "bg-stone-400", border: "" },
  legacy_general_enquiry:   { label: "Legacy",    pill: "bg-stone-100 text-stone-500 border-stone-200", barColor: "bg-stone-300", border: "" },
};

const REFERRAL_ICONS = {
  Instagram: Instagram,
  Facebook:  Facebook,
  X:         Twitter,
  Twitter:   Twitter,
  TikTok:    Globe,
  Google:    Globe,
  Friend:    Users,
  "Word of Mouth": Users,
  Other:     HelpCircle,
};

function formatDate(value) {
  if (!value) return "—";
  // Accept "YYYY-MM-DD" or full ISO "YYYY-MM-DD HH:MM:SS" / "YYYY-MM-DDTHH:MM:SSZ"
  const s = String(value);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return s.slice(0, 10);
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr); if (isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}
function daysLabel(d) {
  if (d == null) return "—";
  if (d === 0) return "today";
  if (d === 1) return "1d";
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

// Pipeline age tiers — used to filter and visually grade cards so "New" actually means new.
const AGE_TIERS = [
  { key: "all",    label: "All ages",           test: () => true,                              accent: "" },
  { key: "fresh",  label: "Fresh (≤ 30 days)",  test: (d) => d != null && d <= 30,             accent: "border-l-4 border-l-emerald-400" },
  { key: "recent", label: "Recent (30–90 days)",test: (d) => d != null && d > 30 && d <= 90,   accent: "border-l-4 border-l-amber-400" },
  { key: "stale",  label: "Stale (90+ days)",   test: (d) => d != null && d > 90,              accent: "border-l-4 border-l-stone-300" },
];

function ageTier(days) {
  if (days == null) return null;
  if (days <= 30) return "fresh";
  if (days <= 90) return "recent";
  return "stale";
}

function AgeBadge({ days }) {
  if (days == null) return null;
  const tier = ageTier(days);
  const cls = tier === "fresh"  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
            : tier === "recent" ? "bg-amber-50 text-amber-800 border-amber-200"
            : "bg-stone-100 text-stone-500 border-stone-200";
  return (
    <span className={`px-1.5 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider border ${cls}`}>
      {daysLabel(days)}
    </span>
  );
}

function ManualBadge({ addedBy }) {
  if (!addedBy) return null;
  return (
    <span title={`Added manually by ${addedBy}`} className="inline-flex items-center gap-0.5 text-[#dddd16]" data-testid="manual-badge">
      <Sparkles className="w-3 h-3" fill="#dddd16" stroke="#A89A00" strokeWidth={1} />
    </span>
  );
}

function StageBadge({ status }) {
  // Normalise any retired stages (demo_booked / converted) so historic
  // contacts still render a familiar badge after the May 2026 simplification.
  const norm = LEGACY_STAGE_FALLBACK[status] || status;
  const s = STAGE_MAP[norm];
  if (!s) return <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-stone-100 text-stone-500 border border-stone-200 rounded-full">{norm || "—"}</span>;
  return <span className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border rounded-full ${s.color}`}>{s.label}</span>;
}
function AddContactModal({ open, onClose, onCreated, defaultTarget = "franchise" }) {
  const [form, setForm] = useState({
    target: defaultTarget,
    first_name: "", last_name: "", email: "", telephone: "",
    address_line_1: "", address_line_2: "",
    city: "", county: "", postcode: "", country: "United Kingdom",
    establishment_name: "",
    referral_source: "", notes: "",
    pipeline_status: "new",
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (open) {
      setForm((f) => ({ ...f, target: defaultTarget }));
      setErr("");
    }
  }, [open, defaultTarget]);

  if (!open) return null;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    if (!form.first_name && !form.last_name && !form.email && !form.establishment_name) {
      setErr("Please provide a first name, last name, email, or establishment.");
      return;
    }
    setSubmitting(true);
    setErr("");
    try {
      const payload = { ...form };
      if (payload.target !== "pipeline") delete payload.pipeline_status;
      Object.keys(payload).forEach((k) => { if (payload[k] === "") delete payload[k]; });
      const r = await api.post("/contacts", payload);
      onCreated && onCreated(r.data.contact, form.target);
      onClose();
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not save contact.");
    } finally {
      setSubmitting(false);
    }
  };

  const TARGETS = [
    { key: "franchise", label: "Franchise Contacts", icon: Users },
    { key: "licence",   label: "Licence Contacts",   icon: UserPlus },
    { key: "general",   label: "General Contacts",   icon: Users },
    { key: "pipeline",  label: "Sales Pipeline",     icon: Briefcase },
  ];
  const REFERRALS = ["Instagram", "Facebook", "X", "TikTok", "Google", "Friend", "Word of Mouth", "Other"];

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 bg-stone-950/40 backdrop-blur-sm flex items-start justify-center p-6 overflow-y-auto" data-testid="add-contact-modal">
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        className="w-full max-w-2xl bg-white border border-stone-200 rounded-2xl shadow-2xl my-10">
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">New contact</div>
            <h2 className="text-xl font-display font-black text-stone-950 mt-1">Add a Contact</h2>
          </div>
          <button type="button" onClick={onClose} data-testid="add-contact-close" className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-2">Where should this contact land?</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {TARGETS.map((t) => {
                const active = form.target === t.key;
                const Icon = t.icon;
                return (
                  <button key={t.key} type="button" onClick={() => setForm((f) => ({ ...f, target: t.key }))}
                    data-testid={`add-target-${t.key}`}
                    className={`px-3 py-3 border rounded-xl text-xs font-bold uppercase tracking-wider flex flex-col items-center gap-1.5 transition-colors ${
                      active ? "bg-stone-950 text-white border-stone-950" : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"
                    }`}>
                    <Icon className="w-4 h-4" />
                    <span className="text-[10px] leading-tight text-center">{t.label}</span>
                  </button>
                );
              })}
            </div>
            {form.target === "pipeline" && (
              <div className="mt-3">
                <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1.5">Starting pipeline stage</label>
                <select value={form.pipeline_status} onChange={set("pipeline_status")} data-testid="add-pipeline-stage"
                  className="w-full px-3 py-2 bg-white border border-stone-300 text-sm rounded-lg focus:outline-none focus:border-stone-900">
                  {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="First name" value={form.first_name} onChange={set("first_name")} testid="add-first-name" />
            <Field label="Last name" value={form.last_name} onChange={set("last_name")} testid="add-last-name" />
            <Field label="Email" type="email" value={form.email} onChange={set("email")} testid="add-email" />
            <Field label="Telephone" value={form.telephone} onChange={set("telephone")} testid="add-telephone" />
            <Field label="Establishment" value={form.establishment_name} onChange={set("establishment_name")} testid="add-establishment" wide />
          </div>

          {/* Address — full UK-shape block so manually-added contacts
              carry the same address detail as Airtable / Gravity Forms
              imports. The "Country" field defaults to United Kingdom but
              is editable for the occasional overseas enquiry. */}
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-2">Address</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="1st line of address" value={form.address_line_1} onChange={set("address_line_1")} testid="add-address-1" wide />
              <Field label="2nd line of address" value={form.address_line_2} onChange={set("address_line_2")} testid="add-address-2" wide />
              <Field label="Town / City" value={form.city} onChange={set("city")} testid="add-city" />
              <Field label="County / State" value={form.county} onChange={set("county")} testid="add-county" />
              <Field label="Postcode" value={form.postcode} onChange={set("postcode")} testid="add-postcode" />
              <Field label="Country" value={form.country} onChange={set("country")} testid="add-country" />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="md:col-span-2">
              <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1.5">Where did they hear about us?</label>
              <select value={form.referral_source} onChange={set("referral_source")} data-testid="add-referral"
                className="w-full px-3 py-2 bg-white border border-stone-300 text-sm rounded-lg focus:outline-none focus:border-stone-900">
                <option value="">— Not specified —</option>
                {REFERRALS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1.5">Notes</label>
              <textarea value={form.notes} onChange={set("notes")} data-testid="add-notes" rows={3}
                className="w-full px-3 py-2 bg-white border border-stone-300 text-sm rounded-lg focus:outline-none focus:border-stone-900" />
            </div>
          </div>

          {err && <div className="px-4 py-3 border border-red-200 bg-red-50 text-sm text-red-800 rounded-xl flex items-center gap-2"><AlertCircle className="w-4 h-4" />{err}</div>}
        </div>

        <div className="px-6 py-4 border-t border-stone-200 flex items-center justify-end gap-2 bg-stone-50 rounded-b-2xl">
          <button type="button" onClick={onClose} data-testid="add-contact-cancel"
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 rounded-lg">
            Cancel
          </button>
          <button type="submit" disabled={submitting} data-testid="add-contact-submit"
            className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-lg disabled:opacity-50 flex items-center gap-1.5">
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Save contact
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", testid, wide }) {
  return (
    <div className={wide ? "md:col-span-2" : ""}>
      <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1.5">{label}</label>
      <input type={type} value={value} onChange={onChange} data-testid={testid}
        className="w-full px-3 py-2 bg-white border border-stone-300 text-sm rounded-lg focus:outline-none focus:border-stone-900" />
    </div>
  );
}

// CSV header alias map — common Gravity Forms / Excel column variations
const CSV_HEADER_ALIASES = {
  first_name:         ["first name", "firstname", "given name", "fname"],
  last_name:          ["last name", "surname", "surname name", "lastname", "family name", "lname"],
  email:              ["email", "email address", "e-mail"],
  telephone:          ["telephone", "telephone number", "phone", "phone number", "mobile", "tel"],
  postcode:           ["postcode", "post code", "zip", "zip code", "postal code"],
  city:               ["city", "city / town", "town", "city/town"],
  country:            ["country"],
  establishment_name: ["establishment", "establishment name", "business", "business name", "company", "1st line of address", "address"],
  referral_source:    ["referral", "referral source", "where did you hear about us", "where did you hear about creative mojo", "how did you hear about us"],
  message:            ["message", "your message", "comments", "notes"],
  date:               ["date", "entry date", "submission date", "submitted at", "created", "created at"],
};

function parseCsv(text) {
  // Tolerant CSV parser handling quoted fields with embedded commas + newlines + ""-escape
  const rows = [];
  let row = [], cell = "", inQuotes = false, i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { inQuotes = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; continue; }
    cell += ch; i++;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c && c.trim()));
}

function mapHeaders(headers) {
  const out = {};
  headers.forEach((h, idx) => {
    const norm = (h || "").trim().toLowerCase();
    for (const field of Object.keys(CSV_HEADER_ALIASES)) {
      if (CSV_HEADER_ALIASES[field].includes(norm) || norm === field) {
        out[field] = idx;
        break;
      }
    }
  });
  return out;
}

function ImportCsvModal({ open, onClose, onImported, defaultTarget = "licence" }) {
  const [step, setStep] = useState(1);          // 1: upload, 2: preview, 3: done
  const [target, setTarget] = useState(defaultTarget);
  const [pipelineStage, setPipelineStage] = useState("new");
  const [dedupe, setDedupe] = useState(true);
  const [filename, setFilename] = useState("");
  const [headers, setHeaders] = useState([]);
  const [mapped, setMapped] = useState({});
  const [parsedRows, setParsedRows] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => { if (open) { setStep(1); setTarget(defaultTarget); setErr(""); setResult(null); setParsedRows([]); setHeaders([]); setMapped({}); setFilename(""); } }, [open, defaultTarget]);

  if (!open) return null;

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setErr("");
    setFilename(f.name);
    try {
      const text = await f.text();
      const rows = parseCsv(text);
      if (rows.length < 2) { setErr("CSV looks empty — need a header row and at least one data row."); return; }
      const hdrs = rows[0].map((h) => (h || "").trim());
      const dataRows = rows.slice(1);
      const colMap = mapHeaders(hdrs);
      const matchedFields = Object.keys(colMap).length;
      if (matchedFields === 0) { setErr(`No recognised columns. CSV headers I saw: ${hdrs.join(", ")}`); return; }
      // Project each row into a typed object
      const proj = dataRows.map((r) => {
        const obj = {};
        Object.entries(colMap).forEach(([field, idx]) => { obj[field] = (r[idx] || "").trim(); });
        return obj;
      }).filter((o) => o.first_name || o.last_name || o.email || o.establishment_name);
      setHeaders(hdrs);
      setMapped(colMap);
      setParsedRows(proj);
      setStep(2);
    } catch (ex) {
      setErr("Could not read the file. Please upload a UTF-8 CSV.");
    }
  };

  const TARGETS = [
    { key: "licence",   label: "Licence Contacts",   icon: UserPlus },
    { key: "franchise", label: "Franchise Contacts", icon: Users },
    { key: "general",   label: "General Contacts",   icon: Users },
    { key: "pipeline",  label: "Sales Pipeline",     icon: Briefcase },
  ];

  const submit = async () => {
    setBusy(true); setErr("");
    try {
      const payload = { target, dedupe_by_email: dedupe, rows: parsedRows };
      if (target === "pipeline") payload.pipeline_status = pipelineStage;
      const r = await api.post("/contacts/import", payload);
      setResult(r.data);
      setStep(3);
      onImported && onImported(r.data, target);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Import failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 bg-stone-950/40 backdrop-blur-sm flex items-start justify-center p-6 overflow-y-auto" data-testid="import-csv-modal">
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl bg-white border border-stone-200 rounded-2xl shadow-2xl my-10">
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">Bulk import · Step {step} of 3</div>
            <h2 className="text-xl font-display font-black text-stone-950 mt-1">Import contacts from CSV</h2>
          </div>
          <button onClick={onClose} data-testid="import-close" className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg"><X className="w-4 h-4" /></button>
        </div>

        {step === 1 && (
          <div className="p-6 space-y-5">
            <div className="text-sm text-stone-700">
              Upload a CSV exported from Gravity Forms, Mailchimp, or any spreadsheet. We auto-detect the following columns (case-insensitive, common aliases supported):
            </div>
            <div className="grid grid-cols-2 gap-1 text-xs text-stone-600">
              {Object.keys(CSV_HEADER_ALIASES).map((f) => <div key={f}>· <code className="font-mono">{f}</code></div>)}
            </div>
            <label className="block">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-2">CSV file</div>
              <div className="border-2 border-dashed border-stone-300 rounded-xl p-6 text-center hover:border-stone-500 transition-colors cursor-pointer">
                <Upload className="w-6 h-6 mx-auto text-stone-400 mb-2" />
                <div className="text-sm text-stone-700">Click to choose, or drop a CSV file here</div>
                <input type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" data-testid="csv-file-input" />
              </div>
            </label>
            {err && <div className="px-4 py-3 border border-red-200 bg-red-50 text-sm text-red-800 rounded-xl flex items-center gap-2"><AlertCircle className="w-4 h-4 shrink-0" /><span>{err}</span></div>}
          </div>
        )}

        {step === 2 && (
          <div className="p-6 space-y-5">
            <div className="px-4 py-3 bg-stone-50 border border-stone-200 rounded-xl text-sm flex items-center gap-2">
              <FileText className="w-4 h-4 text-stone-500" />
              <span><strong>{filename}</strong> — {parsedRows.length} usable rows · {Object.keys(mapped).length} columns mapped</span>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-2">Send these contacts to</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {TARGETS.map((t) => {
                  const active = target === t.key;
                  const Icon = t.icon;
                  return (
                    <button key={t.key} onClick={() => setTarget(t.key)} data-testid={`import-target-${t.key}`}
                      className={`px-3 py-3 border rounded-xl text-xs font-bold uppercase tracking-wider flex flex-col items-center gap-1.5 ${
                        active ? "bg-stone-950 text-white border-stone-950" : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"
                      }`}>
                      <Icon className="w-4 h-4" /> <span className="text-[10px] leading-tight text-center">{t.label}</span>
                    </button>
                  );
                })}
              </div>
              {target === "pipeline" && (
                <div className="mt-3">
                  <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1.5">Starting pipeline stage</label>
                  <select value={pipelineStage} onChange={(e) => setPipelineStage(e.target.value)} data-testid="import-pipeline-stage"
                    className="w-full px-3 py-2 bg-white border border-stone-300 text-sm rounded-lg">
                    {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                </div>
              )}
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={dedupe} onChange={(e) => setDedupe(e.target.checked)} data-testid="import-dedupe" />
              <span>Skip rows whose email already exists in the CRM (recommended)</span>
            </label>

            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-2">Preview · first 5 rows</div>
              <div className="border border-stone-200 rounded-xl overflow-x-auto max-h-64">
                <table className="w-full text-xs">
                  <thead className="bg-stone-50 border-b border-stone-200">
                    <tr>{Object.keys(mapped).map((f) => <th key={f} className="px-2 py-1.5 text-left font-bold text-stone-700">{f}</th>)}</tr>
                  </thead>
                  <tbody>
                    {parsedRows.slice(0, 5).map((r, i) => (
                      <tr key={`row-${i}-${Object.values(r).slice(0, 3).join("|")}`} className="border-b border-stone-100 last:border-0">
                        {Object.keys(mapped).map((f) => <td key={f} className="px-2 py-1 text-stone-700 whitespace-nowrap">{r[f] || "—"}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {err && <div className="px-4 py-3 border border-red-200 bg-red-50 text-sm text-red-800 rounded-xl flex items-center gap-2"><AlertCircle className="w-4 h-4 shrink-0" /><span>{err}</span></div>}
          </div>
        )}

        {step === 3 && result && (
          <div className="p-6 space-y-3">
            <div className="px-4 py-4 bg-emerald-50 border border-emerald-200 rounded-xl flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 mt-0.5 shrink-0" />
              <div>
                <div className="font-bold text-emerald-900">Imported {result.inserted} contact{result.inserted === 1 ? "" : "s"}</div>
                <div className="text-xs text-emerald-800 mt-1">
                  Sent to <strong>{TARGETS.find((t) => t.key === result.target)?.label || result.target}</strong>.
                  {result.skipped_empty ? ` Skipped ${result.skipped_empty} empty rows.` : ""}
                  {result.skipped_duplicate ? ` Skipped ${result.skipped_duplicate} duplicate emails.` : ""}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="px-6 py-4 border-t border-stone-200 flex items-center justify-end gap-2 bg-stone-50 rounded-b-2xl">
          {step === 2 && (
            <button onClick={() => setStep(1)} className="px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 rounded-lg">
              ← Back
            </button>
          )}
          <button onClick={onClose} data-testid="import-cancel"
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 rounded-lg">
            {step === 3 ? "Close" : "Cancel"}
          </button>
          {step === 2 && (
            <button onClick={submit} disabled={busy || parsedRows.length === 0} data-testid="import-submit"
              className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-lg disabled:opacity-50 flex items-center gap-1.5">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              Import {parsedRows.length} contact{parsedRows.length === 1 ? "" : "s"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function sourceLabel(s) {
  return (SOURCE_STYLE[s]?.label) || s || "Other";
}

function SourcePill({ source }) {
  const sty = SOURCE_STYLE[source] || SOURCE_STYLE.general_enquiry;
  return (
    <span className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border rounded-md ${sty.pill}`}>
      {sty.label}
    </span>
  );
}

function ReferralBadge({ source }) {
  if (!source) return null;
  const Icon = REFERRAL_ICONS[source] || HelpCircle;
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-semibold bg-stone-100 text-stone-800 border border-stone-200 rounded-md">
      <Icon className="w-3 h-3" /> {source}
    </span>
  );
}

// Compact "Move to…" dropdown used both on rows (compact) and the bulk action bar
function MoveMenu({ onMove, label = "Move", testid, currentTab, count, contactSource, inPipeline }) {
  const [open, setOpen] = useState(false);
  const [showStages, setShowStages] = useState(false);
  const close = () => { setOpen(false); setShowStages(false); };
  // Highlight the contact's CURRENT source so the user sees what they're changing FROM.
  const currentType =
    contactSource === "licence_enquiry" ? "licence"
    : contactSource === "franchise_enquiry" ? "franchise"
    : contactSource === "general_enquiry" ? "general"
    : null;
  return (
    <div className="relative inline-block" onMouseLeave={close} data-testid={testid}>
      <button onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); setShowStages(false); }}
        className="px-2.5 py-1 text-xs font-bold uppercase tracking-wider bg-white border border-stone-300 text-stone-800 hover:bg-stone-50 rounded-lg flex items-center gap-1"
        data-testid={`${testid}-trigger`}>
        <ArrowRightLeft className="w-3 h-3" /> {label}{count != null && count > 0 ? ` (${count})` : ""}
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-64 bg-white border border-stone-200 rounded-xl shadow-lg overflow-hidden text-sm text-stone-900">
          {!showStages ? (
            <>
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 bg-stone-50 border-b border-stone-200">Change Type</div>
              <button onClick={(e) => { e.stopPropagation(); onMove("franchise"); close(); }} data-testid={`${testid}-franchise`}
                disabled={currentType === "franchise"}
                className="w-full text-left px-3 py-2 hover:bg-stone-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2">
                <Users className="w-3.5 h-3.5 text-stone-500" /> Franchise{currentType === "franchise" && <span className="ml-auto text-[9px] text-stone-400 uppercase tracking-wider">current</span>}
              </button>
              <button onClick={(e) => { e.stopPropagation(); onMove("licence"); close(); }} data-testid={`${testid}-licence`}
                disabled={currentType === "licence"}
                className="w-full text-left px-3 py-2 hover:bg-stone-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2">
                <UserPlus className="w-3.5 h-3.5 text-indigo-500" /> Licence{currentType === "licence" && <span className="ml-auto text-[9px] text-stone-400 uppercase tracking-wider">current</span>}
              </button>
              <button onClick={(e) => { e.stopPropagation(); onMove("general"); close(); }} data-testid={`${testid}-general`}
                disabled={currentType === "general"}
                className="w-full text-left px-3 py-2 hover:bg-stone-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2">
                <Users className="w-3.5 h-3.5 text-stone-500" /> General{currentType === "general" && <span className="ml-auto text-[9px] text-stone-400 uppercase tracking-wider">current</span>}
              </button>
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 bg-stone-50 border-y border-stone-200">Pipeline</div>
              <button onClick={(e) => { e.stopPropagation(); setShowStages(true); }} data-testid={`${testid}-pipeline`}
                className="w-full text-left px-3 py-2 hover:bg-stone-50 flex items-center justify-between">
                <span className="flex items-center gap-2"><Briefcase className="w-3.5 h-3.5 text-stone-500" /> {inPipeline ? "Change Pipeline Stage" : "Add to Pipeline"}</span>
                <ChevronDown className="w-3 h-3 -rotate-90 text-stone-400" />
              </button>
              {inPipeline && (
                <button onClick={(e) => { e.stopPropagation(); onMove("remove_from_pipeline"); close(); }} data-testid={`${testid}-remove-from-pipeline`}
                  className="w-full text-left px-3 py-2 hover:bg-stone-50 flex items-center gap-2 text-red-700">
                  <X className="w-3.5 h-3.5" /> Remove from Pipeline
                </button>
              )}
            </>
          ) : (
            <>
              <div className="px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 bg-stone-50 border-b border-stone-200">
                {inPipeline ? "Change stage to" : "Add to pipeline as"}
              </div>
              {STAGES.filter((s) => contactSource !== "licence_enquiry" || !FRANCHISE_ONLY_STAGES.has(s.key)).map((s) => (
                <button key={s.key} onClick={(e) => { e.stopPropagation(); onMove("pipeline", s.key); close(); }}
                  data-testid={`${testid}-stage-${s.key}`}
                  className="w-full text-left px-3 py-2 hover:bg-stone-50 flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full ${s.barColor}`} />
                  {s.label}
                </button>
              ))}
              <button onClick={(e) => { e.stopPropagation(); setShowStages(false); }} className="w-full text-left px-3 py-2 hover:bg-stone-50 text-stone-500 border-t border-stone-100 text-xs">
                ← Back
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ContactDrawer({ contact, onClose, onStageChange, onPromote, onDemote, onDelete, onReply, onConvert, onLinkExisting, onAdminNotesUpdated, onMergeWith, onChecklistChanged, onChangeSource, allContacts }) {
  const [busy, setBusy] = useState(false);
  const [converting, setConverting] = useState(false);
  const [replyModalOpen, setReplyModalOpen] = useState(false);  // Reply-with-template modal
  // Bumped after a successful send so <EmailTimeline> re-fetches and
  // surfaces the new entry without a page reload.
  const [emailRefreshSignal, setEmailRefreshSignal] = useState(0);
  // Inline edit of identity + address — staff routinely fix typos from
  // Gravity-Forms / Airtable imports. We hold a single ``editing``
  // boolean + a working ``draft`` copy that's only persisted on Save.
  const [editingDetails, setEditingDetails] = useState(false);
  const [detailsDraft, setDetailsDraft] = useState({});
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [detailsErr, setDetailsErr] = useState("");
  // Inline "Change type" picker — lets the admin reclassify an enquiry
  // between Franchise / Licence / General without leaving the drawer
  // (covers the common case where the contact filled in the wrong web form).
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  // Reset edit mode whenever the drawer switches contacts so half-edits
  // don't leak from one contact to another. Sits BEFORE the early-return
  // below to comply with React's Hook rules.
  useEffect(() => {
    setEditingDetails(false);
    setDetailsErr("");
  }, [contact?.id]);
  if (!contact) return null;
  const beginEditDetails = () => {
    setDetailsDraft({
      first_name: contact.first_name || "",
      last_name: contact.last_name || "",
      email: contact.email || contact.email_raw || "",
      telephone: contact.telephone || "",
      mobile_phone: contact.mobile_phone || "",
      address_line_1: contact.address_line_1 || contact.address_street || "",
      address_line_2: contact.address_line_2 || "",
      city: contact.city || contact.town_city || "",
      county: contact.county || "",
      postcode: contact.postcode || "",
      country: contact.country || "United Kingdom",
    });
    setDetailsErr("");
    setEditingDetails(true);
  };
  const saveDetails = async () => {
    setDetailsSaving(true); setDetailsErr("");
    try {
      const { data } = await api.patch(`/contacts/${contact.id}/details`, detailsDraft);
      // Forward the saved fields up — the parent's onChecklistChanged
      // patch already filters undefineds, so we reuse it as a generic
      // "fields-merge" channel without adding another prop.
      onChecklistChanged?.({
        id: contact.id,
        first_name: data.first_name,
        last_name: data.last_name,
        email: data.email,
        telephone: data.telephone,
        mobile_phone: data.mobile_phone,
        address_line_1: data.address_line_1,
        address_line_2: data.address_line_2,
        address_street: data.address_street,
        city: data.city,
        town_city: data.town_city,
        county: data.county,
        postcode: data.postcode,
        country: data.country,
      });
      setEditingDetails(false);
    } catch (e) {
      setDetailsErr(e?.response?.data?.detail || "Could not save changes.");
    } finally { setDetailsSaving(false); }
  };
  const setDraft = (k) => (e) => setDetailsDraft((d) => ({ ...d, [k]: e.target.value }));
  const isInPipeline = !!contact.in_pipeline;
  const dateAdded = contact.date || contact.date_added;
  const sinceCreated = daysSince(dateAdded);
  const isFranchiseEnq = contact.source === "franchise_enquiry";
  const isLicenceEnq = contact.source === "licence_enquiry";
  const homeTabLabel = isLicenceEnq ? "Licence Contacts" : isFranchiseEnq ? "Franchise Contacts" : "General Contacts";
  const convertLabel = isLicenceEnq ? "Convert to Licencee" : "Convert to Franchisee";
  const alreadyConverted = !!contact.converted_to_franchisee_id;

  const confirmDelete = async () => {
    if (!window.confirm("Permanently delete this contact? This cannot be undone.")) return;
    setBusy(true); try { await onDelete(contact.id); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex" data-testid="contact-drawer">
      <div className="flex-1 bg-stone-900/40 backdrop-blur-sm" onClick={onClose} />
      <aside className="w-full max-w-xl bg-white border-l border-stone-200 overflow-y-auto shadow-2xl">
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">
            {isInPipeline ? "Sales Pipeline" : homeTabLabel}
          </div>
          <div className="flex items-center gap-1">
            {contact.email && (
              <button onClick={() => setReplyModalOpen(true)} data-testid="drawer-reply-template"
                title="Reply using a saved Resend template"
                className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-lg flex items-center gap-1">
                <Mail className="w-3.5 h-3.5" /> Reply with template
              </button>
            )}
            {contact.email && onReply && (
              <button onClick={() => onReply(contact)} data-testid="drawer-reply"
                title="Open a quick blank reply in your own mail app"
                className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-white border border-stone-300 text-stone-700 hover:bg-stone-50 rounded-lg flex items-center gap-1">
                <Send className="w-3.5 h-3.5" /> Quick reply
              </button>
            )}
            {isInPipeline && (!contact.pipeline_status || contact.pipeline_status === "new") && (
              <button onClick={() => onStageChange(contact.id, "contacted")}
                data-testid="drawer-mark-contacted"
                title="Mark Contacted — use this if you've replied in your own email app"
                className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-white border border-stone-300 text-stone-700 hover:bg-stone-950 hover:text-white hover:border-stone-950 rounded-lg flex items-center gap-1 transition-colors">
                <CheckCircle2 className="w-3.5 h-3.5" /> Mark contacted
              </button>
            )}
            <button onClick={confirmDelete} disabled={busy} data-testid="drawer-delete"
              className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-red-700 hover:bg-red-50 rounded-lg flex items-center gap-1 disabled:opacity-50">
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </button>
            <button onClick={onClose} data-testid="drawer-close" className="p-2 text-stone-500 hover:text-stone-950 rounded-lg hover:bg-stone-100">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="p-6 space-y-6">
          <div>
            <h2 className="font-display text-3xl text-stone-950 flex items-center gap-2">
              {editingDetails ? (
                <span className="flex gap-2 w-full">
                  <input
                    value={detailsDraft.first_name || ""}
                    onChange={setDraft("first_name")}
                    placeholder="First name"
                    data-testid="drawer-edit-first-name"
                    className="flex-1 min-w-0 px-3 py-1.5 text-base font-sans font-semibold bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-stone-900"
                  />
                  <input
                    value={detailsDraft.last_name || ""}
                    onChange={setDraft("last_name")}
                    placeholder="Last name"
                    data-testid="drawer-edit-last-name"
                    className="flex-1 min-w-0 px-3 py-1.5 text-base font-sans font-semibold bg-white border border-stone-300 rounded-lg focus:outline-none focus:border-stone-900"
                  />
                </span>
              ) : (
                <>
                  <span>{[contact.first_name, contact.last_name].filter(Boolean).join(" ") || "(no name)"}</span>
                  <ManualBadge addedBy={contact.manually_added_by} />
                </>
              )}
            </h2>
            {contact.establishment_name && <div className="text-base text-stone-600 mt-1">{contact.establishment_name}</div>}
            <div className="flex items-center gap-2 flex-wrap mt-3">
              {isInPipeline && <StageBadge status={contact.pipeline_status} />}
              {isInPipeline && <TemperatureFlame value={contact.temperature} />}
              <SourcePill source={contact.source} />
              {onChangeSource && (contact.source === "franchise_enquiry" || contact.source === "licence_enquiry" || contact.source === "general_enquiry") && (
                <div className="relative" data-testid="drawer-change-source">
                  <button
                    type="button"
                    onClick={() => setSourceMenuOpen((v) => !v)}
                    data-testid="drawer-change-source-trigger"
                    title="Reclassify this enquiry"
                    className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 rounded-md inline-flex items-center gap-1">
                    <ArrowRightLeft className="w-3 h-3" /> Change type
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  {sourceMenuOpen && (
                    <div onMouseLeave={() => setSourceMenuOpen(false)}
                      className="absolute left-0 top-full mt-1 z-50 w-56 bg-white border border-stone-200 rounded-xl shadow-lg overflow-hidden text-sm text-stone-900">
                      <div className="px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 bg-stone-50 border-b border-stone-200">Reclassify enquiry</div>
                      {[
                        { key: "franchise", label: "Franchise enquiry", source: "franchise_enquiry", Icon: Users, iconClass: "text-stone-500" },
                        { key: "licence",   label: "Licence enquiry",   source: "licence_enquiry",   Icon: UserPlus, iconClass: "text-indigo-500" },
                        { key: "general",   label: "General enquiry",   source: "general_enquiry",   Icon: Users, iconClass: "text-stone-500" },
                      ].map(({ key, label, source, Icon, iconClass }) => {
                        const current = contact.source === source;
                        return (
                          <button key={key} type="button"
                            disabled={current}
                            onClick={async () => {
                              setSourceMenuOpen(false);
                              await onChangeSource(contact, key);
                            }}
                            data-testid={`drawer-change-source-${key}`}
                            className="w-full text-left px-3 py-2 hover:bg-stone-50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2">
                            <Icon className={`w-3.5 h-3.5 ${iconClass}`} />
                            <span className="flex-1">{label}</span>
                            {current && <span className="text-[9px] text-stone-400 uppercase tracking-wider">current</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              {contact.referral_source && <ReferralBadge source={contact.referral_source} />}
            </div>
            {contact.referral_source && (
              <div className="text-xs text-stone-500 mt-2">
                Heard about Creative Mojo via <strong>{contact.referral_source}</strong>
              </div>
            )}
            {contact.manually_added_by && (
              <div className="mt-3 px-3 py-2 bg-[#dddd16]/10 border border-[#dddd16]/40 rounded-lg flex items-center gap-2 text-xs text-stone-800" data-testid="drawer-manual-flag">
                <Sparkles className="w-3.5 h-3.5 text-stone-700" fill="#dddd16" />
                <span>
                  Added manually by <strong>{contact.manually_added_by}</strong>
                  {contact.created_at && (
                    <> on <strong>{(() => {
                      const s = String(contact.created_at);
                      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
                      return m ? `${m[3]}/${m[2]}/${m[1]}` : s.slice(0, 10);
                    })()}</strong></>
                  )}
                </span>
              </div>
            )}
          </div>

          {/* 3. Contact info / address — view + inline edit. The pencil
              icon in the corner toggles edit mode for the whole panel
              and the name above. Saved fields are mirrored into the
              parent's cached list via onChecklistChanged. */}
          <div className="bg-stone-50 border border-stone-200 p-4 space-y-3 text-sm rounded-xl relative" data-testid="drawer-contact-info">
            {!editingDetails && (
              <button
                type="button"
                onClick={beginEditDetails}
                data-testid="drawer-edit-details"
                title="Edit contact details"
                className="absolute top-2 right-2 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-stone-500 hover:text-stone-900 hover:bg-stone-200 rounded-md inline-flex items-center gap-1">
                <Pencil className="w-3 h-3" /> Edit
              </button>
            )}
            {editingDetails ? (
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] uppercase tracking-[0.15em] font-bold text-stone-500 mb-1">Email</label>
                    <input type="email" value={detailsDraft.email || ""} onChange={setDraft("email")} data-testid="drawer-edit-email"
                      className="w-full px-3 py-1.5 bg-white border border-stone-300 rounded-md text-sm focus:outline-none focus:border-stone-900" />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-[0.15em] font-bold text-stone-500 mb-1">Telephone</label>
                    <input value={detailsDraft.telephone || ""} onChange={setDraft("telephone")} data-testid="drawer-edit-telephone"
                      className="w-full px-3 py-1.5 bg-white border border-stone-300 rounded-md text-sm focus:outline-none focus:border-stone-900" />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-[10px] uppercase tracking-[0.15em] font-bold text-stone-500 mb-1">1st line of address</label>
                    <input value={detailsDraft.address_line_1 || ""} onChange={setDraft("address_line_1")} data-testid="drawer-edit-address-1"
                      className="w-full px-3 py-1.5 bg-white border border-stone-300 rounded-md text-sm focus:outline-none focus:border-stone-900" />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-[10px] uppercase tracking-[0.15em] font-bold text-stone-500 mb-1">2nd line of address</label>
                    <input value={detailsDraft.address_line_2 || ""} onChange={setDraft("address_line_2")} data-testid="drawer-edit-address-2"
                      className="w-full px-3 py-1.5 bg-white border border-stone-300 rounded-md text-sm focus:outline-none focus:border-stone-900" />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-[0.15em] font-bold text-stone-500 mb-1">Town / City</label>
                    <input value={detailsDraft.city || ""} onChange={setDraft("city")} data-testid="drawer-edit-city"
                      className="w-full px-3 py-1.5 bg-white border border-stone-300 rounded-md text-sm focus:outline-none focus:border-stone-900" />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-[0.15em] font-bold text-stone-500 mb-1">County / State</label>
                    <input value={detailsDraft.county || ""} onChange={setDraft("county")} data-testid="drawer-edit-county"
                      className="w-full px-3 py-1.5 bg-white border border-stone-300 rounded-md text-sm focus:outline-none focus:border-stone-900" />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-[0.15em] font-bold text-stone-500 mb-1">Postcode</label>
                    <input value={detailsDraft.postcode || ""} onChange={setDraft("postcode")} data-testid="drawer-edit-postcode"
                      className="w-full px-3 py-1.5 bg-white border border-stone-300 rounded-md text-sm focus:outline-none focus:border-stone-900" />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-[0.15em] font-bold text-stone-500 mb-1">Country</label>
                    <input value={detailsDraft.country || ""} onChange={setDraft("country")} data-testid="drawer-edit-country"
                      className="w-full px-3 py-1.5 bg-white border border-stone-300 rounded-md text-sm focus:outline-none focus:border-stone-900" />
                  </div>
                </div>
                {detailsErr && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">{detailsErr}</div>}
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button type="button" onClick={() => setEditingDetails(false)} disabled={detailsSaving} data-testid="drawer-edit-cancel"
                    className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 bg-white hover:bg-stone-50 rounded-md disabled:opacity-50">
                    Cancel
                  </button>
                  <button type="button" onClick={saveDetails} disabled={detailsSaving} data-testid="drawer-edit-save"
                    className="px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-md disabled:opacity-50 inline-flex items-center gap-1">
                    {detailsSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <>
                {(contact.email || contact.email_raw) && (
                  <div className="flex items-start gap-2"><Mail className="w-3.5 h-3.5 text-stone-400 mt-1" />
                    <a href={`mailto:${contact.email || contact.email_raw}`} className="text-stone-900 hover:underline">{contact.email || contact.email_raw}</a></div>
                )}
                {(contact.telephone || contact.mobile_phone) && (
                  <div className="flex items-start gap-2"><Phone className="w-3.5 h-3.5 text-stone-400 mt-1" />
                    <span className="text-stone-900">{contact.telephone || contact.mobile_phone}</span></div>
                )}
                {(() => {
                  // Address rendered as a multi-line block — pulls from the
                  // various legacy field aliases so Airtable / Gravity Forms
                  // / manual entries all render consistently.
                  const line1 = contact.address_line_1 || contact.address_street;
                  const line2 = contact.address_line_2;
                  const town  = contact.city || contact.town_city;
                  const lines = [line1, line2, town, contact.county, contact.postcode, contact.country].filter(Boolean);
                  if (lines.length === 0) return null;
                  return (
                    <div className="flex items-start gap-2" data-testid="drawer-address">
                      <MapPin className="w-3.5 h-3.5 text-stone-400 mt-1 shrink-0" />
                      <div className="text-stone-900 leading-snug">
                        {lines.map((ln, i) => (
                      <div key={`addr-${i}-${ln}`}>{ln}</div>
                    ))}
                  </div>
                </div>
              );
            })()}
                {dateAdded && (
                  <div className="flex items-start gap-2"><Calendar className="w-3.5 h-3.5 text-stone-400 mt-1" />
                    <span className="text-stone-900">{formatDate(dateAdded)} <span className="text-stone-500">· {sinceCreated} days ago</span></span></div>
                )}
              </>
            )}
          </div>

          {/* 4–6. Interested-only block: Checklist → Plan Territory → Convert.
              These three panels are intentionally hidden in New / Contacted /
              Dormant / Lost because they make no sense until someone is
              actively being qualified. */}
          {isInPipeline && contact.pipeline_status === "qualified" && !alreadyConverted && (
            <InterestedChecklist contact={contact} onChanged={onChecklistChanged} />
          )}

          {isInPipeline && contact.pipeline_status === "qualified" && !alreadyConverted && !isLicenceEnq && (
            <a href={`/territory-builder?contact_id=${contact.id}`}
              data-testid="drawer-plan-territory"
              className="block p-4 border border-stone-300 rounded-xl hover:border-stone-500 hover:shadow-md transition-all bg-gradient-to-br from-[#EEEE86]/30 to-white">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-stone-950 flex items-center gap-1.5">
                    <Target className="w-4 h-4 text-stone-700" /> Plan their territory
                  </div>
                  <div className="text-xs text-stone-600 mt-1">
                    Build a sample 150-home territory around their postcode using live CQC data. Saved against this contact and easy to edit.
                    <span className="block mt-1 text-stone-500">Already drafted one for them elsewhere? Open the builder and click <strong>Link contact</strong> on the matching saved plan.</span>
                  </div>
                </div>
                <span className="shrink-0 px-3 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white rounded-lg flex items-center gap-1.5">
                  Open builder
                </span>
              </div>
            </a>
          )}

          {isInPipeline && contact.pipeline_status === "qualified" && (
            <div className={`p-4 border rounded-xl ${alreadyConverted ? "bg-emerald-50 border-emerald-200" : "bg-gradient-to-br from-[#dddd16]/10 to-stone-50 border-stone-300"}`} data-testid="drawer-convert-section">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-stone-950 flex items-center gap-1.5">
                    <Award className={`w-4 h-4 ${alreadyConverted ? "text-emerald-700" : "text-stone-700"}`} />
                    {alreadyConverted ? "Already converted" : convertLabel}
                  </div>
                  <div className="text-xs text-stone-600 mt-1">
                    {alreadyConverted
                      ? <>This contact has been converted to a {contact.converted_to_record_type === "licencee" ? "Licencee" : "Franchisee"} record.</>
                      : <>Create a {isLicenceEnq ? "Licencee" : "Franchisee"} record from this enquiry. Their details &amp; original message will copy over.</>}
                  </div>
                </div>
                {alreadyConverted ? (
                  <button
                    onClick={() => onConvert(contact, true)}
                    data-testid="drawer-view-franchisee"
                    className="shrink-0 px-3 py-2 text-xs font-bold uppercase tracking-wider bg-white text-emerald-800 border border-emerald-300 hover:bg-emerald-100 rounded-lg flex items-center gap-1.5">
                    <ArrowRightLeft className="w-3.5 h-3.5" /> View record
                  </button>
                ) : (
                  <button
                    onClick={async () => {
                      if (!window.confirm(`${convertLabel} for ${[contact.first_name, contact.last_name].filter(Boolean).join(" ") || "this contact"}?`)) return;
                      setConverting(true);
                      try { await onConvert(contact, false); }
                      finally { setConverting(false); }
                    }}
                    disabled={converting}
                    data-testid="drawer-convert"
                    className="shrink-0 px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg flex items-center gap-1.5 disabled:opacity-50">
                    <Award className="w-3.5 h-3.5" /> {converting ? "Converting…" : convertLabel}
                  </button>
                )}
              </div>
              {!alreadyConverted && onLinkExisting && (
                <div className="mt-3 pt-3 border-t border-stone-200/70 flex items-center justify-between gap-3">
                  <div className="text-xs text-stone-600">
                    Already in the franchisees list? Skip creating a new record and link to the existing one.
                  </div>
                  <button
                    onClick={() => onLinkExisting(contact)}
                    data-testid="drawer-link-existing"
                    className="shrink-0 px-3 py-2 text-xs font-bold uppercase tracking-wider bg-white text-stone-800 border border-stone-300 hover:bg-stone-50 rounded-lg flex items-center gap-1.5">
                    <Link2 className="w-3.5 h-3.5" /> Link to existing
                  </button>
                </div>
              )}
            </div>
          )}

          {/* 7. Move to stage (pipeline) OR Promote (non-pipeline) */}
          {isInPipeline ? (
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">Move to stage</div>
              <div className="grid grid-cols-3 gap-2" data-testid="drawer-stages">
                {stagesForContact(contact).map((s) => (
                  <button key={s.key} onClick={() => onStageChange(contact.id, s.key)} data-testid={`drawer-stage-${s.key}`}
                    className={`px-3 py-2 text-xs font-bold uppercase tracking-wider border rounded-lg transition-colors ${
                      contact.pipeline_status === s.key ? `${s.color} border-current` : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"
                    }`}>{s.label}</button>
                ))}
              </div>
              <button onClick={() => onDemote(contact.id)} data-testid="drawer-demote"
                className="mt-3 px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 rounded-lg flex items-center gap-1.5">
                <ArrowDownCircle className="w-3.5 h-3.5" /> Remove from sales pipeline
              </button>
              <div className="text-xs text-stone-500 mt-1.5">
                Will return to <strong>{homeTabLabel}</strong> based on their source.
              </div>
            </div>
          ) : (
            <div className="p-4 bg-stone-50 border border-stone-200 rounded-xl">
              <div className="text-sm font-semibold text-stone-900 mb-1">Not in the sales pipeline</div>
              <div className="text-xs text-stone-600 mb-3">
                Currently in <strong>{homeTabLabel}</strong>.
                Promote them to actively work them as a potential franchisee.
              </div>
              <button onClick={() => onPromote(contact.id)} data-testid="drawer-promote"
                className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] text-stone-950 hover:bg-[#aaaa11] rounded-lg flex items-center gap-1.5">
                <ArrowUpCircle className="w-3.5 h-3.5" /> Promote to sales pipeline
              </button>
            </div>
          )}

          {/* 8. Sales Notes — only in pipeline */}
          {isInPipeline && (
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">Sales Notes</div>
              <div className="bg-white border border-stone-200 divide-y divide-stone-100 text-sm rounded-xl overflow-hidden">
                {[
                  ["Response Sent", contact.response_sent], ["Email Opened", contact.email_opened],
                  ["Potential", contact.potential], ["Price Tier", contact.price_tier],
                  ["Had a Map", contact.had_a_map], ["Shadow Booked", contact.shadow_booked],
                  ["Follow Up Needed", contact.follow_up_needed], ["Country", contact.country_tag],
                ].filter(([, v]) => v != null && v !== "").map(([k, v]) => (
                  <div key={k} className="px-3 py-2 flex justify-between gap-3">
                    <span className="text-xs uppercase tracking-wider text-stone-500 font-bold">{k}</span>
                    <span className="text-stone-900 text-right">{Array.isArray(v) ? v.join(", ") : String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 9. Notes (Original Enquiry) */}
          {(contact.why_contacting || contact.message) && (
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">Notes</div>
              <div className="bg-stone-50 border border-stone-200 p-4 text-sm text-stone-800 leading-relaxed whitespace-pre-wrap rounded-xl">
                {contact.why_contacting && <div className="font-semibold mb-1">{contact.why_contacting}</div>}
                {contact.message}
              </div>
            </div>
          )}

          {/* Running admin notes */}
          <AdminNotesEditor contact={contact} onUpdated={onAdminNotesUpdated} />

          {/* Recent email sends — only visible if there's history */}
          <EmailTimeline contactId={contact.id} refreshSignal={emailRefreshSignal} />

          {/* 10. Internal Notes */}
          {contact.notes && (
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">Internal Notes</div>
              <div className="bg-amber-50 border border-amber-200 p-4 text-sm text-stone-800 leading-relaxed whitespace-pre-wrap rounded-xl">{contact.notes}</div>
            </div>
          )}
        </div>
      </aside>
      <ReplyWithTemplateModal
        open={replyModalOpen}
        contact={contact}
        onClose={() => setReplyModalOpen(false)}
        onSent={() => setEmailRefreshSignal((n) => n + 1)}
      />
    </div>
  );
}


function InterestedChecklist({ contact, onChanged }) {
  // The Interested stage tracks four concrete actions:
  //  • Territory confirmed?  • Contract Sent?
  //  • Shadow Day Booked?   (with date + "Shadowing:" free text)
  //  • Training Day(s) booked? (with one-or-more dates — training runs 2–3 days)
  // Top two ticks sit side-by-side. Bottom two reveal their date/text inputs
  // only when checked, and are separated by a divider so they read as
  // distinct steps. Saves on blur (date/text) or instantly on tick.
  const [territoryDefined, setTerritoryDefined] = useState(!!contact.territory_defined);
  const [contractSent, setContractSent] = useState(!!contact.contract_sent);
  const [shadowDayBooked, setShadowDayBooked] = useState(!!contact.shadow_day_booked);
  const [shadowDate, setShadowDate] = useState(contact.shadow_day_date || "");
  const [shadowingWith, setShadowingWith] = useState(contact.shadowing_with || "");
  const [trainingBooked, setTrainingBooked] = useState(!!contact.training_days_booked);
  const [trainingDates, setTrainingDates] = useState(Array.isArray(contact.training_day_dates) ? [...contact.training_day_dates] : []);
  const [newTrainingDate, setNewTrainingDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // When the drawer switches to a different contact, sync local state.
  useEffect(() => {
    setTerritoryDefined(!!contact.territory_defined);
    setContractSent(!!contact.contract_sent);
    setShadowDayBooked(!!contact.shadow_day_booked);
    setShadowDate(contact.shadow_day_date || "");
    setShadowingWith(contact.shadowing_with || "");
    setTrainingBooked(!!contact.training_days_booked);
    setTrainingDates(Array.isArray(contact.training_day_dates) ? [...contact.training_day_dates] : []);
    setNewTrainingDate("");
  }, [contact.id, contact.territory_defined, contact.contract_sent, contact.shadow_day_booked, contact.shadow_day_date, contact.shadowing_with, contact.training_days_booked, contact.training_day_dates]);

  // Single saver — accepts overrides so callers don't have to wait for
  // setState before firing the PATCH.
  const persist = async (overrides = {}) => {
    setSaving(true); setError("");
    const payload = {
      territory_defined: territoryDefined,
      contract_sent: contractSent,
      shadow_day_booked: shadowDayBooked,
      shadow_day_date: shadowDate,
      shadowing_with: shadowingWith,
      training_days_booked: trainingBooked,
      training_day_dates: trainingDates,
      ...overrides,
    };
    try {
      const { data } = await api.patch(`/contacts/${contact.id}/checklist`, payload);
      onChanged?.({ id: contact.id, ...data });
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not save.");
      throw e;
    } finally { setSaving(false); }
  };

  const toggle = async (field, next, setter) => {
    const prev = next ? false : true;
    setter(next);
    try { await persist({ [field]: next }); }
    catch { setter(prev); }
  };

  const addTrainingDate = async () => {
    const d = (newTrainingDate || "").trim();
    if (!d) return;
    if (trainingDates.includes(d)) { setNewTrainingDate(""); return; }
    const next = [...trainingDates, d].sort();
    setTrainingDates(next);
    setNewTrainingDate("");
    try { await persist({ training_day_dates: next }); }
    catch { setTrainingDates(trainingDates); }
  };

  const removeTrainingDate = async (d) => {
    const next = trainingDates.filter((x) => x !== d);
    setTrainingDates(next);
    try { await persist({ training_day_dates: next }); }
    catch { setTrainingDates(trainingDates); }
  };

  const fmtTrain = (s) => {
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
  };

  const Tick = ({ k, label, checked, onCheck }) => (
    <label className="flex items-center gap-2 cursor-pointer hover:bg-blue-50/50 px-2 py-1.5 rounded-md transition-colors" data-testid={`interested-checklist-${k}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onCheck(e.target.checked)}
        disabled={saving}
        className="w-4 h-4 rounded border-stone-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
      />
      <span className={`text-sm ${checked ? "text-stone-500 line-through" : "text-stone-900 font-medium"}`}>{label}</span>
    </label>
  );

  return (
    <div className="border-2 border-blue-200 bg-blue-50/40 rounded-xl p-3" data-testid="interested-checklist">
      <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-blue-700 mb-2 flex items-center justify-between px-1">
        <span>Checklist</span>
        {saving && <span className="text-[10px] font-normal normal-case text-stone-500">Saving…</span>}
      </div>

      {/* Top row — Territory confirmed + Contract Sent side by side */}
      <div className="grid grid-cols-2 gap-1">
        <Tick k="territory" label="Territory confirmed?" checked={territoryDefined} onCheck={(v) => toggle("territory_defined", v, setTerritoryDefined)} />
        <Tick k="contract" label="Contract Sent?" checked={contractSent} onCheck={(v) => toggle("contract_sent", v, setContractSent)} />
      </div>

      {/* Divider between the top two ticks and the Shadow Day group so the
          three sub-sections (Top row / Shadow Day / Training Day(s)) all
          read as distinct steps. */}
      <div className="my-2 border-t border-blue-200/70" />

      {/* Shadow Day Booked — date + "Shadowing:" only when ticked */}
      <Tick k="shadow" label="Shadow Day Booked?" checked={shadowDayBooked} onCheck={(v) => toggle("shadow_day_booked", v, setShadowDayBooked)} />
      {shadowDayBooked && (
        <div className="px-2 pt-1 pb-2 grid grid-cols-1 sm:grid-cols-[auto,1fr] gap-2 items-center">
          <input
            type="date"
            value={shadowDate}
            onChange={(e) => setShadowDate(e.target.value)}
            onBlur={() => { if ((shadowDate || "") !== (contact.shadow_day_date || "")) persist().catch(() => {}); }}
            disabled={saving}
            data-testid="interested-shadow-date"
            className="px-3 py-1.5 bg-white border border-blue-200 rounded-lg text-sm focus:outline-none focus:border-blue-500"
          />
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-blue-800 shrink-0">Shadowing:</span>
            <input
              type="text"
              value={shadowingWith}
              onChange={(e) => setShadowingWith(e.target.value)}
              onBlur={() => { if ((shadowingWith || "") !== (contact.shadowing_with || "")) persist().catch(() => {}); }}
              disabled={saving}
              placeholder="e.g. with Jane Smith @ Manchester class"
              data-testid="interested-shadowing-with"
              className="flex-1 px-3 py-1.5 bg-white border border-blue-200 rounded-lg text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>
      )}

      {/* Divider between Shadow Day and Training Day(s) so they read as
          two clearly separate steps. */}
      <div className="my-2 border-t border-blue-200/70" />

      {/* Training Day(s) Booked — multi-date selector, only when ticked */}
      <Tick k="training" label="Training Day(s) booked?" checked={trainingBooked} onCheck={(v) => toggle("training_days_booked", v, setTrainingBooked)} />
      {trainingBooked && (
        <div className="px-2 pt-1 pb-2 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={newTrainingDate}
              onChange={(e) => setNewTrainingDate(e.target.value)}
              disabled={saving}
              data-testid="interested-training-date-input"
              className="px-3 py-1.5 bg-white border border-blue-200 rounded-lg text-sm focus:outline-none focus:border-blue-500"
            />
            <button
              type="button"
              onClick={addTrainingDate}
              disabled={saving || !newTrainingDate}
              data-testid="interested-training-date-add"
              className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-40 flex items-center gap-1">
              <Plus className="w-3 h-3" /> Add date
            </button>
          </div>
          {trainingDates.length > 0 && (
            <div className="flex flex-wrap gap-1.5" data-testid="interested-training-date-list">
              {trainingDates.map((d) => (
                <span key={d} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 text-xs font-semibold bg-white border border-blue-300 text-blue-900 rounded-full">
                  {fmtTrain(d)}
                  <button
                    type="button"
                    onClick={() => removeTrainingDate(d)}
                    disabled={saving}
                    data-testid={`interested-training-date-remove-${d}`}
                    className="w-4 h-4 flex items-center justify-center rounded-full hover:bg-blue-100 text-blue-700">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <div className="text-xs text-red-700 mt-2 px-1">{error}</div>}
    </div>
  );
}

function AdminNotesEditor({ contact, onUpdated }) {
  // Local draft separates the input value from the persisted value so the
  // user can type freely without losing focus mid-write. Auto-saves on blur
  // (with a short debounce safety net so accidental clicks don't lose work).
  const [draft, setDraft] = useState(contact.admin_notes || "");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(contact.admin_notes_updated_at || null);
  const [error, setError] = useState("");
  const initialRef = contact.admin_notes || "";

  useEffect(() => {
    // When the drawer switches to a new contact, reset the draft.
    setDraft(contact.admin_notes || "");
    setSavedAt(contact.admin_notes_updated_at || null);
    setError("");
  }, [contact.id, contact.admin_notes, contact.admin_notes_updated_at]);

  const dirty = draft !== initialRef;

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError("");
    try {
      const { data } = await api.patch(`/contacts/${contact.id}/admin-notes`, { admin_notes: draft });
      setSavedAt(data.admin_notes_updated_at);
      onUpdated && onUpdated(contact.id, data.admin_notes, data.admin_notes_updated_at);
    } catch (e) {
      setError(e?.response?.data?.detail || "Could not save notes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="admin-notes-editor">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Notes</div>
        <div className="text-[10px] text-stone-500 flex items-center gap-1.5">
          {saving ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" /> Saving…
            </>
          ) : dirty ? (
            <span className="text-amber-700">Unsaved changes</span>
          ) : savedAt ? (
            <span title={`Last saved ${savedAt}`}>
              Saved {(() => { const d = new Date(savedAt); const diff = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000)); if (diff < 60) return "just now"; if (diff < 3600) return `${Math.floor(diff / 60)}m ago`; if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`; return d.toLocaleDateString("en-GB"); })()}
            </span>
          ) : (
            <span className="text-stone-400">Type to add notes</span>
          )}
        </div>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        placeholder="Running notes — follow-ups, call summaries, anything you want to remember about this contact…"
        rows={4}
        data-testid="admin-notes-textarea"
        className="w-full px-3 py-2 bg-white border border-stone-300 rounded-xl text-sm focus:outline-none focus:border-stone-900 resize-y"
      />
      <div className="flex items-center justify-between mt-1.5">
        <div className="text-[10px] text-stone-500">
          {dirty
            ? "Click outside or press ⌘/Ctrl + Enter to save."
            : draft.length > 0
              ? `${draft.length} characters`
              : ""}
        </div>
        {dirty && (
          <button
            type="button"
            onClick={save}
            disabled={saving}
            data-testid="admin-notes-save"
            className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-900 hover:text-stone-950 underline disabled:opacity-40">
            Save now
          </button>
        )}
      </div>
      {error && (
        <div className="mt-1.5 text-xs text-red-700 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" /> {error}
        </div>
      )}
    </div>
  );
}

export default function ContactsPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState("pipeline");
  const [view, setView] = useState("pipeline");
  const [stageFilter, setStageFilter] = useState("");
  const [search, setSearch] = useState("");
  const [recentSearches, setRecentSearches] = useState(() => loadRecentSearches());
  const [searchFocused, setSearchFocused] = useState(false);
  const [data, setData] = useState({ items: [], total: 0 });
  const [counts, setCounts] = useState({});
  // Display cap for the LIST view — chunked 500 at a time so we don't shove
  // 6k+ DOM rows in at once. "Show 500 more" extends until the dataset is
  // fully visible. Reset whenever the dataset (tab / search / stage) changes.
  const [displayLimit, setDisplayLimit] = useState(500);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [lastSelectedId, setLastSelectedId] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Contact whose Reply-with-template modal is currently open from the kanban
  // quick-Reply button (not the drawer — the drawer has its own state).
  const [kanbanReplyContact, setKanbanReplyContact] = useState(null);
  const [ageFilter, setAgeFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all"); // 'all' | 'franchise' | 'licence'
  const [collapsedStages, setCollapsedStages] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem("pipelineCollapsedStages") || "[]")); }
    catch { return new Set(); }
  });
  const toggleStageCollapsed = (key) => {
    setCollapsedStages((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem("pipelineCollapsedStages", JSON.stringify([...next])); } catch {/* ignore */}
      return next;
    });
  };

  const clearSelection = () => { setSelectedIds(new Set()); setLastSelectedId(null); };
  // Visible items (filtered + age + source) — needed so shift-select knows the range
  const visibleItems = useMemo(() => {
    const af = AGE_TIERS.find((t) => t.key === ageFilter) || AGE_TIERS[0];
    return data.items.filter((c) => {
      if (!af.test(daysSince(c.date || c.date_added))) return false;
      if (sourceFilter === "franchise" && c.source !== "franchise_enquiry") return false;
      if (sourceFilter === "licence"   && c.source !== "licence_enquiry")   return false;
      return true;
    });
  }, [data.items, ageFilter, sourceFilter]);

  const toggleSelect = (id, evt) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      // Shift-click: extend the live selection from the anchor (last clicked checkbox)
      // up to the current one. Only triggers when the anchor is still selected — otherwise
      // fall through to single-toggle. In the kanban view the range must be scoped to
      // a SINGLE stage so a shift-click in NEW doesn't pull cards in from INTERESTED /
      // TERRITORY MAP etc. (visibleItems otherwise interleaves stages).
      if (evt && evt.shiftKey && lastSelectedId && lastSelectedId !== id && next.has(lastSelectedId)) {
        let rangeItems = visibleItems;
        if (view === "pipeline") {
          const anchor = visibleItems.find((c) => c.id === lastSelectedId);
          const target = visibleItems.find((c) => c.id === id);
          const anchorStage = (anchor?.pipeline_status && STAGE_MAP[anchor.pipeline_status]) ? anchor.pipeline_status : "new";
          const targetStage = (target?.pipeline_status && STAGE_MAP[target.pipeline_status]) ? target.pipeline_status : "new";
          if (anchorStage !== targetStage) {
            // Cross-column shift — refuse to extend; fall through to single toggle.
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
          }
          rangeItems = (grouped[anchorStage] || []);
        }
        const ids = rangeItems.map((c) => c.id);
        const a = ids.indexOf(lastSelectedId);
        const b = ids.indexOf(id);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          // Anchor is selected — ADD the range to the selection.
          for (let i = lo; i <= hi; i++) next.add(ids[i]);
          return next;
        }
      }
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setLastSelectedId(id);
  };

  const load = async () => {
    setLoading(true);
    try {
      const params = { tab, search: search || undefined, limit: 10000 };
      if (tab === "pipeline" && stageFilter) params.pipeline_status = stageFilter;
      const { data } = await api.get("/contacts", { params });
      setData(data);
    } catch (e) { setError("Could not load contacts."); }
    finally { setLoading(false); }
  };

  // Tab-header badges: total live records per category. Reloads whenever a
  // contact is added / merged / moved so the numbers stay accurate.
  const loadCounts = async () => {
    try {
      const { data } = await api.get("/contacts/counts");
      setCounts(data || {});
    } catch (e) { /* badges are non-critical, swallow */ }
  };

  useEffect(() => {
    const t = setTimeout(() => {
      load();
      // Push the applied search into the Recent Searches cache. Only
      // strings ≥ 2 chars get recorded — single-letter typing is noise.
      const q = (search || "").trim();
      if (q.length >= 2) {
        saveRecentSearch(q);
        setRecentSearches(loadRecentSearches());
      }
    }, search ? 350 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, stageFilter, search]);

  // Counts are cheap — refresh whenever any mutation changes the dataset.
  useEffect(() => {
    loadCounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, data.items.length]);

  // Reset selection whenever the tab/filter changes
  useEffect(() => { clearSelection(); setAgeFilter("all"); setSourceFilter("all"); setDisplayLimit(500); }, [tab, stageFilter, search]);

  const moveContact = async (contactId, target, pipeline_status) => {
    try {
      await api.post(`/contacts/${contactId}/move`, { target, pipeline_status });
      const stayingOnPipeline = target === "pipeline" && tab === "pipeline";
      if (stayingOnPipeline) {
        // Just changing stage — keep the row visible, update in place
        setData((d) => ({ ...d, items: d.items.map((c) => c.id === contactId
          ? { ...c, in_pipeline: true, pipeline_status: pipeline_status || "new" }
          : c) }));
        setSelected((sel) => sel && sel.id === contactId ? { ...sel, in_pipeline: true, pipeline_status: pipeline_status || "new" } : sel);
      } else {
        setSelected(null);
        setData((d) => ({ ...d, items: d.items.filter((c) => c.id !== contactId) }));
      }
      setSelectedIds((prev) => { const n = new Set(prev); n.delete(contactId); return n; });
    } catch (e) { setError("Could not move contact."); }
  };

  const bulkMove = async (target, pipeline_status) => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    const stayingOnPipeline = target === "pipeline" && tab === "pipeline";
    const targetLabel = target === "pipeline" ? "Sales Pipeline"
                      : target === "franchise" ? "Franchise Contacts"
                      : target === "licence"   ? "Licence Contacts"
                      : "General Contacts";
    const stageLabel = pipeline_status ? (STAGE_MAP[pipeline_status]?.label || pipeline_status) : null;
    const verb = stayingOnPipeline ? "Change stage to" : "Move";
    const dest = stayingOnPipeline ? stageLabel : (stageLabel ? `${targetLabel} (${stageLabel})` : targetLabel);
    if (!window.confirm(`${verb} ${ids.length} contact${ids.length === 1 ? "" : "s"} → ${dest}?`)) return;
    try {
      await api.post(`/contacts/bulk-move`, { ids, target, pipeline_status });
      if (stayingOnPipeline) {
        // Records stay on this tab — just update their stage in-place
        setData((d) => ({ ...d, items: d.items.map((c) => selectedIds.has(c.id)
          ? { ...c, in_pipeline: true, pipeline_status: pipeline_status || "new" }
          : c) }));
      } else {
        // Records leave the current tab — remove them from the visible list
        setData((d) => ({ ...d, items: d.items.filter((c) => !selectedIds.has(c.id)) }));
      }
      clearSelection();
    } catch (e) { setError("Could not move contacts."); }
  };

  const updateStage = async (contactId, newStage) => {
    try {
      await api.patch(`/contacts/${contactId}/pipeline`, { pipeline_status: newStage });
      setData((d) => ({ ...d, items: d.items.map((c) => (c.id === contactId ? { ...c, pipeline_status: newStage } : c)) }));
      setSelected((sel) => sel && sel.id === contactId ? { ...sel, pipeline_status: newStage } : sel);
    } catch (e) { /* noop */ }
  };

  // Optimistically set the pipeline lead-temperature on a contact and
  // PATCH the server. Used from the kanban card; the drawer shows the
  // result read-only.
  const setTemperature = async (contactId, nextTemperature) => {
    const prev = data.items.find((c) => c.id === contactId)?.temperature ?? null;
    setData((d) => ({ ...d, items: d.items.map((c) => c.id === contactId ? { ...c, temperature: nextTemperature } : c) }));
    setSelected((sel) => sel && sel.id === contactId ? { ...sel, temperature: nextTemperature } : sel);
    try {
      await api.patch(`/contacts/${contactId}/temperature`, { temperature: nextTemperature });
    } catch (e) {
      // Rollback
      setData((d) => ({ ...d, items: d.items.map((c) => c.id === contactId ? { ...c, temperature: prev } : c) }));
      setSelected((sel) => sel && sel.id === contactId ? { ...sel, temperature: prev } : sel);
      setError("Could not update lead temperature.");
    }
  };

  const replyByEmail = (contact) => {
    const to = contact.email || contact.email_raw;
    if (!to) {
      setError("This contact has no email address on file.");
      return;
    }
    // Open a plain mailto: link — pops the user's default mail client
    // (Apple Mail / Outlook) with To pre-filled. Subject prefixed with
    // "Re:" if we have one. No HTML body / signature — the local mail
    // client uses its own signature.
    const subject = contact.subject ? `Re: ${contact.subject}` : "";
    const params = subject ? `?subject=${encodeURIComponent(subject)}` : "";
    window.location.href = `mailto:${encodeURIComponent(to)}${params}`;
    // Auto-advance to "Contacted" if currently "new" — same UX as before.
    if (!contact.pipeline_status || contact.pipeline_status === "new") {
      updateStage(contact.id, "contacted");
    }
  };

  const promote = async (contactId) => {
    try { await api.patch(`/contacts/${contactId}/promote`); setSelected(null); load(); }
    catch (e) { setError("Could not promote contact."); }
  };

  const demote = async (contactId, target) => {
    if (!window.confirm(`Remove from sales pipeline and return to ${target === "franchise" ? "Franchise Contacts" : "General Contacts"}?`)) return;
    try { await api.patch(`/contacts/${contactId}/demote`); setSelected(null); load(); }
    catch (e) { setError("Could not demote contact."); }
  };

  const remove = async (contactId) => {
    try {
      await api.delete(`/contacts/${contactId}`);
      setSelected(null);
      setData((d) => ({ ...d, items: d.items.filter((c) => c.id !== contactId) }));
    } catch (e) { setError("Could not delete contact."); }
  };

  // Phase 1.7 — One-click Convert to Franchisee/Licencee
  const convertContact = async (contact, viewOnly) => {
    // If already converted, just navigate
    if (viewOnly || contact.converted_to_franchisee_id) {
      const fid = contact.converted_to_franchisee_id;
      if (fid) navigate(`/franchisees/${fid}`);
      return;
    }
    try {
      const { data: res } = await api.post(`/contacts/${contact.id}/convert-to-franchisee`);
      const fid = res?.franchisee?.id;
      // Update the contact in-place to reflect "converted" status — removes from pipeline
      setData((d) => ({
        ...d,
        items: d.items.map((c) => c.id === contact.id
          ? { ...c, in_pipeline: false, pipeline_status: null,
              converted_to_franchisee_id: fid, converted_to_record_type: res.record_type }
          : c),
      }));
      setSelected(null);
      if (fid) navigate(`/franchisees/${fid}`);
    } catch (e) {
      const msg = e?.response?.data?.detail || "Could not convert contact.";
      setError(typeof msg === "string" ? msg : "Could not convert contact.");
    }
  };

  // Link contact to an EXISTING franchisee (no new record created).
  // The actual API call happens inside the modal; we just handle the
  // post-link side-effects here (in-place row update + navigation).
  const [linkingContact, setLinkingContact] = useState(null);
  const openLinkExisting = (contact) => setLinkingContact(contact);

  // Merge state — `mergePair` holds the two contacts to merge. Triggered
  // either from the bulk-bar (exactly 2 selected), the drawer, or the
  // Duplicate Finder modal.
  const [mergePair, setMergePair] = useState(null);
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  const [duplicatesReloadAt, setDuplicatesReloadAt] = useState(0);
  const openMergeFromBulkBar = () => {
    if (selectedIds.size !== 2) return;
    const ids = [...selectedIds];
    const a = data.items.find((c) => c.id === ids[0]);
    const b = data.items.find((c) => c.id === ids[1]);
    if (a && b) setMergePair({ a, b });
  };
  const handleMerged = (result) => {
    // Remove the loser from the local list and replace the survivor with
    // the freshly-returned doc so the kanban + drawer reflect the merge
    // without needing a full reload.
    setData((d) => ({
      ...d,
      items: d.items
        .filter((c) => c.id !== result.loser_id)
        .map((c) => c.id === result.survivor_id ? { ...c, ...result.survivor } : c),
    }));
    setSelectedIds(new Set());
    setMergePair(null);
    setSelected(result.survivor || null);
    // If the merge was launched from the Duplicate Finder, refresh the
    // group list so the loser drops off and groups of 2 disappear.
    if (duplicatesOpen) setDuplicatesReloadAt(Date.now());
  };
  const handleLinked = (franchiseeId) => {
    if (!linkingContact) return;
    setData((d) => ({
      ...d,
      items: d.items.map((c) => c.id === linkingContact.id
        ? { ...c, in_pipeline: false, pipeline_status: null,
            converted_to_franchisee_id: franchiseeId,
            linked_to_existing: true }
        : c),
    }));
    setLinkingContact(null);
    setSelected(null);
    navigate(`/franchisees/${franchiseeId}`);
  };

  const grouped = useMemo(() => {
    const g = STAGES.reduce((acc, s) => ({ ...acc, [s.key]: [] }), {});
    visibleItems.forEach((c) => {
      const stage = c.pipeline_status && g[c.pipeline_status] ? c.pipeline_status : "new";
      g[stage].push(c);
    });
    return g;
  }, [visibleItems]);

  const stats = useMemo(() => {
    const s = { total: visibleItems.length };
    STAGES.forEach((stg) => { s[stg.key] = (grouped[stg.key] || []).length; });
    return s;
  }, [visibleItems, grouped]);

  const currentTab = TABS.find((t) => t.key === tab);
  const isPipeline = tab === "pipeline";

  return (
    <div className="min-h-screen">
      <div className="h-16 border-b border-stone-200 bg-white flex items-center px-8 sticky top-0 z-10" data-testid="topbar">
        <div className="flex items-baseline gap-3 flex-1">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">CRM</div>
          <h1 className="font-display text-xl text-stone-950">{currentTab?.label}</h1>
          <span className="text-xs text-stone-500">{data.total.toLocaleString()} records</span>
        </div>
        <div className="flex items-center gap-3">
          {isPipeline && (
            <div className="flex border border-stone-300 rounded-lg overflow-hidden">
              <button onClick={() => setView("list")} data-testid="view-list" className={`px-3 py-2 text-xs font-bold uppercase tracking-wider transition-colors flex items-center gap-1.5 ${view === "list" ? "bg-stone-950 text-white" : "bg-white text-stone-700 hover:bg-stone-50"}`}>
                <LayoutList className="w-3 h-3" /> List
              </button>
              <button onClick={() => setView("pipeline")} data-testid="view-pipeline" className={`px-3 py-2 text-xs font-bold uppercase tracking-wider transition-colors flex items-center gap-1.5 ${view === "pipeline" ? "bg-stone-950 text-white" : "bg-white text-stone-700 hover:bg-stone-50"}`}>
                <Kanban className="w-3 h-3" /> Pipeline
              </button>
            </div>
          )}
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="contact-search"
              placeholder="Search…"
              autoComplete="off"
              onFocus={() => setSearchFocused(true)}
              onBlur={() => { setTimeout(() => setSearchFocused(false), 150); }}
              className={`pl-9 ${search ? "pr-9" : "pr-3"} py-2 w-56 bg-stone-50 border border-stone-300 text-sm focus:outline-none focus:border-stone-900 rounded-lg`} />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                data-testid="contact-search-clear"
                aria-label="Clear search"
                title="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-stone-400 hover:text-stone-900 hover:bg-stone-200 rounded-md transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
            {/* Recent Searches dropdown — shows when the input is focused
                and there's at least one historical query AND the user
                hasn't started typing a new one (so it never gets in the
                way of an active search). Last 10 queries, most-recent
                first; click to re-run, or "Clear" to wipe the list. */}
            {searchFocused && !search && recentSearches.length > 0 && (
              <div
                onMouseDown={(e) => e.preventDefault()}
                className="absolute right-0 top-full mt-1 z-30 w-72 bg-white border border-stone-200 rounded-xl shadow-lg overflow-hidden"
                data-testid="recent-searches-dropdown">
                <div className="px-3 py-2 flex items-center justify-between bg-stone-50 border-b border-stone-200">
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-1.5">
                    <Clock className="w-3 h-3" /> Recent searches
                  </div>
                  <button
                    type="button"
                    onClick={() => { clearRecentSearches(); setRecentSearches([]); }}
                    data-testid="recent-searches-clear"
                    className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 hover:text-stone-900">
                    Clear
                  </button>
                </div>
                <ul className="max-h-72 overflow-y-auto">
                  {recentSearches.map((q) => (
                    <li key={q}>
                      <button
                        type="button"
                        onClick={() => { setSearch(q); setSearchFocused(false); }}
                        data-testid={`recent-search-${q.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")}`}
                        className="w-full text-left px-3 py-2 text-sm text-stone-800 hover:bg-stone-50 flex items-center gap-2">
                        <Search className="w-3 h-3 text-stone-400" />
                        <span className="truncate">{q}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <button onClick={() => setDuplicatesOpen(true)} data-testid="find-duplicates-button"
            className="px-3 py-2 border border-stone-300 bg-white text-stone-900 text-xs font-bold uppercase tracking-wider hover:bg-stone-50 transition-colors rounded-lg flex items-center gap-1.5">
            <GitMerge className="w-3.5 h-3.5" /> Find Duplicates
          </button>
          <button onClick={() => setImportOpen(true)} data-testid="import-csv-button"
            className="px-3 py-2 border border-stone-300 bg-white text-stone-900 text-xs font-bold uppercase tracking-wider hover:bg-stone-50 transition-colors rounded-lg flex items-center gap-1.5">
            <Upload className="w-3.5 h-3.5" /> Import CSV
          </button>
          <button onClick={() => setAddOpen(true)} data-testid="add-contact-button"
            className="px-4 py-2 bg-stone-950 text-white text-xs font-bold uppercase tracking-wider hover:bg-stone-800 transition-colors rounded-lg flex items-center gap-1.5">
            <Plus className="w-3.5 h-3.5" /> Add Contact
          </button>
        </div>
      </div>

      <div className="px-8 pt-6">
        <div className="flex flex-wrap gap-1 -mb-px" data-testid="mode-tabs">
          {TABS.map((t) => {
            const active = tab === t.key;
            const Icon = t.icon;
            const count = counts[t.key];
            return (
              <button key={t.key} onClick={() => { setTab(t.key); setStageFilter(""); }} data-testid={`mode-${t.key}`}
                className={`px-5 py-3 text-sm font-bold transition-colors rounded-t-xl flex items-start gap-2 ${
                  active ? "bg-white text-stone-950 border border-stone-200 border-b-white" : "text-stone-500 hover:text-stone-900 hover:bg-stone-100/50"
                }`}>
                <Icon className="w-4 h-4 mt-0.5" />
                <span className="text-left">
                  <span className="inline-flex items-center gap-1.5">
                    {t.label}
                    {typeof count === "number" && (
                      <span
                        data-testid={`tab-count-${t.key}`}
                        className={`tabular-nums text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${
                          active
                            ? "bg-stone-950 text-white border-stone-950"
                            : "bg-stone-100 text-stone-700 border-stone-200"
                        }`}
                      >
                        {count.toLocaleString()}
                      </span>
                    )}
                  </span>
                  <div className={`text-[10px] font-normal mt-0.5 ${active ? "text-stone-600" : "text-stone-400"}`}>{t.hint}</div>
                </span>
              </button>
            );
          })}
        </div>
        <div className="border-b border-stone-200" />
      </div>

      {search && search.trim() && (
        <div className="px-8 pt-3" data-testid="cross-tab-search-banner">
          <div className="bg-stone-50 border border-stone-200 rounded-xl px-4 py-2 flex items-center gap-3 text-xs text-stone-700">
            <Search className="w-3.5 h-3.5 text-stone-500 shrink-0" />
            <span>
              Searching across <strong>all tabs</strong> for &ldquo;{search.trim()}&rdquo; — results show their source pill so you can tell which tab each contact lives in.
            </span>
            <button
              type="button"
              onClick={() => setSearch("")}
              data-testid="cross-tab-search-clear"
              className="ml-auto px-2 py-1 text-[10px] font-bold uppercase tracking-wider bg-white border border-stone-300 hover:bg-stone-100 rounded-md transition-colors"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Bulk action bar — appears when one or more contacts selected */}
      {selectedIds.size > 0 && (
        <div className="px-8 pt-4">
          <div className="bg-stone-950 text-white rounded-2xl px-5 py-3 flex items-center gap-4 shadow-lg" data-testid="bulk-action-bar">
            <div className="flex items-center gap-2">
              <CheckSquare className="w-4 h-4 text-[#dddd16]" />
              <span className="text-sm font-bold tabular-nums">{selectedIds.size} selected</span>
            </div>
            <div className="flex-1" />
            <MoveMenu onMove={bulkMove} label="Move selected" testid="bulk-move" currentTab={tab} count={selectedIds.size} />
            {selectedIds.size === 2 && (
              <button onClick={openMergeFromBulkBar} data-testid="bulk-merge"
                className="touch-target px-3 text-xs font-bold uppercase tracking-wider bg-[#dddd16] text-stone-950 hover:bg-[#aaaa11] rounded-lg flex items-center gap-1.5">
                <GitMerge className="w-3.5 h-3.5" /> Merge these 2
              </button>
            )}
            <button onClick={clearSelection} data-testid="bulk-clear"
              className="px-3 py-1 text-xs font-bold uppercase tracking-wider bg-white/10 hover:bg-white/20 text-white rounded-lg flex items-center gap-1">
              <X className="w-3 h-3" /> Clear
            </button>
          </div>
        </div>
      )}

      {isPipeline && !loading && data.items.length > 0 && (
        <div className="px-8 pt-6 space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap" data-testid="age-filter">
              <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mr-1">Age</span>
              {AGE_TIERS.map((t) => {
                const active = ageFilter === t.key;
                const count = t.key === "all"
                  ? data.items.length
                  : data.items.filter((c) => t.test(daysSince(c.date || c.date_added))).length;
                return (
                  <button key={t.key} onClick={() => setAgeFilter(t.key)} data-testid={`age-tier-${t.key}`}
                    className={`px-3 py-1 text-[11px] font-bold uppercase tracking-wider border rounded-lg transition-colors ${
                      active ? "bg-stone-950 text-white border-stone-950" : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"
                    }`}>
                    {t.label} <span className={`ml-1 tabular-nums ${active ? "text-stone-300" : "text-stone-500"}`}>{count}</span>
                  </button>
                );
              })}
            </div>
            <span className="text-stone-300">·</span>
            <div className="flex items-center gap-2 flex-wrap" data-testid="source-filter">
              <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mr-1">Type</span>
              {[
                { key: "all",       label: "All",       },
                { key: "franchise", label: "Franchise"  },
                { key: "licence",   label: "Licence"    },
              ].map((s) => {
                const active = sourceFilter === s.key;
                const count = s.key === "all"
                  ? data.items.length
                  : data.items.filter((c) => c.source === (s.key === "franchise" ? "franchise_enquiry" : "licence_enquiry")).length;
                const dotColor = s.key === "franchise" ? "bg-stone-500" : s.key === "licence" ? "bg-indigo-500" : "bg-stone-300";
                return (
                  <button key={s.key} onClick={() => setSourceFilter(s.key)} data-testid={`source-${s.key}`}
                    className={`px-3 py-1 text-[11px] font-bold uppercase tracking-wider border rounded-lg transition-colors flex items-center gap-1.5 ${
                      active ? "bg-stone-950 text-white border-stone-950" : "bg-white text-stone-700 border-stone-300 hover:bg-stone-50"
                    }`}>
                    {s.key !== "all" && <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />}
                    {s.label} <span className={`ml-1 tabular-nums ${active ? "text-stone-300" : "text-stone-500"}`}>{count}</span>
                  </button>
                );
              })}
            </div>
            <span className="text-stone-300">·</span>
            <button
              onClick={async () => {
                if (!window.confirm("Find and remove duplicate Sales Pipeline contacts?\n\nThe same email submitted multiple times via Gravity Forms creates duplicate cards. This removes the newer 'new' duplicates when an older, already-triaged copy exists. Safe — never deletes triaged records.")) return;
                try {
                  const { data } = await api.post("/contacts/dedupe-pipeline");
                  const samples = (data.samples || []).slice(0, 5).map((s) => `${s.name || s.email}`).join("\n  • ");
                  window.alert(`Removed ${data.removed || 0} duplicate ${data.removed === 1 ? "record" : "records"}.${samples ? "\n\nIncluding:\n  • " + samples : ""}`);
                  load();
                  loadCounts();
                } catch (e) {
                  window.alert(e?.response?.data?.detail || "Dedupe failed.");
                }
              }}
              data-testid="pipeline-dedupe-btn"
              title="Find email duplicates in the pipeline and remove the 'new' copies when an older triaged version already exists"
              className="px-3 py-1 text-[11px] font-bold uppercase tracking-wider border border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 rounded-lg flex items-center gap-1.5"
            >
              <RefreshCw className="w-3 h-3" /> Dedupe pipeline
            </button>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-7 gap-3" data-testid="pipeline-summary">
            <button onClick={() => setStageFilter("")} className={`bg-white border border-stone-200 rounded-2xl p-4 text-left hover:border-stone-400 transition-colors ${stageFilter === "" ? "ring-2 ring-stone-950" : ""}`}>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Total</div>
              <div className="font-display text-2xl text-stone-950">{stats.total.toLocaleString()}</div>
            </button>
            {STAGES.map((s) => (
              <button key={s.key} onClick={() => setStageFilter(s.key === stageFilter ? "" : s.key)} data-testid={`stat-${s.key}`}
                className={`bg-white border border-stone-200 rounded-2xl p-4 text-left hover:border-stone-400 transition-colors ${stageFilter === s.key ? "ring-2 ring-stone-950" : ""}`}>
                <div className="flex items-center gap-1.5">
                  <div className={`w-1.5 h-1.5 rounded-full ${s.barColor}`} />
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">{s.label}</div>
                </div>
                <div className="font-display text-2xl text-stone-950">{(stats[s.key] || 0).toLocaleString()}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="p-8 pt-6">
        {error && <div className="mb-4 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2 rounded-xl"><AlertCircle className="w-4 h-4" />{error}</div>}
        {loading ? (
          <div className="text-center text-stone-500 text-sm uppercase tracking-widest p-12 flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        ) : isPipeline && view === "pipeline" ? (
          <div className="flex gap-3 items-stretch" data-testid="pipeline-board">
            {STAGES.map((stage) => {
              const items = grouped[stage.key] || [];
              const collapsed = collapsedStages.has(stage.key);
              if (collapsed) {
                // Narrow vertical strip — rotated label + count, click anywhere to re-open.
                return (
                  <button
                    key={stage.key}
                    type="button"
                    onClick={() => toggleStageCollapsed(stage.key)}
                    data-testid={`pipeline-column-${stage.key}`}
                    title={`Expand ${stage.label}`}
                    className={`w-10 shrink-0 bg-white border border-stone-200 rounded-2xl overflow-hidden hover:border-stone-500 transition-colors`}>
                    <div className={`px-1 py-2.5 border-b border-stone-200 flex items-center justify-center ${stage.color.split(" ")[0]}`}>
                      <ChevronsRight className="w-3.5 h-3.5 text-stone-700" />
                    </div>
                    <div className="py-4 flex flex-col items-center gap-3" style={{ minHeight: "12rem" }}>
                      <span className="text-xs font-bold text-stone-700 tabular-nums">{items.length}</span>
                      <span
                        className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-700"
                        style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
                        {stage.label}
                      </span>
                    </div>
                  </button>
                );
              }
              return (
                <div key={stage.key} className="flex-1 min-w-0 bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid={`pipeline-column-${stage.key}`}>
                  <div className={`px-3 py-2.5 border-b border-stone-200 ${stage.color.split(" ")[0]}`}>
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => toggleStageCollapsed(stage.key)}
                        data-testid={`pipeline-column-collapse-${stage.key}`}
                        title={`Collapse ${stage.label}`}
                        className="shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-white/60 text-stone-700">
                        <ChevronsLeft className="w-3.5 h-3.5" />
                      </button>
                      <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-900 truncate">{stage.label}</span>
                      <span className="text-xs text-stone-700 font-bold tabular-nums">{items.length}</span>
                    </div>
                  </div>
                  <div className="p-2 space-y-1.5 max-h-[calc(100vh-22rem)] overflow-y-auto">
                    {items.slice(0, 100).map((c) => {
                      const age = daysSince(c.date || c.date_added);
                      const checked = selectedIds.has(c.id);
                      const srcStyle = SOURCE_STYLE[c.source] || SOURCE_STYLE.general_enquiry;
                      return (
                        <div key={c.id} onClick={() => setSelected(c)}
                          className={`bg-white border border-stone-200 rounded-xl p-2.5 hover:border-stone-500 cursor-pointer text-xs ${srcStyle.border} ${checked ? "ring-2 ring-stone-950" : ""}`}
                          data-testid={`pipeline-card-${c.id}`}>
                          <div className="flex items-start justify-between gap-2">
                            <button onClick={(e) => { e.stopPropagation(); toggleSelect(c.id, e); }} data-testid={`card-select-${c.id}`} className="shrink-0 text-stone-400 hover:text-stone-950">
                              {checked ? <CheckSquare className="w-3.5 h-3.5 text-stone-950" /> : <Square className="w-3.5 h-3.5" />}
                            </button>
                            <div className="font-semibold text-stone-950 truncate flex-1 flex items-center gap-1">
                              <span className="truncate">{[c.first_name, c.last_name].filter(Boolean).join(" ") || "Unnamed"}</span>
                              <ManualBadge addedBy={c.manually_added_by} />
                            </div>
                            {/* Lead-temperature picker. Pipeline-only: any
                                contact in the kanban is by definition in
                                the pipeline, so always render here. */}
                            <TemperaturePicker
                              value={c.temperature}
                              onChange={(next) => setTemperature(c.id, next)}
                              testidPrefix={`card-temp-${c.id}`}
                            />
                          </div>
                          {c.establishment_name && <div className="text-stone-600 truncate mt-0.5 pl-5">{c.establishment_name}</div>}
                          <div className="flex items-center justify-between mt-1.5 text-[10px] pl-5 gap-2">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className={`px-1.5 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider border ${srcStyle.pill}`}>{srcStyle.label}</span>
                              {c.postcode && (
                                <span className="text-stone-500 truncate hidden xl:inline" title={c.postcode}>{c.postcode}</span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {(!c.pipeline_status || c.pipeline_status === "new") && (
                                <>
                                  {c.email && (
                                    <button onClick={(e) => { e.stopPropagation(); replyByEmail(c); }}
                                      data-testid={`reply-${c.id}`}
                                      title={`Send reply to ${c.email} (auto-advances to Contacted)`}
                                      className="px-2 py-0.5 rounded-md bg-[#E2462A] hover:bg-[#C73B22] text-white text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 shadow-sm">
                                      <Send className="w-2.5 h-2.5" /> Reply
                                    </button>
                                  )}
                                  <button onClick={(e) => { e.stopPropagation(); updateStage(c.id, "contacted"); }}
                                    data-testid={`mark-contacted-${c.id}`}
                                    title="Mark Contacted — use this if you've replied in your own email app"
                                    className="px-1.5 py-0.5 rounded-md bg-white border border-stone-300 text-stone-700 hover:bg-stone-950 hover:text-white hover:border-stone-950 text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 transition-colors">
                                    <CheckCircle2 className="w-2.5 h-2.5" />
                                  </button>
                                </>
                              )}
                              <AgeBadge days={age} />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {items.length === 0 && <div className="text-[10px] text-stone-400 px-1 py-2 text-center">No enquiries</div>}
                    {items.length > 100 && <div className="text-[10px] text-stone-500 px-1">+{items.length - 100} more</div>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid="contacts-table">
            <table className="w-full">
              <thead className="bg-[#F2F2F0] border-b border-stone-200">
                <tr>
                  <th className="px-3 py-3 w-10">
                    <button onClick={(e) => {
                      e.stopPropagation();
                      const visibleIds = visibleItems.slice(0, 500).map((c) => c.id);
                      const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
                      setSelectedIds(allSelected ? new Set() : new Set(visibleIds));
                      setLastSelectedId(null);
                    }} data-testid="select-all" className="text-stone-500 hover:text-stone-900">
                      {visibleItems.length > 0 && visibleItems.slice(0, 500).every((c) => selectedIds.has(c.id)) ?
                        <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                    </button>
                  </th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Name / Establishment</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-32">Date</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Contact</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-32">Location</th>
                  <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-28">Source</th>
                  {isPipeline && <th className="text-left px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-32">Stage</th>}
                  <th className="text-right px-3 py-3 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 w-32">Move</th>
                </tr>
              </thead>
              <tbody>
                {visibleItems.length === 0 ? (
                  <tr><td colSpan={isPipeline ? 8 : 7} className="px-3 py-10 text-center text-sm text-stone-500">No records.</td></tr>
                ) : visibleItems.slice(0, displayLimit).map((c) => {
                  const checked = selectedIds.has(c.id);
                  const age = daysSince(c.date || c.date_added);
                  return (
                  <tr key={c.id} onClick={() => setSelected(c)} className={`border-b border-stone-100 last:border-0 hover:bg-stone-50 cursor-pointer ${checked ? "bg-[#dddd16]/5" : ""}`} data-testid={`contact-row-${c.id}`}>
                    <td className="px-3 py-2" onClick={(e) => { e.stopPropagation(); toggleSelect(c.id, e); }}>
                      <button data-testid={`select-${c.id}`} className="text-stone-500 hover:text-stone-900">
                        {checked ? <CheckSquare className="w-4 h-4 text-stone-950" /> : <Square className="w-4 h-4" />}
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-sm text-stone-950 font-semibold flex items-center gap-1.5 flex-wrap">
                        {[c.first_name, c.last_name].filter(Boolean).join(" ") || "(no name)"}
                        <ManualBadge addedBy={c.manually_added_by} />
                        {!isPipeline && c.in_pipeline && (
                          <span data-testid={`in-pipeline-${c.id}`}
                            className="px-1.5 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider bg-[#dddd16] text-stone-950 border border-stone-950 flex items-center gap-1"
                            title="Also in the Sales Pipeline">
                            <Kanban className="w-2.5 h-2.5" />
                            In Pipeline{c.pipeline_status ? ` · ${c.pipeline_status.replace(/_/g, " ")}` : ""}
                          </span>
                        )}
                      </div>
                      {c.establishment_name && <div className="text-xs text-stone-600">{c.establishment_name}</div>}
                    </td>
                    <td className="px-3 py-2 text-xs text-stone-500">
                      <div className="flex items-center gap-1.5 tabular-nums">
                        <span>{formatDate(c.date || c.date_added)}</span>
                        {isPipeline && <AgeBadge days={age} />}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-stone-600">
                      <div>{c.email || c.email_raw || "—"}</div>
                      <div className="text-stone-400">{c.telephone || c.mobile_phone || ""}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-stone-700">{[c.city, c.postcode].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="px-3 py-2 text-xs text-stone-700"><SourcePill source={c.source} /></td>
                    {isPipeline && <td className="px-3 py-2"><StageBadge status={c.pipeline_status} /></td>}
                    <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                      <MoveMenu
                        onMove={(target, stage) => moveContact(c.id, target, stage)}
                        label="Move" testid={`row-move-${c.id}`}
                        currentTab={tab}
                        contactSource={c.source}
                        inPipeline={!!c.in_pipeline} />
                    </td>
                  </tr>
                );
                })}
              </tbody>
            </table>
            {visibleItems.length > displayLimit && (
              <div className="px-3 py-3 text-xs text-stone-500 border-t border-stone-100 flex items-center justify-between gap-3 flex-wrap">
                <span data-testid="list-pagination-status">
                  Showing first {displayLimit.toLocaleString()} of {visibleItems.length.toLocaleString()}.
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setDisplayLimit((n) => Math.min(visibleItems.length, n + 500))}
                    data-testid="list-show-more"
                    className="px-3 py-1.5 border border-stone-300 bg-white text-stone-900 text-[11px] font-bold uppercase tracking-wider hover:bg-stone-50 rounded-lg transition-colors flex items-center gap-1.5"
                  >
                    Show 500 more
                  </button>
                  <button
                    type="button"
                    onClick={() => setDisplayLimit(visibleItems.length)}
                    data-testid="list-show-all"
                    className="px-3 py-1.5 border border-stone-300 bg-white text-stone-900 text-[11px] font-bold uppercase tracking-wider hover:bg-stone-50 rounded-lg transition-colors"
                  >
                    Show all {visibleItems.length.toLocaleString()}
                  </button>
                </div>
              </div>
            )}
            {visibleItems.length > 500 && visibleItems.length <= displayLimit && (
              <div className="px-3 py-2 text-xs text-stone-500 border-t border-stone-100" data-testid="list-pagination-status">
                Showing all {visibleItems.length.toLocaleString()} records.
              </div>
            )}
          </div>
        )}
      </div>

      <ContactDrawer contact={selected} onClose={() => setSelected(null)}
        onStageChange={updateStage} onPromote={promote}
        onDemote={(id) => {
          const src = selected?.source;
          const target = src === "licence_enquiry" ? "licence" : src === "franchise_enquiry" ? "franchise" : "general";
          return moveContact(id, target);
        }}
        onDelete={remove}
        onReply={replyByEmail}
        onConvert={convertContact}
        onLinkExisting={openLinkExisting}
        onAdminNotesUpdated={(id, notes, updatedAt) => {
          setData((d) => ({
            ...d,
            items: d.items.map((c) => c.id === id
              ? { ...c, admin_notes: notes, admin_notes_updated_at: updatedAt }
              : c),
          }));
          setSelected((sel) => sel && sel.id === id
            ? { ...sel, admin_notes: notes, admin_notes_updated_at: updatedAt }
            : sel);
        }}
        onChecklistChanged={(payload) => {
          // Mirror checklist booleans + companion fields back into the cached
          // contact list so anything else listening to that data (counts,
          // badges) stays in sync without a full re-fetch.
          const patch = {
            territory_defined: payload.territory_defined,
            contract_sent: payload.contract_sent,
            shadow_day_booked: payload.shadow_day_booked,
            shadow_day_date: payload.shadow_day_date,
            shadowing_with: payload.shadowing_with,
            training_days_booked: payload.training_days_booked,
            training_day_dates: payload.training_day_dates,
            checklist_updated_at: payload.checklist_updated_at,
            launch_checklist: payload.launch_checklist,
            launch_checklist_updated_at: payload.launch_checklist_updated_at,
          };
          // Strip undefined so a partial payload (e.g. only the launch
          // checklist saved) doesn't blow away the other cached fields.
          for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
          setData((d) => ({
            ...d,
            items: d.items.map((c) => c.id === payload.id ? { ...c, ...patch } : c),
          }));
          setSelected((sel) => sel && sel.id === payload.id ? { ...sel, ...patch } : sel);
        }}
        onChangeSource={async (c, target) => {
          // Reclassify the contact (Franchise ↔ Licence ↔ General). Uses
          // the same /contacts/{id}/move endpoint as the row-level MoveMenu
          // so behaviour is consistent — but we want the drawer to STAY
          // OPEN on the same contact afterwards so the admin can carry on
          // working, rather than the drawer closing as it does in the
          // list-view flow.
          const labelMap = { franchise: "Franchise enquiry", licence: "Licence enquiry", general: "General enquiry" };
          if (!window.confirm(`Reclassify ${[c.first_name, c.last_name].filter(Boolean).join(" ") || "this contact"} as a ${labelMap[target]}?`)) return;
          try {
            await api.post(`/contacts/${c.id}/move`, { target });
            const newSource = target === "franchise" ? "franchise_enquiry" : target === "licence" ? "licence_enquiry" : "general_enquiry";
            setData((d) => ({
              ...d,
              items: d.items.map((x) => x.id === c.id ? { ...x, source: newSource } : x),
            }));
            setSelected((sel) => sel && sel.id === c.id ? { ...sel, source: newSource } : sel);
            loadCounts();
          } catch { setError("Could not reclassify contact."); }
        }} />
      <LinkExistingFranchiseeModal
        open={!!linkingContact}
        contact={linkingContact}
        onClose={() => setLinkingContact(null)}
        onLinked={handleLinked} />
      <MergeContactsModal
        open={!!mergePair}
        contactA={mergePair?.a}
        contactB={mergePair?.b}
        onClose={() => setMergePair(null)}
        onMerged={handleMerged} />
      <DuplicatesModal
        open={duplicatesOpen}
        reloadAt={duplicatesReloadAt}
        onClose={() => setDuplicatesOpen(false)}
        onPickPair={(a, b) => setMergePair({ a, b })} />
      <AddContactModal open={addOpen} onClose={() => setAddOpen(false)}
        defaultTarget={tab === "pipeline" ? "franchise" : tab}
        onCreated={(_c, target) => {
          if (target && target !== tab) setTab(target);
          load();
        }} />
      <ImportCsvModal open={importOpen} onClose={() => setImportOpen(false)}
        defaultTarget={tab === "pipeline" ? "licence" : tab}
        onImported={(_r, target) => {
          if (target && target !== tab) setTab(target);
          load();
        }} />
      {/* Kanban quick-Reply modal — same flow as the drawer's "Reply with
          template" button but launched from the orange paper-plane button
          on each pipeline card. Sends via Resend, picks template by
          contact source, carries signature + attachments. */}
      <ReplyWithTemplateModal
        open={!!kanbanReplyContact}
        contact={kanbanReplyContact}
        onClose={() => setKanbanReplyContact(null)}
        onSent={() => { setKanbanReplyContact(null); load(); }}
      />
    </div>
  );
}
