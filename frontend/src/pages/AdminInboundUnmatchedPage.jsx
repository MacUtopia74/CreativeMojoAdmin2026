// Phase 5b — Unmatched inbound replies tray.
// Renders the small admin view for incoming replies that arrived via
// Resend Inbound but couldn't be auto-matched to an outbound send (e.g.
// the lead replied from a different address, or stripped the
// In-Reply-To header). Admin can either link a row to an existing send
// by sticky-pasting a send ID, or discard it.
import { useEffect, useState } from "react";
import api from "@/lib/api";
import { Loader2, Mail, Link2, Trash2, Inbox } from "lucide-react";
import { toast } from "sonner";

export default function AdminInboundUnmatchedPage() {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [linkingId, setLinkingId] = useState(null);
  const [linkSendId, setLinkSendId] = useState("");

  const load = async () => {
    setBusy(true);
    try {
      const { data } = await api.get("/email/inbound/unmatched");
      setRows(data.items || []);
    } catch {
      setRows([]);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { load(); }, []);

  const link = async (id) => {
    if (!linkSendId.trim()) {
      toast.error("Enter a send ID first");
      return;
    }
    try {
      await api.post(`/email/inbound/unmatched/${id}/link`, { send_id: linkSendId.trim() });
      toast.success("Linked — appears on the contact's timeline");
      setLinkingId(null);
      setLinkSendId("");
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Link failed");
    }
  };

  const discard = async (id) => {
    if (!window.confirm("Discard this inbound? It will be hidden from the tray.")) return;
    try {
      await api.delete(`/email/inbound/unmatched/${id}`);
      toast.success("Discarded");
      load();
    } catch {
      toast.error("Discard failed");
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-6" data-testid="inbound-unmatched-page">
      <div className="flex items-center gap-3 mb-6">
        <Inbox className="w-6 h-6 text-stone-700" />
        <div>
          <h1 className="text-2xl font-bold text-stone-950">Unmatched Replies</h1>
          <p className="text-sm text-stone-500">
            Inbound emails that arrived via Resend but couldn&apos;t be auto-linked to an outbound send. Phase 5b fallback.
          </p>
        </div>
      </div>

      {busy && rows === null ? (
        <div className="flex items-center gap-2 text-sm text-stone-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : !rows || rows.length === 0 ? (
        <div className="bg-stone-50 border border-stone-200 rounded-xl p-12 text-center">
          <Mail className="w-10 h-10 text-stone-300 mx-auto mb-3" />
          <div className="text-sm text-stone-600 font-semibold">No unmatched replies</div>
          <div className="text-xs text-stone-500 mt-1">Auto-detection is working — replies are landing on contact timelines directly.</div>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="bg-white border border-stone-200 rounded-xl p-4" data-testid={`unmatched-row-${r.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-stone-900 truncate">{r.subject || "(no subject)"}</div>
                  <div className="text-xs text-stone-500 mt-0.5">
                    From <span className="font-mono">{r.from}</span> · {new Date(r.received_at).toLocaleString("en-GB")}
                  </div>
                  {r.preview && <div className="text-xs text-stone-600 mt-2 italic line-clamp-2">{r.preview}</div>}
                  {r.in_reply_to && (
                    <div className="text-[10px] text-stone-400 mt-1 font-mono truncate">In-Reply-To: {r.in_reply_to}</div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => { setLinkingId(linkingId === r.id ? null : r.id); setLinkSendId(""); }}
                    data-testid={`link-${r.id}`}
                    className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-md flex items-center gap-1.5">
                    <Link2 className="w-3.5 h-3.5" /> Link
                  </button>
                  <button
                    onClick={() => discard(r.id)}
                    data-testid={`discard-${r.id}`}
                    className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-white border border-stone-300 text-stone-700 hover:bg-stone-50 rounded-md flex items-center gap-1.5">
                    <Trash2 className="w-3.5 h-3.5" /> Discard
                  </button>
                </div>
              </div>
              {linkingId === r.id && (
                <div className="mt-3 pt-3 border-t border-stone-100 flex items-center gap-2">
                  <input
                    type="text"
                    value={linkSendId}
                    onChange={(e) => setLinkSendId(e.target.value)}
                    placeholder="Paste the outbound send ID (UUID)…"
                    data-testid={`link-input-${r.id}`}
                    className="flex-1 px-3 py-1.5 text-xs font-mono border border-stone-300 focus:border-stone-950 focus:outline-none rounded-md" />
                  <button
                    onClick={() => link(r.id)}
                    data-testid={`link-confirm-${r.id}`}
                    className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider bg-emerald-600 text-white hover:bg-emerald-700 rounded-md">
                    Confirm
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
