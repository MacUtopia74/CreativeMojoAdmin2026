// Read-only view of a completed DBS application. Renders everything
// the franchisee submitted, plus signed URLs for each uploaded ID
// document (opens in a new tab).
import { useEffect, useState } from "react";
import { X, Loader2, FileText, Eye, EyeOff, Printer } from "lucide-react";
import api from "@/lib/api";
import { toast } from "sonner";

function Section({ title, children }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-widest text-stone-500 border-b border-stone-200 pb-1 mb-3">{title}</div>
      <div className="space-y-2 text-sm">{children}</div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <div className="text-stone-500 text-xs">{label}</div>
      <div className="col-span-2 text-stone-950">{value ?? <span className="text-stone-400">—</span>}</div>
    </div>
  );
}

export default function DBSApplicationView({ applicationId, onClose }) {
  const [app, setApp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [revealNi, setRevealNi] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get(`/dbs/applications/${applicationId}`);
        setApp(data);
      } catch (e) {
        toast.error("Could not load application");
      } finally {
        setLoading(false);
      }
    })();
  }, [applicationId]);

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-white" />
      </div>
    );
  }
  if (!app) return null;
  const d = app.data || {};
  const addresses = Array.isArray(d.addresses) ? d.addresses : [];
  const docUrls = app.document_urls || [];

  return (
    <div className="fixed inset-0 bg-black/80 z-[60] flex items-start justify-center p-4 overflow-y-auto" data-testid="dbs-view-modal">
      <div className="w-full max-w-3xl bg-white rounded-2xl mt-8 mb-8 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200 sticky top-0 bg-white z-10">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-stone-500 font-bold">DBS Application</div>
            <div className="font-display text-lg text-stone-950">{d.forename} {d.surname}</div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => window.print()} className="p-2 rounded-lg hover:bg-stone-100" title="Print">
              <Printer className="w-4 h-4" />
            </button>
            <button onClick={onClose} data-testid="dbs-view-close" className="p-2 rounded-lg hover:bg-stone-100">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-6 space-y-6" data-testid="dbs-view-content">
          <Section title="General Information">
            <Field label="Title" value={d.title} />
            <Field label="Forename" value={d.forename} />
            <Field label="Middle Names" value={d.middle_names} />
            <Field label="Surname" value={d.surname} />
            <Field label="Date of Birth" value={d.date_of_birth} />
            <Field label="Gender" value={d.gender} />
            <Field label="NI Number" value={
              <span className="inline-flex items-center gap-2">
                <span className="font-mono">{revealNi ? d.ni_number : (app.ni_number_masked || "•••")}</span>
                <button onClick={() => setRevealNi((v) => !v)} className="p-1 rounded hover:bg-stone-100 text-stone-500" title={revealNi ? "Hide" : "Reveal"}>
                  {revealNi ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </span>
            } />
            <Field label="Language" value={d.language} />
            <Field label="Telephone No." value={d.telephone} />
            <Field label="Email Address" value={d.email} />
          </Section>

          <Section title="Address History">
            {addresses.length === 0 ? <div className="text-stone-400 text-sm">No addresses submitted.</div> : addresses.map((a, i) => (
              <div key={i} className="border-l-2 border-stone-200 pl-3 py-1">
                <div className="text-xs text-stone-500 mb-1">Address {i + 1} · {a.from || "—"} → {a.to || "—"}</div>
                <div className="whitespace-pre-line">{a.address}</div>
              </div>
            ))}
          </Section>

          <Section title="Place of Birth">
            <Field label="Town" value={d.pob_town} />
            <Field label="County" value={d.pob_county} />
            <Field label="Country" value={d.pob_country} />
            <Field label="Nationality at Birth" value={d.nationality_at_birth} />
            <Field label="Current Nationality" value={d.current_nationality} />
          </Section>

          <Section title="Birth Surname">
            <Field label="Surname at Birth" value={d.birth_surname} />
            <Field label="Used Until" value={d.birth_surname_used_until} />
          </Section>

          <Section title="Conviction History">
            <Field label="Any Convictions" value={d.has_convictions === "yes" ? "Yes" : d.has_convictions === "no" ? "No" : "—"} />
            {d.has_convictions === "yes" && (
              <Field label="Details" value={<span className="whitespace-pre-line">{d.conviction_details}</span>} />
            )}
          </Section>

          <Section title="Identifying Documents">
            {[0, 1, 2].map((i) => {
              const type = d[`document_${i + 1}_type`];
              const url = docUrls[i]?.url;
              return (
                <div key={i} className="border border-stone-200 rounded-lg p-3 flex items-center gap-3">
                  <div className="flex-1">
                    <div className="text-[10px] uppercase tracking-widest text-stone-500 font-bold">Document {i + 1}</div>
                    <div className="text-sm">{type || <span className="text-stone-400">— not selected —</span>}</div>
                  </div>
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer"
                      data-testid={`dbs-view-doc-${i + 1}`}
                      className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider border border-stone-950 bg-stone-950 text-[#dddd16] hover:bg-stone-800 rounded-md flex items-center gap-1">
                      <FileText className="w-3.5 h-3.5" /> Open
                    </a>
                  ) : (
                    <span className="text-xs text-stone-400">No upload</span>
                  )}
                </div>
              );
            })}
          </Section>
        </div>
      </div>
    </div>
  );
}
