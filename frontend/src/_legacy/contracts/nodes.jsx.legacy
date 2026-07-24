// Placeholder chip — Tiptap Node extension that renders as a yellow
// pill token in the editor and serialises to
//   <span data-placeholder="X" class="cm-placeholder">{{X}}</span>
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { useEffect, useState } from "react";

export const PlaceholderChip = Node.create({
  name: "placeholderChip",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      token: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-placeholder"),
        renderHTML: (attrs) => ({ "data-placeholder": attrs.token }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-placeholder]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const token = node.attrs.token || "";
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "cm-placeholder",
        "data-placeholder": token,
      }),
      `{{${token}}}`,
    ];
  },
  addCommands() {
    return {
      insertPlaceholder: (token) => ({ chain }) => (
        chain().insertContent({
          type: "placeholderChip",
          attrs: { token },
        }).run()
      ),
    };
  },
});

// Manual page break — dashed divider in the editor, page-break-before
// in the printed PDF.
export const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,
  parseHTML() {
    return [{ tag: "div[data-cm-page-break]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-cm-page-break": "true",
        class: "cm-page-break",
      }),
    ];
  },
  addCommands() {
    return {
      insertPageBreak: () => ({ chain }) => (
        chain().insertContent({ type: "pageBreak" }).createParagraphNear().run()
      ),
    };
  },
});

// Live Table of Contents view — scans all H1/H2 headings currently in
// the document. On save it serialises to a bare marker; WeasyPrint
// inflates the entries at PDF render time.
function TocView({ editor }) {
  const [entries, setEntries] = useState([]);
  useEffect(() => {
    if (!editor) return () => {};
    const recompute = () => {
      const out = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name === "heading" && node.attrs.level <= 2) {
          out.push({ level: node.attrs.level, text: node.textContent });
        }
        return true;
      });
      setEntries(out);
    };
    recompute();
    editor.on("update", recompute);
    return () => editor.off("update", recompute);
  }, [editor]);
  return (
    <NodeViewWrapper as="div" className="cm-toc" data-cm-toc="true" contentEditable={false}>
      <div className="cm-toc-title">Contents</div>
      {entries.length === 0 ? (
        <div className="cm-toc-empty text-xs text-stone-400 italic">
          No headings yet — Contents will populate as you type.
        </div>
      ) : entries.map((e, i) => (
        <div key={i} className={`cm-toc-entry level-${e.level}`}>
          <span className="cm-toc-text">{e.text || "(untitled heading)"}</span>
          <span className="cm-toc-lead" />
          <span className="cm-toc-page">…</span>
        </div>
      ))}
    </NodeViewWrapper>
  );
}

export const TableOfContents = Node.create({
  name: "tableOfContents",
  group: "block",
  atom: true,
  draggable: false,
  selectable: true,
  parseHTML() { return [{ tag: "div[data-cm-toc]" }]; },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-cm-toc": "true",
        class: "cm-toc",
      }),
    ];
  },
  addNodeView() { return ReactNodeViewRenderer(TocView); },
  addCommands() {
    return {
      insertTableOfContents: () => ({ chain }) => (
        chain().insertContent({ type: "tableOfContents" }).run()
      ),
    };
  },
});
