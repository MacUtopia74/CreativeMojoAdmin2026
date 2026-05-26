// Portal — Home / dashboard landing page. Shows the franchisee's hero
// card (photo, organisation, franchise number, years, mandate badge) plus
// a few quick stats. Detailed profile / map / events / files now live on
// their own routes.
import { useOutletContext } from "react-router-dom";
import {
  Calendar, ShieldCheck, ShieldAlert, User as UserIcon, ArrowRight,
  MapPin, CalendarDays, FolderOpen, Receipt,
} from "lucide-react";
import { Link } from "react-router-dom";

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

function QuickLink({ to, icon: Icon, title, description, testid }) {
  return (
    <Link
      to={to}
      data-testid={testid}
      className="bg-white border border-stone-200 rounded-2xl p-5 hover:border-stone-950 hover:shadow-md transition-all flex items-start gap-4 group"
    >
      <div className="w-10 h-10 rounded-xl bg-stone-100 flex items-center justify-center shrink-0 group-hover:bg-stone-950 group-hover:text-white transition-colors">
        <Icon className="w-5 h-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-stone-950">{title}</div>
        <div className="text-xs text-stone-500 mt-0.5 leading-relaxed">{description}</div>
      </div>
      <ArrowRight className="w-4 h-4 text-stone-400 mt-1 group-hover:text-stone-950 transition-colors" />
    </Link>
  );
}

export default function PortalHomePage() {
  const { profile: data } = useOutletContext();
  const profile = data?.profile;
  if (!profile) return null;
  const years = yearsBetween(profile.start_date);
  const modules = profile.portal_modules || {};

  return (
    <div className="space-y-6" data-testid="portal-home">
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

      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="portal-quick-links">
        <QuickLink to="/portal/details" icon={UserIcon} title="Your franchise details" description="Contact info, address, contract dates and your private documents."
          testid="quicklink-profile" />
        {modules.map !== false && (
          <QuickLink to="/portal/territory" icon={MapPin} title="Your territory map" description="See your assigned postcode sectors and care homes."
            testid="quicklink-territory" />
        )}
        {modules.calendar !== false && (
          <QuickLink to="/portal/events" icon={CalendarDays} title="Upcoming events" description="Group meetings, training and key franchise dates."
            testid="quicklink-events" />
        )}
        {modules.invoicing === true && (
          <QuickLink to="/portal/invoices" icon={Receipt} title="Invoicing" description="Send invoices to your clients and reconcile bank transactions."
            testid="quicklink-invoices" />
        )}
        {modules.files !== false && (
          <QuickLink to="/portal/files" icon={FolderOpen} title="Files" description="Shared brand assets, training materials and franchise files."
            testid="quicklink-files" />
        )}
      </section>
    </div>
  );
}
