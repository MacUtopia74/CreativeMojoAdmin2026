// Portal — Territory map page.
//
// Renders either the vanilla "My Territory" view or the "My Territory+"
// view based on the route. The component itself decides the page
// heading, then delegates the actual map + list rendering to the
// shared ``FranchiseeTerritoryWidget``.
//
// Routes:
//   /portal/territory          → auto-detect (uses bolt-on / demo flag)
//   /portal/territory/basic    → demo-only: force vanilla view so the
//                                demo account can side-by-side compare
import { useOutletContext } from "react-router-dom";
import { MapPin } from "lucide-react";
import FranchiseeTerritoryWidget from "@/components/territory/FranchiseeTerritoryWidget";
import PortalPageHeading from "@/components/portal/PortalPageHeading";

export default function PortalTerritoryPage({ forceBasic = false }) {
  const { profile: data } = useOutletContext();
  if (!data) return null;
  // Marketing bolt-on flag — drives whether per-row "Send marketing
  // e-shot" shortcuts appear in MyClientsPanel. Demo tag overrides
  // because Demo franchisees get to preview every module.
  const modules = data?.profile?.portal_modules || {};
  const tags = data?.profile?.tags || [];
  const isDemo = tags.some((t) => String(t).trim().toLowerCase() === "demo");
  const marketingEnabled = !!modules.marketing || isDemo;
  const title = forceBasic ? "My Territory" : "My Territory+";
  const subtitle = forceBasic
    ? "Your exclusive postcodes and the customers and prospects within them."
    : "Plot your own clients, mark existing customers, and filter by care group.";
  return (
    <div className="space-y-5" data-testid="portal-territory-page">
      <PortalPageHeading
        eyebrow={forceBasic ? "Your patch" : "Your patch · upgraded"}
        icon={MapPin}
        title={title}
        subtitle={subtitle}
      />
      <div className="block md:hidden">
        <FranchiseeTerritoryWidget mapHeight={420} forceBasic={forceBasic} marketingEnabled={marketingEnabled} />
      </div>
      <div className="hidden md:block">
        <FranchiseeTerritoryWidget mapHeight={720} forceBasic={forceBasic} marketingEnabled={marketingEnabled} />
      </div>
    </div>
  );
}
