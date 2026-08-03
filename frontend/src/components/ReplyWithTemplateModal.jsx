// Reply with template modal — opens from the Contact drawer.
// In stage-1 (pre-deploy) the Send button is disabled with a tooltip
// "Wires up to Resend after deployment". The UX otherwise works fully:
// pick a template, see the populated subject + body with {{first_name}}
// substituted, edit Cc/Bcc, see the to-be-attached file links.
//
// Once Resend is wired (stage 2), this same modal grows a real Send
// handler and the disabled flag flips off.
import { useEffect, useMemo, useRef, useState } from "react";
import api from "@/lib/api";
import DOMPurify from "dompurify";
import { toast } from "sonner";
import { CATEGORY_BUCKETS, groupTemplatesByBucket } from "@/lib/emailTemplateCategories";
import { DisplayNamePill } from "@/lib/emailTemplateColors";
import { resolveLandingTokens } from "@/lib/landingTokens";
import {
  Loader2, Send, X, AlertTriangle, FileText, Mail, ChevronDown, Check,
} from "lucide-react";

export default function ReplyWithTemplateModal({ open, contact, onClose, onSent }) {
  const [templates, setTemplates] = useState([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");
  // Editable intro paragraph inserted between the "Hi {{first_name}},"
  // salutation and the template body. Not persisted — it's a one-off
  // tweak per send so admins can answer the specific question a lead
  // raised without carving out a bespoke template.
  const [intro, setIntro] = useState("");
  const [sending, setSending] = useState(false);

  // Load templates lazily — first time the modal opens. Refetches on
  // every open so admins see edits they just made in another tab/section
  // without having to refresh the whole app. Cache is cleared on close
  // so the dropdown never flashes stale data on the way in.
  useEffect(() => {
    if (!open) {
      setTemplates([]);
      return;
    }
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
    setCc(""); setBcc(""); setSubject(""); setIntro("");
  }, [open, contact?.id, contact?.email, contact?.email_raw]);

  // Auto-pick a sensible default template based on the contact's source
  // once templates load. Mapping rules below are deliberately loose
  // (substring match on `category`) so admins can use whatever naming
  // they like — "franchise" / "franchise-uk" / "Franchise UK" all
  // resolve to the same template for a `franchise_enquiry` contact.
  //
  // We also honour a stable "preferred default" for franchise enquiries:
  // when a template titled "Franchise Enquiry Reply …" exists, it wins
  // over any other franchise-category candidate. This mirrors Paul's
  // ask (Jul 2026) to make the current standard reply the default
  // without hard-coding an ID that would break on the next rename.
  useEffect(() => {
    if (!open || selectedId || !templates.length || !contact?.source) return;
    const source = String(contact.source).toLowerCase();
    const wantedKeyword =
      source.includes("franchise") ? "franchise"
      : source.includes("licence") || source.includes("license") ? "licence"
      : null;
    if (!wantedKeyword) return;
    const inCategory = templates.filter((t) => (t.category || "").toLowerCase().includes(wantedKeyword));
    // Franchise: prefer the "Franchise Enquiry Reply" name pattern.
    if (wantedKeyword === "franchise") {
      const preferred = inCategory.find((t) => /^franchise enquiry reply\b/i.test(t.name || ""));
      if (preferred) { setSelectedId(preferred.id); return; }
    }
    const match = inCategory[0];
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
  // Escapes user-typed intro text for safe HTML injection. Keeps
  // paragraph breaks: two-or-more newlines start a new <p>, single
  // newlines become <br>.
  const introToHtml = (raw) => {
    const s = String(raw || "").trim();
    if (!s) return "";
    const esc = (t) => t
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
    const paras = s.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`);
    return paras.join("");
  };

  // Insert the intro HTML immediately after the salutation paragraph
  // (the first <p> containing "{{first_name}}"). Falls back to the
  // top of the body if no salutation is found — better to appear at
  // the top than get silently lost inside a bulk template.
  const injectIntro = (bodyHtml, introHtml) => {
    if (!introHtml) return bodyHtml;
    const saluteRegex = /(<p[^>]*>[\s\S]*?\{\{\s*first_name\s*\}\}[\s\S]*?<\/p>)/i;
    if (saluteRegex.test(bodyHtml)) {
      return bodyHtml.replace(saluteRegex, `$1${introHtml}`);
    }
    return introHtml + bodyHtml;
  };

  // Use the rendered_html (editable body + locked signature) for both
  // the preview and the send. The signature lives outside body_html so
  // Tiptap can't mangle it.
  const baseRendered = useMemo(() => {
    if (!selected) return "";
    let h = selected.rendered_html || selected.body_html || "";
    // Inject BEFORE the first_name substitution so the intro sits
    // exactly under the salutation.
    h = injectIntro(h, introToHtml(intro));
    h = h.replace(/\{\{\s*first_name\s*\}\}/g, firstName);
    h = h.replace(/\{\{\s*file:([^}]+)\s*\}\}/g, "#preview");
    return h;
  }, [selected, firstName, intro]);

  // Resolve {{landing:*}} tokens using the SAME backend resolver the
  // Resend send pipeline uses at send time (see resend_routes.py
  // _resolve_landing_tokens). Without this the preview anchor's
  // href stayed as the raw token, which browsers then treated as a
  // relative URL and rewrote to /admin/%7B%7B... — exactly the bug
  // the user reported on the info-pack CTA.
  const [rendered, setRendered] = useState("");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out = await resolveLandingTokens(baseRendered);
      if (!cancelled) setRendered(out);
    })();
    return () => { cancelled = true; };
  }, [baseRendered]);

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
        // Inject the per-send intro under the salutation before the
        // backend does its own first_name / file token substitution.
        body_html: injectIntro(
          selected.rendered_html || selected.body_html || "",
          introToHtml(intro),
        ),
      });
      toast.success(`Email sent to ${toList[0]}${toList.length > 1 ? ` (+${toList.length - 1})` : ""}`);
      // Backend auto-advances "new" contacts to "contacted" on template
      // send. Fire the same event ContactsPage.updateStage fires so the
      // sidebar red badge decrements immediately and the kanban card
      // moves without a full refresh.
      if (data?.auto_advanced_to_contacted) {
        toast.success("Moved to Contacted", { duration: 2500 });
        window.dispatchEvent(new CustomEvent("pipeline:stage-changed", {
          detail: { contactId: contact.id, newStage: "contacted", source: "template-send" },
        }));
      }
      if (onSent) onSent(data.send, { autoAdvancedToContacted: !!data?.auto_advanced_to_contacted });
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
          {/* Template picker — custom listbox so the coloured Display
              Name pills actually render (native <option> backgrounds
              aren't honoured cross-browser). Same keyboard-friendly
              affordances a native select would give. */}
          <div>
            <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1">Template</label>
            <TemplatePicker
              templates={templates}
              loading={loadingTemplates}
              value={selectedId}
              onChange={(id) => setSelectedId(id)}
            />
            <div className="text-[10px] text-stone-500 mt-1">
              Don&apos;t see your template? Open <a href="/admin/email-templates" target="_blank" rel="noopener noreferrer" className="underline">Email Templates</a> and give it a bold Display Name &mdash; the coloured tag above is what differentiates options here.
            </div>
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

          {/* Optional personal intro — appears under the salutation
              in this send only (not saved to the template). Great
              for answering a specific question a lead asked before
              the standard template body kicks in. */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 flex items-center gap-1.5">
              Personal note <span className="text-stone-400 normal-case tracking-normal">(optional — appears under &quot;Hi {firstName},&quot;)</span>
            </label>
            <textarea
              value={intro}
              onChange={(e) => setIntro(e.target.value)}
              rows={3}
              data-testid="reply-intro"
              placeholder={`Thanks for your email — to answer your question about class sizes…`}
              className="px-3 py-2 bg-white border border-stone-300 text-sm rounded focus:outline-none focus:border-stone-900 leading-relaxed"
            />
            <div className="text-[10px] text-stone-400">One blank line between paragraphs. Not saved to the template — this personalisation goes out with this reply only.</div>
          </div>

          {/* Linked files note — only show attachments whose
              `{{file:placeholder}}` token is still referenced in the
              body. This stops orphan placeholders from old CTAs
              showing up after the admin replaces the body. */}
          {(() => {
            const body = selected?.body_html || selected?.rendered_html || "";
            const visible = (selected?.attachments || []).filter((a) => {
              const ph = a?.placeholder;
              return ph && body.includes(`{{file:${ph}}}`);
            });
            if (visible.length === 0) return null;
            return (
              <div className="border border-stone-200 rounded-lg p-3 bg-stone-50">
                <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-2">Attached PDFs</div>
                <ul className="space-y-1 text-xs">
                  {visible.map((a, i) => (
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
            );
          })()}

          {/* Live preview */}
          <div>
            <label className="block text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1">Preview (as {firstName} will see it)</label>
            <div className="border border-stone-200 bg-white rounded-lg p-4 min-h-[300px] reply-preview-canvas text-sm"
              data-testid="reply-preview"
              // Sanitised with DOMPurify before injection — templates are
              // admin-authored but contacts (and their potential typos)
              // feed in via the {{first_name}} substitution above, so the
              // belt-and-braces sanitise blocks any script injection.
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(rendered || "<p class='text-stone-400'>Pick a template to see the preview.</p>", { ADD_ATTR: ["target"] }) }} />
          </div>
          {/* Scoped CSS so CTA buttons in the template body render here
              exactly as they will after the backend's send-time inliner
              runs. Without this the {`<a class="cm-btn-cta">`} tags would
              show as plain underlined links (matching the user's
              reported bug). Kept in lock-step with RichTextEditor.jsx. */}
          <style>{`
            .reply-preview-canvas { font-family: Helvetica, Arial, sans-serif; color: #1a1a1a; line-height: 1.6; }
            .reply-preview-canvas p { margin: 0 0 0.9em; font-size: 15px; }
            .reply-preview-canvas strong { font-weight: 700; }
            .reply-preview-canvas h1 { font-size: 22px; font-weight: 700; margin: 0.6em 0 0.4em; }
            .reply-preview-canvas h2 { font-size: 18px; font-weight: 700; margin: 0.6em 0 0.4em; }
            .reply-preview-canvas ul { list-style: disc; padding-left: 1.4em; margin: 0 0 0.9em; }
            .reply-preview-canvas ol { list-style: decimal; padding-left: 1.4em; margin: 0 0 0.9em; }
            .reply-preview-canvas a { color: #1c1917; text-decoration: underline; }
            .reply-preview-canvas a.cm-btn-cta,
            .reply-preview-canvas a[href^="{{file:"],
            .reply-preview-canvas a[href^="{{landing:"] {
              display: inline-block;
              background: #dddd16;
              color: #1a1a1a !important;
              font-weight: 700;
              text-decoration: none !important;
              padding: 11px 26px;
              border-radius: 4px;
              font-size: 13px;
              letter-spacing: 0.5px;
              text-transform: uppercase;
              margin: 6px 0;
            }
            .reply-preview-canvas a.cm-btn-outline {
              display: inline-block;
              background: transparent;
              color: #1a1a1a !important;
              font-weight: 700;
              text-decoration: none !important;
              padding: 11px 26px;
              border: 2px solid #1a1a1a;
              border-radius: 4px;
              font-size: 13px;
              letter-spacing: 0.5px;
              text-transform: uppercase;
              margin: 6px 0;
            }
          `}</style>
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

// ---------------------------------------------------------------------------
// TemplatePicker — custom listbox used inside ReplyWithTemplateModal.
// Native <select> can't paint per-option backgrounds cross-browser, so
// we render our own dropdown that shows the coloured DisplayNamePill
// beside each row and groups options by CATEGORY_BUCKETS just like the
// sidebar on /admin/email-templates.
// ---------------------------------------------------------------------------
function TemplatePicker({ templates, loading, value, onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const selected = useMemo(
    () => templates.find((t) => t.id === value) || null,
    [templates, value],
  );

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const buckets = useMemo(() => groupTemplatesByBucket(templates), [templates]);

  return (
    <div ref={wrapRef} className="relative" data-testid="reply-template-picker">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="reply-template-picker-button"
        className="w-full px-3 py-2 bg-white border border-stone-300 text-sm rounded-lg focus:outline-none focus:border-stone-900 flex items-center gap-2 text-left">
        {selected ? (
          <>
            {selected.display_name && (
              <DisplayNamePill
                displayName={selected.display_name}
                color={selected.display_color} />
            )}
            <span className="flex-1 truncate text-stone-900">{selected.name}</span>
          </>
        ) : (
          <span className="flex-1 text-stone-500">— Choose a template —</span>
        )}
        <ChevronDown className="w-4 h-4 text-stone-500 shrink-0" />
      </button>

      {open && (
        <div
          role="listbox"
          data-testid="reply-template-picker-listbox"
          className="absolute z-20 mt-1 w-full max-h-96 overflow-y-auto bg-white border border-stone-200 rounded-lg shadow-xl">
          {loading && (
            <div className="px-3 py-4 text-xs text-stone-500 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading templates…
            </div>
          )}
          {!loading && templates.length === 0 && (
            <div className="px-3 py-4 text-xs text-stone-500">No templates yet.</div>
          )}
          {!loading && CATEGORY_BUCKETS.map((b) => {
            const rows = buckets[b.id] || [];
            if (rows.length === 0) return null;
            return (
              <div key={b.id}>
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 bg-stone-50 border-b border-stone-100">
                  {b.label}
                </div>
                <ul>
                  {rows.map((t) => {
                    const active = t.id === value;
                    return (
                      <li key={t.id}>
                        <button
                          type="button"
                          onClick={() => { onChange(t.id); setOpen(false); }}
                          role="option"
                          aria-selected={active}
                          data-testid={`reply-template-option-${t.id}`}
                          className={`w-full text-left px-3 py-2 flex items-start gap-2 border-b border-stone-100 last:border-0 ${active ? "bg-stone-100" : "hover:bg-stone-50"}`}>
                          {active
                            ? <Check className="w-3.5 h-3.5 text-stone-900 shrink-0 mt-0.5" />
                            : <span className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
                          <div className="flex-1 min-w-0">
                            {t.display_name && (
                              <div className="mb-1">
                                <DisplayNamePill
                                  displayName={t.display_name}
                                  color={t.display_color} />
                              </div>
                            )}
                            <div className="text-sm text-stone-900 truncate">{t.name || "(untitled)"}</div>
                            {t.category && (
                              <div className="text-[10px] text-stone-500 truncate mt-0.5">{t.category}</div>
                            )}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
