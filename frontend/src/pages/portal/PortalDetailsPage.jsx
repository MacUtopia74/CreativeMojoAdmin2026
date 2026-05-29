// Portal — "My Franchise" page (previously /portal + /portal/details).
//
// Combines the old Home hero (photo, organisation, years, mandate
// badge) with the franchisee's contact details and their private R2
// document folder. Section headings are intentionally large per Paul's
// spec — this is the page a franchisee lands on after signing in, so
// "MY FRANCHISE DETAILS" and "MY FRANCHISE DOCUMENTS" should read
// like proper section dividers, not muted micro-labels.
import { useOutletContext } from "react-router-dom";
import {
  Mail, Phone, Globe, MapPin, Calendar, Clock, Smartphone,
  User as UserIcon, FileText, FolderOpen,
  ShieldCheck, ShieldAlert,
} from "lucide-react";
import FranchiseeFilesPanel from "@/components/files/FranchiseeFilesPanel";

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

export default function PortalDetailsPage() {
  const { profile: data } = useOutletContext();
  const profile = data?.profile;
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

      {/* Section: My franchise documents — big heading per spec. */}
      <section className="bg-white border border-stone-200 rounded-2xl px-4 sm:px-6 py-5 sm:py-6" data-testid="portal-my-documents">
        <div className="flex items-center gap-3 mb-5 pb-4 border-b border-stone-200">
          <FolderOpen className="w-6 h-6 text-stone-700 shrink-0" />
          <h1 className="font-display text-2xl sm:text-3xl font-black text-stone-950 tracking-tight">My franchise documents</h1>
        </div>
        <FranchiseeFilesPanel franchisee={profile} lockedTab="own" />
      </section>
    </div>
  );
}
