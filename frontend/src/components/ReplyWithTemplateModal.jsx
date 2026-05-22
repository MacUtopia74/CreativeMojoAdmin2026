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
import {
  Loader2, Send, X, AlertTriangle, FileText, Mail,
} from "lucide-react";

export default function ReplyWithTemplateModal({ open, contact, onClose }) {
  const [templates, setTemplates] = useState([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");

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
  // Substitute {{first_name}} (and {{file:*}} → friendly chip text) so
  // the preview reflects exactly what the recipient will see.
  const rendered = useMemo(() => {
    if (!selected) return "";
    let h = selected.body_html || "";
    h = h.replace(/\{\{\s*first_name\s*\}\}/g, firstName);
    h = h.replace(/\{\{\s*file:([^}]+)\s*\}\}/g, "#preview");
    return h;
  }, [selected, firstName]);

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
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: rendered || "<p class='text-stone-400'>Pick a template to see the preview.</p>" }} />
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-stone-200 bg-stone-50 flex items-center justify-between gap-3 shrink-0">
          <div className="text-[11px] text-amber-800 flex items-center gap-1.5">
            <AlertTriangle className="w-3 h-3" />
            Wires up to Resend after deployment — the Send button stays disabled in dev.
          </div>
          <button
            type="button"
            disabled
            data-testid="reply-send"
            title="Wires up to Resend after deployment"
            className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-stone-300 text-stone-500 rounded-lg flex items-center gap-1.5 cursor-not-allowed">
            <Send className="w-3.5 h-3.5" /> Send (disabled)
          </button>
        </div>
      </aside>
    </div>
  );
}
