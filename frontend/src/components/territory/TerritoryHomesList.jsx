// Collapsible list of regulated homes inside a franchisee's territory.
//
// Used directly under the territory map on the franchisee portal dashboard.
// The map draws numbered markers (1, 2, 3…) that align with the list rows,
// so clicking a marker scrolls the list to the matching row, and clicking a
// row pans the map to the marker. Designed for read-only consumption by the
// franchisee themselves.
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, MapPin, Phone, Mail, Globe, ExternalLink, User, Calendar, Building2, Star, BedDouble, List as ListIcon, Plus, Route, Edit3, Circle, CheckCircle2, Clock, X } from "lucide-react";

function formatDateGB(iso) {
  if (!iso) return null;
  try { return new Date(iso).toLocaleDateString("en-GB"); }
  catch { return iso; }
}

function HomeRow({ home, idx, isOpen, onToggle, onZoom, isMyClient, onMarkClient, onUnmarkClient, plus, lead, onSetLeadStatus, dimmed }) {
  const address = home.fullAddress
    || [home.postalAddressLine1, home.postalAddressLine2, home.postalAddressTownCity, home.postalAddressCounty, home.postalCode].filter(Boolean).join(", ");
  const services = (home.gacServiceTypes || []).map((s) => s.name).filter(Boolean).join(" · ");
  const specialisms = (home.specialisms || []).map((s) => s.name).filter(Boolean);
  const ratingDate = home.currentRatings?.overall?.reportDate;
  const beds = Number(home.numberOfBeds) || 0;
  const phoneHref = home.mainPhoneNumber ? `tel:${String(home.mainPhoneNumber).replace(/\s+/g, "")}` : null;
  const webHref = home.website ? (home.website.startsWith("http") ? home.website : `https://${home.website}`) : null;
  const emailHref = home.email ? `mailto:${home.email}` : null;

  return (
    <div
      className={`border-b border-stone-200 last:border-b-0 ${isMyClient ? "bg-[#fcfbd8]" : ""} ${dimmed ? "opacity-40" : ""}`}
      data-testid={`home-row-${idx + 1}`}
    >
      <div
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
        role="button"
        tabIndex={0}
        className={`w-full flex items-center gap-3 px-3 py-3 text-left group transition-colors cursor-pointer ${isOpen ? "" : "hover:bg-stone-50"}`}
        style={isOpen ? { backgroundColor: "#f6f6cd" } : undefined}
      >
        <span className={`w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center tabular-nums shrink-0 ${isMyClient ? "bg-[#dddd16] text-stone-950 border border-stone-950" : "bg-stone-950 text-white"}`}>
          {idx + 1}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-stone-950 truncate flex items-center gap-1.5">
            {home.name || "—"}
            {isMyClient && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded bg-[#dddd16] text-stone-950 border border-stone-950">
                <Star className="w-2.5 h-2.5 fill-current" /> My Client
              </span>
            )}
            {/* Sales-flow status badge — only for non-clients */}
            {plus && !isMyClient && lead?.status === "contacted" && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded bg-emerald-100 text-emerald-800 border border-emerald-300">
                <CheckCircle2 className="w-2.5 h-2.5" /> Contacted
              </span>
            )}
            {plus && !isMyClient && lead?.status === "follow_up" && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded bg-blue-100 text-blue-800 border border-blue-300">
                <Clock className="w-2.5 h-2.5" /> Follow up
              </span>
            )}
          </div>
          <div className="text-xs text-stone-600 truncate">{home.postalAddressTownCity || home.postcode_district} · {services || "Care home"}</div>
        </div>
        {plus && isMyClient && onUnmarkClient && (
          <button
            onClick={(e) => { e.stopPropagation(); onUnmarkClient(home); }}
            data-testid={`home-unmark-quick-${idx + 1}`}
            title="Unmark as My Client"
            className="shrink-0 p-1.5 rounded-full bg-white border border-stone-300 hover:border-red-500 hover:bg-red-50 text-stone-600 hover:text-red-700"
          >
            <Star className="w-3.5 h-3.5 fill-current text-[#dddd16]" />
          </button>
        )}
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
      </div>
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
          <div className="sm:col-span-2 flex items-center gap-2 pt-2 mt-1 border-t border-stone-200 flex-wrap">
            {/* Sales-flow status pills — only for non-client rows */}
            {plus && !isMyClient && onSetLeadStatus && (
              <LeadStatusBar idx={idx} lead={lead} onSet={onSetLeadStatus} home={home} />
            )}
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
            {/* Territory+ — Mark this regulated home as "My Client".
                Only rendered when the franchisee has Territory+ enabled
                (the parent gates ``plus`` accordingly). */}
            {plus && !isMyClient && onMarkClient && (
              <button
                onClick={(e) => { e.stopPropagation(); onMarkClient(home); }}
                data-testid={`home-mark-client-${idx + 1}`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-[#dddd16] hover:bg-stone-800 rounded-md"
              >
                <Star className="w-3 h-3" /> Mark as my client
              </button>
            )}
            {plus && isMyClient && onUnmarkClient && (
              <button
                onClick={(e) => { e.stopPropagation(); onUnmarkClient(home); }}
                data-testid={`home-unmark-client-${idx + 1}`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-white rounded-md text-stone-900"
              >
                <Star className="w-3 h-3 fill-current text-[#dddd16]" /> Unmark
              </button>
            )}
            {/* mailto: launcher — only visible when we know an email */}
            {plus && emailHref && (
              <a href={emailHref} data-testid={`home-mailto-${idx + 1}`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-white rounded-md text-stone-900">
                <Mail className="w-3 h-3" /> Email
              </a>
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

// Three-state sales-flow status bar used on non-client rows.
// Not contacted → Contacted → Follow up.
// "Follow up" opens an inline datetime popover so the franchisee can set
// a reminder. Status is purely UI/UX — never auto-promotes to My Client.
function LeadStatusBar({ idx, lead, onSet, home }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [when, setWhen] = useState(() => {
    if (lead?.follow_up_at) {
      try { return lead.follow_up_at.slice(0, 16); } catch { return ""; }
    }
    return "";
  });
  const status = lead?.status || "not_contacted";
  const isNC = status === "not_contacted";
  const isC  = status === "contacted";
  const isF  = status === "follow_up";

  const setStatus = (next, follow_up_at) => onSet?.(home, next, follow_up_at);

  // Compute follow-up urgency badge.
  let urgency = null;
  if (isF && lead?.follow_up_at) {
    const dt = new Date(lead.follow_up_at);
    if (!Number.isNaN(dt.getTime())) {
      const days = Math.round((dt.getTime() - Date.now()) / 86400000);
      if (days < 0) urgency = { text: `Overdue · ${Math.abs(days)}d`, cls: "bg-red-100 text-red-800 border-red-300" };
      else if (days === 0) urgency = { text: "Due today", cls: "bg-amber-100 text-amber-900 border-amber-300" };
      else if (days <= 3) urgency = { text: `Due in ${days}d`, cls: "bg-amber-50 text-amber-900 border-amber-200" };
      else urgency = { text: `Due ${dt.toLocaleDateString("en-GB")}`, cls: "bg-blue-50 text-blue-800 border-blue-200" };
    }
  }

  const handleFollowUpClick = () => {
    if (isF && !pickerOpen) { setPickerOpen(true); return; }
    setPickerOpen(true);
  };

  const saveFollowUp = () => {
    if (!when) return;
    // Convert datetime-local "YYYY-MM-DDTHH:mm" → ISO with seconds
    const iso = new Date(when).toISOString();
    setStatus("follow_up", iso);
    setPickerOpen(false);
  };

  const clearStatus = () => {
    setStatus("not_contacted", null);
    setPickerOpen(false);
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap mr-auto" data-testid={`lead-status-bar-${idx + 1}`}>
      <span className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mr-1">Status:</span>
      <button
        onClick={() => setStatus("not_contacted", null)}
        data-testid={`lead-status-not-contacted-${idx + 1}`}
        className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md border transition-colors ${
          isNC ? "bg-red-600 text-white border-red-700" : "bg-white border-stone-300 text-stone-700 hover:border-red-400 hover:bg-red-50"
        }`}
      >
        <Circle className={`w-3 h-3 ${isNC ? "fill-current" : ""}`} /> Not contacted
      </button>
      <button
        onClick={() => setStatus("contacted", null)}
        data-testid={`lead-status-contacted-${idx + 1}`}
        className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md border transition-colors ${
          isC ? "bg-emerald-600 text-white border-emerald-700" : "bg-white border-stone-300 text-stone-700 hover:border-emerald-400 hover:bg-emerald-50"
        }`}
      >
        <CheckCircle2 className="w-3 h-3" /> Contacted
      </button>
      <div className="relative">
        <button
          onClick={handleFollowUpClick}
          data-testid={`lead-status-follow-up-${idx + 1}`}
          className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md border transition-colors ${
            isF ? "bg-blue-600 text-white border-blue-700" : "bg-white border-stone-300 text-stone-700 hover:border-blue-400 hover:bg-blue-50"
          }`}
        >
          <Clock className="w-3 h-3" /> Follow up
        </button>
        {pickerOpen && (
          <div className="absolute left-0 top-full mt-1 z-20 bg-white border border-stone-300 rounded-lg shadow-xl p-3 w-72" data-testid={`lead-status-follow-up-picker-${idx + 1}`}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-wider font-bold text-stone-600">Remind me on</div>
              <button onClick={() => setPickerOpen(false)} className="p-0.5 text-stone-500 hover:text-stone-900">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              data-testid={`lead-status-follow-up-input-${idx + 1}`}
              className="w-full px-2 py-1.5 text-sm bg-stone-50 border border-stone-300 rounded focus:outline-none focus:border-stone-950"
            />
            <div className="flex items-center justify-end gap-2 mt-2">
              <button onClick={() => setPickerOpen(false)} className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-stone-700 hover:bg-stone-100 rounded">Cancel</button>
              <button
                onClick={saveFollowUp}
                disabled={!when}
                data-testid={`lead-status-follow-up-save-${idx + 1}`}
                className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        )}
      </div>
      {urgency && !pickerOpen && (
        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded border ${urgency.cls}`}>
          {urgency.text}
        </span>
      )}
      {!isNC && (
        <button
          onClick={clearStatus}
          data-testid={`lead-status-clear-${idx + 1}`}
          title="Reset status"
          className="p-1 text-stone-400 hover:text-stone-900 hover:bg-stone-100 rounded"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

export default function TerritoryHomesList({
  homes = [],
  onZoomHome,
  openIndex,
  onOpenChange,
  expanded,
  onExpandedChange,
  // Territory+ extras ------------------------------------------------------
  plus = false,             // enables the My Territory+ UI (Mark-as-client,
                            //   Add Client, provider buttons, etc.)
  clientHomeKeys = null,    // Set of "${source}:${home_id}" — which regulated
                            //   homes the franchisee has flagged as Mine
  customClients = [],       // custom client docs (source: "custom")
  onMarkHomeClient = null,  // (home) — fire when "Mark as my client" tapped
  onUnmarkHomeClient = null,// (home) — fire when "Unmark" tapped
  onAddClient = null,       // () — opens the add-client modal
  onEditClient = null,      // (client) — opens the edit-client modal
  onPlanRoute = null,       // () — currently a no-op (coming soon)
  providers = [],           // [{ name, count }] — for the filter buttons
  providerFilter = null,
  onProviderFilter = null,  // (providerName | null) — toggle
  // Sales-flow leads -------------------------------------------------------
  leadsByKey = null,        // Map "${source}:${home_id}" → lead doc
  onSetLeadStatus = null,   // (home, status, follow_up_at) — upsert lead
  // My Clients filter ------------------------------------------------------
  myClientsOnly = false,
  onMyClientsOnlyChange = null,
}) {
  const [internalOpen, setInternalOpen] = useState(null);
  const open = openIndex ?? internalOpen;
  const setOpen = (i) => (onOpenChange ?? setInternalOpen)(i);
  // Whole-list collapse — defaults to closed so the dashboard stays scannable.
  // The franchisee opts in by clicking the obvious "Expand to show list of
  // homes" button; once opened we remember the choice for the session.
  // Optionally controllable from the parent so clicking a map marker can
  // force-open the list and jump to the matching row.
  const [internalExpanded, setInternalExpanded] = useState(false);
  const listExpanded = expanded ?? internalExpanded;
  const setListExpanded = (v) => (onExpandedChange ?? setInternalExpanded)(v);

  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    let base = homes;
    if (providerFilter) {
      base = base.filter((h) => (h.providerName || "").toLowerCase() === providerFilter.toLowerCase());
    }
    if (q.trim()) {
      const needle = q.toLowerCase().trim();
      base = base.filter((h) =>
        (h.name || "").toLowerCase().includes(needle)
        || (h.fullAddress || h.postalAddressTownCity || "").toLowerCase().includes(needle)
        || (h.postalCode || "").toLowerCase().includes(needle)
        || (h.registrationManagerName || "").toLowerCase().includes(needle)
        || (h.providerName || "").toLowerCase().includes(needle),
      );
    }
    // In "My clients only" mode push the client rows to the top of the list
    // so dimmed non-clients sit below — the user reads their clients first.
    if (myClientsOnly && clientHomeKeys) {
      const isMine = (h) => {
        const key = h.id || h.locationId || "";
        return clientHomeKeys.has(`cqc:${key}`) || clientHomeKeys.has(`scotland:${key}`);
      };
      base = [...base].sort((a, b) => {
        const am = isMine(a) ? 0 : 1;
        const bm = isMine(b) ? 0 : 1;
        return am - bm;
      });
    }
    return base;
  }, [homes, q, providerFilter, myClientsOnly, clientHomeKeys]);

  // Treat custom clients + regulated homes as a single pool when deciding
  // whether to render the panel at all. Even with zero CQC homes, a
  // franchisee using Territory+ may have added some manual clients.
  const totalEntries = homes.length + (plus ? customClients.length : 0);

  if (!totalEntries && !plus) return null;
  if (!totalEntries && plus) {
    // Plus user with no homes AND no custom clients — still show the panel
    // so they can use "Add my own client".
  }

  if (!listExpanded) {
    // Collapsed — yellow brand-coloured CTA matching the site-wide
    // collapsible panel pattern (#dedd0a). Click anywhere to expand.
    return (
      <button
        onClick={() => setListExpanded(true)}
        data-testid="expand-homes-list"
        className="w-full flex items-center justify-between gap-3 bg-[#dedd0a] hover:brightness-95 text-stone-950 rounded-2xl px-5 py-4 transition-all group"
      >
        <span className="flex items-center gap-3 min-w-0">
          <span className="w-9 h-9 rounded-full bg-stone-950 text-[#dedd0a] flex items-center justify-center shrink-0">
            <ListIcon className="w-4 h-4" />
          </span>
          <span className="text-left min-w-0">
            <span className="block text-[10px] uppercase tracking-[0.3em] font-bold text-stone-950/70">
              {plus ? "My Clients & Homes in My Territory" : "Homes in your territory"}
            </span>
            <span className="block text-sm font-semibold truncate text-stone-950">
              {plus
                ? `Expand to show list of ${homes.length} home${homes.length === 1 ? "" : "s"}${customClients.length ? ` + ${customClients.length} of my clients` : ""}`
                : `Expand to show list of ${homes.length} home${homes.length === 1 ? "" : "s"}`}
            </span>
          </span>
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-wider font-bold bg-stone-950 text-[#dedd0a] group-hover:bg-stone-800 px-3 py-1.5 rounded-full flex items-center gap-1.5">
          Expand <ChevronDown className="w-3.5 h-3.5" />
        </span>
      </button>
    );
  }

  return (
    <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid="territory-homes-list">
      <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between gap-3 flex-wrap" style={{ backgroundColor: "#dedd0a" }}>
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-9 h-9 rounded-full bg-stone-950 text-[#dedd0a] flex items-center justify-center shrink-0">
            <ListIcon className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-950/70">
              {plus ? "My Clients & Homes in My Territory" : "Homes in your territory"}
            </div>
            <div className="text-sm text-stone-950 mt-0.5">
              <strong>{filtered.length}</strong>
              {filtered.length !== homes.length && <span className="text-stone-950/60"> of {homes.length}</span>} homes
              {plus && customClients.length > 0 && <span> · {customClients.length} of my clients</span>}
              <span className="text-stone-950/60"> · click any row to expand</span>
            </div>
          </div>
        </div>
        <button onClick={() => setListExpanded(false)} data-testid="collapse-homes-list"
          className="touch-target shrink-0 w-7 h-7 rounded-full border border-stone-950 bg-stone-950 text-[#dedd0a] hover:bg-stone-800 flex items-center justify-center" aria-label="Hide list">
          <ChevronDown className="w-3.5 h-3.5 rotate-180" />
        </button>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, town, postcode, manager…"
          data-testid="homes-search"
          className="px-3 py-2 ios-no-zoom bg-white border border-stone-950/20 rounded-lg w-full sm:w-72 focus:outline-none focus:ring-2 focus:ring-stone-950/20 focus:border-stone-950/50" />
      </div>

      {/* Territory+ toolbar — Add client, Plan a route, provider filters. */}
      {plus && (
        <div className="px-4 py-3 border-b border-stone-200 space-y-2.5 bg-white" data-testid="territory-plus-toolbar">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => onAddClient?.()}
              data-testid="t-plus-add-client"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-[#dddd16] hover:bg-stone-800 rounded-md"
            >
              <Plus className="w-3.5 h-3.5" /> Add my own client
            </button>
            <button
              onClick={(e) => e.preventDefault()}
              title="Coming soon — Open route in your phone's maps app for turn-by-turn directions."
              data-testid="t-plus-plan-route"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-[10px] font-bold uppercase tracking-wider border border-stone-300 text-stone-600 rounded-md cursor-not-allowed bg-stone-100"
            >
              <Route className="w-3.5 h-3.5" /> Plan a route
              <span className="ml-1 px-1.5 py-0.5 rounded bg-stone-200 text-stone-700 text-[9px] font-black">Soon</span>
            </button>
            <button
              onClick={() => onMyClientsOnlyChange?.(!myClientsOnly)}
              data-testid="t-plus-my-clients-only"
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-[10px] font-bold uppercase tracking-wider rounded-md border transition-colors ${
                myClientsOnly
                  ? "bg-[#dddd16] text-stone-950 border-stone-950"
                  : "bg-white border-stone-300 text-stone-700 hover:bg-stone-50 hover:border-stone-500"
              }`}
            >
              <Star className={`w-3.5 h-3.5 ${myClientsOnly ? "fill-current" : ""}`} />
              {myClientsOnly ? "Showing My Clients only" : "Show My Clients only"}
            </button>
          </div>
          {providers.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap" data-testid="t-plus-provider-filters">
              <span className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mr-1">Care groups:</span>
              {providers.map((p) => {
                const active = providerFilter === p.name;
                return (
                  <button
                    key={p.name}
                    onClick={() => onProviderFilter?.(active ? null : p.name)}
                    data-testid={`t-plus-provider-btn-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded-md border transition-colors ${
                      active
                        ? "bg-stone-950 text-white border-stone-950"
                        : "bg-white border-stone-300 text-stone-700 hover:bg-stone-100 hover:border-stone-500"
                    }`}
                  >
                    {p.name} <span className={`px-1.5 py-0.5 rounded text-[9px] ${active ? "bg-white/20 text-white" : "bg-stone-100 text-stone-600"}`}>{p.count}</span>
                  </button>
                );
              })}
              {providerFilter && (
                <button
                  onClick={() => onProviderFilter?.(null)}
                  data-testid="t-plus-provider-clear"
                  className="text-[10px] font-bold uppercase tracking-wider text-stone-500 hover:text-stone-900 underline ml-1"
                >
                  Clear
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="max-h-[520px] overflow-y-auto">
        {/* My custom clients first — they're the franchisee's data, so it
            feels right that "their stuff" sits above the public CQC list. */}
        {plus && customClients.map((c) => (
          <CustomClientRow key={c.id} client={c} onEdit={onEditClient} onZoom={onZoomHome} />
        ))}
        {filtered.map((h, i) => {
          const realIdx = homes.indexOf(h);
          const homeKey = h.id || h.locationId || "";
          const isMine = !!(clientHomeKeys && (
            clientHomeKeys.has(`cqc:${homeKey}`) ||
            clientHomeKeys.has(`scotland:${homeKey}`)
          ));
          if (myClientsOnly && !isMine) {
            // In My-Clients-only mode: still render non-clients but dim them
            // hard so the franchisee can see context without distraction.
            return (
              <HomeRow key={h.locationId || h._id || i} home={h} idx={realIdx}
                isOpen={false}
                onToggle={() => setOpen(realIdx)}
                onZoom={onZoomHome}
                isMyClient={false}
                onMarkClient={onMarkHomeClient}
                onUnmarkClient={null}
                plus={plus}
                lead={null}
                onSetLeadStatus={null}
                dimmed
              />
            );
          }
          const leadKey = `cqc:${homeKey}`;
          const altKey = `scotland:${homeKey}`;
          const lead = leadsByKey ? (leadsByKey.get(leadKey) || leadsByKey.get(altKey) || null) : null;
          return (
            <HomeRow key={h.locationId || h._id || i} home={h} idx={realIdx}
              isOpen={open === realIdx}
              onToggle={() => setOpen(open === realIdx ? null : realIdx)}
              onZoom={onZoomHome}
              isMyClient={isMine}
              onMarkClient={onMarkHomeClient}
              onUnmarkClient={onUnmarkHomeClient}
              plus={plus}
              lead={lead}
              onSetLeadStatus={onSetLeadStatus}
            />
          );
        })}
        {filtered.length === 0 && plus && customClients.length === 0 && (
          <div className="px-6 py-12 text-center text-stone-500 text-sm">
            {providerFilter
              ? `No homes match the ${providerFilter} filter.`
              : "No homes here yet. Tap “Add my own client” to plot your first one."}
          </div>
        )}
      </div>
    </div>
  );
}

function CustomClientRow({ client, onEdit, onZoom }) {
  const [open, setOpen] = useState(false);
  const emailHref = client.email ? `mailto:${client.email}` : null;
  const phoneHref = client.phone ? `tel:${String(client.phone).replace(/\s+/g, "")}` : null;
  const webHref = client.website ? (client.website.startsWith("http") ? client.website : `https://${client.website}`) : null;
  return (
    <div className="border-b border-stone-200 last:border-b-0 bg-[#fcfbd8]" data-testid={`client-row-${client.id}`}>
      <div
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
        role="button"
        tabIndex={0}
        className="w-full flex items-center gap-3 px-3 py-3 text-left group cursor-pointer"
      >
        <span className="w-7 h-7 rounded-full bg-[#dddd16] text-stone-950 border border-stone-950 text-[14px] font-black flex items-center justify-center shrink-0">★</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-stone-950 truncate flex items-center gap-1.5">
            {client.name}
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest rounded bg-stone-950 text-[#dddd16]">
              My Client
            </span>
          </div>
          <div className="text-xs text-stone-600 truncate">{client.address || client.postcode || "—"}{client.provider ? ` · ${client.provider}` : ""}</div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onEdit?.(client); }}
          className="shrink-0 text-stone-700 hover:text-stone-950 p-1.5 rounded hover:bg-white/60"
          data-testid={`client-edit-${client.id}`}
          aria-label="Edit"
        >
          <Edit3 className="w-3.5 h-3.5" />
        </button>
        <span className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center border transition-colors ${
          open ? "bg-stone-950 text-white border-stone-950"
               : "bg-white text-stone-700 border-stone-300 group-hover:border-stone-500"
        }`}>
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </span>
      </div>
      {open && (
        <div className="px-3 pb-4 pt-1 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm bg-white/70">
          <Detail icon={MapPin} label="Address">{client.address || client.postcode || "—"}</Detail>
          <Detail icon={Phone} label="Phone">
            {phoneHref ? <a href={phoneHref} className="text-stone-900 hover:underline">{client.phone}</a> : <span className="text-stone-400">—</span>}
          </Detail>
          <Detail icon={Globe} label="Website">
            {webHref ? <a href={webHref} target="_blank" rel="noreferrer" className="text-stone-900 hover:underline inline-flex items-center gap-1">{client.website} <ExternalLink className="w-3 h-3" /></a> : <span className="text-stone-400">—</span>}
          </Detail>
          <Detail icon={Mail} label="Email">
            {emailHref ? <a href={emailHref} className="text-stone-900 hover:underline">{client.email}</a> : <span className="text-stone-400">—</span>}
          </Detail>
          <Detail icon={Building2} label="Provider">{client.provider || <span className="text-stone-400">—</span>}</Detail>
          <Detail icon={User} label="Manager">{client.manager || <span className="text-stone-400">—</span>}</Detail>
          <Detail icon={Calendar} label="Latest inspection">{client.latest_inspection || <span className="text-stone-400">—</span>}</Detail>
          <Detail icon={Star} label="CQC rating">{client.cqc_rating || <span className="text-stone-400">—</span>}</Detail>
          {client.notes && (
            <div className="sm:col-span-2 px-3 py-2 bg-white border border-stone-200 rounded-lg mt-1">
              <div className="text-[10px] uppercase tracking-wider font-bold text-stone-500 mb-1">Notes</div>
              <div className="text-sm text-stone-800 whitespace-pre-wrap">{client.notes}</div>
            </div>
          )}
          <div className="sm:col-span-2 flex items-center gap-2 pt-2 mt-1 border-t border-stone-200 flex-wrap">
            <button onClick={() => onEdit?.(client)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-white rounded-md text-stone-900">
              <Edit3 className="w-3 h-3" /> Edit details
            </button>
            {client.lat != null && client.lng != null && onZoom && (
              <button onClick={() => onZoom({ ...client, latitude: client.lat, longitude: client.lng })} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-white rounded-md text-stone-900">
                <MapPin className="w-3 h-3" /> Zoom map here
              </button>
            )}
            {emailHref && (
              <a href={emailHref} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-white rounded-md text-stone-900">
                <Mail className="w-3 h-3" /> Email
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
