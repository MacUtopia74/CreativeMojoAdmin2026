"""Regression: main Files admin sidebar and FranchiseeFilesPanel MUST
navigate to the same R2 root for every franchisee.

Background: for legacy franchisees (0001-era) the sidebar's ``prefix``
was computed via a plain re-derivation of the current organisation
slug, while the panel discovered the root from files_index. When the
two disagreed (rename, or ``r2_root_prefix`` never persisted), the
panel showed the three standard folders but the sidebar landed on an
empty prefix — same franchisee, two different views. This test locks
the shared-provisioning contract: convert-to-franchisee →
bootstrap-folders → both entry points return the same canonical prefix.
"""
from __future__ import annotations

import os
import time
import uuid

import pytest
import requests

BASE = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PW = "CreativeMojo2026!"


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    r = sess.post(f"{BASE}/api/auth/login",
                  json={"email": ADMIN_EMAIL, "password": ADMIN_PW}, timeout=20)
    assert r.status_code == 200, r.text[:200]
    return sess


def _make_and_convert(s, suffix):
    payload = {
        "first_name": "TEST",
        "last_name": f"SidebarParity_{suffix}",
        "email": f"sidebar_parity_{suffix}@example.com",
        "source": "franchise_enquiry",
        "target": "pipeline",
        "establishment_name": f"TEST Sidebar Parity {suffix}",
        "postcode": "se1 7tp",
        "city": "London",
        "telephone": "020 1234 5678",
        "message": "Automated regression contact — safe to delete.",
        "date": "2026-01-15",
    }
    r = s.post(f"{BASE}/api/contacts", json=payload, timeout=20)
    assert r.status_code in (200, 201), r.text[:200]
    cid = r.json().get("id") or r.json().get("contact", {}).get("id")
    conv = s.post(f"{BASE}/api/contacts/{cid}/convert-to-franchisee", timeout=30)
    assert conv.status_code == 200, conv.text[:300]
    return cid, conv.json()["franchisee"]["id"]


def test_convert_and_bootstrap_gives_matching_views(s):
    """Freshly-converted franchisee → bootstrap-folders → confirm:
      * ``r2_root_prefix`` is persisted on the franchisee doc.
      * The Files admin scope-tree returns that same prefix in the
        sidebar entry.
      * The FranchiseeFilesPanel discovery call
        (``GET /files/tree?prefix=franchisees/&franchisee_id=<id>``)
        picks the SAME prefix.
      * All three standard sub-folders (Artwork / Franchise Documents /
        Other Files) appear under that prefix in the tree — same list
        for both entry points.
    """
    suffix = f"{int(time.time())}_{uuid.uuid4().hex[:6]}"
    cid, fid = _make_and_convert(s, suffix)
    try:
        # Give the franchise a number so its slug is stable & predictable.
        r = s.patch(f"{BASE}/api/franchisees/{fid}",
                    json={"franchise_number": "9993"}, timeout=20)
        assert r.status_code == 200

        # Explicit bootstrap so we don't race with the convert-flow's
        # side-effect bootstrap.
        r = s.post(f"{BASE}/api/franchisees/{fid}/bootstrap-folders", timeout=30)
        assert r.status_code == 200, r.text[:300]
        canonical = r.json().get("prefix")
        assert canonical and canonical.startswith("franchisees/"), canonical

        # 1) r2_root_prefix persisted on the franchisee doc.
        fr = s.get(f"{BASE}/api/franchisees/{fid}", timeout=20).json()
        fdoc = fr.get("franchisee") or fr
        assert fdoc.get("r2_root_prefix") == canonical

        # 2) Sidebar entry from the scope-tree matches the canonical.
        st = s.get(f"{BASE}/api/files/scope-tree", timeout=30).json()
        sidebar_entry = next(
            (row for row in st.get("franchisees", []) if row["franchisee_id"] == fid),
            None,
        )
        assert sidebar_entry is not None, (
            "franchisee missing from Files admin sidebar — files_index probably didn't "
            "receive the .keep markers from bootstrap"
        )
        assert sidebar_entry["prefix"] == canonical, (
            f"sidebar prefix {sidebar_entry['prefix']!r} diverges from canonical "
            f"{canonical!r} — this is the exact bug that made 0001 land on an empty folder"
        )

        # 3) FranchiseeFilesPanel discovery picks the same prefix.
        disc = s.get(
            f"{BASE}/api/files/tree",
            params={"prefix": "franchisees/", "franchisee_id": fid},
            timeout=20,
        ).json()
        disc_folders = disc.get("folders", [])
        assert len(disc_folders) == 1, (
            f"root-discovery returned {len(disc_folders)} folders — should be exactly one "
            f"canonical root after the r2_root_prefix persistence fix: {disc_folders}"
        )
        assert disc_folders[0]["key"] == canonical

        # 4) Same three standard sub-folders visible from BOTH entry
        #    points. We hit the tree API once (both entry points use it)
        #    and assert the set of folder names.
        tree = s.get(f"{BASE}/api/files/tree",
                     params={"prefix": canonical}, timeout=20).json()
        names = sorted(f["name"] for f in tree.get("folders", []))
        assert names == ["Artwork", "Franchise Documents", "Other Files"], names
        # Every card is empty (0 non-hidden files) — .keep markers are
        # hidden and don't inflate the counts.
        for card in tree["folders"]:
            assert card["files"] == 0, card

    finally:
        # Best-effort cleanup.
        try: s.delete(f"{BASE}/api/franchisees/{fid}", timeout=15)
        except Exception: pass
        try: s.delete(f"{BASE}/api/contacts/{cid}", timeout=15)
        except Exception: pass


def test_bulk_bootstrap_is_idempotent(s):
    """Running ``bootstrap-folders/all`` twice must not re-create the
    .keep markers on the second run (idempotent). Also confirms the
    endpoint doesn't 500 in a healthy environment."""
    r1 = s.post(f"{BASE}/api/franchisees/bootstrap-folders/all", timeout=120)
    assert r1.status_code == 200, r1.text[:300]
    j1 = r1.json()
    r2 = s.post(f"{BASE}/api/franchisees/bootstrap-folders/all", timeout=120)
    assert r2.status_code == 200, r2.text[:300]
    j2 = r2.json()
    # Second run must not create anything — everything already there.
    assert j2["created_total"] == 0, (
        f"second bootstrap-folders/all run created {j2['created_total']} markers — "
        f"idempotence broken. First run: {j1['created_total']}, second: {j2['created_total']}"
    )
