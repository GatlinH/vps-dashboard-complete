import importlib.util
import os
from pathlib import Path

os.environ.setdefault("API_ROOT", "http://127.0.0.1:5000")
os.environ.setdefault("AGENT_UUID", "test-agent")
os.environ.setdefault("AGENT_KEY", "test-key")
SPEC = importlib.util.spec_from_file_location("vps_agent", Path(__file__).parents[2] / "scripts" / "vps-agent.py")
agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent)


def _task(kind, params=None):
    return {"schema_version": 1, "id": 11, "kind": kind, "params": params or {}, "expires_at": "2099-01-01T00:00:00+00:00"}


def test_execute_tasks_runs_inventory_without_shell(monkeypatch):
    pushed = []
    monkeypatch.setattr(agent, "push_once", lambda: pushed.append(True))
    assert agent.execute_tasks([_task("collect_inventory")]) == [11]
    assert pushed == [True]


def test_execute_tasks_passes_only_declared_probe_keys(monkeypatch):
    received = []
    monkeypatch.setattr(agent, "probe_targets", lambda keys: received.append(keys))
    assert agent.execute_tasks([_task("run_peer_probe", {"target_keys": ["peer-a"]})]) == [11]
    assert received == [{"peer-a"}]


def test_icmp_probe_parses_standard_ping_latency(monkeypatch):
    class Result:
        returncode = 0
        stdout = '64 bytes from 198.51.100.9: icmp_seq=1 ttl=49 time=126 ms\n'
        stderr = ''
    monkeypatch.setattr(agent.subprocess, 'run', lambda *args, **kwargs: Result())
    assert agent.icmp_probe('198.51.100.9') == 126.0


def test_probe_targets_merges_external_and_peer_families(monkeypatch):
    calls, sent = [], []
    monkeypatch.setattr(agent, "SERVER_ID", "1")
    monkeypatch.setattr(agent, "_probe_target_family", lambda source: calls.append(source) or ([{"key": "us", "host": "198.51.100.9", "protocol": "icmp"}] if source == "external" else [{"key": "vps-2", "host": "2001:db8::2", "port": 443, "protocol": "tcp"}]))
    monkeypatch.setattr(agent, "probe_once", lambda host, port, protocol: 12.3)
    monkeypatch.setattr(agent, "_request", lambda path, body: sent.append((path, body)))
    agent.probe_targets()
    assert calls == ["external", "agent"]
    assert len(sent) == 1
    assert {row["key"] for row in __import__("json").loads(sent[0][1])["results"]} == {"us", "vps-2"}


def test_execute_tasks_skips_unsafe_task(monkeypatch):
    monkeypatch.setattr(agent, "push_once", lambda: (_ for _ in ()).throw(AssertionError("must not run")))
    unsafe = _task("exec", {"command": "whoami"})
    assert agent.execute_tasks([unsafe]) == []
