// Marketing compose modal — two-pane editor (left) / live preview
// (right). Mirrors the HQ Updates ComposeModal but scoped to the
// franchisee's own Territory+ clients and capped at 5 recipients
// per send. Now supports:
//   • Multi-panel sections — each panel = {intro, image, link}
//     joined in the email by the brand-yellow horizontal divider.
//   • Rich-text intro on each panel (bold + centre via tiny toolbar).
//   • "Save draft" — persists the in-progress campaign so the user
//     can come back and finish later. Loaded drafts re-open here
//     pre-filled with their stored panels/recipients.
import { useEffect, useState, useMemo, useCallback } from "react";
import {
  X, Send, Loader2, Search, CheckCircle2, AlertCircle, Image as ImageIcon,
  Trash2, Link as LinkIcon, Calendar, Megaphone, RefreshCw, Plus, FileText,
} from "lucide-react";
import api from "@/lib/api";
import MarketingImageCropper from "@/components/portal/marketing/MarketingImageCropper";
import MarketingIntroEditor from "@/components/portal/marketing/MarketingIntroEditor";

const MAX_RECIPIENTS = 5;
const MAX_PANELS = 8;

const emptyPanel = () => ({
  intro: "",
  image_url: "",
  image_key: "",
  link_url: "",
  link_label: "Find out more",
});

export default function MarketingComposeModal({ open, access, draft, onClose, onSent, onDraftSaved }) {
  const [draftId, setDraftId] = useState(null);
  const [title, setTitle] = useState("");
  const [panels, setPanels] = useState([emptyPanel()]);
  const [includeBookings, setIncludeBookings] = useState(false);
  // Per-send footer-contact checkboxes. Persisted with drafts so the
  // franchisee's choices stick on every Save → reload cycle.
  const [footerShowPhone, setFooterShowPhone] = useState(false);
  const [footerShowEmail, setFooterShowEmail] = useState(true);
  const [footerShowFacebook, setFooterShowFacebook] = useState(false);

  const [recipients, setRecipients] = useState([]);
  const [recipientSearch, setRecipientSearch] = useState("");
  const [selectedKeys, setSelectedKeys] = useState(new Set());
  const [recipientsLoading, setRecipientsLoading] = useState(false);

  const [previewHtml, setPreviewHtml] = useState("");
  const [cropOpen, setCropOpen] = useState(false);
  const [cropPanelIdx, setCropPanelIdx] = useState(null);
  const [rawImageFile, setRawImageFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  // Reset / hydrate whenever the modal opens or a different draft is loaded.
  useEffect(() => {
    if (!open) return;
    if (draft) {
      setDraftId(draft.id);
      setTitle(draft.title || "");
      const dp = Array.isArray(draft.panels) && draft.panels.length
        ? draft.panels.map((p) => ({ ...emptyPanel(), ...p }))
        : [{
            ...emptyPanel(),
            intro: draft.intro || "",
            image_url: draft.image_url || "",
            image_key: draft.image_key || "",
            link_url: draft.link_url || "",
            link_label: draft.link_label || "Find out more",
          }];
      setPanels(dp);
      setIncludeBookings(!!draft.include_bookings_link);
      setFooterShowPhone(!!draft.footer_show_phone);
      setFooterShowEmail(draft.footer_show_email !== false);
      setFooterShowFacebook(!!draft.footer_show_facebook);
    } else {
      setDraftId(null);
      setTitle("");
      setPanels([emptyPanel()]);
      setIncludeBookings(false);
      setFooterShowPhone(false);
      setFooterShowEmail(true);
      setFooterShowFacebook(false);
    }
    setRecipientSearch(""); setSelectedKeys(new Set());
    setPreviewHtml(""); setError(""); setInfo("");
    setRecipientsLoading(true);
    api.get("/portal/marketing/recipients")
      .then(({ data }) => setRecipients(data.items || []))
      .catch(() => setRecipients([]))
      .finally(() => setRecipientsLoading(false));
  }, [open, draft]);

  // Live preview render (debounced).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      try {
        const { data } = await api.post("/portal/marketing/preview-html", {
          title,
          panels,
          bookings_url: includeBookings && access?.bookings_enabled
            ? `${window.location.origin}/portal/bookings` : "",
          sample_first_name: "Sandra",
          footer_show_phone: footerShowPhone,
          footer_show_email: footerShowEmail,
          footer_show_facebook: footerShowFacebook,
        });
        setPreviewHtml(data.html || "");
      } catch { /* swallow — preview is best-effort */ }
    }, 300);
    return () => clearTimeout(t);
  }, [open, title, panels, includeBookings, access?.bookings_enabled,
      footerShowPhone, footerShowEmail, footerShowFacebook]);

  const filteredRecipients = useMemo(() => {
    const needle = recipientSearch.trim().toLowerCase();
    if (!needle) return recipients;
    return recipients.filter((r) =>
      (r.name || "").toLowerCase().includes(needle) ||
      (r.organisation || "").toLowerCase().includes(needle) ||
      (r.email || "").toLowerCase().includes(needle) ||
      (r.role || "").toLowerCase().includes(needle)
    );
  }, [recipients, recipientSearch]);

  const toggleRecipient = (r) => {
    const key = `${r.client_id}:${r.contact_index}`;
    setSelectedKeys((s) => {
      const n = new Set(s);
      if (n.has(key)) {
        n.delete(key);
      } else {
        if (n.size >= MAX_RECIPIENTS) {
          setError(`Maximum ${MAX_RECIPIENTS} recipients per send.`);
          setTimeout(() => setError(""), 2000);
          return s;
        }
        n.add(key);
      }
      return n;
    });
  };

  const selectedRecipients = useMemo(
    () => recipients.filter((r) => selectedKeys.has(`${r.client_id}:${r.contact_index}`)),
    [recipients, selectedKeys],
  );

  // --- panels: update / add / remove ---
  const updatePanel = (idx, patch) =>
    setPanels((arr) => arr.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  const addPanel = () => setPanels((arr) => arr.length >= MAX_PANELS ? arr : [...arr, emptyPanel()]);
  const removePanel = (idx) =>
    setPanels((arr) => (arr.length <= 1 ? arr : arr.filter((_, i) => i !== idx)));

  // --- image crop pipeline ---
  const onPickImage = (idx, e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setCropPanelIdx(idx);
    setRawImageFile(f);
    setCropOpen(true);
    e.target.value = "";
  };
  const onCropDone = async (croppedBlob) => {
    setCropOpen(false);
    const idx = cropPanelIdx;
    if (!croppedBlob || idx === null) return;
    setUploading(true); setError("");
    try {
      const fd = new FormData();
      fd.append("file", croppedBlob, "marketing.jpg");
      const { data } = await api.post("/portal/marketing/upload-image", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      updatePanel(idx, { image_url: data.image_url, image_key: data.key });
    } catch (e) {
      setError(e?.response?.data?.detail || "Image upload failed");
    } finally { setUploading(false); }
  };

  // --- payload builders ---
  const baseBody = () => ({
    frontend_origin: typeof window !== "undefined" ? window.location.origin : "",
    title: title.trim(),
    panels: panels.map((p) => ({
      intro: p.intro || "",
      image_url: p.image_url || "",
      image_key: p.image_key || "",
      link_url: p.link_url || "",
      link_label: p.link_label || "Find out more",
    })),
    include_bookings_link: includeBookings && access?.bookings_enabled,
    footer_show_phone: footerShowPhone,
    footer_show_email: footerShowEmail,
    footer_show_facebook: footerShowFacebook,
  });
  const sendBody = () => ({
    ...baseBody(),
    draft_id: draftId || undefined,
    recipients: selectedRecipients.map((r) => ({
      client_id: r.client_id, contact_index: r.contact_index,
    })),
  });

  const saveDraft = async () => {
    setSavingDraft(true); setError(""); setInfo("");
    try {
      const { data } = await api.post("/portal/marketing/campaigns/draft", {
        ...baseBody(),
        id: draftId || undefined,
      });
      setDraftId(data.id);
      setInfo("Draft saved — you can come back and finish later.");
      onDraftSaved?.();
    } catch (e) {
      setError(e?.response?.data?.detail || "Couldn't save draft.");
    } finally { setSavingDraft(false); }
  };

  const send = async () => {
    if (selectedRecipients.length === 0) {
      setError("Pick at least one recipient.");
      return;
    }
    const ok = window.confirm(
      `Send "${title.trim() || "(no subject)"}" to ${selectedRecipients.length} recipient${selectedRecipients.length === 1 ? "" : "s"}?`
    );
    if (!ok) return;
    setSending(true); setError(""); setInfo("");
    try {
      const { data } = await api.post("/portal/marketing/campaigns", sendBody());
      setInfo(`Sent to ${data.succeeded} recipient(s).`);
      onSent?.();
    } catch (e) {
      setError(e?.response?.data?.detail || "Send failed.");
    } finally { setSending(false); }
  };

  const sendTest = async () => {
    setTesting(true); setError(""); setInfo("");
    try {
      const { data } = await api.post("/portal/marketing/test-send", {
        ...baseBody(),
        sample_first_name: "Sandra",
      });
      setInfo(`Test email sent to ${data.to}.`);
    } catch (e) {
      setError(e?.response?.data?.detail || "Test send failed.");
    } finally { setTesting(false); }
  };

  const hasAnyContent = panels.some(
    (p) => (p.intro || "").trim() || (p.image_url || "").trim() || (p.link_url || "").trim()
  );
  const canSend = title.trim() && hasAnyContent && selectedRecipients.length > 0 && !sending;
  const canSaveDraft = (title.trim() || hasAnyContent) && !savingDraft;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-stone-950/40 backdrop-blur-sm flex items-stretch justify-center p-4 overflow-y-auto"
      onClick={onClose}
      data-testid="marketing-compose-modal"
    >
      <div
        className="bg-white w-full max-w-[1400px] rounded-2xl border border-stone-200 shadow-2xl my-auto flex flex-col max-h-[95vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-stone-200 flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-1.5">
              <Megaphone className="w-3 h-3" /> {draftId ? "Edit Draft" : "Send Campaign"}
            </div>
            <h2 className="font-display text-2xl font-black text-stone-950 mt-1">Compose Campaign</h2>
          </div>
          <button
            onClick={onClose}
            data-testid="marketing-compose-close"
            className="w-9 h-9 rounded-full border border-stone-300 hover:bg-stone-50 flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body — two-pane */}
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-0">
            {/* LEFT — editor */}
            <div className="px-6 py-5 space-y-5 border-r border-stone-200">
              <Field label="Title (subject line)" required>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  data-testid="marketing-title"
                  className="w-full px-3 py-2.5 border border-stone-300 rounded-xl text-sm focus:outline-none focus:border-stone-950"
                  placeholder="e.g. New summer craft sessions"
                />
              </Field>

              {/* Repeatable content sections */}
              <div className="space-y-4">
                {panels.map((panel, idx) => (
                  <PanelEditor
                    key={idx}
                    idx={idx}
                    panel={panel}
                    canRemove={panels.length > 1}
                    onChange={(patch) => updatePanel(idx, patch)}
                    onRemove={() => removePanel(idx)}
                    onPickImage={(e) => onPickImage(idx, e)}
                    onClearImage={() => updatePanel(idx, { image_url: "", image_key: "" })}
                    uploading={uploading}
                  />
                ))}
                {panels.length < MAX_PANELS && (
                  <button
                    type="button"
                    onClick={addPanel}
                    data-testid="marketing-add-section"
                    className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-bold uppercase tracking-wider border-2 border-dashed border-stone-300 text-stone-600 hover:bg-stone-50 rounded-xl"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add another section
                  </button>
                )}
              </div>

              {/* Bookings link */}
              {access?.bookings_enabled && (
                <label className="flex items-center gap-2 px-3 py-2 border border-stone-200 rounded-xl bg-stone-50 cursor-pointer hover:bg-stone-100" data-testid="marketing-bookings-toggle">
                  <input
                    type="checkbox"
                    checked={includeBookings}
                    onChange={(e) => setIncludeBookings(e.target.checked)}
                    className="w-4 h-4 rounded border-stone-300 text-stone-900 focus:ring-stone-900"
                  />
                  <Calendar className="w-4 h-4 text-stone-600" />
                  <span className="text-sm text-stone-800">
                    Include a <strong>Book a session</strong> button (links to your bookings page)
                  </span>
                </label>
              )}

              {/* Footer contact block — per-send checkboxes pulled from
                  the franchisee's own contact details. */}
              <div className="border border-stone-200 rounded-xl bg-stone-50/60 p-3" data-testid="marketing-footer-block">
                <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-2 flex items-center justify-between gap-3">
                  <span>Footer · what to include on this e-shot</span>
                  <a
                    href="/portal/marketing/settings"
                    className="text-[10px] font-bold text-stone-700 hover:text-stone-950 underline normal-case tracking-normal"
                  >Edit my marketing settings →</a>
                </div>
                <div className="space-y-1.5">
                  <label className={`flex items-center gap-2 text-sm ${access?.phone ? "text-stone-800 cursor-pointer" : "text-stone-400 cursor-not-allowed"}`}>
                    <input
                      type="checkbox"
                      checked={footerShowPhone && !!access?.phone}
                      disabled={!access?.phone}
                      onChange={(e) => setFooterShowPhone(e.target.checked)}
                      data-testid="footer-show-phone"
                      className="w-4 h-4 rounded border-stone-300 text-stone-900"
                    />
                    Phone — {access?.phone || <em className="text-stone-400">no phone on your profile</em>}
                  </label>
                  <label className={`flex items-center gap-2 text-sm ${access?.from_email ? "text-stone-800 cursor-pointer" : "text-stone-400 cursor-not-allowed"}`}>
                    <input
                      type="checkbox"
                      checked={footerShowEmail && !!access?.from_email}
                      disabled={!access?.from_email}
                      onChange={(e) => setFooterShowEmail(e.target.checked)}
                      data-testid="footer-show-email"
                      className="w-4 h-4 rounded border-stone-300 text-stone-900"
                    />
                    Email — {access?.from_email || <em className="text-stone-400">no email</em>}
                  </label>
                  <label className={`flex items-center gap-2 text-sm ${access?.facebook_url ? "text-stone-800 cursor-pointer" : "text-stone-400 cursor-not-allowed"}`}>
                    <input
                      type="checkbox"
                      checked={footerShowFacebook && !!access?.facebook_url}
                      disabled={!access?.facebook_url}
                      onChange={(e) => setFooterShowFacebook(e.target.checked)}
                      data-testid="footer-show-facebook"
                      className="w-4 h-4 rounded border-stone-300 text-stone-900"
                    />
                    Facebook page — {access?.facebook_url
                      ? <span className="truncate max-w-[260px] inline-block align-bottom" title={access.facebook_url}>{access.facebook_url}</span>
                      : <em className="text-stone-400">add a link in marketing settings</em>}
                  </label>
                </div>
                <div className="mt-2 text-[11px] text-stone-500 italic">
                  The Creative Mojo logo at the top of each e-shot links to your <strong>{access?.logo_target === "facebook" ? "Facebook page" : "Mojo franchise page"}</strong>. Change in settings.
                </div>
              </div>

              {/* Recipients */}
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1.5 flex items-center justify-between">
                  <span>Recipients <span className="text-stone-400 normal-case font-normal">(max 5 per send)</span></span>
                  <span data-testid="marketing-recipients-count" className={`px-2 py-0.5 rounded ${selectedKeys.size === MAX_RECIPIENTS ? "bg-amber-100 text-amber-900" : "bg-stone-100 text-stone-700"}`}>
                    {selectedKeys.size} / {MAX_RECIPIENTS}
                  </span>
                </label>
                <div className="relative mb-2">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
                  <input
                    value={recipientSearch}
                    onChange={(e) => setRecipientSearch(e.target.value)}
                    placeholder="Search clients & contacts…"
                    className="w-full pl-9 pr-3 py-2 text-sm border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-stone-900/20"
                    data-testid="marketing-recipient-search"
                  />
                </div>
                <div className="max-h-72 overflow-y-auto border border-stone-200 rounded-xl divide-y divide-stone-100" data-testid="marketing-recipient-list">
                  {recipientsLoading ? (
                    <div className="flex items-center justify-center py-8 text-stone-400 text-sm">
                      <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading clients…
                    </div>
                  ) : filteredRecipients.length === 0 ? (
                    <div className="px-3 py-6 text-center text-xs text-stone-500">
                      {recipients.length === 0
                        ? "No client contacts with email addresses yet. Add one from My Territory+."
                        : "No matches."}
                    </div>
                  ) : filteredRecipients.map((r) => {
                    const key = `${r.client_id}:${r.contact_index}`;
                    const checked = selectedKeys.has(key);
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => toggleRecipient(r)}
                        data-testid={`marketing-recipient-${r.client_id}-${r.contact_index}`}
                        className={`w-full px-3 py-2 text-left flex items-center gap-3 hover:bg-stone-50 ${checked ? "bg-emerald-50" : ""}`}
                      >
                        <input type="checkbox" readOnly checked={checked}
                          className="w-4 h-4 rounded border-stone-300 text-stone-900 focus:ring-stone-900 pointer-events-none" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-stone-900 truncate">
                            {r.name} <span className="text-stone-400 font-normal">· {r.role}</span>
                          </div>
                          <div className="text-xs text-stone-500 truncate">
                            {r.email}{r.organisation ? ` — ${r.organisation}` : ""}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* RIGHT — preview */}
            <div className="bg-stone-50 px-6 py-5 flex flex-col gap-3">
              <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700 flex items-center gap-1.5">
                <EyeIcon /> Live Preview
                <span className="text-stone-400 font-normal normal-case tracking-normal ml-auto">Rendered as recipients will see it</span>
              </div>
              <div className="flex-1 bg-white border border-stone-200 rounded-xl overflow-hidden min-h-[420px]">
                {previewHtml ? (
                  <iframe
                    title="Email preview"
                    srcDoc={previewHtml}
                    className="w-full h-[600px] border-0"
                    data-testid="marketing-preview-iframe"
                  />
                ) : (
                  <div className="flex items-center justify-center h-[420px] text-stone-400 text-sm">
                    <Loader2 className="w-4 h-4 animate-spin mr-2" /> Rendering…
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-stone-200 bg-stone-50 flex items-center justify-between gap-3 flex-wrap shrink-0">
          <div className="flex-1 min-w-0">
            {error && (
              <div className="text-xs text-red-700 flex items-center gap-1.5" data-testid="marketing-error">
                <AlertCircle className="w-3.5 h-3.5" /> {error}
              </div>
            )}
            {info && !error && (
              <div className="text-xs text-emerald-700 flex items-center gap-1.5" data-testid="marketing-info">
                <CheckCircle2 className="w-3.5 h-3.5" /> {info}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={saveDraft}
            disabled={!canSaveDraft}
            data-testid="marketing-save-draft"
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
          >
            {savingDraft ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
            Save draft
          </button>
          <button
            type="button"
            onClick={sendTest}
            disabled={testing || !title.trim() || !hasAnyContent}
            data-testid="marketing-test-send"
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
          >
            {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Send test to me
          </button>
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            data-testid="marketing-send-btn"
            className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
          >
            {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            Send to {selectedKeys.size || 0} recipient{selectedKeys.size === 1 ? "" : "s"}
          </button>
        </div>
      </div>

      <MarketingImageCropper
        open={cropOpen}
        file={rawImageFile}
        onCancel={() => setCropOpen(false)}
        onDone={onCropDone}
      />
    </div>
  );
}

function PanelEditor({ idx, panel, canRemove, onChange, onRemove, onPickImage, onClearImage, uploading }) {
  return (
    <div className="border border-stone-200 rounded-xl p-4 bg-white relative" data-testid={`marketing-panel-${idx}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-600">
          Section {idx + 1}
        </div>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            data-testid={`marketing-panel-remove-${idx}`}
            className="text-stone-400 hover:text-red-600 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold"
          >
            <Trash2 className="w-3 h-3" /> Remove
          </button>
        )}
      </div>

      <Field label="Intro text" required={idx === 0}>
        <MarketingIntroEditor
          value={panel.intro}
          onChange={(html) => onChange({ intro: html })}
          placeholder={idx === 0 ? "Hi! We're running…" : "Add more details, an offer, a follow-up note…"}
          testid={`marketing-intro-${idx}`}
        />
      </Field>

      {/* Image */}
      <div className="mt-3">
        <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1.5 flex items-center justify-between">
          <span><ImageIcon className="w-3 h-3 inline mr-1" /> Image (optional)</span>
          {panel.image_url && (
            <button
              onClick={onClearImage}
              data-testid={`marketing-image-remove-${idx}`}
              className="text-stone-400 hover:text-red-600 text-[10px] inline-flex items-center gap-1"
            >
              <Trash2 className="w-3 h-3" /> Remove
            </button>
          )}
        </label>
        {panel.image_url ? (
          <div className="border border-stone-300 rounded-xl overflow-hidden bg-stone-100">
            <img src={panel.image_url} alt="" className="w-full h-auto" data-testid={`marketing-image-preview-${idx}`} />
          </div>
        ) : (
          <label
            className="flex flex-col items-center justify-center px-4 py-6 border-2 border-dashed border-stone-300 rounded-xl cursor-pointer hover:bg-stone-50 text-stone-500"
            data-testid={`marketing-image-upload-${idx}`}
          >
            {uploading ? (
              <Loader2 className="w-5 h-5 animate-spin text-stone-400" />
            ) : (
              <>
                <ImageIcon className="w-6 h-6 mb-1.5 text-stone-400" />
                <span className="text-sm font-medium">Upload &amp; crop an image</span>
                <span className="text-[11px] mt-0.5">Free-form crop · max 12 MB · JPG / PNG / WebP</span>
              </>
            )}
            <input type="file" accept="image/*" onChange={onPickImage} className="hidden" />
          </label>
        )}
      </div>

      {/* Link */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
        <Field label="Link URL (optional)">
          <div className="relative">
            <LinkIcon className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input
              type="url"
              value={panel.link_url}
              onChange={(e) => onChange({ link_url: e.target.value })}
              data-testid={`marketing-link-url-${idx}`}
              placeholder="https://…"
              className="w-full pl-9 pr-3 py-2.5 border border-stone-300 rounded-xl text-sm focus:outline-none focus:border-stone-950"
            />
          </div>
        </Field>
        <Field label="Button label">
          <input
            value={panel.link_label}
            onChange={(e) => onChange({ link_label: e.target.value })}
            data-testid={`marketing-link-label-${idx}`}
            className="w-full px-3 py-2.5 border border-stone-300 rounded-xl text-sm focus:outline-none focus:border-stone-950"
          />
        </Field>
      </div>
    </div>
  );
}

function Field({ label, required, children }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-600 mb-1.5 block">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

function EyeIcon() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
