// Inline pill dropdown for changing an order's production status from the
// Orders table without opening the detail page. Mirrors the Airtable-style
// chip behaviour the team is used to in the legacy admin.
//
// Why the menu uses `position: fixed` + a React portal:
// The Orders table is wrapped in `overflow-hidden` (rounded panel) and
// `overflow-x-auto` (horizontal scroll). Either would clip a normally
// positioned absolute menu — so we render the menu at the document root
// and compute coordinates from the trigger's bounding rect.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Loader2 } from "lucide-react";
import api from "@/lib/api";

// Canonical statuses the user wants surfaced in the dropdown, in order.
export const PRODUCTION_OPTIONS = [
  "Awaiting Assembly",
  "In Production",
  "Awaiting Labels",
  "Ready To Ship",
  "Complete",
];

// Tailwind classes per status — kept here so the table cell and the
// dropdown menu items render with the same colours.
export const PRODUCTION_PILL_CLASS = {
  "Awaiting Assembly": "bg-rose-600 text-white",
  "In Production":     "bg-orange-500 text-white",
  "Awaiting Labels":   "bg-teal-600 text-white",
  "Ready To Ship":     "bg-stone-900 text-white",
  "Complete":          "bg-emerald-600 text-white",
  // Legacy aliases — keep visible until we backfill the DB.
  "Completed":         "bg-emerald-600 text-white",
  "Dispatched":        "bg-emerald-600 text-white",
  "Cancelled":         "bg-stone-500 text-white",
  "Refunded":          "bg-stone-500 text-white",
  "Failed":            "bg-rose-700 text-white",
};

export default function ProductionStatusDropdown({
  orderId,
  value,
  onChange,
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [local, setLocal] = useState(value);
  const [coords, setCoords] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => { setLocal(value); }, [value]);

  // Recompute coords each time we open so the menu sticks to the trigger
  // even after a scroll-then-reopen.
  const updateCoords = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setCoords({ top: r.bottom + 4, left: r.left });
  };
  useLayoutEffect(() => { if (open) updateCoords(); }, [open]);

  // Close on outside click / escape / scroll.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (triggerRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    const onScroll = () => updateCoords();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  const pick = async (next) => {
    if (next === local) { setOpen(false); return; }
    const prev = local;
    setLocal(next);  // optimistic
    setOpen(false);
    setSaving(true);
    try {
      await api.patch(`/orders/${orderId}`, { production_status: next });
      onChange?.(next);
    } catch (e) {
      setLocal(prev);  // rollback
      alert(e?.response?.data?.detail || "Could not update production status.");
    } finally {
      setSaving(false);
    }
  };

  // Normalise alias to display label for the trigger pill
  const displayLabel = local === "Completed" ? "Complete" : (local || "—");
  const pillClass = PRODUCTION_PILL_CLASS[displayLabel] || PRODUCTION_PILL_CLASS[local] || "bg-stone-300 text-stone-800";

  const menu = open && coords ? createPortal(
    <div
      ref={menuRef}
      role="listbox"
      data-testid={`production-status-menu-${orderId}`}
      style={{ position: "fixed", top: coords.top, left: coords.left, width: 192 }}
      className="z-[100] bg-white border border-stone-200 rounded-lg shadow-2xl p-1.5 space-y-1"
      onClick={(e) => e.stopPropagation()}
    >
      {PRODUCTION_OPTIONS.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => pick(opt)}
          data-testid={`production-status-option-${orderId}-${opt.replace(/\s+/g, "-").toLowerCase()}`}
          className="w-full flex items-center hover:bg-stone-50 rounded"
        >
          <span className={`w-full px-3 py-1.5 rounded-full text-xs font-semibold text-center ${PRODUCTION_PILL_CLASS[opt]}`}>
            {opt}
          </span>
        </button>
      ))}
    </div>,
    document.body,
  ) : null;

  return (
    <span className="inline-block" onClick={(e) => e.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || saving}
        onClick={() => setOpen((o) => !o)}
        data-testid={`production-status-trigger-${orderId}`}
        className={`inline-flex items-center gap-1.5 pl-3 pr-2 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap ${pillClass} ${
          disabled ? "opacity-60 cursor-not-allowed" : "hover:opacity-90"
        }`}
        title="Change production status"
      >
        <span>{displayLabel}</span>
        {saving ? (
          <Loader2 className="w-3 h-3 animate-spin opacity-80" />
        ) : (
          <ChevronDown className="w-3 h-3 opacity-80" />
        )}
      </button>
      {menu}
    </span>
  );
}
