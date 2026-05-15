// Franchisee portal dashboard. The franchisee's "home" — shows their
// contact info, tenure, mandate status (read-only), files panel, and
// a Phase-4 placeholder for the territory map + postcode lookup.
import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import api from "@/lib/api";
import Logo from "@/components/Logo";
import FranchiseeFilesPanel from "@/components/files/FranchiseeFilesPanel";
import FranchiseeTerritoryWidget from "@/components/territory/FranchiseeTerritoryWidget";
import {
  LogOut, Phone, Mail, Globe, MapPin, Calendar, ShieldCheck, ShieldAlert,
  FolderOpen, User as UserIcon, Loader2, AlertCircle, Smartphone,
  CreditCard, Clock,
} from "lucide-react";

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

  return (
    <div className="min-h-screen bg-[#FBFAF8]" data-testid="portal-dashboard">
      {/* Top bar */}
      <header className="bg-white border-b border-stone-200">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between gap-3">
          <Logo className="h-10" />
          <div className="flex items-center gap-4">
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

            {/* Two-column grid */}
            <div className="grid lg:grid-cols-3 gap-6">
              {/* Contact info */}
              <div className="bg-white border border-stone-200 rounded-2xl p-6 lg:col-span-1" data-testid="portal-contact">
                <div className="flex items-center gap-2 mb-5">
                  <UserIcon className="w-4 h-4 text-stone-700" />
                  <span className="text-xs uppercase tracking-[0.3em] font-bold text-stone-700">Your details</span>
                </div>
                <div className="space-y-4">
                  <Field icon={Mail} label="Email" value={profile.mojo_email || profile.email} href={`mailto:${profile.mojo_email || profile.email}`} />
                  <Field icon={Phone} label="Phone" value={profile.phone} href={`tel:${profile.phone}`} />
                  <Field icon={Smartphone} label="Mobile" value={profile.mobile} href={`tel:${profile.mobile}`} />
                  <Field icon={Globe} label="Website" value={profile.website} href={profile.website} />
                  <Field icon={MapPin} label="Address" value={[profile.address, profile.city, profile.county, profile.postcode].filter(Boolean).join(", ")} />
                  <Field icon={Calendar} label="Start date" value={profile.start_date ? new Date(profile.start_date).toLocaleDateString() : null} />
                  {profile.end_date && <Field icon={Clock} label="End date" value={new Date(profile.end_date).toLocaleDateString()} />}
                </div>
              </div>

              {/* Territory widget (real Mapbox map + postcode lookup) */}
              <div className="lg:col-span-2">
                <FranchiseeTerritoryWidget />
              </div>
            </div>

            {/* Files */}
            <div className="bg-white border border-stone-200 rounded-2xl p-6" data-testid="portal-files">
              <div className="flex items-center gap-2 mb-5">
                <FolderOpen className="w-4 h-4 text-stone-700" />
                <span className="text-xs uppercase tracking-[0.3em] font-bold text-stone-700">Your files</span>
              </div>
              <FranchiseeFilesPanel franchisee={profile} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
