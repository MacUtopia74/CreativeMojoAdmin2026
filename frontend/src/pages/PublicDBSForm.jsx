// Public DBS application form — token-gated, no auth. The franchisee
// receives this URL by email and fills the form. On submit the data is
// persisted and admin sees it on the franchisee's admin page.
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Loader2, Plus, Trash2, Upload, CheckCircle2, AlertTriangle } from "lucide-react";
import api from "@/lib/api";
import { toast } from "sonner";
import { DOCUMENT_1_OPTIONS, DOCUMENT_2_3_OPTIONS } from "@/lib/dbsDocumentOptions";

function Section({ title, children, subtitle }) {
  return (
    <section className="bg-white border border-stone-200 rounded-xl p-5 md:p-6 space-y-4">
      <header>
        <h2 className="font-display text-lg md:text-xl text-stone-950 uppercase tracking-wide">{title}</h2>
        {subtitle && <p className="text-xs text-stone-500 mt-1">{subtitle}</p>}
      </header>
      {children}
    </section>
  );
}

function Field({ label, required, children }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-widest font-bold text-stone-700">
        {label}{required && <span className="text-red-600 ml-1">*</span>}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

const inputCls = "w-full px-3 py-2 border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-stone-950 text-sm";

export default function PublicDBSForm() {
  const { token } = useParams();
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submittedOk, setSubmittedOk] = useState(false);
  const [uploads, setUploads] = useState({ 1: null, 2: null, 3: null }); // { name, size }
  const [uploadingSlot, setUploadingSlot] = useState(null);
  const [form, setForm] = useState({
    title: "",
    forename: "",
    middle_names: "",
    surname: "",
    date_of_birth: "",
    gender: "",
    ni_number: "",
    language: "English",
    telephone: "",
    email: "",
    addresses: [{ address: "", from: "", to: "" }],
    pob_town: "",
    pob_county: "",
    pob_country: "",
    nationality_at_birth: "",
    current_nationality: "",
    birth_surname: "",
    birth_surname_used_until: "",
    has_convictions: "",
    conviction_details: "",
    document_1_type: "",
    document_2_type: "",
    document_3_type: "",
  });

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get(`/dbs/public/${token}`);
        setMeta(data);
        if (data?.already_submitted) {
          setSubmittedOk(true);
        } else if (data?.prefill_email) {
          setForm((f) => ({
            ...f,
            forename: data.franchisee_first_name || f.forename,
            surname: data.franchisee_last_name || f.surname,
            email: data.prefill_email || f.email,
          }));
        }
      } catch (e) {
        setError(e?.response?.data?.detail || "This DBS form link is not valid or has expired.");
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setAddr = (i, k, v) => setForm((f) => {
    const next = [...f.addresses]; next[i] = { ...next[i], [k]: v };
    return { ...f, addresses: next };
  });
  const addAddress = () => setForm((f) => ({ ...f, addresses: [...f.addresses, { address: "", from: "", to: "" }] }));
  const rmAddress = (i) => setForm((f) => ({ ...f, addresses: f.addresses.filter((_, idx) => idx !== i) }));

  const upload = async (slot, file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast.error("File too large — max 10MB");
      return;
    }
    setUploadingSlot(slot);
    try {
      const fd = new FormData();
      fd.append("slot", String(slot));
      fd.append("file", file);
      await api.post(`/dbs/public/${token}/upload`, fd, { headers: { "Content-Type": "multipart/form-data" } });
      setUploads((u) => ({ ...u, [slot]: { name: file.name, size: file.size } }));
      toast.success(`Document ${slot} uploaded`);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Upload failed");
    } finally {
      setUploadingSlot(null);
    }
  };

  const submit = async () => {
    // Client-side validation.
    const missing = [];
    if (!form.forename.trim()) missing.push("Forename");
    if (!form.surname.trim()) missing.push("Surname");
    if (!form.date_of_birth) missing.push("Date of Birth");
    if (!form.email.trim()) missing.push("Email");
    if (!form.addresses.length || !form.addresses[0].address.trim()) missing.push("At least one address");
    if (form.has_convictions === "yes" && !form.conviction_details.trim()) missing.push("Conviction details");
    if (!form.document_1_type) missing.push("Document 1 type");
    if (!form.document_2_type) missing.push("Document 2 type");
    if (!form.document_3_type) missing.push("Document 3 type");
    for (const s of [1, 2, 3]) if (!uploads[s]) missing.push(`Document ${s} upload`);
    if (missing.length) {
      toast.error(`Please complete: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? `, +${missing.length - 3} more` : ""}`);
      return;
    }
    setSubmitting(true);
    try {
      await api.post(`/dbs/public/${token}/submit`, { data: form });
      setSubmittedOk(true);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Submit failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-stone-500" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center p-6">
        <div className="max-w-md bg-white border border-red-200 rounded-xl p-6 text-center">
          <AlertTriangle className="w-8 h-8 text-red-500 mx-auto mb-3" />
          <h1 className="font-display text-xl mb-2">Link no longer valid</h1>
          <p className="text-sm text-stone-600">{error}</p>
        </div>
      </div>
    );
  }
  if (submittedOk) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center p-6" data-testid="dbs-submitted-thanks">
        <div className="max-w-md bg-white border border-emerald-200 rounded-xl p-6 text-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-3" />
          <h1 className="font-display text-2xl mb-2">Thank you!</h1>
          <p className="text-sm text-stone-600">Your DBS application has been submitted. Creative Mojo HQ will be in touch once it&apos;s processed.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-50 py-8 px-4">
      <div className="max-w-3xl mx-auto space-y-4" data-testid="dbs-public-form">
        <header className="text-center mb-6">
          <div className="text-[11px] uppercase tracking-widest font-bold text-stone-500">Creative Mojo</div>
          <h1 className="font-display text-3xl md:text-4xl text-stone-950 mt-1">DBS Application Form</h1>
          <p className="text-sm text-stone-600 mt-2">Please complete every section. Your data is kept confidential and used only to process your DBS check.</p>
        </header>

        <Section title="General Information">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Title"><input className={inputCls} value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="Mr / Mrs / Ms / Dr / Other" data-testid="dbs-title" /></Field>
            <Field label="Forename" required><input className={inputCls} value={form.forename} onChange={(e) => set("forename", e.target.value)} data-testid="dbs-forename" /></Field>
            <Field label="Middle Names"><input className={inputCls} value={form.middle_names} onChange={(e) => set("middle_names", e.target.value)} data-testid="dbs-middle" /></Field>
            <Field label="Surname" required><input className={inputCls} value={form.surname} onChange={(e) => set("surname", e.target.value)} data-testid="dbs-surname" /></Field>
            <Field label="Date of Birth" required><input type="date" className={inputCls} value={form.date_of_birth} onChange={(e) => set("date_of_birth", e.target.value)} data-testid="dbs-dob" /></Field>
            <Field label="Gender">
              <select className={inputCls} value={form.gender} onChange={(e) => set("gender", e.target.value)} data-testid="dbs-gender">
                <option value="">— Select —</option>
                <option>Female</option><option>Male</option><option>Non-binary</option><option>Prefer not to say</option>
              </select>
            </Field>
            <Field label="NI Number"><input className={inputCls} value={form.ni_number} onChange={(e) => set("ni_number", e.target.value.toUpperCase())} placeholder="QQ123456C" data-testid="dbs-ni" /></Field>
            <Field label="Language"><input className={inputCls} value={form.language} onChange={(e) => set("language", e.target.value)} data-testid="dbs-language" /></Field>
            <Field label="Telephone No."><input className={inputCls} value={form.telephone} onChange={(e) => set("telephone", e.target.value)} data-testid="dbs-phone" /></Field>
            <Field label="Email Address" required><input type="email" className={inputCls} value={form.email} onChange={(e) => set("email", e.target.value)} data-testid="dbs-email" /></Field>
          </div>
        </Section>

        <Section title="Address History" subtitle="Please provide your full address history for each property covering the last 5 years. Please include month and year to and from.">
          {form.addresses.map((a, i) => (
            <div key={i} className="border border-stone-200 rounded-lg p-3 space-y-2" data-testid={`dbs-address-${i}`}>
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-widest font-bold text-stone-500">Address {i + 1}</div>
                {form.addresses.length > 1 && (
                  <button onClick={() => rmAddress(i)} className="p-1 text-red-500 hover:bg-red-50 rounded" title="Remove">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
              <Field label="Full Address" required>
                <textarea rows={2} className={inputCls} value={a.address} onChange={(e) => setAddr(i, "address", e.target.value)}
                  placeholder="House number/name, street, town, county, postcode" data-testid={`dbs-address-input-${i}`} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="From (Month/Year)"><input type="month" className={inputCls} value={a.from} onChange={(e) => setAddr(i, "from", e.target.value)} data-testid={`dbs-address-from-${i}`} /></Field>
                <Field label="To (Month/Year)"><input type="month" className={inputCls} value={a.to} onChange={(e) => setAddr(i, "to", e.target.value)} placeholder="Or 'Present'" data-testid={`dbs-address-to-${i}`} /></Field>
              </div>
            </div>
          ))}
          <button onClick={addAddress} data-testid="dbs-add-address"
            className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-stone-700 hover:text-stone-950">
            <Plus className="w-4 h-4" /> Add additional address
          </button>
        </Section>

        <Section title="Place of Birth">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Town"><input className={inputCls} value={form.pob_town} onChange={(e) => set("pob_town", e.target.value)} /></Field>
            <Field label="County"><input className={inputCls} value={form.pob_county} onChange={(e) => set("pob_county", e.target.value)} /></Field>
            <Field label="Country"><input className={inputCls} value={form.pob_country} onChange={(e) => set("pob_country", e.target.value)} /></Field>
            <Field label="Nationality at Birth"><input className={inputCls} value={form.nationality_at_birth} onChange={(e) => set("nationality_at_birth", e.target.value)} /></Field>
            <Field label="Current Nationality"><input className={inputCls} value={form.current_nationality} onChange={(e) => set("current_nationality", e.target.value)} /></Field>
          </div>
        </Section>

        <Section title="Birth Surname">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Surname at Birth"><input className={inputCls} value={form.birth_surname} onChange={(e) => set("birth_surname", e.target.value)} /></Field>
            <Field label="Used Until"><input type="month" className={inputCls} value={form.birth_surname_used_until} onChange={(e) => set("birth_surname_used_until", e.target.value)} /></Field>
          </div>
        </Section>

        <Section title="Conviction History">
          <Field label="Do you have any convictions?" required>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2"><input type="radio" name="conv" value="yes" checked={form.has_convictions === "yes"} onChange={(e) => set("has_convictions", e.target.value)} data-testid="dbs-conv-yes" /> Yes</label>
              <label className="flex items-center gap-2"><input type="radio" name="conv" value="no" checked={form.has_convictions === "no"} onChange={(e) => set("has_convictions", e.target.value)} data-testid="dbs-conv-no" /> No</label>
            </div>
          </Field>
          {form.has_convictions === "yes" && (
            <Field label="Please fill out any details" required>
              <textarea rows={4} className={inputCls} value={form.conviction_details} onChange={(e) => set("conviction_details", e.target.value)} data-testid="dbs-conv-details" />
            </Field>
          )}
        </Section>

        <Section title="Identifying Documents" subtitle="We also need you to supply three identifying proof documents to support the application. Upload one image or PDF per document (max 10MB).">
          {[1, 2, 3].map((n) => {
            const opts = n === 1 ? DOCUMENT_1_OPTIONS : DOCUMENT_2_3_OPTIONS;
            const key = `document_${n}_type`;
            return (
              <div key={n} className="border border-stone-200 rounded-lg p-3 space-y-3">
                <Field label={`Please select your Document ${n}`} required>
                  <select className={inputCls} value={form[key]} onChange={(e) => set(key, e.target.value)} data-testid={`dbs-doc-${n}-type`}>
                    <option value="">— Select —</option>
                    {opts.map((o) => <option key={o}>{o}</option>)}
                  </select>
                </Field>
                <label className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="text-[11px] uppercase tracking-widest font-bold text-stone-700">Upload Document {n}<span className="text-red-600 ml-1">*</span></div>
                    <div className="text-xs text-stone-500 mt-0.5">
                      {uploads[n] ? <span className="text-emerald-700">✓ {uploads[n].name} ({(uploads[n].size / 1024).toFixed(0)} KB)</span> : "JPG, PNG, HEIC, WebP or PDF · Max 10MB"}
                    </div>
                  </div>
                  <span className="cursor-pointer px-3 py-2 text-[11px] font-bold uppercase tracking-wider border border-stone-950 bg-stone-950 text-[#dddd16] hover:bg-stone-800 rounded-md inline-flex items-center gap-1">
                    {uploadingSlot === n ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                    {uploads[n] ? "Replace" : "Upload"}
                    <input type="file" className="hidden" accept="image/*,application/pdf"
                      data-testid={`dbs-doc-${n}-upload`}
                      onChange={(e) => upload(n, e.target.files?.[0])} />
                  </span>
                </label>
              </div>
            );
          })}
        </Section>

        <div className="text-center pt-4">
          <button onClick={submit} disabled={submitting}
            data-testid="dbs-submit"
            className="px-6 py-3 text-sm font-bold uppercase tracking-widest bg-[#dddd16] text-stone-950 hover:bg-yellow-300 rounded-lg disabled:opacity-50 inline-flex items-center gap-2">
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            {submitting ? "Submitting…" : "Submit DBS Application"}
          </button>
        </div>
      </div>
    </div>
  );
}
