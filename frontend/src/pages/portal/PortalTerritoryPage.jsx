// Portal — Territory map page. Full-screen-ish layout.
import { useOutletContext } from "react-router-dom";
import { MapPin } from "lucide-react";
import FranchiseeTerritoryWidget from "@/components/territory/FranchiseeTerritoryWidget";
import PortalPageHeading from "@/components/portal/PortalPageHeading";

export default function PortalTerritoryPage() {
  const { profile: data } = useOutletContext();
  if (!data) return null;
  return (
    <div className="space-y-5" data-testid="portal-territory-page">
      <PortalPageHeading
        eyebrow="Your patch"
        icon={MapPin}
        title="My Territory"
        subtitle="Your exclusive postcodes and the customers and prospects within them."
      />
      <div className="block md:hidden">
        <FranchiseeTerritoryWidget mapHeight={420} />
      </div>
      <div className="hidden md:block">
        <FranchiseeTerritoryWidget mapHeight={720} />
      </div>
    </div>
  );
}
