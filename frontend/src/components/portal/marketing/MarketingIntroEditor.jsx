// Tiny rich-text editor for the campaign Intro field. Allows the
// franchisee to **bold** and **centre** the selected text inside a
// contentEditable surface — that's it. We deliberately keep the
// toolbar narrow because every extra format means more sanitisation
// work on the backend and more chance of email-client mis-render.
//
// Sends HTML to the parent via ``onChange(html)``. The backend
// sanitiser (``_sanitise_intro_html``) keeps only ``<b><strong><i><em>
// <u><br><div><p><span>`` + ``style="text-align:…"``, so nothing
// dangerous can slip into the recipient's inbox.
import { useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import { Bold, AlignCenter } from "lucide-react";

// Allowlist mirrors the backend ``_sanitise_intro_html`` so what the
// editor renders matches what the email send pipeline will accept.
// DOMPurify gives us belt-and-braces XSS protection on the hydration
// path: if a draft was somehow tampered with in Mongo, this strips
// any script/iframe/event-handler before it ever reaches the DOM.
const SANITIZE_CFG = {
  ALLOWED_TAGS: ["b", "strong", "i", "em", "u", "br", "div", "p", "span"],
  ALLOWED_ATTR: ["style"],
  ALLOWED_CSS_PROPERTIES: ["text-align"],
};

export default function MarketingIntroEditor({ value, onChange, placeholder, testid }) {
  const ref = useRef(null);

  // Only sync the incoming `value` into the DOM when it actually
  // differs — otherwise React would clobber the caret on every keystroke.
  // Hydration runs incoming HTML through DOMPurify so a tampered/legacy
  // draft can never inject script/iframe content.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clean = value ? DOMPurify.sanitize(value, SANITIZE_CFG) : "";
    if (el.innerHTML !== clean) {
      el.innerHTML = clean;
    }
  }, [value]);

  const exec = (cmd) => {
    // document.execCommand is "deprecated" by spec but every browser
    // still ships it and there is no agreed-on replacement that works
    // inside a contentEditable. The output is exactly what we want
    // (a wrapping `<b>` / `text-align: center` style), and the
    // backend sanitiser is the security boundary either way.
    document.execCommand(cmd, false, null);
    if (ref.current) onChange(ref.current.innerHTML);
  };

  return (
    <div className="border border-stone-300 rounded-xl overflow-hidden focus-within:border-stone-950 bg-white" data-testid={testid}>
      <div className="flex items-center gap-1 px-2 py-1.5 bg-stone-50 border-b border-stone-200">
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); exec("bold"); }}
          className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-stone-200 text-stone-700"
          title="Bold (selected text)"
          data-testid={`${testid}-bold`}
        >
          <Bold className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); exec("justifyCenter"); }}
          className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-stone-200 text-stone-700"
          title="Centre alignment (current line)"
          data-testid={`${testid}-center`}
        >
          <AlignCenter className="w-3.5 h-3.5" />
        </button>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-stone-400">Rich text</span>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={(e) => onChange(e.currentTarget.innerHTML)}
        data-placeholder={placeholder || "Type here…"}
        className="min-h-[120px] p-3 text-sm leading-relaxed focus:outline-none cm-rte"
        data-testid={`${testid}-area`}
      />
      <style>{`.cm-rte:empty::before{content:attr(data-placeholder);color:#a8a29e;}`}</style>
    </div>
  );
}
