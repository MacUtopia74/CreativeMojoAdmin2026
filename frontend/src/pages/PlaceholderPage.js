import { Construction } from "lucide-react";

export default function PlaceholderPage({ title, subtitle, phase = "Phase 1", description }) {
  return (
    <div className="min-h-screen">
      <div className="h-16 border-b border-stone-200 bg-white flex items-center px-8 sticky top-0 z-10" data-testid="topbar">
        <div className="flex items-baseline gap-3">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">{phase}</div>
          <h1 className="font-display font-black text-xl text-stone-950 tracking-tight">{title}</h1>
        </div>
      </div>
      <div className="p-12">
        <div className="max-w-xl bg-white border border-stone-200 p-10 rounded-2xl" data-testid={`placeholder-${title.toLowerCase()}`}>
          <div className="w-10 h-10 bg-[#D4FF00] flex items-center justify-center mb-6 rounded-lg">
            <Construction className="w-5 h-5 text-stone-950" />
          </div>
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Pending Migration</div>
          <h2 className="font-display font-black text-3xl text-stone-950 tracking-tight mt-2">{subtitle || title}</h2>
          <p className="text-sm text-stone-600 leading-relaxed mt-4">
            {description || "This section will populate once the Airtable schema walkthrough is complete and data is migrated across."}
          </p>
          <a
            href="/airtable-inspector"
            className="inline-flex items-center gap-2 mt-6 px-4 py-2 bg-stone-950 text-white text-xs font-bold uppercase tracking-wider hover:bg-stone-800 transition-colors rounded-lg"
            data-testid="goto-inspector-from-placeholder"
          >
            Open Airtable Inspector
          </a>
        </div>
      </div>
    </div>
  );
}
