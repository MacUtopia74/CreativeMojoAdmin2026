// Portal — Marketing module (Plus add-on, subscription-gated).
//
// This is a placeholder shell so the sidebar item resolves to a real
// page during demos. The actual feature build (campaign templates,
// social-asset library, social-post composer, etc.) will land in a
// follow-up phase. For now we render a friendly "Coming soon" hero so
// the franchisee can see the page exists and the admin can demo the
// nav item.
import { Megaphone, Sparkles } from "lucide-react";

export default function PortalMarketingPage() {
  return (
    <div className="space-y-5" data-testid="portal-marketing-page">
      <div className="bg-[#dddd16] rounded-2xl px-5 sm:px-8 py-5 sm:py-7 flex items-center gap-4">
        <Megaphone className="w-7 h-7 sm:w-8 sm:h-8 text-stone-950 shrink-0" strokeWidth={2.2} />
        <h1 className="font-display text-2xl sm:text-4xl font-black text-stone-950 tracking-tight">
          Marketing
        </h1>
      </div>
      <div className="bg-white border border-stone-200 rounded-2xl px-6 py-10 sm:py-14 text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-stone-100 mb-4">
          <Sparkles className="w-7 h-7 text-stone-700" />
        </div>
        <h2 className="font-display text-2xl sm:text-3xl font-black text-stone-950 mb-2">
          Coming soon
        </h2>
        <p className="text-sm text-stone-600 max-w-md mx-auto leading-relaxed">
          Pre-designed social posts, local-area marketing kits, and one-click
          campaign templates — built around the Creative Mojo brand. We'll
          let you know the moment this module is live.
        </p>
      </div>
    </div>
  );
}
