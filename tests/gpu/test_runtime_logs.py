import contextlib
import io
import json
import uuid
from types import SimpleNamespace

import pytest
from app.common import APIError
from app.db import Store
from app.gpu.mcp import MCPTransient, build_poll_code
from app.gpu.repository import Repository
from app.gpu.runtime_logs import MAX_LOG_BYTES, public_runtime_logs
from app.gpu.scheduler import Scheduler
from app.main import get_job
from app.presenters import public_job


def test_status_probe_reads_bounded_worker_and_comfy_logs(tmp_path):
    execution_id = str(uuid.uuid4())
    root = tmp_path / execution_id
    root.mkdir()
    (root / "status.json").write_text(json.dumps({"state": "running", "stage": "prep_weights"}))
    (root / "worker.log").write_text("old line\n" * MAX_LOG_BYTES + "model.safetensors 123/456\n", encoding="utf-8")
    (root / "comfy.log").write_bytes(b"\x1b[32mgot prompt\x1b[0m\r50%\x00\x06\nAuthorization: Bearer private-value\n")
    original = (root / "status.json").read_bytes()
    code = build_poll_code(execution_id).replace("/content/ai-studio", tmp_path.as_posix())
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        exec(compile(code, "trusted-status-probe", "exec"), {})
    result = json.loads(output.getvalue())
    assert result["state"] == "running"
    assert result["execution_id"] == execution_id
    assert len(result["runtime_logs"]["worker"].encode()) <= MAX_LOG_BYTES
    logs = public_runtime_logs(result["runtime_logs"])
    assert logs["worker"].endswith("model.safetensors 123/456")
    assert "got prompt\n50%" in logs["comfyui"]
    assert "private-value" not in logs["comfyui"]
    assert not any(ord(char) < 32 and char not in "\n\t" for char in logs["comfyui"])
    assert (root / "status.json").read_bytes() == original


def test_log_projection_bounds_and_redacts_each_file():
    logs = public_runtime_logs({
        "collected_at": float("inf"),
        "worker": "ready\npassword=private-password\nGET https://host.invalid/file?signature=private\nBearer private-bearer\nfinished",
        "comfyui": 123,
        "payload": "private-payload",
    })
    assert set(logs) == {"worker"}
    assert logs["worker"].startswith("ready") and logs["worker"].endswith("finished")
    assert "private" not in logs["worker"]
    assert "REDACTED" in logs["worker"]
    assert public_runtime_logs({"worker": "password=" + "s" * (MAX_LOG_BYTES * 2)})["worker"] == ""


def test_poll_keeps_real_logs_through_retry_and_details_remain_owner_scoped():
    store = Store("sqlite://")
    repo = Repository(store)
    execution_id = str(uuid.uuid4())
    job = repo.create("jobs", "owner", {"state": "running", "execution_id": execution_id, "prep": True})
    repo.create("leases", "owner", {"owner_job_id": job["id"], "state": "active", "handle": {}})
    replies = iter([
        {"state": "running", "execution_id": execution_id, "stage": "prep_weights",
         "runtime_logs": {"collected_at": 100, "worker": "download model 1/2\nsecret=private-secret"}},
        MCPTransient("Colab kernel inspect HTTP 403"),
        {"state": "running", "execution_id": execution_id,
         "runtime_logs": {"collected_at": 110, "worker": "download model 2/2"}},
    ])

    class Executor:
        def poll(self, *_):
            result = next(replies)
            if isinstance(result, Exception):
                raise result
            return result

    clock = [100.0]
    scheduler = Scheduler(repo, executor_factory=lambda _: Executor(), clock=lambda: clock[0])
    job = scheduler._run(job)
    assert "download model 1/2" in job["runtime_logs"]["worker"]
    assert "private-secret" not in json.dumps(job["runtime_logs"])
    job = scheduler._run(job)
    assert "HTTP 403" in job["poll_last_error"]
    assert job["runtime_logs"]["collected_at"] == 100
    events = repo.list("events", "owner")
    assert any("CPU 状态查询暂时失败" in event["message"] and "HTTP 403" in event["message"] for event in events)

    request = SimpleNamespace(state=SimpleNamespace(request_id="runtime-logs-test"))
    detail = json.loads(get_job(job["id"], request, user={"id": "owner"}, st=store).body)["data"]
    assert detail["runtime_logs"] == job["runtime_logs"]
    assert detail["poll_last_error"] == job["poll_last_error"]
    assert "runtime_logs" not in public_job(job)
    with pytest.raises(APIError) as denied:
        get_job(job["id"], request, user={"id": "another-owner"}, st=store)
    assert denied.value.status == 404

    clock[0] = 110
    job = scheduler._run(job)
    assert job["poll_retry_count"] == 0 and job["poll_last_error"] is None
    assert job["runtime_logs"]["worker"] == "download model 2/2"


def test_new_attempt_clears_current_log_snapshot_and_preserves_previous_evidence():
    repo = Repository(Store("sqlite://"))
    old_logs = {"collected_at": 100, "worker": "previous attempt"}
    job = repo.create("jobs", "owner", {
        "state": "failed", "provider": "mock", "runtime_logs": old_logs,
        "poll_last_error": "previous connection failure",
    })
    retried = repo.retry_attempt(job["id"], "owner", "new-attempt-with-logs")
    assert "runtime_logs" not in retried and "poll_last_error" not in retried
    assert retried["attempt_history"][0]["runtime_logs"] == old_logs
