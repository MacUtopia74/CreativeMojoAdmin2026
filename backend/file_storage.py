"""Phase 3 — R2 storage client + utilities.

Read-only-by-default S3 client pointing at Cloudflare R2. Used by:
  - filecamp_migration.py  (writes during commit, reads during dry-run)
  - files_routes.py        (admin file browser CRUD + signed URLs)
"""
from __future__ import annotations

import os
import re
import logging
from functools import lru_cache
from typing import Optional, Iterable
import boto3
from botocore.config import Config

logger = logging.getLogger("creative-mojo-admin.r2")

R2_ENDPOINT_URL = os.environ.get("R2_ENDPOINT_URL", "")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET = os.environ.get("R2_BUCKET", "")
R2_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID", "")

# Access scopes — drive what folder structure means in R2
SCOPE_FRANCHISEE = "franchisee"   # /franchisees/{slug}/...
SCOPE_SHARED = "shared"           # /shared/{slug}/...  -- all franchisees can read
SCOPE_ADMIN = "admin"             # /admin/{slug}/...   -- admins only

# Maximum size we'll display in the index in MB before truncating
MAX_INDEX_FILE_BYTES = 50 * 1024 * 1024 * 1024  # 50 GB hard cap to avoid bug edge cases


@lru_cache(maxsize=1)
def _client():
    if not R2_ENDPOINT_URL:
        raise RuntimeError("R2 not configured: R2_ENDPOINT_URL is empty")
    return boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT_URL,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 4}),
    )


def get_client():
    return _client()


def r2_configured() -> bool:
    return all([R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET])


# ---------------------------------------------------------------------------
# Naming helpers
# ---------------------------------------------------------------------------
def slugify(s: str, max_len: int = 80) -> str:
    """URL-safe slug for folder names. Keeps a-z, 0-9 and hyphens only."""
    s = s.strip().lower()
    s = re.sub(r"&amp;|&", "and", s)
    s = re.sub(r"[^\w\s-]", "", s, flags=re.UNICODE)
    s = re.sub(r"[-\s_]+", "-", s).strip("-")
    return s[:max_len] or "untitled"


def franchisee_folder_key(franchise_number: Optional[str], organisation: Optional[str], first_name: Optional[str] = None, last_name: Optional[str] = None) -> str:
    """Build a deterministic per-franchisee R2 key prefix.
    Example: '0046-creative-mojo-central-scotland-gail-wright/'
    Falls back to a UUID-style fallback if we have nothing usable."""
    parts = []
    if franchise_number:
        parts.append(str(franchise_number).zfill(4))
    if organisation:
        parts.append(slugify(organisation, 60))
    if not organisation and (first_name or last_name):
        parts.append(slugify(f"{first_name or ''} {last_name or ''}", 60))
    if not parts:
        return ""
    return "-".join(p for p in parts if p) + "/"


# ---------------------------------------------------------------------------
# Mapping FileCamp top-level folder names → R2 prefix + access scope
# Anything not listed here is admin-only by default (safe).
# ---------------------------------------------------------------------------
FILECAMP_FOLDER_MAP: dict[str, dict] = {
    "Franchisees": {
        # Special-cased inside the migration walker: deep-mapped per franchisee.
        "scope": SCOPE_FRANCHISEE,
        "prefix": "franchisees/",
    },
    "Files for all franchisees": {
        "scope": SCOPE_SHARED,
        "prefix": "shared/files-for-all-franchisees/",
    },
    "Meeting Audio Files": {
        "scope": SCOPE_SHARED,
        "prefix": "shared/meeting-audio-files/",
    },
    "Franchise Sales PDF": {
        "scope": SCOPE_ADMIN,
        "prefix": "admin/franchise-sales-pdf/",
    },
    "Mojo Digital Activity Packs": {
        "scope": SCOPE_ADMIN,
        "prefix": "admin/mojo-digital-activity-packs/",
    },
    "Mojo World": {
        "scope": SCOPE_ADMIN,
        "prefix": "admin/mojo-world/",
    },
    "Misc": {
        "scope": SCOPE_ADMIN,
        "prefix": "admin/misc/",
    },
    "Old Stuff": {
        "scope": SCOPE_ADMIN,
        "prefix": "admin/old-stuff/",
    },
}
# Top-level entries we explicitly never migrate
FILECAMP_SKIP_PREFIXES = (".trash", ".versions", ".DS_Store", "._", ".filecamp", ".htaccess")


def is_noise_filename(name: str) -> bool:
    """Should we skip this filename outright? (macOS junk, system files, etc.)"""
    base = name.rsplit("/", 1)[-1]
    if not base:
        return True
    if base.startswith("._"):
        return True
    if base.startswith(".DS_Store"):
        return True
    return False


# ---------------------------------------------------------------------------
# Direct R2 helpers
# ---------------------------------------------------------------------------
def list_prefix(prefix: str, delimiter: Optional[str] = "/", page_size: int = 1000) -> Iterable[dict]:
    """Generator over Contents + CommonPrefixes under a prefix."""
    s3 = get_client()
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=R2_BUCKET, Prefix=prefix,
                                    Delimiter=delimiter or "",
                                    PaginationConfig={"PageSize": page_size}):
        # Folders (CommonPrefixes)
        for cp in page.get("CommonPrefixes", []) or []:
            yield {"type": "folder", "key": cp["Prefix"]}
        # Files
        for obj in page.get("Contents", []) or []:
            # Skip the "folder placeholder" objects sometimes created with a / suffix
            if obj["Key"].endswith("/"):
                continue
            yield {
                "type": "file",
                "key": obj["Key"],
                "size": obj["Size"],
                "last_modified": obj["LastModified"].isoformat(),
                "etag": obj["ETag"].strip('"'),
            }


def presigned_get_url(key: str, expires_in: int = 3600,
                      content_disposition: Optional[str] = None) -> str:
    """Generate a time-limited download URL. content_disposition can be e.g.
    'attachment; filename="report.pdf"'."""
    params = {"Bucket": R2_BUCKET, "Key": key}
    if content_disposition:
        params["ResponseContentDisposition"] = content_disposition
    return get_client().generate_presigned_url("get_object", Params=params, ExpiresIn=expires_in)


def presigned_put_url(key: str, content_type: Optional[str] = None,
                      expires_in: int = 600) -> dict:
    """Used by direct-from-browser uploads (Step 2)."""
    params: dict = {"Bucket": R2_BUCKET, "Key": key}
    if content_type:
        params["ContentType"] = content_type
    url = get_client().generate_presigned_url("put_object", Params=params, ExpiresIn=expires_in)
    return {"url": url, "key": key, "method": "PUT", "headers": {"Content-Type": content_type} if content_type else {}}


def head_object(key: str) -> Optional[dict]:
    try:
        return get_client().head_object(Bucket=R2_BUCKET, Key=key)
    except Exception:  # noqa: BLE001
        return None


def delete_object(key: str) -> None:
    get_client().delete_object(Bucket=R2_BUCKET, Key=key)


def copy_object(src_key: str, dst_key: str) -> None:
    get_client().copy_object(Bucket=R2_BUCKET, Key=dst_key,
                              CopySource={"Bucket": R2_BUCKET, "Key": src_key})
