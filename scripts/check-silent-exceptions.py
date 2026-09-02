#!/usr/bin/env python3
import argparse, hashlib, json, os, re, shutil, subprocess, sys
from pathlib import Path
REPO_ROOT=Path(__file__).resolve().parents[1]; BACKEND=REPO_ROOT/'backend'; DEFAULT_BASELINE=REPO_ROOT/'.github/quality/silent-exception-baseline.json'
BUCKETS=('S110','S112','BLE001'); KNOWN={'E722','F821',*BUCKETS}; RUFF_VERSION='0.16.5'; STALE_THRESHOLD=10
CANARY='''def canary():\n    try:\n        raise Exception()\n    except:\n        pass\n    except Exception:\n        pass\n    try:\n        raise Exception()\n    except Exception:\n        continue\n    return undefined_name\n'''
def _config_digest(): return hashlib.sha256((BACKEND/'ruff.toml').read_text(encoding='utf-8').replace('\r\n','\n').encode()).hexdigest()
def validate_baseline(d):
    if not isinstance(d,dict) or d.get('version')!=4: raise ValueError('baseline must use version 4; v3 and earlier require migration')
    allowed={'version','ruff_config_sha256','ruff_version','buckets','increase_justification','previous_totals'}
    if set(d)-allowed: raise ValueError('unknown top-level baseline key')
    if not isinstance(d.get('ruff_config_sha256'),str) or d.get('ruff_version')!=RUFF_VERSION: raise ValueError('baseline ruff_config_sha256 and ruff_version are required')
    bs=d.get('buckets');
    if not isinstance(bs,dict) or set(bs)!=set(BUCKETS): raise ValueError('baseline buckets must be exactly S110, S112, BLE001')
    out={'version':4,'ruff_config_sha256':d['ruff_config_sha256'],'ruff_version':d['ruff_version'],'buckets':{}}
    for n in BUCKETS:
        b=bs[n]
        if not isinstance(b,dict) or not isinstance(b.get('total'),int) or isinstance(b['total'],bool) or b['total']<0 or not isinstance(b.get('files'),dict): raise ValueError(f'invalid baseline bucket {n}')
        if any(not isinstance(k,str) or not isinstance(v,int) or isinstance(v,bool) or v<1 for k,v in b['files'].items()) or b['total']!=sum(b['files'].values()): raise ValueError(f'baseline bucket {n} total must equal sum(files.values()) and files >= 1')
        out['buckets'][n]={'total':b['total'],'files':b['files']}
    return out
def _ruff_command():
    override=os.environ.get('SILENT_EXC_RUFF'); explicit=bool(override) and not any(os.environ.get(x) for x in ('CI','GITHUB_ACTIONS','GITLAB_CI','JENKINS_URL','BUILDKITE','TF_BUILD'))
    candidates=[Path(override)] if explicit else [BACKEND/'.venv/bin/ruff']+([Path(shutil.which('ruff'))] if shutil.which('ruff') else [])
    for exe in candidates:
        if exe.name.startswith('python'):
            if explicit: raise ValueError('SILENT_EXC_RUFF must point to ruff executable, not interpreter')
            continue
        try: p=subprocess.run([str(exe),'--version'],cwd=BACKEND,text=True,capture_output=True)
        except OSError as e:
            if explicit: raise ValueError(f'SILENT_EXC_RUFF={exe} is unusable: {e}')
            continue
        m=re.search(r'ruff\s+(\d+\.\d+\.\d+)',p.stdout)
        if p.returncode==0 and m and m.group(1)==RUFF_VERSION: print(f'resolved ruff: {exe.resolve()} {m.group(1)}'); return [str(exe)]
        if explicit: raise ValueError(f'SILENT_EXC_RUFF={exe} is unusable: version mismatch or invalid output')
    raise ValueError(f'ruff unavailable; install ruff=={RUFF_VERSION} from backend/requirements-dev.txt')
def _run(cmd,input=None): return subprocess.run(cmd,cwd=BACKEND,text=True,capture_output=True,input=input)
def canary(ruff):
    p=_run(ruff+['check','--output-format','json','--ignore-noqa','--no-respect-gitignore','--no-cache','--config',str((BACKEND/'ruff.toml').resolve()),'--stdin-filename','canary_probe.py','-'],CANARY)
    if p.returncode not in (0,1): raise ValueError(f'ruff canary failed: {p.stderr[:500]}')
    try: items=json.loads(p.stdout)
    except Exception as e: raise ValueError(f'canary invalid JSON: {e}')
    found={x.get('code') for x in items}; miss=sorted(KNOWN-found)
    if miss: raise ValueError('rule coverage lost: '+', '.join(miss))
def scan():
    if 'extend' in (BACKEND/'ruff.toml').read_text(encoding='utf-8').splitlines(): raise ValueError('backend/ruff.toml must not contain extend')
    req=(BACKEND/'requirements-dev.txt').read_text(encoding='utf-8')
    if f'ruff=={RUFF_VERSION}' not in req.splitlines(): raise ValueError('requirements-dev.txt must pin ruff=='+RUFF_VERSION)
    r=_ruff_command(); canary(r); p=_run(r+['check','--output-format','json','--ignore-noqa','--no-respect-gitignore','--no-cache','--config',str((BACKEND/'ruff.toml').resolve()),'.'])
    if p.returncode not in (0,1): raise ValueError(f'ruff failed with exit code {p.returncode}: {p.stderr[:500]}')
    try: items=json.loads(p.stdout)
    except Exception as e: raise ValueError(f'invalid ruff JSON: {e}; ruff stderr: {p.stderr[:500]}')
    c={b:{} for b in BUCKETS}; e7=0; f8=[]
    for i in items:
        code=i.get('code'); path=i.get('filename','')
        if code not in KNOWN: raise ValueError(f'unknown diagnostic {code} in {path}')
        if code=='E722': e7+=1
        elif code=='F821': f8.append(path)
        elif code in BUCKETS:
            rel=Path(path).resolve().relative_to(REPO_ROOT).as_posix(); c[code][rel]=c[code].get(rel,0)+1
    return {'buckets':{b:{'total':sum(v.values()),'files':v} for b,v in c.items()},'e722':e7,'f821':f8}
def main(argv=None):
    ap=argparse.ArgumentParser(allow_abbrev=False); ap.add_argument('--baseline',type=Path,default=DEFAULT_BASELINE); ap.add_argument('--update-baseline',action='store_true'); ap.add_argument('--yes',action='store_true'); ap.add_argument('--allow-increase'); a=ap.parse_args(argv)
    try: measured=scan(); old=validate_baseline(json.loads(a.baseline.read_text())) if a.baseline.exists() else None
    except (OSError,ValueError,json.JSONDecodeError) as e: print('ERROR: '+str(e),file=sys.stderr); return 2
    if measured['e722'] or measured['f821']: print('ERROR: zero tolerance violation',file=sys.stderr); return 1
    if a.update_baseline:
        if not a.yes or os.environ.get('SILENT_EXC_BASELINE_WRITE')!='1' or any(os.environ.get(x) for x in ('CI','GITHUB_ACTIONS','GITLAB_CI','JENKINS_URL','BUILDKITE','TF_BUILD')): print('ERROR: baseline update requires --yes, SILENT_EXC_BASELINE_WRITE=1, and is forbidden in CI',file=sys.stderr); return 2
        rises=[]
        if old:
            for b in BUCKETS:
                bf=old['buckets'][b]['files']; mf=measured['buckets'][b]['files']
                for f in sorted(set(bf)|set(mf)):
                    o=bf.get(f,0); n=mf.get(f,0)
                    if o!=n: print(f'{b} {f}: {o} -> {n}')
                    if n>o: rises.append(f'{b} {f}')
                print(f'{b} total: {old["buckets"][b]["total"]} -> {measured["buckets"][b]["total"]}')
        if rises and not (a.allow_increase and a.allow_increase.strip()): print('ERROR: increase detected; use --allow-increase "<reason>"',file=sys.stderr); return 2
        data={'version':4,'ruff_config_sha256':_config_digest(),'ruff_version':RUFF_VERSION,'buckets':measured['buckets']}
        if rises: data['increase_justification']=a.allow_increase; data['previous_totals']={b:old['buckets'][b]['total'] for b in BUCKETS}
        try: a.baseline.parent.mkdir(parents=True,exist_ok=True); a.baseline.write_text(json.dumps(data,indent=2)+'\n')
        except OSError as e: print('ERROR: '+str(e),file=sys.stderr); return 2
        return 3
    if old is None: print('ERROR: baseline file not found',file=sys.stderr); return 2
    errors=[]; digest=_config_digest()
    if digest!=old['ruff_config_sha256']: errors.append('ruff.toml changed')
    stale=sum(old['buckets'][b]['total'] for b in BUCKETS)-sum(measured['buckets'][b]['total'] for b in BUCKETS)
    if stale>STALE_THRESHOLD: errors.append(f'baseline is stale by {stale} findings; run --update-baseline --yes to record progress')
    for b in BUCKETS:
        bf=old['buckets'][b]['files']; mf=measured['buckets'][b]['files']
        for f in sorted(set(bf)|set(mf)):
            if f not in bf: errors.append(f'{b} {f}: new file requires explicit baseline update')
            elif mf.get(f,0)>bf[f]: errors.append(f'{b} {f}: count increased')
            elif mf.get(f,0)<bf[f]: print(f'progress: {b} {f} {bf[f]} -> {mf.get(f,0)}')
        if measured['buckets'][b]['total']<old['buckets'][b]['total']: print(f'progress: {b} total {old["buckets"][b]["total"]} -> {measured["buckets"][b]["total"]}')
    if errors: print('\n'.join('ERROR: '+e for e in errors),file=sys.stderr); return 1
    print('SILENT_EXC_GATE_OK'); return 0
if __name__=='__main__': raise SystemExit(main())
