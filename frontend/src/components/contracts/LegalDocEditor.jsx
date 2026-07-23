// LegalDocEditor — Tiptap-based rich editor for long-form legal
// documents. Extends the existing HQ-Updates editor foundation but
// unlocks H1-H6, adds Text Align + Text Style, and mounts the three
// custom nodes needed for contract templates:
//
//   • PlaceholderChip   ({{franchisee_name}} etc as yellow pills)
//   • PageBreak         (explicit page-break marker)
//   • TableOfContents   (live scan of H1/H2)
//
// The editor is A4-styled with a paper-like drop shadow so HQ can see
// approximately how the doc will paginate. Precise pagination is
// always deferred to WeasyPrint via the "Generate PDF preview" button.
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bold, Italic, Underline as UnderlineIcon, List, ListOrdered,
  Heading1, Heading2, Heading3, AlignLeft, AlignCenter, AlignRight,
  AlignJustify, Undo, Redo, Link as LinkIcon, FileText as TocIcon,
  Scissors, ChevronDown,
} from "lucide-react";
import { PlaceholderChip, PageBreak, TableOfContents } from "./nodes";
import "./LegalDocEditor.css";

function ToolbarBtn({ active, disabled, onClick, title, testid, children }) {
  return (
    <button
      type="button"
      title={title}
      data-testid={testid}
      onClick={onClick}
      disabled={disabled}
      className={`px-2 py-1 rounded text-sm inline-flex items-center gap-1 border transition ${
        active
          ? "bg-stone-950 text-white border-stone-950"
          : "bg-white text-stone-700 border-stone-300 hover:bg-stone-100"
      } disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {children}
    </button>
  );
}

function PlaceholderMenu({ editor, placeholders }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return () => {};
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <ToolbarBtn onClick={() => setOpen((v) => !v)} title="Insert placeholder"
                  testid="legal-editor-placeholder-menu">
        <span className="text-xs font-bold uppercase tracking-wider">Placeholder</span>
        <ChevronDown className="w-3 h-3" />
      </ToolbarBtn>
      {open && (
        <div className="absolute z-30 top-full mt-1 right-0 min-w-[260px] bg-white border border-stone-200 rounded-lg shadow-lg py-1 max-h-96 overflow-y-auto">
          {placeholders.map((p) => (
            <button
              key={p.token}
              type="button"
              data-testid={`legal-editor-placeholder-${p.token}`}
              onClick={() => {
                editor?.chain().focus().insertPlaceholder(p.token).run();
                setOpen(false);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-stone-50 flex items-baseline justify-between gap-2"
            >
              <span className="text-sm text-stone-900">{p.label}</span>
              <span className="text-xs text-stone-500 font-mono">{`{{${p.token}}}`}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function LegalDocEditor({
  initialHtml = "",
  placeholders = [],
  onUpdateHtml,   // (html) => void — called on every edit, debounce upstream
  editable = true,
}) {
  const editor = useEditor({
    editable,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        codeBlock: false,
      }),
      Underline,
      Link.configure({ openOnClick: false, autolink: false }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      TextStyle,
      PlaceholderChip,
      PageBreak,
      TableOfContents,
    ],
    content: initialHtml || "<p></p>",
    editorProps: {
      attributes: {
        class: "cm-doc-editor prose max-w-none focus:outline-none",
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (onUpdateHtml) onUpdateHtml(ed.getHTML());
    },
  });

  // Keep the editor in sync if the parent swaps templates.
  useEffect(() => {
    if (!editor) return;
    if (initialHtml && editor.getHTML() !== initialHtml) {
      editor.commands.setContent(initialHtml, { emitUpdate: false });
    }
  }, [initialHtml]);

  if (!editor) return null;

  const setHeading = (level) => editor.chain().focus().toggleHeading({ level }).run();

  return (
    <div className="border border-stone-200 rounded-xl bg-stone-50 overflow-hidden flex flex-col h-full">
      {/* Toolbar */}
      <div className="border-b border-stone-200 bg-white px-3 py-2 flex flex-wrap items-center gap-1.5">
        <ToolbarBtn onClick={() => editor.chain().focus().undo().run()} title="Undo" testid="legal-editor-undo">
          <Undo className="w-4 h-4" />
        </ToolbarBtn>
        <ToolbarBtn onClick={() => editor.chain().focus().redo().run()} title="Redo" testid="legal-editor-redo">
          <Redo className="w-4 h-4" />
        </ToolbarBtn>
        <span className="w-px h-6 bg-stone-200 mx-1" />

        <ToolbarBtn active={editor.isActive("heading", { level: 1 })} onClick={() => setHeading(1)} title="H1" testid="legal-editor-h1">
          <Heading1 className="w-4 h-4" />
        </ToolbarBtn>
        <ToolbarBtn active={editor.isActive("heading", { level: 2 })} onClick={() => setHeading(2)} title="H2" testid="legal-editor-h2">
          <Heading2 className="w-4 h-4" />
        </ToolbarBtn>
        <ToolbarBtn active={editor.isActive("heading", { level: 3 })} onClick={() => setHeading(3)} title="H3" testid="legal-editor-h3">
          <Heading3 className="w-4 h-4" />
        </ToolbarBtn>

        <span className="w-px h-6 bg-stone-200 mx-1" />

        <ToolbarBtn active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold" testid="legal-editor-bold">
          <Bold className="w-4 h-4" />
        </ToolbarBtn>
        <ToolbarBtn active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic" testid="legal-editor-italic">
          <Italic className="w-4 h-4" />
        </ToolbarBtn>
        <ToolbarBtn active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()} title="Underline" testid="legal-editor-underline">
          <UnderlineIcon className="w-4 h-4" />
        </ToolbarBtn>

        <span className="w-px h-6 bg-stone-200 mx-1" />

        <ToolbarBtn active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet list" testid="legal-editor-ul">
          <List className="w-4 h-4" />
        </ToolbarBtn>
        <ToolbarBtn active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Ordered list" testid="legal-editor-ol">
          <ListOrdered className="w-4 h-4" />
        </ToolbarBtn>

        <span className="w-px h-6 bg-stone-200 mx-1" />

        <ToolbarBtn active={editor.isActive({ textAlign: "left" })} onClick={() => editor.chain().focus().setTextAlign("left").run()} title="Align left" testid="legal-editor-align-left">
          <AlignLeft className="w-4 h-4" />
        </ToolbarBtn>
        <ToolbarBtn active={editor.isActive({ textAlign: "center" })} onClick={() => editor.chain().focus().setTextAlign("center").run()} title="Centre" testid="legal-editor-align-center">
          <AlignCenter className="w-4 h-4" />
        </ToolbarBtn>
        <ToolbarBtn active={editor.isActive({ textAlign: "right" })} onClick={() => editor.chain().focus().setTextAlign("right").run()} title="Align right" testid="legal-editor-align-right">
          <AlignRight className="w-4 h-4" />
        </ToolbarBtn>
        <ToolbarBtn active={editor.isActive({ textAlign: "justify" })} onClick={() => editor.chain().focus().setTextAlign("justify").run()} title="Justify" testid="legal-editor-align-justify">
          <AlignJustify className="w-4 h-4" />
        </ToolbarBtn>

        <span className="w-px h-6 bg-stone-200 mx-1" />

        <ToolbarBtn onClick={() => {
          const url = window.prompt("Link URL");
          if (!url) return;
          editor.chain().focus().extendMarkRange("link").setLink({ href: url, target: "_blank", rel: "noopener noreferrer" }).run();
        }} title="Insert link" testid="legal-editor-link">
          <LinkIcon className="w-4 h-4" />
        </ToolbarBtn>

        <ToolbarBtn onClick={() => editor.chain().focus().insertPageBreak().run()} title="Insert page break" testid="legal-editor-pagebreak">
          <Scissors className="w-4 h-4" />
          <span className="text-xs font-bold uppercase tracking-wider">Page break</span>
        </ToolbarBtn>

        <ToolbarBtn onClick={() => editor.chain().focus().insertTableOfContents().run()} title="Insert Contents page" testid="legal-editor-toc">
          <TocIcon className="w-4 h-4" />
          <span className="text-xs font-bold uppercase tracking-wider">Contents</span>
        </ToolbarBtn>

        <div className="ml-auto">
          <PlaceholderMenu editor={editor} placeholders={placeholders} />
        </div>
      </div>

      {/* A4 canvas */}
      <div className="flex-1 overflow-auto flex justify-center bg-stone-100 py-8 px-6">
        <div className="cm-doc-page bg-white shadow-md">
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}
