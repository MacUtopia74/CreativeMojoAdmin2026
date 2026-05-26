// Portal — Upcoming events page. Wraps the existing PortalEventsPanel
// in always-open mode so it occupies the full content column.
import PortalEventsPanel from "@/components/portal/PortalEventsPanel";

export default function PortalEventsPage() {
  return (
    <div data-testid="portal-events-page">
      <PortalEventsPanel open={true} onToggle={() => { /* always open on dedicated route */ }} />
    </div>
  );
}
