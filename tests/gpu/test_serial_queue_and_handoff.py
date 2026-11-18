"""Spec-aware serial queueing, automatic warm handoff (even under save), and parallel new-instance override."""
from __future__ import annotations

import pytest
from app.admission import _validate_allocation
from app.common import APIError
from app.db import Store
from app.gpu.compute import GpuConfig, MockColabProvider, MockGPUExecutor
from app.gpu.repository import Repository
from app.gpu.scheduler import Scheduler
from app.job_schemas import Policy, normalize_policy

OWNER = {"id": "owner-1", "role": "admin"}

L4_SPEC = {"key": {"variant": "VARIANT_GPU", "accelerator": "L4", "shape": "SHAPE_STANDARD"}, "eligible": True}
T4_STD_SPEC = {"key": {"variant": "VARIANT_GPU", "accelerator": "T4", "shape": "SHAPE_STANDARD"}, "eligible": True}
T4_HIGH_SPEC = {"key": {"variant": "VARIANT_GPU", "accelerator": "T4", "shape": "SHAPE_HIGHMEM"}, "eligible": True}
A100_SPEC = {"key": {"variant": "VARIANT_GPU", "accelerator": "A100", "shape": "SHAPE_STANDARD"}, "eligible": True}


class MultiSpecProvider(MockColabProvider):
    def __init__(self, specs=None, **kwargs):
        super().__init__(**kwargs)
        self.specs = list(specs or [L4_SPEC, T4_STD_SPEC, T4_HIGH_SPEC, A100_SPEC])
        self.created_specs = []

    def list_specs(self):
        return list(self.specs)

    def create(self, spec, request_id, job_id, runtime_id):
        self.created_specs.append(spec)
        return super().create(spec, request_id, job_id, runtime_id)


def _setup_account(repo: Repository, account_id: str = "acct-1", *, provider: str = "colab") -> dict:
    return repo.create(
        "accounts",
        OWNER["id"],
        {
            "account_id": account_id,
            "alias": account_id,
            "provider": provider,
            "connected": True,
            "enabled": True,
            "allow_allocation": True,
            "allowed_projects": ["project-1"],
            "budget": {"daily": 100.0, "monthly": 500.0},
        },
        record_id=account_id,
    )


def _create_colab_job(
    repo: Repository,
    key: str,
    *,
    accel: str = "L4",
    shape: str = "SHAPE_STANDARD",
    workflow_key: str = "minimax-h3-ref2v",
    lifecycle: str = "save",
    queue_mode: str = "queue",
    account_id: str = "acct-1",
    instance_id: str | None = None,
    max_runtime_minutes: int = 30,
) -> dict:
    spec_key = {"variant": "VARIANT_GPU", "accelerator": accel, "shape": shape}
    policy = {
        "provider": "colab",
        "lifecycle": lifecycle,
        "account_id": account_id,
        "queue_mode": queue_mode,
        "max_runtime_minutes": max_runtime_minutes,
        **({"allocation": "existing", "instance_id": instance_id} if instance_id else {"allocation": "auto"}),
    }
    snapshot = {"manifest": {"compute_spec": spec_key}}
    return repo.create_job(
        OWNER["id"],
        {
            "project_id": "project-1",
            "model_id": workflow_key,
            "workflow_key": workflow_key,
            "workflow_version": "1.0.0",
            "provider": "colab",
            "requested_account_id": account_id,
            **({"requested_instance_id": instance_id} if instance_id else {}),
            "max_runtime_minutes": max_runtime_minutes,
            "budget_units": max_runtime_minutes * 0.1,
            "estimated_units": 1.0,
            "snapshot": snapshot,
            "execution_policy": policy,
        },
        key,
        admitted={"snapshot": snapshot},
    )[0]


def _make_scheduler(repo: Repository, provider, executor, clock_box=None):
    clock = (lambda: clock_box[0]) if clock_box is not None else (lambda: 1000.0)
    cfg = GpuConfig(
        enabled=True,
        real_enabled=True,
        unit_rate=0.1,
        daily_units=100.0,
        monthly_units=500.0,
        max_job_units=50.0,
        max_runtime_minutes=120,
    )
    return Scheduler(
        repo,
        config=cfg,
        provider_factory=lambda _: provider,
        executor_factory=lambda _: executor,
        clock=clock,
    )


def test_policy_queue_mode_preserves_legacy_wire_contract_when_omitted():
    legacy = Policy()
    assert "queue_mode" not in legacy.model_dump()
    assert "queue_mode" not in normalize_policy(legacy)

    explicit = Policy(provider="colab", queue_mode="new_instance")
    dumped = explicit.model_dump()
    assert dumped["queue_mode"] == "new_instance"
    normalized = normalize_policy(explicit)
    assert normalized["queue_mode"] == "new_instance"
    assert normalized["allocation"] == "auto"


def test_admission_allows_busy_instance_for_queue_and_blocks_for_new_instance_or_deleted():
    repo = Repository(Store("sqlite:///:memory:"))
    _setup_account(repo, "acct-1", provider="colab")
    busy_inst = repo.create(
        "instances",
        OWNER["id"],
        {
            "account_id": "acct-1",
            "provider": "colab",
            "state": "busy",
            "current_job_id": "job-running",
        },
        record_id="11111111-1111-1111-1111-111111111111",
    )
    queued_policy = normalize_policy({"provider": "colab", "instance_id": busy_inst["id"], "queue_mode": "queue"})
    checked = _validate_allocation(repo, OWNER, queued_policy)
    assert checked["instance_id"] == busy_inst["id"]
    assert checked["account_id"] == "acct-1"

    new_inst_policy = normalize_policy({"provider": "colab", "instance_id": busy_inst["id"], "queue_mode": "new_instance"})
    with pytest.raises(APIError) as exc_info:
        _validate_allocation(repo, OWNER, new_inst_policy)
    assert exc_info.value.code == "INSTANCE_BUSY"

    dead_inst = repo.create(
        "instances",
        OWNER["id"],
        {"account_id": "acct-1", "provider": "colab", "state": "releasing"},
        record_id="22222222-2222-2222-2222-222222222222",
    )
    with pytest.raises(APIError) as dead_exc:
        _validate_allocation(repo, OWNER, normalize_policy({"provider": "colab", "instance_id": dead_inst["id"]}))
    assert dead_exc.value.code == "INSTANCE_UNAVAILABLE"


def test_same_spec_l4_queues_and_seamlessly_hands_off_even_under_save_lifecycle():
    repo = Repository(Store("sqlite:///:memory:"))
    _setup_account(repo, "acct-1", provider="colab")
    now = [1000.0]
    provider = MultiSpecProvider()
    executor = MockGPUExecutor(polls_before_complete=2)
    scheduler = _make_scheduler(repo, provider, executor, clock_box=now)

    job1 = _create_colab_job(repo, "l4-1", accel="L4", lifecycle="save", max_runtime_minutes=30)
    # Drive job1 until it is actively running on an L4 instance.
    for _ in range(12):
        scheduler.tick()
        if repo.get("jobs", job1["id"], OWNER["id"])["state"] == "running":
            break
    j1_running = repo.get("jobs", job1["id"], OWNER["id"])
    assert j1_running["state"] == "running"
    inst1_id = j1_running["instance_id"]
    lease1_id = j1_running["lease_id"]
    assert provider.create_calls == 1

    # Advance clock halfway through job1, then submit job2 (also L4 + save).
    now[0] = 2200.0
    job2 = _create_colab_job(repo, "l4-2", accel="L4", lifecycle="save", max_runtime_minutes=30)

    # Tick until job2 parks in waiting_for_capacity and job1 finishes.
    for _ in range(40):
        now[0] += 5.0
        scheduler.tick()
        j2 = repo.get("jobs", job2["id"], OWNER["id"])
        j1 = repo.get("jobs", job1["id"], OWNER["id"])
        if j1["state"] == "running" and j2["state"] == "waiting_for_capacity":
            assert j2.get("queue_state") == "waiting_capacity"
            assert j2.get("queue_gpu") == "L4"
            assert "L4" in (j2.get("queue_message") or "")
        if j1["state"] == "completed":
            break

    j1_done = repo.get("jobs", job1["id"], OWNER["id"])
    j2_handed = repo.get("jobs", job2["id"], OWNER["id"])
    assert j1_done["state"] == "completed"
    # Critical: even though lifecycle="save", warm VM was NOT deleted; it was handed directly to job2.
    assert j1_done.get("runtime_deleted") is False
    assert provider.delete_calls == 0
    assert provider.create_calls == 1
    assert j2_handed["instance_id"] == inst1_id
    assert j2_handed["lease_id"] == lease1_id
    # Extended deadline gives job2 its full 30m runtime instead of dying at job1's original deadline (1000+1800=2800).
    assert float(j2_handed["deadline_epoch"]) > 2800.0

    # Drive job2 to completion; once queue is empty, save lifecycle deletes the VM.
    for _ in range(40):
        now[0] += 5.0
        scheduler.tick()
        if repo.get("jobs", job2["id"], OWNER["id"])["state"] == "completed":
            break

    j2_done = repo.get("jobs", job2["id"], OWNER["id"])
    assert j2_done["state"] == "completed"
    assert provider.create_calls == 1
    assert provider.delete_calls == 1
    assert repo.get("instances", inst1_id, OWNER["id"])["state"] == "deleted"


def test_spec_aware_queue_l4_jumps_ahead_of_older_t4_then_t4_runs_after_l4_releases():
    repo = Repository(Store("sqlite:///:memory:"))
    _setup_account(repo, "acct-1", provider="colab")
    now = [1000.0]
    provider = MultiSpecProvider()
    executor = MockGPUExecutor(polls_before_complete=2)
    scheduler = _make_scheduler(repo, provider, executor, clock_box=now)

    # Start L4 job1 on the single Google account.
    job1_l4 = _create_colab_job(repo, "l4-1", accel="L4", lifecycle="save")
    for _ in range(12):
        scheduler.tick()
        if repo.get("jobs", job1_l4["id"], OWNER["id"])["state"] == "running":
            break
    assert repo.get("jobs", job1_l4["id"], OWNER["id"])["state"] == "running"
    assert len(provider.created_specs) == 1
    assert provider.created_specs[0]["key"]["accelerator"] == "L4"

    # Submit T4 job FIRST, then another L4 job SECOND while L4 job1 is running.
    now[0] = 1010.0
    job2_t4 = _create_colab_job(repo, "t4-1", accel="T4", workflow_key="moss-image-sft-t2i", lifecycle="save")
    now[0] = 1020.0
    job3_l4 = _create_colab_job(repo, "l4-2", accel="L4", lifecycle="save")

    # Advance ticks until job1_l4 completes: neither job2_t4 nor job3_l4 should open a 2nd VM prematurely.
    for _ in range(40):
        now[0] += 1.0
        scheduler.tick()
        j2_mid = repo.get("jobs", job2_t4["id"], OWNER["id"])
        j3_mid = repo.get("jobs", job3_l4["id"], OWNER["id"])
        if j2_mid["state"] == "waiting_for_capacity":
            assert j2_mid.get("queue_gpu") == "T4"
        if j3_mid["state"] == "waiting_for_capacity":
            assert j3_mid.get("queue_gpu") == "L4"
        if repo.get("jobs", job1_l4["id"], OWNER["id"])["state"] == "completed":
            break

    assert repo.get("jobs", job1_l4["id"], OWNER["id"])["state"] == "completed"
    # L4 warm machine must be handed to job3_l4 (matching L4 queue), even though job2_t4 is older.
    j3_after_handoff = repo.get("jobs", job3_l4["id"], OWNER["id"])
    j2_after_handoff = repo.get("jobs", job2_t4["id"], OWNER["id"])
    assert j3_after_handoff["instance_id"] == repo.get("jobs", job1_l4["id"], OWNER["id"])["instance_id"]
    assert j2_after_handoff.get("instance_id") is None
    assert len(provider.created_specs) == 1
    assert provider.delete_calls == 0

    # Now drive job3_l4 (never starved by older waiting job2_t4!) and then job2_t4 to completion.
    for _ in range(80):
        now[0] += 1.0
        scheduler.tick()
        if (
            repo.get("jobs", job3_l4["id"], OWNER["id"])["state"] == "completed"
            and repo.get("jobs", job2_t4["id"], OWNER["id"])["state"] == "completed"
        ):
            break

    j3_done = repo.get("jobs", job3_l4["id"], OWNER["id"])
    j2_done = repo.get("jobs", job2_t4["id"], OWNER["id"])
    assert j3_done["state"] == "completed"
    assert j2_done["state"] == "completed"
    assert j3_done["instance_id"] == repo.get("jobs", job1_l4["id"], OWNER["id"])["instance_id"]
    assert j2_done["instance_id"] != j3_done["instance_id"]
    assert [s["key"]["accelerator"] for s in provider.created_specs] == ["L4", "T4"]
    assert provider.delete_calls == 2


def test_t4_standard_does_not_handoff_to_t4_highmem_but_highmem_hands_off_to_standard():
    repo = Repository(Store("sqlite:///:memory:"))
    _setup_account(repo, "acct-1", provider="colab")
    now = [1000.0]
    provider = MultiSpecProvider()
    executor = MockGPUExecutor(polls_before_complete=1)
    scheduler = _make_scheduler(repo, provider, executor, clock_box=now)

    # T4 SHAPE_STANDARD must NOT hand off to T4 SHAPE_HIGHMEM (prevents OOM).
    j_std = _create_colab_job(repo, "t4-std", accel="T4", shape="SHAPE_STANDARD", workflow_key="moss-image-sft-t2i")
    for _ in range(12):
        scheduler.tick()
        if repo.get("jobs", j_std["id"], OWNER["id"])["state"] == "running":
            break
    now[0] += 10.0
    j_high = _create_colab_job(repo, "t4-high", accel="T4", shape="SHAPE_HIGHMEM", workflow_key="krea2-moss-dual-t2i")
    for _ in range(60):
        now[0] += 1.0
        scheduler.tick()
        if repo.get("jobs", j_high["id"], OWNER["id"])["state"] == "completed":
            break

    j_std_done = repo.get("jobs", j_std["id"], OWNER["id"])
    j_high_done = repo.get("jobs", j_high["id"], OWNER["id"])
    assert j_std_done["state"] == "completed" and j_high_done["state"] == "completed"
    assert j_std_done["instance_id"] != j_high_done["instance_id"]
    assert provider.delete_calls == 2
    assert len(provider.created_specs) == 2

    # Conversely, an active T4 SHAPE_HIGHMEM can safely hand off to a waiting T4 SHAPE_STANDARD.
    now[0] += 10.0
    j_high2 = _create_colab_job(repo, "t4-high-2", accel="T4", shape="SHAPE_HIGHMEM", workflow_key="krea2-moss-dual-t2i")
    for _ in range(12):
        scheduler.tick()
        if repo.get("jobs", j_high2["id"], OWNER["id"])["state"] == "running":
            break
    now[0] += 10.0
    j_std2 = _create_colab_job(repo, "t4-std-2", accel="T4", shape="SHAPE_STANDARD", workflow_key="moss-image-sft-t2i")
    for _ in range(60):
        now[0] += 1.0
        scheduler.tick()
        if repo.get("jobs", j_std2["id"], OWNER["id"])["state"] == "completed":
            break

    j_high2_done = repo.get("jobs", j_high2["id"], OWNER["id"])
    j_std2_done = repo.get("jobs", j_std2["id"], OWNER["id"])
    assert j_high2_done["instance_id"] == j_std2_done["instance_id"]
    assert len(provider.created_specs) == 3
    assert provider.delete_calls == 3


def test_new_instance_queue_mode_allocates_second_machine_in_parallel():
    repo = Repository(Store("sqlite:///:memory:"))
    _setup_account(repo, "acct-1", provider="colab")
    now = [1000.0]
    provider = MultiSpecProvider()
    executor = MockGPUExecutor(polls_before_complete=4)
    scheduler = _make_scheduler(repo, provider, executor, clock_box=now)

    job1 = _create_colab_job(repo, "l4-running", accel="L4", lifecycle="save", queue_mode="queue")
    for _ in range(12):
        scheduler.tick()
        if repo.get("jobs", job1["id"], OWNER["id"])["state"] == "running":
            break
    assert repo.get("jobs", job1["id"], OWNER["id"])["state"] == "running"

    now[0] = 1005.0
    job2 = _create_colab_job(repo, "l4-parallel", accel="L4", lifecycle="save", queue_mode="new_instance")
    for _ in range(12):
        scheduler.tick()
        j2_cur = repo.get("jobs", job2["id"], OWNER["id"])
        if j2_cur["state"] in {"preparing", "loading", "running"}:
            break

    j1_cur = repo.get("jobs", job1["id"], OWNER["id"])
    j2_cur = repo.get("jobs", job2["id"], OWNER["id"])
    assert j2_cur.get("instance_id") is not None
    assert j2_cur["instance_id"] != j1_cur["instance_id"]
    assert provider.create_calls == 2
    assert len(repo.list("instances", OWNER["id"])) == 2
