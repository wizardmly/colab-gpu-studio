
from app.db import Store
from app.gpu.mcp import MCPError, MCPGPUExecutor, MCPRateLimited, MCPTransient
from app.gpu.repository import Repository
from app.gpu.scheduler import Scheduler


def setup_job(error):
    repo=Repository(Store('sqlite://'))
    job=repo.create('jobs','owner',{'state':'running','execution_id':'original-execution'})
    repo.create('leases','owner',{'owner_job_id':job['id'],'state':'active','handle':{}})
    class Executor:
        calls=0
        def poll(self,*args):
            self.calls+=1
            raise error
    executor=Executor()
    clock=[100.0]
    scheduler=Scheduler(repo,executor_factory=lambda _:executor,clock=lambda:clock[0])
    return repo,job,scheduler,executor,clock


def test_transient_poll_is_durable_and_backed_off():
    repo,job,scheduler,executor,clock=setup_job(MCPTransient('offline interruption'))
    result=scheduler._run(job)
    assert result['state']=='running'
    assert result['execution_id']=='original-execution'
    assert result['poll_retry_count']==1 and result['poll_retry_at']>clock[0]
    # Recreate scheduler as on restart; durable deadline suppresses immediate I/O.
    restarted=Scheduler(repo,executor_factory=lambda _:executor,clock=lambda:clock[0])
    assert restarted._run(repo.get('jobs',job['id'],'owner'))['state']=='running'
    assert executor.calls==1


def test_poll_retries_have_finite_budget():
    repo,job,scheduler,executor,clock=setup_job(MCPTransient('offline interruption'))
    for _ in range(6):
        job=scheduler._run(job)
        clock[0]+=100
    assert job['state']=='cleaning_up'
    assert job['error_code']=='gpu_poll_failed'
    assert executor.calls==6


def test_integrity_failure_is_not_retried():
    _,job,scheduler,executor,_=setup_job(MCPError('artifact chunk identity mismatch'))
    result=scheduler._run(job)
    assert result['state']=='cleaning_up' and result['error_code']=='gpu_poll_failed'
    assert executor.calls==1



def test_new_attempt_drops_previous_poll_backoff_but_keeps_history():
    repo=Repository(Store('sqlite://'))
    job=repo.create('jobs','owner',{'state':'failed','provider':'mock',
        'poll_retry_count':5,'poll_retry_at':9999999999})
    retried=repo.retry_attempt(job['id'],'owner','new-attempt')
    assert 'poll_retry_at' not in retried and 'poll_retry_count' not in retried
    assert retried['attempt_history'][0]['poll_retry_count']==5


def test_429_cooldown_survives_restart_and_applies_to_the_same_account():
    repo = Repository(Store("sqlite://"))
    clock = [100.0]
    calls = []
    outcomes = [MCPRateLimited("HTTP 429", {"retry-after": "120"}), None, None, MCPRateLimited("HTTP 429")]

    class Executor(MCPGPUExecutor):
        def __init__(self):
            pass

        def poll(self, handle, job):
            calls.append(job["id"])
            outcome = outcomes.pop(0)
            if outcome:
                raise outcome
            return {"state": "running", "execution_id": job["execution_id"]}

    def running_job(account, owner="owner"):
        job = repo.create("jobs", owner, {"state": "running", "provider": "colab", "execution_id": "execution",
                                         "account_id": account, "deadline_epoch": 1000})
        repo.create("leases", owner, {"owner_job_id": job["id"], "state": "active", "handle": {}})
        return job

    def scheduler():
        return Scheduler(repo, executor_factory=lambda _: Executor(), clock=lambda: clock[0])

    first = running_job("account-a")
    same = running_job("account-a")
    other = running_job("account-b")
    limited = scheduler()._run(first)
    assert limited["state"] == "running" and limited["poll_retry_at"] == 220
    assert limited["execution_id"] == first["execution_id"]
    repo.extend_mcp_cooldown("owner", "account-a", 160)
    assert repo.mcp_cooldown_until("owner", "account-a") == 220
    assert repo.mcp_cooldown_until("different-owner", "account-a") == 0

    restarted = scheduler()
    assert restarted._run(limited) == limited
    assert restarted._run(same)["poll_retry_at"] == 220
    assert restarted._run(other)["poll_next_at"] == 110
    assert calls == [first["id"], other["id"]]

    clock[0] = 220
    recovered = restarted._run(limited)
    assert not recovered["mcp_rate_limited"] and recovered["poll_next_at"] == 245
    assert restarted._run(recovered) == recovered
    clock[0] = 245
    next_limit = restarted._run(recovered)
    assert next_limit["poll_retry_at"] == 295
    assert calls == [first["id"], other["id"], first["id"], first["id"]]


def test_cooldown_does_not_block_other_jobs_or_cancellation():
    repo, job, scheduler, _, _ = setup_job(MCPRateLimited("HTTP 429"))
    limited = scheduler._run(job)
    queued = repo.create("jobs", "owner", {"state": "queued"})
    assert scheduler.tick()["job_id"] == queued["id"]
    assert repo.get("jobs", queued["id"], "owner")["state"] == "validating"
    assert limited["state"] == "running"
    scheduler.cancel("owner", job["id"])
    assert scheduler.tick()["job_id"] == job["id"]
    assert repo.get("jobs", job["id"], "owner")["state"] != "running"


def test_start_retries_after_429_with_the_same_execution_id():
    repo = Repository(Store("sqlite://"))
    clock = [100.0]
    execution_ids = []
    job = repo.create("jobs", "owner", {"state": "loading", "provider": "colab", "account_id": "account-a",
                                      "deadline_epoch": 1000})
    lease = repo.create("leases", "owner", {"owner_job_id": job["id"], "state": "active", "handle": {}})
    job = repo.update("jobs", job["id"], {"lease_id": lease["id"]}, "owner")

    class Executor:
        def start(self, handle, job, execution_id):
            execution_ids.append(execution_id)
            if len(execution_ids) == 1:
                raise MCPRateLimited("HTTP 429")
            return {"execution_id": execution_id}

    scheduler = Scheduler(repo, executor_factory=lambda _: Executor(), clock=lambda: clock[0])
    assert scheduler.tick()["state"] == "loading"
    waiting = repo.get("jobs", job["id"], "owner")
    assert waiting["poll_retry_at"] == 130
    assert scheduler.tick()["advanced"] is False
    assert len(execution_ids) == 1
    clock[0] = 130
    assert scheduler.tick()["state"] == "running"
    assert execution_ids == [waiting["execution_id"]] * 2
    assert len(repo.list("executions", "owner")) == 1


def test_job_deadline_still_triggers_cleanup_during_a_long_retry_after():
    repo, job, scheduler, executor, clock = setup_job(MCPRateLimited("HTTP 429", {"retry-after": "120"}))
    job = repo.update("jobs", job["id"], {"deadline_epoch": 110}, "owner")
    scheduler._run(job)
    clock[0] = 111
    assert scheduler.tick()["state"] == "cleaning_up"
    assert repo.get("jobs", job["id"], "owner")["error_code"] == "gpu_timeout"
    assert executor.calls == 1
