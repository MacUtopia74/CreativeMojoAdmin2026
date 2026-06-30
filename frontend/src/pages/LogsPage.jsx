// Admin → Logs page. Aggregates every admin-only audit log so HQ has
// a single place to check who's been opening updates, downloading
// files, and sending e-shots.
//
// Each panel is its own self-contained component that lazy-loads on
// first expand, so the page renders instantly.
import { ClipboardList } from "lucide-react";
import AnnouncementReadLog from "@/components/announcements/AnnouncementReadLog";
import MarketingUsageLog from "@/components/announcements/MarketingUsageLog";
import FileVaultAuditLog from "@/components/files/FileVaultAuditLog";
import LoginLog from "@/components/auth/LoginLog";
import FranchiseeLoginReport from "@/components/auth/FranchiseeLoginReport";

export default function LogsPage() {
  return (
    <div className="space-y-6" data-testid="admin-logs-page">
      <div>
        <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-1.5">
          <ClipboardList className="w-3 h-3" /> Admin audit trail
        </div>
        <h1 className="font-display text-4xl font-black text-stone-950 mt-1">Logs</h1>
        <p className="text-sm text-stone-600 mt-1 max-w-2xl">
          One place for every audit trail across the portal — who's
          opened what, who's downloading files, and what e-shots have
          gone out. Each panel loads on demand so the page stays snappy.
        </p>
      </div>

      <div className="space-y-3">
        <FranchiseeLoginReport />
        <LoginLog />
        <AnnouncementReadLog />
        <MarketingUsageLog />
        <FileVaultAuditLog />
      </div>
    </div>
  );
}
