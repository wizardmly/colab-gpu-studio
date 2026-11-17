import json
from types import SimpleNamespace

import pytest
from app.db import Store
from app.gpu.repository import Repository
from app.gpu.scheduler import Scheduler
from app.main import get_job
from app.presenters import public_job


@pytest.fixture
def waiting_jobs(monkeypatch):
    monkeypatch.setenv("GPU_PREP", "on")
    repo = Repository(Store("sqlite://"))
    snapshot = {
        "workflow_sha256": "reviewed-workflow",
        "manifest": {"weight_files": [{"repo_id": "owner/model", "filename": "model.bin", "revision": "v1", "sha256": "a" * 64}]},
    }
    prep = repo.create("jobs", "owner", {
        "state": "running", "prep": True, "snapshot": {**snapshot, "prep": True},
        "stage": "prep_weights", "runtime_logs": {"collected_at": 100, "worker": "model download 123/456"},
        "poll_retry_count": 2, "poll_last_error": "Colab kernel inspect HTTP 403",
    })
    parent = repo.create("jobs", "owner", {
        "state": "waiting_for_capacity", "provider": "colab", "snapshot": snapshot,
        "prep_job_id": prep["id"], "awaiting_prep": True,
    })
    lease = repo.create("leases", "owner", {"owner_job_id": prep["id"], "state": "active"})
    return repo, parent, prep, lease


def test_parent_waits_for_cpu_cache_before_entering_gpu_allocation(waiting_jobs):
    repo, parent, prep, lease = waiting_jobs
    allocations = []

    def allocate(job):
        allocations.append(job)
        return {"id": "gpu-instance", "state": "allocating"}

    scheduler = Scheduler(repo, instance_service=SimpleNamespace(allocate=allocate))
    waiting = scheduler._advance(parent)
    assert waiting["state"] == "waiting_for_capacity" and waiting["awaiting_prep"] is True
    assert len(repo.list("jobs", "owner")) == 2
    assert [row["owner_job_id"] for row in repo.list("leases", "owner")] == [prep["id"]]
    assert allocations == []

    repo.update("jobs", prep["id"], {"state": "completed"}, "owner")
    repo.update("leases", lease["id"], {"state": "deleted"}, "owner")
    ready = scheduler._advance(waiting)
    assert ready["state"] == "allocating"
    assert ready["awaiting_prep"] is False
    assert len(allocations) == 1 and allocations[0]["awaiting_prep"] is False


@pytest.mark.parametrize("prep_state", ["completed", "failed", "cancelled"])
def test_prep_wait_flag_clears_while_cpu_cleanup_still_blocks_capacity(waiting_jobs, prep_state):
    repo, parent, prep, _lease = waiting_jobs
    repo.update("jobs", prep["id"], {"state": prep_state}, "owner")
    scheduler = Scheduler(repo, instance_service=SimpleNamespace(allocate=lambda _job: None))
    waiting = scheduler._advance(parent)
    assert waiting["state"] == "waiting_for_capacity"
    assert waiting["awaiting_prep"] is False
    assert len(repo.list("jobs", "owner")) == 2


def test_parent_details_include_linked_cpu_progress_logs_and_error(waiting_jobs):
    repo, parent, prep, _lease = waiting_jobs
    repo.event(prep["id"], "owner", "running", "正在补齐模型缓存")
    request = SimpleNamespace(state=SimpleNamespace(request_id="prep-test"))
    response = get_job(parent["id"], request, user={"id": "owner"}, st=repo.store)
    detail = json.loads(response.body)["data"]
    child = detail["cache_prep"]
    assert detail["awaiting_prep"] is True
    assert child["id"] == prep["id"] and child["prep"] is True
    assert child["stage"] == "prep_weights"
    assert child["runtime_logs"]["worker"] == "model download 123/456"
    assert child["poll_last_error"] == "Colab kernel inspect HTTP 403"
    assert any(event["message"] == "正在补齐模型缓存" for event in child["events"])
    assert "cache_prep" not in child
    listed = public_job(parent)
    assert listed["awaiting_prep"] is True and listed["prep_job_id"] == prep["id"]
    assert "cache_prep" not in listed


@pytest.mark.parametrize("binding", ["foreign", "ordinary", "missing"])
def test_cpu_dependency_projection_rejects_invalid_or_foreign_links(waiting_jobs, binding):
    repo, parent, _prep, _lease = waiting_jobs
    if binding == "missing":
        child_id = "missing-job"
    else:
        child = repo.create("jobs", "another-owner" if binding == "foreign" else "owner", {
            "state": "running", "prep": binding == "foreign",
            "runtime_logs": {"worker": "private log from another task"},
        })
        child_id = child["id"]
    repo.update("jobs", parent["id"], {"prep_job_id": child_id}, "owner")
    request = SimpleNamespace(state=SimpleNamespace(request_id="prep-isolation-test"))
    response = get_job(parent["id"], request, user={"id": "owner"}, st=repo.store)
    assert "cache_prep" not in json.loads(response.body)["data"]
    assert b"private log" not in response.body
