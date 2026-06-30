// Franchisee Activation panel — one-glance tick/cross of who in the
// 184-franchisee roster has actually logged into the portal. Joins
// franchisees ↔ users ↔ auth_logins server-side so the UI is just a
// flat list + summary.
//
// Three states per row:
//   ✓ active    — has a portal account AND has logged in
//   ⚠ invited   — has a portal account but never logged in (chase!)
//   ✗ no acct.  — no portal account created yet (HQ needs to invite)
import { useEffect, useMemo, useState } from "react";
import {
  Loader2, CheckCircle2, XCircle, AlertCircle, Users, Search,
  ChevronRight, Download, Copy, Mail,
} from "lucide-react";
import api from "@/lib/api";
import { toast } from "sonner";

export default function FranchiseeLoginReport() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all"); // all | active | invited | not_invited

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/admin/franchisees/login-status");
      setData(data);
    } finally { setLoading(false); }
  };

  useEffect(() => { if (open && !data) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const search = q.trim().toLowerCase();
    return data.items.filter((r) => {
      if (filter === "active" && !r.has_logged_in) return false;
      if (filter === "invited" && r.account_status !== "invited") return false;
      if (filter === "not_invited" && r.account_status !== "not_invited") return false;
      if (!search) return true;
      const hay = [r.first_name, r.last_name, r.organisation, r.mojo_email, r.secondary_email, r.account_email].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(search);
    });
  }, [data, q, filter]);

  const copyEmails = () => {
    const emails = filtered.map((r) => r.account_email || r.mojo_email || r.secondary_email).filter(Boolean);
    if (emails.length === 0) { toast.error("No emails to copy"); return; }
    navigator.clipboard.writeText(emails.join("; "));
    toast.success(`Copied ${emails.length} email(s) to clipboard`);
  };

  const downloadCsv = () => {
    if (!data) return;
    const rows = [["First Name", "Last Name", "Organisation", "Account Email", "Mojo Email", "Secondary Email", "Status", "Has Logged In", "Last Login", "Login Count"]];
    for (const r of filtered) {
      rows.push([
        r.first_name, r.last_name, r.organisation,
        r.account_email || "", r.mojo_email || "", r.secondary_email || "",
        r.account_status, r.has_logged_in ? "Yes" : "No",
        r.last_login_at || "",
        String(r.login_count || 0),
      ]);
    }
    const csv = rows.map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `franchisee-login-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const summary = data?.summary;

  return (
    <div className="bg-white border border-stone-200 rounded-xl overflow-hidden" data-testid="franchisee-login-report">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="login-report-toggle"
        className="w-full px-4 py-3 flex items-center justify-between gap-3 hover:bg-stone-50 transition-colors"
      >
        <div className="flex items-center gap-3 text-left">
          <Users className="w-4 h-4 text-stone-700" />
          <div>
            <div className="text-sm font-bold text-stone-950">Franchisee Activation</div>
            <div className="text-[11px] text-stone-500">Who has actually logged into the portal — green tick if yes, cross if not</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {summary && (
            <div className="hidden sm:flex items-center gap-2 text-[10px] uppercase tracking-wider font-bold">
              <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded">{summary.logged_in} active</span>
              <span className="px-2 py-0.5 bg-amber-100 text-amber-800 rounded">{summary.invited_not_yet_logged_in} invited</span>
              <span className="px-2 py-0.5 bg-stone-200 text-stone-700 rounded">{summary.not_invited} no acct</span>
            </div>
          )}
          <ChevronRight className={`w-4 h-4 text-stone-400 transition-transform ${open ? "rotate-90" : ""}`} />
        </div>
      </button>

      {open && (
        <div className="border-t border-stone-200">
          {loading ? (
            <div className="p-8 flex items-center justify-center gap-2 text-sm text-stone-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading report…
            </div>
          ) : !data ? null : (
            <>
              {/* Summary cards */}
              <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-4 gap-2 bg-stone-50 border-b border-stone-200">
                <StatCard label="Total franchisees" value={summary.total} tint="stone" />
                <StatCard label="Logged in" value={summary.logged_in} tint="emerald" icon={CheckCircle2} />
                <StatCard label="Invited · not yet" value={summary.invited_not_yet_logged_in} tint="amber" icon={AlertCircle} />
                <StatCard label="No account" value={summary.not_invited} tint="stone" icon={XCircle} />
              </div>

              {/* Filter + actions toolbar */}
              <div className="px-4 py-3 bg-white border-b border-stone-100 flex items-center gap-2 flex-wrap">
                <div className="relative flex-1 min-w-[200px] max-w-[400px]">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400 pointer-events-none" />
                  <input
                    type="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search name, organisation, email…"
                    data-testid="login-report-search"
                    className="w-full pl-8 pr-3 py-1.5 text-sm border border-stone-300 focus:border-stone-950 focus:outline-none rounded-md"
                  />
                </div>
                <div className="flex items-center bg-stone-100 rounded-md p-0.5">
                  {[
                    { k: "all", label: "All" },
                    { k: "active", label: "Logged in" },
                    { k: "invited", label: "Not yet" },
                    { k: "not_invited", label: "No account" },
                  ].map((b) => (
                    <button
                      key={b.k}
                      onClick={() => setFilter(b.k)}
                      data-testid={`login-report-filter-${b.k}`}
                      className={`px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider rounded ${filter === b.k ? "bg-white text-stone-950 shadow-sm" : "text-stone-500 hover:text-stone-900"}`}
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
                <button onClick={copyEmails}
                  data-testid="login-report-copy-emails"
                  title="Copy emails of currently-filtered rows to clipboard"
                  className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 rounded-md flex items-center gap-1.5">
                  <Copy className="w-3 h-3" /> Copy emails
                </button>
                <button onClick={downloadCsv}
                  data-testid="login-report-csv"
                  className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md flex items-center gap-1.5">
                  <Download className="w-3 h-3" /> CSV
                </button>
              </div>

              {/* The list */}
              <div className="max-h-[60vh] overflow-y-auto">
                {filtered.length === 0 ? (
                  <div className="p-8 text-center text-sm text-stone-500">No franchisees match that filter.</div>
                ) : (
                  <div className="divide-y divide-stone-100">
                    {filtered.map((r) => (
                      <Row key={r.franchisee_id} r={r} />
                    ))}
                  </div>
                )}
              </div>

              <div className="px-4 py-2 bg-stone-50 border-t border-stone-200 text-[11px] text-stone-500">
                Showing {filtered.length} of {data.items.length} franchisees.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, tint, icon: Icon }) {
  const tintClass = {
    stone: "bg-white border-stone-200 text-stone-700",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-900",
    amber: "bg-amber-50 border-amber-200 text-amber-900",
  }[tint] || "bg-white border-stone-200 text-stone-700";
  return (
    <div className={`border rounded-lg px-3 py-2 ${tintClass}`}>
      <div className="text-[9px] uppercase tracking-wider font-bold opacity-70 flex items-center gap-1">
        {Icon && <Icon className="w-3 h-3" />} {label}
      </div>
      <div className="text-2xl font-black tabular-nums">{value}</div>
    </div>
  );
}

function Row({ r }) {
  const fullName = `${r.first_name} ${r.last_name}`.trim() || "(no name)";
  const email = r.account_email || r.mojo_email || r.secondary_email;
  const mailtoSubject = "Welcome to the Mojo Hub";
  const mailtoBody = `Hi ${r.first_name || "there"},%0A%0AJust a quick nudge — we noticed you haven't yet logged into the Mojo Hub. When you have a moment, please head to https://hub.creativemojo.co.uk and use the password-reset link to set yourself up.%0A%0AThanks!`;

  return (
    <div className="px-4 py-2.5 flex items-center gap-3 hover:bg-stone-50" data-testid={`login-report-row-${r.franchisee_id}`}>
      <div className="shrink-0">
        {r.has_logged_in ? (
          <span title="Has logged in"><CheckCircle2 className="w-5 h-5 text-emerald-600" data-testid="status-active" /></span>
        ) : r.account_status === "invited" ? (
          <span title="Account exists but never logged in — chase up"><AlertCircle className="w-5 h-5 text-amber-600" data-testid="status-invited" /></span>
        ) : (
          <span title="No portal account yet"><XCircle className="w-5 h-5 text-stone-400" data-testid="status-not-invited" /></span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-stone-900 truncate">{fullName}</div>
        <div className="text-[11px] text-stone-500 truncate">{r.organisation || "—"}</div>
      </div>
      <div className="hidden sm:block text-[11px] text-stone-600 truncate max-w-[220px]" title={email || ""}>
        {email || <span className="italic text-stone-400">no email on file</span>}
      </div>
      <div className="hidden md:block text-[11px] text-stone-500 tabular-nums w-32 text-right">
        {r.has_logged_in
          ? new Date(r.last_login_at).toLocaleDateString("en-GB")
          : <span className="italic">never</span>}
      </div>
      {email && (
        <a
          href={`mailto:${email}?subject=${encodeURIComponent(mailtoSubject)}&body=${mailtoBody}`}
          title="Email this franchisee a nudge"
          data-testid={`login-report-mailto-${r.franchisee_id}`}
          className="shrink-0 p-1.5 text-stone-500 hover:text-stone-900 hover:bg-stone-100 rounded"
        >
          <Mail className="w-3.5 h-3.5" />
        </a>
      )}
    </div>
  );
}
