// Collapsible list of CQC homes inside a franchisee's territory.
//
// Used directly under the territory map on the franchisee portal dashboard.
// The map draws numbered markers (1, 2, 3…) that align with the list rows,
// so clicking a marker scrolls the list to the matching row, and clicking a
// row pans the map to the marker. Designed for read-only consumption by the
// franchisee themselves.
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, MapPin, Phone, Mail, Globe, ExternalLink, User, Calendar, Building2, Star, BedDouble, List as ListIcon } from "lucide-react";

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
  const ratingDate = home.currentRatings?.overall?.reportDate;
  const beds = Number(home.numberOfBeds) || 0;
  const phoneHref = home.mainPhoneNumber ? `tel:${String(home.mainPhoneNumber).replace(/\s+/g, "")}` : null;
  const webHref = home.website ? (home.website.startsWith("http") ? home.website : `https://${home.website}`) : null;

  return (
    <div className="border-b border-stone-200 last:border-b-0" data-testid={`home-row-${idx + 1}`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-3 hover:bg-stone-50 text-left group"
      >
        <span className="w-7 h-7 rounded-full bg-stone-950 text-white text-xs font-bold flex items-center justify-center tabular-nums shrink-0">
          {idx + 1}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-stone-950 truncate">{home.name || "—"}</div>
          <div className="text-xs text-stone-600 truncate">{home.postalAddressTownCity || home.postcode_district} · {services || "Care home"}</div>
        </div>
        {/* Bed-count pill — replaces the prior CQC rating lozenge */}
        {beds > 0 && (
          <span className="text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-md whitespace-nowrap bg-stone-100 text-stone-800 border border-stone-200">
            <BedDouble className="w-3 h-3 inline-block mr-0.5 -mt-0.5" /> {beds} beds
          </span>
        )}
        {/* Obvious "Expand details" chevron with hover ring */}
        <span className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center border transition-colors ${
          isOpen ? "bg-stone-950 text-white border-stone-950"
                 : "bg-white text-stone-700 border-stone-300 group-hover:border-stone-500 group-hover:bg-stone-100"
        }`} aria-label={isOpen ? "Collapse details" : "Show details"}>
          {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </span>
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
          <Detail icon={Star} label="CQC rating">{home.currentRatings?.overall?.rating || <span className="text-stone-400">No rating yet</span>}</Detail>
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
  // Whole-list collapse — defaults to closed so the dashboard stays scannable.
  // The franchisee opts in by clicking the obvious "Expand to show list of
  // homes" button; once opened we remember the choice for the session.
  const [listExpanded, setListExpanded] = useState(false);

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

  if (!listExpanded) {
    // Collapsed — render a single prominent CTA that doubles as a summary.
    return (
      <button
        onClick={() => setListExpanded(true)}
        data-testid="expand-homes-list"
        className="w-full flex items-center justify-between gap-3 bg-stone-950 hover:bg-stone-800 text-white rounded-2xl px-5 py-4 transition-colors group"
      >
        <span className="flex items-center gap-3 min-w-0">
          <span className="w-9 h-9 rounded-full bg-[#D4FF00] text-stone-950 flex items-center justify-center shrink-0">
            <ListIcon className="w-4 h-4" />
          </span>
          <span className="text-left min-w-0">
            <span className="block text-[10px] uppercase tracking-[0.3em] font-bold text-[#D4FF00]">CQC homes in your territory</span>
            <span className="block text-sm font-semibold truncate">
              Expand to show list of {homes.length} home{homes.length === 1 ? "" : "s"}
            </span>
          </span>
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-wider font-bold bg-white/10 group-hover:bg-white/20 px-3 py-1.5 rounded-full flex items-center gap-1.5">
          Expand <ChevronDown className="w-3.5 h-3.5" />
        </span>
      </button>
    );
  }

  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid="territory-homes-list">
      <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between gap-3 flex-wrap bg-stone-50">
        <div className="flex items-center gap-3">
          <button onClick={() => setListExpanded(false)} data-testid="collapse-homes-list"
            className="w-7 h-7 rounded-full border border-stone-300 hover:bg-white flex items-center justify-center" aria-label="Hide list">
            <ChevronDown className="w-4 h-4 text-stone-600 rotate-180" />
          </button>
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">CQC homes in your territory</div>
            <div className="text-sm text-stone-900 mt-0.5"><strong>{filtered.length}</strong>{filtered.length !== homes.length && <span className="text-stone-500"> of {homes.length}</span>} homes · click any row to expand</div>
          </div>
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
