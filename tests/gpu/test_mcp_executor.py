from __future__ import annotations

import base64
import hashlib
import json
import time
import uuid
from email.utils import formatdate

import httpx
import pytest
from app.db import Store
from app.gpu.mcp import MCPError, MCPGPUExecutor, MCPRateLimited
from app.gpu.repository import Repository

TOKEN = "access-token"
RUNTIME = {"runtime_name": "runtimes/runtime-1", "runtime_id": "runtime-1", "owner_id": "owner-1"}


def _text_result(value: dict) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(value)}]}


def _job() -> dict:
    return {
        "id": "job-1",
        "owner_id": "owner-1",
        "execution_id": "11111111-1111-4111-8111-111111111111",
        "max_runtime_minutes": 10,
        "snapshot": {
            "manifest": {"state": "published", "reviewed": True},
            "bound_graph": {"1": {"class_type": "CheckpointLoaderSimple", "inputs": {}}},
        },
    }


class Google:
    def access_token(self, purpose: str) -> str:
        assert purpose == "colab"
        return TOKEN


def test_start_calls_official_mcp_tools_and_embeds_only_trusted_bootstrap():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(json.loads(request.content))
        assert request.url == "https://colaboratory.googleapis.com/mcp"
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        assert request.headers["accept"] == "application/json,text/event-stream"
        body = calls[-1]
        if body["params"]["name"] == "create_session":
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": body["id"],
                    "result": _text_result(
                        {
                            "session": (
                                "runtimes/runtime-1/sessions/studio-"
                                + hashlib.sha256(b"job-1").hexdigest()[:32]
                            )
                        }
                    ),
                },
            )
        arguments = body["params"]["arguments"]
        assert body["params"]["name"] == "execute_code"
        assert arguments["session"] == (
            "runtimes/runtime-1/sessions/studio-" + hashlib.sha256(b"job-1").hexdigest()[:32]
        )
        assert arguments["executionId"] == _job()["execution_id"]
        assert "Popen" in arguments["code"] and "shell=False" in arguments["code"]
        assert "/content/ai-studio" in arguments["code"]
        assert "user_code" not in arguments["code"]
        return httpx.Response(
            200, json={"jsonrpc": "2.0", "id": body["id"], "result": _text_result({"started": True})}
        )

    executor = MCPGPUExecutor(
        object(), "owner-1", google=Google(), client=httpx.Client(transport=httpx.MockTransport(handler))
    )
    result = executor.start(RUNTIME, _job(), _job()["execution_id"])
    assert result["execution_id"] == _job()["execution_id"]
    assert [call["params"]["name"] for call in calls] == ["create_session", "execute_code"]
    assert calls[0]["params"]["arguments"] == {
        "parent": "runtimes/runtime-1",
        "sessionId": "studio-" + hashlib.sha256(b"job-1").hexdigest()[:32],
    }


def test_poll_uses_new_execution_id_and_recovers_sse_status_with_bounded_output():
    seen = []
    output = base64.b64encode(b"png").decode()

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body)
        name = body["params"]["name"]
        if name == "create_session":
            return httpx.Response(
                200,
                json={
                    "jsonrpc": "2.0",
                    "id": body["id"],
                    "result": {
                        "session": (
                            "runtimes/runtime-1/sessions/studio-" + hashlib.sha256(b"job-1").hexdigest()[:32]
                        )
                    },
                },
            )
        assert name == "execute_code"
        code = body["params"]["arguments"]["code"]
        assert "status.json" in code and "base64" in code and "100 * 1024 * 1024" in code
        execution_id = body["params"]["arguments"]["executionId"]
        assert uuid.UUID(execution_id).version == 4
        payload = {
            "state": "completed",
            "outputs": [{"filename": "x.png", "mime": "image/png", "content": output}],
        }
        raw = f"data: {json.dumps({'jsonrpc': '2.0', 'id': body['id'], 'result': {'content': [{'type': 'text', 'text': json.dumps(payload)}]}})}\n\ndata: [DONE]\n\n"
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=raw)

    executor = MCPGPUExecutor(
        object(), "owner-1", google=Google(), client=httpx.Client(transport=httpx.MockTransport(handler))
    )
    result = executor.poll(RUNTIME, _job())
    assert result["state"] == "completed"
    assert result["outputs"][0]["content"] == b"png"
    assert seen[0]["params"]["name"] == "create_session"
    assert seen[1]["params"]["name"] == "execute_code"
    assert seen[1]["params"]["arguments"]["executionId"] != _job()["execution_id"]


def test_invalid_execution_id_and_untrusted_runtime_fail_closed():
    executor = MCPGPUExecutor(
        object(),
        "owner-1",
        google=Google(),
        client=httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(500))),
    )
    with pytest.raises(MCPError):
        executor.start(RUNTIME, _job(), "not-a-uuid")
    with pytest.raises(MCPError):
        executor.start({**RUNTIME, "owner_id": "other"}, _job(), _job()["execution_id"])


def test_repeated_start_script_is_marker_idempotent_not_restart():
    scripts = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body["params"]["name"] == "create_session":
            return httpx.Response(
                200,
                json={
                    "result": {
                        "session": (
                            "runtimes/runtime-1/sessions/studio-" + hashlib.sha256(b"job-1").hexdigest()[:32]
                        )
                    }
                },
            )
        scripts.append(body["params"]["arguments"]["code"])
        return httpx.Response(
            200, json={"result": {"content": [{"type": "text", "text": json.dumps({"existing": True})}]}}
        )

    executor = MCPGPUExecutor(
        object(), "owner-1", google=Google(), client=httpx.Client(transport=httpx.MockTransport(handler))
    )
    first = executor.start(RUNTIME, _job(), _job()["execution_id"])
    second = executor.start(RUNTIME, _job(), _job()["execution_id"])
    assert first["execution_id"] == second["execution_id"]
    assert all("O_EXCL" in script and "Popen" in script for script in scripts)
    assert all("if _marker.exists()" in script for script in scripts)


@pytest.mark.parametrize("header,wait", [("120", 120), ("0", 0), ("bad value", 0), ("http-date", 120)])
def test_429_respects_retry_after_without_an_inner_retry(monkeypatch, header, wait):
    calls = []
    now = 1_790_000_000
    if header == "http-date":
        header = formatdate(now + wait, usegmt=True)
    monkeypatch.setattr(time, "time", lambda: now)
    monkeypatch.setattr(time, "sleep", lambda delay: pytest.fail(f"unexpected inline retry sleep: {delay}"))

    def handler(request):
        calls.append(request)
        return httpx.Response(429, headers={"Retry-After": header})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        executor = MCPGPUExecutor(object(), "owner-1", google=Google(), client=client)
        with pytest.raises(MCPRateLimited) as failure:
            executor.poll(RUNTIME, _job())
    assert failure.value.retry_after == wait
    assert len(calls) == 1


def test_mcp_session_survives_restart_and_is_recreated_once_after_expiry():
    repo = Repository(Store("sqlite://"))
    handle = {**RUNTIME, "job_id": "job-1"}
    lease = repo.create("leases", "owner-1", {"runtime_id": "runtime-1", "owner_job_id": "job-1"})
    calls = []
    sessions = []
    expired = set()

    def handler(request):
        body = json.loads(request.content)
        name = body["params"]["name"]
        arguments = body["params"]["arguments"]
        calls.append(name)
        if name == "create_session":
            sessions.append(f"runtimes/runtime-1/sessions/test-{len(sessions)}")
            result = {"session": sessions[-1]}
        elif arguments["session"] in expired:
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"],
                                           "error": {"code": -32000, "message": "Session not found"}})
        else:
            result = _text_result({"state": "running"})
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": result})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        def poll():
            executor = MCPGPUExecutor(repo, "owner-1", google=Google(), client=client)
            assert executor.poll(handle, _job())["state"] == "running"

        poll()
        poll()
        assert calls == ["create_session", "execute_code", "execute_code"]
        expired.add(sessions[0])
        poll()
        poll()
    assert calls[3:] == ["execute_code", "create_session", "execute_code", "execute_code"]
    assert repo.get("leases", lease["id"], "owner-1")["mcp_session"] == sessions[-1]


@pytest.mark.parametrize('message,transient', [('temporarily unavailable',True),('deadline exceeded',True),('permission denied',False),('invalid params',False)])
def test_rpc_error_classification_is_safe(message,transient):
    from app.gpu.mcp import MCPTransient
    executor=MCPGPUExecutor(object(),'owner-1',google=Google(),client=httpx.Client(
        transport=httpx.MockTransport(lambda _:httpx.Response(200,json={'error':{'code':-32000,'message':message+' fake-secret'}}))))
    with pytest.raises(MCPError) as caught:
        executor._rpc('tools/call',{})
    assert isinstance(caught.value,MCPTransient)==transient
    assert 'fake-secret' not in str(caught.value)
