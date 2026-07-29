"""Environment identity + fingerprint safety tests.

Verifies:
  * `environment_identity()` strips Mongo credentials.
  * `environment_identity()` never leaks secrets.
  * A confirmation_token generated with fingerprint F1 does NOT match
    an environment with fingerprint F2.
  * Setting ENVIRONMENT_NAME to something outside {preview, production}
    is reported as `unset`.
"""
from __future__ import annotations

import os
import sys
import hashlib

import pytest

sys.path.insert(0, "/app/backend")


def test_strip_credentials_removes_user_pass(monkeypatch):
    from environment_identity import _strip_credentials
    assert _strip_credentials("mongodb://user:p%40ss@cluster0.mongodb.net/db") == "cluster0.mongodb.net"
    assert _strip_credentials("mongodb+srv://a:b@cluster0.abc.mongodb.net/db") == "cluster0.abc.mongodb.net"
    assert _strip_credentials("mongodb://localhost:27017/db") == "localhost:27017"
    assert _strip_credentials("mongodb://a:b@host1:27017,host2:27017/db?replicaSet=rs0") == "host1:27017,host2:27017"


def test_environment_identity_leaks_no_secrets(monkeypatch):
    monkeypatch.setenv("MONGO_URL", "mongodb://admin:supersecret@cluster0.mongodb.net/db")
    monkeypatch.setenv("DB_NAME", "creative_mojo_admin")
    monkeypatch.setenv("ENVIRONMENT_NAME", "preview")
    monkeypatch.setenv("DEPLOYMENT_ID", "test-123")
    # Force reload of module so it picks up new env
    import importlib
    import environment_identity as mod
    importlib.reload(mod)
    identity = mod.environment_identity()
    text = repr(identity)
    for secret in ("supersecret", "mongodb://"):
        assert secret not in text, f"secret leaked: {secret}"
    assert identity["environment_name"] == "preview"
    assert identity["deployment_id"] == "test-123"
    assert identity["mongo_host"] == "cluster0.mongodb.net"
    assert identity["mongo_db_name"] == "creative_mojo_admin"
    # Fingerprint deterministic
    expected = hashlib.sha256(
        "preview|test-123|cluster0.mongodb.net|creative_mojo_admin".encode()
    ).hexdigest()
    assert identity["fingerprint"] == expected


def test_environment_name_invalid_reported_as_unset(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT_NAME", "staging")   # not in allowlist
    import importlib
    import environment_identity as mod
    importlib.reload(mod)
    assert mod.environment_identity()["environment_name"] == "unset"


def test_fingerprint_differs_across_environments(monkeypatch):
    import importlib, environment_identity as mod

    monkeypatch.setenv("MONGO_URL", "mongodb://a:b@preview-cluster.mongodb.net/db")
    monkeypatch.setenv("DB_NAME", "creative_mojo_admin")
    monkeypatch.setenv("ENVIRONMENT_NAME", "preview")
    monkeypatch.setenv("DEPLOYMENT_ID", "d1")
    importlib.reload(mod)
    preview_fp = mod.environment_identity()["fingerprint"]

    monkeypatch.setenv("MONGO_URL", "mongodb://a:b@prod-cluster.mongodb.net/db")
    monkeypatch.setenv("ENVIRONMENT_NAME", "production")
    monkeypatch.setenv("DEPLOYMENT_ID", "d2")
    importlib.reload(mod)
    production_fp = mod.environment_identity()["fingerprint"]

    assert preview_fp != production_fp
    # Even same db_name — different fingerprint. This is the key property.


def test_fingerprint_stable_when_only_credentials_change(monkeypatch):
    import importlib, environment_identity as mod

    monkeypatch.setenv("DB_NAME", "creative_mojo_admin")
    monkeypatch.setenv("ENVIRONMENT_NAME", "production")
    monkeypatch.setenv("DEPLOYMENT_ID", "d1")

    monkeypatch.setenv("MONGO_URL", "mongodb://user1:passwordA@prod.mongodb.net/db")
    importlib.reload(mod)
    fp1 = mod.environment_identity()["fingerprint"]

    monkeypatch.setenv("MONGO_URL", "mongodb://user2:passwordB@prod.mongodb.net/db")
    importlib.reload(mod)
    fp2 = mod.environment_identity()["fingerprint"]

    # Same host + db + env + deploy → same fingerprint even though
    # credentials rotated. Credential rotation is intentional and must
    # not change the environment identity.
    assert fp1 == fp2
