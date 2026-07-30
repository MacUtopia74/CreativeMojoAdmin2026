// Portal — "My Franchise" page (previously /portal + /portal/details).
//
// Combines the old Home hero (photo, organisation, years, mandate
// badge) with the franchisee's contact details and their private R2
// document folder. Section headings are intentionally large per Paul's
// spec — this is the page a franchisee lands on after signing in, so
// "MY FRANCHISE DETAILS" and "MY FRANCHISE DOCUMENTS" should read
// like proper section dividers, not muted micro-labels.
import { useOutletContext } from "react-router-dom";
import { useState, useEffect } from "react";
import {
  Mail, Phone, Globe, MapPin, Calendar, Clock, Smartphone,
  User as UserIcon, FileText, FolderOpen,
  ShieldCheck, ShieldAlert, Home, Facebook,
  Save, CheckCircle2, AlertCircle, Loader2, ExternalLink,
} from "lucide-react";
import api from "@/lib/api";
import FranchiseeFilesPanel from "@/components/files/FranchiseeFilesPanel";
import PortalPageHeading from "@/components/portal/PortalPageHeading";
import { PortalContractsSection } from "@/pages/portal/PortalContractsPage";

function yearsBetween(iso) {
  if (!iso) return null;
  const start = new Date(iso); if (isNaN(start)) return null;
  return (Date.now() - start.getTime()) / (365.25 * 24 * 3600 * 1000);
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

// Read-only, opt-in display field used inside "Your Mojo page profile".
// Renders the underlying admin value non-editably and offers a single
// checkbox that gates whether the field surfaces on the public map
// popup. Explicitly does NOT fall back to any other data source — if
// `value` is blank the popup will simply omit the field.
function ReadOnlyGate({ label, icon: Icon, value, placeholder, toggleLabel,
                       checked, onChange, testid, renderValue }) {
  const hasValue = !!value;
  return (
    <div data-testid={testid}>
      <label className="text-[11px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-2">
        <Icon className="w-3.5 h-3.5" /> {label}
      </label>
      <div className="mt-2 px-3 py-2.5 border border-stone-200 rounded-lg bg-stone-50 text-sm text-stone-900 flex items-center gap-3 min-h-[46px]">
        {renderValue && hasValue
          ? renderValue(value)
          : (
            <span className={hasValue ? "truncate" : "text-stone-400 italic"}>
              {hasValue ? value : placeholder}
            </span>
          )}
      </div>
      <label
        className={`mt-1.5 flex items-center gap-2 text-sm ${
          hasValue ? "text-stone-800 cursor-pointer" : "text-stone-400 cursor-not-allowed"
        }`}
      >
        <input
          type="checkbox"
          data-testid={`${testid}-toggle`}
          checked={hasValue && checked}
          disabled={!hasValue}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4 accent-emerald-600 disabled:opacity-40"
        />
        {toggleLabel}
        {!hasValue && <span className="text-[11px] text-stone-400 italic">(no value to show)</span>}
      </label>
    </div>
  );
}

export default function PortalDetailsPage() {
  const { profile: data, refreshProfile } = useOutletContext();
  const profile = data?.profile;

  // Local editable state for the "Website Profile" section — the values
  // franchisees curate for the creativemojo.co.uk map popup. Seeded
  // from the fetched profile; PATCH writes back and refreshes.
  const [wpForm, setWpForm] = useState({
    website_email: "",
    website_phone: "",
    website_bio: "",
    show_website_email: false,
    show_website_phone: false,
    show_website_bio: false,
    // Jul-2026 popup overhaul — new opt-in gates for the read-only
    // display fields the franchisee also gets to control (territory
    // name, their full name, profile photo, Facebook link).
    show_website_territory_name: false,
    show_website_franchisee_name: false,
    show_website_photo: false,
    show_website_facebook: false,
  });
  const [wpSaving, setWpSaving] = useState(false);
  const [wpSavedAt, setWpSavedAt] = useState(null);
  const [wpErr, setWpErr] = useState("");

  useEffect(() => {
    if (!profile) return;
    // Jul-2026 popup overhaul: the four new show_* flags default to
    // true when the underlying value is populated and the franchisee
    // has not yet explicitly untied. This mirrors backend behaviour
    // in find_class_routes._flag_default_true so the portal UI
    // reflects what the map popup will actually render.
    const rawArea = (profile?.organisation || "").trim();
    const franchiseeName = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim();
    const photoUrl = (Array.isArray(profile?.photos) && profile.photos[0]?.url) || profile?.photo_url || "";
    const facebookUrl = profile?.facebook || "";
    const dflt = (flag, hasValue) =>
      flag === undefined || flag === null ? !!hasValue : !!flag;
    setWpForm({
      website_email: profile.website_email || "",
      website_phone: profile.website_phone || "",
      website_bio: profile.website_bio || "",
      show_website_email: !!profile.show_website_email,
      show_website_phone: !!profile.show_website_phone,
      show_website_bio: !!profile.show_website_bio,
      show_website_territory_name: dflt(profile.show_website_territory_name, rawArea),
      show_website_franchisee_name: dflt(profile.show_website_franchisee_name, franchiseeName),
      show_website_photo: dflt(profile.show_website_photo, photoUrl),
      show_website_facebook: dflt(profile.show_website_facebook, facebookUrl),
    });
  }, [profile?.website_email, profile?.website_phone, profile?.website_bio,
      profile?.show_website_email, profile?.show_website_phone, profile?.show_website_bio,
      profile?.show_website_territory_name, profile?.show_website_franchisee_name,
      profile?.show_website_photo, profile?.show_website_facebook,
      profile?.organisation, profile?.first_name, profile?.last_name,
      profile?.photo_url, profile?.facebook]);

  const saveWebsiteProfile = async () => {
    setWpSaving(true); setWpErr("");
    try {
      await api.patch("/portal/me/website-profile", wpForm);
      setWpSavedAt(new Date());
      if (refreshProfile) await refreshProfile();
    } catch (e) {
      setWpErr(e?.response?.data?.detail || "Couldn't save — please try again.");
    } finally {
      setWpSaving(false);
    }
  };

  if (!profile) return null;
  const years = yearsBetween(profile.start_date);
  const addressLines = [
    profile.address || profile.address_street,
    profile.address_line2,
    profile.city || profile.town,
    profile.county,
    profile.postcode,
    profile.country,
  ].filter(Boolean);

  return (
    <div className="space-y-6" data-testid="portal-details">
      <PortalPageHeading
        eyebrow="Welcome back"
        icon={Home}
        title="My Franchise"
        subtitle="Your franchise details, key dates, and private document vault — all in one place."
      />
      {/* Hero — moved from the retired Home page. */}
      <section
        className="bg-white border border-stone-200 rounded-2xl px-4 sm:px-8 py-5 sm:py-7"
        data-testid="portal-hero"
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-5 sm:gap-6">
          <div className="flex items-start sm:items-center gap-4 sm:gap-5 min-w-0">
            {profile.photo_url ? (
              <img src={profile.photo_url} alt="" className="w-16 h-16 sm:w-20 sm:h-20 rounded-full object-cover border-2 border-stone-200 shrink-0" />
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

      {/* Section: Your franchise details — big heading per spec. */}
      <section className="bg-white border border-stone-200 rounded-2xl px-4 sm:px-6 py-5 sm:py-6" data-testid="portal-franchise-details">
        <div className="flex items-center gap-3 mb-5 pb-4 border-b border-stone-200">
          <UserIcon className="w-6 h-6 text-stone-700 shrink-0" />
          <h1 className="font-display text-2xl sm:text-3xl font-black text-stone-950 tracking-tight">Your franchise details</h1>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4">
          <Field icon={Mail} label="Email" value={profile.mojo_email || profile.email} href={`mailto:${profile.mojo_email || profile.email}`} />
          <Field icon={Phone} label="Phone" value={profile.phone} href={`tel:${profile.phone}`} />
          <Field icon={Smartphone} label="Mobile" value={profile.mobile} href={`tel:${profile.mobile}`} />
          <Field icon={Globe} label="Website" value={profile.website} href={profile.website} />
          <Field icon={Calendar} label="Started with us" value={profile.start_date ? new Date(profile.start_date).toLocaleDateString("en-GB") : null} />
          {profile.end_date && <Field icon={Clock} label="End date" value={new Date(profile.end_date).toLocaleDateString("en-GB")} />}
          {/* Franchisee's OWN public Facebook page — promoted to a
              prominent button (not the tiny mailto/tel-style line we
              show for the others) because it's something Sandra et al
              click into constantly to check their public-facing
              presence. Spans the full row on every breakpoint. */}
          {(() => {
            const fbUrl = profile.facebook_page || profile.facebook_url || profile.facebook;
            if (!fbUrl) return null;
            const display = String(fbUrl).replace(/^https?:\/\/(www\.)?/, "");
            return (
              <div className="sm:col-span-2 lg:col-span-3" data-testid="portal-my-facebook">
                <a
                  href={fbUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-center gap-4 px-4 py-4 sm:px-5 sm:py-5 rounded-2xl border border-[#1877F2]/30 bg-[#1877F2]/5 hover:bg-[#1877F2]/10 transition-colors"
                  data-testid="portal-visit-my-facebook"
                >
                  <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-[#1877F2] flex items-center justify-center shrink-0 shadow-sm">
                    <Facebook className="w-6 h-6 sm:w-7 sm:h-7 text-white fill-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] sm:text-[11px] uppercase tracking-[0.2em] font-bold text-[#1877F2]">
                      My Mojo Facebook page
                    </div>
                    <div className="text-sm sm:text-base text-stone-900 font-medium truncate">{display}</div>
                  </div>
                  <div className="hidden sm:flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#1877F2] text-white text-xs font-bold uppercase tracking-wider group-hover:bg-[#1666d4] transition-colors">
                    Visit My Mojo Facebook Page
                  </div>
                  <div className="sm:hidden px-3 py-2 rounded-lg bg-[#1877F2] text-white text-[10px] font-bold uppercase tracking-wider">
                    Visit
                  </div>
                </a>
              </div>
            );
          })()}
          {/* Mojo public biography page — the franchisee's profile on
              creativemojo.com. Sits flush below the Facebook card so
              the two "public-facing me" links cluster visually. Mojo
              brand lime so it doesn't blend in with the Facebook blue. */}
          {(() => {
            const bioUrl = profile.bio_url;
            if (!bioUrl) return null;
            const display = String(bioUrl).replace(/^https?:\/\/(www\.)?/, "");
            return (
              <div className="sm:col-span-2 lg:col-span-3" data-testid="portal-my-bio">
                <a
                  href={bioUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-center gap-4 px-4 py-4 sm:px-5 sm:py-5 rounded-2xl border border-[#dddd16]/60 bg-[#dddd16]/15 hover:bg-[#dddd16]/30 transition-colors"
                  data-testid="portal-visit-my-bio"
                >
                  <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-[#dddd16] flex items-center justify-center shrink-0 shadow-sm">
                    <UserIcon className="w-6 h-6 sm:w-7 sm:h-7 text-stone-950" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] sm:text-[11px] uppercase tracking-[0.2em] font-bold text-stone-800">
                      My Mojo biography page
                    </div>
                    <div className="text-sm sm:text-base text-stone-900 font-medium truncate">{display}</div>
                  </div>
                  <div className="hidden sm:flex items-center gap-2 px-4 py-2.5 rounded-lg bg-stone-950 text-[#dddd16] text-xs font-bold uppercase tracking-wider group-hover:bg-stone-800 transition-colors">
                    Visit My Mojo Biography
                  </div>
                  <div className="sm:hidden px-3 py-2 rounded-lg bg-stone-950 text-[#dddd16] text-[10px] font-bold uppercase tracking-wider">
                    Visit
                  </div>
                </a>
              </div>
            );
          })()}
          {profile.current_contract && (
            <div className="sm:col-span-2 lg:col-span-3 mt-2 pt-4 border-t border-stone-200">
              <div className="flex items-center gap-2 mb-3">
                <FileText className="w-3.5 h-3.5 text-stone-400" />
                <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Current contract</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 sm:gap-x-6 gap-y-3">
                <Field icon={Calendar} label="Started" value={profile.current_contract.commencement_date ? new Date(profile.current_contract.commencement_date).toLocaleDateString("en-GB") : "—"} />
                <Field icon={Clock} label="Expires" value={profile.current_contract.renewal_date ? new Date(profile.current_contract.renewal_date).toLocaleDateString("en-GB") : "—"} />
                <Field icon={FileText} label="Term" value={profile.current_contract.contract_term_years ? `${profile.current_contract.contract_term_years} year${profile.current_contract.contract_term_years === 1 ? "" : "s"}` : "—"} />
              </div>
            </div>
          )}
          {addressLines.length > 0 && (
            <div className="sm:col-span-2 lg:col-span-3">
              <div className="flex items-start gap-3">
                <MapPin className="w-4 h-4 text-stone-400 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.2em] font-bold text-stone-500">Address</div>
                  <div className="text-sm sm:text-base text-stone-900 leading-relaxed">{addressLines.join(", ")}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Section: My Contracts — merged in from the old separate
          /portal/contracts tab per Paul's spec. Shows all issued /
          signed / superseded contracts and lets the franchisee accept
          any that are awaiting their acceptance. */}
      <PortalContractsSection />

      {/* Section: Your Mojo page profile — the fields shown on the
          creativemojo.co.uk map popup. Franchisee-controlled, opt-in
          per field, so private admin contact details are never
          accidentally exposed. */}
      <section
        className="bg-white border border-stone-200 rounded-2xl px-4 sm:px-6 py-5 sm:py-6"
        data-testid="portal-website-profile"
      >
        <div className="flex items-start gap-3 mb-4 pb-4 border-b border-stone-200">
          <ExternalLink className="w-6 h-6 text-stone-700 shrink-0 mt-1" />
          <div className="flex-1 min-w-0">
            <h1 className="font-display text-2xl sm:text-3xl font-black text-stone-950 tracking-tight">Your Mojo page profile</h1>
            <p className="text-sm text-stone-600 mt-1 leading-relaxed">
              These are the details prospects see when they search for you on the
              {" "}<a href="https://www.creativemojo.co.uk" target="_blank" rel="noopener noreferrer" className="text-stone-950 underline hover:text-stone-700">creativemojo.co.uk</a>{" "}
              map. Tick each item you&apos;re happy to share publicly.
              Untick anything you&apos;d like to keep private — leave those blank on the map.
            </p>
          </div>
        </div>

        <div className="space-y-5">
          {/* Read-only, checkbox-gated display fields sourced from the
              franchisee's admin record. No admin/user-account/WordPress
              fallback — if the value is blank OR the checkbox is
              unticked, the field disappears from the map popup. */}
          {(() => {
            const rawArea = (profile?.organisation || "").trim();
            const territory = rawArea.replace(/^Creative Mojo(?:\s*-)?\s+/i, "");
            const franchiseeName = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim();
            const photoUrl = (Array.isArray(profile?.photos) && profile.photos[0]?.url) || profile?.photo_url || "";
            const facebookUrl = profile?.facebook || "";
            return (
              <>
                <ReadOnlyGate
                  label="Territory name"
                  icon={Globe}
                  value={territory}
                  placeholder="Not set on your admin record"
                  toggleLabel="Show my territory name on my Mojo page"
                  checked={wpForm.show_website_territory_name}
                  onChange={(v) => setWpForm((f) => ({ ...f, show_website_territory_name: v }))}
                  testid="wp-territory"
                />
                <ReadOnlyGate
                  label="Franchisee name"
                  icon={UserIcon}
                  value={franchiseeName}
                  placeholder="Not set on your admin record"
                  toggleLabel="Show my name on my Mojo page"
                  checked={wpForm.show_website_franchisee_name}
                  onChange={(v) => setWpForm((f) => ({ ...f, show_website_franchisee_name: v }))}
                  testid="wp-franchisee-name"
                />
                <ReadOnlyGate
                  label="Profile image"
                  icon={UserIcon}
                  value={photoUrl}
                  placeholder="No photo uploaded — ask HQ to add one"
                  toggleLabel="Show my photo on my Mojo page"
                  checked={wpForm.show_website_photo}
                  onChange={(v) => setWpForm((f) => ({ ...f, show_website_photo: v }))}
                  testid="wp-photo"
                  renderValue={(url) =>
                    url ? (
                      <img
                        src={url}
                        alt="Profile"
                        className="w-16 h-16 object-cover rounded-lg border border-stone-200"
                      />
                    ) : null
                  }
                />
                <ReadOnlyGate
                  label="Facebook page"
                  icon={Facebook}
                  value={facebookUrl}
                  placeholder="Not set on your admin record"
                  toggleLabel="Show my Facebook page on my Mojo page"
                  checked={wpForm.show_website_facebook}
                  onChange={(v) => setWpForm((f) => ({ ...f, show_website_facebook: v }))}
                  testid="wp-facebook"
                />
              </>
            );
          })()}

          {/* Biography */}
          <div>
            <label className="text-[11px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-2">
              <FileText className="w-3.5 h-3.5" /> Biography
            </label>
            <textarea
              data-testid="wp-bio-input"
              value={wpForm.website_bio}
              onChange={(e) => setWpForm((f) => ({ ...f, website_bio: e.target.value }))}
              rows={6}
              maxLength={4000}
              placeholder="Introduce yourself — a short paragraph or two about you and your Creative Mojo territory. Prospects see this on the website map."
              className="mt-2 w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:border-stone-950 leading-relaxed"
            />
            <div className="flex items-center justify-between mt-1.5 flex-wrap gap-2">
              <label className="flex items-center gap-2 text-sm text-stone-800 cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="wp-bio-toggle"
                  checked={wpForm.show_website_bio}
                  onChange={(e) => setWpForm((f) => ({ ...f, show_website_bio: e.target.checked }))}
                  className="w-4 h-4 accent-emerald-600"
                />
                Use this biography on your Mojo page
              </label>
              <div className="text-[11px] text-stone-400 tabular-nums">{wpForm.website_bio.length} / 4000</div>
            </div>
          </div>

          {/* Phone */}
          <div>
            <label className="text-[11px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-2">
              <Phone className="w-3.5 h-3.5" /> Phone number
            </label>
            <input
              type="tel"
              data-testid="wp-phone-input"
              value={wpForm.website_phone}
              onChange={(e) => setWpForm((f) => ({ ...f, website_phone: e.target.value }))}
              placeholder="e.g. 07700 900123"
              className="mt-2 w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:border-stone-950"
            />
            <label className="mt-1.5 flex items-center gap-2 text-sm text-stone-800 cursor-pointer">
              <input
                type="checkbox"
                data-testid="wp-phone-toggle"
                checked={wpForm.show_website_phone}
                onChange={(e) => setWpForm((f) => ({ ...f, show_website_phone: e.target.checked }))}
                className="w-4 h-4 accent-emerald-600"
              />
              Use this phone number on your Mojo page
            </label>
          </div>

          {/* Email */}
          <div>
            <label className="text-[11px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-2">
              <Mail className="w-3.5 h-3.5" /> Email address
            </label>
            <input
              type="email"
              data-testid="wp-email-input"
              value={wpForm.website_email}
              onChange={(e) => setWpForm((f) => ({ ...f, website_email: e.target.value }))}
              placeholder="e.g. yourname@creativemojo.co.uk"
              className="mt-2 w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:border-stone-950"
            />
            <label className="mt-1.5 flex items-center gap-2 text-sm text-stone-800 cursor-pointer">
              <input
                type="checkbox"
                data-testid="wp-email-toggle"
                checked={wpForm.show_website_email}
                onChange={(e) => setWpForm((f) => ({ ...f, show_website_email: e.target.checked }))}
                className="w-4 h-4 accent-emerald-600"
              />
              Use this email address on your Mojo page
            </label>
          </div>

          {/* Save row */}
          <div className="flex items-center gap-3 pt-3 border-t border-stone-100 flex-wrap">
            <button
              type="button"
              onClick={saveWebsiteProfile}
              disabled={wpSaving}
              data-testid="wp-save"
              className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-[#dddd16] hover:bg-stone-800 rounded-lg flex items-center gap-1.5 disabled:opacity-60"
            >
              {wpSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save website profile
            </button>
            {wpSavedAt && !wpErr && !wpSaving && (
              <div className="text-xs text-emerald-800 flex items-center gap-1.5" data-testid="wp-saved-indicator">
                <CheckCircle2 className="w-3.5 h-3.5" /> Saved · {wpSavedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
              </div>
            )}
            {wpErr && (
              <div className="text-xs text-red-700 flex items-center gap-1.5" data-testid="wp-save-error">
                <AlertCircle className="w-3.5 h-3.5" /> {wpErr}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Section: My franchise documents — big heading per spec. */}
      <section className="bg-white border border-stone-200 rounded-2xl px-4 sm:px-6 py-5 sm:py-6" data-testid="portal-my-documents">
        <div className="flex items-center gap-3 mb-5 pb-4 border-b border-stone-200">
          <FolderOpen className="w-6 h-6 text-stone-700 shrink-0" />
          <h1 className="font-display text-2xl sm:text-3xl font-black text-stone-950 tracking-tight">My Own Franchise Documents</h1>
        </div>
        <FranchiseeFilesPanel franchisee={profile} lockedTab="own" hideZipAll hideRootBreadcrumb />
      </section>
    </div>
  );
}
