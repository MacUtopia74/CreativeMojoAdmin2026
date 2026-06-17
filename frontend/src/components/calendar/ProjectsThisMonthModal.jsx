// Modal that surfaces the Woo "Standard Boxed Art Kits" for the
// month the franchisee is viewing on the calendar. Each tile carries
// the product image, name, and a single primary action — Open Project
// Guide. The guide URL resolves on the server by joining the Woo
// product to its linked Instruction PDF via shared Project Code; if
// no match yet → a friendly "Coming soon" fallback so franchisees
// know the gap is on us, not on them.
import { useEffect, useState } from "react";
import {
  X, Loader2, BookOpen, AlertCircle, FileText, ExternalLink, Link2,
} from "lucide-react";
import api from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import EditProductLinkModal from "@/components/projectcodes/EditProductLinkModal";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * @param {Object} props
 * @param {Date} props.visibleDate — any date inside the visible month;
 *   we read month/year from it. Defaults to "now" if omitted.
 * @param {() => void} props.onClose
 */
export default function ProjectsThisMonthModal({ visibleDate, onClose }) {
  const d = visibleDate || new Date();
  const month = d.getMonth() + 1;
  const year = d.getFullYear();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  // When the admin clicks "Match" on a tile we open the shared edit
  // modal (same one as the Project Codes admin page). Storing the
  // product here keeps it lazily-rendered above the month modal.
  const [matching, setMatching] = useState(null);
  // Bump after each successful save so we re-fetch the month feed and
  // the tile flips from "Coming soon" → "Open Project Guide" without
  // requiring the admin to close + reopen the modal.
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr("");
    api.get("/portal/calendar/projects", { params: { month, year } })
      .then(({ data }) => { if (!cancelled) setItems(data.items || []); })
      .catch((e) => { if (!cancelled) setErr(e?.response?.data?.detail || "Could not load projects."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [month, year, reloadTick]);

  const openGuide = async (it) => {
    if (!it.guide_url) return;
    // The endpoint returns a relative path that hits the existing
    // signed-download endpoint. Use api so the auth header flows.
    try {
      const { data } = await api.get(it.guide_url);
      const url = data?.url || data?.signed_url;
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      else setErr("Couldn't generate the download link.");
    } catch (e) {
      setErr(e?.response?.data?.detail || "Couldn't open the project guide.");
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto"
      data-testid="projects-month-modal"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="bg-white w-full max-w-5xl rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[92vh]">
        <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500 flex items-center gap-2">
              <BookOpen className="w-3 h-3" /> Projects this month
            </div>
            <h2 className="font-display text-2xl text-stone-950 mt-0.5">{MONTH_NAMES[month - 1]} {year}</h2>
          </div>
          <button
            onClick={onClose}
            data-testid="projects-month-close"
            className="w-9 h-9 rounded-full border border-stone-300 bg-white hover:bg-stone-100 flex items-center justify-center"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-5 overflow-y-auto flex-1">
          {err && (
            <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-900 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" /> {err}
            </div>
          )}
          {loading ? (
            <div className="py-16 text-center text-stone-500"><Loader2 className="w-6 h-6 animate-spin inline" /></div>
          ) : !items.length ? (
            <div className="py-16 text-center text-sm text-stone-500" data-testid="projects-month-empty">
              No projects tagged for {MONTH_NAMES[month - 1]} yet. Try a different month, or ask HQ to tag the products.
            </div>
          ) : (
            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {items.map((it) => (
                <li
                  key={it.id}
                  data-testid={`projects-month-tile-${it.id}`}
                  className="border border-stone-200 rounded-2xl overflow-hidden flex flex-col bg-white"
                >
                  <div className="aspect-[4/3] bg-stone-100 overflow-hidden">
                    {it.image_url ? (
                      <img src={it.image_url} alt={it.name} loading="lazy" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-stone-300"><FileText className="w-10 h-10" /></div>
                    )}
                  </div>
                  <div className="p-3.5 flex-1 flex flex-col gap-2">
                    <div className="font-bold text-sm text-stone-950 line-clamp-2">{it.name}</div>
                    {it.has_guide ? (
                      <button
                        onClick={() => openGuide(it)}
                        data-testid={`projects-month-open-${it.id}`}
                        className="mt-auto inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-[#dedd0a] rounded-lg"
                      >
                        <BookOpen className="w-3.5 h-3.5" /> Open Project Guide
                      </button>
                    ) : (
                      <div className="mt-auto px-3 py-2 text-xs font-bold uppercase tracking-wider text-stone-500 bg-stone-100 rounded-lg text-center" data-testid={`projects-month-coming-soon-${it.id}`}>
                        Project guide coming soon
                      </div>
                    )}
                    {it.permalink && (
                      <a
                        href={it.permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid={`projects-month-shop-${it.id}`}
                        className="text-[10px] uppercase tracking-wider text-stone-500 hover:text-stone-950 inline-flex items-center gap-1 self-start"
                      >
                        View on shop <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    {/* Admin-only Match button — opens the shared
                        EditProductLinkModal so HQ can finish linking
                        the product to an R2 instruction PDF without
                        leaving the calendar context. */}
                    {isAdmin && (
                      <button
                        onClick={() => setMatching({
                          id: it.woo_id || it.id,
                          name: it.name,
                          image: it.image_url,
                          value: it.project_code || "",
                        })}
                        data-testid={`projects-month-match-${it.id}`}
                        title={it.has_guide ? "Re-link to a different file" : "Find and link an Instruction PDF"}
                        className="text-[10px] uppercase tracking-wider font-bold text-sky-700 hover:text-sky-900 inline-flex items-center gap-1 self-start"
                      >
                        <Link2 className="w-3 h-3" /> {it.has_guide ? "Re-match" : "Match"}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {matching && (
        <EditProductLinkModal
          product={matching}
          onClose={() => setMatching(null)}
          onSaved={() => { setMatching(null); setReloadTick((t) => t + 1); }}
        />
      )}
    </div>
  );
}

// The signed-download endpoint returns ``{ url }`` — the modal opens
// the signed URL in a new tab so the browser handles PDF rendering.
