import importlib.util
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("agent_tasks", Path(__file__).parents[2] / "scripts" / "agent_tasks.py")
agent_tasks = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent_tasks)


def test_accepts_only_versioned_allowlisted_task():
    assert agent_tasks.validate_task({"schema_version": 1, "id": 7, "kind": "collect_inventory", "params": {}, "expires_at": "2099-01-01T00:00:00+00:00"})["kind"] == "collect_inventory"


def test_rejects_unknown_kind_and_expired_task():
    assert agent_tasks.validate_task({"schema_version": 1, "id": 8, "kind": "exec", "params": {}, "expires_at": "2099-01-01T00:00:00+00:00"}) is None
    assert agent_tasks.validate_task({"schema_version": 1, "id": 9, "kind": "collect_inventory", "params": {}, "expires_at": "2000-01-01T00:00:00+00:00"}) is None


def test_rejects_probe_with_non_key_params():
    assert agent_tasks.validate_task({"schema_version": 1, "id": 10, "kind": "run_peer_probe", "params": {"host": "127.0.0.1;cmd"}, "expires_at": "2099-01-01T00:00:00+00:00"}) is None
