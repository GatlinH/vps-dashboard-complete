#!/usr/bin/env python3
"""Configuration A native hit forensics; never edits product sources.

--clip-contract runs the three-button C0/C2/C3/C9 acceptance matrix (42 fresh
pages). Without that flag the historical Earth-only forensics remain available.

Build first, then run with a new --evidence directory outside the socket sandbox.
Exit 2 = measurements unavailable/incomplete; exit 1 = reproduced native/model
mismatch; exit 0 = complete measurements without that mismatch (not acceptance).
"""
import argparse
import asyncio
import functools
import hashlib
import json
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import traceback
import urllib.request
from http.server import ThreadingHTTPServer
from threading import Thread

ROOT = Path(__file__).resolve().parents[2]
PAYLOAD = Path(__file__).with_name('measure_solar_native_hit.mjs')
JD = 2446454.4312
VARIANTS = ['baseline', 'border-outline', 'pseudo-pointer', 'padding-box-sizing',
            'transform-scale', 'appearance', 'circle-clip', 'legacy-percent',
            'grid-legacy-percent', 'grid-integer-residual', 'grid-no-transform']
READY = "window.__DBG__?.solarEphemeris?.status === 'ready' && window.__DBG__.solarEphemeris.targets.moon.ok"


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def summarize(rows):
    """Compare measured boundaries, not c (which cannot measure a hit shape)."""
    result = []
    for focus in [False, True]:
        group = {r['variant']: r for r in rows if r['focusRequested'] is focus}
        pairs = [('baseline', v) for v in VARIANTS if v != 'baseline']
        pairs += [('grid-legacy-percent', 'grid-integer-residual'),
                  ('grid-no-transform', 'grid-integer-residual')]
        for left, right in pairs:
            if left not in group or right not in group:
                result.append({'focus': focus, 'left': left, 'right': right, 'status': 'NOT_MEASURED'})
                continue
            a, b = group[left], group[right]
            same = all(a['centers']['earth'][k] == b['centers']['earth'][k]
                       for k in ['x', 'y', 'width', 'height'])
            # Compare every sampled membership, ignoring unrelated stack changes.
            def memberships(row):
                return [[run['first']['earthIncluded']
                         for run in ray['runs']
                         for _ in range(run['first']['index'], run['last']['index'] + 1)]
                        for ray in row['rays']]
            differing = sum(x != y for ar, br in zip(memberships(a), memberships(b)) for x, y in zip(ar, br))
            result.append({'focus': focus, 'left': left, 'right': right,
                'status': 'MEASURED_SAME_CENTER' if same else 'INCONCLUSIVE_CENTER_OR_SIZE_SHIFT',
                'sameEarthCenterAndSize': same, 'differingEarthMembershipSamples': differing,
                'leftCenter': a['centers']['earth'], 'rightCenter': b['centers']['earth'],
                'leftMoonOwner': a['moonProbe']['top'], 'rightMoonOwner': b['moonProbe']['top'],
                'interpretation': 'Only same-center comparisons isolate representation/shape at this sampling resolution.'})
    return result


async def run(args, report):
    import websockets
    from verify_solar_hit_targets import CDPDispatcher, Handler, navigate_and_wait, wait_devtools
    payload = re.sub(r'^export ', '', PAYLOAD.read_text(), flags=re.M)
    profile = tempfile.mkdtemp(prefix='solar-native-hit-')
    httpd = process = None
    try:
        httpd = ThreadingHTTPServer(('127.0.0.1', 0),
            functools.partial(Handler, directory=str(ROOT / 'frontend-dist')))
        Thread(target=httpd.serve_forever, daemon=True).start()
        origin = f'http://127.0.0.1:{httpd.server_address[1]}'
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        with (args.evidence / 'chromium.log').open('w') as log:
            process = subprocess.Popen([args.chromium, '--headless=new', '--no-sandbox',
                f'--remote-debugging-port={port}', f'--user-data-dir={profile}',
                '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                '--disable-dev-shm-usage', '--no-first-run', 'about:blank'], stdout=log, stderr=log)
            report['browser'] = wait_devtools(port)
            request = urllib.request.Request(f'http://127.0.0.1:{port}/json/new?about%3Ablank', method='PUT')
            with urllib.request.urlopen(request, timeout=10) as response:
                tab = json.loads(response.read())
            async with websockets.connect(tab['webSocketDebuggerUrl'], max_size=None) as ws:
                async with CDPDispatcher(ws, timeout=90, event_limit=20000) as cdp:
                    async def js(expression):
                        r = await cdp('Runtime.evaluate', {'expression': expression,
                            'returnByValue': True, 'awaitPromise': True})
                        if 'exceptionDetails' in r:
                            raise RuntimeError(json.dumps(r['exceptionDetails']))
                        return r.get('result', {}).get('value')
                    await cdp('Runtime.enable')
                    await cdp('Network.enable')
                    await cdp('Network.setCacheDisabled', {'cacheDisabled': True})
                    await cdp('Network.setBlockedURLs', {'urls': ['https://*']})
                    for group in report['groups']:
                        dpr, scale = group['dpr'], group['fontScale']
                        await cdp('Emulation.setDeviceMetricsOverride', {
                            'width': 320, 'height': 700, 'deviceScaleFactor': dpr, 'mobile': False})
                        await navigate_and_wait(cdp, origin + '/', ready_expression=READY, timeout=45)
                        await js('window.__DBG__.solarSystem.pause(); true')
                        await js("document.documentElement.style.fontSize="
                            f"(parseFloat(getComputedStyle(document.documentElement).fontSize)*{scale})+'px'; true")
                        await js('window.__DBG__.solarSystem.resize(); true')
                        if not await js(f'window.__DBG__.solarSystem.setSimulationTime({JD}, {{paused:true}})'):
                            raise RuntimeError('Configuration A precision epoch unavailable')
                        rows = []
                        for focus in [None, False, True]:
                            for variant in (['baseline'] if focus is None else VARIANTS):
                                options = json.dumps({'variant': variant, 'focus': focus})
                                row = await js('(() => {\n' + payload + '\nreturn measureSolarNativeHit(' + options + ');})()')
                                if not row or row.get('status') != 'MEASURED':
                                    raise RuntimeError('Browser returned no native measurement')
                                name = f'dpr{dpr:g}-font{scale:g}-{variant}-focus{focus}.json'
                                write_json(args.evidence / name, row)
                                rows.append(row)
                                group['files'].append(name)
                                report['measuredVariants'] += 1
                                if focus is None:
                                    group['questions'] = {
                                        'q1': {'status': 'MEASURED', 'moonProbe': row['moonProbe'], 'centers': row['centers']},
                                        'q2': {'status': 'MEASURED', 'distribution': row['distribution'],
                                               'fullStack': [row['registry'][key] for key in row['moonProbe']['stack']],
                                               'directionDetailsFile': name},
                                        'q3': {'status': 'NOT_MEASURED'}}
                                    group['baselineMismatch'] = not row['moonProbe']['modelMatchesNative']
                                write_json(args.evidence / 'report.json', report)
                                print(json.dumps({'file': name, 'moonProbe': row['moonProbe'],
                                    'distribution': row['distribution']}, ensure_ascii=False), flush=True)
                        group['questions']['q3'] = {'status': 'MEASURED_CONTROLS', 'comparisons': summarize(rows),
                            'historicalDeltaSameOrigin': 'UNDETERMINED',
                            'reason': 'Historical delta-external raw data is absent locally. Matching c alone cannot establish matching native hit boundaries.'}
                        group['status'] = 'MEASURED'
                        write_json(args.evidence / 'report.json', report)
    finally:
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if httpd is not None:
            httpd.shutdown()
            httpd.server_close()
        shutil.rmtree(profile, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', required=True, type=Path)
    parser.add_argument('--chromium', default='chromium')
    parser.add_argument('--dpr', type=float, nargs='+', default=[1, 2, 3])
    parser.add_argument('--font-scales', type=float, nargs='+', default=[1, 1.25])
    args = parser.parse_args()
    if any(v <= 0 for v in args.dpr + args.font_scales):
        parser.error('DPR and font scale must be positive')
    if args.evidence.exists() and any(args.evidence.iterdir()):
        parser.error('--evidence must be new or empty; existing evidence is never overwritten')
    args.evidence.mkdir(parents=True, exist_ok=True)
    sources = [Path(__file__), PAYLOAD,
        ROOT / 'frontend-vite/src/components/SolarSystem.js',
        ROOT / 'frontend-vite/src/components/solar/SolarHitDOM.js',
        ROOT / 'frontend-vite/src/components/solar/SolarHitLayout.js',
        ROOT / 'frontend-vite/src/styles/starfleet-theme.css',
        ROOT / 'frontend-vite/scripts/verify_solar_hit_targets.py',
        ROOT / 'frontend-vite/scripts/solar_hit_bands.py']
    assets = [ROOT / 'frontend-dist/index.html'] + sorted((ROOT / 'frontend-dist/assets').glob('*.js')) + sorted((ROOT / 'frontend-dist/assets').glob('*.css'))
    report = {'status': 'NOT_MEASURED', 'measurementComplete': False, 'measuredVariants': 0,
        'case': {'jd': JD, 'viewport': [320, 700], 'mobile': False},
        'source_sha256': {str(p.relative_to(ROOT)): sha256(p) for p in sources},
        'built_assets_sha256': {str(p.relative_to(ROOT)): sha256(p) for p in assets if p.is_file()},
        'historicalDeltaExternalAvailable': (ROOT / 'evidence/stage2-driver-delta-20261002/delta-external').exists(),
        'groups': [{'dpr': d, 'fontScale': s, 'status': 'NOT_MEASURED', 'files': [],
            'questions': {q: {'status': 'NOT_MEASURED'} for q in ['q1', 'q2', 'q3']}}
            for d in args.dpr for s in args.font_scales],
        'scope': 'Native Chromium Configuration A only. DOM style controls are transient and restored. No product edits, backend, threshold calibration, or other configurations.'}
    exit_code = 2
    try:
        if not assets[0].is_file():
            raise FileNotFoundError('Run npm run build in frontend-vite first')
        asyncio.run(run(args, report))
        report['measurementComplete'] = all(g['status'] == 'MEASURED' for g in report['groups'])
        mismatches = sum(g.get('baselineMismatch', False) for g in report['groups'])
        report['baselineMismatchGroups'] = mismatches
        report['status'] = 'MEASURED_WITH_MODEL_MISMATCH' if mismatches else 'MEASURED'
        exit_code = 1 if mismatches else 0
    except Exception as error:
        report['status'] = 'BLOCKED' if not report['measuredVariants'] else 'PARTIAL'
        report['error'] = {'type': type(error).__name__, 'message': str(error), 'traceback': traceback.format_exc()}
        print(report['error']['traceback'], flush=True)
    finally:
        report['exit_code'] = exit_code
        write_json(args.evidence / 'report.json', report)
    return exit_code


if __name__ == '__main__':
    import sys
    if '--clip-contract' in sys.argv:
        from verify_solar_clip_contract import main as clip_main
        raise SystemExit(clip_main([arg for arg in sys.argv[1:] if arg != '--clip-contract']))
    raise SystemExit(main())
