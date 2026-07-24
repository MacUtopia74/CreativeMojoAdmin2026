# Creative Mojo — Word Authoring Guide for Contract Markers

*Phase 1A · Fixed-PDF Marker System · HQ authoring conventions*

Contracts are authored in Word as normal legal documents. The Hub
personalises them by locating and replacing tokens like
`[[FRANCHISEE_LEGAL_NAME]]` in the exported PDF. This guide documents
the rules HQ must follow when inserting markers in Word so the
detection engine works reliably.

---

## 1. Marker syntax

A marker is a token of the form `[[MARKER_CODE]]`:

- Wrapped in **double square brackets** — two open, two close.
- The code is **UPPER_SNAKE_CASE**, starts with a letter, contains only
  letters, digits and underscores, and is at most 50 characters.
- No spaces inside the brackets.

**Valid:**
`[[FRANCHISEE_LEGAL_NAME]]`, `[[AGREEMENT_DATE]]`, `[[MONTHLY_FEE]]`,
`[[CONTRACT_REFERENCE]]`.

**Invalid:**
`[FRANCHISEE_NAME]` (single brackets), `[[franchisee name]]` (lowercase +
space), `[[  NAME  ]]` (padded), `[[NAME))` (mismatched).

---

## 2. Golden rule — keep the whole token on one line

The entire `[[CODE]]` token must sit on a single line in the exported
PDF.

- ✅ `"This Agreement is made on [[AGREEMENT_DATE]]."` — inline is fine.
- ✅ `"Franchisee: [[FRANCHISEE_LEGAL_NAME]]"` — on a line of its own.
- ❌ A token that Word has wrapped so the closing `]]` sits on the next
  line will be flagged as a **cross-line marker error** and the
  template will be blocked from approval until the source Word document
  is re-authored.

If Word wraps a long token, either:

- shorten the surrounding text so the token fits, or
- move the token to a fresh line (`Shift+Enter` or paragraph break).

The Hub cannot merge a token across two visual lines; PDF export is
line-preserving.

---

## 3. Preferred placements (in priority order)

1. **Dedicated fields inside a table cell** — the cleanest option. Each
   cell holds one marker; the layout of the surrounding cell reserves
   the space for the personalised value. This is how the Cover page and
   Particulars page should be structured.
2. **A line of its own** — e.g. `"Franchisee: [[FRANCHISEE_LEGAL_NAME]]"`.
   Reserve the rest of the line for the value.
3. **A reserved space at the end of a paragraph** — e.g.
   `"Signed for and on behalf of [[FRANCHISEE_LEGAL_NAME]]."`.
4. **Inline within a sentence** — supported and tested, but keep the
   token near the end of the sentence and leave enough room for the
   expected value. e.g. `"The initial term is [[CONTRACT_TERM_YEARS]]
   years."`.

Avoid using an inline marker inside a heavily justified paragraph — the
personalised value may need to be shorter or longer than the marker
token, which in a justified paragraph can affect the visual spacing of
adjacent words. HQ can flag this at Marker Review and choose to move
the marker to a dedicated line.

---

## 4. Space budgeting

Word does not know how long the personalised value will be. Reserve
enough space in the layout so the substituted text fits without
overflow.

| Marker | Expected max length | Sensible width |
|---|---|---|
| `[[FRANCHISEE_LEGAL_NAME]]` | ~80 chars incl. `Limited` | ~½ line |
| `[[FRANCHISEE_ADDRESS_BLOCK]]` | 5 lines, ~60 chars each | ~⅓ page width, 5 lines tall |
| `[[MONTHLY_FEE]]` | e.g. £1,234.56 | 8-10 chars |
| `[[AGREEMENT_DATE]]` | e.g. 31 December 2026 | 20 chars |
| `[[CONTRACT_REFERENCE]]` | e.g. CM-2026-0094 | 20 chars |

The Marker Review screen (Phase 1B) will let HQ preview a sample value
and adjust the marker box if it needs more room. In the meantime, err on
the side of over-reserving space in the source Word document.

---

## 5. Backgrounds and artwork

Do not place markers on top of artwork, logos, watermarks, or complex
image backgrounds. The Hub will visually mask the marker area when
overlaying the personalised value, and a busy background will show
around the edges of the mask.

Instead, place markers on a plain white (or plain-coloured) background.
Cover pages that contain both a logo and a marker should keep them in
separate regions.

---

## 6. Repeats

The same marker can appear more than once in a document — for example,
the franchisee name usually appears on:

- the cover page
- the parties clause
- the signature page

This is expected. Each occurrence is positioned independently; the
personalised value is the same across all of them. No special authoring
step is required — just use the same marker code wherever the value is
needed.

---

## 7. Fonts

Any font is fine as long as it renders correctly in Word and the
exported PDF. Note however:

- Word-exported PDFs typically embed fonts as **subsets**, which means
  the Hub cannot always reuse the exact font for overlaying the
  personalised value. Where a substitute is needed, the Hub picks the
  nearest metric-compatible variant (Times → Times-Roman-equivalent,
  Arial → Helvetica). This is normally invisible.
- Bold, italic, and underline on the marker token itself are preserved:
  `[[FRANCHISEE_LEGAL_NAME]]` typeset in **bold** will render the
  personalised value in bold.
- Very small (< 8pt) or very large (> 36pt) markers may hit the
  auto-shrink lower/upper bounds. HQ can override per-marker in Phase 1B.

---

## 8. Un-supported patterns

The following will not detect and will surface at upload time as an
error:

- A marker whose brackets span two lines.
- A marker inside a **text-box** that has been rotated more than a few
  degrees off horizontal.
- A marker rendered as an **image** (e.g. someone pasted a PNG of the
  text `[[NAME]]`).
- Nested brackets — `[[FOO_[[BAR]]_BAZ]]` is not supported.

---

## 9. Approval workflow

After uploading the PDF, the Hub produces a summary showing:

- Every detected marker with its page and position.
- Which markers are **recognised** by the Marker Library.
- Any **unrecognised** codes (mistyped, or a genuinely new marker).
- Any **cross-line errors** (fix in Word and re-upload).
- Any **duplicate offenders** (repeats where the library says
  `repeat_allowed = false`).

The template cannot be marked `current` until all of those are cleared.
Adding a new marker to the Marker Library takes one click on the
"Add to library" prompt at Marker Review.

---

## 10. One-time checklist before you upload

- [ ] Every `[[CODE]]` fits on a single line in the PDF.
- [ ] Every code is `UPPER_SNAKE_CASE` with no spaces inside the brackets.
- [ ] Enough surrounding space is reserved for the substituted value.
- [ ] Markers do not sit on top of images or coloured backgrounds.
- [ ] The PDF has been exported using **Word → File → Export → PDF**
      (not "Print to PDF") to ensure the text layer is preserved.
- [ ] Track-changes are accepted; comments are resolved.
- [ ] The Word master file is retained locally — the Hub only stores
      the exported PDF, not the .docx.

*If you're unsure whether a particular authoring pattern is safe, the
Marker Review screen will show you exactly what the Hub detected. Upload
early, iterate on the Word source, and re-upload as needed. Nothing
becomes live until you press Publish.*
