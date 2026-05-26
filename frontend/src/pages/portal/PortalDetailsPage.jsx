// Portal — Your franchise details page.
// Contact info, contract dates, address, plus the franchisee's private R2
// document folder (their "own" files).
import { useOutletContext } from "react-router-dom";
import {
  Mail, Phone, Globe, MapPin, Calendar, Clock, Smartphone,
  User as UserIcon, FileText, FolderOpen,
} from "lucide-react";
import FranchiseeFilesPanel from "@/components/files/FranchiseeFilesPanel";

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
      <section className="bg-white border border-stone-200 rounded-2xl px-4 sm:px-6 py-5 sm:py-6">
        <div className="flex items-center gap-2 mb-4">
          <UserIcon className="w-4 h-4 text-stone-700" />
          <h1 className="text-xs uppercase tracking-[0.3em] font-bold text-stone-700">Your franchise details</h1>
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

      <section className="bg-white border border-stone-200 rounded-2xl px-4 sm:px-6 py-5 sm:py-6">
        <div className="flex items-center gap-2 mb-3">
          <FolderOpen className="w-3.5 h-3.5 text-stone-400" />
          <span className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">My franchise documents</span>
        </div>
        <FranchiseeFilesPanel franchisee={profile} lockedTab="own" />
      </section>
    </div>
  );
}
