import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import api from "@/lib/api";
import { ArrowLeft, MapPin, Mail, Phone, Calendar, Globe, Facebook, FileText, AlertCircle } from "lucide-react";

function Label({ children }) {
  return <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-1">{children}</div>;
}

function Value({ children, mono }) {
  return <div className={`text-sm font-medium text-stone-900 ${mono ? "font-mono" : ""}`}>{children || <span className="text-stone-300">—</span>}</div>;
}

export default function FranchiseeDetailPage() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get(`/franchisees/${id}`);
        setData(data);
      } catch (e) {
        setError("Franchisee not found.");
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  if (loading) return <div className="min-h-screen flex items-center justify-center text-stone-500 text-sm font-mono uppercase tracking-widest">Loading…</div>;
  if (error || !data) return (
    <div className="p-12">
      <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2 max-w-lg">
        <AlertCircle className="w-4 h-4" /> {error || "Not found"}
      </div>
      <Link to="/franchisees" className="inline-flex items-center gap-2 mt-4 text-sm text-stone-700 hover:text-stone-950">
        <ArrowLeft className="w-4 h-4" /> Back to franchisees
      </Link>
    </div>
  );

  const { franchisee: f, contracts, territories, enquiries } = data;
  const photo = f.photos?.[0]?.url;
  const fullName = [f.first_name, f.last_name].filter(Boolean).join(" ");

  return (
    <div className="min-h-screen">
      <div className="h-16 border-b border-stone-200 bg-white flex items-center px-8 sticky top-0 z-10" data-testid="topbar">
        <Link to="/franchisees" data-testid="back-button" className="flex items-center gap-2 text-sm text-stone-700 hover:text-stone-950">
          <ArrowLeft className="w-4 h-4" /> Franchisees
        </Link>
        <div className="ml-6 flex items-baseline gap-3">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">{f.franchise_number || "—"}</div>
          <h1 className="font-display font-black text-xl text-stone-950 tracking-tight" data-testid="franchisee-detail-name">{fullName || f.organisation || "—"}</h1>
          {fullName && f.organisation && (
            <span className="text-sm text-stone-500">· {f.organisation}</span>
          )}
        </div>
      </div>

      <div className="p-8 space-y-8 max-w-7xl">
        {/* Hero: Photo + key facts */}
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-px bg-stone-200 border border-stone-200">
          <div className="bg-white p-6 flex items-center justify-center">
            {photo ? (
              <img src={photo} alt={fullName} className="w-full max-w-[240px] aspect-square object-cover" />
            ) : (
              <div className="w-full max-w-[240px] aspect-square bg-stone-100 flex items-center justify-center text-4xl font-display font-black text-stone-400">
                {(f.first_name?.[0] || "?") + (f.last_name?.[0] || "")}
              </div>
            )}
          </div>
          <div className="bg-white p-6 space-y-5">
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Franchisee · {f.franchise_number}</div>
              <h2 className="font-display font-black text-3xl text-stone-950 tracking-tight mt-1">{fullName || f.organisation}</h2>
              <div className="text-sm text-stone-600 mt-1">{f.organisation}</div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-5">
              <div><Label>Mojo Email</Label><Value mono>{f.mojo_email}</Value></div>
              <div><Label>Secondary Email</Label><Value mono>{f.secondary_email}</Value></div>
              <div><Label>Mobile</Label><Value mono>{f.mobile_phone}</Value></div>
              <div><Label>Home Phone</Label><Value mono>{f.home_phone}</Value></div>
              <div>
                <Label>Mandate</Label>
                {f.mandate ? (
                  <span className="inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-[#D4FF00]/20 border border-[#D4FF00]/60 text-stone-900">
                    {Array.isArray(f.mandate) ? f.mandate[0] : f.mandate}
                  </span>
                ) : <span className="text-stone-300">—</span>}
              </div>
              <div><Label>Date Added</Label><Value mono>{f.date_added ? String(f.date_added).slice(0, 10) : null}</Value></div>
            </div>

            <div>
              <Label>Address</Label>
              <div className="text-sm text-stone-900 mt-1 leading-relaxed">
                {[f.address_street, f.city, f.county, f.postcode].filter(Boolean).join(", ") || <span className="text-stone-300">—</span>}
              </div>
            </div>

            {(f.tags && f.tags.length > 0) && (
              <div>
                <Label>Tags</Label>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {f.tags.map((t) => (
                    <span key={t} className="px-2 py-0.5 bg-stone-100 text-xs text-stone-700 font-medium">{t}</span>
                  ))}
                </div>
              </div>
            )}

            {(f.website || f.facebook) && (
              <div className="flex flex-wrap gap-4 pt-2 border-t border-stone-100 text-xs">
                {f.website && <a href={f.website.startsWith("http") ? f.website : `https://${f.website}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-stone-700 hover:text-stone-950"><Globe className="w-3 h-3" /> {f.website}</a>}
                {f.facebook && <a href={f.facebook.startsWith("http") ? f.facebook : `https://facebook.com/${f.facebook}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-stone-700 hover:text-stone-950"><Facebook className="w-3 h-3" /> {f.facebook}</a>}
              </div>
            )}

            {f.notes && (
              <div>
                <Label>Notes</Label>
                <div className="text-sm text-stone-700 mt-1 whitespace-pre-wrap leading-relaxed">{f.notes}</div>
              </div>
            )}
          </div>
        </div>

        {/* Linked contracts */}
        <div>
          <div className="flex items-baseline justify-between mb-3">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Contracts ({contracts.length})</div>
          </div>
          {contracts.length === 0 ? (
            <div className="bg-white border border-stone-200 p-6 text-center text-sm text-stone-500">No contracts linked.</div>
          ) : (
            <div className="bg-white border border-stone-200 overflow-hidden" data-testid="franchisee-contracts">
              <table className="w-full">
                <thead className="bg-[#F2F2F0] border-b border-stone-200">
                  <tr>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Ref</th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Commencement</th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Renewal</th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Term</th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Monthly Fee</th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {contracts.map((c) => (
                    <tr key={c.id} className="border-b border-stone-100 hover:bg-stone-50">
                      <td className="px-3 py-2"><Link to={`/contracts/${c.id}`} className="text-sm font-semibold text-stone-950 hover:underline">#{c.ref}</Link></td>
                      <td className="px-3 py-2 text-xs text-stone-700 font-mono">{c.commencement_date ? String(c.commencement_date).slice(0, 10) : "—"}</td>
                      <td className="px-3 py-2 text-xs text-stone-700 font-mono">{c.renewal_date ? String(c.renewal_date).slice(0, 10) : "—"}</td>
                      <td className="px-3 py-2 text-xs text-stone-700">{c.contract_term_years ? `${c.contract_term_years} yrs` : "—"}</td>
                      <td className="px-3 py-2 text-xs text-stone-700">{c.monthly_fee != null ? `£${c.monthly_fee}` : "—"}</td>
                      <td className="px-3 py-2">
                        {c.cancelled_early ? <span className="text-xs text-red-700 font-bold uppercase">Cancelled</span> : <span className="text-xs text-emerald-700 font-bold uppercase">{c.staying_leaving || "Active"}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Territories */}
        <div>
          <div className="flex items-baseline justify-between mb-3">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Territory · Postcode Sectors ({territories.length})</div>
          </div>
          {territories.length === 0 ? (
            <div className="bg-white border border-stone-200 p-6 text-center text-sm text-stone-500">No territory assigned.</div>
          ) : (
            <div className="bg-white border border-stone-200 p-4 flex flex-wrap gap-1.5" data-testid="franchisee-territories">
              {territories.map((t) => (
                <span key={t.id} className="px-2 py-0.5 bg-stone-100 text-xs text-stone-800 font-mono">{t.postcode}</span>
              ))}
            </div>
          )}
        </div>

        {/* Enquiries that became them */}
        {enquiries.length > 0 && (
          <div>
            <div className="flex items-baseline justify-between mb-3">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Original Enquiry ({enquiries.length})</div>
            </div>
            <div className="bg-white border border-stone-200 divide-y divide-stone-100" data-testid="franchisee-enquiries">
              {enquiries.map((e) => (
                <div key={e.id} className="p-4">
                  <div className="text-xs text-stone-500 font-mono">{e.date ? String(e.date).slice(0, 10) : ""}</div>
                  <div className="text-sm text-stone-900 mt-1">{e.why_contacting || e.message || "—"}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
