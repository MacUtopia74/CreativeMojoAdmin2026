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
import PortalEventsPanel from "@/components/portal/PortalEventsPanel";
import PortalBottomNav from "@/components/portal/PortalBottomNav";
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
  // Events panel — defaults closed because not every franchisee has
  // scheduled meetings, but stays sticky once they open it.
  const [eventsOpen, setEventsOpen] = useState(() => {
    try { return JSON.parse(localStorage.getItem("portal.eventsOpen") ?? "false"); }
    catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem("portal.eventsOpen", JSON.stringify(eventsOpen)); } catch (_) { /* noop */ } }, [eventsOpen]);

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
    <div className="min-h-screen bg-[#FBFAF8] pl-safe pr-safe" style={{ zoom: FONT_SCALES[fontScale].zoom }} data-testid="portal-dashboard">
      {/* Top bar — compact on mobile (logo + sign-out only), full on desktop */}
      <header className="bg-white border-b border-stone-200 sticky top-0 z-30 pt-safe">
        <div className="max-w-6xl mx-auto px-5 sm:px-6 py-2 sm:py-3 flex items-center justify-between gap-2">
          <Logo className="h-7 sm:h-10 shrink-0 max-w-[40%]" />
          <div className="flex items-center gap-2 sm:gap-4">
            <button
              onClick={() => {
                const order = ["small", "medium", "large", "xlarge"];
                const next = order[(order.indexOf(fontScale) + 1) % order.length];
                setFontScale(next);
              }}
              title={`Text size: ${FONT_SCALES[fontScale].label} — click for the next size`}
              data-testid="portal-font-size"
              className="touch-target px-2.5 sm:px-3 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-lg flex items-center gap-1.5"
            >
              <Type className="w-3.5 h-3.5" />
              <span className="hidden md:inline">Change font size · {FONT_SCALES[fontScale].label}</span>
              <span className="md:hidden">{FONT_SCALES[fontScale].label}</span>
            </button>
            <div className="text-right hidden lg:block">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Signed in as</div>
              <div className="text-xs text-stone-900 font-mono">{user?.email}</div>
            </div>
            {/* Desktop sign-out — bottom nav handles this on mobile */}
            <button onClick={logout} data-testid="portal-logout"
              className="hidden md:flex touch-target px-3 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg items-center gap-1.5">
              <LogOut className="w-3 h-3" /> Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Generous bottom padding on mobile so content isn't hidden behind the
          fixed bottom-tab nav (~70px tall incl. safe-area). */}
      <main className="max-w-6xl mx-auto px-5 sm:px-6 py-5 sm:py-8 space-y-5 sm:space-y-6 pb-28 md:pb-8">
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
            {/* Hero card — stacks vertically on mobile, horizontal on sm+ */}
            <section
              id="portal-section-home"
              className="bg-white border border-stone-200 rounded-2xl px-4 sm:px-8 py-5 sm:py-7 scroll-mt-20"
              data-testid="portal-hero">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-5 sm:gap-6">
                <div className="flex items-start sm:items-center gap-4 sm:gap-5 min-w-0">
                  {profile.photo_url ? (
                    <img src={profile.photo_url} alt={profile.full_name || profile.first_name} className="w-16 h-16 sm:w-20 sm:h-20 rounded-full object-cover border-2 border-stone-200 shrink-0" />
                  ) : (
                    <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-stone-100 flex items-center justify-center text-stone-400 shrink-0">
                      <UserIcon className="w-8 h-8 sm:w-10 sm:h-10" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] sm:text-xs uppercase tracking-[0.3em] font-bold text-stone-500">
                      Franchise #{profile.franchise_number || "—"}
                    </div>
                    <div className="font-display text-lg sm:text-3xl text-stone-950 leading-tight break-words">{profile.organisation || profile.full_name || ""}</div>
                    <div className="text-sm sm:text-base text-stone-600 mt-0.5 break-words">{profile.first_name} {profile.last_name}</div>
                  </div>
                </div>
                <div className="flex items-center justify-between sm:justify-end gap-6 sm:gap-8 flex-wrap">
                  {years != null && (
                    <div className="text-center sm:text-right" data-testid="portal-years">
                      <div className="font-display text-3xl sm:text-4xl text-stone-950 tabular-nums leading-none">{years.toFixed(1)}</div>
                      <div className="text-[10px] sm:text-[11px] uppercase tracking-[0.2em] font-bold text-stone-500 mt-1.5">Years as a franchisee</div>
                    </div>
                  )}
                  {profile.gocardless_mandate_status && (
                    <div>
                      <div className="text-[10px] sm:text-[11px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1.5">Direct Debit</div>
                      <MandateBadge status={profile.gocardless_mandate_status} />
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* Profile / details — collapsible, full-width. Includes the
                franchisee's own private file area (R2 personal folder) at
                the bottom, so everything pertinent to their franchise
                lives in one place. */}
            <section
              id="portal-section-profile"
              className={`${detailsOpen ? "bg-white" : "bg-stone-100"} border border-stone-200 rounded-2xl overflow-hidden transition-colors scroll-mt-20`}
              data-testid="portal-contact">
              <button onClick={() => setDetailsOpen((v) => !v)} data-testid="toggle-details"
                className={`touch-target w-full flex items-center justify-between gap-3 ${detailsOpen ? "hover:bg-stone-50" : "hover:bg-stone-200"} transition-colors px-4 sm:px-6 py-3.5 sm:py-4`}>
                <div className="flex items-center gap-2">
                  <UserIcon className="w-4 h-4 text-stone-700" />
                  <span className="text-xs uppercase tracking-[0.3em] font-bold text-stone-700">Your franchise details</span>
                </div>
                <span className={`w-7 h-7 rounded-full border flex items-center justify-center transition-colors ${detailsOpen ? "border-stone-300 bg-white" : "border-stone-950 bg-stone-950 text-white"}`}>
                  {detailsOpen ? <ChevronUp className="w-3.5 h-3.5 text-stone-600" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </span>
              </button>
              {detailsOpen && (
                <>
                  <div className="px-4 sm:px-6 pb-5 sm:pb-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4">
                    <Field icon={Mail} label="Email" value={profile.mojo_email || profile.email} href={`mailto:${profile.mojo_email || profile.email}`} />
                    <Field icon={Phone} label="Phone" value={profile.phone} href={`tel:${profile.phone}`} />
                    <Field icon={Smartphone} label="Mobile" value={profile.mobile} href={`tel:${profile.mobile}`} />
                    <Field icon={Globe} label="Website" value={profile.website} href={profile.website} />
                    <Field icon={Calendar} label="Started with us" value={profile.start_date ? new Date(profile.start_date).toLocaleDateString("en-GB") : null} />
                    {profile.end_date && <Field icon={Clock} label="End date" value={new Date(profile.end_date).toLocaleDateString("en-GB")} />}
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
                            <div className="text-sm sm:text-base text-stone-900 leading-relaxed">
                              {addressLines.join(", ")}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Own franchise files — the franchisee's private R2 folder.
                      Locked to the "own" scope so the tab switcher is hidden.
                      This is the "documents pertinent to YOUR franchise" half
                      of the file split — shared/brand files live in the
                      FILES panel below. */}
                  <div className="border-t border-stone-200 px-4 sm:px-6 pb-5 sm:pb-6 pt-4 sm:pt-5">
                    <div className="flex items-center gap-2 mb-3">
                      <FolderOpen className="w-3.5 h-3.5 text-stone-400" />
                      <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">My franchise documents</span>
                    </div>
                    <FranchiseeFilesPanel franchisee={profile} lockedTab="own" />
                  </div>
                </>
              )}
            </section>

            {/* Territory map */}
            <section id="portal-section-map" className="scroll-mt-20">
              {territoryOpen ? (
                <div className="relative">
                  <button onClick={() => setTerritoryOpen(false)} data-testid="toggle-territory"
                    className="touch-target absolute top-3 sm:top-5 right-3 sm:right-5 z-10 rounded-full border border-stone-300 bg-white hover:bg-stone-100 flex items-center justify-center" aria-label="Hide territory map">
                    <ChevronUp className="w-3.5 h-3.5 text-stone-600" />
                  </button>
                  <div className="block md:hidden">
                    <FranchiseeTerritoryWidget mapHeight={360} />
                  </div>
                  <div className="hidden md:block">
                    <FranchiseeTerritoryWidget mapHeight={640} />
                  </div>
                </div>
              ) : (
                <button onClick={() => setTerritoryOpen(true)} data-testid="toggle-territory"
                  className="touch-target w-full bg-stone-100 border border-stone-200 rounded-2xl px-4 sm:px-6 py-3.5 sm:py-4 flex items-center justify-between gap-3 hover:bg-stone-200 transition-colors">
                  <div className="flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-stone-700" />
                    <span className="text-xs uppercase tracking-[0.3em] font-bold text-stone-700">Your territory map</span>
                  </div>
                  <span className="w-7 h-7 rounded-full border border-stone-950 bg-stone-950 text-white flex items-center justify-center">
                    <ChevronDown className="w-3.5 h-3.5" />
                  </span>
                </button>
              )}
            </section>

            {/* Events */}
            <section id="portal-section-events" className="scroll-mt-20">
              <PortalEventsPanel
                open={eventsOpen}
                onToggle={() => setEventsOpen((v) => !v)}
              />
            </section>

            {/* Shared files only — own files moved into Your Franchise
                Details above. */}
            <section
              id="portal-section-files"
              className={`${filesOpen ? "bg-white" : "bg-stone-100"} border border-stone-200 rounded-2xl overflow-hidden transition-colors scroll-mt-20`}
              data-testid="portal-files">
              <button onClick={() => setFilesOpen((v) => !v)} data-testid="toggle-files"
                className={`touch-target w-full flex items-center justify-between gap-3 ${filesOpen ? "hover:bg-stone-50" : "hover:bg-stone-200"} transition-colors px-4 sm:px-6 py-3.5 sm:py-4`}>
                <div className="flex items-center gap-2">
                  <FolderOpen className="w-4 h-4 text-stone-700" />
                  <span className="text-xs uppercase tracking-[0.3em] font-bold text-stone-700">Files</span>
                </div>
                <span className={`w-7 h-7 rounded-full border flex items-center justify-center transition-colors ${filesOpen ? "border-stone-300 bg-white" : "border-stone-950 bg-stone-950 text-white"}`}>
                  {filesOpen ? <ChevronUp className="w-3.5 h-3.5 text-stone-600" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </span>
              </button>
              {filesOpen && (
                <div className="px-4 sm:px-6 pb-5 sm:pb-6">
                  <RecentFilesStrip
                    onOpenFile={(f) => setPreviewFile(f)}
                    onDownload={downloadRecent}
                    onOpenFolder={() => { /* the panel below is the browser */ }}
                  />
                  <FranchiseeFilesPanel franchisee={profile} lockedTab="brand" />
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {/* Mobile-only bottom-tab nav — anchored to viewport bottom */}
      <PortalBottomNav
        onLogout={logout}
        sectionsRef={profile}
        onTabSelect={(id) => {
          // Accordion behaviour: tapping a bottom-nav tab expands ONLY the
          // matching section and collapses everything else.
          if (id === "portal-section-home") {
            setDetailsOpen(false);
            setTerritoryOpen(false);
            setEventsOpen(false);
            setFilesOpen(false);
          } else if (id === "portal-section-profile") {
            setDetailsOpen(true);
            setTerritoryOpen(false);
            setEventsOpen(false);
            setFilesOpen(false);
          } else if (id === "portal-section-map") {
            setTerritoryOpen(true);
            setDetailsOpen(false);
            setEventsOpen(false);
            setFilesOpen(false);
          } else if (id === "portal-section-events") {
            setEventsOpen(true);
            setDetailsOpen(false);
            setTerritoryOpen(false);
            setFilesOpen(false);
          } else if (id === "portal-section-files") {
            setFilesOpen(true);
            setDetailsOpen(false);
            setTerritoryOpen(false);
            setEventsOpen(false);
          }
        }} />

      {previewFile && <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />}
    </div>
  );
}
