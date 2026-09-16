#!/usr/bin/env python3
"""
Verify solar-system behavior in a real Chromium via CDP over the legacy asyncio
websockets client (works with websockets 10.4 and 15.x alike).

Checks:
  A - revolution actually moves world positions
  B - Earth -> Cesium -> Escape round trip (run twice to catch {once: true})
  C - Sun click calls openFrontLogin exactly once and never navigates
  D - Cesium absent on first paint
  E - Cesium chunk requested after Earth click
"""

import asyncio
import functools
import json
import math
import os
import shutil
import socket
import signal
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import websockets

REPO_ROOT = Path(__file__).resolve().parents[2]
DIST = REPO_ROOT / "frontend-dist"

WS = None
MSG_ID = 0
NET_URLS = []
CDP_PENDING = {}
CDP_EVENTS = asyncio.Queue()
CDP_READER = None
PAGE_URL = None


# ----------------------------------------------------------------------------
# CDP transport
# ----------------------------------------------------------------------------
async def cdp(method, timeout=25, **params):
    """Send a CDP command and wait for the matching response id."""
    global MSG_ID
    MSG_ID += 1
    mid = MSG_ID
    fut = asyncio.get_running_loop().create_future(); CDP_PENDING[mid] = fut
    await WS.send(json.dumps({"id": mid, "method": method, "params": params}))
    try:
        msg = await asyncio.wait_for(fut, timeout=timeout)
    finally:
        CDP_PENDING.pop(mid, None)
    if "error" in msg: raise RuntimeError("CDP error for %s: %s" % (method, msg["error"]))
    return msg.get("result", {})

async def cdp_reader():
    async for raw in WS:
        msg = json.loads(raw)
        if msg.get("method") == "Network.requestWillBeSent":
            try: NET_URLS.append(msg["params"]["request"]["url"])
            except KeyError: pass
        if msg.get("id") in CDP_PENDING:
            CDP_PENDING[msg["id"]].set_result(msg)
        else:
            await CDP_EVENTS.put(msg)


async def drain(seconds):
    """Idle for `seconds` while collecting Network.requestWillBeSent URLs."""
    end = time.time() + seconds
    while True:
        remaining = end - time.time()
        if remaining <= 0:
            return
        try:
            raw = await asyncio.wait_for(CDP_EVENTS.get(), timeout=remaining)
        except asyncio.TimeoutError:
            return


async def js(expr):
    res = await cdp(
        "Runtime.evaluate",
        expression=expr,
        returnByValue=True,
        awaitPromise=True,
        userGesture=True,
    )
    if "exceptionDetails" in res:
        raise RuntimeError("JS exception: %s" % json.dumps(res["exceptionDetails"])[:400])
    return res.get("result", {}).get("value")


def visible_expr(sel):
    """JS expression string for 'is this selector visible' — usable inside wait_for()."""
    return (
        "(() => {"
        "  const el = document.querySelector(%s);"
        "  if (!el) return false;"
        "  const r = el.getBoundingClientRect();"
        "  const s = getComputedStyle(el);"
        "  return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';"
        "})()" % json.dumps(sel)
    )


async def visible(sel):
    return await js(
        """
        (() => {
          const el = document.querySelector(%s);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        })()
        """
        % json.dumps(sel)
    )


async def wait_for(expr, what, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if await js(expr):
                return True
        except RuntimeError:
            pass
        await asyncio.sleep(0.15)
    print("       (timed out waiting for %s)" % what)
    return False


async def click_hit(label, idx, what):
    """Click a button.solar-system-hit by Chinese aria-label, positional fallback."""
    ok = await js(
        """
        (() => {
          const hits = Array.from(document.querySelectorAll('button.solar-system-hit'));
          if (!hits.length) return false;
          let el = hits.find(h => (h.getAttribute('aria-label') || '').includes(%s));
          if (!el) el = hits[%d];
          if (!el) return false;
          el.click();
          return true;
        })()
        """
        % (json.dumps(label), idx)
    )
    if not ok:
        print("       (could not find hit target for %s)" % what)
    return ok


async def press_escape():
    await cdp(
        "Input.dispatchKeyEvent",
        type="keyDown",
        key="Escape",
        code="Escape",
        windowsVirtualKeyCode=27,
        nativeVirtualKeyCode=27,
    )
    await cdp(
        "Input.dispatchKeyEvent",
        type="keyUp",
        key="Escape",
        code="Escape",
        windowsVirtualKeyCode=27,
        nativeVirtualKeyCode=27,
    )


# ----------------------------------------------------------------------------
# Checks
# ----------------------------------------------------------------------------
async def check_a():
    """A - revolution must move world positions.

    Polls instead of sampling once. Headless Chromium has no compositor driving frames,
    so a single fixed sleep can straddle a stalled requestAnimationFrame interval and
    report a 0.0000 delta for perfectly correct code. The instance stores the id returned
    by requestAnimationFrame in window.__DBG__.solarSystem.frameId and reassigns it every
    tick, so a changing frameId proves the loop is running. That separates the two
    zero-delta cases: a stalled loop is an environment failure (FATAL), while a loop that
    advanced with nothing moving is the real defect this assertion exists to catch (FAIL).
    The 0.05 threshold stays as is and axial rotation is deliberately not accepted as
    evidence - a `rotation.y += k` substitution must still fail here.
    """
    snap = """
    (() => {
      const w = window.__DBG__ && window.__DBG__.solarSystem;
      if (!w || typeof w.getBodySnapshot !== 'function') return null;
      return w.getBodySnapshot();
    })()
    """

    def by_name(snapshot):
        # getBodySnapshot() returns a LIST of {name, x, y, z}, not a name->coords mapping.
        out = {}
        for item in snapshot or []:
            if isinstance(item, dict) and "name" in item:
                out[item["name"]] = (item.get("x"), item.get("y"), item.get("z"))
        return out

    if not await wait_for(
        "!!(window.__DBG__ && window.__DBG__.solarSystem && window.__DBG__.solarSystem.getBodySnapshot)",
        "__DBG__.solarSystem.getBodySnapshot",
        timeout=15.0,
    ):
        print("FAIL: A - revolution debug hook never appeared")
        return False

    base = await js(snap)
    base_by = by_name(base)
    if not base_by:
        print("FAIL: A - snapshot contained no named bodies: %r" % (base,))
        return False

    frame_expr = "window.__DBG__.solarSystem.frameId"
    frame0 = await js(frame_expr)
    seen_frames = {frame0}

    started = time.monotonic()
    deadline = started + 6.0
    max_delta = 0.0
    worst = "?"
    counted = 0

    while True:
        # drain() rather than asyncio.sleep(): keeps consuming Network.requestWillBeSent
        # while waiting, otherwise those events queue up unread and assertion D loses them.
        await drain(0.25)

        cur_by = by_name(await js(snap))
        seen_frames.add(await js(frame_expr))

        max_delta = 0.0
        worst = "?"
        counted = 0
        for name, a in base_by.items():
            b = cur_by.get(name)
            if b is None:
                continue
            counted += 1
            try:
                d = max(abs(float(a[i]) - float(b[i])) for i in range(3))
            except (TypeError, ValueError, IndexError):
                continue
            if d > max_delta:
                max_delta, worst = d, name

        elapsed = time.monotonic() - started
        if max_delta > 0.05:
            print("PASS: A - revolution moves world positions "
                  "(max delta %.4f on %s, %d bodies, after %.2fs)"
                  % (max_delta, worst, counted, elapsed))
            return True

        if time.monotonic() >= deadline:
            break

    advances = len(seen_frames) - 1
    if advances == 0:
        print("FATAL: A - the animation loop never advanced (frameId stayed %r) - the browser is "
              "not scheduling requestAnimationFrame; the assertion cannot judge revolution."
              % (frame0,))
        return False

    print("FAIL: A - world positions static (max delta %.4f over %d bodies) while the animation "
          "loop advanced %d times; bodies are spinning in place rather than revolving."
          % (max_delta, counted, advances))
    return False


async def check_b():
    """Earth -> Cesium -> Escape round trip, twice, to catch {once: true}."""
    # Escape hides #globe-container and re-shows #solar-system-container; the Cesium
    # instance is deliberately kept alive (initGlobe no longer destroys `globe`), so
    # .cesium-viewer stays in the DOM after the first round. Assert on container
    # visibility, which is what the handler actually toggles.
    all_ok = True
    for attempt in (1, 2):
        if not await click_hit("地球", 1, "Earth (round %d)" % attempt):
            print("FAIL: B - Earth hit target missing on round %d" % attempt)
            return False
        if not await wait_for(
            visible_expr("#globe-container"),
            "#globe-container to become visible (round %d)" % attempt,
            timeout=20.0,
        ):
            print("FAIL: B - the Cesium container never became visible on round %d" % attempt)
            return False
        if await js(visible_expr("#solar-system-container")):
            print("FAIL: B - the solar system stayed visible behind Cesium on round %d" % attempt)
            return False
        await asyncio.sleep(0.4)
        await press_escape()
        if not await wait_for(
            "!(%s)" % visible_expr("#globe-container"),
            "#globe-container to hide after Escape (round %d)" % attempt,
            timeout=15.0,
        ):
            print("FAIL: B - Escape did not close Cesium on round %d "
                  "(a {once: true} listener only fires once)" % attempt)
            return False
        if not await wait_for(
            visible_expr("#solar-system-container"),
            "#solar-system-container to come back after Escape (round %d)" % attempt,
            timeout=15.0,
        ):
            print("FAIL: B - the solar system did not come back after Escape on round %d" % attempt)
            return False
        await asyncio.sleep(0.3)
        print("       round %d: Earth -> Cesium -> Escape OK" % attempt)

    if all_ok:
        print("PASS: B - Earth -> Cesium -> Escape round trip works twice")
    return all_ok


async def check_c():
    """Sun click calls openFrontLogin exactly once and adds no navigation of its own."""
    # The stub must NOT chain to the real implementation. In production
    # window.openFrontLogin is itself a full-page navigation (serverTable.js:2653 sets
    # location.href = '/?login=1'), so calling through would unload the document, destroy
    # window.__loginCalls, and take the rest of the suite off the home page. Counting only
    # keeps the page alive and still exposes the defect this check exists for: written as
    # `window.openFrontLogin?.() || (location.href = '/?login=1')` the call returns
    # undefined, the `||` fires the second branch too, and location.href changes even
    # though the handler ran.
    await js(
        """
        (() => {
          window.__loginCalls = 0;
          window.openFrontLogin = function () {
            window.__loginCalls = (window.__loginCalls || 0) + 1;
          };
          window.__hrefBefore = location.href;
          return true;
        })()
        """
    )
    before = len(NET_URLS)

    if not await click_hit("太阳", 0, "Sun"):
        print("FAIL: C - Sun hit target missing")
        return False

    await drain(1.2)

    calls = await js("window.__loginCalls || 0")
    href_same = await js("location.href === window.__hrefBefore")
    nav_urls = [u for u in NET_URLS[before:] if u.startswith("http") and "?login=1" in u]

    ok = True
    if calls != 1:
        print("FAIL: C - openFrontLogin called %s times (expected exactly 1)" % calls)
        ok = False
    if not href_same:
        print("FAIL: C - Sun click navigated on its own in addition to calling openFrontLogin")
        ok = False
    if nav_urls:
        print("FAIL: C - Sun click requested the login URL directly: %s" % nav_urls[:3])
        ok = False
    if ok:
        print("PASS: C - Sun click calls openFrontLogin exactly once and never navigates itself")
    return ok


async def check_d_problems():
    """Cesium must be absent on first paint."""
    dom_cesium = await js("!!document.querySelector('.cesium-viewer')")
    cesium_net = [u for u in NET_URLS if "cesium" in u.lower()]
    if not dom_cesium and not cesium_net:
        print("PASS: D - Cesium absent on first paint")
        return True
    detail = []
    if dom_cesium:
        detail.append(".cesium-viewer present in DOM")
    cesium_js = [u for u in cesium_net if u.lower().split("?", 1)[0].endswith(".js")]
    cesium_css = [u for u in cesium_net if u.lower().split("?", 1)[0].endswith(".css")]
    cesium_other = [u for u in cesium_net if u not in cesium_js and u not in cesium_css]
    if cesium_js:
        detail.append("Cesium JS requested early: %s" % ", ".join(cesium_js))
    if cesium_css:
        detail.append("Cesium stylesheet requested early: %s" % ", ".join(cesium_css))
    if cesium_other:
        detail.append("other Cesium resource(s) requested early: %s" % ", ".join(cesium_other))
    print("FAIL: D - Cesium loaded on first paint (%s)" % "; ".join(detail))
    return False

async def check_e():
    chunks = [u for u in NET_URLS if "cesium" in u.lower() and "/assets/" in u]
    if chunks:
        print("PASS: E - Cesium chunk requested after Earth click (%s)" % chunks[-1][:120])
        return True
    print("FAIL: E - no Cesium chunk request observed after Earth click")
    return False

async def check_f():
    ok = await wait_for("window.__DBG__?.solarEphemeris?.status === 'ready' && window.__DBG__.solarEphemeris.targets.mars.ok && window.__DBG__.solarEphemeris.targets.halley.ok", "solar ephemeris ready with both targets", timeout=25)
    targets = await js("window.__DBG__.solarEphemeris.targets") if ok else None
    good = ok and all(targets.get(k, {}).get('ok') for k in ('mars', 'halley'))
    print("PASS: F - ephemeris ready with both targets" if good else "FAIL: F - ephemeris targets not ready")
    return good

async def check_g():
    expr = "window.__DBG__?.solarSystem?.getP1RuntimeSnapshot?.() || null"
    first = await js(expr)
    await wait_for("window.__DBG__.solarSystem.frameId !== %s" % json.dumps(first and first.get('frameId')), "a subsequent animation frame", timeout=5)
    second = await js(expr)
    if not first or not second or not second.get('halleyPhysical') or not second.get('marsPhysical'):
        print("FAIL: G - runtime snapshot or physical state unavailable")
        return False
    def asset(name):
        with urllib.request.urlopen(PAGE_URL + "/assets/solar/p1/" + name + ".json", timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    mars_asset, halley_asset = asset("mars"), asset("halley")
    def hermite(data, jd):
        states = data["states"]
        for a, b in zip(states, states[1:]):
            if a[0] <= jd <= b[0]:
                h, t = b[0] - a[0], (jd - a[0]) / (b[0] - a[0])
                t2, t3 = t * t, t * t * t
                return [
                    (2*t3-3*t2+1)*a[i+1] + (t3-2*t2+t)*h*a[i+4] +
                    (-2*t3+3*t2)*b[i+1] + (t3-t2)*h*b[i+4] for i in range(3)
                ]
        return None
    def display(v):
        r = math.sqrt(sum(x*x for x in v))
        nodes = [(0, 0), (.39, 9), (1, 19), (5.2, 35), (30.1, 62)]
        if r >= nodes[-1][0]: d = nodes[-1][1] + 1.5 * (r - nodes[-1][0])
        else:
            for (r0, d0), (r1, d1) in zip(nodes, nodes[1:]):
                if r <= r1:
                    d = d0 + (r-r0)/(r1-r0)*(d1-d0); break
        scale = d / r if r else 0
        return [v[0]*scale, v[2]*scale, -v[1]*scale]
    jd = second['simulationTime']
    expected_mars_physical = hermite(mars_asset, jd)
    expected_halley_physical = hermite(halley_asset, jd)
    if not expected_mars_physical or not expected_halley_physical:
        print("FAIL: G - snapshot simulationTime outside published asset range")
        return False
    expected_mars_world, expected_halley_world = display(expected_mars_physical), display(expected_halley_physical)
    position_error = max(math.dist(second['marsWorld'], expected_mars_world), math.dist(second['halleyWorld'], expected_halley_world))
    move = lambda key: math.dist(first[key], second[key])
    mars_move, halley_move = move('marsWorld'), move('halleyWorld')
    p = expected_halley_physical; expected = [p[0], p[2], -p[1]]
    length = math.sqrt(sum(v*v for v in expected)); expected = [v/length for v in expected]
    actual = second['tailWorldDirection']; dot = sum(a*b for a,b in zip(actual, expected))
    angle = math.degrees(math.acos(max(-1, min(1, dot))))
    good = first['frameId'] != second['frameId'] and mars_move > 0 and halley_move > 0 and abs(mars_move-halley_move) > 1e-12 and position_error <= 1e-8 and dot > 0 and angle <= 2
    print("PASS: G - independent published-state positions and anti-solar tail match (%.4f deg, position error %.3g)" % (angle, position_error) if good else "FAIL: G - snapshot mismatch: mars=%g halley=%g position_error=%g dot=%g angle=%g" % (mars_move, halley_move, position_error, dot, angle))
    return good


# ----------------------------------------------------------------------------
# Infrastructure
# ----------------------------------------------------------------------------
def wait_devtools(port, timeout=30.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:%d/json/version" % port, timeout=1.5
            ) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.3)
    raise RuntimeError("DevTools never came up on port %d (last error: %s)" % (port, last))


def open_tab(port, url):
    """This Chromium build rejects GET on /json/new; PUT is required."""
    req = urllib.request.Request(
        "http://127.0.0.1:%d/json/new?%s" % (port, urllib.parse.quote(url, safe="")),
        method="PUT",
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode("utf-8"))


def find_chromium():
    for name in (
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
        "chrome",
    ):
        path = shutil.which(name)
        if path:
            return path
    return None


async def main():
    global WS, CDP_READER, PAGE_URL
    stage = "startup"

    dist = DIST
    if not (dist / "index.html").exists():
        print("FATAL: %s/index.html not found - build the frontend first" % dist)
        return 1

    chromium = find_chromium()
    if not chromium:
        print("FATAL: no chromium/chrome binary found on PATH")
        return 1

    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(dist))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    http_port = httpd.server_address[1]
    Thread(target=httpd.serve_forever, daemon=True).start()
    page_url = "http://127.0.0.1:%d/" % http_port
    PAGE_URL = page_url.rstrip('/')
    print("       serving %s at %s" % (dist, page_url))

    profile = tempfile.mkdtemp(prefix="solar-verify-profile-")
    proc = None
    a = b = c = d = e = False

    try:
        # Never hard-code 9222: this machine already runs chromium instances on 922x for
        # unrelated CDP work. Binding a fixed port silently attaches to one of those
        # browsers instead of the one launched here, so the flags below (software GL in
        # particular) would apply to a process that is never used.
        with socket.socket() as probe_sock:
            probe_sock.bind(("127.0.0.1", 0))
            cdp_port = probe_sock.getsockname()[1]
        proc = subprocess.Popen(
            [
                chromium,
                "--headless=new",
                "--remote-debugging-port=%d" % cdp_port,
                "--user-data-dir=%s" % profile,
                "--no-first-run",
                "--no-default-browser-check",
                "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                "--disable-dev-shm-usage",
                "--no-sandbox",
                "--window-size=1400,1000",
                "--hide-scrollbars",
                "--mute-audio",
                "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding",
                "--disable-backgrounding-occluded-windows",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        stage = "wait for DevTools"
        version = wait_devtools(cdp_port)
        print("       browser %s" % version.get("Browser", "?"))

        # Open the tab on about:blank and navigate only AFTER Network.enable.
        # Assertion D's determinism depends on this ordering: D looks for /cesium/
        # URLs in Network.requestWillBeSent, and index.html carries a static
        # <link href="/cesium/Widgets/widgets.css"> requested during the very first
        # navigation. Handing page_url to open_tab() starts the document before the
        # Network domain is subscribed, making that capture a coin flip.
        stage = "open blank tab"
        tab = open_tab(cdp_port, "about:blank")
        ws_url = tab["webSocketDebuggerUrl"]

        stage = "connect target websocket"
        WS = await asyncio.wait_for(
            websockets.connect(ws_url, max_size=None), timeout=10
        )
        CDP_READER = asyncio.create_task(cdp_reader())

        stage = "enable Runtime"
        await cdp("Runtime.enable")
        stage = "enable Page"
        await cdp("Page.enable")
        stage = "enable Network"
        await cdp("Network.enable")
        stage = "enable DOM"
        await cdp("DOM.enable")

        stage = "navigate home"
        await cdp("Page.navigate", timeout=60, url=page_url)
        stage = "wait document and scene"
        await wait_for("document.readyState === 'complete'", "document ready", timeout=25.0)
        await drain(1.5)

        # The scene mounts several seconds after readyState=complete (measured: renderer and
        # hit buttons appear around t+6..7s on software GL). Wait for the instance to finish
        # building before probing anything, otherwise every check fails on a half-built scene.
        ready = await wait_for(
            "!!(window.__DBG__ && window.__DBG__.solarSystem && window.__DBG__.solarSystem.renderer"
            " && document.querySelectorAll('button.solar-system-hit').length >= 3)",
            "the solar system scene to finish building (renderer + hit buttons)",
            timeout=30.0,
        )

        # A fail-soft scene records why it degraded. Surface that instead of letting every
        # check fail with a misleading "hit target missing" message: without a working
        # WebGL context THREE never builds a renderer, so no hit buttons are created.
        scene_error = await js("(window.__DBG__ && window.__DBG__.solarSystemError) || null")
        if scene_error:
            print("FATAL: the solar system degraded instead of rendering: %s" % scene_error)
            print("       WebGL is unavailable in this browser configuration. This script launches "
                  "chromium with --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader; "
                  "do not add --disable-gpu, which removes the software renderer too.")
            return 1
        if not ready:
            print("FATAL: the scene never finished building within 30s and reported no error; "
                  "window.__DBG__.solarSystem.renderer and the three hit buttons never appeared.")
            return 1

        # Order matters: A first, then the D probe (before any Earth click mounts
        # Cesium), then C (also before B), then B.
        only_b = "--only-b" in sys.argv
        if only_b:
            print("PARTIAL RUN: A/C/D/E skipped, only B ran", file=sys.stderr)
        a = "SKIP" if only_b else await check_a()
        d = "SKIP" if only_b else await check_d_problems()
        c = "SKIP" if only_b else await check_c()
        b = await check_b()
        e = "SKIP" if only_b else await check_e()
        f = "SKIP" if only_b else await check_f()
        g = "SKIP" if only_b else await check_g()

        print("SUMMARY: A=%s B=%s C=%s D=%s E=%s F=%s G=%s" % (a, b, c, d, e, f, g))
        checks = (b,) if only_b else (a, b, c, d, e, f, g)
        return 0 if all(result is True for result in checks) else 1

    except Exception as exc:  # noqa: BLE001
        print("FATAL: %s during %s: %s" % (type(exc).__name__, stage, exc))
        return 1

    finally:
        if WS is not None:
            try:
                await WS.close()
            except Exception:  # noqa: BLE001
                pass
        if CDP_READER is not None:
            CDP_READER.cancel()
        if proc is not None:
            try:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
            except Exception:  # noqa: BLE001
                pass
        try:
            httpd.shutdown()
        except Exception:  # noqa: BLE001
            pass
        try:
            httpd.server_close()
        except Exception:  # noqa: BLE001
            pass
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
