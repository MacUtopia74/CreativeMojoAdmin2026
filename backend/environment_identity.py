"""Environment identity + fingerprinting for high-risk migration endpoints.

Purpose
-------
The Phase 3 CQC repair and TW11 9 territory migrations must NEVER be run
against the wrong database. `DB_NAME` alone is not sufficient because
preview and production can legitimately share a database name while
connecting to different Mongo clusters (or different connection strings
against the same cluster).

This module produces a non-secret **environment identity block** that
callers can visually verify before approving a commit, and a one-way
**fingerprint hash** that binds a confirmation token to the exact
(cluster host, database, environment name, deployment id) tuple. A
stale token generated on preview cannot be replayed against production.

What is emitted
---------------
* ``environment_name``  — literal string from ``ENVIRONMENT_NAME``
  ("preview" or "production"). Anything else is refused as a safety
  guard.
* ``deployment_id``     — literal string from ``DEPLOYMENT_ID`` (e.g.
  the CI build number, or a random slug per deploy).
* ``backend_url``       — the public URL the caller reached us on
  (Host header), fallback to the ``PUBLIC_URL`` / ``FRONTEND_URL`` env.
* ``mongo_host``        — the host portion of ``MONGO_URL`` **only**.
  Credentials are stripped even if present.
* ``mongo_db_name``     — the ``DB_NAME`` value.
* ``fingerprint``       — SHA-256 of
  ``env_name|deployment_id|mongo_host|mongo_db_name``. This is the
  authoritative identifier a caller compares against.

What is NEVER emitted
---------------------
* MongoDB username or password
* Full connection URI
* Any secret from ``.env``
"""
from __future__ import annotations

import hashlib
import os
import re
from typing import Optional
from urllib.parse import urlparse


_VALID_ENV_NAMES = {"preview", "production"}


def _strip_credentials(mongo_url: str) -> str:
    """Return only the host[:port] part of a Mongo URI."""
    if not mongo_url:
        return ""
    # Handle 'mongodb+srv://user:pass@cluster0.mongodb.net/db' and
    # 'mongodb://localhost:27017/db' uniformly.
    try:
        parsed = urlparse(mongo_url)
        host = parsed.hostname or ""
        # For replica-set-list style URIs, urlparse only sees the first
        # host. Extract everything between '@' (if any) and the next '/'
        # to preserve all hosts, then strip credentials.
        after_scheme = mongo_url.split("://", 1)[-1]
        no_creds = after_scheme.split("@")[-1]
        host_and_maybe_more = no_creds.split("/", 1)[0].split("?", 1)[0]
        # Strip auth if any accidentally leaked
        return re.sub(r"[^\w.:,\-\[\]]", "", host_and_maybe_more) or host
    except Exception:  # noqa: BLE001
        return "unknown"


def _resolve_env_name() -> str:
    v = (os.environ.get("ENVIRONMENT_NAME") or "").strip().lower()
    if v in _VALID_ENV_NAMES:
        return v
    return "unset"


def environment_identity() -> dict:
    """Return the non-secret environment identity block.

    Fingerprint semantics
    ---------------------
    * ``deployment_fingerprint`` = SHA-256 of
      ``env_name|deployment_id|backend_url``.
      Uniquely identifies the *pod* (which release, which URL). Changes
      when the code redeploys but stays stable across credential rotations.

    * ``datastore_fingerprint`` = SHA-256 of
      ``mongo_host|mongo_db_name``.
      Uniquely identifies the *database* the app is reading. Purely a
      claim by the application about what it can see — the operator
      must independently confirm database isolation between preview and
      production (Emergent Support does this).

    Neither fingerprint contains credentials.

    The confirmation token used by the commit endpoints binds to BOTH
    fingerprints plus the actual data state (id-list + count digest).
    A token generated on preview will therefore never validate on
    production, because at minimum the ``env_name`` differs.
    """
    env_name = _resolve_env_name()
    deployment_id = os.environ.get("DEPLOYMENT_ID") or "unset"
    mongo_host = _strip_credentials(os.environ.get("MONGO_URL", ""))
    mongo_db_name = os.environ.get("DB_NAME") or "unset"
    backend_url = (
        os.environ.get("PUBLIC_URL")
        or os.environ.get("FRONTEND_URL")
        or "unset"
    )
    deployment_fp = hashlib.sha256(
        f"{env_name}|{deployment_id}|{backend_url}".encode()
    ).hexdigest()
    datastore_fp = hashlib.sha256(
        f"{mongo_host}|{mongo_db_name}".encode()
    ).hexdigest()
    return {
        "environment_name": env_name,
        "deployment_id": deployment_id,
        "backend_url": backend_url,
        "mongo_host": mongo_host,
        "mongo_db_name": mongo_db_name,
        "deployment_fingerprint": deployment_fp,
        "datastore_fingerprint": datastore_fp,
        "deployment_fingerprint_input_shape":
            "sha256(env_name|deployment_id|backend_url)",
        "datastore_fingerprint_input_shape":
            "sha256(mongo_host|mongo_db_name)",
        "note_on_isolation": (
            "datastore_fingerprint is a self-report by the application. "
            "Where mongo_host is a shared value like 'localhost:27017' it "
            "cannot alone prove that preview and production use different "
            "physical databases. Independent operator confirmation is "
            "required for that guarantee."
        ),
    }


def refuse_if_not(env: str) -> Optional[dict]:
    """Return an error dict if the running environment is not ``env``.
    Used by mutating endpoints:
        err = refuse_if_not("production")
        if err: raise HTTPException(403, detail=err)
    """
    identity = environment_identity()
    if identity["environment_name"] != env:
        return {
            "error": "environment_mismatch",
            "expected_environment_name": env,
            "actual_identity": identity,
            "hint": (
                "The ENVIRONMENT_NAME env var must be set to "
                f"'{env}' on the target pod. Refuse to run."
            ),
        }
    if identity["environment_name"] == "unset":
        return {
            "error": "environment_name_unset",
            "actual_identity": identity,
            "hint": "Set ENVIRONMENT_NAME=preview or production on the pod.",
        }
    return None
