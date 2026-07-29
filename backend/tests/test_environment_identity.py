"""Environment identity + two-fingerprint safety tests.

Verifies:
  * Credentials never leaked.
  * `deployment_fingerprint` = f(env_name, deployment_id, backend_url).
  * `datastore_fingerprint` = f(mongo_host, mongo_db_name).
  * The two fingerprints are independent of each other:
      - changing env_name changes deployment_fp only, not datastore_fp
      - changing mongo_host changes datastore_fp only, not deployment_fp
  * A shared localhost mongo_host on two pods yields the same
    `datastore_fingerprint`, so on its own it does NOT prove isolation.
    The environment_name gate + operator confirmation are what carry
    the isolation guarantee.
  * `ENVIRONMENT_NAME` outside {preview, production} → `unset`.
"""
from __future__ import annotations

import hashlib
import importlib
import sys

sys.path.insert(0, "/app/backend")


def test_strip_credentials_removes_user_pass():
    from environment_identity import _strip_credentials
    assert _strip_credentials("mongodb://user:p%40ss@cluster0.mongodb.net/db") == "cluster0.mongodb.net"
    assert _strip_credentials("mongodb+srv://a:b@cluster0.abc.mongodb.net/db") == "cluster0.abc.mongodb.net"
    assert _strip_credentials("mongodb://localhost:27017/db") == "localhost:27017"
    assert _strip_credentials("mongodb://a:b@host1:27017,host2:27017/db?replicaSet=rs0") == "host1:27017,host2:27017"


def _reload(monkeypatch, **env):
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    import environment_identity as mod
    importlib.reload(mod)
    return mod


def test_no_credentials_leak_in_output(monkeypatch):
    mod = _reload(monkeypatch,
                  MONGO_URL="mongodb://admin:supersecret@cluster0.mongodb.net/db",
                  DB_NAME="creative_mojo_admin",
                  ENVIRONMENT_NAME="preview",
                  DEPLOYMENT_ID="test-123")
    text = repr(mod.environment_identity())
    for secret in ("supersecret", "mongodb://"):
        assert secret not in text, f"secret leaked: {secret}"


def test_deployment_fingerprint_shape(monkeypatch):
    mod = _reload(monkeypatch,
                  DB_NAME="d", MONGO_URL="mongodb://x:y@h/db",
                  ENVIRONMENT_NAME="production",
                  DEPLOYMENT_ID="deploy-42",
                  PUBLIC_URL="https://hub.creativemojo.co.uk")
    idn = mod.environment_identity()
    expected = hashlib.sha256(
        "production|deploy-42|https://hub.creativemojo.co.uk".encode()
    ).hexdigest()
    assert idn["deployment_fingerprint"] == expected


def test_datastore_fingerprint_shape(monkeypatch):
    mod = _reload(monkeypatch,
                  MONGO_URL="mongodb://x:y@host-a:27017/db",
                  DB_NAME="creative_mojo_admin",
                  ENVIRONMENT_NAME="production",
                  DEPLOYMENT_ID="d1")
    idn = mod.environment_identity()
    expected = hashlib.sha256(
        "host-a:27017|creative_mojo_admin".encode()
    ).hexdigest()
    assert idn["datastore_fingerprint"] == expected


def test_two_fingerprints_are_independent(monkeypatch):
    # A) baseline
    mod = _reload(monkeypatch, MONGO_URL="mongodb://x:y@h1/db",
                  DB_NAME="d", ENVIRONMENT_NAME="preview",
                  DEPLOYMENT_ID="d1", PUBLIC_URL="https://a.example")
    base = mod.environment_identity()

    # B) change ENV / deploy only — deployment_fp changes, datastore_fp same
    mod = _reload(monkeypatch, MONGO_URL="mongodb://x:y@h1/db",
                  DB_NAME="d", ENVIRONMENT_NAME="production",
                  DEPLOYMENT_ID="d2", PUBLIC_URL="https://b.example")
    b = mod.environment_identity()
    assert b["deployment_fingerprint"] != base["deployment_fingerprint"]
    assert b["datastore_fingerprint"] == base["datastore_fingerprint"]

    # C) change datastore only — datastore_fp changes, deployment_fp same
    mod = _reload(monkeypatch, MONGO_URL="mongodb://x:y@h2/db",
                  DB_NAME="d2", ENVIRONMENT_NAME="preview",
                  DEPLOYMENT_ID="d1", PUBLIC_URL="https://a.example")
    c = mod.environment_identity()
    assert c["deployment_fingerprint"] == base["deployment_fingerprint"]
    assert c["datastore_fingerprint"] != base["datastore_fingerprint"]


def test_shared_localhost_yields_same_datastore_fp(monkeypatch):
    """Documents the intentional limitation: two pods that both use
    'localhost:27017' as their MongoDB will report the same
    datastore_fingerprint. This is why operator confirmation of database
    isolation is required — the fingerprint alone cannot prove it.
    """
    mod = _reload(monkeypatch, MONGO_URL="mongodb://x:y@localhost:27017/db",
                  DB_NAME="creative_mojo_admin",
                  ENVIRONMENT_NAME="preview", DEPLOYMENT_ID="d1")
    fp_preview = mod.environment_identity()["datastore_fingerprint"]
    mod = _reload(monkeypatch, MONGO_URL="mongodb://x:y@localhost:27017/db",
                  DB_NAME="creative_mojo_admin",
                  ENVIRONMENT_NAME="production", DEPLOYMENT_ID="d2")
    fp_prod = mod.environment_identity()["datastore_fingerprint"]
    assert fp_preview == fp_prod  # documented limitation


def test_credential_rotation_does_not_change_datastore_fp(monkeypatch):
    mod = _reload(monkeypatch, MONGO_URL="mongodb://u1:p1@h/db",
                  DB_NAME="d", ENVIRONMENT_NAME="production",
                  DEPLOYMENT_ID="d1")
    fp1 = mod.environment_identity()["datastore_fingerprint"]
    mod = _reload(monkeypatch, MONGO_URL="mongodb://u2:p2@h/db",
                  DB_NAME="d", ENVIRONMENT_NAME="production",
                  DEPLOYMENT_ID="d1")
    fp2 = mod.environment_identity()["datastore_fingerprint"]
    assert fp1 == fp2


def test_environment_name_invalid_reported_as_unset(monkeypatch):
    mod = _reload(monkeypatch, ENVIRONMENT_NAME="staging")
    assert mod.environment_identity()["environment_name"] == "unset"
