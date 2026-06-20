// Global "Follow-up Nagger" — polls /api/followup-tasks/due every
// 60 seconds and overlays a modal-stack whenever there's a pending
// task. Mounted at the admin Layout level so it surfaces on ANY page.
//
// User can either:
//   • Actioned   → task is archived (followup_tasks → followup_tasks_done)
//   • Snooze 1d / 1w → due_at pushed forward; modal reappears later
//
// The modal is non-blocking (it sits in a fixed bottom-right card) so
// the admin can carry on working — but it stays sticky until they
// decide. Multiple due tasks stack vertically.
import { useCallback, useEffect, useState } from "react";
import { Bell, Check, Clock, X, Mail, Phone, ChevronDown, ChevronUp } from "lucide-react";
import api from "@/lib/api";

const POLL_MS = 60_000; // re-check the backlog every 60s
const DISMISS_KEY = "cm.followupNagger.collapsed";

const fmtSentAgo = (iso) => {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const hrs = Math.round(ms / 36e5);
  if (hrs < 1) return "just now";
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
};

const methodIcon = (m) => (m === "phone" ? Phone : Mail);

export default function FollowupNagger() {
  const [tasks, setTasks] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.sessionStorage.getItem(DISMISS_KEY) === "1";
  });

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get("/followup-tasks/due");
      setTasks(data?.items || []);
    } catch {
      // 401 etc. — user isn't authenticated as admin. No-op; just stop polling silently.
      setTasks([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    refresh();
    const t = setInterval(() => { if (!cancelled) refresh(); }, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [refresh]);

  const toggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(DISMISS_KEY, next ? "1" : "0");
    }
  };

  const action = async (task, endpoint, payload) => {
    if (busyId) return;
    setBusyId(task.id);
    try {
      await api.post(`/followup-tasks/${task.id}/${endpoint}`, payload || {});
      // Optimistic remove so the modal disappears immediately.
      setTasks((rows) => rows.filter((r) => r.id !== task.id));
    } catch (e) {
      console.error("followup-task action failed", e);
    } finally {
      setBusyId(null);
      // Re-fetch after a beat to pick up server canonical state.
      setTimeout(refresh, 600);
    }
  };

  if (tasks.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[80] max-w-md w-[min(96vw,420px)]" data-testid="followup-nagger">
      <div className="bg-amber-50 border border-amber-300 rounded-2xl shadow-2xl overflow-hidden">
        <button
          onClick={toggleCollapse}
          data-testid="followup-nagger-toggle"
          className="w-full flex items-center justify-between gap-2 px-4 py-2.5 bg-amber-100 hover:bg-amber-200 transition-colors border-b border-amber-300"
        >
          <div className="flex items-center gap-2">
            <Bell className="w-4 h-4 text-amber-700" />
            <div className="text-left">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-amber-900">
                {tasks.length} follow-up{tasks.length === 1 ? "" : "s"} pending
              </div>
              <div className="text-[10px] text-amber-700">click an option per row to clear</div>
            </div>
          </div>
          {collapsed ? <ChevronUp className="w-4 h-4 text-amber-700" /> : <ChevronDown className="w-4 h-4 text-amber-700" />}
        </button>

        {!collapsed && (
          <div className="max-h-[70vh] overflow-y-auto divide-y divide-amber-200">
            {tasks.map((t) => {
              const MIcon = methodIcon(t.method);
              return (
                <div
                  key={t.id}
                  className="p-3.5 bg-white"
                  data-testid={`followup-task-${t.id}`}
                >
                  <div className="flex items-start gap-2 mb-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] uppercase tracking-wider font-bold text-amber-700 mb-0.5">
                        Contract renewal · awaiting response
                      </div>
                      <div className="font-semibold text-stone-950 truncate">{t.label || "Franchisee"}</div>
                      <div className="text-[11px] text-stone-500 flex items-center gap-1 mt-0.5">
                        <MIcon className="w-3 h-3" />
                        Reminder sent {fmtSentAgo(t.sent_at)}
                        {t.sent_by_name ? ` by ${t.sent_by_name}` : ""}
                      </div>
                      {t.renewal_date && (
                        <div className="text-[10px] text-stone-500 mt-0.5 tabular-nums">
                          Renewal date: {new Date(t.renewal_date).toLocaleDateString("en-GB")}
                        </div>
                      )}
                      {t.snooze_count > 0 && (
                        <div className="text-[10px] text-amber-700 mt-1">
                          Snoozed {t.snooze_count} time{t.snooze_count === 1 ? "" : "s"}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button
                      onClick={() => action(t, "actioned")}
                      disabled={busyId === t.id}
                      data-testid={`followup-actioned-${t.id}`}
                      className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-emerald-600 hover:bg-emerald-700 text-white rounded-md flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <Check className="w-3 h-3" /> Actioned
                    </button>
                    <button
                      onClick={() => action(t, "snooze", { hours: 24 })}
                      disabled={busyId === t.id}
                      data-testid={`followup-snooze-1d-${t.id}`}
                      className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-100 hover:bg-stone-200 border border-stone-300 rounded-md flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <Clock className="w-3 h-3" /> Snooze 1 day
                    </button>
                    <button
                      onClick={() => action(t, "snooze", { hours: 24 * 7 })}
                      disabled={busyId === t.id}
                      data-testid={`followup-snooze-1w-${t.id}`}
                      className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-100 hover:bg-stone-200 border border-stone-300 rounded-md flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <Clock className="w-3 h-3" /> Snooze 1 week
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
