// Compose step for a new DBS Application. Mirrors the "Reply with
// Template" UX so admins pick a template, review the recipient +
// subject + intro paragraph, see a live preview of the outbound email
// (including the auto-appended CTA button), THEN hit Send. Nothing is
// created on the server until Send is clicked — so cancelling doesn't
// leave orphan tokens in the DB.
//
// On Send we do it in one round-trip:
//   1. POST /dbs/applications          → create + get token
//   2. POST /dbs/applications/{id}/send-email → attach the composed
//      subject/intro + admin's window.location.origin so the link
//      points at the right host (Kubernetes ingress strips Origin).
import { useEffect, useMemo, useState } from "react";
import { X, Loader2, Send, Eye } from "lucide-react";
import api from "@/lib/api";
import { toast } from "sonner";
import { CATEGORY_BUCKETS, groupTemplatesByBucket } from "@/lib/emailTemplateCategories";

const DEFAULT_INTRO = (name) => (
  `<p>Hi ${name},</p>
<p>Please complete your DBS Application form so we can process your
Disclosure & Barring Service check. Click the button below to open your
personal form — it should only take a few minutes.</p>
<p>Once submitted the information comes straight back to Creative Mojo
HQ. Any documents you upload are kept private and encrypted.</p>`
);

// Render {{first_name}} etc. Kept purposefully simple — the templates
// system uses the same syntax and we don't need Handlebars for this.
function renderTemplate(str, vars) {
  if (!str) return "";
  return String(str).replace(/{{\s*(\w+)\s*}}/g, (_, k) => (vars[k] != null ? vars[k] : ""));
}

export default function DBSComposeModal({ franchisee, onClose, onSent }) {
  const defaultEmail = franchisee.mojo_email || franchisee.secondary_email || franchisee.email || "";
  const [to, setTo] = useState(defaultEmail);
  const [templates, setTemplates] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [subject, setSubject] = useState(`DBS Application — ${franchisee.first_name || "Creative Mojo"}`);
  const [introHtml, setIntroHtml] = useState(DEFAULT_INTRO(franchisee.first_name || "there"));
  const [sending, setSending] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  // Load templates (grouped by category bucket in the dropdown below).
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/email-templates");
        const list = Array.isArray(data) ? data : (data?.templates || []);
        setTemplates(list);
      } catch {
        setTemplates([]);
      }
    })();
  }, []);

  // When a template is selected, render its subject + body with the
  // franchisee's first_name substituted in.
  const applyTemplate = (id) => {
    setSelectedId(id);
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    const vars = {
      first_name: franchisee.first_name || "there",
      last_name: franchisee.last_name || "",
      organisation: franchisee.organisation || "",
    };
    setSubject(renderTemplate(t.subject || "", vars));
    setIntroHtml(renderTemplate(t.body_html || t.rendered_html || "", vars));
  };

  // Preview HTML — mirrors what the backend will build so what the
  // admin sees is what the franchisee sees. Auto-appends the yellow
  // CTA button. Uses a placeholder token URL for display only.
  const previewHtml = useMemo(() => {
    const url = `${window.location.origin}/dbs/apply/…`;
    return `
<div style="font-family:Helvetica,Arial,sans-serif;color:#1a1a1a;line-height:1.5;max-width:600px;margin:0 auto;padding:16px;">
  ${introHtml}
  <p style="margin:24px 0;">
    <a href="${url}" style="display:inline-block;padding:12px 24px;background:#dddd16;color:#1a1a1a;font-weight:bold;text-decoration:none;border-radius:6px;">OPEN DBS FORM</a>
  </p>
  <p style="font-size:12px;color:#666;">Or copy this link: <a href="${url}" style="color:#666;">${url}</a></p>
  <p style="font-size:12px;color:#999;margin-top:32px;">This link is unique to you — please don't forward it on. Creative Mojo</p>
</div>`;
  }, [introHtml]);

  const send = async () => {
    if (!to.trim()) { toast.error("Recipient email is required"); return; }
    if (!subject.trim()) { toast.error("Subject is required"); return; }
    setSending(true);
    try {
      // 1. Create the application (mint token).
      const { data: app } = await api.post("/dbs/applications", { franchisee_id: franchisee.id });
      // 2. Build the tokenized URL from THIS browser's origin (ingress-safe).
      const public_url = `${window.location.origin}/dbs/apply/${app.token}`;
      // 3. Fire the email with the composed subject + intro. The
      //    backend's send-email honours these overrides.
      const { data: sent } = await api.post(`/dbs/applications/${app.id}/send-email`, {
        application_id: app.id,
        subject,
        intro_html: introHtml,
        public_url,
        override_to: to.trim(),   // NEW: recipient override
      });
      toast.success(`DBS form sent to ${sent.sent_to}`);
      onSent?.();
    } catch (e) {
      const detail = e?.response?.data?.detail || e?.message || "Send failed";
      toast.error(detail);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 z-[70] flex items-start justify-center p-4 overflow-y-auto" data-testid="dbs-compose-modal">
      <div className="w-full max-w-2xl bg-white rounded-2xl mt-8 mb-8 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200 sticky top-0 bg-white z-10">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-stone-500 font-bold">Send DBS Application form</div>
            <div className="font-display text-lg text-stone-950">{franchisee.first_name} {franchisee.last_name}</div>
          </div>
          <button onClick={onClose} data-testid="dbs-compose-close" className="p-2 rounded-lg hover:bg-stone-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <label className="block">
            <span className="text-[11px] uppercase tracking-widest font-bold text-stone-700">To</span>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              data-testid="dbs-compose-to"
              className="mt-1 w-full px-3 py-2 border border-stone-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-stone-950"
            />
            {!defaultEmail && (
              <div className="text-[11px] text-amber-600 mt-1">
                No email on file for this franchisee — set one on the profile or type it here.
              </div>
            )}
          </label>

          <label className="block">
            <span className="text-[11px] uppercase tracking-widest font-bold text-stone-700">Template</span>
            <select
              value={selectedId}
              onChange={(e) => applyTemplate(e.target.value)}
              data-testid="dbs-compose-template"
              className="mt-1 w-full px-3 py-2 border border-stone-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-stone-950"
            >
              <option value="">— Default intro (below) —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.category === "dbs" && "★ "}{t.name}
                </option>
              ))}
            </select>
            <div className="text-[11px] text-stone-500 mt-1">
              Selecting a template overwrites the subject + intro below. You can edit them after.
            </div>
          </label>

          <label className="block">
            <span className="text-[11px] uppercase tracking-widest font-bold text-stone-700">Subject</span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              data-testid="dbs-compose-subject"
              className="mt-1 w-full px-3 py-2 border border-stone-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-stone-950"
            />
          </label>

          <label className="block">
            <div className="flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-widest font-bold text-stone-700">Intro paragraph (HTML supported)</span>
              <button
                onClick={() => setShowPreview((v) => !v)}
                className="text-[11px] uppercase tracking-widest font-bold text-stone-700 hover:text-stone-950 flex items-center gap-1"
                data-testid="dbs-compose-preview-toggle"
                type="button"
              >
                <Eye className="w-3.5 h-3.5" /> {showPreview ? "Hide preview" : "Show preview"}
              </button>
            </div>
            <textarea
              value={introHtml}
              onChange={(e) => setIntroHtml(e.target.value)}
              rows={8}
              data-testid="dbs-compose-intro"
              className="mt-1 w-full px-3 py-2 border border-stone-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-stone-950"
            />
            <div className="text-[11px] text-stone-500 mt-1">
              The yellow <span className="font-bold">OPEN DBS FORM</span> button is added automatically underneath this intro — you don&apos;t need to include the link yourself.
            </div>
          </label>

          {showPreview && (
            <div className="border border-stone-200 rounded-lg p-3 bg-stone-50" data-testid="dbs-compose-preview">
              <div className="text-[10px] uppercase tracking-widest font-bold text-stone-500 mb-2">Preview (what the franchisee sees)</div>
              <div className="bg-white rounded-md p-2 overflow-auto" dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-stone-200 flex items-center justify-end gap-2 sticky bottom-0 bg-white">
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 rounded-lg">
            Cancel
          </button>
          <button
            onClick={send}
            disabled={sending || !to.trim() || !subject.trim()}
            data-testid="dbs-compose-send"
            className="px-4 py-1.5 text-xs font-bold uppercase tracking-wider bg-[#dddd16] text-stone-950 hover:bg-yellow-300 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
          >
            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            {sending ? "Sending…" : "Create + Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
