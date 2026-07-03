#!/usr/bin/env python3
from __future__ import annotations
import argparse, os, re, sys
from pathlib import Path

SECRET_ASSIGN_RE = re.compile(r"(?i)(api_key|secret|password|passwd|token|agent_key|bot_token)\s*[:=]\s*['\"]([^'\"]{6,})['\"]")
URL_SECRET_RE = re.compile(r"(?i)[?&](api_key|token|agent_key|bot_token|secret)=")
DANGEROUS_RE = re.compile(r"shell\s*=\s*True|os\.system\(|\beval\(|\bexec\(|pickle\.loads?\(")
ALLOW_KEY_RE = re.compile(r"(?i)(masked|has_|enabled|expires|created|updated|last_|csrf|token_type|password_login_enabled|password_min_length|password_policy|example|test|fixture)")
ALLOW_VALUE_RE = re.compile(r"(?i)^(test-|should-not-be-stored|example|placeholder|masked|changeme|your_|xxx|\*+)")
SKIP_DIRS = {'.git','node_modules','__pycache__','.pytest_cache','htmlcov','dist','build','.venv','venv'}
SUFFIXES = {'.py','.js','.jsx','.ts','.tsx','.html','.css','.sh','.yml','.yaml','.json'}

def iter_files(root: Path, include_dist: bool):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.endswith('.egg-info')]
        # Local backup/history trees are never release inputs; skip them even
        # during --include-dist to avoid validating stale pre-hardening code.
        dirnames[:] = [d for d in dirnames if d not in {'backups','_archive'}]
        if not include_dist:
            dirnames[:] = [d for d in dirnames if d not in {'frontend-dist'}]
        for name in filenames:
            p = Path(dirpath) / name
            if p.suffix in SUFFIXES:
                yield p

def allowed_secret(rel: Path, key: str, value: str, line: str) -> bool:
    ps = str(rel).replace('\\','/')
    if '/tests/' in ps or ps.startswith('tests/') or '/backups/' in ps or ps.startswith('backups/') or 'frontend-vite/backups/' in ps:
        return True
    # Shell/config templates often move an already-existing secret between local
    # variables (for example ${existing_agent_key}) without embedding the raw value.
    if value.startswith(('${', '$(')):
        return True
    # Minified frontend bundles may contain password-field UI templates or vendor
    # code that look like assignments. Keep bundle scanning focused on reusable
    # credentials and URL secret leaks, not labels/forms.
    if str(rel).replace('\\','/').startswith('frontend-dist/') and (
        key.lower() in {'password', 'passwd'} or 'submitPassword' in line or 'password' in line.lower()
    ):
        return True
    if ALLOW_KEY_RE.search(key) or ALLOW_VALUE_RE.search(value):
        return True
    if 'api_key_masked' in line or 'bot_token_masked' in line or 'has_token' in line:
        return True
    return False

def scan_file(path: Path, root: Path):
    problems=[]
    try: text=path.read_text(errors='ignore')
    except Exception as exc: return [(path,0,'read_error',str(exc))]
    rel=path.relative_to(root)
    for i,line in enumerate(text.splitlines(),1):
        for m in SECRET_ASSIGN_RE.finditer(line):
            key,value=m.group(1),m.group(2)
            if not allowed_secret(rel,key,value,line):
                problems.append((rel,i,'raw_secret_assignment',line.strip()[:220]))
        if URL_SECRET_RE.search(line) and 'URLSearchParams' not in line:
            problems.append((rel,i,'secret_in_url_pattern',line.strip()[:220]))
        if DANGEROUS_RE.search(line) and rel != Path('scripts/security-scan.py'):
            # Vendor/minified build outputs are scanned for leaked secrets, not
            # static code-shape patterns such as eval-like strings in Cesium.
            if not str(rel).replace('\\','/').startswith('frontend-dist/'):
                problems.append((rel,i,'dangerous_code_pattern',line.strip()[:220]))
    return problems

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--root', default='.')
    ap.add_argument('--include-dist', action='store_true')
    args=ap.parse_args()
    root=Path(args.root).resolve()
    problems=[]
    for p in iter_files(root,args.include_dist):
        problems.extend(scan_file(p,root))
    for rel,line,kind,detail in problems:
        print(f'{rel}:{line}: {kind}: {detail}')
    print(f'TOTAL_PROBLEMS {len(problems)}')
    return 1 if problems else 0
if __name__=='__main__':
    raise SystemExit(main())
