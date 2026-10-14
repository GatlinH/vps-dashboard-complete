#!/usr/bin/env python3
"""Chromium C0/C2/C3 and related C9; 42 fresh pages, raw samples, no source edits.

Run after npm run build, outside a socket-restricted sandbox. Exit 0 means this
delivery subset passed; C4-C8/C10 remain NOT_MEASURED, so the full contract does
not pass. Exit 1 means measured failure; exit 2 means incomplete measurement.
"""
import argparse
import asyncio
import base64
import functools
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import traceback
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from threading import Thread

from solar_clip_contract import KEYS, STATES, check_matrix, check_record, verdict

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / 'frontend-dist'
PAYLOAD = Path(__file__).with_name('measure_solar_clip_contract.mjs')
READY = "window.__DBG__?.solarEphemeris?.status === 'ready' && ['earth','moon'].every(k => window.__DBG__.solarEphemeris.targets[k].ok)"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def hashes(paths):
    return {str(p.relative_to(ROOT)): digest(p.read_bytes()) for p in paths if p.is_file()}


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + '\n')


def save_record(directory, name, record):
    data = (json.dumps(record, separators=(',', ':'), ensure_ascii=False, allow_nan=False) + '\n').encode()
    path = directory / f'{name}.json.gz'
    path.write_bytes(gzip.compress(data, mtime=0))
    return {'file': path.name, 'sha256': digest(path.read_bytes()), 'rawJsonSha256': digest(data)}


def summarize(records):
    result = {}
    for name in ('C0', 'C1', 'C2', 'C3'):
        statuses = [r['assertions'][name]['status'] for r in records]
        result[name] = {'status': 'FAIL' if 'FAIL' in statuses else
                        ('PASS' if len(records) == 42 and all(s == 'PASS' for s in statuses) else 'NOT_MEASURED')}
    if records and check_matrix(records):
        result['C0'] = verdict(check_matrix(records))
    return result


async def run(args, report):
    import websockets
    from verify_solar_hit_targets import CDPDispatcher, Handler, navigate_and_wait, wait_devtools

    payload = re.sub(r'^export ', '', PAYLOAD.read_text(), flags=re.M)
    profile = tempfile.mkdtemp(prefix='solar-clip-contract-')
    httpd = process = None
    try:
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(DIST)))
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

            async def page(meta, mutation=None):
                request = urllib.request.Request(f'http://127.0.0.1:{port}/json/new?about%3Ablank', method='PUT')
                with urllib.request.urlopen(request, timeout=10) as response:
                    tab = json.loads(response.read())
                try:
                    async with websockets.connect(tab['webSocketDebuggerUrl'], max_size=None) as ws:
                        async with CDPDispatcher(ws, timeout=120, event_limit=100000) as cdp:
                            async def js(expression):
                                value = await cdp('Runtime.evaluate', {'expression': expression,
                                    'returnByValue': True, 'awaitPromise': True})
                                if 'exceptionDetails' in value:
                                    raise RuntimeError(json.dumps(value['exceptionDetails']))
                                return value.get('result', {}).get('value')

                            await cdp('Runtime.enable')
                            await cdp('Network.enable', {'maxTotalBufferSize': 100000000, 'maxResourceBufferSize': 20000000})
                            await cdp('Network.setCacheDisabled', {'cacheDisabled': True})
                            await cdp('Network.setBypassServiceWorker', {'bypass': True})
                            await cdp('Network.setBlockedURLs', {'urls': ['https://*']})
                            await cdp('Emulation.setDeviceMetricsOverride', {
                                'width': 320, 'height': 700, 'deviceScaleFactor': meta['dpr'], 'mobile': False})
                            await navigate_and_wait(cdp, origin + '/', ready_expression=READY, timeout=60)
                            initial_font = await js('parseFloat(getComputedStyle(document.documentElement).fontSize)')
                            await js(f"(() => {{ const s = window.__DBG__.solarSystem; s.pause(); document.documentElement.style.fontSize = '{initial_font * meta['fontScale']}px'; s.resize(); s.resetCamera(); return true; }})()")
                            if not await js('window.__DBG__.solarSystem.setSimulationTime(2446454.4312, {paused:true})'):
                                raise RuntimeError('Configuration A epoch unavailable')
                            # Drain already scheduled browser frames before taking the witness.
                            await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
                            await js('window.__DBG__.solarSystem.pause(); true')
                            await js(payload + '\ntrue')
                            prepared = await js('prepareSolarClipAudit()')
                            inputs = {'tabEvents': [], 'mouse': {'x': 300, 'y': 650}}
                            await cdp('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': 300, 'y': 650})
                            state = meta['state']
                            if state.startswith('focus-'):
                                target = state.removeprefix('focus-')
                                for _ in range(100):
                                    await cdp('Input.dispatchKeyEvent', {'type': 'keyDown', 'key': 'Tab', 'code': 'Tab', 'windowsVirtualKeyCode': 9})
                                    await cdp('Input.dispatchKeyEvent', {'type': 'keyUp', 'key': 'Tab', 'code': 'Tab', 'windowsVirtualKeyCode': 9})
                                    active = await js("(() => { const a=window.__solarClipAudit; return a.keys.find(k=>a.entries[k].el===document.activeElement) || document.activeElement?.tagName; })()")
                                    inputs['tabEvents'].append({'keyDown': 'Tab', 'keyUp': 'Tab', 'activeAfter': active})
                                    if active == target: break
                                else: raise RuntimeError(f'Tab never reached {target}')
                            elif state.startswith('hover-'):
                                p = prepared['centers'][state.removeprefix('hover-')]
                                inputs['mouse'] = {'x': p['x'], 'y': p['y']}
                                await cdp('Input.dispatchMouseEvent', {'type': 'mouseMoved', **inputs['mouse']})

                            # These are actual decoded HTTP response bodies seen by Chromium.
                            loaded = []
                            seen = set()
                            asset_dir = args.evidence / 'loaded-assets'
                            asset_dir.mkdir(exist_ok=True)
                            for _, event in list(cdp.event_messages):
                                if event['method'] != 'Network.responseReceived': continue
                                p = event['params']
                                if p['type'] not in ('Script', 'Stylesheet') or p['requestId'] in seen: continue
                                seen.add(p['requestId'])
                                response = await cdp('Network.getResponseBody', {'requestId': p['requestId']})
                                body = base64.b64decode(response['body']) if response.get('base64Encoded') else response['body'].encode()
                                sha = digest(body)
                                url = p['response']['url']
                                relative = urllib.parse.unquote(urllib.parse.urlparse(url).path).lstrip('/')
                                built = DIST / relative
                                extension = 'js' if p['type'] == 'Script' else 'css'
                                local = asset_dir / f'{sha}.{extension}'
                                local.write_bytes(body)
                                loaded.append({'url': url, 'type': p['type'], 'sha256': sha,
                                    'file': str(local.relative_to(args.evidence)),
                                    'matchesBuild': url.startswith(origin + '/') and built.is_file() and digest(built.read_bytes()) == sha,
                                    'builtFile': str(built.relative_to(ROOT))})

                            async def measure(label):
                                row = await js('measureSolarClipContract(' + json.dumps(meta) + ')')
                                row.update(initialRootFontSize=initial_font, loadedAssets=loaded, inputWitness=inputs)
                                file_info = save_record(args.evidence, label, row)
                                checked = check_record(row)
                                summary = {**meta, **file_info, 'assertions': checked, 'instance': row['witness']['instance']}
                                print(json.dumps({'file': file_info['file'], 'assertions': checked}, ensure_ascii=False), flush=True)
                                return summary

                            name = f"dpr{meta['dpr']:g}-font{meta['fontScale']:g}-{state}"
                            if mutation:
                                key, value = mutation
                                await js('window.__clipOriginalStyle = window.__solarClipAudit.entries[' + json.dumps(key) + '].el.getAttribute("style"); true')
                                await js('window.__solarClipAudit.entries[' + json.dumps(key) + '].el.style.setProperty("clip-path", ' + json.dumps(value) + ', "important"); true')
                                bad = await measure(f'mutation-{key}-{value.replace("(", "-").replace(")", "")}')
                                await js('window.__solarClipAudit.entries[' + json.dumps(key) + '].el.setAttribute("style", window.__clipOriginalStyle); true')
                                restored = await measure(f'restored-{key}-{value.replace("(", "-").replace(")", "")}')
                                kill = bad['assertions']['C3']['status'] == 'FAIL'
                                if key == 'earth' and value == 'none' and report['browser']['Browser'].startswith('Chrome/148.'):
                                    kill = kill and bad['assertions']['C2']['status'] == 'FAIL'
                                kill = kill and all(restored['assertions'][c]['status'] == 'PASS' for c in ('C0', 'C1', 'C2', 'C3'))
                                # Missing samples or wrong configuration cannot kill a mutation.
                                kill = kill and all(bad['assertions'][c]['status'] == 'PASS' for c in ('C0', 'C1'))
                                return {'key': key, 'clipPath': value, 'status': 'PASS' if kill else 'FAIL', 'mutated': bad, 'restored': restored}
                            return await measure(name)
                finally:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/close/{tab['id']}", timeout=10) as response:
                        response.read()

            for dpr in (1, 2, 3):
                for font in (1, 1.25):
                    for state in STATES:
                        report['records'].append(await page({'dpr': dpr, 'fontScale': font, 'state': state}))
                        report['assertions'].update(summarize(report['records']))
                        write_json(args.evidence / 'report.json', report)
            for key in KEYS:
                for value in ('none', 'circle(10px)'):
                    report['mutations'].append(await page({'dpr': 1, 'fontScale': 1, 'state': 'idle'}, (key, value)))
                    report['assertions']['C9'] = {'status': 'FAIL' if any(m['status'] == 'FAIL' for m in report['mutations']) else
                                                  ('PASS' if len(report['mutations']) == 6 else 'NOT_MEASURED')}
                    write_json(args.evidence / 'report.json', report)
    finally:
        if process is not None:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if httpd is not None:
            httpd.shutdown()
            httpd.server_close()
        shutil.rmtree(profile, ignore_errors=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', required=True, type=Path)
    parser.add_argument('--chromium', default='chromium')
    args = parser.parse_args(argv)
    if args.evidence.exists() and any(args.evidence.iterdir()):
        parser.error('--evidence must be new or empty')
    args.evidence.mkdir(parents=True, exist_ok=True)
    sources = sorted((ROOT / 'frontend-vite/src').rglob('*.js')) + sorted((ROOT / 'frontend-vite/src').rglob('*.css'))
    sources += [Path(__file__), PAYLOAD, Path(__file__).with_name('solar_clip_contract.py'),
                Path(__file__).with_name('diagnose_solar_native_hit.py'), Path(__file__).with_name('verify_solar_hit_targets.py'),
                Path(__file__).with_name('solar_hit_bands.py'), ROOT / 'frontend-vite/package.json',
                ROOT / 'frontend-vite/package-lock.json', ROOT / 'frontend-vite/vite.config.js']
    assets = [DIST / 'index.html'] + sorted((DIST / 'assets').glob('*.js')) + sorted((DIST / 'assets').glob('*.css'))
    report = {'status': 'NOT_MEASURED', 'fullContractStatus': 'NOT_MEASURED', 'records': [], 'mutations': [],
              'scope': 'C0/C1/C2/C3 and clip-related C9 only; C4-C8/C10 NOT_MEASURED',
              'source_sha256': hashes(sources), 'built_assets_sha256': hashes(assets),
              'assertions': {f'C{i}': {'status': 'NOT_MEASURED'} for i in range(11)}}
    try:
        if not (DIST / 'index.html').is_file(): raise FileNotFoundError('Run npm run build first')
        asyncio.run(run(args, report))
    except Exception as error:
        report['error'] = {'type': type(error).__name__, 'message': str(error), 'traceback': traceback.format_exc()}
        print(report['error']['traceback'], flush=True)
    report['assertions'].update(summarize(report['records']))
    report['sourceUnchanged'] = hashes(sources) == report['source_sha256']
    report['buildUnchanged'] = hashes(assets) == report['built_assets_sha256']
    if not report['sourceUnchanged'] or not report['buildUnchanged']:
        report['assertions']['C0'] = verdict(['C0_SOURCES_OR_BUILD_CHANGED'])
    if report['records'] and len({r['instance'] for r in report['records']}) != len(report['records']):
        report['assertions']['C0'] = verdict(['C0_PAGES_NOT_FRESH'])
    required = [report['assertions'][c]['status'] for c in ('C0', 'C1', 'C2', 'C3', 'C9')]
    status = 'FAIL' if 'FAIL' in required else ('PASS' if all(s == 'PASS' for s in required) and 'error' not in report else 'NOT_MEASURED')
    report['status'] = status
    report['fullContractStatus'] = 'FAIL' if status == 'FAIL' else 'NOT_MEASURED'
    report['exit_code'] = {'PASS': 0, 'FAIL': 1, 'NOT_MEASURED': 2}[status]
    write_json(args.evidence / 'report.json', report)
    print(json.dumps({'status': status, 'assertions': report['assertions'], 'exit_code': report['exit_code']}, ensure_ascii=False), flush=True)
    return report['exit_code']


if __name__ == '__main__':
    raise SystemExit(main())
