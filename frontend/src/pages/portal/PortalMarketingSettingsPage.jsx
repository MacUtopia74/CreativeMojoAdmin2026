// Marketing settings — per-franchisee preferences for e-shots.
//
//   • Where the Creative Mojo logo at the top of every e-shot links to
//     (the franchisee's Facebook page or their Mojo franchise page).
//   • The Facebook URL itself, so the per-send "Include Facebook in
//     footer" checkbox has somewhere to point to.
//   • The Mojo franchise page URL is sourced from the franchisee's
//     `wp_page_url` (admin-managed) so franchisees never have to keep
//     it in sync themselves — we just show it read-only here.
//
// Persists to `/api/portal/marketing/settings` on save.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Sparkles, Loader2, AlertCircle, CheckCircle2, ArrowLeft,
  Facebook, Globe, Phone, Mail, Instagram, Link as LinkIcon,
} from "lucide-react";
import api from "@/lib/api";
import PortalPageHeading from "@/components/portal/PortalPageHeading";

export default function PortalMarketingSettingsPage() {
  const navigate = useNavigate();
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/portal/marketing/settings");
        setSettings(data);
      } catch (e) {
        setError(e?.response?.data?.detail || "Couldn't load your marketing settings.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    setSaving(true); setError(""); setSaved("");
    try {
      const { data } = await api.patch("/portal/marketing/settings", {
        logo_target: settings.logo_target,
        facebook_url: settings.facebook_url || "",
        instagram_url: settings.instagram_url || "",
        custom_link_label: settings.custom_link_label || "",
        custom_link_url: settings.custom_link_url || "",
      });
      setSettings((s) => ({ ...s, ...data.marketing_settings }));
      setSaved("Saved — your next e-shot will use these settings.");
      setTimeout(() => setSaved(""), 4000);
    } catch (e) {
      setError(e?.response?.data?.detail || "Save failed.");
    } finally { setSaving(false); }
  };

  return (
    <div className="px-4 sm:px-6 py-6 max-w-3xl mx-auto" data-testid="marketing-settings-page">
      <button
        onClick={() => navigate("/portal/marketing")}
        data-testid="back-to-marketing"
        className="text-xs font-bold uppercase tracking-wider text-stone-600 hover:text-stone-950 inline-flex items-center gap-1 mb-3"
      >
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Marketing
      </button>
      <PortalPageHeading
        eyebrow="E-shot defaults"
        icon={Sparkles}
        title="Marketing settings"
        subtitle="These choices apply to every e-shot you send from here on."
      />

      {loading ? (
        <div className="text-sm text-stone-500 flex items-center gap-2 mt-6">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : !settings ? (
        <div className="text-sm text-stone-500 mt-6">No settings available.</div>
      ) : (
        <div className="mt-6 space-y-6">
          {/* Logo destination */}
          <section className="bg-white border border-stone-200 rounded-2xl p-5">
            <h2 className="font-display text-xl font-bold text-stone-950 mb-1">
              When recipients click the Creative Mojo logo…
            </h2>
            <p className="text-sm text-stone-600 mb-4">
              Pick where you'd like the logo at the top of every e-shot to take them.
            </p>
            <div className="space-y-2">
              <label className={`flex items-start gap-3 p-3 border rounded-xl cursor-pointer ${settings.logo_target === "mojo_page" ? "border-stone-950 bg-stone-50" : "border-stone-200 hover:bg-stone-50"}`}>
                <input
                  type="radio"
                  name="logo_target"
                  value="mojo_page"
                  checked={settings.logo_target === "mojo_page"}
                  onChange={() => setSettings((s) => ({ ...s, logo_target: "mojo_page" }))}
                  data-testid="logo-target-mojo"
                  className="mt-1 accent-stone-900"
                />
                <div className="min-w-0">
                  <div className="font-semibold text-stone-900 flex items-center gap-1.5">
                    <Globe className="w-3.5 h-3.5 text-stone-500" /> My Mojo franchise page
                  </div>
                  <div className="text-xs text-stone-600 mt-0.5 truncate">
                    {settings.mojo_page_url
                      ? <a href={settings.mojo_page_url} target="_blank" rel="noreferrer" className="underline">{settings.mojo_page_url}</a>
                      : <em className="text-amber-700">HQ hasn't set your franchise page URL yet — speak to Paul.</em>
                    }
                  </div>
                </div>
              </label>
              <label className={`flex items-start gap-3 p-3 border rounded-xl cursor-pointer ${settings.logo_target === "facebook" ? "border-stone-950 bg-stone-50" : "border-stone-200 hover:bg-stone-50"}`}>
                <input
                  type="radio"
                  name="logo_target"
                  value="facebook"
                  checked={settings.logo_target === "facebook"}
                  onChange={() => setSettings((s) => ({ ...s, logo_target: "facebook" }))}
                  data-testid="logo-target-facebook"
                  className="mt-1 accent-stone-900"
                />
                <div className="min-w-0">
                  <div className="font-semibold text-stone-900 flex items-center gap-1.5">
                    <Facebook className="w-3.5 h-3.5 text-blue-700" /> My Facebook page
                  </div>
                  <div className="text-xs text-stone-600 mt-0.5">
                    {settings.facebook_url || <em className="text-amber-700">Add your Facebook URL below first.</em>}
                  </div>
                </div>
              </label>
            </div>
          </section>

          {/* Facebook page URL */}
          <section className="bg-white border border-stone-200 rounded-2xl p-5">
            <h2 className="font-display text-xl font-bold text-stone-950 mb-1">
              Your Facebook page URL
            </h2>
            <p className="text-sm text-stone-600 mb-3">
              Used both for the "Find us on Facebook" footer link and (if you tick the option above) the logo click destination.
            </p>
            <input
              type="url"
              placeholder="https://www.facebook.com/CreativeMojoYourTown"
              value={settings.facebook_url || ""}
              onChange={(e) => setSettings((s) => ({ ...s, facebook_url: e.target.value }))}
              data-testid="settings-facebook-url"
              className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
            />
          </section>

          {/* Instagram URL */}
          <section className="bg-white border border-stone-200 rounded-2xl p-5">
            <h2 className="font-display text-xl font-bold text-stone-950 mb-1 flex items-center gap-2">
              <Instagram className="w-4 h-4 text-pink-600" /> Your Instagram URL
            </h2>
            <p className="text-sm text-stone-600 mb-3">
              Shown in the footer of your e-shots when "Include Instagram" is ticked on the send.
            </p>
            <input
              type="url"
              placeholder="https://www.instagram.com/creativemojo_yourtown"
              value={settings.instagram_url || ""}
              onChange={(e) => setSettings((s) => ({ ...s, instagram_url: e.target.value }))}
              data-testid="settings-instagram-url"
              className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
            />
          </section>

          {/* Custom footer link — anything you want to plug from your e-shot footer */}
          <section className="bg-white border border-stone-200 rounded-2xl p-5">
            <h2 className="font-display text-xl font-bold text-stone-950 mb-1 flex items-center gap-2">
              <LinkIcon className="w-4 h-4 text-stone-600" /> One more footer link
            </h2>
            <p className="text-sm text-stone-600 mb-3">
              A free-form footer link — handy for promoting your booking page, TikTok, a survey, anything you want.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr] gap-2">
              <input
                type="text"
                placeholder="Label (e.g. Book a class)"
                value={settings.custom_link_label || ""}
                onChange={(e) => setSettings((s) => ({ ...s, custom_link_label: e.target.value }))}
                data-testid="settings-custom-label"
                className="px-3 py-2 text-sm border border-stone-300 rounded-lg"
              />
              <input
                type="url"
                placeholder="https://…"
                value={settings.custom_link_url || ""}
                onChange={(e) => setSettings((s) => ({ ...s, custom_link_url: e.target.value }))}
                data-testid="settings-custom-url"
                className="px-3 py-2 text-sm border border-stone-300 rounded-lg"
              />
            </div>
          </section>

          {/* Read-only info */}
          <section className="bg-stone-50 border border-stone-200 rounded-2xl p-5 text-sm text-stone-700">
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 mb-2">From your profile</div>
            <div className="flex items-center gap-2 py-1">
              <Phone className="w-3.5 h-3.5 text-stone-500 shrink-0" />
              <span className="text-stone-600 w-16 shrink-0">Phone</span>
              <span className="font-mono text-stone-900">{settings.phone || <em className="text-stone-400 not-italic">— ask HQ to add</em>}</span>
            </div>
            <div className="flex items-center gap-2 py-1">
              <Mail className="w-3.5 h-3.5 text-stone-500 shrink-0" />
              <span className="text-stone-600 w-16 shrink-0">Email</span>
              <span className="font-mono text-stone-900">{settings.email || <em className="text-stone-400 not-italic">— ask HQ to add</em>}</span>
            </div>
            <div className="mt-2 text-xs text-stone-500">
              These come from your franchisee profile. Drop Paul a line if either needs changing.
            </div>
          </section>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-900 flex items-center gap-2">
              <AlertCircle className="w-4 h-4" /> {error}
            </div>
          )}
          {saved && (
            <div className="px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-900 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> {saved}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              onClick={() => navigate("/portal/marketing")}
              className="px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white hover:bg-stone-50 rounded-lg"
            >Cancel</button>
            <button
              onClick={save}
              disabled={saving}
              data-testid="save-marketing-settings"
              className="px-4 py-2 text-xs font-bold uppercase tracking-wider bg-stone-950 text-white hover:bg-stone-800 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Save settings
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
