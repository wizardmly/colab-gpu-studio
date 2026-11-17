"""Exact workflow GPU selection and machine-list fallback through allocation/cleanup."""

from types import SimpleNamespace

import httpx
import pytest
from app.db import Store
from app.gpu.colab import ColabAllocationError, GoogleColabProvider
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

    def __init__(self, unavailable_accels=()):
        self.unavailable = set(unavailable_accels)
        self.tried = []
        self.specs = SPECS

    def list_specs(self):
        return self.specs

    def create(self, spec, request_id, job_id, runtime_id):
        self.tried.append(spec["key"])
        if spec["key"]["accelerator"] in self.unavailable:
            raise ColabAllocationError(9, "NO_RUNTIMES")
        return {"runtime_name": f"runtimes/{runtime_id}", "ready": True,
                "runtime_id": runtime_id, "request_id": request_id}

    def inspect(self, handle):
        return {"ready": True, "deleted": True, "allocation_failed": True}

    def delete(self, handle):
        return True


def setup(provider=None, **patch):
    repo = Repository(Store("sqlite://"))
    provider = provider or FallbackProvider()
    cfg = GpuConfig(enabled=True, real_enabled=True, unit_rate=0.027, daily_units=100,
                    monthly_units=2200, max_job_units=15, max_runtime_minutes=60)
    job = repo.create("jobs", "owner", {
        "state": "allocating", "provider": "colab", "max_runtime_minutes": 10,
        "snapshot": {"manifest": {"compute_spec": SPECS[2]["key"]}}, **patch,
    })
    scheduler = Scheduler(repo, config=cfg, provider_factory=lambda j: provider,
                          executor_factory=lambda j: MockGPUExecutor())
    return repo, provider, job, scheduler


@pytest.mark.parametrize("selection", [None, "workflow"])
def test_workflow_default_requests_exact_config_even_with_legacy_a100_flag(monkeypatch, selection):
    monkeypatch.setenv("GPU_PREFER_A100_FALLBACK", "1")
    _, provider, job, scheduler = setup(execution_policy={} if selection is None else {"gpu_selection": selection})
    assert scheduler._allocation(job)["state"] == "preparing"
    assert provider.tried == [SPECS[2]["key"]]


def test_explicit_a100_capacity_failure_does_not_switch_config():
    _, provider, job, scheduler = setup(FallbackProvider({"A100"}), requested_spec=SPECS[0])
    result = scheduler._cleanup(scheduler._allocation(job))
    assert provider.tried == [SPECS[0]["key"]]
    assert result["state"] == "failed"
    assert result["error_code"] == "gpu_capacity_unavailable"


@pytest.mark.parametrize("snapshot", [{"manifest": {}}, {"manifest": {}, "workflow_smoke": True}])
@pytest.mark.parametrize("policy", [{}, {"gpu_selection": "auto"}])
def test_unspecified_tries_every_exact_config_once_in_provider_order(snapshot, policy):
    repo, provider, job, scheduler = setup(FallbackProvider({"A100", "L4", "T4"}),
                                         snapshot=snapshot, execution_policy=policy)
    provider.specs = [SPECS[3], SPECS[0], SPECS[0], SPECS[1], SPECS[4], SPECS[2]]
    expected = [SPECS[i]["key"] for i in (3, 0, 1, 4, 2)]
    for index, key in enumerate(expected):
        failed = scheduler._allocation(job)
        assert provider.tried[-1] == key
        result = scheduler._cleanup(failed)
        assert repo.get("leases", failed["lease_id"], "owner")["state"] == "deleted"
        if index < len(expected) - 1:
            assert result["state"] == "queued"
            assert len(result["attempt_history"]) == index + 1
            job = repo.update("jobs", job["id"], {"state": "allocating"}, "owner")
        else:
            assert result["state"] == "failed"
    assert provider.tried == expected


def test_auto_selection_overrides_workflow_default_and_skips_ineligible_cpu_and_duplicates():
    _, provider, job, scheduler = setup(execution_policy={"gpu_selection": "auto"})
    provider.specs = [
        {"key": {"variant": "VARIANT_CPU", "accelerator": "NONE", "shape": "SHAPE_STANDARD"}, "eligible": True},
        {**SPECS[0], "eligible": False}, SPECS[3], SPECS[3], SPECS[2],
    ]
    assert scheduler._allocation(job)["state"] == "preparing"
    assert provider.tried == [SPECS[3]["key"]]


@pytest.mark.parametrize("patch", [
    {"prep": True}, {"snapshot": {"prep": True}}, {"snapshot": {"system_smoke": True}},
    {"requested_instance_id": "pinned"}, {"execution_policy": {"gpu_selection": "auto", "allocation": "existing"}},
])
def test_fixed_runtime_requests_do_not_enter_gpu_fallback(patch):
    _, _, job, scheduler = setup(execution_policy={"gpu_selection": "auto"}, **{
        key: value for key, value in patch.items() if key != "execution_policy"
    })
    if "execution_policy" in patch:
        job["execution_policy"] = patch["execution_policy"]
    assert not scheduler._spec_fallback_enabled(job)


def test_fallback_waits_for_confirmed_cleanup_and_rejects_duplicate_or_cancelled_requeue():
    repo, provider, job, scheduler = setup(FallbackProvider({"A100"}), execution_policy={"gpu_selection": "auto"})
    failed = scheduler._allocation(job)
    provider.delete = lambda handle: False
    provider.inspect = lambda handle: {"ready": False, "deleted": False}
    pending = scheduler._cleanup(failed)
    assert pending["state"] == "cleanup_pending"
    assert provider.tried == [SPECS[0]["key"]]
    provider.delete = lambda handle: True
    provider.inspect = lambda handle: {"ready": False, "deleted": True}
    repo.update("leases", failed["lease_id"], {"cleanup_next_epoch": 0}, "owner")
    pending = repo.update("jobs", job["id"], {"cleanup_next_epoch": 0}, "owner")
    queued = scheduler._cleanup(pending)
    assert queued["state"] == "queued"
    assert repo.requeue_spec_fallback(job["id"], "owner", [], SPECS[3], "stale") is None
    repo.update("jobs", job["id"], {"state": "failed", "cancel_requested": True}, "owner")
    assert repo.requeue_spec_fallback(job["id"], "owner", [], SPECS[3], "cancelled") is None


def cli_provider(repo, handler):
    google = SimpleNamespace(access_token=lambda purpose: "private-access-token",
                             _credential=lambda purpose, **kwargs: {"client_id": "764086051850-test"})
    return GoogleColabProvider(repo, "owner", google=google,
                               client=httpx.Client(transport=httpx.MockTransport(handler)))


@pytest.mark.parametrize("status", [400, 412])
@pytest.mark.parametrize("selection,expected", [("auto", "queued"), ("workflow", "failed")])
def test_cli_refusal_finishes_cleanup_before_optional_fallback(status, selection, expected):
    repo, _, job, scheduler = setup(execution_policy={"gpu_selection": selection}, requested_spec=SPECS[0])
    calls = []

    def handler(request):
        calls.append((request.method, request.url.path))
        assert request.url.path == "/tun/m/assign"
        return httpx.Response(200, json={"token": "xsrf"}) if request.method == "GET" else httpx.Response(status)

    provider = cli_provider(repo, handler)
    provider.list_specs = lambda: SPECS
    scheduler._provider = lambda j: provider
    failed = scheduler._allocation(job)
    assert failed["error_code"] == "gpu_capacity_unavailable"
    assert repo.get("leases", failed["lease_id"], "owner")["operation_done"] is True
    result = scheduler._cleanup(failed)
    assert result["state"] == expected
    assert calls == [("GET", "/tun/m/assign"), ("POST", "/tun/m/assign")]
    assert "private-access-token" not in str(repo.list("events", "owner"))
    provider.client.close()


@pytest.mark.parametrize("status", [401, 403, 500, "timeout"])
def test_cli_auth_and_transport_errors_preserve_uncertain_allocation(status):
    repo, _, job, scheduler = setup(execution_policy={"gpu_selection": "auto"})

    def handler(request):
        if status == "timeout":
            raise httpx.ReadTimeout("private upstream details", request=request)
        return httpx.Response(status)

    provider = cli_provider(repo, handler)
    provider.list_specs = lambda: SPECS
    scheduler._provider = lambda j: provider
    result = scheduler._allocation(job)
    assert result["state"] == "allocating"
    lease = repo.get("leases", result["lease_id"], "owner")
    assert not lease.get("operation_done")
    assert not provider.delete(scheduler._intent_handle(result, lease))
    provider.client.close()


def test_cli_refusal_after_prior_unknown_create_keeps_lease_for_reconciliation():
    repo, _, job, scheduler = setup(execution_policy={"gpu_selection": "auto"})
    lease = scheduler._ensure_lease(job)
    repo.update("leases", lease["id"], {"create_attempts": 2}, "owner")
    provider = cli_provider(repo, lambda request: httpx.Response(412))
    with pytest.raises(ColabAllocationError):
        provider.create(SPECS[0], lease["request_id"], job["id"], lease["runtime_id"])
    current = repo.get("leases", lease["id"], "owner")
    assert not current.get("operation_done")
    assert not provider.delete(scheduler._intent_handle(job, current))
    provider.client.close()


def test_unknown_allocation_retry_keeps_original_config_when_machine_list_changes():
    repo, provider, job, scheduler = setup(execution_policy={"gpu_selection": "auto"})

    def unknown_create(spec, *args):
        provider.tried.append(spec["key"])
        raise RuntimeError("allocation response lost")

    def unavailable_inspect(handle):
        raise RuntimeError("reconciliation unavailable")

    provider.create = unknown_create
    provider.inspect = unavailable_inspect
    first = scheduler._allocation(job)
    assert first["state"] == "allocating"
    provider.specs = [SPECS[3], SPECS[0]]
    second = scheduler._allocation(repo.get("jobs", job["id"], "owner"))
    assert second["state"] == "allocating"
    assert provider.tried == [SPECS[0]["key"], SPECS[0]["key"]]
