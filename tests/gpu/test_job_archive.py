"""Task archive preserves history and never controls a runtime's lifecycle."""

import pytest
from app.common import APIError, current_user, get_store
from app.db import Store
from app.gpu.compute import MockColabProvider, MockGPUExecutor
from app.gpu.instances import InstanceConflict
from app.gpu.repository import Repository
from app.gpu.scheduler import Scheduler
from app.instance_routes import router as instance_router
from app.main import router
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient


@pytest.fixture
def context():
    store = Store("sqlite://")
    repo = Repository(store)
    app = FastAPI()

    async def api_error(request, exc):
        return JSONResponse({"error": {"code": exc.code, "message": exc.message}}, status_code=exc.status)

    app.add_exception_handler(APIError, api_error)
    app.include_router(router, prefix="/api/gpu")
    app.include_router(instance_router)
    app.state.store = store
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[current_user] = lambda: {"id": "owner", "role": "user"}
    return repo, TestClient(app)


@pytest.mark.parametrize("state", ["failed", "cancelled", "completed"])
def test_archive_restore_survives_reload_and_preserves_job_evidence(context, state):
    repo, client = context
    job = repo.create("jobs", "owner", {"state": state, "instance_id": "instance", "output_asset_ids": ["asset"],
                      "error_message": "original failure", "snapshot": {"manifest": {"compute_spec": {"accelerator": "T4"}}}})
    event = repo.event(job["id"], "owner", state, "original event")
    instance = repo.create("instances", "owner", {"state": "unknown", "current_job_id": job["id"]}, record_id="instance")
    url = f"/api/gpu/jobs/{job['id']}/archive"
    first = client.patch(url, json={"archived": True})
    assert first.status_code == 200
    archived = first.json()["data"]
    assert archived["state"] == state and archived["archived_at"]
    assert client.patch(url, json={"archived": True}).json()["data"] == archived
    assert client.get("/api/gpu/jobs").json()["data"][0]["archived_at"] == archived["archived_at"]
    assert client.get(f"/api/gpu/jobs/{job['id']}").json()["data"]["error_message"] == "original failure"
    assert repo.get("jobs", job["id"], "owner")["snapshot"] == job["snapshot"]
    assert repo.get("events", event["id"], "owner") == event
    assert repo.get("instances", "instance", "owner") == instance
    restored = client.patch(url, json={"archived": False})
    assert restored.status_code == 200
    assert not restored.json()["data"].get("archived_at")
    assert restored.json()["data"]["output_asset_ids"] == ["asset"]
    assert not client.get("/api/gpu/jobs").json()["data"][0].get("archived_at")


@pytest.mark.parametrize("state", ["queued", "allocating", "running", "cleaning_up", "cleanup_pending"])
def test_active_job_archive_is_rejected(context, state):
    repo, client = context
    job = repo.create("jobs", "owner", {"state": state})
    response = client.patch(f"/api/gpu/jobs/{job['id']}/archive", json={"archived": True})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "JOB_ACTIVE"
    assert not repo.get("jobs", job["id"], "owner").get("archived_at")


def test_archive_is_owner_scoped_and_requires_boolean(context):
    repo, client = context
    foreign = repo.create("jobs", "other", {"state": "failed"})
    own = repo.create("jobs", "owner", {"state": "failed"})
    assert client.patch(f"/api/gpu/jobs/{foreign['id']}/archive", json={"archived": True}).status_code == 404
    assert client.patch(f"/api/gpu/jobs/{own['id']}/archive", json={"archived": "false"}).status_code == 422
    assert not repo.get("jobs", foreign["id"], "other").get("archived_at")


def test_archived_mock_retry_returns_to_default_list(context):
    repo, client = context
    job = repo.create("jobs", "owner", {"state": "failed", "provider": "mock", "snapshot": {"manifest": {"mock": True}}})
    assert client.patch(f"/api/gpu/jobs/{job['id']}/archive", json={"archived": True}).status_code == 200
    response = client.post(f"/api/gpu/jobs/{job['id']}/attempts", json={}, headers={"Idempotency-Key": "retry-archived"})
    assert response.status_code == 202
    assert response.json()["data"]["state"] == "queued"
    assert not response.json()["data"].get("archived_at")
    assert repo.get("jobs", job["id"], "owner")["attempt_history"][0]["archived_at"]


def test_unknown_instance_release_reconciles_until_remote_deletion_is_confirmed(context):
    repo, client = context
    provider = MockColabProvider(fail_delete_times=1)
    calls = []

    def factory(job):
        calls.append(job)
        return provider

    clock = [1000.0]
    scheduler = Scheduler(repo, provider_factory=factory, executor_factory=lambda job: MockGPUExecutor(), clock=lambda: clock[0])
    job = repo.create_job("owner", {"provider": "mock", "execution_policy": {"provider": "mock"}, "estimated_units": 0}, "release-job")[0]
    for _ in range(6):
        scheduler.tick()
        job = repo.get("jobs", job["id"], "owner")
        if job["state"] == "preparing":
            break
    assert job["state"] == "preparing"
    instance_id = job["instance_id"]
    repo.update("jobs", job["id"], {"state": "failed"}, "owner")
    repo.update("instances", instance_id, {"state": "unknown"}, "owner")
    client.app.state.instance_service = scheduler.instances
    response = client.post(f"/api/gpu/instances/{instance_id}/stop", json={"confirmed": True},
                           headers={"Idempotency-Key": "release-unknown"})
    assert response.status_code == 202
    stopped = response.json()["data"]
    assert stopped["state"] == "releasing" and stopped["manual_stop_requested"]
    scheduler.watchdog()
    assert repo.get("instances", instance_id, "owner")["state"] != "deleted"
    assert calls[-1]["account_id"] == job["account_id"]
    clock[0] += 600
    scheduler.watchdog()
    assert repo.get("instances", instance_id, "owner")["state"] == "deleted"
    assert repo.get("leases", job["lease_id"], "owner")["state"] == "deleted"


def test_release_of_busy_instance_cancels_its_current_job(context):
    repo, _ = context
    scheduler = Scheduler(repo)
    job = repo.create_job("owner", {"provider": "mock", "estimated_units": 0}, "active-release")[0]
    instance = scheduler.instances.allocate(job)
    repo.update("jobs", job["id"], {"state": "running"}, "owner")
    stopped = scheduler.instances.stop("owner", instance["id"], "stop-busy")
    assert stopped["state"] == "releasing"
    current_job = repo.get("jobs", job["id"], "owner")
    assert current_job["cancel_requested"] is True
    assert current_job["state"] == "running"
    assert current_job["requested_outcome"] == "cancelled"


def test_release_refuses_a_stale_reference_to_a_job_on_another_instance(context):
    repo, _ = context
    scheduler = Scheduler(repo)
    job = repo.create_job("owner", {"provider": "mock", "estimated_units": 0}, "stale-release")[0]
    instance = scheduler.instances.allocate(job)
    repo.update("jobs", job["id"], {"state": "running", "instance_id": "another-instance"}, "owner")
    with pytest.raises(InstanceConflict):
        scheduler.instances.stop("owner", instance["id"], "stop-stale")
    assert not repo.get("jobs", job["id"], "owner").get("cancel_requested")
    assert repo.get("instances", instance["id"], "owner")["state"] == "allocating"
