import argparse
import functools
import json
import math
import os
import select
import socket
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

TARGETS = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'moon', 'halley']
INIT = 'window.__nativeWallNow = Date.now.bind(Date);'
OBSERVER = '''() => {
  const s = window.__DBG__?.solarSystem;
  if (!s || s.__frameObservationInstalled) return;
  s.__frameObservationInstalled = true;
  const original = s._advanceBodies;
  let id = 0;
  s._advanceBodies = function(...args) {
    const enterWall = window.__nativeWallNow();
    const enterPerf = performance.now();
    const renderFrameBefore = this.renderer.info.render.frame;
    const result = original.apply(this, args);
    const exitPerf = performance.now();
    const exitWall = window.__nativeWallNow();
    const locals = Object.fromEntries(Object.entries(this.ephemerisTargets).map(([k,v]) => [k, v.position.toArray()]));
    window.__boundFrameCall = {
      id: ++id, enterWall, exitWall, enterPerf, exitPerf, renderFrameBefore,
      sample: structuredClone(this.timeSample), simulationTime: this.simulationTime,
      anchorSim: this.realTimeClock.anchorSim, anchorPerf: this.realTimeClock.anchorPerf,
      dragging: this.orbitState.isDragging, status: structuredClone(this.ephemerisStatus), locals
    };
    return result;
  };
}'''
SNAPSHOT = '''() => ({
  visibility: document.visibilityState,
  rendererFrame: window.__DBG__.solarSystem.renderer.info.render.frame,
  secureContext: window.isSecureContext,
  wall: window.__nativeWallNow(), perf: performance.now(),
  call: structuredClone(window.__boundFrameCall),
  toolbarText: document.querySelector('.time-control-panel')?.innerText,
  scripts: [...document.scripts].map(s => s.src).filter(Boolean)
})'''


def physical_to_display(v):
    radius = math.hypot(*v)
    if not radius:
        return [0, 0, 0]
    r, d = [0, .39, 1, 5.2, 30.1], [0, 9, 19, 35, 62]
    if radius >= r[-1]:
        display_radius = d[-1] + 1.5 * (radius - r[-1])
    else:
        index = next(i for i in range(4) if radius <= r[i + 1])
        display_radius = d[index] + (radius - r[index]) / (r[index + 1] - r[index]) * (d[index + 1] - d[index])
    scale = display_radius / radius
    return [v[0] * scale, v[2] * scale, -v[1] * scale]


def validate_bound_frame(record, expected_rate=None):
    assert record['visibility'] == 'visible', 'SCI_NATIVE_VISIBLE_FRAME'
    call = record['call']
    assert record['rendererFrame'] > call['renderFrameBefore'], 'SCI_NATIVE_RENDER_FRAME'
    sample, status = call['sample'], call['status']
    if expected_rate is not None:
        assert sample['rate'] == expected_rate, 'SCI_NATIVE_DEFAULT_RATE'
    if sample['rate'] == 1:
        assert call['enterWall'] <= sample['utcMs'] <= call['exitWall'], 'SCI_NATIVE_REALTIME_CLOCK'
    else:
        low = call['anchorSim'] + (call['enterPerf'] - call['anchorPerf']) * sample['rate']
        high = call['anchorSim'] + (call['exitPerf'] - call['anchorPerf']) * sample['rate']
        assert low - math.ulp(low) <= sample['utcMs'] <= high + math.ulp(high), 'SCI_NATIVE_MONOTONIC_RATE'
    assert status['status'] == 'ready', 'SCI_NATIVE_READY'
    assert set(status['targets']) == set(TARGETS) and set(call['locals']) == set(TARGETS), 'SCI_NATIVE_TARGET_SET'
    assert sample['jdTdb'] == call['simulationTime'] == status['lastAppliedJd'] and sample['utcMs'] == status['lastAppliedUtcMs'], 'SCI_NATIVE_APPLIED_EPOCH'
    expected_earth = physical_to_display(status['targets']['earth']['lastPhysicalPosition'])
    for name in TARGETS:
        target = status['targets'][name]
        assert target['ok'] and target['lastJd'] == sample['jdTdb'], 'SCI_NATIVE_APPLIED_EPOCH'
        vector = target['lastPhysicalPosition']
        assert len(vector) == 3 and all(math.isfinite(v) for v in vector), 'SCI_NATIVE_PHYSICAL_VECTOR'
        if name == 'moon':
            expected = [expected_earth[0] + vector[0] * 1089.68, expected_earth[1] + vector[2] * 1089.68, expected_earth[2] - vector[1] * 1089.68]
        else:
            expected = physical_to_display(vector)
        actual = call['locals'][name]
        assert len(actual) == 3 and all(math.isfinite(v) for v in actual), 'SCI_NATIVE_DISPLAY_POSITION'
        # Float64 scene-coordinate arithmetic, not a pixel-quality threshold.
        assert math.dist(actual, expected) <= max(1e-9, 64 * math.ulp(max(1, *map(abs, expected)))), 'SCI_NATIVE_DISPLAY_POSITION'
    return True


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description='Frame-bound full-widget technical verification; user visual approval is separate.')
    parser.add_argument('--url')
    parser.add_argument('--allow-live-preview', action='store_true')
    parser.add_argument('--dist', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--negative-controls', action='store_true')
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    assert not (output / 'browser-results.json').exists(), 'Use a new output directory'
    assert not args.url or args.allow_live_preview, 'Explicit live-preview technical scope required'
    assert not (args.url and args.negative_controls), 'Never inject negative controls into a live target'
    records, servers = [], []
    browser = None
    chrome_process = None
    display_process = None
    previous_display = os.environ.get('DISPLAY')

    def record(step, value):
        records.append({'step': step, 'recordedUtcMs': time.time_ns() // 1000000, 'value': value})
        (output / 'browser-results.json').write_text(json.dumps(records, indent=2) + '\n')

    def serve(directory):
        server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(directory)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
        return f'http://solar-realtime.test:{server.server_port}/'

    try:
        # A real visible X11 tab is needed to observe an actual hidden-tab transition.
        read_fd, write_fd = os.pipe()
        display_process = subprocess.Popen(['Xvfb', '-displayfd', str(write_fd), '-screen', '0', '1280x1000x24', '-nolisten', 'tcp'], pass_fds=(write_fd,), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        os.close(write_fd)
        assert select.select([read_fd], [], [], 10)[0], 'Xvfb display readiness failed'
        display = os.read(read_fd, 100).decode().strip()
        os.close(read_fd)
        assert display.isdigit(), 'Invalid Xvfb allocated display'
        os.environ['DISPLAY'] = ':' + display
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright, tempfile.TemporaryDirectory(prefix='solar-native-controls-', dir=os.environ.get('TMPDIR')) as temporary:
            with socket.socket() as port_socket:
                port_socket.bind(('127.0.0.1', 0))
                cdp_port = port_socket.getsockname()[1]
            profile = Path(temporary) / 'browser-profile'
            chrome_process = subprocess.Popen([playwright.chromium.executable_path, '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--remote-debugging-port=' + str(cdp_port), '--user-data-dir=' + str(profile), '--host-resolver-rules=MAP solar-realtime.test 127.0.0.1', '--no-proxy-server', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + 10
            while True:
                try:
                    urllib.request.urlopen(f'http://127.0.0.1:{cdp_port}/json/version', timeout=1).close()
                    break
                except Exception:
                    assert time.monotonic() < deadline, 'Standalone Chromium CDP readiness failed'
                    time.sleep(.1)
            # Playwright's normal contexts force focus/visibility. The public
            # no_defaults CDP option leaves native default-context tabs real.
            browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{cdp_port}', no_defaults=True)
            native_context = browser.contexts[0]
            keeper = native_context.pages[0] if native_context.pages else native_context.new_page()
            record('browser-execution-binding', {'standalone_CDP': True, 'no_defaults': True, 'default_context': True, 'cdp_port': cdp_port})

            def new_context(url):
                parsed = urlparse(url)
                assert parsed.scheme == 'http'
                context = native_context
                context.unroute_all(behavior='wait')
                context.add_init_script(INIT)
                def local_only(route):
                    request = urlparse(route.request.url)
                    if request.hostname != parsed.hostname:
                        route.abort()
                    elif not args.url and request.path.startswith('/api/'):
                        route.fulfill(content_type='application/json', body=json.dumps({'success': True, 'servers': [], 'data': []}))
                    else:
                        route.continue_()
                context.route('**/*', local_only)
                return context

            def next_frame(page, after=0, expected_rate=None):
                page.bring_to_front()
                page.wait_for_function('window.__DBG__?.solarSystem && window.__DBG__.solarSystem.renderer', timeout=60000)
                page.evaluate(OBSERVER)
                page.wait_for_function('after => {const c=window.__boundFrameCall;const s=window.__DBG__.solarSystem;return document.visibilityState === "visible" && c?.id > after && c.status.status === "ready" && s.renderer.info.render.frame > c.renderFrameBefore;}', arg=after, timeout=60000)
                value = page.evaluate(SNAPSHOT)
                validate_bound_frame(value, expected_rate)
                return value

            url = args.url or serve(Path(args.dist).resolve())
            context = new_context(url)
            page = context.new_page()
            page.set_viewport_size({'width': 1280, 'height': 900})
            page.goto(url)
            initial = next_frame(page, expected_rate=1)
            assert initial['secureContext'] is False, 'Ordinary HTTP fallback must be exercised'
            record('current', initial)
            page.wait_for_timeout(1000)
            elapsed = next_frame(page, initial['call']['id'], 1)
            assert elapsed['call']['sample']['utcMs'] > initial['call']['sample']['utcMs'], 'SCI_NATIVE_REALTIME_ADVANCES'
            record('wall-clock-wait', elapsed)
            page.evaluate('localStorage.setItem("solar-rate","86400");sessionStorage.setItem("solar-epoch","2446078.5")')
            page.goto(url + '?epoch=2446078.5&rate=86400')
            refreshed = next_frame(page, expected_rate=1)
            record('polluted-url-storage-reload', refreshed)
            canvas = page.locator('#solar-system-container canvas').first
            box = canvas.bounding_box()
            page.mouse.move(box['x'] + box['width'] * .7, box['y'] + box['height'] * .7)
            page.mouse.down()
            page.mouse.move(box['x'] + box['width'] * .75, box['y'] + box['height'] * .65)
            dragged = next_frame(page, refreshed['call']['id'], 1)
            assert dragged['call']['dragging'] is True, 'SCI_NATIVE_DRAG_NOT_OBSERVED'
            record('held-drag', dragged)
            page.mouse.up()
            page.evaluate('window.__DBG__.solarSystem.pause()')
            page.wait_for_timeout(1200)
            page.evaluate('window.__DBG__.solarSystem.resume()')
            resumed = next_frame(page, dragged['call']['id'], 1)
            record('actual-render-resume', resumed)
            other = context.new_page()
            other.goto('about:blank')
            other.bring_to_front()
            record('background-switch-observation', {'primary': page.evaluate('document.visibilityState'), 'secondary': other.evaluate('document.visibilityState')})
            # A hidden tab stops rAF; interval polling must observe visibility.
            page.wait_for_function('document.visibilityState === "hidden"', polling=100, timeout=10000)
            record('actual-hidden-tab-observed', page.evaluate('document.visibilityState'))
            page.wait_for_timeout(1200)
            foreground = next_frame(page, resumed['call']['id'], 1)
            record('actual-background-return', foreground)
            other.close()
            for rate in [60, 3600, 86400, 1]:
                before_id = page.evaluate('window.__boundFrameCall.id')
                page.locator(f'.time-control-panel button[data-rate="{rate}"]').click()
                value = next_frame(page, before_id, rate)
                record(f'native-rate-{rate}', value)
            page.locator('.time-control-panel button[data-rate="60"]').click()
            page.locator('.time-control-panel button[data-action="return-realtime"]').focus()
            page.keyboard.press('Enter')
            now = next_frame(page, expected_rate=1)
            record('native-Now-Enter', now)
            assert page.evaluate('window.__DBG__.solarSystem.hitButtons.every(x=>!x.el.className.includes("time-control"))'), 'Time controls leaked into pickables'
            page.screenshot(path=str(output / 'current.png'))
            for attempt in range(2):
                page.evaluate('window.__DBG__.solarSystem.resetCamera()')
                button = page.get_by_role('button', name='地球（进入三维地球）', exact=True)
                button.focus()
                page.keyboard.press('Enter')
                page.locator('#globe-container').wait_for(state='visible', timeout=30000)
                page.keyboard.press('Escape')
                page.locator('#solar-system-container').wait_for(state='visible', timeout=30000)
                returned = next_frame(page, expected_rate=1)
                record(f'native-Earth-Cesium-Escape-{attempt + 1}', returned)
            page.get_by_role('button', name='月球（进入总览）', exact=True).focus()
            page.keyboard.press('Enter')
            page.wait_for_url('**/*overview=1*')
            record('native-Moon-overview', page.url)
            page.goto(url)
            next_frame(page, expected_rate=1)
            page.get_by_role('button', name='太阳（前往登录）', exact=True).focus()
            page.keyboard.press('Enter')
            page.wait_for_url('**/*login=1*')
            record('native-Sun-login', page.url)
            for old_page in list(context.pages):
                if old_page != keeper:
                    old_page.close()

            if not args.url:
                damaged = new_context(url)
                damage_count = [0]
                def damage(route):
                    # Route.fetch uses the Node-side resolver, not Chromium's
                    # --host-resolver-rules. Fetch the same local HTTP payload.
                    fetch_url = route.request.url.replace('://solar-realtime.test:', '://127.0.0.1:')
                    response = route.fetch(url=fetch_url)
                    payload = bytearray(response.body())
                    payload[0] ^= 1
                    assert math.isfinite(struct.unpack('<d', payload[:8])[0])
                    damage_count[0] += 1
                    route.fulfill(response=response, body=bytes(payload))
                damaged.route('**/de440-1900-2100/mercury/*.f64', damage)
                broken_page = damaged.new_page()
                broken_page.set_viewport_size({'width': 1280, 'height': 900})
                broken_page.goto(url)
                broken_page.bring_to_front()
                broken_page.wait_for_function('document.visibilityState === "visible"', polling=100)
                broken_page.wait_for_function('window.__DBG__?.solarSystem?.ephemerisStatus?.error?.includes("EPHEMERIS_INTEGRITY_MISMATCH")', polling=100, timeout=60000)
                assert damage_count[0] > 0, 'SCI_NATIVE_CORRUPTION_TRANSPORT_NOT_EXERCISED'
                record('ordinary-HTTP-corrupt-payload-rejected', {'intercepted_payload_count': damage_count[0], 'status': broken_page.evaluate('structuredClone(window.__DBG__.solarSystem.ephemerisStatus)')})
                broken_page.close()

            if args.negative_controls:
                for kind, code in [('fixed-clock', 'SCI_NATIVE_REALTIME_CLOCK'), ('default-acceleration', 'SCI_NATIVE_DEFAULT_RATE')]:
                    directory = Path(temporary) / kind
                    shutil.copytree(Path(args.dist).resolve(), directory)
                    html = (directory / 'index.html').read_text()
                    if kind == 'fixed-clock':
                        injection = 'window.__nativeWallNow=Date.now.bind(Date);Date.now=()=>Date.UTC(2000,0,1,12);window.__temporalNegativeApplied=true;'
                    else:
                        injection = 'window.__nativeWallNow=Date.now.bind(Date);let k=setInterval(()=>{let s=window.__DBG__?.solarSystem;if(s){s.realTimeClock.setRate(60);window.__temporalNegativeApplied=true;clearInterval(k);}},0);'
                    (directory / 'temporal-negative.js').write_text(injection)
                    (directory / 'index.html').write_text(html.replace('<head>', '<head><script src="/temporal-negative.js"></script>', 1))
                    mutant_url = serve(directory)
                    mutant_context = new_context(mutant_url)
                    # INIT ran first, and injection preserves that same native reference.
                    mutant_page = mutant_context.new_page()
                    mutant_page.set_viewport_size({'width': 1280, 'height': 900})
                    mutant_page.goto(mutant_url)
                    try:
                        next_frame(mutant_page, expected_rate=1)
                    except AssertionError as error:
                        assert code in str(error), f'{kind} failed for wrong boundary: {error}'
                        record('negative-' + kind, {'rejected_by': code})
                    else:
                        raise AssertionError('Temporal negative control survived: ' + kind)
                    mutant_page.close()
            record('result', {'status': 'TECHNICAL_PASS_VISUAL_PENDING_USER', 'executed_steps': len(records), 'url': url, 'frame_bound': True, 'negative_controls': args.negative_controls})
    except Exception as error:
        record('result', {'status': 'FAIL', 'type': type(error).__name__, 'message': str(error)})
        raise
    finally:
        if browser:
            try:
                browser.close()
            except Exception:
                pass
        for server in servers:
            server.shutdown()
        if chrome_process:
            chrome_process.terminate()
            try:
                chrome_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                chrome_process.kill()
                chrome_process.wait()
        if display_process:
            display_process.terminate()
            try:
                display_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                display_process.kill()
                display_process.wait()
        if previous_display is None:
            os.environ.pop('DISPLAY', None)
        else:
            os.environ['DISPLAY'] = previous_display


if __name__ == '__main__':
    main()
