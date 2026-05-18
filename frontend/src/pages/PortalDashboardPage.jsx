// Franchisee portal dashboard. The franchisee's "home" — shows their
// contact info, tenure, mandate status (read-only), files panel, and
// a Phase-4 placeholder for the territory map + postcode lookup.
import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import api from "@/lib/api";
import Logo from "@/components/Logo";
import FranchiseeFilesPanel from "@/components/files/FranchiseeFilesPanel";
import FranchiseeTerritoryWidget from "@/components/territory/FranchiseeTerritoryWidget";
import RecentFilesStrip from "@/components/files/RecentFilesStrip";
import FilePreviewModal from "@/components/files/FilePreviewModal";
import {
  LogOut, Phone, Mail, Globe, MapPin, Calendar, ShieldCheck, ShieldAlert,
  FolderOpen, User as UserIcon, Loader2, AlertCircle, Smartphone,
  Clock, ChevronDown, ChevronUp, Type, FileText,
} from "lucide-react";

// Font size preference — applied via CSS `zoom` on the portal wrapper.
// Earlier attempt used a Tailwind `text-*` class on the wrapper, which
// silently did nothing because every nested Tailwind utility (text-base,
// text-sm…) is `rem`-relative to the document root and overrides whatever
// is inherited. `zoom` is now broadly supported (Chrome, Safari, Firefox
// 126+) and scales icons, the map, and font sizes together — exactly what
// a franchisee who wants "make everything bigger" expects.
const FONT_SCALES = {
  small: { label: "Small", zoom: 0.9 },
  medium: { label: "Medium", zoom: 1 },
  large: { label: "Large", zoom: 1.15 },
  xlarge: { label: "Extra large", zoom: 1.3 },
};

function yearsBetween(iso) {
  if (!iso) return null;
  const start = new Date(iso); if (isNaN(start)) return null;
  const ms = Date.now() - start.getTime();
  const years = ms / (365.25 * 24 * 3600 * 1000);
  return years;
}

function Field({ icon: Icon, label, value, href }) {
  if (!value) return null;
  const content = (
    <div className="flex items-start gap-3">
      <Icon className="w-4 h-4 text-stone-400 mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-[0.2em] font-bold text-stone-500">{label}</div>
        <div className="text-base text-stone-900 truncate">{value}</div>
      </div>
    </div>
  );
  return href ? <a href={href} className="block hover:bg-stone-50 -mx-2 px-2 py-1.5 rounded-md transition-colors">{content}</a> : <div>{content}</div>;
}

function MandateBadge({ status }) {
  if (!status) return null;
  const map = {
    active: { cls: "bg-emerald-100 text-emerald-800 border-emerald-300", icon: ShieldCheck, label: "Active" },
    pending_submission: { cls: "bg-amber-100 text-amber-900 border-amber-300", icon: ShieldAlert, label: "Pending" },
    pending_customer_approval: { cls: "bg-amber-100 text-amber-900 border-amber-300", icon: ShieldAlert, label: "Awaiting approval" },
    submitted: { cls: "bg-blue-100 text-blue-800 border-blue-300", icon: ShieldCheck, label: "Submitted" },
    cancelled: { cls: "bg-red-100 text-red-700 border-red-300", icon: ShieldAlert, label: "Cancelled" },
    expired: { cls: "bg-stone-200 text-stone-700 border-stone-300", icon: ShieldAlert, label: "Expired" },
    failed: { cls: "bg-red-100 text-red-700 border-red-300", icon: ShieldAlert, label: "Failed" },
  };
  const v = map[status] || { cls: "bg-stone-100 text-stone-700 border-stone-300", icon: ShieldAlert, label: status };
  const I = v.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold uppercase tracking-wider rounded-md border ${v.cls}`}>
      <I className="w-3.5 h-3.5" /> {v.label}
    </span>
  );
}

export default function PortalDashboardPage() {
  const { user, logout } = useAuth();
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [previewFile, setPreviewFile] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/portal/me");
        setData(data);
      } catch (e) { setErr(e?.response?.data?.detail || "Could not load your dashboard."); }
    })();
  }, []);

  const profile = data?.profile;
  const years = yearsBetween(profile?.start_date);

  // Collapsible state for the two "supporting" panels — Files is the daily
  // tool, so we let the franchisee tuck these away to give Files the room.
  // Persisted to localStorage so we remember their preference across visits.
  const [detailsOpen, setDetailsOpen] = useState(() => {
    try { return JSON.parse(localStorage.getItem("portal.detailsOpen") ?? "true"); }
    catch { return true; }
  });
  const [territoryOpen, setTerritoryOpen] = useState(() => {
    try { return JSON.parse(localStorage.getItem("portal.territoryOpen") ?? "true"); }
    catch { return true; }
  });
  useEffect(() => { try { localStorage.setItem("portal.detailsOpen", JSON.stringify(detailsOpen)); } catch (_) { /* noop */ } }, [detailsOpen]);
  useEffect(() => { try { localStorage.setItem("portal.territoryOpen", JSON.stringify(territoryOpen)); } catch (_) { /* noop */ } }, [territoryOpen]);
  const [fontScale, setFontScale] = useState(() => {
    try {
      const v = localStorage.getItem("portal.fontScale");
      return FONT_SCALES[v] ? v : "medium";
    } catch { return "medium"; }
  });
  useEffect(() => { try { localStorage.setItem("portal.fontScale", fontScale); } catch (_) { /* noop */ } }, [fontScale]);
  const [filesOpen, setFilesOpen] = useState(() => {
    try { return JSON.parse(localStorage.getItem("portal.filesOpen") ?? "true"); }
    catch { return true; }
  });
  useEffect(() => { try { localStorage.setItem("portal.filesOpen", JSON.stringify(filesOpen)); } catch (_) { /* noop */ } }, [filesOpen]);

  // Compose the full address from any of the field-name variants Airtable
  // / the migrator may have stored under.
  const addressLines = profile ? [
    profile.address || profile.address_street,
    profile.address_line2,
    profile.city || profile.town,
    profile.county,
    profile.postcode,
    profile.country,
  ].filter(Boolean) : [];

  const downloadRecent = async (key) => {
    try {
      const { data: dl } = await api.get("/files/download", { params: { key, attachment: true } });
      window.location.href = dl.url;
    } catch (e) { /* noop */ }
  };

  return (
    <div className="min-h-screen bg-[#FBFAF8]" style={{ zoom: FONT_SCALES[fontScale].zoom }} data-testid="portal-dashboard">
      {/* Top bar */}
      <header className="bg-white border-b border-stone-200">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between gap-3">
          <Logo className="h-10" />
          <div className="flex items-center gap-4">
            {/* Font size cycler — bumps through S → M → L → XL via CSS
                `zoom`, which scales every visual element (text, icons,
                map labels) in one go. */}
            <button
              onClick={() => {
                const order = ["small", "medium", "large", "xlarge"];
                const next = order[(order.indexOf(fontScale) + 1) % order.length];
                setFontScale(next);
              }}
              title={`Text size: ${FONT_SCALES[fontScale].label} — click for the next size`}
              data-testid="portal-font-size"
              className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-lg flex items-center gap-1.5"
            >
              <Type className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Change font size · {FONT_SCALES[fontScale].label}</span>
              <span className="sm:hidden">{FONT_SCALES[fontScale].label}</span>
            </button>
            <div className="text-right hidden sm:block">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Signed in as</div>
              <div className="text-xs text-stone-900 font-mono">{user?.email}</div>
            </div>
            <button onClick={logout} data-testid="portal-logout"
              className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg flex items-center gap-1.5">
              <LogOut className="w-3 h-3" /> Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        {err && (
          <div className="px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-2xl flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}
        {!data && !err && (
          <div className="flex items-center gap-2 text-sm text-stone-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading your account…</div>
        )}

        {profile && (
          <>
            {/* Hero card */}
            <div className="bg-white border border-stone-200 rounded-2xl px-8 py-7 flex items-center justify-between gap-6 flex-wrap" data-testid="portal-hero">
              <div className="flex items-center gap-5">
                {profile.photo_url ? (
                  <img src={profile.photo_url} alt={profile.full_name || profile.first_name} className="w-20 h-20 rounded-full object-cover border-2 border-stone-200" />
                ) : (
                  <div className="w-20 h-20 rounded-full bg-stone-100 flex items-center justify-center text-stone-400">
                    <UserIcon className="w-10 h-10" />
                  </div>
                )}
                <div>
                  <div className="text-xs uppercase tracking-[0.3em] font-bold text-stone-500">
                    Franchise #{profile.franchise_number || "—"}
                  </div>
                  <div className="font-display text-3xl text-stone-950 leading-tight">{profile.organisation || profile.full_name || ""}</div>
                  <div className="text-base text-stone-600 mt-0.5">{profile.first_name} {profile.last_name}</div>
                </div>
              </div>
              <div className="flex items-center gap-8 flex-wrap">
                {years != null && (
                  <div className="text-center" data-testid="portal-years">
                    <div className="font-display text-4xl text-stone-950 tabular-nums leading-none">{years.toFixed(1)}</div>
                    <div className="text-[11px] uppercase tracking-[0.2em] font-bold text-stone-500 mt-1.5">Years as a franchisee</div>
                  </div>
                )}
                {profile.gocardless_mandate_status && (
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1.5">Direct Debit</div>
                    <MandateBadge status={profile.gocardless_mandate_status} />
                  </div>
                )}
              </div>
            </div>

            {/* Your details — full-width landscape strip across the top.
                Collapsible so the franchisee can shrink it to a header bar
                if they want even more room for the map and files below. */}
            <div className={`${detailsOpen ? "bg-white" : "bg-stone-100"} border border-stone-200 rounded-2xl overflow-hidden transition-colors`} data-testid="portal-contact">
              <button onClick={() => setDetailsOpen((v) => !v)} data-testid="toggle-details"
                className={`w-full flex items-center justify-between gap-3 ${detailsOpen ? "hover:bg-stone-50" : "hover:bg-stone-200"} transition-colors px-6 py-4`}>
                <div className="flex items-center gap-2">
                  <UserIcon className="w-4 h-4 text-stone-700" />
                  <span className="text-xs uppercase tracking-[0.3em] font-bold text-stone-700">Your details</span>
                </div>
                <span className={`w-7 h-7 rounded-full border flex items-center justify-center transition-colors ${detailsOpen ? "border-stone-300 bg-white" : "border-stone-950 bg-stone-950 text-white"}`}>
                  {detailsOpen ? <ChevronUp className="w-3.5 h-3.5 text-stone-600" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </span>
              </button>
              {detailsOpen && (
                <div className="px-6 pb-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4">
                  <Field icon={Mail} label="Email" value={profile.mojo_email || profile.email} href={`mailto:${profile.mojo_email || profile.email}`} />
                  <Field icon={Phone} label="Phone" value={profile.phone} href={`tel:${profile.phone}`} />
                  <Field icon={Smartphone} label="Mobile" value={profile.mobile} href={`tel:${profile.mobile}`} />
                  <Field icon={Globe} label="Website" value={profile.website} href={profile.website} />
                  <Field icon={Calendar} label="Started with us" value={profile.start_date ? new Date(profile.start_date).toLocaleDateString("en-GB") : null} />
                  {profile.end_date && <Field icon={Clock} label="End date" value={new Date(profile.end_date).toLocaleDateString("en-GB")} />}
                  {/* Current contract — only renders if we have something on
                      file. Three side-by-side fields keep this readable on
                      both desktop and tablet widths. */}
                  {profile.current_contract && (
                    <div className="sm:col-span-2 lg:col-span-3 mt-2 pt-4 border-t border-stone-200">
                      <div className="flex items-center gap-2 mb-3">
                        <FileText className="w-3.5 h-3.5 text-stone-400" />
                        <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Current contract</span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-3">
                        <Field icon={Calendar} label="Started" value={profile.current_contract.commencement_date ? new Date(profile.current_contract.commencement_date).toLocaleDateString("en-GB") : "—"} />
                        <Field icon={Clock} label="Expires" value={profile.current_contract.renewal_date ? new Date(profile.current_contract.renewal_date).toLocaleDateString("en-GB") : "—"} />
                        <Field icon={FileText} label="Term" value={profile.current_contract.contract_term_years ? `${profile.current_contract.contract_term_years} year${profile.current_contract.contract_term_years === 1 ? "" : "s"}` : "—"} />
                      </div>
                    </div>
                  )}
                  {addressLines.length > 0 && (
                    <div className="sm:col-span-2 lg:col-span-3" data-testid="portal-address">
                      <div className="flex items-start gap-3">
                        <MapPin className="w-4 h-4 text-stone-400 mt-0.5 shrink-0" />
                        <div className="min-w-0">
                          <div className="text-[11px] uppercase tracking-[0.2em] font-bold text-stone-500">Address</div>
                          <div className="text-base text-stone-900 leading-relaxed">
                            {addressLines.join(", ")}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Territory widget — also full-width, also collapsible. Taller
                map (`mapHeight=640`) since the details panel above is now a
                strip rather than a sidebar. */}
            {territoryOpen ? (
              <div className="relative">
                <button onClick={() => setTerritoryOpen(false)} data-testid="toggle-territory"
                  className="absolute top-5 right-5 z-10 w-7 h-7 rounded-full border border-stone-300 bg-white hover:bg-stone-100 flex items-center justify-center" aria-label="Hide territory">
                  <ChevronUp className="w-3.5 h-3.5 text-stone-600" />
                </button>
                <FranchiseeTerritoryWidget mapHeight={640} />
              </div>
            ) : (
              <button onClick={() => setTerritoryOpen(true)} data-testid="toggle-territory"
                className="w-full bg-stone-100 border border-stone-200 rounded-2xl px-6 py-4 flex items-center justify-between gap-3 hover:bg-stone-200 transition-colors">
                <div className="flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-stone-700" />
                  <span className="text-xs uppercase tracking-[0.3em] font-bold text-stone-700">Your territory</span>
                </div>
                <span className="w-7 h-7 rounded-full border border-stone-950 bg-stone-950 text-white flex items-center justify-center">
                  <ChevronDown className="w-3.5 h-3.5" />
                </span>
              </button>
            )}

            {/* Files — primary daily-use tool. Collapsible like the other
                two panels so the franchisee can shrink it on small screens
                or when they want a quick map-only view. Default open. */}
            <div className={`${filesOpen ? "bg-white" : "bg-stone-100"} border border-stone-200 rounded-2xl overflow-hidden transition-colors`} data-testid="portal-files">
              <button onClick={() => setFilesOpen((v) => !v)} data-testid="toggle-files"
                className={`w-full flex items-center justify-between gap-3 ${filesOpen ? "hover:bg-stone-50" : "hover:bg-stone-200"} transition-colors px-6 py-4`}>
                <div className="flex items-center gap-2">
                  <FolderOpen className="w-4 h-4 text-stone-700" />
                  <span className="text-xs uppercase tracking-[0.3em] font-bold text-stone-700">Your files</span>
                </div>
                <span className={`w-7 h-7 rounded-full border flex items-center justify-center transition-colors ${filesOpen ? "border-stone-300 bg-white" : "border-stone-950 bg-stone-950 text-white"}`}>
                  {filesOpen ? <ChevronUp className="w-3.5 h-3.5 text-stone-600" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </span>
              </button>
              {filesOpen && (
                <div className="px-6 pb-6">
                  {/* Live recents — last 30 days of activity scoped to this
                      franchisee's own folder + shared brand files. */}
                  <RecentFilesStrip
                    onOpenFile={(f) => setPreviewFile(f)}
                    onDownload={downloadRecent}
                    onOpenFolder={() => { /* the panel below is the browser */ }}
                  />
                  <FranchiseeFilesPanel franchisee={profile} />
                </div>
              )}
            </div>
          </>
        )}
      </main>
      {previewFile && <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />}
    </div>
  );
}
