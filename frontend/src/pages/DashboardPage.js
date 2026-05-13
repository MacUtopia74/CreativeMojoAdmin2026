import { useEffect, useState } from "react";
import api from "@/lib/api";
import { Users, FileText, Contact, Database, AlertCircle } from "lucide-react";

function KPI({ label, value, hint, testid }) {
  return (
    <div className="bg-white border border-stone-200 p-6" data-testid={testid}>
      <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">{label}</div>
      <div className="mt-3 font-display font-black text-4xl text-stone-950 tracking-tight">{value}</div>
      {hint && <div className="mt-2 text-xs text-stone-500">{hint}</div>}
    </div>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/dashboard/stats");
        setStats(data);
      } catch (e) {
        setError("Could not load dashboard stats.");
      }
    })();
  }, []);

  return (
    <div className="min-h-screen">
      {/* Top bar */}
      <div className="h-16 border-b border-stone-200 bg-white flex items-center px-8 sticky top-0 z-10" data-testid="topbar">
        <div className="flex items-baseline gap-3">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">Overview</div>
          <h1 className="font-display font-black text-xl text-stone-950 tracking-tight">Dashboard</h1>
        </div>
      </div>

      <div className="p-8 space-y-8">
        {/* Phase progress banner */}
        <div className="bg-white border border-stone-200">
          <div className="p-6 border-b border-stone-200">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">Build Status</div>
                <h2 className="font-display font-black text-2xl text-stone-950 tracking-tight mt-1">Phase 1 — In Progress</h2>
              </div>
              <div className="px-3 py-1 bg-[#D4FF00]/20 border border-[#D4FF00]/60 text-xs font-bold uppercase tracking-wider text-stone-900">
                Active
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-stone-200">
            <div className="p-6">
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 rounded-full bg-[#D4FF00] mt-1.5" />
                <div>
                  <div className="text-sm font-semibold text-stone-950">Admin & Login</div>
                  <div className="text-xs text-stone-500 mt-1">Complete</div>
                </div>
              </div>
            </div>
            <div className="p-6">
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 rounded-full bg-[#D4FF00] mt-1.5 animate-pulse" />
                <div>
                  <div className="text-sm font-semibold text-stone-950">Airtable Inspector</div>
                  <div className="text-xs text-stone-500 mt-1">Ready — awaiting walkthrough</div>
                </div>
              </div>
            </div>
            <div className="p-6">
              <div className="flex items-start gap-3">
                <div className="w-2 h-2 rounded-full bg-stone-300 mt-1.5" />
                <div>
                  <div className="text-sm font-semibold text-stone-700">CRM Migration</div>
                  <div className="text-xs text-stone-500 mt-1">Pending schema decisions</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* KPIs */}
        {error && (
          <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-3">Migration Progress</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px bg-stone-200 border border-stone-200">
            <KPI label="Franchisees Migrated" value={stats?.franchisees_migrated ?? "—"} hint="Source: 88 in Airtable" testid="kpi-franchisees" />
            <KPI label="Contracts Migrated" value={stats?.contracts_migrated ?? "—"} hint="Source: 134 in Airtable" testid="kpi-contracts" />
            <KPI label="Contacts Migrated" value={stats?.contacts_migrated ?? "—"} hint="Source: 7,632 combined" testid="kpi-contacts" />
            <KPI label="Admin Users" value={stats?.users ?? "—"} hint="Active accounts" testid="kpi-users" />
          </div>
        </div>

        {/* Airtable summary */}
        {stats?.airtable && (
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-3">Airtable Source Base</div>
            <div className="bg-white border border-stone-200 p-6 flex items-center justify-between" data-testid="airtable-summary">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-stone-900 flex items-center justify-center">
                  <Database className="w-5 h-5 text-[#D4FF00]" />
                </div>
                <div>
                  <div className="font-display font-bold text-lg text-stone-950">Connected · Read-only</div>
                  <div className="text-xs text-stone-500 mt-0.5">
                    {stats.airtable.tables} tables · {stats.airtable.total_fields} fields total
                  </div>
                </div>
              </div>
              <a href="/airtable-inspector" data-testid="goto-inspector" className="px-4 py-2 bg-stone-950 text-white text-xs font-bold uppercase tracking-wider hover:bg-stone-800 transition-colors">
                Open Inspector
              </a>
            </div>
          </div>
        )}

        {/* Next actions */}
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-3">Next Steps</div>
          <div className="bg-white border border-stone-200 divide-y divide-stone-200">
            <div className="p-5 flex items-start gap-4">
              <div className="w-6 h-6 bg-[#D4FF00] flex items-center justify-center font-bold text-xs text-stone-950 shrink-0">1</div>
              <div>
                <div className="font-semibold text-stone-950">Walkthrough Airtable tables together</div>
                <div className="text-sm text-stone-600 mt-1">Open the inspector and decide which fields to keep, drop, merge or rename for each table.</div>
              </div>
            </div>
            <div className="p-5 flex items-start gap-4">
              <div className="w-6 h-6 border border-stone-300 flex items-center justify-center font-bold text-xs text-stone-600 shrink-0">2</div>
              <div>
                <div className="font-semibold text-stone-950">Migrate Franchisees, Contracts & Contacts</div>
                <div className="text-sm text-stone-600 mt-1">Once schema is locked in, run the migration into this admin's database.</div>
              </div>
            </div>
            <div className="p-5 flex items-start gap-4">
              <div className="w-6 h-6 border border-stone-300 flex items-center justify-center font-bold text-xs text-stone-600 shrink-0">3</div>
              <div>
                <div className="font-semibold text-stone-950">Hook up WordPress forms</div>
                <div className="text-sm text-stone-600 mt-1">Install the plugin to route Gravity Forms (×3) submissions directly into this admin.</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
