// Shared "In-House Launch Prep Checklist" modal — paper-style static form
// originally lived inside ContactsPage when the data hung off a contact.
// Now lives on a Franchisee record (after conversion) so the same modal
// is mounted from FranchiseeDetailPage. Generic over the "subject" — pass
// any record with ``first_name`` / ``last_name`` / ``launch_checklist`` /
// ``launch_checklist_updated_at`` plus the URL that should receive the
// PATCH payload (e.g. ``/franchisees/{id}/launch-checklist``).
import { useEffect, useState } from "react";
import api from "@/lib/api";
import { X, ClipboardList, CheckCircle2 } from "lucide-react";

const DEFAULTS = () => ({
  name: "",
  franchise_name_confirmed: "",
  // 1 Contract prep
  contract_full_name: false,
  contract_full_address: false,
  contract_mobile_same: false,
  // 2 Territory prep
  territory_defined_confirmed: false,
  territory_db_pdf_excel: false,
  // 3 Printed materials & docs — each row has aw + printed
  print_6pp_dl: { aw: false, printed: false },
  print_business_cards: { aw: false, printed: false },
  print_invoices: { aw: false, printed: false },
  print_feedback_forms: { aw: false, printed: false },
  print_care_of_duty: { aw: false, printed: false },
  print_toolbox_sticker: { aw: false, printed: false },
  // 4 Materials for kit
  kit_wheeled_trolley: false,
  kit_paint_pots: false,
  kit_sequins: false,
  kit_paintbrushes: false,
  kit_mixed_paper: false,
  kit_glue_gun: false,
  kit_stapler: false,
  kit_string: false,
  kit_pencils: false,
  kit_scissors: false,
  kit_apron: false,
  kit_requires_couriering: false,
  // 5 Email account
  email_define_address: false,
  email_address: "",
  email_setup_address: false,
  email_supply_video: false,
  // 6 Social media
  fb_configuration: false,
  fb_page_url: "",
  fb_confirmation_sent: false,
  fb_added_to_comfort_zone: false,
  // 7 Website listing
  web_added_to_cm: false,
  web_asked_bio_quote: false,
  web_bio_supplied: false,
  // 8 FileCamp
  fc_explain_use: false,
  fc_populate_folders: false,
  // 9 Launch
  launch_date_same_as_training: false,
  launch_date_if_not: "",
  // 10 DBS
  dbs_all_text_info: false,
  dbs_address_correct: false,
  dbs_three_proofs_id: false,
  dbs_own_dbs_checked: false,
  // Renewals & Direct Debits
  dd_mandate_setup: false,
});

export default function LaunchChecklistModal({ open, subject, endpoint, onClose, onSaved }) {
  const [state, setState] = useState(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // Hydrate from any saved value when the modal opens.
  useEffect(() => {
    if (!open) return;
    const stored = subject?.launch_checklist || {};
    const fullName = [subject?.first_name, subject?.last_name].filter(Boolean).join(" ");
    setState({ ...DEFAULTS(), ...stored, name: stored.name || fullName });
    setErr("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, subject?.id]);

  const persist = async (next) => {
    setSaving(true); setErr("");
    try {
      const { data } = await api.patch(endpoint, { launch_checklist: next });
      onSaved?.({
        launch_checklist: data.launch_checklist,
        launch_checklist_updated_at: data.launch_checklist_updated_at,
      });
    } catch (e) {
      setErr(e?.response?.data?.detail || "Could not save.");
    } finally { setSaving(false); }
  };

  const setField = (k, v) => setState((s) => { const next = { ...s, [k]: v }; persist(next); return next; });
  const setNestedField = (k, sub, v) => setState((s) => {
    const next = { ...s, [k]: { ...(s[k] || {}), [sub]: v } };
    persist(next);
    return next;
  });
  const setTextField = (k, v) => setState((s) => ({ ...s, [k]: v }));
  const flushText = (k, original) => {
    if ((state[k] || "") === (original || "")) return;
    persist(state);
  };

  if (!open || !subject) return null;

  const Tick = ({ k, label, sub }) => {
    const checked = sub ? !!state[k]?.[sub] : !!state[k];
    return (
      <label
        className="flex items-center justify-between gap-3 py-1.5 px-1 cursor-pointer hover:bg-stone-50 rounded"
        data-testid={`launch-${sub ? `${k}-${sub}` : k}`}
      >
        <span className="text-sm text-stone-800">{label}</span>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => (sub ? setNestedField(k, sub, e.target.checked) : setField(k, e.target.checked))}
          className="w-4 h-4 shrink-0 rounded border-stone-400 text-stone-950 focus:ring-stone-900"
        />
      </label>
    );
  };
  const SectionTitle = ({ children, big }) => (
    <h3 className={big ? "text-xl font-display text-stone-950 mt-4" : "text-[10px] uppercase tracking-[0.2em] font-bold text-white bg-stone-950 px-3 py-1.5 rounded-md mt-3 mb-2"}>
      {children}
    </h3>
  );

  return (
    <div onClick={onClose} className="fixed inset-0 z-[90] bg-stone-950/70 backdrop-blur-sm flex items-stretch justify-end" data-testid="launch-checklist-modal">
      <aside onClick={(e) => e.stopPropagation()}
        className="bg-stone-50 w-full max-w-3xl shadow-2xl overflow-y-auto h-full flex flex-col">
        <div className="px-6 py-3 bg-stone-950 text-[#dddd16] flex items-center justify-between gap-3 sticky top-0 z-10">
          <div className="flex items-center gap-2">
            <ClipboardList className="w-5 h-5" />
            <h2 className="font-bold uppercase tracking-[0.18em] text-sm">In-House Franchisee Launch Prep Checklist</h2>
          </div>
          <div className="flex items-center gap-2">
            {saving && <span className="text-[10px] uppercase tracking-[0.2em] text-stone-300">Saving…</span>}
            <button onClick={onClose} data-testid="launch-checklist-close" className="w-9 h-9 hover:bg-stone-800 rounded-lg flex items-center justify-center">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="bg-stone-200 px-6 py-3 grid grid-cols-[140px_1fr] gap-x-3 gap-y-2 items-center border-b border-stone-300">
          <label className="text-xs font-bold text-stone-700">Name:</label>
          <input
            value={state.name || ""}
            onChange={(e) => setTextField("name", e.target.value)}
            onBlur={() => flushText("name", subject.launch_checklist?.name)}
            data-testid="launch-name"
            className="px-3 py-1.5 text-sm bg-white border border-stone-300 rounded focus:outline-none focus:border-stone-900"
          />
          <label className="text-xs font-bold text-stone-700 leading-tight">Franchise Name<br/><span className="font-normal text-stone-500">(confirmed)</span></label>
          <input
            value={state.franchise_name_confirmed || ""}
            onChange={(e) => setTextField("franchise_name_confirmed", e.target.value)}
            onBlur={() => flushText("franchise_name_confirmed", subject.launch_checklist?.franchise_name_confirmed)}
            data-testid="launch-franchise-name"
            className="px-3 py-1.5 text-sm bg-white border border-stone-300 rounded focus:outline-none focus:border-stone-900"
          />
        </div>

        <div className="px-6 py-4 grid md:grid-cols-2 gap-x-8 gap-y-2 flex-1">
          <div>
            <SectionTitle big>Contract</SectionTitle>
            <SectionTitle>1 Contract preparation</SectionTitle>
            <Tick k="contract_full_name" label="Full Name" />
            <Tick k="contract_full_address" label="Full Address" />
            <Tick k="contract_mobile_same" label="Mobile/number same as on file?" />

            <SectionTitle>2 Territory preparation</SectionTitle>
            <Tick k="territory_defined_confirmed" label="Territory defined and confirmed" />
            <Tick k="territory_db_pdf_excel" label="Territory database PDF & Excel file created" />

            <SectionTitle big>Franchise Kit</SectionTitle>
            <SectionTitle>3 Printed marketing materials &amp; docs</SectionTitle>
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 grid grid-cols-[1fr_70px_70px] gap-2 px-1 pb-1 border-b border-stone-200">
              <span>Item</span>
              <span className="text-center">A/W done</span>
              <span className="text-center">Printed</span>
            </div>
            {[
              ["print_6pp_dl", "6pp DL x100"],
              ["print_business_cards", "2pp Business cards x100"],
              ["print_invoices", "Invoices"],
              ["print_feedback_forms", "Feedback Forms"],
              ["print_care_of_duty", "Care of Duty Forms"],
              ["print_toolbox_sticker", "Add sticker to front of toolbox"],
            ].map(([k, label]) => (
              <div key={k} className="grid grid-cols-[1fr_70px_70px] gap-2 px-1 py-1.5 items-center hover:bg-stone-50 rounded">
                <span className="text-sm text-stone-800">{label}</span>
                <div className="flex justify-center">
                  <input type="checkbox" checked={!!state[k]?.aw} onChange={(e) => setNestedField(k, "aw", e.target.checked)} data-testid={`launch-${k}-aw`} className="w-4 h-4 rounded border-stone-400 text-stone-950 focus:ring-stone-900" />
                </div>
                <div className="flex justify-center">
                  <input type="checkbox" checked={!!state[k]?.printed} onChange={(e) => setNestedField(k, "printed", e.target.checked)} data-testid={`launch-${k}-printed`} className="w-4 h-4 rounded border-stone-400 text-stone-950 focus:ring-stone-900" />
                </div>
              </div>
            ))}

            <SectionTitle>4 Materials for kit</SectionTitle>
            <Tick k="kit_wheeled_trolley" label="Wheeled Trolley" />
            <Tick k="kit_paint_pots" label="Paint & Plastic Pots" />
            <Tick k="kit_sequins" label="Sequins" />
            <Tick k="kit_paintbrushes" label="Paintbrushes" />
            <Tick k="kit_mixed_paper" label="1x Set of mixed paper" />
            <Tick k="kit_glue_gun" label="1x Glue Gun" />
            <Tick k="kit_stapler" label="Stapler & Staples" />
            <Tick k="kit_string" label="String" />
            <Tick k="kit_pencils" label="Pencils & Watercolour Pencils" />
            <Tick k="kit_scissors" label="Scissors" />
            <Tick k="kit_apron" label="Apron" />
            <div className="mt-2 pt-2 border-t border-stone-200">
              <Tick k="kit_requires_couriering" label="Does this franchise kit require couriering?" />
            </div>
          </div>

          <div>
            <SectionTitle big>Digital</SectionTitle>
            <SectionTitle>5 Email account</SectionTitle>
            <Tick k="email_define_address" label="Define email address with franchisee" />
            <div className="grid grid-cols-[110px_1fr] items-center gap-2 px-1 py-1.5">
              <span className="text-sm text-stone-800">Email address:</span>
              <input
                value={state.email_address || ""}
                onChange={(e) => setTextField("email_address", e.target.value)}
                onBlur={() => flushText("email_address", subject.launch_checklist?.email_address)}
                data-testid="launch-email-address"
                className="px-3 py-1 text-sm bg-white border border-stone-300 rounded focus:outline-none focus:border-stone-900"
              />
            </div>
            <Tick k="email_setup_address" label="Setup email address" />
            <Tick k="email_supply_video" label="Supply details to franchisee along with video of how to set up on their device" />

            <SectionTitle>6 Social media</SectionTitle>
            <Tick k="fb_configuration" label="Configuration of Facebook page" />
            <div className="grid grid-cols-[110px_1fr] items-center gap-2 px-1 py-1.5">
              <span className="text-sm text-stone-800">Facebook URL:</span>
              <input
                value={state.fb_page_url || ""}
                onChange={(e) => setTextField("fb_page_url", e.target.value)}
                onBlur={() => flushText("fb_page_url", subject.launch_checklist?.fb_page_url)}
                placeholder="https://facebook.com/…"
                data-testid="launch-fb-url"
                className="px-3 py-1 text-sm bg-white border border-stone-300 rounded focus:outline-none focus:border-stone-900"
              />
            </div>
            <Tick k="fb_confirmation_sent" label="Send confirmation of Facebook setup" />
            <Tick k="fb_added_to_comfort_zone" label="Add to Comfort Zone Facebook page" />

            <SectionTitle>7 Website listing</SectionTitle>
            <Tick k="web_added_to_cm" label="Add franchisee to CM website" />
            <Tick k="web_asked_bio_quote" label="Ask for a biography and/or quote" />
            <Tick k="web_bio_supplied" label="Have they supplied the biography" />

            <SectionTitle>8 FileCamp</SectionTitle>
            <Tick k="fc_explain_use" label="Explain about use" />
            <Tick k="fc_populate_folders" label="Populate their folders" />

            <SectionTitle>9 Launch</SectionTitle>
            <Tick k="launch_date_same_as_training" label="Launch date same as training" />
            <div className="grid grid-cols-[110px_1fr] items-center gap-2 px-1 py-1.5">
              <span className="text-sm text-stone-800 leading-tight">If NO — what date?</span>
              <input
                type="date"
                value={state.launch_date_if_not || ""}
                onChange={(e) => setTextField("launch_date_if_not", e.target.value)}
                onBlur={() => flushText("launch_date_if_not", subject.launch_checklist?.launch_date_if_not)}
                data-testid="launch-date-if-not"
                className="px-3 py-1 text-sm bg-white border border-stone-300 rounded focus:outline-none focus:border-stone-900"
              />
            </div>

            <SectionTitle big>DBS</SectionTitle>
            <SectionTitle>10 Information supplied</SectionTitle>
            <Tick k="dbs_all_text_info" label="All text information?" />
            <Tick k="dbs_address_correct" label="Address information correct?" />
            <Tick k="dbs_three_proofs_id" label="3 types of proof of ID supplied?" />
            <Tick k="dbs_own_dbs_checked" label="Do they have a DBS of their own (checked?)" />

            <SectionTitle big>Renewals &amp; Direct Debits</SectionTitle>
            <Tick k="dd_mandate_setup" label="Setup Direct Debit mandate" />
          </div>
        </div>

        <div className="px-6 py-3 border-t border-stone-200 bg-white sticky bottom-0 flex items-center justify-between text-xs text-stone-500">
          <span>Changes save automatically</span>
          <button onClick={onClose} data-testid="launch-checklist-done" className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 hover:bg-stone-800 text-[#dddd16] rounded-lg flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5" /> Done
          </button>
        </div>
        {err && <div className="px-6 py-2 bg-red-50 border-t border-red-200 text-sm text-red-700">{err}</div>}
      </aside>
    </div>
  );
}
