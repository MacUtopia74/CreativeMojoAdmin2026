// Portal — Marketing module (Plus add-on, requires marketing +
// territory_plus modules; the Demo tag bypasses both).
//
// Mirrors the HQ Updates admin composer: two-pane edit / live preview
// modal, but scoped to a single franchisee and capped at 5 recipients
// per send. Recipients come from the My Territory+ clients list (each
// client's primary email + every secondary contact that has an email).
//
// History list shows past campaigns with delivery + open/click stats
// rolled up from the Resend webhook events stored on each campaign.
import { useEffect, useState, useCallback } from "react";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import {
  Megaphone, Loader2, AlertCircle, Plus, Mail, Sparkles, RefreshCw,
  Eye, Calendar, FileText, Pencil, Trash2, Settings, Copy, Bookmark, X,
} from "lucide-react";
import api from "@/lib/api";
import PortalPageHeading from "@/components/portal/PortalPageHeading";
import MarketingComposeModal from "@/components/portal/marketing/MarketingComposeModal";
import MarketingCampaignReport from "@/components/portal/marketing/MarketingCampaignReport";

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return "—"; }
}

export default function PortalMarketingPage() {
  const [access, setAccess] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [composeOpen, setComposeOpen] = useState(false);
  const [editingDraft, setEditingDraft] = useState(null);   // draft doc OR null for new
  const [preselectClientId, setPreselectClientId] = useState(null);
  const [reportId, setReportId] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [previewingTemplate, setPreviewingTemplate] = useState(null);  // template doc | null
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  // Deep-link from My Territory+: ``?client_id=…`` opens the compose
  // modal with that client's recipients pre-ticked. We consume the
  // search param once on mount, then clear it so a page refresh
  // doesn't re-open the modal unexpectedly.
  const [searchParams, setSearchParams] = useSearchParams();

  const loadAccess = useCallback(async () => {
    try {
      const { data } = await api.get("/portal/marketing/access");
      setAccess(data);
    } catch (e) {
      setAccess({ allowed: false, reason: e?.response?.data?.detail || "Unavailable" });
    }
  }, []);

  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/portal/marketing/campaigns");
      setCampaigns(data.items || []);
    } catch {
      setCampaigns([]);
    } finally { setLoading(false); }
  }, []);

  const loadTemplates = useCallback(async () => {
    try {
      const { data } = await api.get("/portal/marketing/templates");
      setTemplates(data.items || []);
    } catch { setTemplates([]); }
  }, []);

  useEffect(() => { loadAccess(); }, [loadAccess]);
  useEffect(() => { if (access?.allowed) { loadCampaigns(); loadTemplates(); } }, [access?.allowed, loadCampaigns, loadTemplates]);

  // Auto-open the compose modal when arriving via /portal/marketing?client_id=…
  useEffect(() => {
    const cid = searchParams.get("client_id");
    if (cid && access?.allowed) {
      setPreselectClientId(cid);
      setEditingDraft(null);
      setComposeOpen(true);
      // Clear the param so refreshing the page doesn't loop us back
      // into the modal.
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access?.allowed, searchParams]);

  const openCompose = (draft = null) => {
    setEditingDraft(draft);
    setPreselectClientId(null);
    setComposeOpen(true);
  };

  const deleteCampaign = async (c) => {
    if (!window.confirm(`Delete ${c.status === "draft" ? "draft" : "campaign"} "${c.title || "(untitled)"}"?`)) return;
    try {
      await api.delete(`/portal/marketing/campaigns/${c.id}`);
      loadCampaigns();
    } catch (e) {
      window.alert(e?.response?.data?.detail || "Couldn't delete.");
    }
  };

  // Duplicate any draft / sent / template into a fresh draft and pop
  // open the compose modal on it so the franchisee can immediately
  // edit the copy. Same flow for the template "Use Template" action.
  const duplicateCampaign = async (c) => {
    try {
      const { data } = await api.post(`/portal/marketing/campaigns/${c.id}/duplicate`);
      await loadCampaigns();
      const draft = { id: data.id };
      // Pull the freshly-duplicated draft so the modal opens with full content.
      try {
        const r = await api.get(`/portal/marketing/campaigns/${data.id}`);
        Object.assign(draft, r.data);
      } catch { /* fall back to id-only; modal will load on its own */ }
      openCompose(draft);
    } catch (e) {
      window.alert(e?.response?.data?.detail || "Couldn't duplicate.");
    }
  };

  const saveAsTemplate = async (c) => {
    const name = window.prompt(
      "Save this campaign as a reusable template. Give it a name:",
      c.title || "Template",
    );
    if (!name || !name.trim()) return;
    try {
      await api.post(`/portal/marketing/campaigns/${c.id}/save-as-template`, {
        template_name: name.trim(),
      });
      loadTemplates();
    } catch (e) {
      window.alert(e?.response?.data?.detail || "Couldn't save as template.");
    }
  };

  const deleteTemplate = async (t) => {
    if (!window.confirm(`Delete template "${t.template_name || t.title}"?`)) return;
    try {
      await api.delete(`/portal/marketing/templates/${t.id}`);
      loadTemplates();
    } catch (e) {
      window.alert(e?.response?.data?.detail || "Couldn't delete template.");
    }
  };

  // Preview a template — hit the live-preview endpoint to render the
  // same HTML the franchisee would see in their inbox. Shown inside a
  // modal so they can sanity-check before clicking Use Template.
  const previewTemplate = async (t) => {
    setPreviewingTemplate(t); setPreviewBusy(true); setPreviewHtml("");
    try {
      const { data } = await api.post("/portal/marketing/preview-html", {
        title: t.title,
        panels: t.panels || [],
        intro_html: t.intro_html || "",
        background_color: t.background_color || "",
        include_bookings_link: !!t.include_bookings_link,
        footer_show_phone: !!t.footer_show_phone,
        footer_show_email: !!t.footer_show_email,
        footer_show_facebook: !!t.footer_show_facebook,
        footer_show_instagram: !!t.footer_show_instagram,
        footer_show_custom: !!t.footer_show_custom,
      });
      setPreviewHtml(data.html || "");
    } catch (e) {
      setPreviewHtml(`<p style="padding:24px;color:#b91c1c">${e?.response?.data?.detail || "Couldn't render preview."}</p>`);
    } finally { setPreviewBusy(false); }
  };

  if (!access) {
    return (
      <div className="flex items-center justify-center min-h-[200px] text-stone-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
      </div>
    );
  }

  if (!access.allowed) {
    return (
      <div className="space-y-5" data-testid="portal-marketing-page">
        <PortalPageHeading
          eyebrow="Marketing toolkit"
          icon={Megaphone}
          title="Marketing+"
          subtitle="Send branded e-shots to your existing Territory+ clients."
        />
        <div className="bg-amber-50 border border-amber-200 rounded-2xl px-6 py-8 text-center" data-testid="marketing-locked">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-amber-100 mb-4">
            <AlertCircle className="w-7 h-7 text-amber-700" />
          </div>
          <h2 className="font-display text-2xl font-black text-stone-950 mb-2">Marketing+ is locked</h2>
          <p className="text-sm text-stone-700 max-w-md mx-auto">
            {access.reason || "Add the Marketing+ module from your Subscriptions page to enable this feature."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="portal-marketing-page">
      <PortalPageHeading
        eyebrow="Marketing toolkit"
        icon={Megaphone}
        title="Marketing+"
        subtitle="Send branded e-shots to your Territory+ clients. Max 5 recipients per send."
        actions={
          <div className="flex items-center gap-2">
            <RouterLink
              to="/portal/marketing/settings"
              data-testid="marketing-settings-link"
              title="Edit your marketing settings (logo destination + Facebook URL)"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white hover:bg-stone-50 text-stone-900 rounded-lg"
            >
              <Settings className="w-3.5 h-3.5" /> Settings
            </RouterLink>
            <button
              onClick={() => openCompose(null)}
              data-testid="marketing-compose-btn"
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-[#dddd16] rounded-lg"
            >
              <Plus className="w-3.5 h-3.5" /> New Campaign
            </button>
          </div>
        }
      />

      <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-900 flex items-center gap-2">
        <Sparkles className="w-3.5 h-3.5 shrink-0" />
        Sent from <strong className="mx-1">{access.from_email}</strong> · Capped at <strong>5</strong> recipients per send to keep your emails out of spam folders.
      </div>

      {/* GDPR / PECR compliance note — surfaced so the franchisee
          knows what their e-shots include automatically. */}
      <details
        className="bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 text-xs text-stone-700"
        data-testid="marketing-gdpr-block"
      >
        <summary className="cursor-pointer font-bold text-stone-900 select-none flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-stone-500" />
          GDPR &amp; UK PECR — what your e-shots already include
          <span className="ml-auto text-[10px] uppercase tracking-wider text-stone-500 font-bold">Click to expand</span>
        </summary>
        <div className="pt-3 mt-3 border-t border-stone-200 space-y-2 leading-relaxed">
          <p>Every e-shot you send from this portal automatically includes the four legally required elements for marketing email under UK PECR + GDPR:</p>
          <ol className="list-decimal pl-5 space-y-1">
            <li><strong>Sender identity</strong> — your name + your franchise organisation, rendered at the bottom of every email.</li>
            <li><strong>Postal address</strong> — pulled from your franchisee profile so recipients can identify a real business.</li>
            <li><strong>Lawful basis statement</strong> — the line <em>"You're receiving this because you're a Creative Mojo customer."</em></li>
            <li><strong>Opt-out mechanism</strong> — recipients can reply <code className="bg-white px-1 rounded">UNSUBSCRIBE</code> in the subject line at any time, which you'll then need to honour by removing them from your client list.</li>
          </ol>
          <p className="text-stone-600">
            <strong>Your job</strong>: only e-shot people who are existing or recent customers (soft opt-in), and respect unsubscribe replies promptly. If anyone formally asks to be forgotten, delete them from My Territory+ → that removes them from every future send.
          </p>
        </div>
      </details>

      {/* Drafts (if any) */}
      {(() => {
        const drafts = campaigns.filter((c) => (c.status || "sent") === "draft");
        const sent = campaigns.filter((c) => (c.status || "sent") !== "draft");
        return (
          <>
            {/* Templates strip — sits ABOVE drafts + past campaigns. Each
                template is a horizontal card with Use Template + Preview +
                Delete actions. Clicking the title opens a preview modal. */}
            <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden" data-testid="marketing-templates-strip">
              <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700 flex items-center gap-1.5">
                  <Bookmark className="w-3 h-3" /> Templates ({templates.length})
                </div>
                <span className="text-[10px] text-stone-500 italic">Save any draft or sent campaign as a template using the bookmark icon on its row.</span>
              </div>
              {templates.length === 0 ? (
                <div className="px-5 py-5 text-xs text-stone-500">
                  No templates yet. Save any campaign as a template to reuse it later.
                </div>
              ) : (
                <ul className="divide-y divide-stone-100">
                  {templates.map((t) => (
                    <li key={t.id} className="px-5 py-3 flex items-center gap-3 flex-wrap" data-testid={`marketing-template-${t.id}`}>
                      <button
                        onClick={() => previewTemplate(t)}
                        className="flex-1 min-w-0 text-left group"
                        title="Click to preview"
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <Bookmark className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                          <span className="font-semibold text-stone-900 truncate group-hover:underline">
                            {t.template_name || t.title || "(untitled template)"}
                          </span>
                        </div>
                        <div className="text-xs text-stone-500 mt-1 flex items-center gap-3 flex-wrap">
                          <span className="inline-flex items-center gap-1">
                            <Calendar className="w-3 h-3" /> Saved {fmtDate(t.created_at)}
                          </span>
                          <span>· {(t.panels || []).length} section{(t.panels || []).length === 1 ? "" : "s"}</span>
                        </div>
                      </button>
                      <button
                        onClick={() => duplicateCampaign(t)}
                        data-testid={`marketing-template-use-${t.id}`}
                        className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-[#dddd16] rounded-lg flex items-center gap-1.5"
                      >
                        <Plus className="w-3.5 h-3.5" /> Use Template
                      </button>
                      <button
                        onClick={() => deleteTemplate(t)}
                        className="text-stone-400 hover:text-red-600 p-2"
                        title="Delete template"
                        data-testid={`marketing-template-delete-${t.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {drafts.length > 0 && (
              <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
                <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
                  <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700 flex items-center gap-1.5">
                    <FileText className="w-3 h-3" /> Drafts ({drafts.length})
                  </div>
                </div>
                <ul className="divide-y divide-stone-100" data-testid="marketing-draft-list">
                  {drafts.map((c) => (
                    <li key={c.id} className="px-5 py-3 flex items-center gap-4 flex-wrap" data-testid={`marketing-draft-${c.id}`}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-stone-900 truncate">{c.title || "(untitled draft)"}</span>
                          <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded bg-stone-100 text-stone-700 border border-stone-300">
                            Draft
                          </span>
                        </div>
                        <div className="text-xs text-stone-500 mt-1 flex items-center gap-3 flex-wrap">
                          <span className="inline-flex items-center gap-1">
                            <Calendar className="w-3 h-3" /> Saved {fmtDate(c.updated_at || c.created_at)}
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => openCompose(c)}
                        data-testid={`marketing-draft-edit-${c.id}`}
                        className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-lg flex items-center gap-1.5"
                      >
                        <Pencil className="w-3.5 h-3.5" /> Edit
                      </button>
                      <button
                        onClick={() => duplicateCampaign(c)}
                        data-testid={`marketing-draft-duplicate-${c.id}`}
                        title="Duplicate to a new draft"
                        className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-lg flex items-center gap-1.5"
                      >
                        <Copy className="w-3.5 h-3.5" /> Duplicate
                      </button>
                      <button
                        onClick={() => saveAsTemplate(c)}
                        data-testid={`marketing-draft-save-template-${c.id}`}
                        title="Save as template"
                        className="text-stone-400 hover:text-amber-600 p-2"
                      >
                        <Bookmark className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => deleteCampaign(c)}
                        data-testid={`marketing-draft-delete-${c.id}`}
                        className="text-stone-400 hover:text-red-600 p-2"
                        title="Delete draft"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700 flex items-center gap-1.5">
                  <Mail className="w-3 h-3" /> Past campaigns ({sent.length})
                </div>
                <button
                  onClick={loadCampaigns}
                  title="Reload"
                  className="p-1.5 border border-stone-200 rounded-md hover:bg-stone-50"
                  data-testid="marketing-reload"
                >
                  <RefreshCw className="w-3.5 h-3.5 text-stone-600" />
                </button>
              </div>
              {loading ? (
                <div className="flex items-center justify-center min-h-[160px] text-stone-500">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
                </div>
              ) : sent.length === 0 ? (
                <div className="px-6 py-10 text-center text-sm text-stone-500">
                  No campaigns sent yet. Click <strong>New Campaign</strong> to send your first marketing e-shot.
                </div>
              ) : (
                <ul className="divide-y divide-stone-100" data-testid="marketing-campaign-list">
                  {sent.map((c) => (
                    <li key={c.id} className="px-5 py-3 flex items-center gap-4 flex-wrap" data-testid={`marketing-campaign-${c.id}`}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-stone-900 truncate">{c.title}</span>
                          <DeliveryPill status={c.delivery?.status} />
                        </div>
                        <div className="text-xs text-stone-500 mt-1 flex items-center gap-3 flex-wrap">
                          <span className="inline-flex items-center gap-1">
                            <Calendar className="w-3 h-3" /> {fmtDate(c.sent_at || c.created_at)}
                          </span>
                          <span>· {c.recipient_count} recipient{c.recipient_count === 1 ? "" : "s"}</span>
                          <span>· <strong className="text-emerald-700">{c.opens_count || 0}</strong> opens</span>
                          {(c.clicks_count || 0) > 0 && (
                            <span>· <strong className="text-blue-700">{c.clicks_count}</strong> clicks</span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => setReportId(c.id)}
                        data-testid={`marketing-campaign-report-${c.id}`}
                        className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-lg flex items-center gap-1.5"
                      >
                        <Eye className="w-3.5 h-3.5" /> Report
                      </button>
                      <button
                        onClick={() => duplicateCampaign(c)}
                        data-testid={`marketing-campaign-duplicate-${c.id}`}
                        title="Duplicate to a new draft"
                        className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider border border-stone-300 hover:bg-stone-50 text-stone-700 rounded-lg flex items-center gap-1.5"
                      >
                        <Copy className="w-3.5 h-3.5" /> Duplicate
                      </button>
                      <button
                        onClick={() => saveAsTemplate(c)}
                        data-testid={`marketing-campaign-save-template-${c.id}`}
                        title="Save as template"
                        className="text-stone-400 hover:text-amber-600 p-2"
                      >
                        <Bookmark className="w-4 h-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        );
      })()}

      <MarketingComposeModal
        open={composeOpen}
        access={access}
        draft={editingDraft}
        preselectClientId={preselectClientId}
        onClose={() => { setComposeOpen(false); setEditingDraft(null); setPreselectClientId(null); }}
        onDraftSaved={() => { loadCampaigns(); }}
        onSent={() => { setComposeOpen(false); setEditingDraft(null); setPreselectClientId(null); loadCampaigns(); }}
      />

      <MarketingCampaignReport
        campaignId={reportId}
        onClose={() => setReportId(null)}
      />

      {/* Template preview modal — shows the rendered e-shot HTML in an
          iframe so the franchisee can sanity-check before clicking
          "Use Template" (which duplicates it into a new draft). */}
      {previewingTemplate && (
        <div
          className="fixed inset-0 z-[100] bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-6"
          data-testid="marketing-template-preview"
          onClick={() => setPreviewingTemplate(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full max-h-[88vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-stone-200">
              <div className="flex items-center gap-2">
                <Bookmark className="w-4 h-4 text-amber-600" />
                <span className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">Template preview</span>
                <span className="text-sm font-semibold text-stone-900 ml-2 truncate max-w-[280px]">{previewingTemplate.template_name || previewingTemplate.title}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { const t = previewingTemplate; setPreviewingTemplate(null); duplicateCampaign(t); }}
                  data-testid="marketing-template-preview-use"
                  className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-[#dddd16] rounded-lg flex items-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" /> Use Template
                </button>
                <button
                  onClick={() => setPreviewingTemplate(null)}
                  className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-stone-50">
              {previewBusy ? (
                <div className="flex items-center justify-center min-h-[300px] text-stone-500">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" /> Rendering preview…
                </div>
              ) : (
                <iframe
                  title="Template preview"
                  srcDoc={previewHtml}
                  className="w-full min-h-[600px] bg-white border-0"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DeliveryPill({ status }) {
  const cfg = {
    sent: "bg-emerald-100 text-emerald-900 border border-emerald-300",
    partial: "bg-amber-100 text-amber-900 border border-amber-300",
    failed: "bg-red-100 text-red-900 border border-red-300",
    pending: "bg-stone-100 text-stone-700 border border-stone-300",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded ${cfg[status] || cfg.pending}`}>
      {status || "pending"}
    </span>
  );
}
