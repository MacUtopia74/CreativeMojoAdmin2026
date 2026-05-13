import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import api from "@/lib/api";
import { ArrowLeft, MapPin, Mail, Phone, Calendar, Globe, Facebook, AlertCircle, User, Tag, FileText, Map, MessageSquare } from "lucide-react";

function Panel({ icon: Icon, title, action, children, testid }) {
  return (
    <div className="bg-white border border-stone-200" data-testid={testid}>
      <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="w-3.5 h-3.5 text-stone-500" />}
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">{title}</div>
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function Row({ label, value, mono }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">{label}</div>
      <div className={`text-sm text-stone-900 mt-1 ${mono ? "tabular-nums" : ""}`}>
        {value || <span className="text-stone-300">—</span>}
      </div>
    </div>
  );
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
      } catch (e) { setError("Franchisee not found."); }
      finally { setLoading(false); }
    })();
  }, [id]);

  if (loading) return <div className="min-h-screen flex items-center justify-center text-stone-500 text-sm uppercase tracking-widest">Loading…</div>;
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
  const statusTag = (f.tags || []).find((t) => ["Franchisee", "EX-Franchisee", "Worldwide Licencee"].includes(t));
  const feeTag = (f.tags || []).find((t) => /£/.test(t));
  const otherTags = (f.tags || []).filter((t) => t !== statusTag && t !== feeTag);
  const statusColor = statusTag === "Franchisee" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : statusTag === "EX-Franchisee" ? "bg-stone-100 text-stone-600 border-stone-300"
    : "bg-blue-50 text-blue-700 border-blue-200";

  const activeContracts = contracts.filter((c) => !c.cancelled_early);

  return (
    <div className="min-h-screen">
      <div className="h-16 border-b border-stone-200 bg-white flex items-center px-8 sticky top-0 z-10" data-testid="topbar">
        <Link to="/franchisees" data-testid="back-button" className="flex items-center gap-2 text-sm text-stone-700 hover:text-stone-950">
          <ArrowLeft className="w-4 h-4" /> Franchisees
        </Link>
        <div className="ml-6 flex items-baseline gap-3">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">{f.franchise_number || "—"}</div>
          <h1 className="font-display text-xl text-stone-950" data-testid="franchisee-detail-name">{fullName || f.organisation || "—"}</h1>
          {fullName && f.organisation && <span className="text-sm text-stone-500">· {f.organisation}</span>}
        </div>
      </div>

      <div className="p-8 max-w-[1400px] space-y-6">
        {/* HERO */}
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr_auto] gap-6 items-start">
          <div>
            {photo ? (
              <img src={photo} alt={fullName} className="w-full aspect-square object-cover border border-stone-200" />
            ) : (
              <div className="w-full aspect-square bg-stone-100 border border-stone-200 flex items-center justify-center text-5xl font-display text-stone-400">
                {(f.first_name?.[0] || "?") + (f.last_name?.[0] || "")}
              </div>
            )}
          </div>
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              {statusTag && <span className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border ${statusColor}`}>{statusTag}</span>}
              {feeTag && <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-[#D4FF00]/15 border border-[#D4FF00]/60 text-stone-900">{feeTag}</span>}
              <span className="text-xs text-stone-500">Franchise #{f.franchise_number}</span>
            </div>
            <div>
              <h2 className="font-display text-4xl text-stone-950">{fullName || f.organisation}</h2>
              {f.organisation && fullName && <div className="text-base text-stone-600 mt-1">{f.organisation}</div>}
            </div>
            <div className="text-sm text-stone-700 flex items-center gap-1.5">
              <MapPin className="w-3.5 h-3.5 text-stone-400" />
              {[f.city, f.county, f.postcode].filter(Boolean).join(" · ") || "—"}
            </div>
            {otherTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {otherTags.map((t) => <span key={t} className="px-2 py-0.5 bg-stone-100 text-xs text-stone-700">{t}</span>)}
              </div>
            )}
          </div>
          {/* Quick stats */}
          <div className="grid grid-cols-3 gap-px bg-stone-200 border border-stone-200 lg:min-w-[420px]">
            <div className="bg-white p-4">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Contracts</div>
              <div className="font-display text-2xl text-stone-950 mt-1">{contracts.length}</div>
              <div className="text-xs text-stone-500 mt-0.5">{activeContracts.length} active</div>
            </div>
            <div className="bg-white p-4">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Territory</div>
              <div className="font-display text-2xl text-stone-950 mt-1">{territories.length}</div>
              <div className="text-xs text-stone-500 mt-0.5">postcode sectors</div>
            </div>
            <div className="bg-white p-4">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Mandate</div>
              <div className="font-display text-2xl text-stone-950 mt-1 truncate">
                {f.mandate ? (Array.isArray(f.mandate) ? f.mandate[0] : f.mandate).slice(0, 8) : "—"}
              </div>
              <div className="text-xs text-stone-500 mt-0.5">live in Phase 1.5</div>
            </div>
          </div>
        </div>

        {/* PANELS GRID */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Panel icon={User} title="Contact Details" testid="panel-contact">
            <div className="grid grid-cols-2 gap-5">
              <Row label="Mojo Email" value={f.mojo_email ? <a href={`mailto:${f.mojo_email}`} className="hover:underline">{f.mojo_email}</a> : null} mono />
              <Row label="Secondary Email" value={f.secondary_email} mono />
              <Row label="Mobile Phone" value={f.mobile_phone} mono />
              <Row label="Home Phone" value={f.home_phone} mono />
            </div>
            {(f.website || f.facebook) && (
              <div className="flex flex-wrap gap-4 pt-4 mt-4 border-t border-stone-100 text-xs">
                {f.website && <a href={f.website.startsWith("http") ? f.website : `https://${f.website}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-stone-700 hover:text-stone-950"><Globe className="w-3 h-3" /> {f.website}</a>}
                {f.facebook && <a href={f.facebook.startsWith("http") ? f.facebook : `https://facebook.com/${f.facebook}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-stone-700 hover:text-stone-950"><Facebook className="w-3 h-3" /> {f.facebook}</a>}
              </div>
            )}
          </Panel>

          <Panel icon={MapPin} title="Address" testid="panel-address">
            <div className="text-sm text-stone-900 leading-relaxed">
              {[f.address_street, f.city, f.county, f.postcode].filter(Boolean).join(", ") || <span className="text-stone-300">No address</span>}
            </div>
            <div className="grid grid-cols-2 gap-5 mt-4 pt-4 border-t border-stone-100">
              <Row label="City" value={f.city} />
              <Row label="County" value={f.county} />
              <Row label="Postcode" value={f.postcode} mono />
              <Row label="Date Added" value={f.date_added ? String(f.date_added).slice(0, 10) : null} mono />
            </div>
          </Panel>

          {f.notes && (
            <Panel icon={MessageSquare} title="Notes" testid="panel-notes">
              <div className="text-sm text-stone-700 whitespace-pre-wrap leading-relaxed">{f.notes}</div>
            </Panel>
          )}

          {enquiries.length > 0 && (
            <Panel icon={MessageSquare} title={`Original Enquiry (${enquiries.length})`} testid="panel-enquiries">
              <div className="space-y-3">
                {enquiries.slice(0, 3).map((e) => (
                  <div key={e.id} className="text-sm">
                    <div className="text-xs text-stone-500">{e.date ? String(e.date).slice(0, 10) : ""}</div>
                    <div className="text-stone-900 mt-1">{e.why_contacting || e.message || "—"}</div>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </div>

        {/* Contracts panel - full width */}
        <Panel icon={FileText} title={`Contracts (${contracts.length})`} testid="panel-contracts">
          {contracts.length === 0 ? (
            <div className="text-sm text-stone-500 text-center py-4">No contracts.</div>
          ) : (
            <table className="w-full" data-testid="franchisee-contracts">
              <thead className="border-b border-stone-200">
                <tr>
                  <th className="text-left px-0 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Ref</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Commencement</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Renewal</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Term</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Monthly Fee</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Renewal Fee</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Status</th>
                </tr>
              </thead>
              <tbody>
                {contracts.map((c) => (
                  <tr key={c.id} className="border-b border-stone-100 last:border-0 hover:bg-stone-50">
                    <td className="px-0 py-2 text-sm font-semibold text-stone-950">#{c.ref}</td>
                    <td className="px-3 py-2 text-xs text-stone-700 tabular-nums">{c.commencement_date ? String(c.commencement_date).slice(0, 10) : "—"}</td>
                    <td className="px-3 py-2 text-xs text-stone-700 tabular-nums">{c.renewal_date ? String(c.renewal_date).slice(0, 10) : "—"}</td>
                    <td className="px-3 py-2 text-xs text-stone-700">{c.contract_term_years ? `${c.contract_term_years} yrs` : "—"}</td>
                    <td className="px-3 py-2 text-xs text-stone-700">{c.monthly_fee != null ? `£${c.monthly_fee}` : "—"}</td>
                    <td className="px-3 py-2 text-xs text-stone-700">
                      {c.renewal_fee != null ? `£${c.renewal_fee}` : "—"}
                      {c.renewal_fee_paid && <span className="ml-1 text-emerald-700 font-bold">✓</span>}
                    </td>
                    <td className="px-3 py-2">
                      {c.cancelled_early
                        ? <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-red-50 text-red-700 border border-red-200">Cancelled</span>
                        : <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-emerald-50 text-emerald-700 border border-emerald-200">{c.staying_leaving || "Active"}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        {/* Territory panel - full width */}
        <Panel icon={Map} title={`Territory · ${territories.length} postcode sector${territories.length === 1 ? "" : "s"}`} testid="panel-territory">
          {territories.length === 0 ? (
            <div className="text-sm text-stone-500 text-center py-4">No territory assigned.</div>
          ) : (
            <div className="flex flex-wrap gap-1.5" data-testid="franchisee-territories">
              {territories.map((t) => (
                <span key={t.id} className="px-2 py-0.5 bg-stone-100 text-xs text-stone-800 tabular-nums">{t.postcode}</span>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
