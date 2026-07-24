"""Contract PDF → editable HTML conversion pipeline.

Pipeline:

1. ``extract_blocks(pdf_bytes)`` — PyMuPDF walks each page, capturing
   text lines with their font size / weight / position. Also extracts
   image blocks and uploads them to R2 as ``uploads/contract-templates/
   {template_id}/img-N.png`` so the LLM can reference them by URL.

2. ``convert_to_html(blocks)`` — Claude Sonnet 4.5 turns the structured
   blocks into semantic Tiptap-friendly HTML in chunks of ~10 pages.
   The system prompt is content-preserving: no rephrasing, no
   reordering, no summarisation.

3. ``verify_verbatim(pdf_text, html)`` — normalised token-level diff of
   the source PDF against the converted HTML. Produces the
   ``conversion_report`` that HQ reviews before hitting Approve.

Every function is stateless and unit-testable — no MongoDB writes here.
"""
from __future__ import annotations

import io
import re
import uuid
import logging
import difflib
from dataclasses import dataclass, field
from typing import List, Dict, Optional

import bleach
import fitz  # PyMuPDF

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------
@dataclass
class ExtractedLine:
    page: int
    text: str
    size: float
    bold: bool
    x0: float
    y0: float


@dataclass
class ExtractedImage:
    page: int
    bbox: List[float]
    r2_key: Optional[str] = None
    r2_url: Optional[str] = None
    width: int = 0
    height: int = 0


@dataclass
class ExtractionResult:
    lines: List[ExtractedLine] = field(default_factory=list)
    images: List[ExtractedImage] = field(default_factory=list)
    plain_text: str = ""
    page_count: int = 0


# ---------------------------------------------------------------------------
# Step 1 — PyMuPDF extraction
# ---------------------------------------------------------------------------
def extract_blocks(pdf_bytes: bytes) -> ExtractionResult:
    """Extract structured text lines + image blocks from a PDF."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    lines: List[ExtractedLine] = []
    images: List[ExtractedImage] = []
    plain_chunks: List[str] = []
    for page_idx in range(doc.page_count):
        page = doc[page_idx]
        page_dict = page.get_text("dict")
        for block in page_dict.get("blocks", []):
            btype = block.get("type")
            if btype == 0:  # text
                for line in block.get("lines", []):
                    spans = line.get("spans", [])
                    if not spans:
                        continue
                    text = "".join(s.get("text", "") for s in spans).strip()
                    if not text:
                        continue
                    sizes = [s.get("size", 0) for s in spans if s.get("size")]
                    size = max(sizes) if sizes else 0.0
                    bold = any(
                        "bold" in (s.get("font") or "").lower()
                        for s in spans
                    )
                    bbox = line.get("bbox", [0, 0, 0, 0])
                    lines.append(ExtractedLine(
                        page=page_idx + 1, text=text, size=round(size, 2),
                        bold=bold, x0=round(bbox[0], 1), y0=round(bbox[1], 1),
                    ))
            elif btype == 1:  # image
                bbox = block.get("bbox", [0, 0, 0, 0])
                images.append(ExtractedImage(
                    page=page_idx + 1,
                    bbox=[round(v, 1) for v in bbox],
                    width=int(block.get("width", 0) or 0),
                    height=int(block.get("height", 0) or 0),
                ))
        plain_chunks.append(page.get_text("text"))
    doc.close()
    return ExtractionResult(
        lines=lines,
        images=images,
        plain_text="\n".join(plain_chunks),
        page_count=len(plain_chunks),
    )


# ---------------------------------------------------------------------------
# Step 2 — LLM semantic HTML cleanup
# ---------------------------------------------------------------------------
CONVERSION_SYSTEM_PROMPT = """You convert legal-contract text extracted from a PDF into clean, semantic HTML for a rich-text editor. Follow every rule exactly.

CONTENT PRESERVATION IS ABSOLUTE.
- Output the input text VERBATIM. Do not rephrase, summarise, restructure or reorder.
- Do not add commentary, disclaimers or explanations. Output HTML only.
- Do not omit any line. Every non-empty input line must appear in your output.

STRUCTURE.
- Use the largest font sizes for <h1>, next for <h2>, next for <h3>. Look at the ``size`` values I give you per line.
- Bold lines that look like section titles → treat as headings.
- Normal paragraphs → <p>.
- If a line begins with a clause marker like "1.", "1.1", "1.1.1", "(a)", "(i)", wrap the marker in <span class="cm-original-num" data-original-num="MARKER">MARKER</span> followed by a space, then the rest of the line.
- Consecutive lettered / roman-numeral clauses at the same indent → wrap in <ol><li>...</li></ol>.
- Preserve inline emphasis (bold / italic) using <strong> and <em>.
- Do NOT emit tables even if the source used a table layout — flow the text into paragraphs / lists.
- Do NOT include <html>, <body>, <!doctype> or CSS. Return only the fragment.

OUTPUT.
Return one HTML fragment that flows in document order. No JSON, no markdown fences.
"""


# Tags Tiptap can safely round-trip. Everything else is stripped by bleach.
_ALLOWED_TAGS = [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "br", "hr",
    "strong", "em", "u", "s", "sub", "sup",
    "ul", "ol", "li",
    "blockquote",
    "a", "span", "img", "div",
]
_ALLOWED_ATTRS = {
    "*": ["class", "id", "data-placeholder", "data-original-num",
          "data-cm-page-break", "data-cm-toc", "data-num-skip",
          "style"],
    "a": ["href", "target", "rel"],
    "img": ["src", "alt", "width", "height", "data-source-image", "data-page"],
    "span": ["class", "data-placeholder", "data-original-num"],
}


def _sanitise_html(html: str) -> str:
    """Strip disallowed tags/attrs; keep the semantic structure only."""
    cleaned = bleach.clean(
        html or "",
        tags=_ALLOWED_TAGS,
        attributes=_ALLOWED_ATTRS,
        protocols=["http", "https", "mailto"],
        strip=True,
        strip_comments=True,
    )
    return cleaned


def _chunk_lines(lines: List[ExtractedLine], max_pages: int = 8) -> List[List[ExtractedLine]]:
    """Batch lines into chunks of ~max_pages so each LLM call stays small."""
    chunks: List[List[ExtractedLine]] = []
    current: List[ExtractedLine] = []
    current_pages: set[int] = set()
    for ln in lines:
        current.append(ln)
        current_pages.add(ln.page)
        if len(current_pages) >= max_pages:
            chunks.append(current)
            current = []
            current_pages = set()
    if current:
        chunks.append(current)
    return chunks


def _serialise_chunk(lines: List[ExtractedLine]) -> str:
    """Convert a chunk of extracted lines into a compact input string
    the LLM can reliably parse."""
    rows = []
    for ln in lines:
        flag = "B" if ln.bold else "-"
        rows.append(f"[p{ln.page} sz={ln.size} {flag}] {ln.text}")
    return "\n".join(rows)


async def convert_to_html(
    lines: List[ExtractedLine], emergent_key: str,
) -> str:
    """Send extracted lines to Claude Sonnet 4.5 and receive semantic
    HTML back. Chunked to keep prompts under model limits."""
    # Lazy import so pytest can import this module without pulling in
    # the LLM SDK.
    from emergentintegrations.llm.chat import LlmChat, UserMessage

    fragments: List[str] = []
    chunks = _chunk_lines(lines, max_pages=8)
    logger.info("Contract PDF cleanup — %d chunks", len(chunks))
    for i, chunk in enumerate(chunks):
        chat = LlmChat(
            api_key=emergent_key,
            session_id=f"contract-conv-{uuid.uuid4().hex[:8]}-{i}",
            system_message=CONVERSION_SYSTEM_PROMPT,
        ).with_model("anthropic", "claude-sonnet-4-5-20250929")
        user = UserMessage(text=_serialise_chunk(chunk))
        try:
            raw = await chat.send_message(user)
        except Exception as exc:  # noqa: BLE001
            logger.exception("LLM chunk %d failed: %s", i, exc)
            # Fall back to a plain-paragraph rendering so the HQ user
            # still has something editable rather than a blank chunk.
            fallback = "\n".join(
                f"<p>{bleach.clean(l.text, tags=[], strip=True)}</p>"
                for l in chunk
            )
            fragments.append(fallback)
            continue
        raw = (raw or "").strip()
        # Strip ``` code fences the model sometimes wraps output in.
        raw = re.sub(r"^```(?:html)?\s*|\s*```$", "", raw, flags=re.IGNORECASE)
        fragments.append(raw)

    html = "\n".join(fragments)
    return _sanitise_html(html)


# ---------------------------------------------------------------------------
# Step 3 — verbatim text verification
# ---------------------------------------------------------------------------
_NUM_PREFIX_RE = re.compile(r"^\s*(?:\(?[a-zA-Z0-9]+[.)\]]\s+|\d+(?:\.\d+)*\.?\s+)")
_WS_RE = re.compile(r"\s+")


def _normalise_for_diff(text: str) -> List[str]:
    """Lowercase, strip clause number prefixes, collapse whitespace,
    split into word tokens for a fair token-level diff."""
    lines = []
    for raw in (text or "").splitlines():
        stripped = _NUM_PREFIX_RE.sub("", raw.strip())
        stripped = _WS_RE.sub(" ", stripped).strip().lower()
        if not stripped:
            continue
        # Drop stand-alone page number / running header noise.
        if re.fullmatch(r"page\s*\d+(\s*of\s*\d+)?", stripped):
            continue
        if re.fullmatch(r"\d+", stripped):
            continue
        lines.append(stripped)
    joined = " ".join(lines)
    return [t for t in joined.split(" ") if t]


def _html_to_plain(html: str) -> str:
    """Strip tags for the diff step (keeps text nodes only)."""
    return bleach.clean(html or "", tags=[], attributes={}, strip=True)


def verify_verbatim(pdf_text: str, converted_html: str,
                    min_span_len: int = 8, max_flags: int = 25) -> Dict:
    """Compare source PDF text to converted HTML text at token level.

    Returns a report suitable for storing on the template:

        {
          "score": 0.0-1.0,
          "missing":  [ "phrase from pdf not found in html" , ... ],
          "added":    [ "phrase in html not in pdf" , ... ],
        }

    ``min_span_len`` filters trivial single-word diffs (punctuation,
    page numbers). ``max_flags`` caps the report so the UI stays
    scannable — an HQ user can drill into the source PDF for edge cases.
    """
    pdf_tokens = _normalise_for_diff(pdf_text)
    html_tokens = _normalise_for_diff(_html_to_plain(converted_html))

    if not pdf_tokens:
        return {"score": 1.0, "missing": [], "added": [], "note":
                "Empty source PDF text — nothing to verify."}

    matcher = difflib.SequenceMatcher(None, pdf_tokens, html_tokens, autojunk=False)
    ratio = matcher.ratio()

    missing: List[str] = []
    added: List[str] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        pdf_span = " ".join(pdf_tokens[i1:i2]).strip()
        html_span = " ".join(html_tokens[j1:j2]).strip()
        if tag in ("delete", "replace") and pdf_span and len(pdf_span) >= min_span_len:
            missing.append(pdf_span[:280])
        if tag in ("insert", "replace") and html_span and len(html_span) >= min_span_len:
            added.append(html_span[:280])

    return {
        "score": round(ratio, 4),
        "missing": missing[:max_flags],
        "added":   added[:max_flags],
        "total_missing": len(missing),
        "total_added":   len(added),
    }


__all__ = [
    "ExtractedLine",
    "ExtractedImage",
    "ExtractionResult",
    "extract_blocks",
    "convert_to_html",
    "verify_verbatim",
]
