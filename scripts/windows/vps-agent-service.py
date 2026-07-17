"""Windows Service wrapper for the readonly metrics agent (requires pywin32)."""
import importlib.util
import os
import threading
from pathlib import Path

import servicemanager
import win32event
import win32service
import win32serviceutil

SERVICE_NAME = "VpsDashboardAgent"
SERVICE_DISPLAY_NAME = "VPS Dashboard Readonly Metrics Agent"
ROOT = Path(__file__).resolve().parents[2]
AGENT_DIR = Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "VpsDashboardAgent"


def load_agent_module():
    source = ROOT / "scripts" / "vps-agent.py"
    spec = importlib.util.spec_from_file_location("vps_dashboard_agent", source)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load agent module: {source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class VpsDashboardAgentService(win32serviceutil.ServiceFramework):
    _svc_name_ = SERVICE_NAME
    _svc_display_name_ = SERVICE_DISPLAY_NAME
    _svc_description_ = "Reports readonly Windows host metrics to VPS Dashboard."

    def __init__(self, args):
        super().__init__(args)
        self.stop_event = threading.Event()
        self.stop_handle = win32event.CreateEvent(None, 0, 0, None)

    def SvcStop(self):
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        self.stop_event.set()
        win32event.SetEvent(self.stop_handle)

    def SvcDoRun(self):
        try:
            env_path = AGENT_DIR / "agent.env"
            if not env_path.is_file():
                raise RuntimeError(f"Missing agent configuration: {env_path}")
            for line in env_path.read_text(encoding="utf-8").splitlines():
                if line and not line.lstrip().startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    os.environ[key.strip()] = value.strip()
            servicemanager.LogInfoMsg(f"{SERVICE_NAME} started")
            load_agent_module().run_forever(self.stop_event)
        except Exception as error:
            servicemanager.LogErrorMsg(f"{SERVICE_NAME} stopped unexpectedly: {error!r}")
            raise


if __name__ == "__main__":
    win32serviceutil.HandleCommandLine(VpsDashboardAgentService)
