// Admin-side DBS modal. Opens from the "DBS" button on the franchisee
// detail page. Lists every application (past + current) and lets HQ
// create a new one — which mints a token, emails the tokenized public
// form URL to the franchisee, and appears here as "Pending" until they
// submit. Once submitted, the "View" button opens a read-only render
// with document previews.
import { useEffect, useState } from "react";
import { X, Plus, Send, Loader2, FileText, Trash2, Copy, ExternalLink, CheckCircle2 } from "lucide-react";
import api from "@/lib/api";
import { toast } from "sonner";
import DBSApplicationView from "./DBSApplicationView";

const STATUS_LABEL = {
  pending: { label: "PENDING", color: "bg-stone-100 text-stone-700 border-stone-300" },
  in_progress: { label: "OPENED", color: "bg-amber-50 text-amber-700 border-amber-300" },
  submitted: { label: "SUBMITTED", color: "bg-emerald-50 text-emerald-700 border-emerald-300" },
  reviewed: { label: "REVIEWED", color: "bg-blue-50 text-blue-700 border-blue-300" },
};

function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }); }
  catch { return "—"; }
}

export default function DBSModal({ franchisee, onClose }) {
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [sendingId, setSendingId] = useState(null);
  const [viewingId, setViewingId] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/dbs/applications", { params: { franchisee_id: franchisee.id } });
      setApps(data.applications || []);
    } catch (e) {
      toast.error("Could not load DBS applications");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [franchisee.id]);

  // The public form URL. Constructed from window.location.origin so
  // it always points to the domain the admin is on (Kubernetes ingress
  // strips Origin/Host so the backend can't reliably derive it).
  const publicUrlFor = (a) => `${window.location.origin}/dbs/apply/${a.token}`;

  const sendEmail = async (id) => {
    setSendingId(id);
    try {
      const a = apps.find((x) => x.id === id);
      const public_url = a ? publicUrlFor(a) : undefined;
      const { data } = await api.post(`/dbs/applications/${id}/send-email`, {
        application_id: id, public_url,
      });
      toast.success(`Sent to ${data.sent_to}`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Send failed");
    } finally {
      setSendingId(null);
    }
  };

  const create = async () => {
    setCreating(true);
    try {
      const { data } = await api.post("/dbs/applications", { franchisee_id: franchisee.id });
      toast.success("New DBS application created");
      // Optimistically send the email right away using our own origin.
      try {
        const public_url = `${window.location.origin}/dbs/apply/${data.token}`;
        const { data: sent } = await api.post(`/dbs/applications/${data.id}/send-email`, {
          application_id: data.id, public_url,
        });
        toast.success(`Sent to ${sent.sent_to}`);
      } catch (e) {
        toast.error(e?.response?.data?.detail || "Send failed");
      }
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Create failed");
    } finally {
      setCreating(false);
    }
  };

  const copyLink = async (a) => {
    try {
      await navigator.clipboard.writeText(publicUrlFor(a));
      toast.success("Public link copied");
    } catch { toast.error("Could not copy"); }
  };

  const del = async (id) => {
    if (!window.confirm("Permanently delete this DBS application AND its uploaded documents? This cannot be undone.")) return;
    try {
      await api.delete(`/dbs/applications/${id}`);
      toast.success("Deleted");
      await load();
    } catch (e) { toast.error(e?.response?.data?.detail || "Delete failed"); }
  };

  const markReviewed = async (id) => {
    try {
      await api.patch(`/dbs/applications/${id}`, { status: "reviewed" });
      toast.success("Marked as reviewed");
      await load();
    } catch (e) { toast.error(e?.response?.data?.detail || "Update failed"); }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-start justify-center p-4 overflow-y-auto" data-testid="dbs-modal">
      <div className="w-full max-w-3xl bg-white rounded-2xl overflow-hidden mt-8 mb-8">
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-stone-500 font-bold">DBS Applications</div>
            <div className="font-display text-lg text-stone-950" data-testid="dbs-modal-title">{franchisee.first_name} {franchisee.last_name}</div>
          </div>
          <button onClick={onClose} data-testid="dbs-modal-close" className="p-2 rounded-lg hover:bg-stone-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <button
            onClick={create}
            disabled={creating}
            data-testid="dbs-new-application"
            className="w-full flex items-center justify-center gap-2 px-4 py-3 text-sm font-bold uppercase tracking-wider bg-[#dddd16] text-stone-950 hover:bg-yellow-300 rounded-lg disabled:opacity-50"
          >
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {creating ? "Creating…" : "+ New DBS Application"}
          </button>

          <div className="text-[11px] uppercase tracking-widest text-stone-500 font-bold pt-2">Applications</div>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-stone-500 py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : apps.length === 0 ? (
            <div className="text-sm text-stone-500 py-6 text-center border border-dashed border-stone-300 rounded-lg">
              No DBS applications yet. Click <span className="font-bold">+ New DBS Application</span> to email one to the franchisee.
            </div>
          ) : (
            <div className="space-y-2">
              {apps.map((a) => {
                const s = STATUS_LABEL[a.status] || STATUS_LABEL.pending;
                return (
                  <div key={a.id} data-testid={`dbs-application-row-${a.id}`}
                    className="border border-stone-200 rounded-xl p-3 flex items-center gap-3 bg-white">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border rounded ${s.color}`}>{s.label}</span>
                        <span className="text-xs text-stone-600">Created {fmtDate(a.created_at)}</span>
                        {a.submitted_at && <span className="text-xs text-emerald-700">· Submitted {fmtDate(a.submitted_at)}</span>}
                        {a.last_sent_at && !a.submitted_at && <span className="text-xs text-stone-500">· Last sent {fmtDate(a.last_sent_at)}</span>}
                      </div>
                      {a.applicant_email && (
                        <div className="text-[11px] text-stone-500 mt-1 truncate">{a.applicant_email}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {a.status === "submitted" || a.status === "reviewed" ? (
                        <>
                          <button
                            onClick={() => setViewingId(a.id)}
                            data-testid={`dbs-view-${a.id}`}
                            className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider border border-stone-950 bg-stone-950 text-[#dddd16] hover:bg-stone-800 rounded-md flex items-center gap-1"
                          >
                            <FileText className="w-3.5 h-3.5" /> View
                          </button>
                          {a.status === "submitted" && (
                            <button onClick={() => markReviewed(a.id)}
                              className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-md flex items-center gap-1">
                              <CheckCircle2 className="w-3.5 h-3.5" /> Mark reviewed
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          <button onClick={() => sendEmail(a.id)} disabled={sendingId === a.id}
                            data-testid={`dbs-send-${a.id}`}
                            className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 rounded-md flex items-center gap-1 disabled:opacity-50">
                            {sendingId === a.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                            Resend email
                          </button>
                          <button onClick={() => copyLink(a)} title="Copy public link"
                            className="p-1.5 rounded-md hover:bg-stone-100 text-stone-600">
                            <Copy className="w-4 h-4" />
                          </button>
                          <a href={publicUrlFor(a)} target="_blank" rel="noopener noreferrer" title="Open form"
                            className="p-1.5 rounded-md hover:bg-stone-100 text-stone-600">
                            <ExternalLink className="w-4 h-4" />
                          </a>
                        </>
                      )}
                      <button onClick={() => del(a.id)} title="Delete permanently"
                        data-testid={`dbs-delete-${a.id}`}
                        className="p-1.5 rounded-md hover:bg-red-50 text-stone-400 hover:text-red-600">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {viewingId && (
        <DBSApplicationView
          applicationId={viewingId}
          onClose={() => setViewingId(null)}
        />
      )}
    </div>
  );
}
