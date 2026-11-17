from urllib.parse import parse_qs, urlparse

import httpx
from app import account_routes, oauth_config_routes
from app.common import current_user
from app.db import Store
from app.gpu import google
from app.gpu.google import GoogleService
from app.gpu.repository import Repository
from app.main import google_callback
from fastapi import FastAPI
from fastapi.testclient import TestClient


def test_account_authorizations_survive_reopening_database(monkeypatch, tmp_path):
    for variable in ("GPU_GOOGLE_CLIENT_ID", "GPU_GOOGLE_CLIENT_SECRET", "GPU_GOOGLE_SECRET"):
        monkeypatch.delenv(variable, raising=False)

    exchanges = []
    refreshes = []

    def token_endpoint(request):
        form = parse_qs(request.content.decode())
        assert form["client_id"] == ["123456789-example.apps.googleusercontent.com"]
        assert form["client_secret"] == ["saved-client-secret"]
        if form["grant_type"] == ["authorization_code"]:
            purpose = form["code"][0]
            exchanges.append(purpose)
            return httpx.Response(200, json={
                "access_token": f"access-{purpose}",
                "refresh_token": f"refresh-{purpose}",
                "expires_in": 1,
            })
        refresh = form["refresh_token"][0]
        refreshes.append(refresh)
        return httpx.Response(200, json={"access_token": f"renewed-{refresh}", "expires_in": 3600})

    transport = httpx.Client(transport=httpx.MockTransport(token_endpoint))
    monkeypatch.setattr(google, "GoogleService", lambda *args, **kwargs: GoogleService(
        *args, client=transport, **kwargs,
    ))
    database_url = f"sqlite:///{tmp_path / 'studio.db'}"
    app = FastAPI()
    app.state.store = Store(database_url)
    app.dependency_overrides[current_user] = lambda: {"id": "owner", "role": "admin"}
    app.include_router(account_routes.router)
    app.include_router(oauth_config_routes.router)
    app.add_api_route("/api/gpu/auth/google/callback", google_callback, methods=["GET"])
    client = TestClient(app)

    try:
        configured = client.post("/api/gpu/auth/google/config", json={
            "client_id": "123456789-example.apps.googleusercontent.com",
            "client_secret": "saved-client-secret",
            "confirmed": True,
        })
        assert configured.status_code == 200, configured.text
        created = client.post("/api/gpu/accounts", json={"alias": "Jake-Ultra"},
                              headers={"Idempotency-Key": "create-jake"})
        assert created.status_code == 201, created.text
        account_id = created.json()["data"]["account_id"]

        for purpose in ("colab", "drive"):
            started = client.post(f"/api/gpu/accounts/{account_id}/auth/{purpose}/start", json={},
                                  headers={"Idempotency-Key": f"connect-{purpose}"})
            assert started.status_code == 200, started.text
            state = started.json()["data"]["state"]
            callback = client.get("/api/gpu/auth/google/callback", params={"code": purpose, "state": state},
                                  follow_redirects=False)
            assert callback.status_code == 303, callback.text
            target = urlparse(callback.headers["location"])
            assert parse_qs(target.query) == {"google": ["connected"]}
            assert target.fragment == "google-accounts"

            # A newly created Store simulates the process being replaced during
            # deployment, including between the two authorization steps.
            app.state.store.engine.dispose()
            app.state.store = Store(database_url)
            listed = client.get("/api/gpu/accounts")
            assert listed.status_code == 200, listed.text
            accounts = listed.json()["data"]
            assert len(accounts) == 1
            assert accounts[0]["account_id"] == account_id
            assert accounts[0]["alias"] == "Jake-Ultra"
            assert accounts[0]["authorization"]["colab"]["connected"] is True
            assert accounts[0]["authorization"]["drive"]["connected"] is (purpose == "drive")

        service = GoogleService(Repository(app.state.store), "owner", account_id=account_id, client=transport)
        for purpose in ("colab", "drive"):
            assert service.access_token(purpose) == f"renewed-refresh-{purpose}"
        assert exchanges == ["colab", "drive"]
        assert refreshes == ["refresh-colab", "refresh-drive"]
        assert "refresh-colab" not in listed.text
        assert "saved-client-secret" not in listed.text

        app.dependency_overrides[current_user] = lambda: {"id": "another-owner", "role": "admin"}
        assert client.get("/api/gpu/accounts").json()["data"] == []
    finally:
        client.close()
        transport.close()
        app.state.store.engine.dispose()
