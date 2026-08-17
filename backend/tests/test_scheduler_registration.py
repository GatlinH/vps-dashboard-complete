"""Scheduler registration policy tests."""

from services.scheduler_registration import CRON_JOBS, INTERVAL_JOBS, register_scheduler_jobs


class _ConfigApp:
    config = {"SCHEDULER_TCP_PING_SECONDS": 7}


class _SchedulerSpy:
    def __init__(self):
        self.jobs = []

    def add_job(self, **kwargs):
        self.jobs.append(kwargs)


def _callback(_app):
    return None


def test_registration_has_unique_complete_job_ids():
    ids = [item[0] for item in INTERVAL_JOBS] + [item[0] for item in CRON_JOBS]
    assert len(ids) == 12
    assert len(ids) == len(set(ids))


def test_interval_can_be_overridden_without_changing_registration_code():
    scheduler = _SchedulerSpy()
    callbacks = {
        item[0]: _callback
        for item in (*INTERVAL_JOBS, *CRON_JOBS)
    }

    register_scheduler_jobs(scheduler, _ConfigApp(), callbacks)

    tcp_job = next(job for job in scheduler.jobs if job["id"] == "tcp_ping")
    assert int(tcp_job["trigger"].interval.total_seconds()) == 7
    assert tcp_job["misfire_grace_time"] == 10


def test_invalid_interval_falls_back_to_positive_default():
    class App:
        config = {"SCHEDULER_TCP_PING_SECONDS": 0}

    scheduler = _SchedulerSpy()
    callbacks = {
        item[0]: _callback
        for item in (*INTERVAL_JOBS, *CRON_JOBS)
    }

    register_scheduler_jobs(scheduler, App(), callbacks)

    tcp_job = next(job for job in scheduler.jobs if job["id"] == "tcp_ping")
    assert int(tcp_job["trigger"].interval.total_seconds()) == 1
