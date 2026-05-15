"""One-off: apply a CORS policy to the Cloudflare R2 bucket so the admin
file browser can PUT files directly from the user's browser using presigned
URLs.

Run:  python /app/backend/scripts/apply_r2_cors.py
"""
from __future__ import annotations
import os
import sys
import json
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from file_storage import get_client, R2_BUCKET  # noqa: E402

FRONTEND_URL = os.environ.get("FRONTEND_URL", "")

# Allow the production frontend + any *.preview.emergentagent.com previews
# + localhost for local dev. R2 supports wildcard origins via "*", but we
# prefer explicit origins to scope the policy tighter.
ALLOWED_ORIGINS = [
    FRONTEND_URL,
    "https://licensee-vault.preview.emergentagent.com",
    "http://localhost:3000",
    "http://localhost:5173",
]
ALLOWED_ORIGINS = [o for o in ALLOWED_ORIGINS if o]

CORS_RULES = {
    "CORSRules": [
        {
            "AllowedOrigins": ALLOWED_ORIGINS or ["*"],
            "AllowedMethods": ["PUT", "GET", "HEAD", "POST", "DELETE"],
            "AllowedHeaders": ["*"],
            "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
            "MaxAgeSeconds": 3600,
        }
    ]
}


def main():
    s3 = get_client()
    print(f"Applying CORS to bucket: {R2_BUCKET}")
    print(json.dumps(CORS_RULES, indent=2))
    s3.put_bucket_cors(Bucket=R2_BUCKET, CORSConfiguration=CORS_RULES)
    print("\nVerifying...")
    got = s3.get_bucket_cors(Bucket=R2_BUCKET)
    print(json.dumps(got.get("CORSRules", []), indent=2, default=str))
    print("\nDone.")


if __name__ == "__main__":
    main()
