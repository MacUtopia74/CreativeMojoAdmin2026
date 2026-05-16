// Collapsible list of CQC homes inside a franchisee's territory.
//
// Used directly under the territory map on the franchisee portal dashboard.
// The map draws numbered markers (1, 2, 3…) that align with the list rows,
// so clicking a marker scrolls the list to the matching row, and clicking a
// row pans the map to the marker. Designed for read-only consumption by the
// franchisee themselves.
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, MapPin, Phone, Mail, Globe, ExternalLink, User, Calendar, Building2, Star } from "lucide-react";

function formatDateGB(iso) {
  if (!iso) return null;
  try { return new Date(iso).toLocaleDateString("en-GB"); }
  catch { return iso; }
}

function HomeRow({ home, idx, isOpen, onToggle, onZoom }) {
  const address = home.fullAddress
    || [home.postalAddressLine1, home.postalAddressLine2, home.postalAddressTownCity, home.postalAddressCounty, home.postalCode].filter(Boolean).join(", ");
  const services = (home.gacServiceTypes || []).map((s) => s.name).filter(Boolean).join(" · ");
  const specialisms = (home.specialisms || []).map((s) => s.name).filter(Boolean);
  const rating = home.currentRatings?.overall?.rating;
  const ratingDate = home.currentRatings?.overall?.reportDate;
  const phoneHref = home.mainPhoneNumber ? `tel:${String(home.mainPhoneNumber).replace(/\s+/g, "")}` : null;
  const webHref = home.website ? (home.website.startsWith("http") ? home.website : `https://${home.website}`) : null;

  return (
    <div className="border-b border-stone-200 last:border-b-0" data-testid={`home-row-${idx + 1}`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-3 hover:bg-stone-50 text-left"
      >
        <span className="w-7 h-7 rounded-full bg-stone-950 text-white text-xs font-bold flex items-center justify-center tabular-nums shrink-0">
          {idx + 1}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-stone-950 truncate">{home.name || "—"}</div>
          <div className="text-xs text-stone-600 truncate">{home.postalAddressTownCity || home.postcode_district} · {services || "Care home"}</div>
        </div>
        {rating && (
          <span
            className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-md whitespace-nowrap ${
              rating === "Outstanding" ? "bg-emerald-100 text-emerald-900"
                : rating === "Good" ? "bg-lime-100 text-lime-900"
                : rating === "Requires improvement" ? "bg-amber-100 text-amber-900"
                : rating === "Inadequate" ? "bg-red-100 text-red-900"
                : "bg-stone-100 text-stone-700"
            }`}
          >
            <Star className="w-2.5 h-2.5 inline-block mr-0.5 -mt-0.5" /> {rating}
          </span>
        )}
        {isOpen ? <ChevronDown className="w-4 h-4 text-stone-500" /> : <ChevronRight className="w-4 h-4 text-stone-400" />}
      </button>
      {isOpen && (
        <div className="px-3 pb-4 pt-1 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm bg-stone-50" data-testid={`home-detail-${idx + 1}`}>
          <Detail icon={MapPin} label="Address">{address || "—"}</Detail>
          <Detail icon={User} label="Manager">{home.registrationManagerName || <span className="text-stone-400">Not on file</span>}</Detail>
          <Detail icon={Phone} label="Phone">
            {phoneHref ? <a href={phoneHref} className="text-stone-900 hover:underline">{home.mainPhoneNumber}</a> : <span className="text-stone-400">Not on file</span>}
          </Detail>
          <Detail icon={Mail} label="Email">
            <span className="text-stone-400">Not published on CQC</span>
          </Detail>
          <Detail icon={Globe} label="Website">
            {webHref ? <a href={webHref} target="_blank" rel="noreferrer" className="text-stone-900 hover:underline inline-flex items-center gap-1">{home.website} <ExternalLink className="w-3 h-3" /></a> : <span className="text-stone-400">Not on file</span>}
          </Detail>
          <Detail icon={Calendar} label="Latest inspection">{formatDateGB(home.lastInspection?.date) || formatDateGB(ratingDate) || <span className="text-stone-400">No inspection on record</span>}</Detail>
          <Detail icon={Building2} label="Provider">{home.providerName || home.providerId || "—"}</Detail>
          <Detail icon={Star} label="Beds">{home.numberOfBeds || "—"}</Detail>
          {specialisms.length > 0 && (
            <div className="sm:col-span-2 flex items-start gap-2 mt-1">
              <span className="text-[10px] uppercase tracking-wider text-stone-500 font-bold mt-1 shrink-0">Specialisms</span>
              <div className="flex flex-wrap gap-1">
                {specialisms.map((s) => (
                  <span key={s} className="px-2 py-0.5 bg-stone-200/60 text-stone-800 text-[11px] rounded-md">{s}</span>
                ))}
              </div>
            </div>
          )}
          <div className="sm:col-span-2 flex items-center gap-2 pt-2 mt-1 border-t border-stone-200">
            {home.locationURL && (
              <a href={home.locationURL} target="_blank" rel="noreferrer" data-testid={`home-cqc-link-${idx + 1}`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-white rounded-md text-stone-900">
                <ExternalLink className="w-3 h-3" /> Open CQC page
              </a>
            )}
            {home.latitude != null && home.longitude != null && onZoom && (
              <button onClick={() => onZoom(home)} data-testid={`home-zoom-${idx + 1}`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-white rounded-md text-stone-900">
                <MapPin className="w-3 h-3" /> Zoom map here
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ icon: Icon, label, children }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="w-3.5 h-3.5 text-stone-400 mt-1 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500">{label}</div>
        <div className="text-stone-900 text-sm break-words">{children}</div>
      </div>
    </div>
  );
}

export default function TerritoryHomesList({ homes = [], onZoomHome, openIndex, onOpenChange }) {
  const [internalOpen, setInternalOpen] = useState(null);
  const open = openIndex ?? internalOpen;
  const setOpen = (i) => (onOpenChange ?? setInternalOpen)(i);

  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    if (!q.trim()) return homes;
    const needle = q.toLowerCase().trim();
    return homes.filter((h) =>
      (h.name || "").toLowerCase().includes(needle)
      || (h.fullAddress || h.postalAddressTownCity || "").toLowerCase().includes(needle)
      || (h.postalCode || "").toLowerCase().includes(needle)
      || (h.registrationManagerName || "").toLowerCase().includes(needle)
      || (h.providerName || "").toLowerCase().includes(needle),
    );
  }, [homes, q]);

  if (!homes.length) return null;

  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid="territory-homes-list">
      <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between gap-3 flex-wrap bg-stone-50">
        <div>
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">CQC homes in your territory</div>
          <div className="text-sm text-stone-900 mt-0.5"><strong>{filtered.length}</strong>{filtered.length !== homes.length && <span className="text-stone-500"> of {homes.length}</span>} homes</div>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, town, postcode, manager…"
          data-testid="homes-search"
          className="px-3 py-1.5 text-sm bg-white border border-stone-200 rounded-lg w-full sm:w-72 focus:outline-none focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400" />
      </div>
      <div className="max-h-[520px] overflow-y-auto">
        {filtered.map((h, i) => {
          // Numbering follows the FULL homes list (not the filtered one)
          // so a marker labelled "12" on the map always points at the 12th
          // home — even when the search box hides the rows around it.
          const realIdx = homes.indexOf(h);
          return (
            <HomeRow key={h.locationId || h._id || i} home={h} idx={realIdx}
              isOpen={open === realIdx}
              onToggle={() => setOpen(open === realIdx ? null : realIdx)}
              onZoom={onZoomHome} />
          );
        })}
      </div>
    </div>
  );
}
