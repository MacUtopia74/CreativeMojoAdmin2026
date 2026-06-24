// Lightweight WYSIWYG editor for Email Templates. Uses Tiptap because
// it's headless (we own every pixel of the toolbar) and outputs clean
// semantic HTML that survives DOMPurify's sanitisation on the send
// path. We deliberately keep the toolbar SMALL — Paul writes franchise
// + licence enquiry replies, not novels: bold, italic, underline,
// bullet/numbered lists, link, headings (H2/H3), and an "insert HTML"
// escape hatch for the {{file:*}} CTA buttons we generate when the
// admin picks an R2 file.
import { useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold, Italic, Underline as UnderlineIcon, List, ListOrdered,
  Link2, Heading1, Heading2, Pilcrow, Undo2, Redo2, MousePointerClick, Square,
} from "lucide-react";

// Tiptap exports blank paragraphs as `<p></p>` or `<p><br></p>` (when the
// user hits Enter twice for a paragraph break). HTML collapses these to
// zero height, so the preview — and real email clients like Gmail/Outlook
// — show no visible gap between paragraphs. Inserting a `&nbsp;` gives
// the paragraph actual content, so it renders at one line of vertical
// space without otherwise affecting the layout. Cheap, idempotent, and
// safe to run on every editor update.
function normaliseEmptyParagraphs(html) {
  if (!html) return html;
  return html
    .replace(/<p>\s*<\/p>/g, "<p>&nbsp;</p>")
    .replace(/<p>\s*<br\s*\/?>\s*<\/p>/g, "<p>&nbsp;</p>");
}

export default function RichTextEditor({ value, onChange, placeholder, testIdPrefix = "rte", onInsertCta, onInsertOutline, signatureHtml = "", logoUrl = "" }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        codeBlock: false,
        horizontalRule: false,
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: {
          rel: "noopener noreferrer",
          target: "_blank",
          class: "text-stone-900 underline underline-offset-2",
        },
      }),
      Placeholder.configure({ placeholder: placeholder || "Start typing..." }),
    ],
    content: value || "",
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none min-h-[400px] p-6 focus:outline-none email-canvas",
        "data-testid": `${testIdPrefix}-area`,
      },
    },
    onUpdate: ({ editor: ed }) => {
      onChange?.(normaliseEmptyParagraphs(ed.getHTML()));
    },
  });

  // Sync external value changes (e.g. switching between templates in
  // the list) into the editor without breaking the user's cursor on
  // every keystroke — we only setContent when the incoming HTML
  // genuinely differs from the editor's current output.
  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    if ((value || "") !== current) {
      editor.commands.setContent(value || "", { emitUpdate: false });
    }
  }, [value, editor]);

  if (!editor) {
    return (
      <div className="border border-stone-300 rounded-lg bg-white min-h-[460px] flex items-center justify-center text-stone-400 text-xs">
        Loading editor…
      </div>
    );
  }

  // Wrap a Tiptap command + an active-state visual cue in one button.
  // Keeping the markup terse here because the toolbar has ~10 buttons.
  const Btn = ({ onClick, active, disabled, title, testId, children }) => (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}  // Stops the editor losing focus on click
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      className={`p-1.5 rounded transition-colors ${
        active ? "bg-stone-900 text-[#dddd16]" : "text-stone-700 hover:bg-stone-100"
      } disabled:opacity-30 disabled:cursor-not-allowed`}>
      {children}
    </button>
  );

  const addLink = () => {
    const prev = editor.getAttributes("link").href || "";
    const url = window.prompt("Link URL", prev);
    if (url === null) return;  // cancelled
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    // Add https:// if the admin typed a bare domain. Saves them remembering.
    const normalised = /^https?:\/\//i.test(url) || url.startsWith("mailto:") || url.startsWith("{{")
      ? url : `https://${url}`;
    editor.chain().focus().extendMarkRange("link").setLink({ href: normalised }).run();
  };

  return (
    <div className="border border-stone-300 rounded-lg bg-stone-50 overflow-hidden" data-testid={`${testIdPrefix}-wrapper`}>
      {/* Toolbar */}
      <div className="border-b border-stone-200 px-2 py-1.5 flex items-center gap-0.5 bg-stone-50 flex-wrap">
        <Btn onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          active={editor.isActive("heading", { level: 2 })}
          title="Heading" testId="rte-h2"><Heading1 className="w-4 h-4" /></Btn>
        <Btn onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          active={editor.isActive("heading", { level: 3 })}
          title="Subheading" testId="rte-h3"><Heading2 className="w-4 h-4" /></Btn>
        <Btn onClick={() => editor.chain().focus().setParagraph().run()}
          active={editor.isActive("paragraph")}
          title="Paragraph" testId="rte-p"><Pilcrow className="w-4 h-4" /></Btn>

        <div className="w-px h-5 bg-stone-300 mx-1" />

        <Btn onClick={() => editor.chain().focus().toggleBold().run()}
          active={editor.isActive("bold")}
          title="Bold (⌘B)" testId="rte-bold"><Bold className="w-4 h-4" /></Btn>
        <Btn onClick={() => editor.chain().focus().toggleItalic().run()}
          active={editor.isActive("italic")}
          title="Italic (⌘I)" testId="rte-italic"><Italic className="w-4 h-4" /></Btn>
        <Btn onClick={() => editor.chain().focus().toggleUnderline().run()}
          active={editor.isActive("underline")}
          title="Underline (⌘U)" testId="rte-underline"><UnderlineIcon className="w-4 h-4" /></Btn>

        <div className="w-px h-5 bg-stone-300 mx-1" />

        <Btn onClick={() => editor.chain().focus().toggleBulletList().run()}
          active={editor.isActive("bulletList")}
          title="Bullet list" testId="rte-ul"><List className="w-4 h-4" /></Btn>
        <Btn onClick={() => editor.chain().focus().toggleOrderedList().run()}
          active={editor.isActive("orderedList")}
          title="Numbered list" testId="rte-ol"><ListOrdered className="w-4 h-4" /></Btn>

        <div className="w-px h-5 bg-stone-300 mx-1" />

        <Btn onClick={addLink} active={editor.isActive("link")}
          title="Insert link" testId="rte-link"><Link2 className="w-4 h-4" /></Btn>
        {onInsertCta && (
          <Btn onClick={() => onInsertCta(editor)} title="Insert yellow CTA button" testId="rte-cta-yellow">
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#dddd16] text-stone-950 text-[10px] font-bold uppercase tracking-wider">
              <MousePointerClick className="w-3 h-3" />CTA
            </span>
          </Btn>
        )}
        {onInsertOutline && (
          <Btn onClick={() => onInsertOutline(editor)} title="Insert outline button" testId="rte-cta-outline">
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-stone-900 text-stone-950 text-[10px] font-bold uppercase tracking-wider">
              <Square className="w-3 h-3" />Outline
            </span>
          </Btn>
        )}

        <div className="flex-1" />

        <Btn onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
          title="Undo (⌘Z)" testId="rte-undo"><Undo2 className="w-4 h-4" /></Btn>
        <Btn onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
          title="Redo (⌘⇧Z)" testId="rte-redo"><Redo2 className="w-4 h-4" /></Btn>
      </div>

      {/* Email-styled canvas — what you see is what gets sent. */}
      <div className="bg-[#f7f7f4] py-6 px-3 sm:px-6">
        <div className="max-w-[640px] mx-auto bg-white shadow border border-stone-200">
          {/* Logo header — read-only, mirrors the production email */}
          {logoUrl && (
            <div className="px-6 pt-7 pb-3 flex justify-center">
              <img src={logoUrl} alt="Creative Mojo" style={{ maxWidth: 220, height: "auto" }} />
            </div>
          )}
          {/* Editable body — Tiptap with email-style CSS */}
          <EditorContent editor={editor} className="rte-editor" />
          {/* Locked signature — visible while editing so admin sees the
              full final layout, but cannot edit. The 50% opacity + lock
              badge make the lock state obvious. */}
          {signatureHtml && (
            <div className="relative border-t border-stone-100" data-testid="rte-signature-locked">
              <div className="absolute top-2 right-2 text-[9px] font-bold uppercase tracking-wider bg-stone-900 text-[#dddd16] px-1.5 py-0.5 rounded shadow z-10">
                🔒 Locked signature
              </div>
              <div
                className="px-6 py-4 opacity-50 pointer-events-none select-none"
                dangerouslySetInnerHTML={{ __html: signatureHtml }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Email-canvas styling — paragraph rhythm matches Gmail/Outlook
          render, and special link classes/href-tokens transform into the
          coloured buttons live so admins see the final look as they edit. */}
      <style>{`
        .rte-editor .ProseMirror { min-height: 300px; padding: 22px 28px; outline: none; font-family: Helvetica, Arial, sans-serif; color: #1a1a1a; }
        .rte-editor .ProseMirror p { margin: 0 0 0.9em; line-height: 1.6; font-size: 15px; }
        .rte-editor .ProseMirror p:last-child { margin-bottom: 0; }
        .rte-editor .ProseMirror h2 { font-size: 22px; font-weight: 800; margin: 1.1em 0 0.4em; line-height: 1.25; }
        .rte-editor .ProseMirror h3 { font-size: 17px; font-weight: 700; margin: 0.95em 0 0.3em; }
        .rte-editor .ProseMirror ul { list-style: disc; padding-left: 1.4em; margin: 0 0 0.9em; }
        .rte-editor .ProseMirror ol { list-style: decimal; padding-left: 1.4em; margin: 0 0 0.9em; }
        .rte-editor .ProseMirror li > p { margin: 0; }
        .rte-editor .ProseMirror a { color: #1c1917; text-decoration: underline; }
        /* WYSIWYG: yellow CTA buttons & outline buttons render inline as
           the admin will see them. The href can be either a real URL or
           a {{file:*}} placeholder — both get the button style.  */
        .rte-editor .ProseMirror a.cm-btn-cta,
        .rte-editor .ProseMirror a[href^="{{file:"] {
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
        .rte-editor .ProseMirror a.cm-btn-outline {
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
        .rte-editor .ProseMirror p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: #a8a29e;
          pointer-events: none;
          height: 0;
        }
      `}</style>
    </div>
  );
}
