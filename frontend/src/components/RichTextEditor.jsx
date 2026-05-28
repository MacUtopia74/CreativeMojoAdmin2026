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
  Link2, Heading1, Heading2, Pilcrow, Undo2, Redo2, Code,
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

export default function RichTextEditor({ value, onChange, placeholder, testIdPrefix = "rte" }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        // We disable code-block + horizontalRule — not needed for email
        // copy and they'd just clutter the toolbar.
        codeBlock: false,
        horizontalRule: false,
      }),
      Underline,
      Link.configure({
        openOnClick: false,  // Don't follow links inside the editor
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
        class: "prose prose-sm max-w-none min-h-[400px] p-4 focus:outline-none",
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
    <div className="border border-stone-300 rounded-lg bg-white overflow-hidden">
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
        <Btn onClick={() => editor.chain().focus().toggleCode().run()}
          active={editor.isActive("code")}
          title="Inline code" testId="rte-code"><Code className="w-4 h-4" /></Btn>

        <div className="flex-1" />

        <Btn onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
          title="Undo (⌘Z)" testId="rte-undo"><Undo2 className="w-4 h-4" /></Btn>
        <Btn onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
          title="Redo (⌘⇧Z)" testId="rte-redo"><Redo2 className="w-4 h-4" /></Btn>
      </div>

      {/* Editable area */}
      <EditorContent editor={editor} className="rte-editor" />

      {/* Local styling — Tailwind's typography plugin handles most of
          this but a couple of overrides keep the editor feeling tight. */}
      <style>{`
        .rte-editor .ProseMirror { min-height: 400px; padding: 16px; outline: none; }
        .rte-editor .ProseMirror p { margin: 0 0 0.6em; line-height: 1.55; }
        .rte-editor .ProseMirror p:last-child { margin-bottom: 0; }
        .rte-editor .ProseMirror h2 { font-size: 1.25em; font-weight: 700; margin: 1em 0 0.4em; }
        .rte-editor .ProseMirror h3 { font-size: 1.05em; font-weight: 700; margin: 0.9em 0 0.3em; }
        .rte-editor .ProseMirror ul { list-style: disc; padding-left: 1.4em; margin: 0 0 0.6em; }
        .rte-editor .ProseMirror ol { list-style: decimal; padding-left: 1.4em; margin: 0 0 0.6em; }
        .rte-editor .ProseMirror li > p { margin: 0; }
        .rte-editor .ProseMirror a { color: #1c1917; text-decoration: underline; }
        .rte-editor .ProseMirror code { background: #f5f5f4; padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
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
