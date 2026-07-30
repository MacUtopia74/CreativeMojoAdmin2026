// Temporary admin-only migration control for the one-off WordPress
// → website_bio backfill (2026-07-30).
//
// Wired into /admin/website-profile-audit as a self-contained card.
// Whole file is scheduled for removal once Paul confirms production is
// happy — do NOT extend this into a reusable upload facility.
import { useState } from "react";
import api from "@/lib/api";
import {
  BookText, RefreshCw, ShieldAlert, CheckCircle2, AlertTriangle,
  Loader2, Fingerprint, Info,
} from "lucide-react";

const EXPECTED_BASELINE_KEYS = [
  "wp_rows_matched", "wp_rows_unmatched",
  "to_insert", "to_overwrite", "to_preserve",
  "to_skip_short", "to_skip_placeholder",
  "to_skip_pending_manual_choice", "to_skip_blank_content",
  "manual_inclusions_to_apply",
  "manual_inclusions_skipped_no_match",
  "manual_inclusions_skipped_name_mismatch",
  "manual_inclusions_skipped_conflict",
];

export default function AdminWpBioMigrationControl() {
  const [phase, setPhase] = useState("idle"); // idle | dry | ready | applying | done | error
  const [dry, setDry] = useState(null);
  const [applied, setApplied] = useState(null);
  const [rerun, setRerun] = useState(null);
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState("");

  async function runDryRun() {
    setErr(""); setPhase("dry");
    setDry(null); setApplied(null); setRerun(null); setTyped("");
    try {
      const { data } = await api.post("/admin/wp-bio-migration/bundled-dry-run", {});
      setDry(data);
      setPhase(data?.baseline_deviation?.hard_block ? "error" : "ready");
      if (data?.baseline_deviation?.hard_block) {
        setErr(
          "Dry-run refused to proceed: baseline hard block. Inspect the deviation table below.",
        );
      }
    } catch (e) {
      setErr(e?.response?.data?.detail?.error || e?.response?.data?.detail || e.message);
      setPhase("error");
    }
  }

  async function runApply() {
    if (typed.trim() !== "PROCEED") return;
    setErr(""); setPhase("applying");
    try {
      const { data } = await api.post("/admin/wp-bio-migration/bundled-apply", {
        expected_environment: dry.environment.environment_name,
        expected_deployment_fingerprint: dry.environment.deployment_fingerprint,
        confirmation_token: dry.confirmation_token,
        typed_confirmation: "PROCEED",
      });
      setApplied(data);
      // Second run — verify idempotency.
      const [dry2, log2] = await Promise.all([
        api.post("/admin/wp-bio-migration/bundled-dry-run", {}),
        api.get("/admin/wp-bio-migration/log"),
      ]);
      setRerun({ stats: dry2.data.stats, deviation: dry2.data.baseline_deviation, log: log2.data });
      setPhase("done");
    } catch (e) {
      setErr(e?.response?.data?.detail?.error || e?.response?.data?.detail || e.message);
      setPhase("error");
    }
  }

  return (
    <div className="mt-10 border border-purple-300 bg-purple-50/40 rounded-xl p-5"
         data-testid="wp-bio-migration-control">
      <div className="flex items-start gap-3 mb-4">
        <BookText className="w-6 h-6 text-purple-700 mt-1" />
        <div className="flex-1">
          <h2 className="text-lg font-bold text-stone-900">
            One-off WordPress → biography backfill (2026-07-30)
          </h2>
          <p className="text-sm text-stone-600 mt-1 max-w-3xl">
            Temporary control. Runs the exact, checksum-verified WordPress
            export that was ratified on preview, plus the two HQ-approved
            manual biographies (Samantha Whiteman #0095 and Helen Lyons
            #0006 Option A). Once you confirm production is correct, this
            control is removed. The audit collection{" "}
            <code>website_bio_migration_log</code> is kept.
          </p>
        </div>
        {phase === "idle" && (
          <button
            onClick={runDryRun}
            className="inline-flex items-center gap-2 px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm rounded"
            data-testid="wp-bio-migration-dry-run-btn"
          >
            <RefreshCw className="h-4 w-4" /> Run dry-run
          </button>
        )}
        {phase === "dry" && (
          <div className="inline-flex items-center gap-2 text-sm text-purple-700">
            <Loader2 className="h-4 w-4 animate-spin" /> Running dry-run…
          </div>
        )}
      </div>

      {err && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 text-sm rounded flex items-start gap-2"
             data-testid="wp-bio-migration-error">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div><b>Error:</b> {JSON.stringify(err)}</div>
        </div>
      )}

      {dry && <DryRunPanel dry={dry} />}

      {phase === "ready" && (
        <ProceedGate
          dry={dry}
          typed={typed}
          setTyped={setTyped}
          onApply={runApply}
        />
      )}

      {phase === "applying" && (
        <div className="mt-4 p-4 bg-amber-50 border border-amber-200 text-amber-900 text-sm rounded flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Applying the migration to <b>{dry?.environment?.environment_name}</b>. Do not refresh.
        </div>
      )}

      {applied && <ResultPanel applied={applied} rerun={rerun} />}
    </div>
  );
}

// ---------- sub-panels ------------------------------------------------------

function DryRunPanel({ dry }) {
  const dev = dry.baseline_deviation || {};
  return (
    <div className="grid gap-4 mt-4" data-testid="wp-bio-migration-dry-panel">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <FactCard label="Environment"
                  value={dry.environment.environment_name}
                  hint={dry.environment.deployment_id} />
        <FactCard label="Deployment fingerprint"
                  value={dry.environment.deployment_fingerprint?.slice(0, 20) + "…"}
                  hint={<>SHA-256 CSV: <code>{dry.csv_sha256.slice(0, 24)}…</code></>}
                  icon={<Fingerprint className="h-4 w-4" />} />
      </div>

      <div>
        <h3 className="text-sm font-bold text-stone-900 mb-2">Plan totals vs preview baseline</h3>
        <table className="w-full text-sm border border-stone-200 rounded">
          <thead className="bg-stone-100 text-stone-700">
            <tr>
              <th className="text-left px-3 py-2">Metric</th>
              <th className="text-right px-3 py-2">Preview baseline</th>
              <th className="text-right px-3 py-2">This run</th>
              <th className="text-center px-3 py-2">Match</th>
            </tr>
          </thead>
          <tbody>
            {(dev.rows || []).map((r) => (
              <tr key={r.metric} className="border-t border-stone-100">
                <td className="px-3 py-1.5 font-mono text-xs">{r.metric}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.expected}</td>
                <td className="px-3 py-1.5 text-right tabular-nums font-bold">{r.actual}</td>
                <td className="px-3 py-1.5 text-center">
                  {r.matches ? <CheckCircle2 className="inline h-4 w-4 text-emerald-600" />
                             : <AlertTriangle className="inline h-4 w-4 text-amber-600" />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <FactCard label="Samantha Whiteman #0095"
                  value={dev.samantha_0095_writes ? "Will be written" : "NOT queued"}
                  tone={dev.samantha_0095_writes ? "ok" : "danger"} />
        <FactCard label="Helen Lyons #0006 Option A"
                  value={dev.helen_0006_option_A_writes ? "Will be written" : "NOT queued"}
                  tone={dev.helen_0006_option_A_writes ? "ok" : "danger"} />
        <FactCard label="Anita Priest #0030 overwrite"
                  value={dev.anita_0030_overwrite_queued ? "Queued (approved)" : "NOT queued"}
                  tone={dev.anita_0030_overwrite_queued ? "ok" : "danger"} />
      </div>

      <details className="bg-white border border-stone-200 rounded p-3">
        <summary className="cursor-pointer text-sm font-bold text-stone-900">
          Per-franchisee action list ({dry.actions_preview.length}{" "}
          {dry.actions_preview.length === 1 ? "row" : "rows"})
        </summary>
        <div className="overflow-x-auto mt-2 max-h-96 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-stone-50 sticky top-0"><tr>
              <th className="text-left px-2 py-1">#</th>
              <th className="text-left px-2 py-1">Name</th>
              <th className="text-left px-2 py-1">Action</th>
              <th className="text-right px-2 py-1">Chars</th>
              <th className="text-left px-2 py-1">Note</th>
            </tr></thead>
            <tbody>
              {dry.actions_preview.map((a, i) => (
                <tr key={i} className="border-t border-stone-100">
                  <td className="px-2 py-1 font-mono">{a.franchise_number || "—"}</td>
                  <td className="px-2 py-1">{a.name || "—"}</td>
                  <td className={`px-2 py-1 font-mono ${
                    a.action.startsWith("inserted") ? "text-emerald-700"
                    : a.action === "overwrote_approved" ? "text-amber-700"
                    : a.action === "preserved_existing" ? "text-stone-500"
                    : "text-red-700"}`}>{a.action}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{a.chars}</td>
                  <td className="px-2 py-1 text-stone-500">{(a.note || "").slice(0, 80)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function ProceedGate({ dry, typed, setTyped, onApply }) {
  const ok = typed.trim() === "PROCEED";
  return (
    <div className="mt-4 p-4 border border-amber-300 bg-amber-50 rounded"
         data-testid="wp-bio-migration-proceed-gate">
      <div className="flex items-start gap-2">
        <Info className="h-5 w-5 text-amber-700 mt-0.5" />
        <div className="flex-1">
          <div className="text-sm text-amber-900 font-bold">
            Dry-run passed. Apply the migration to&nbsp;
            <b>{dry.environment.environment_name}</b>?
          </div>
          <div className="text-xs text-amber-800 mt-1">
            Type <code className="font-mono font-bold">PROCEED</code> below to
            release the confirmation gate. This runs once (idempotent). A
            second automatic dry-run will follow to confirm no further writes.
          </div>
          <div className="mt-3 flex items-center gap-2">
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Type PROCEED"
              className="flex-1 max-w-xs border border-amber-400 rounded px-3 py-2 text-sm font-mono bg-white"
              data-testid="wp-bio-migration-proceed-input"
            />
            <button
              onClick={onApply}
              disabled={!ok}
              className={`inline-flex items-center gap-2 px-4 py-2 text-sm rounded ${
                ok
                  ? "bg-red-600 hover:bg-red-700 text-white"
                  : "bg-stone-200 text-stone-400 cursor-not-allowed"}`}
              data-testid="wp-bio-migration-apply-btn"
            >
              <ShieldAlert className="h-4 w-4" /> Run migration now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ResultPanel({ applied, rerun }) {
  const noRewrites = rerun && rerun.stats
    && rerun.deviation && !rerun.deviation.hard_block
    && (rerun.stats.to_insert === 0)
    && (rerun.stats.to_overwrite === 0
        || (applied?.results?.overwrote_approved === 1 && rerun.stats.to_overwrite === 1))
    && (rerun.stats.manual_inclusions_to_apply === 0);
  return (
    <div className="mt-6 grid gap-4" data-testid="wp-bio-migration-result">
      <div className="p-4 bg-emerald-50 border border-emerald-300 rounded">
        <div className="text-sm font-bold text-emerald-900 flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5" /> Migration applied to&nbsp;
          <b>{applied.environment.environment_name}</b>
        </div>
        <div className="text-xs text-emerald-800 mt-1">
          Script: <code>{applied.script_version}</code>{" "}
          · CSV md5: <code>{applied.csv_md5}</code>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-bold text-stone-900 mb-2">Apply results</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {Object.entries(applied.results).map(([k, v]) => (
            <div key={k} className="border border-stone-200 rounded px-3 py-2 bg-white">
              <div className="text-[10px] uppercase tracking-wide text-stone-500 font-mono">{k}</div>
              <div className="text-xl font-bold tabular-nums">{v}</div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-bold text-stone-900 mb-2">Applied rows</h3>
        <div className="overflow-x-auto max-h-72 overflow-y-auto border border-stone-200 rounded">
          <table className="w-full text-xs">
            <thead className="bg-stone-50 sticky top-0"><tr>
              <th className="text-left px-2 py-1">#</th>
              <th className="text-left px-2 py-1">Name</th>
              <th className="text-left px-2 py-1">Action</th>
              <th className="text-right px-2 py-1">Chars</th>
            </tr></thead>
            <tbody>
              {applied.applied_rows.map((r, i) => (
                <tr key={i} className="border-t border-stone-100">
                  <td className="px-2 py-1 font-mono">{r.franchise_number}</td>
                  <td className="px-2 py-1">{r.name}</td>
                  <td className="px-2 py-1 font-mono text-emerald-700">{r.action}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{r.chars}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {rerun && (
        <div className={`p-4 rounded border ${
          noRewrites
            ? "bg-emerald-50 border-emerald-300"
            : "bg-amber-50 border-amber-300"}`}
             data-testid="wp-bio-migration-rerun-check">
          <div className="text-sm font-bold flex items-center gap-2">
            {noRewrites
              ? <><CheckCircle2 className="h-5 w-5 text-emerald-700" /> Idempotent re-run confirmed — 0 further writes.</>
              : <><AlertTriangle className="h-5 w-5 text-amber-700" /> Re-run would still write something. Inspect below.</>}
          </div>
          <div className="text-xs mt-2 grid grid-cols-2 md:grid-cols-4 gap-2">
            {EXPECTED_BASELINE_KEYS.map((k) => (
              <div key={k} className="bg-white/60 border border-stone-200 rounded px-2 py-1">
                <div className="text-[10px] uppercase tracking-wide text-stone-500 font-mono">{k}</div>
                <div className="text-base font-bold tabular-nums">{rerun.stats[k]}</div>
              </div>
            ))}
          </div>
          <div className="text-xs text-stone-600 mt-2">
            Durable audit log now holds{" "}
            <b>{rerun.log?.total_rows ?? "?"}</b> rows across{" "}
            <b>{Object.keys(rerun.log?.by_action || {}).length}</b> action types.
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- shared ----------------------------------------------------------

function FactCard({ label, value, hint, tone, icon }) {
  const toneClass = {
    ok:     "border-emerald-300 bg-emerald-50 text-emerald-900",
    warn:   "border-amber-300 bg-amber-50 text-amber-900",
    danger: "border-red-300 bg-red-50 text-red-900",
  }[tone] || "border-stone-200 bg-white text-stone-900";
  return (
    <div className={`border rounded-lg px-3 py-2 ${toneClass}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-75 flex items-center gap-1">
        {icon}{label}
      </div>
      <div className="text-sm font-bold">{value ?? "—"}</div>
      {hint && <div className="text-[11px] opacity-70 mt-0.5">{hint}</div>}
    </div>
  );
}
