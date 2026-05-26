// Portal — Territory map page. Full-screen-ish layout.
import { useOutletContext } from "react-router-dom";
import FranchiseeTerritoryWidget from "@/components/territory/FranchiseeTerritoryWidget";

export default function PortalTerritoryPage() {
  const { profile: data } = useOutletContext();
  if (!data) return null;
  return (
    <div data-testid="portal-territory-page">
      <div className="block md:hidden">
        <FranchiseeTerritoryWidget mapHeight={420} />
      </div>
      <div className="hidden md:block">
        <FranchiseeTerritoryWidget mapHeight={720} />
      </div>
    </div>
  );
}
