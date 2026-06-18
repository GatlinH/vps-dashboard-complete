#!/usr/bin/env python3
import os, pathlib, subprocess, sys, re
root=pathlib.Path('/root/vps-dashboard-complete')
sec=pathlib.Path('/etc/vps-dashboard/secrets.env')
env=os.environ.copy()
for raw in sec.read_text(errors='ignore').splitlines():
    line=raw.strip()
    if not line or line.startswith('#') or '=' not in line: continue
    k,v=line.split('=',1)
    if re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', k): env[k]=v
os.chdir(root)
raise SystemExit(subprocess.call(['docker','compose']+sys.argv[1:], env=env))
