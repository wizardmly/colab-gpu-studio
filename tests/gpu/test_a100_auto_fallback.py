"""Tests for smoke-only A100-first selection with NO_RUNTIMES fallback; normal jobs strictly use workflow compute_spec."""

from app.db import Store
from app.gpu.colab import ColabAllocationError
from app.gpu.compute import GpuConfig, MockGPUExecutor
from app.gpu.repository import Repository
from app.gpu.scheduler import Scheduler

SPECS = [
    {"key": {"variant": "VARIANT_GPU", "accelerator": "A100", "shape": "SHAPE_HIGHMEM"}, "eligible": True},
    {"key": {"variant": "VARIANT_GPU", "accelerator": "A100", "shape": "SHAPE_STANDARD"}, "eligible": True},
    {"key": {"variant": "VARIANT_GPU", "accelerator": "T4", "shape": "SHAPE_HIGHMEM"}, "eligible": True},
    {"key": {"variant": "VARIANT_GPU", "accelerator": "L4", "shape": "SHAPE_STANDARD"}, "eligible": True},
    {"key": {"variant": "VARIANT_GPU", "accelerator": "T4", "shape": "SHAPE_STANDARD"}, "eligible": True},
]


class FallbackProvider:
    is_mock = False

    def __init__(self, unavailable_accels: set[str]):
        self.unavailable = unavailable_accels
        self.tried: list[str] = []

    def list_specs(self):
        return SPECS

    def create(self, spec, request_id, job_id, runtime_id):
        accel = spec["key"]["accelerator"]
        self.tried.append(accel)
        if accel in self.unavailable:
            raise ColabAllocationError(9, "NO_RUNTIMES")
        return {
            "runtime_name": f"runtimes/{runtime_id}",
            "ready": True,
            "runtime_id": runtime_id,
            "request_id": request_id,
        }

    def inspect(self, handle):
        return {"ready": True, "deleted": True, "allocation_failed": True}

    def delete(self, handle):
        return {"deleted": True}


def _cfg():
    return GpuConfig(
        enabled=True,
        real_enabled=True,
        unit_rate=0.027,
        daily_units=100.0,
        monthly_units=2200.0,
        max_job_units=15.0,
        max_runtime_minutes=60,
    )


def test_smoke_activation_tries_a100_then_falls_back_to_workflow_t4_on_no_runtimes(monkeypatch):
    monkeypatch.setenv("GPU_PREFER_A100_FALLBACK", "1")
    repo = Repository(Store("sqlite://"))
    provider = FallbackProvider({"A100"})
    job = repo.create(
        "jobs",
        "owner",
        {
            "state": "allocating",
            "provider": "colab",
            "workflow_smoke": True,
            "requested_spec": SPECS[0],
            "max_runtime_minutes": 10,
            "snapshot": {
                "workflow_smoke": True,
                "manifest": {
                    "compute_spec": {"variant": "VARIANT_GPU", "accelerator": "T4", "shape": "SHAPE_HIGHMEM"}
                },
            },
        },
    )
    scheduler = Scheduler(repo, config=_cfg(), provider_factory=lambda j: provider, executor_factory=lambda j: MockGPUExecutor())

    step1 = scheduler._allocation(job)
    assert provider.tried == ["A100"]
    assert step1["state"] == "cleaning_up"
    assert step1["error_code"] == "gpu_capacity_unavailable"

    requeued = scheduler._cleanup(step1)
    assert requeued["state"] == "queued"
    assert requeued["requested_spec"]["key"] == {"variant": "VARIANT_GPU", "accelerator": "T4", "shape": "SHAPE_HIGHMEM"}

    allocating = repo.update("jobs", job["id"], {"state": "allocating"}, "owner")
    step2 = scheduler._allocation(allocating)
    assert provider.tried == ["A100", "T4"]
    assert step2["state"] == "preparing"


def test_normal_production_job_never_grabs_a100_and_strictly_uses_workflow_compute_spec(monkeypatch):
    monkeypatch.setenv("GPU_PREFER_A100_FALLBACK", "1")
    repo = Repository(Store("sqlite://"))
    provider = FallbackProvider(set())
    job = repo.create(
        "jobs",
        "owner",
        {
            "state": "allocating",
            "provider": "colab",
            "max_runtime_minutes": 10,
            "snapshot": {
                "manifest": {
                    "compute_spec": {"variant": "VARIANT_GPU", "accelerator": "L4", "shape": "SHAPE_STANDARD"}
                }
            },
        },
    )
    scheduler = Scheduler(repo, config=_cfg(), provider_factory=lambda j: provider, executor_factory=lambda j: MockGPUExecutor())

    step = scheduler._allocation(job)
    assert provider.tried == ["L4"]
    assert step["state"] == "preparing"


def test_video_l4_smoke_falls_back_from_a100_to_l4_and_never_t4(monkeypatch):
    monkeypatch.setenv("GPU_PREFER_A100_FALLBACK", "1")
    repo = Repository(Store("sqlite://"))
    provider = FallbackProvider({"A100", "L4"})
    job = repo.create(
        "jobs",
        "owner",
        {
            "state": "allocating",
            "provider": "colab",
            "workflow_smoke": True,
            "requested_spec": SPECS[0],
            "max_runtime_minutes": 10,
            "snapshot": {
                "workflow_smoke": True,
                "manifest": {
                    "compute_spec": {"variant": "VARIANT_GPU", "accelerator": "L4", "shape": "SHAPE_STANDARD"}
                },
            },
        },
    )
    scheduler = Scheduler(repo, config=_cfg(), provider_factory=lambda j: provider, executor_factory=lambda j: MockGPUExecutor())

    requeued = scheduler._cleanup(scheduler._allocation(job))
    assert requeued["state"] == "queued"
    assert requeued["requested_spec"]["key"]["accelerator"] == "L4"

    allocating = repo.update("jobs", job["id"], {"state": "allocating"}, "owner")
    terminal = scheduler._cleanup(scheduler._allocation(allocating))
    assert provider.tried == ["A100", "L4"]
    assert terminal["state"] == "failed"
    assert terminal["error_code"] == "gpu_capacity_unavailable"
