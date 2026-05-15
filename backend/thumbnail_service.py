"""Phase 3 — Thumbnail cache.

Generates 256×256 JPEG previews of PDFs (first page) and images, caches
them back into R2 under `_thumbs/`, and serves them through the FastAPI
backend so the browser cache + Cloudflare R2 keep them blazing fast on
subsequent visits.

Why server-side?
  - Client-side PDF.js needed the full PDF for every thumbnail (multi-MB
    PDFs × many tiles → slow folder load).
  - Server renders once per file, stores 30-50 KB JPEG, every other
    visitor (any role, any device) reuses the cache.
"""
from __future__ import annotations

import hashlib
import io
import logging
from typing import Optional

import boto3.exceptions  # noqa: F401  (typing only)
from PIL import Image

from file_storage import R2_BUCKET, get_client

logger = logging.getLogger("creative-mojo-admin.thumbnails")

THUMB_PREFIX = "_thumbs/"
SIZES: dict[str, int] = {"sm": 128, "md": 320, "lg": 640}
JPEG_QUALITY = 78


def thumb_key(source_key: str, size: str) -> str:
    """Deterministic cache key: hash the source path to keep names safe
    and avoid surfacing in the user-facing listings."""
    h = hashlib.sha1(source_key.encode("utf-8")).hexdigest()
    return f"{THUMB_PREFIX}{h}-{size}.jpg"


def _resize_to_square(im: Image.Image, side: int) -> Image.Image:
    """Letterbox-fit into a `side×side` white canvas. Keeps aspect."""
    im = im.convert("RGB")
    im.thumbnail((side, side), Image.LANCZOS)
    canvas = Image.new("RGB", (side, side), "white")
    x = (side - im.size[0]) // 2
    y = (side - im.size[1]) // 2
    canvas.paste(im, (x, y))
    return canvas


def render_image_bytes(raw: bytes, side: int) -> Optional[bytes]:
    try:
        im = Image.open(io.BytesIO(raw))
        out = _resize_to_square(im, side)
        buf = io.BytesIO()
        out.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        return buf.getvalue()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Image thumbnail failed: %s", exc)
        return None


def render_pdf_bytes(raw: bytes, side: int) -> Optional[bytes]:
    try:
        import pypdfium2 as pdfium  # local import keeps server startup snappy
        pdf = pdfium.PdfDocument(raw)
        if len(pdf) == 0:
            return None
        page = pdf[0]
        # Render at ~2x the target size for crisp downscale.
        bitmap = page.render(scale=max(1.0, (side * 2) / max(page.get_size())))
        pil = bitmap.to_pil()
        out = _resize_to_square(pil, side)
        buf = io.BytesIO()
        out.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        return buf.getvalue()
    except Exception as exc:  # noqa: BLE001
        logger.warning("PDF thumbnail failed: %s", exc)
        return None


def get_cached_thumbnail(key: str, size: str = "md") -> Optional[bytes]:
    """Return JPEG bytes from R2 if present."""
    s3 = get_client()
    try:
        obj = s3.get_object(Bucket=R2_BUCKET, Key=thumb_key(key, size))
        return obj["Body"].read()
    except Exception:  # noqa: BLE001
        return None


def store_thumbnail(key: str, size: str, data: bytes) -> None:
    s3 = get_client()
    s3.put_object(
        Bucket=R2_BUCKET,
        Key=thumb_key(key, size),
        Body=data,
        ContentType="image/jpeg",
        CacheControl="public, max-age=86400, immutable",
    )


def build_thumbnail(key: str, size: str, content_type: str | None) -> Optional[bytes]:
    """Render a thumbnail for the source key. Stores the result in R2
    cache on success. Returns the bytes, or None if not renderable."""
    side = SIZES.get(size, SIZES["md"])
    s3 = get_client()
    try:
        obj = s3.get_object(Bucket=R2_BUCKET, Key=key)
        raw = obj["Body"].read()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Source fetch failed for thumbnail: %s", exc)
        return None
    ct = (content_type or "").lower()
    ext = (key.rsplit(".", 1)[-1] or "").lower()
    if ct.startswith("image/") or ext in {"jpg", "jpeg", "png", "gif", "webp", "heic"}:
        out = render_image_bytes(raw, side)
    elif ct == "application/pdf" or ext == "pdf":
        out = render_pdf_bytes(raw, side)
    else:
        out = None
    if out:
        try:
            store_thumbnail(key, size, out)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Store thumb failed: %s", exc)
    return out
