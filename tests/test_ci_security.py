import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SecurityScannerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scanner = load_module("security_scan", "scripts/security-scan.py")

    def scan(self, relative_path, content):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / relative_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
            return self.scanner.scan_file(path, root)

    def test_ci_agent_key_fixture_is_allowed(self):
        self.assertEqual([], self.scan(".github/workflows/ci.yml", "$env:AGENT_KEY = 'ci-agent-key'\n"))

    def test_token_like_secret_is_detected(self):
        problems = self.scan("config.py", "token = 'ghp_abcdefghijklmnopqrstuvwxyz123456'\n")
        self.assertEqual("raw_secret_assignment", problems[0][2])

    def test_arbitrary_workflow_secret_is_detected(self):
        problems = self.scan(".github/workflows/ci.yml", "password: 'actual-production-password'\n")
        self.assertEqual("raw_secret_assignment", problems[0][2])


class DependencyAuditPolicyTests(unittest.TestCase):
    def run_gate(self, audit, allowlist):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            audit_path = directory / "audit.json"
            policy_path = directory / "allowlist.json"
            audit_path.write_text(json.dumps(audit))
            policy_path.write_text(json.dumps(allowlist))
            return subprocess.run(
                ["python3", str(ROOT / "scripts/check-npm-audit.py"), "--audit-json", str(audit_path), "--allowlist", str(policy_path), "--today", "2026-08-20"],
                text=True,
                capture_output=True,
            )

    @staticmethod
    def audit(advisory="GHSA-test-0001", package="example", severity="high"):
        return {"vulnerabilities": {package: {"name": package, "severity": severity, "via": [{"source": 1, "name": package, "severity": severity, "url": f"https://github.com/advisories/{advisory}"}]}}}

    def test_non_allowlisted_advisory_fails(self):
        self.assertNotEqual(0, self.run_gate(self.audit(), {"entries": []}).returncode)

    def test_unexpired_allowlisted_advisory_passes(self):
        policy = {"entries": [{"package": "example", "advisory": "GHSA-test-0001", "rationale": "fixture", "expires": "2026-09-01"}]}
        self.assertEqual(0, self.run_gate(self.audit(), policy).returncode)

    def test_expired_allowlist_entry_fails(self):
        policy = {"entries": [{"package": "example", "advisory": "GHSA-test-0001", "rationale": "fixture", "expires": "2026-08-19"}]}
        self.assertNotEqual(0, self.run_gate(self.audit(), policy).returncode)

    def test_frontend_workflows_use_current_working_directory_as_audit_root(self):
        for workflow in ("ci.yml", "frontend-ci.yml"):
            source = (ROOT / ".github" / "workflows" / workflow).read_text()
            self.assertIn("check-npm-audit.py --root . --allowlist", source)


class ActionPinTests(unittest.TestCase):
    def test_tag_reference_fails_and_sha_reference_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflows = root / ".github/workflows"
            workflows.mkdir(parents=True)
            workflow = workflows / "ci.yml"
            workflow.write_text("steps:\n  - uses: actions/checkout@v7\n")
            command = ["python3", str(ROOT / "scripts/check-action-pins.py"), "--root", str(root)]
            self.assertNotEqual(0, subprocess.run(command).returncode)
            workflow.write_text("steps:\n  - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567 # v7\n")
            self.assertEqual(0, subprocess.run(command).returncode)


if __name__ == "__main__":
    unittest.main()
