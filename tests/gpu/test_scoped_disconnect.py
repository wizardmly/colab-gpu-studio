"""Tests for scoped account disconnect without collateral Google OAuth grant revocation."""

from __future__ import annotations

from urllib.parse import parse_qs

import httpx
import pytest
from app.common import APIError
from app.db import Store
from app.gpu.accounts import AccountService
from app.gpu.google import GoogleService
from app.gpu.repository import Repository
from app.security import encrypt_secret


def _seed_two_accounts_sharing_client(repo: Repository, owner: str, *, client_id: str = "123-shared.apps.googleusercontent.com"):
    repo.create(
        "credentials",
        owner,
        {
            "provider": "google",
            "purpose": "oauth_client_config",
            "account_id": None,
            "client_id": client_id,
            "encrypted_client_secret": encrypt_secret("shared-client-secret"),
        },
    )
    default_id = AccountService.default_account_id(owner)
    repo.create(
        "accounts",
        owner,
        {
            "account_id": default_id,
            "alias": "Google账号",
            "enabled": True,
            "allow_allocation": False,
            "projects": [],
            "workflows": [],
            "budget": {},
            "strategy": "manual",
            "legacy_default": True,
        },
        record_id=default_id,
    )
    service = AccountService(repo, owner)
    jake = service.create({"alias": "Jake-Ultra", "enabled": True, "allow_allocation": True}, "create-jake")
    jake_id = jake["account_id"]

    for account_id, prefix in ((default_id, "legacy"), (jake_id, "jake")):
        for purpose in ("colab", "drive"):
            repo.create(
                "credentials",
                owner,
                {
                    "provider": "google",
                    "purpose": purpose,
                    "account_id": account_id,
                    "encrypted_access_token": encrypt_secret(f"{prefix}-{purpose}-access"),
                    "encrypted_refresh_token": encrypt_secret(f"{prefix}-{purpose}-refresh"),
                    "expires_at": 9_999_999_999,
                },
            )
    return service, default_id, jake_id


def _patch_google_client(monkeypatch, revoke_calls: list[dict]):
    def handler(request: httpx.Request) -> httpx.Response:
        revoke_calls.append({"url": str(request.url), "form": parse_qs(request.content.decode())})
        return httpx.Response(200, json={})

    transport = httpx.MockTransport(handler)

    class SpyGoogleService(GoogleService):
        def __init__(self, store, owner_id, *, account_id=None, **kwargs):
            kwargs.setdefault("client", httpx.Client(transport=transport))
            super().__init__(store, owner_id, account_id=account_id, **kwargs)

    monkeypatch.setattr("app.gpu.google.GoogleService", SpyGoogleService)
    return SpyGoogleService


def test_disconnecting_duplicate_slot_skips_google_revoke_and_preserves_remaining_account(tmp_path, monkeypatch):
    monkeypatch.delenv("STUDIO_OFFLINE_TEST", raising=False)
    monkeypatch.delenv("GPU_GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("GPU_GOOGLE_CLIENT_SECRET", raising=False)
    revoke_calls: list[dict] = []
    spy_cls = _patch_google_client(monkeypatch, revoke_calls)

    repo = Repository(Store("sqlite:///" + str(tmp_path / "scoped_disconnect.db")))
    owner = "owner-1"
    service, default_id, jake_id = _seed_two_accounts_sharing_client(repo, owner)

    result = service.disconnect(default_id, "disc-1")
    assert result["disconnected"] is True
    assert revoke_calls == []

    creds = repo.list("credentials", owner)
    default_creds = [c for c in creds if c.get("account_id") == default_id and c.get("purpose") in {"colab", "drive"}]
    assert len(default_creds) == 2
    assert all(c["revoked"] is True and c["encrypted_refresh_token"] is None and c["encrypted_access_token"] is None for c in default_creds)
    assert all(c["disconnect_status"] == "local_only_shared_client" for c in default_creds)

    # Disconnected default slot stays hidden across subsequent list() calls and is not resurrected by _ensure_default.
    listed = AccountService(repo, owner).list()
    assert [acc["account_id"] for acc in listed] == [jake_id]
    assert [acc["account_id"] for acc in AccountService(repo, owner).list()] == [jake_id]
    with pytest.raises(APIError) as not_found:
        AccountService(repo, owner).require(default_id)
    assert not_found.value.status == 404

    jake_status = spy_cls(repo, owner, account_id=jake_id).status()
    assert jake_status["colab"]["connected"] is True
    assert jake_status["drive"]["connected"] is True


def test_disconnecting_last_remaining_account_calls_google_revoke_once(tmp_path, monkeypatch):
    monkeypatch.delenv("STUDIO_OFFLINE_TEST", raising=False)
    monkeypatch.delenv("GPU_GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("GPU_GOOGLE_CLIENT_SECRET", raising=False)
    revoke_calls: list[dict] = []
    _patch_google_client(monkeypatch, revoke_calls)

    repo = Repository(Store("sqlite:///" + str(tmp_path / "scoped_disconnect_last.db")))
    owner = "owner-1"
    service, default_id, jake_id = _seed_two_accounts_sharing_client(repo, owner)

    service.disconnect(default_id, "disc-1")
    assert revoke_calls == []

    service.disconnect(jake_id, "disc-2")
    assert len(revoke_calls) == 1
    assert revoke_calls[0]["url"] == "https://oauth2.googleapis.com/revoke"
    assert revoke_calls[0]["form"]["token"] == ["jake-drive-refresh"]
    assert AccountService(repo, owner).list() == []


def test_disconnect_blocked_when_other_account_delegates_drive(tmp_path, monkeypatch):
    monkeypatch.delenv("STUDIO_OFFLINE_TEST", raising=False)
    revoke_calls: list[dict] = []
    _patch_google_client(monkeypatch, revoke_calls)

    repo = Repository(Store("sqlite:///" + str(tmp_path / "delegated_disconnect.db")))
    owner = "owner-1"
    service = AccountService(repo, owner)
    acc_a = service.create({"alias": "Drive主号"}, "create-a")
    repo.create(
        "credentials",
        owner,
        {
            "provider": "google",
            "purpose": "drive",
            "account_id": acc_a["account_id"],
            "encrypted_access_token": encrypt_secret("a-access"),
            "encrypted_refresh_token": encrypt_secret("a-refresh"),
            "expires_at": 9_999_999_999,
        },
    )
    acc_b = service.create({"alias": "算力副号", "drive_account_id": acc_a["account_id"]}, "create-b")

    with pytest.raises(APIError) as exc_info:
        service.disconnect(acc_a["account_id"], "disc-a")
    assert exc_info.value.status == 409
    assert exc_info.value.code == "ACCOUNT_IN_USE_AS_DRIVE"
    assert revoke_calls == []

    service.disconnect(acc_b["account_id"], "disc-b")
    assert [acc["account_id"] for acc in service.list()] == [acc_a["account_id"]]
