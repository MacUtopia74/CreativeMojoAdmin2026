// Portal — Upcoming events page. Wraps the existing PortalEventsPanel
// in always-open mode so it occupies the full content column.
import { CalendarDays } from "lucide-react";
import PortalEventsPanel from "@/components/portal/PortalEventsPanel";
import PortalPageHeading from "@/components/portal/PortalPageHeading";

export default function PortalEventsPage() {
  return (
    <div className="space-y-5" data-testid="portal-events-page">
      <PortalPageHeading
        eyebrow="Upcoming events"
        icon={CalendarDays}
        title="Calendar"
        subtitle="Training sessions, franchisee meetings, and HQ events you've been invited to."
      />
      <PortalEventsPanel open={true} onToggle={() => { /* always open on dedicated route */ }} />
    </div>
  );
}
