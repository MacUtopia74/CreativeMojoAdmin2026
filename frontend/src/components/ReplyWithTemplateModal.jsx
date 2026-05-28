// Reply with template modal — opens from the Contact drawer.
// In stage-1 (pre-deploy) the Send button is disabled with a tooltip
// "Wires up to Resend after deployment". The UX otherwise works fully:
// pick a template, see the populated subject + body with {{first_name}}
// substituted, edit Cc/Bcc, see the to-be-attached file links.
//
// Once Resend is wired (stage 2), this same modal grows a real Send
// handler and the disabled flag flips off.
import { useEffect, useMemo, useState } from "react";
import api from "@/lib/api";
import DOMPurify from "dompurify";
import { toast } from "sonner";
import {
  Loader2, Send, X, AlertTriangle, FileText, Mail,
} from "lucide-react";

export default function ReplyWithTemplateModal({ open, contact, onClose, onSent }) {
  const [templates, setTemplates] = useState([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");
  const [sending, setSending] = useState(false);

  // Load templates lazily — first time the modal opens. Cached after.
  useEffect(() => {
    if (!open) return;
    setLoadingTemplates(true);
    api.get("/email-templates")
      .then(({ data }) => setTemplates(data.items || []))
      .finally(() => setLoadingTemplates(false));
  }, [open]);

  // Pre-populate To from the contact + reset selection on open / contact change.
  useEffect(() => {
    if (!open) return;
    setTo(contact?.email || contact?.email_raw || "");
    setSelectedId(null);
    setCc(""); setBcc(""); setSubject("");
  }, [open, contact?.id, contact?.email, contact?.email_raw]);

  // Auto-pick a sensible default template based on the contact's source
  // once templates load. Mapping rules below are deliberately loose
  // (substring match on `category`) so admins can use whatever naming
  // they like — "franchise" / "franchise-uk" / "Franchise UK" all
  // resolve to the same template for a `franchise_enquiry` contact.
  useEffect(() => {
    if (!open || selectedId || !templates.length || !contact?.source) return;
    const source = String(contact.source).toLowerCase();
    const wantedKeyword =
      source.includes("franchise") ? "franchise"
      : source.includes("licence") || source.includes("license") ? "licence"
      : null;
    if (!wantedKeyword) return;
    const match = templates.find((t) => (t.category || "").toLowerCase().includes(wantedKeyword));
    if (match) setSelectedId(match.id);
  }, [open, templates, contact?.source, selectedId]);

  const selected = useMemo(() => templates.find((t) => t.id === selectedId), [templates, selectedId]);

  // When the template selection changes, hydrate the editable Subject /
  // Cc / Bcc fields from the template's defaults.
  useEffect(() => {
    if (!selected) return;
    setSubject(selected.subject || "");
    setCc((selected.default_cc || []).join(", "));
    setBcc((selected.default_bcc || []).join(", "));
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const firstName = contact?.first_name || "there";

  // Normalise "a@x.com, b@y.com  ; c@z.com" → ["a@x.com","b@y.com","c@z.com"]
  // for the To / Cc / Bcc fields. Trims whitespace, drops empties.
  const parseList = (raw) =>
    String(raw || "")
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  // Use the rendered_html (editable body + locked signature) for both
  // the preview and the send. The signature lives outside body_html so
  // Tiptap can't mangle it.
  const rendered = useMemo(() => {
    if (!selected) return "";
    let h = selected.rendered_html || selected.body_html || "";
    h = h.replace(/\{\{\s*first_name\s*\}\}/g, firstName);
    h = h.replace(/\{\{\s*file:([^}]+)\s*\}\}/g, "#preview");
    return h;
  }, [selected, firstName]);

  // What we POST is the *unrendered* body — the backend re-runs the
  // first_name + file token substitution server-side so we keep the
  // signed R2 URLs fresh and avoid trusting the client to do it. Only
  // the {{file:*}} → "#preview" rewrite is preview-only; the real
  // body still has the original tokens which the backend resolves.
  const handleSend = async () => {
    if (!selected) {
      toast.error("Pick a template first");
      return;
    }
    const toList = parseList(to);
    if (toList.length === 0) {
      toast.error("Add at least one recipient");
      return;
    }
    if (!subject.trim()) {
      toast.error("Subject is required");
      return;
    }
    setSending(true);
    try {
      const { data } = await api.post("/email/send-reply", {
        contact_id: contact.id,
        template_id: selected.id,
        to: toList,
        cc: parseList(cc),
        bcc: parseList(bcc),
        subject: subject.trim(),
        body_html: selected.rendered_html || selected.body_html || "",
      });
      toast.success(`Email sent to ${toList[0]}${toList.length > 1 ? ` (+${toList.length - 1})` : ""}`);
      if (onSent) onSent(data.send);
      onClose();
    } catch (e) {
      const msg = e?.response?.data?.detail || e?.message || "Failed to send";
      toast.error(msg);
    } finally {
      setSending(false);
    }
  };

  if (!open || !contact) return null;

  return (
    <div onClick={onClose} className="fixed inset-0 z-[80] bg-stone-950/60 backdrop-blur-sm flex items-stretch justify-end" data-testid="reply-template-modal">
      <aside onClick={(e) => e.stopPropagation()}
        className="bg-white w-full max-w-3xl h-full shadow-2xl flex flex-col">
        <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between shrink-0">
          <h2 className="font-bold uppercase tracking-[0.18em] text-sm text-stone-900 flex items-center gap-2">
            <Mail className="w-4 h-4" /> Reply with template
          </h2>
          <button onClick={onClose} data-testid="reply-template-close" className="w-9 h-9 hover:bg-stone-100 rounded-lg flex items-center justify-center">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {/* Template picker */}
          <div>
            <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1">Template</label>
            <select value={selectedId || ""} onChange={(e) => setSelectedId(e.target.value || null)} data-testid="reply-template-picker"
              className="w-full px-3 py-2 bg-white border border-stone-300 text-sm rounded-lg focus:outline-none focus:border-stone-900">
              <option value="">— Choose a template —</option>
              {loadingTemplates && <option disabled>Loading…</option>}
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}{t.category ? ` · ${t.category}` : ""}</option>
              ))}
            </select>
          </div>

          {/* To / Cc / Bcc / Subject */}
          <div className="space-y-2 border border-stone-200 rounded-lg p-3 bg-stone-50">
            <div className="grid grid-cols-[60px_1fr] items-center gap-2">
              <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">To</label>
              <input value={to} onChange={(e) => setTo(e.target.value)} data-testid="reply-to"
                className="px-3 py-1.5 bg-white border border-stone-300 text-sm rounded focus:outline-none focus:border-stone-900" />
            </div>
            <div className="grid grid-cols-[60px_1fr] items-center gap-2">
              <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Cc</label>
              <input value={cc} onChange={(e) => setCc(e.target.value)} data-testid="reply-cc" placeholder="comma separated"
                className="px-3 py-1.5 bg-white border border-stone-300 text-sm rounded focus:outline-none focus:border-stone-900" />
            </div>
            <div className="grid grid-cols-[60px_1fr] items-center gap-2">
              <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Bcc</label>
              <input value={bcc} onChange={(e) => setBcc(e.target.value)} data-testid="reply-bcc" placeholder="comma separated"
                className="px-3 py-1.5 bg-white border border-stone-300 text-sm rounded focus:outline-none focus:border-stone-900" />
            </div>
            <div className="grid grid-cols-[60px_1fr] items-center gap-2">
              <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600">Subject</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} data-testid="reply-subject"
                className="px-3 py-1.5 bg-white border border-stone-300 text-sm rounded focus:outline-none focus:border-stone-900" />
            </div>
          </div>

          {/* Linked files note */}
          {(selected?.attachments || []).length > 0 && (
            <div className="border border-stone-200 rounded-lg p-3 bg-stone-50">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-2">Attached PDFs</div>
              <ul className="space-y-1 text-xs">
                {(selected.attachments || []).map((a, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <FileText className="w-3 h-3 text-stone-400 shrink-0" />
                    <span className="text-stone-900">{a.name}</span>
                    {!a.key && (
                      <span className="text-[10px] text-amber-700 inline-flex items-center gap-0.5">
                        <AlertTriangle className="w-3 h-3" /> needs an R2 file picked in template
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Live preview */}
          <div>
            <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1">Preview (as {firstName} will see it)</label>
            <div className="border border-stone-200 bg-white rounded-lg p-4 min-h-[300px] prose prose-sm max-w-none text-sm"
              data-testid="reply-preview"
              // Sanitised with DOMPurify before injection — templates are
              // admin-authored but contacts (and their potential typos)
              // feed in via the {{first_name}} substitution above, so the
              // belt-and-braces sanitise blocks any script injection.
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(rendered || "<p class='text-stone-400'>Pick a template to see the preview.</p>") }} />
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-stone-200 bg-stone-50 flex items-center justify-between gap-3 shrink-0">
          <div className="text-[11px] text-stone-500">
            From <span className="font-medium text-stone-700">Paul · Creative Mojo</span> · sent via Resend
          </div>
          <button
            type="button"
            onClick={handleSend}
            disabled={sending || !selected}
            data-testid="reply-send"
            title={!selected ? "Pick a template first" : "Send via Resend"}
            className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-stone-900 text-white rounded-lg flex items-center gap-1.5 hover:bg-stone-800 transition-colors disabled:bg-stone-300 disabled:text-stone-500 disabled:cursor-not-allowed">
            {sending ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Sending…</>
            ) : (
              <><Send className="w-3.5 h-3.5" /> Send Reply</>
            )}
          </button>
        </div>
      </aside>
    </div>
  );
}
