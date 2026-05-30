// Admin-only "Portal Modules" toggle panel — sits on the franchisee
// detail page and lets admin decide which sections of the franchisee's
// own portal they get to see.
//
// Defaults applied server-side: Map / Calendar / Files = ON,
// Invoicing = OFF. The server persists changes via
// PATCH /api/franchisees/:id/portal-modules.
//
// Why a custom on/off pill rather than a Shadcn Switch? Visual match
// with the rest of the franchisee detail page (uppercase pill style)
// + we get a focus ring + we don't add another component dependency.
import { useState } from "react";
import api from "@/lib/api";
import { toast } from "sonner";
import { Map as MapIcon, Calendar, Folder, FileText, Loader2, Sparkles, Megaphone } from "lucide-react";

const STANDARD_MODULES = [
  { key: "map",       label: "Territory Map", icon: MapIcon,  description: "View their assigned postcode sectors and homes count." },
  { key: "calendar",  label: "Calendar",      icon: Calendar, description: "Events, workshops, and training sessions." },
  { key: "files",     label: "File Vault",    icon: Folder,   description: "Brand assets, marketing materials, ops docs." },
];

// "Plus" add-ons — subscription-gated extras that unlock paid features.
const PLUS_MODULES = [
  { key: "territory_plus", label: "My Territory+", icon: MapIcon,   description: "Upgrades Territory page — plot contacts, marketing leads, area analytics. Adds the “+” suffix to the menu item." },
  { key: "marketing",      label: "Marketing",     icon: Megaphone, description: "Social-post templates, local marketing kits, campaign tools." },
  { key: "invoicing",      label: "Invoicing",     icon: FileText,  description: "Personal invoicing tool with client manager and Xero export." },
];

export default function PortalModulesPanel({ franchisee, onChanged }) {
  // Local mirror of the toggles — we optimistically update on click and
  // roll back on API failure so toggling feels instant.
  const initial = franchisee.portal_modules || {};
  const [state, setState] = useState({
    map:            initial.map            !== false, // default ON
    calendar:       initial.calendar       !== false, // default ON
    files:          initial.files          !== false, // default ON
    territory_plus: initial.territory_plus === true,  // default OFF (plus)
    marketing:      initial.marketing      === true,  // default OFF (plus)
    invoicing:      initial.invoicing      === true,  // default OFF (plus)
  });
  const [savingKey, setSavingKey] = useState(null);

  const allModules = [...STANDARD_MODULES, ...PLUS_MODULES];

  const toggle = async (key) => {
    const next = { ...state, [key]: !state[key] };
    setState(next);  // optimistic
    setSavingKey(key);
    try {
      await api.patch(`/franchisees/${franchisee.id}/portal-modules`, { [key]: next[key] });
      toast.success(`${allModules.find((m) => m.key === key).label} ${next[key] ? "enabled" : "disabled"}`);
      onChanged?.();
    } catch (e) {
      setState(state);  // rollback
      toast.error("Couldn't save toggle — try again");
      console.error("[PortalModules] toggle failed", e);
    } finally {
      setSavingKey(null);
    }
  };

  const renderRow = (m) => {
    const Icon = m.icon;
    const on = !!state[m.key];
    const saving = savingKey === m.key;
    return (
      <div key={m.key} className="flex items-center justify-between p-3 bg-stone-50 border border-stone-200 rounded-lg gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className={`p-1.5 rounded ${on ? "bg-stone-950 text-[#dddd16]" : "bg-stone-200 text-stone-500"}`}>
            <Icon className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-stone-950">{m.label}</div>
            <div className="text-[11px] text-stone-500 leading-snug">{m.description}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => toggle(m.key)}
          disabled={saving}
          data-testid={`portal-module-toggle-${m.key}`}
          aria-pressed={on}
          className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded-md transition-colors shrink-0 inline-flex items-center gap-1.5 ${
            on ? "bg-emerald-600 hover:bg-emerald-700 text-white" : "bg-stone-300 hover:bg-stone-400 text-stone-800"
          } disabled:opacity-50 disabled:cursor-wait`}>
          {saving && <Loader2 className="w-3 h-3 animate-spin" />}
          {on ? "Enabled" : "Disabled"}
        </button>
      </div>
    );
  };

  return (
    <div className="space-y-3" data-testid="portal-modules-panel">
      <p className="text-xs text-stone-600">
        Choose which portal sections this franchisee can see. Toggles apply instantly the next time they sign in or refresh.
      </p>

      <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mt-3 mb-1">Standard modules</div>
      <div className="space-y-2">{STANDARD_MODULES.map(renderRow)}</div>

      <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mt-5 mb-1 flex items-center gap-1.5">
        <Sparkles className="w-3 h-3" /> Plus add-ons <span className="text-stone-400 normal-case tracking-normal">· paid subscription</span>
      </div>
      <div className="space-y-2">{PLUS_MODULES.map(renderRow)}</div>
    </div>
  );
}
