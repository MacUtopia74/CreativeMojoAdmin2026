"""Contract PDF branding — Creative Mojo defaults.

Phase 1A ships with a fixed brand config. A UI to edit these lands in
a later phase. Kept as a module (not a Mongo doc) so it round-trips
through git and cannot drift silently in production.
"""

# The logo lives on-disk under backend/static so the container-local
# WeasyPrint render can load it via a file:// URL. Passing an absolute
# filesystem path is more robust than relying on a base_url + HTTP
# fetch during PDF generation.
import os as _os
LOGO_STATIC_PATH = "file://" + _os.path.join(
    _os.path.dirname(_os.path.abspath(__file__)),
    "static", "creative_mojo_logo.png",
)


HEADER_HTML = """
<div class="cm-brand-header">
  <img src="{logo}" alt="Creative Mojo" class="cm-brand-header-logo" />
  <div class="cm-brand-header-meta">
    Creative Mojo Franchise Agreement
  </div>
</div>
""".strip()


FOOTER_HTML = """
<div class="cm-brand-footer">
  <span class="cm-brand-footer-left">Creative Mojo Ltd · Confidential</span>
  <span class="cm-brand-footer-right">Page <span class="cm-page-num"></span> of <span class="cm-page-count"></span></span>
</div>
""".strip()


# CSS that WeasyPrint uses AND the digital preview page includes. The
# rules that only work under WeasyPrint (@page, target-counter,
# element(header)) are safely ignored by the browser.
PRINT_CSS = r"""
@page {
  size: A4;
  margin: 26mm 22mm 26mm 22mm;

  @top-center {
    content: element(cm-hdr);
  }
  @bottom-center {
    content: element(cm-ftr);
  }
}

.cm-brand-header {
  position: running(cm-hdr);
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #d6d3d1;
  padding-bottom: 4mm;
  font-family: "Inter", "Helvetica Neue", sans-serif;
  font-size: 9pt;
  color: #57534e;
}
.cm-brand-header-logo { height: 12mm; width: auto; }
.cm-brand-header-meta { font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; }

.cm-brand-footer {
  position: running(cm-ftr);
  display: flex;
  justify-content: space-between;
  border-top: 1px solid #d6d3d1;
  padding-top: 3mm;
  font-family: "Inter", "Helvetica Neue", sans-serif;
  font-size: 8pt;
  color: #78716c;
}

body.cm-doc {
  font-family: "Georgia", "Times New Roman", serif;
  font-size: 11pt;
  color: #1c1917;
  line-height: 1.55;
}
body.cm-doc h1 { font-size: 16pt; margin-top: 10mm; margin-bottom: 4mm; page-break-after: avoid; }
body.cm-doc h2 { font-size: 13pt; margin-top: 6mm; margin-bottom: 3mm; page-break-after: avoid; }
body.cm-doc h3 { font-size: 12pt; margin-top: 4mm; margin-bottom: 2mm; page-break-after: avoid; }
body.cm-doc h4 { font-size: 11pt; margin-top: 3mm; margin-bottom: 2mm; font-weight: 700; page-break-after: avoid; }
body.cm-doc p  { margin: 0 0 3mm 0; text-align: justify; hyphens: auto; }
body.cm-doc ol, body.cm-doc ul { margin: 2mm 0 4mm 6mm; }
body.cm-doc li { margin-bottom: 2mm; }
body.cm-doc .cm-placeholder {
  background: #fef9c3;
  border: 1px solid #eab308;
  border-radius: 3px;
  padding: 0 3px;
  font-family: "Menlo", "Courier New", monospace;
  font-size: 9pt;
  color: #713f12;
}
body.cm-doc .cm-original-num {
  background: #f5f5f4;
  color: #57534e;
  padding: 0 2px;
  border-radius: 2px;
  font-weight: 600;
}
body.cm-doc .cm-generated-num {
  font-weight: 700;
  margin-right: 6px;
}
body.cm-doc .cm-page-break {
  page-break-before: always;
  break-before: page;
  display: block;
  height: 1px;
  visibility: hidden;
}
body.cm-doc .cm-page-start { page-break-before: always; }
body.cm-doc .cm-keep-together { page-break-inside: avoid; }

/* Contents page ---------------------------------------------------------- */
body.cm-doc .cm-toc {
  page-break-after: always;
  margin-bottom: 8mm;
}
body.cm-doc .cm-toc-title {
  font-size: 14pt;
  font-weight: 700;
  border-bottom: 1px solid #a8a29e;
  padding-bottom: 3mm;
  margin-bottom: 5mm;
  text-transform: uppercase;
  letter-spacing: 0.1em;
}
body.cm-doc .cm-toc-entry {
  display: flex;
  align-items: baseline;
  gap: 4mm;
  margin: 1mm 0;
}
body.cm-doc .cm-toc-entry .cm-toc-lead {
  flex: 1 1 auto;
  border-bottom: 1px dotted #a8a29e;
  min-height: 0.9em;
}
body.cm-doc .cm-toc-entry .cm-toc-page::after {
  /* WeasyPrint fills in the destination page number of the linked
     heading via target-counter. Falls back to blank in the browser. */
  content: target-counter(attr(href), page);
}
body.cm-doc .cm-toc-entry.level-2 { padding-left: 6mm; font-size: 10.5pt; }
body.cm-doc .cm-toc-entry.level-3 { padding-left: 12mm; font-size: 10pt; }

/* DOCX import — mirrored classes so imported Word cover pages, TOC
   fragments and alignment classes render identically in the PDF. */
body.cm-doc .cover-title    { text-align: center; font-size: 22pt; font-weight: 700; margin: 6mm 0 3mm; }
body.cm-doc .cover-subtitle { text-align: center; font-size: 14pt; margin: 3mm 0; }
body.cm-doc .cover-parties  { text-align: center; font-size: 12pt; margin: 2mm 0; }
body.cm-doc .cover-line     { text-align: center; margin: 1mm 0; }
body.cm-doc .recital        { font-style: italic; margin: 2mm 0 2mm 8mm; }
body.cm-doc .toc-1 { padding-left: 0;  font-weight: 700; margin: 1.5mm 0; }
body.cm-doc .toc-2 { padding-left: 6mm; margin: 1mm 0; }
body.cm-doc .toc-3 { padding-left: 12mm; margin: 1mm 0; }
body.cm-doc .text-center  { text-align: center; }
body.cm-doc .text-right   { text-align: right; }
body.cm-doc .text-justify { text-align: justify; }
body.cm-doc .doc-title    { text-align: center; font-size: 20pt; font-weight: 700; }
body.cm-doc .doc-subtitle { text-align: center; font-size: 12pt; }

/* DOCX tables — same look inside the PDF as in the editor */
body.cm-doc table {
  border-collapse: collapse;
  width: 100%;
  margin: 4mm 0;
  page-break-inside: auto;
}
body.cm-doc td, body.cm-doc th {
  border: 0.5pt solid #a8a29e;
  padding: 2mm 3mm;
  vertical-align: top;
}
body.cm-doc th { background: #f5f5f4; font-weight: 700; text-align: left; }

/* Embedded images preserve the width + alignment attrs set in-editor */
body.cm-doc img {
  max-width: 100%;
  height: auto;
}
body.cm-doc img[data-align="left"]  { float: left;  margin-right: 4mm; }
body.cm-doc img[data-align="right"] { float: right; margin-left: 4mm; }
body.cm-doc img[data-align="center"] { display: block; margin: 3mm auto; }
""".strip()
