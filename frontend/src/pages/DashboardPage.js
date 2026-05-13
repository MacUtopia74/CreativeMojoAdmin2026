import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import { Database, AlertCircle, RefreshCw, Calendar, Users, FileText, Contact, MapPin } from "lucide-react";

function KPI({ label, value, hint, to, testid }) {
  const inner = (
    <>
      <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500">{label}</div>
      <div className="mt-3 font-display font-black text-4xl text-stone-950 tracking-tight">
        {value === null || value === undefined ? "—" : Number(value).toLocaleString()}
      </div>
      {hint && <div className="mt-2 text-xs text-stone-500">{hint}</div>}
    </>
  );
  return to ? (
    <Link to={to} className="bg-white border border-stone-200 p-6 block hover:bg-stone-50 transition-colors" data-testid={testid}>{inner}</Link>
  ) : (
    <div className="bg-white border border-stone-200 p-6" data-testid={testid}>{inner}</div>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState(null);
  const [anniversaries, setAnniversaries] = useState(null);
  const [error, setError] = useState("");
  const [migrating, setMigrating] = useState(false);
  const [migrateResult, setMigrateResult] = useState(null);

  const refresh = async () => {
    try {
      const { data } = await api.get("/dashboard/stats");
      setStats(data);
    } catch (e) { setError("Could not load dashboard."); }
    try {
      const { data } = await api.get("/anniversaries/today");
      setAnniversaries(data);
    } catch (e) { /* noop */ }
  };

  useEffect(() => { refresh(); }, []);

  const runMigration = async () => {
    if (!window.confirm("Re-run the Airtable migration?\n\nThis will wipe and re-import all migrated data from Airtable.")) return;
    setMigrating(true);
    setMigrateResult(null);
    try {
      const { data } = await api.post("/migration/run");
      setMigrateResult({ ok: true, counts: data.counts });
      await refresh();
    } catch (e) {
      setMigrateResult({ ok: false, error: e?.response?.data?.detail || e.message });
    } finally {
      setMigrating(false);
    }
  };

  const lastMigrated = stats?.last_migration ? new Date(stats.last_migration).toLocaleString("en-GB") : null;
  const hasData = (stats?.franchisees_migrated || 0) > 0;

  return (
    <div className="min-h-screen">
      <div className="h-16 border-b border-stone-200 bg-white flex items-center px-8 sticky top-0 z-10" data-testid="topbar">
        <div className="flex items-baseline gap-3 flex-1">
          <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-500">Overview</div>
          <h1 className="font-display font-black text-xl text-stone-950 tracking-tight">Dashboard</h1>
        </div>
        <button
          onClick={runMigration}
          disabled={migrating}
          data-testid="run-migration-button"
          className="px-4 py-2 bg-stone-950 text-white text-xs font-bold uppercase tracking-wider hover:bg-stone-800 transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${migrating ? "animate-spin" : ""}`} />
          {migrating ? "Migrating…" : (hasData ? "Re-run migration" : "Run migration")}
        </button>
      </div>

      <div className="p-8 space-y-8">
        {error && <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-2"><AlertCircle className="w-4 h-4" /> {error}</div>}

        {migrateResult && (
          <div className={`border px-4 py-3 text-sm flex items-start gap-3 ${migrateResult.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"}`}>
            {migrateResult.ok ? (
              <>
                <div>
                  <div className="font-bold">Migration complete</div>
                  <div className="text-xs mt-1 font-mono">
                    {Object.entries(migrateResult.counts).map(([k, v]) => `${k}: ${v.toLocaleString()}`).join(" · ")}
                  </div>
                </div>
              </>
            ) : <div><strong>Migration failed:</strong> {migrateResult.error}</div>}
          </div>
        )}

        {/* KPIs */}
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-3 flex items-center justify-between">
            <span>CRM Records</span>
            {lastMigrated && <span className="text-stone-400 normal-case tracking-normal font-mono">Last migrated · {lastMigrated}</span>}
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-stone-200 border border-stone-200">
            <KPI label="Franchisees" value={stats?.franchisees_migrated} hint="Source: 88 in Airtable" to="/franchisees" testid="kpi-franchisees" />
            <KPI label="Contracts" value={stats?.contracts_migrated} hint="Source: 134 in Airtable" to="/contracts" testid="kpi-contracts" />
            <KPI label="Contacts (all)" value={stats?.contacts_migrated} hint="Legacy + active enquiries" to="/contacts" testid="kpi-contacts" />
            <KPI label="Territory Postcodes" value={stats?.territories_migrated} hint="DaD postcode bridge" testid="kpi-territories" />
          </div>
        </div>

        {/* Anniversaries today */}
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-3">Today's Anniversaries</div>
          <div className="bg-white border border-stone-200 p-6" data-testid="anniversaries-card">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 bg-[#D4FF00] flex items-center justify-center shrink-0">
                <Calendar className="w-5 h-5 text-stone-950" />
              </div>
              <div className="flex-1">
                {!anniversaries ? (
                  <div className="text-sm text-stone-500">Checking…</div>
                ) : anniversaries.count === 0 ? (
                  <>
                    <div className="font-display font-bold text-lg text-stone-950">No anniversaries today</div>
                    <div className="text-xs text-stone-500 mt-1">Daily check for franchise contract anniversaries. When wired up to email (Phase 2), franchisees will get an automated message on their anniversary.</div>
                  </>
                ) : (
                  <>
                    <div className="font-display font-bold text-lg text-stone-950">{anniversaries.count} anniversar{anniversaries.count === 1 ? "y" : "ies"} today</div>
                    <ul className="mt-2 space-y-1">
                      {anniversaries.anniversaries.map(({ contract, franchisee }) => (
                        <li key={contract.id} className="text-sm text-stone-700">
                          {franchisee?.organisation || "—"} <span className="text-stone-500 font-mono text-xs">contract #{contract.ref}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="text-xs text-stone-500 mt-3">Once email is connected, these will fire automatically each morning.</div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Phase status */}
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-3">Build Status</div>
          <div className="bg-white border border-stone-200 divide-y divide-stone-200">
            <div className="p-4 flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-[#D4FF00] mt-1.5 shrink-0" />
              <div>
                <div className="text-sm font-semibold text-stone-950">Phase 1 — Admin, CRM, Airtable migration</div>
                <div className="text-xs text-stone-500 mt-0.5">Complete. {stats?.franchisees_migrated || 0} franchisees, {stats?.contracts_migrated || 0} contracts and {stats?.contacts_migrated || 0} contacts now in the CRM.</div>
              </div>
            </div>
            <div className="p-4 flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-stone-300 mt-1.5 shrink-0" />
              <div>
                <div className="text-sm font-semibold text-stone-700">Phase 1.5 — GoCardless live mandate status</div>
                <div className="text-xs text-stone-500 mt-0.5">Replace static `mandate` field with live API + webhook. Awaiting GoCardless API token.</div>
              </div>
            </div>
            <div className="p-4 flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-stone-300 mt-1.5 shrink-0" />
              <div>
                <div className="text-sm font-semibold text-stone-700">Phase 1.6 — Sales pipeline (simple)</div>
                <div className="text-xs text-stone-500 mt-0.5">Active — visit Contacts → Pipeline view to manage enquiries.</div>
              </div>
            </div>
            <div className="p-4 flex items-start gap-3">
              <div className="w-2 h-2 rounded-full bg-stone-300 mt-1.5 shrink-0" />
              <div>
                <div className="text-sm font-semibold text-stone-700">Phase 2 — WooCommerce orders</div>
                <div className="text-xs text-stone-500 mt-0.5">Live order sync + Gantt view. Up next.</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
