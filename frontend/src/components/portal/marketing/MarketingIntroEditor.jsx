// Rich-text editor for the campaign Intro field.
//
// Supports:
//   • Bold, Italic, Underline
//   • Text colour (small palette + clear)
//   • Align Left / Centre / Right
//   • {{first_name}} placeholder insert (used for the "Hi {{first_name}},"
//     greeting that personalises every send).
//
// Sends HTML to the parent via ``onChange(html)``. The backend
// sanitiser (``_sanitise_intro_html``) keeps only ``<b><strong><i><em>
// <u><br><div><p><span>`` + ``style="text-align:…"`` and
// ``style="color:…"`` so nothing dangerous can slip into the
// recipient's inbox.
import { useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import {
  Bold, Italic, Underline as UnderlineIcon, AlignLeft, AlignCenter,
  AlignRight, Palette, User,
} from "lucide-react";

const SANITIZE_CFG = {
  ALLOWED_TAGS: ["b", "strong", "i", "em", "u", "br", "div", "p", "span", "font"],
  ALLOWED_ATTR: ["style", "color"],
  ALLOWED_CSS_PROPERTIES: ["text-align", "color"],
};

const PALETTE = [
  "#1a1a1a", "#71717A", "#DC2626", "#EA580C",
  "#CA8A04", "#16A34A", "#0EA5E9", "#9333EA",
  "#DB2777", "#dddd16",
];

export default function MarketingIntroEditor({ value, onChange, placeholder, testid }) {
  const ref = useRef(null);
  const [palOpen, setPalOpen] = useState(false);

  // Only sync the incoming `value` into the DOM when it actually
  // differs — otherwise React would clobber the caret on every keystroke.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clean = value ? DOMPurify.sanitize(value, SANITIZE_CFG) : "";
    if (el.innerHTML !== clean) {
      el.innerHTML = clean;
    }
  }, [value]);

  const focusBack = () => {
    // Make sure subsequent execCommand calls operate on the editor's
    // active selection (toolbar buttons live outside the contentEditable).
    if (ref.current) ref.current.focus();
  };

  const exec = (cmd, val = null) => {
    focusBack();
    document.execCommand(cmd, false, val);
    if (ref.current) onChange(ref.current.innerHTML);
  };

  const insertPlaceholder = () => {
    focusBack();
    document.execCommand("insertHTML", false, "{{first_name}}");
    if (ref.current) onChange(ref.current.innerHTML);
  };

  return (
    <div
      className="border border-stone-300 rounded-xl overflow-hidden focus-within:border-stone-950 bg-white"
      data-testid={testid}
    >
      <div className="flex items-center gap-1 px-2 py-1.5 bg-stone-50 border-b border-stone-200 flex-wrap">
        <ToolBtn icon={Bold} title="Bold" onClick={() => exec("bold")} testid={`${testid}-bold`} />
        <ToolBtn icon={Italic} title="Italic" onClick={() => exec("italic")} testid={`${testid}-italic`} />
        <ToolBtn icon={UnderlineIcon} title="Underline" onClick={() => exec("underline")} testid={`${testid}-underline`} />
        <span className="w-px h-4 bg-stone-300 mx-1" />
        <ToolBtn icon={AlignLeft} title="Align left" onClick={() => exec("justifyLeft")} testid={`${testid}-align-left`} />
        <ToolBtn icon={AlignCenter} title="Align centre" onClick={() => exec("justifyCenter")} testid={`${testid}-center`} />
        <ToolBtn icon={AlignRight} title="Align right" onClick={() => exec("justifyRight")} testid={`${testid}-align-right`} />
        <span className="w-px h-4 bg-stone-300 mx-1" />
        <div className="relative">
          <ToolBtn icon={Palette} title="Text colour" onClick={() => setPalOpen((o) => !o)} testid={`${testid}-color`} />
          {palOpen && (
            <div
              className="absolute z-20 top-full mt-1 left-0 p-2 bg-white border border-stone-300 rounded-lg shadow-lg flex flex-wrap gap-1.5 w-[148px]"
              data-testid={`${testid}-color-palette`}
            >
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="w-5 h-5 rounded-full border border-stone-300"
                  style={{ background: c }}
                  title={c}
                  onMouseDown={(e) => { e.preventDefault(); exec("foreColor", c); setPalOpen(false); }}
                />
              ))}
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); exec("foreColor", "#1a1a1a"); setPalOpen(false); }}
                className="text-[10px] font-bold uppercase tracking-wider text-stone-500 hover:text-stone-900 px-1 mt-1 w-full text-left"
              >Reset</button>
            </div>
          )}
        </div>
        <span className="w-px h-4 bg-stone-300 mx-1" />
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); insertPlaceholder(); }}
          title="Insert {{first_name}} placeholder — replaced with the recipient's name on send"
          data-testid={`${testid}-insert-name`}
          className="h-7 px-2 inline-flex items-center gap-1 rounded hover:bg-stone-200 text-stone-700 text-[10px] font-bold uppercase tracking-wider"
        >
          <User className="w-3 h-3" /> Insert name
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

function ToolBtn({ icon: Icon, title, onClick, testid }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      title={title}
      data-testid={testid}
      className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-stone-200 text-stone-700"
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  );
}
