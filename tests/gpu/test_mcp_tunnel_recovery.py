import json
import time
import uuid
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from app.db import Store
from app.gpu.colab import GoogleColabProvider
from app.gpu.mcp import MCPGPUExecutor
from app.gpu.repository import Repository
from app.security import encrypt_secret
from websockets.datastructures import Headers
from websockets.exceptions import InvalidStatus
from websockets.http11 import Response


@pytest.mark.parametrize("denial_at", ["inspect", "list", "start", "websocket"])
def test_proxy_rejection_refreshes_credentials_before_retry(monkeypatch, denial_at):
    repo = Repository(Store("sqlite://"))
    lease = repo.create("leases", "owner", {
        "runtime_id": "runtime-1", "owner_job_id": "job-1", "tunnel_endpoint": "endpoint-1",
        "proxy_url": "https://proxy.invalid", "encrypted_proxy_token": encrypt_secret("stale-proxy"),
        "proxy_token_expires_at": time.time() + 3600,
        **({"kernel_id": "kernel-1"} if denial_at in ("inspect", "websocket") else {}),
    }, record_id="lease-1")
    refreshes = []
    inspected = []
    execution_id = str(uuid.uuid4())

    def refresh_proxy(self, current):
        refreshes.append(current["id"])
        repo.update("leases", current["id"], {
            "encrypted_proxy_token": encrypt_secret("fresh-proxy"),
            "proxy_token_expires_at": time.time() + 3600,
        }, "owner")
        return {"endpoint": "endpoint-1"}

    monkeypatch.setattr(GoogleColabProvider, "_sync_tunnel_lease", refresh_proxy)
    monkeypatch.setattr("app.gpu.mcp.time.sleep", lambda _: None)

    def kernel_http(request):
        credential = request.headers["X-Colab-Runtime-Proxy-Token"]
        inspected.append(credential)
        action = "inspect" if request.url.path.endswith("/kernel-1") else "start" if request.method == "POST" else "list"
        if action == denial_at and credential == "stale-proxy":
            return httpx.Response(403)
        if action == "list":
            return httpx.Response(200, json=[])
        return httpx.Response(200, json={"id": "kernel-1"})

    class Socket:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def send(self, raw):
            message = MCPGPUExecutor._ws_unpack_default(raw)
            parent = {"msg_id": message["header"]["msg_id"]}
            result = {"execution_id": execution_id, "state": "running", "stage": "restore_weights",
                      "runtime_logs": {"collected_at": 100, "worker": "model download 123/456"}}
            self.messages = iter([
                {"header": {"msg_type": "stream"}, "parent_header": parent,
                 "content": {"name": "stdout", "text": json.dumps(result)}},
                {"header": {"msg_type": "execute_reply"}, "parent_header": parent, "content": {"status": "ok"}},
                {"header": {"msg_type": "status"}, "parent_header": parent, "content": {"execution_state": "idle"}},
            ])

        def recv(self, **_):
            return json.dumps(next(self.messages))

    def connect_socket(url, **_):
        credential = parse_qs(urlparse(url).query)["colab-runtime-proxy-token"][0]
        if denial_at == "websocket" and credential == "stale-proxy":
            raise InvalidStatus(Response(403, "Forbidden", Headers()))
        assert credential == "fresh-proxy"
        return Socket()

    monkeypatch.setattr("websockets.sync.client.connect", connect_socket)
    with httpx.Client(transport=httpx.MockTransport(kernel_http)) as client:
        executor = MCPGPUExecutor(repo, "owner", client=client)
        result = executor.poll({
            "owner_id": "owner", "runtime_name": "runtimes/runtime-1", "runtime_id": "runtime-1",
            "owner_job_id": "job-1",
        }, {"id": "job-1", "execution_id": execution_id})

    assert result["execution_id"] == execution_id
    assert result["runtime_logs"]["worker"] == "model download 123/456"
    assert result["state"] == "running"
    assert refreshes == [lease["id"]]
    assert inspected[0] == "stale-proxy" and inspected[-1] == "fresh-proxy"
