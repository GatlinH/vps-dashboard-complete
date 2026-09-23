#!/usr/bin/env python3
"""Measure homepage solar-system legibility from a real Chromium screenshot.

Launches its own headless Chromium over the DevTools protocol, serves the built
frontend-dist over loopback HTTP, waits for the real SolarSystem renderer plus
its CC-BY texture upgrade, and samples the actual captured PNG.

Assertions A1-A6 are pure functions over measured metrics so they can be
exercised in isolation via --mutation-test to prove each one can fail. The gate
exits nonzero on any failure and never manufactures a GREEN result.

Standard-library PNG decoding only; the sole third-party import is the
websockets client used to speak CDP, already relied on by the other browser
gates in this repository.
"""
import argparse
import asyncio
import base64
import functools
import json
import math
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "frontend-dist"

A1_JUP_MEAN = 70.0
A1_JUP_SPREAD = 65.0
A2_NEP_MEAN = 45.0
A2_NEP_SPREAD = 25.0
A3_DIFF_AGG_MIN = 8.0
A3_DIFF_EACH_MIN = 2.0
A4_P98_MAX = 245.0
A5_PIXEL_FLOOR_FRAC = 0.9
A5_MIN_PIXELS = 8
A5_MIN_RADIUS = 1.0
A6_MAX_ADVANCE_DAYS = 300.0

PLANETS = ["mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune"]
REQUIRED = list(PLANETS)

A6_OUTER_SPREAD = dict()
A6_OUTER_SPREAD["jupiter"] = A1_JUP_SPREAD
A6_OUTER_SPREAD["neptune"] = A2_NEP_SPREAD


def _js(t):
    return t.replace("__L__", chr(123)).replace("__R__", chr(125))


WS = None
_pending = dict()
_mid = 0


def wait_devtools(port):
    url = "http://127.0.0.1:" + str(port) + "/json/version"
    for _ in range(100):
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                return json.load(r)
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("DevTools endpoint did not come up")


def open_tab(port):
    # PUT /json/new is the supported way to spawn a fresh target.
    url = "http://127.0.0.1:" + str(port) + "/json/new?about:blank"
    req = urllib.request.Request(url, method="PUT")
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)


async def _reader():
    async for raw in WS:
        msg = json.loads(raw)
        fut = _pending.get(msg.get("id"))
        if fut and not fut.done():
            fut.set_result(msg)


async def cdp(method, timeout=45, **params):
    global _mid
    _mid += 1
    ident = _mid
    fut = asyncio.get_running_loop().create_future()
    _pending[ident] = fut
    payload = dict()
    payload["id"] = ident
    payload["method"] = method
    payload["params"] = params
    await WS.send(json.dumps(payload))
    try:
        msg = await asyncio.wait_for(fut, timeout)
    finally:
        _pending.pop(ident, None)
    if "error" in msg:
        raise RuntimeError(method + ": " + json.dumps(msg["error"]))
    return msg.get("result", dict())


async def js(expr, await_promise=False, timeout=45):
    r = await cdp(
        "Runtime.evaluate",
        expression=expr,
        returnByValue=True,
        awaitPromise=await_promise,
        timeout=timeout,
    )
    if "exceptionDetails" in r:
        raise RuntimeError("JS exception: " + json.dumps(r["exceptionDetails"])[:600])
    return r.get("result", dict()).get("value")


async def wait_js(expr, timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if await js(expr):
                return True
        except Exception:
            pass
        await asyncio.sleep(0.15)
    return False


def decode_png(data):
    # Return (width, height, channels, rows) for 8-bit RGB or RGBA PNGs. Rows
    # are bytearrays of length width*channels; index with the real channel
    # count, never a fixed RGBA stride.
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos = 8
    raw = bytearray()
    w = h = depth = ctype = None
    while pos < len(data):
        n = int.from_bytes(data[pos:pos + 4], "big")
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + n]
        pos += n + 12
        if typ == b"IHDR":
            w, h, depth, ctype, _comp, _filt, _il = struct.unpack(">IIBBBBB", chunk)
        elif typ == b"IDAT":
            raw += chunk
        elif typ == b"IEND":
            break
    if depth != 8 or ctype not in (2, 6):
        raise ValueError("unsupported PNG depth or color type")
    channels = 3 if ctype == 2 else 4
    stride = w * channels
    decoded = zlib.decompress(bytes(raw))
    rows = []
    prev = bytearray(stride)
    p = 0
    bpp = channels
    for _ in range(h):
        f = decoded[p]
        p += 1
        cur = bytearray(decoded[p:p + stride])
        p += stride
        for i in range(stride):
            left = cur[i - bpp] if i >= bpp else 0
            up = prev[i]
            ul = prev[i - bpp] if i >= bpp else 0
            if f == 0:
                pass
            elif f == 1:
                cur[i] = (cur[i] + left) & 255
            elif f == 2:
                cur[i] = (cur[i] + up) & 255
            elif f == 3:
                cur[i] = (cur[i] + ((left + up) >> 1)) & 255
            elif f == 4:
                q = left + up - ul
                a = abs(q - left)
                b = abs(q - up)
                c = abs(q - ul)
                if a <= b and a <= c:
                    pred = left
                elif b <= c:
                    pred = up
                else:
                    pred = ul
                cur[i] = (cur[i] + pred) & 255
            else:
                raise ValueError("bad PNG filter type")
        rows.append(cur)
        prev = cur
    return w, h, channels, rows


def _lum_at(rows, channels, px, py):
    off = px * channels
    row = rows[py]
    r = row[off]
    g = row[off + 1]
    b = row[off + 2]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _disc_pixels(w, h, cx, cy, radius):
    rr = max(1.0, 0.75 * radius)
    x0 = max(0, int(math.floor(cx - rr)))
    x1 = min(w - 1, int(math.ceil(cx + rr)))
    y0 = max(0, int(math.floor(cy - rr)))
    y1 = min(h - 1, int(math.ceil(cy + rr)))
    out = []
    rr2 = rr * rr
    for py in range(y0, y1 + 1):
        for px in range(x0, x1 + 1):
            if (px - cx) ** 2 + (py - cy) ** 2 <= rr2:
                out.append((px, py))
    return out


def _pct(sorted_vals, p):
    if not sorted_vals:
        return 0.0
    idx = int((len(sorted_vals) - 1) * p)
    idx = min(len(sorted_vals) - 1, max(0, idx))
    return sorted_vals[idx]


def measure(png_bytes, bodies, scale_x, scale_y):
    # Sample every projected body at 0.75 of its projected radius.
    w, h, channels, rows = decode_png(png_bytes)
    metrics = dict()
    for b in bodies:
        name = b["name"]
        cx = b["x"] * scale_x
        cy = b["y"] * scale_y
        radius = b["r"] * scale_x
        pts = _disc_pixels(w, h, cx, cy, radius)
        vals = sorted(_lum_at(rows, channels, px, py) for (px, py) in pts)
        floor = max(A5_MIN_PIXELS, A5_PIXEL_FLOOR_FRAC * math.pi * (0.75 * radius) ** 2)
        entry = dict()
        entry["visible"] = bool(b.get("visible"))
        entry["radius"] = round(radius, 2)
        entry["pixel_floor"] = round(floor, 1)
        if not vals:
            entry["pixels"] = 0
            metrics[name] = entry
            continue
        entry["pixels"] = len(vals)
        entry["mean"] = round(sum(vals) / len(vals), 2)
        entry["p5"] = round(_pct(vals, 0.05), 2)
        entry["p95"] = round(_pct(vals, 0.95), 2)
        entry["p98"] = round(_pct(vals, 0.98), 2)
        entry["spread"] = round(_pct(vals, 0.95) - _pct(vals, 0.05), 2)
        metrics[name] = entry
    return w, h, channels, metrics


def map_diff(png_a, png_b, bodies, scale_x, scale_y):
    # Mean absolute luminance difference within each body disc (A3).
    wa, ha, ca, ra = decode_png(png_a)
    wb, hb, cb, rb = decode_png(png_b)
    if (wa, ha) != (wb, hb):
        raise ValueError("A3 screenshots differ in size")
    diffs = dict()
    for b in bodies:
        name = b["name"]
        cx = b["x"] * scale_x
        cy = b["y"] * scale_y
        radius = b["r"] * scale_x
        pts = _disc_pixels(wa, ha, cx, cy, radius)
        if not pts:
            diffs[name] = 0.0
            continue
        total = 0.0
        for (px, py) in pts:
            total += abs(_lum_at(ra, ca, px, py) - _lum_at(rb, cb, px, py))
        diffs[name] = round(total / len(pts), 3)
    return diffs


def check_a1(metrics):
    j = metrics.get("jupiter", dict())
    ok = j.get("mean", 0) >= A1_JUP_MEAN and j.get("spread", 0) >= A1_JUP_SPREAD
    detail = dict()
    detail["jupiter_mean"] = j.get("mean")
    detail["jupiter_spread"] = j.get("spread")
    detail["need_mean"] = A1_JUP_MEAN
    detail["need_spread"] = A1_JUP_SPREAD
    return ok, detail


def check_a2(metrics):
    n = metrics.get("neptune", dict())
    ok = n.get("mean", 0) >= A2_NEP_MEAN and n.get("spread", 0) >= A2_NEP_SPREAD
    detail = dict()
    detail["neptune_mean"] = n.get("mean")
    detail["neptune_spread"] = n.get("spread")
    detail["need_mean"] = A2_NEP_MEAN
    detail["need_spread"] = A2_NEP_SPREAD
    return ok, detail


def check_a3(diffs):
    vals = [diffs.get(n, 0.0) for n in REQUIRED]
    agg = sum(vals) / len(vals) if vals else 0.0
    each_ok = all(diffs.get(n, 0.0) >= A3_DIFF_EACH_MIN for n in REQUIRED)
    ok = bool(REQUIRED) and agg >= A3_DIFF_AGG_MIN and each_ok
    detail = dict()
    detail["aggregate_diff"] = round(agg, 3)
    detail["need_aggregate"] = A3_DIFF_AGG_MIN
    detail["need_each"] = A3_DIFF_EACH_MIN
    detail["per_body"] = diffs
    return ok, detail


def check_a4(metrics):
    present = [n for n in PLANETS if n in metrics and "p98" in metrics[n]]
    detail = dict()
    if len(present) != len(PLANETS):
        detail["reason"] = "missing planet metrics"
        detail["missing"] = [n for n in PLANETS if n not in present]
        return False, detail
    over = dict()
    p98 = dict()
    for n in PLANETS:
        v = metrics[n]["p98"]
        p98[n] = v
        if v > A4_P98_MAX:
            over[n] = v
    detail["p98_max"] = A4_P98_MAX
    detail["over_limit"] = over
    detail["p98"] = p98
    return len(over) == 0, detail


def check_a5(metrics):
    detail = dict()
    detail["required"] = REQUIRED
    if not REQUIRED:
        detail["failures"] = "empty required set"
        return False, detail
    failures = dict()
    for n in REQUIRED:
        m = metrics.get(n)
        if not m:
            failures[n] = "absent"
            continue
        if not m.get("visible"):
            failures[n] = "not visible"
            continue
        if m.get("radius", 0) < A5_MIN_RADIUS:
            failures[n] = "radius below floor"
            continue
        if m.get("pixels", 0) < m.get("pixel_floor", A5_MIN_PIXELS):
            failures[n] = "pixel count below floor"
    detail["failures"] = failures
    return len(failures) == 0, detail


def check_a6(metrics2, advance_days):
    detail = dict()
    detail["advance_days"] = round(advance_days, 4)
    detail["max_advance"] = A6_MAX_ADVANCE_DAYS
    bounded = 0.0 < advance_days <= A6_MAX_ADVANCE_DAYS
    spreads = dict()
    contract_ok = True
    for name in A6_OUTER_SPREAD:
        floor = A6_OUTER_SPREAD[name]
        s = metrics2.get(name, dict()).get("spread", 0)
        row = dict()
        row["spread"] = s
        row["need"] = floor
        row["ok"] = s >= floor
        spreads[name] = row
        if s < floor:
            contract_ok = False
    detail["bounded"] = bounded
    detail["outer_spread"] = spreads
    return (bounded and contract_ok), detail


def assess(pass1, diffs, pass2, advance_days):
    checks = dict()
    checks["A1"] = check_a1(pass1)
    checks["A2"] = check_a2(pass1)
    checks["A3"] = check_a3(diffs)
    checks["A4"] = check_a4(pass1)
    checks["A5"] = check_a5(pass1)
    checks["A6"] = check_a6(pass2, advance_days)
    return checks


READY_EXPR = _js("(()=>__L__const s=window.__DBG__&&window.__DBG__.solarSystem;if(!s||!s.ephemerisTargets||!s.renderer)return false;const n=['mercury','venus','earth','mars','jupiter','saturn','uranus','neptune'];return n.every(k=>s.ephemerisTargets[k]&&s.ephemerisTargets[k].visible===true)&&!s.cameraTween;__R__)()")

TEXTURE_EXPR = _js("new Promise(res=>__L__const s=window.__DBG__.solarSystem;const p=s&&s.textureLoadPromise;if(!p)__L__res('no-promise');return;__R__Promise.resolve(p).then(()=>res('done')).catch(e=>res('err:'+e));__R__)")

TEXTURE_CHECK_EXPR = _js("(()=>__L__const s=window.__DBG__.solarSystem;const out=__L____R__;for(const n of ['jupiter','earth','mars','neptune'])__L__const m=s.ephemerisTargets[n];const img=m&&m.material&&m.material.map&&m.material.map.image;out[n]=img?(img.width||img.naturalWidth||0):0;__R__return out;__R__)()")

PROJECT_EXPR = _js("(()=>__L__const s=window.__DBG__.solarSystem,c=s.canvas.getBoundingClientRect(),cam=s.camera;const P=cam.projectionMatrix.elements,V=cam.matrixWorldInverse.elements,W=cam.matrixWorld.elements;function mul(a,v)__L__return [a[0]*v[0]+a[4]*v[1]+a[8]*v[2]+a[12]*v[3],a[1]*v[0]+a[5]*v[1]+a[9]*v[2]+a[13]*v[3],a[2]*v[0]+a[6]*v[1]+a[10]*v[2]+a[14]*v[3],a[3]*v[0]+a[7]*v[1]+a[11]*v[2]+a[15]*v[3]];__R__function proj(p)__L__const e=mul(V,[p[0],p[1],p[2],1]);const q=mul(P,e);return [q[0]/q[3],q[1]/q[3]];__R__let rx=W[0],ry=W[1],rz=W[2];const rl=Math.hypot(rx,ry,rz)||1;rx/=rl;ry/=rl;rz/=rl;const bodies=[];for(const [name,m] of Object.entries(s.ephemerisTargets))__L__if(!m||!m.isMesh||!m.visible)continue;const e=m.matrixWorld.elements;const p=[e[12],e[13],e[14]];const rad=(m.geometry&&m.geometry.parameters&&m.geometry.parameters.radius)||0.5;const q=proj(p);const q2=proj([p[0]+rad*rx,p[1]+rad*ry,p[2]+rad*rz]);const x=c.left+(q[0]+1)*0.5*c.width;const y=c.top+(1-q[1])*0.5*c.height;const x2=c.left+(q2[0]+1)*0.5*c.width;const y2=c.top+(1-q2[1])*0.5*c.height;const r=Math.max(1,Math.hypot(x2-x,y2-y));bodies.push(__L__name:name,x:x,y:y,r:r,visible:m.visible__R__);__R__const out=__L__innerWidth:window.innerWidth,innerHeight:window.innerHeight,rect:__L__left:c.left,top:c.top,w:c.width,h:c.height__R__,bodies:bodies__R__;return out;__R__)()")


def motion_expr(state):
    body = "(()=>__L__const s=window.__DBG__.solarSystem;s.orbitState.motionState='"
    body += state
    body += "';return s.simulationTime;__R__)()"
    return _js(body)


def toggle_maps_expr(action):
    names = json.dumps(PLANETS)
    parts = []
    parts.append("(()=>__L__const s=window.__DBG__.solarSystem;const names=")
    parts.append(names)
    parts.append(";window.__mapStash=window.__mapStash||__L____R__;")
    parts.append("for(const n of names)__L__const m=s.ephemerisTargets[n];if(!m||!m.material)continue;const mat=m.material;")
    parts.append("if('")
    parts.append(action)
    parts.append("'==='off')__L__window.__mapStash[n]=__L__map:mat.map,em:mat.emissiveMap__R__;mat.map=null;mat.emissiveMap=null;mat.needsUpdate=true;__R__")
    parts.append("else__L__const st=window.__mapStash[n];if(st)__L__mat.map=st.map;mat.emissiveMap=st.em;mat.needsUpdate=true;__R____R____R__")
    parts.append("s.renderer.render(s.scene,s.camera);return true;__R__)()")
    return _js("".join(parts))


async def capture_png():
    shot = await cdp("Page.captureScreenshot", format="png", fromSurface=True)
    return base64.b64decode(shot["data"])


def run_mutation_test():
    # Independently executable proof that A1-A6 assertions can fail. Every
    # check is given a valid input (must pass) plus fault-injected inputs
    # (must fail). Exits nonzero if any assertion cannot detect its fault.
    def good_metrics():
        m = dict()
        for n in PLANETS:
            e = dict()
            e["pixels"] = 5000
            e["visible"] = True
            e["mean"] = 90.0
            e["p5"] = 20.0
            e["p95"] = 160.0
            e["p98"] = 200.0
            e["spread"] = 140.0
            e["radius"] = 20.0
            e["pixel_floor"] = 100.0
            m[n] = e
        return m

    results = []

    ok_pass, _ = check_a1(good_metrics())
    m = good_metrics()
    m["jupiter"]["mean"] = 40.0
    ok_mean, _ = check_a1(m)
    m = good_metrics()
    m["jupiter"]["spread"] = 10.0
    ok_spread, _ = check_a1(m)
    d = dict()
    d["pass"] = ok_pass
    d["dim_fails"] = not ok_mean
    d["flat_fails"] = not ok_spread
    results.append(("A1", ok_pass and not ok_mean and not ok_spread, d))

    ok_pass, _ = check_a2(good_metrics())
    m = good_metrics()
    m["neptune"]["mean"] = 20.0
    ok_mean, _ = check_a2(m)
    m = good_metrics()
    m["neptune"]["spread"] = 5.0
    ok_spread, _ = check_a2(m)
    d = dict()
    d["pass"] = ok_pass
    d["dim_fails"] = not ok_mean
    d["flat_fails"] = not ok_spread
    results.append(("A2", ok_pass and not ok_mean and not ok_spread, d))

    good_diffs = dict()
    for n in PLANETS:
        good_diffs[n] = 30.0
    ok_pass, _ = check_a3(good_diffs)
    zero_diffs = dict()
    for n in PLANETS:
        zero_diffs[n] = 0.0
    ok_zero, _ = check_a3(zero_diffs)
    one_flat = dict()
    for n in PLANETS:
        one_flat[n] = 30.0
    one_flat["mars"] = 0.5
    ok_flat, _ = check_a3(one_flat)
    d = dict()
    d["pass"] = ok_pass
    d["zero_diff_fails"] = not ok_zero
    d["single_flat_fails"] = not ok_flat
    results.append(("A3", ok_pass and not ok_zero and not ok_flat, d))

    ok_pass, _ = check_a4(good_metrics())
    m = good_metrics()
    m["saturn"]["p98"] = 255.0
    ok_clip, _ = check_a4(m)
    m = good_metrics()
    del m["uranus"]
    ok_missing, _ = check_a4(m)
    d = dict()
    d["pass"] = ok_pass
    d["clip_fails"] = not ok_clip
    d["missing_fails"] = not ok_missing
    results.append(("A4", ok_pass and not ok_clip and not ok_missing, d))

    ok_pass, _ = check_a5(good_metrics())
    m = good_metrics()
    m["earth"]["visible"] = False
    ok_invis, _ = check_a5(m)
    m = good_metrics()
    m["mars"]["pixels"] = 0
    ok_thin, _ = check_a5(m)
    m = good_metrics()
    del m["venus"]
    ok_absent, _ = check_a5(m)
    d = dict()
    d["pass"] = ok_pass
    d["invisible_fails"] = not ok_invis
    d["thin_fails"] = not ok_thin
    d["absent_fails"] = not ok_absent
    results.append(("A5", ok_pass and not ok_invis and not ok_thin and not ok_absent, d))

    m2 = good_metrics()
    ok_pass, _ = check_a6(m2, 30.0)
    ok_frozen, _ = check_a6(m2, 0.0)
    ok_huge, _ = check_a6(m2, A6_MAX_ADVANCE_DAYS + 1)
    m2b = good_metrics()
    m2b["jupiter"]["spread"] = 5.0
    ok_collapse, _ = check_a6(m2b, 30.0)
    d = dict()
    d["pass"] = ok_pass
    d["frozen_fails"] = not ok_frozen
    d["unbounded_fails"] = not ok_huge
    d["collapsed_spread_fails"] = not ok_collapse
    results.append(("A6", ok_pass and not ok_frozen and not ok_huge and not ok_collapse, d))

    report = dict()
    all_proven = True
    for name, proven, detail in results:
        detail["proven"] = proven
        report[name] = detail
        if not proven:
            all_proven = False
    out = dict()
    out["mutation_test"] = report
    out["all_proven"] = all_proven
    print(json.dumps(out, indent=2))
    return 0 if all_proven else 1


async def run_measurement(evidence_dir):
    global WS
    events = []

    def event(kind, **kw):
        rec = dict()
        rec["t"] = round(time.time(), 3)
        rec["event"] = kind
        rec.update(kw)
        events.append(rec)
        return rec

    if not (DIST / "index.html").exists():
        print("FATAL: frontend-dist/index.html missing; build the frontend first", file=sys.stderr)
        return 1, events, None

    candidates = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"]
    chrome = None
    for cand in candidates:
        found = shutil.which(cand)
        if found:
            chrome = found
            break
    if not chrome:
        print("FATAL: no Chromium or Chrome binary found", file=sys.stderr)
        return 1, events, None
    event("chromium", path=chrome)

    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(DIST))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    Thread(target=httpd.serve_forever, daemon=True).start()
    http_port = httpd.server_address[1]
    event("http_server", port=http_port, root=str(DIST))

    profile = tempfile.mkdtemp(prefix="solar-legibility-")
    proc = None
    report = None
    exit_code = 1
    try:
        sk = socket.socket()
        sk.bind(("127.0.0.1", 0))
        dbg_port = sk.getsockname()[1]
        sk.close()
        chrome_args = [
            chrome,
            "--headless=new",
            "--remote-debugging-port=" + str(dbg_port),
            "--user-data-dir=" + profile,
            "--no-first-run",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--window-size=1400,913",
            "--force-device-scale-factor=1",
            "--hide-scrollbars",
            "about:blank",
        ]
        proc = subprocess.Popen(chrome_args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        event("chromium_launch", debug_port=dbg_port)
        wait_devtools(dbg_port)
        import websockets
        tab = open_tab(dbg_port)
        WS = await websockets.connect(tab["webSocketDebuggerUrl"], max_size=None, ping_interval=None)
        asyncio.create_task(_reader())

        await cdp("Runtime.enable")
        await cdp("Page.enable")
        await cdp("Page.navigate", url="http://127.0.0.1:" + str(http_port) + "/")
        event("navigated")

        if not await wait_js("document.readyState==='complete'", 25):
            print("FATAL: document never reached complete", file=sys.stderr)
            return 1, events, None
        if not await wait_js(READY_EXPR, 45):
            print("FATAL: renderer or planets never became visible", file=sys.stderr)
            return 1, events, None
        event("scene_ready")

        tex_state = await js(TEXTURE_EXPR, await_promise=True, timeout=60)
        tex_sizes = await js(TEXTURE_CHECK_EXPR)
        event("textures", state=tex_state, sizes=tex_sizes)
        real_tex = True
        for nm in ("jupiter", "neptune", "mars"):
            if (tex_sizes or dict()).get(nm, 0) < 1024:
                real_tex = False
        await asyncio.sleep(1.5)

        # Pass 1: freeze motion so baseline and no-map align pixel-for-pixel.
        await js(motion_expr("paused"))
        await asyncio.sleep(0.3)
        proj1 = await js(PROJECT_EXPR)
        bodies1 = proj1["bodies"]
        baseline_png = await capture_png()
        w_probe, h_probe, _cc, _rr = decode_png(baseline_png)
        scale_x = 1.0
        scale_y = 1.0
        if proj1["innerWidth"]:
            scale_x = w_probe / proj1["innerWidth"]
        if proj1["innerHeight"]:
            scale_y = h_probe / proj1["innerHeight"]
        event("pass1", bodies=len(bodies1), viewport=[w_probe, h_probe], scale=[round(scale_x, 4), round(scale_y, 4)])
        w1, h1, ch1, metrics1 = measure(baseline_png, bodies1, scale_x, scale_y)
        event("pass1_metrics", channels=ch1)

        # A3: remove albedo/emissive maps, recapture at identical positions.
        await js(toggle_maps_expr("off"))
        await asyncio.sleep(0.2)
        nomap_png = await capture_png()
        await js(toggle_maps_expr("on"))
        diffs = map_diff(baseline_png, nomap_png, bodies1, scale_x, scale_y)
        event("a3_diffs", diffs=diffs)

        # A6: bounded simulation advance, then re-freeze and re-measure.
        t0 = await js(motion_expr("running"))
        await asyncio.sleep(2.5)
        t1 = await js(motion_expr("paused"))
        await asyncio.sleep(0.3)
        advance_days = float(t1) - float(t0)
        proj2 = await js(PROJECT_EXPR)
        bodies2 = proj2["bodies"]
        second_png = await capture_png()
        w2, h2, ch2, metrics2 = measure(second_png, bodies2, scale_x, scale_y)
        event("pass2", advance_days=round(advance_days, 4), bodies=len(bodies2))

        checks = assess(metrics1, diffs, metrics2, advance_days)
        checks_ok = dict()
        for k in checks:
            checks_ok[k] = checks[k][0]
        all_ok = real_tex
        for k in checks_ok:
            if not checks_ok[k]:
                all_ok = False
        exit_code = 0 if all_ok else 1

        checks_report = dict()
        for k in checks:
            row = dict()
            row["pass"] = checks[k][0]
            row["detail"] = checks[k][1]
            checks_report[k] = row
        tex_report = dict()
        tex_report["state"] = tex_state
        tex_report["sizes"] = tex_sizes
        tex_report["real"] = real_tex
        report = dict()
        report["verdict"] = "GREEN" if all_ok else "BLOCKED"
        report["viewport"] = [w1, h1]
        report["channels"] = ch1
        report["scale"] = [round(scale_x, 4), round(scale_y, 4)]
        report["textures"] = tex_report
        report["advance_days"] = round(advance_days, 4)
        report["pass1_metrics"] = metrics1
        report["pass2_metrics"] = metrics2
        report["a3_diffs"] = diffs
        report["checks"] = checks_report

        print(json.dumps(report, ensure_ascii=False, indent=2))
        for name in ("A1", "A2", "A3", "A4", "A5", "A6"):
            label = "PASS" if checks_ok[name] else "FAIL"
            print(name + " " + label)
        print("TEXTURES_REAL " + ("PASS" if real_tex else "FAIL"))
        print("VERDICT " + ("GREEN" if all_ok else "BLOCKED"))

        if evidence_dir:
            ed = Path(evidence_dir)
            ed.mkdir(parents=True, exist_ok=True)
            (ed / "metrics.json").write_text(json.dumps(report, indent=2))
            (ed / "baseline.png").write_bytes(baseline_png)
            (ed / "no_map.png").write_bytes(nomap_png)
            (ed / "second_pass.png").write_bytes(second_png)
            event("evidence_saved", dir=str(ed))

        return exit_code, events, report
    finally:
        if WS:
            await WS.close()
        if proc:
            proc.terminate()
            try:
                proc.wait(3)
            except subprocess.TimeoutExpired:
                proc.kill()
        httpd.shutdown()
        httpd.server_close()
        shutil.rmtree(profile, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description="Solar-system legibility gate")
    default_ev = os.environ.get("SOLAR_LEGIBILITY_EVIDENCE")
    parser.add_argument("--evidence", default=default_ev, help="directory for JSON metrics and screenshots")
    parser.add_argument("--mutation-test", action="store_true", help="prove A1-A6 assertions can fail; no browser needed")
    args = parser.parse_args()

    if args.mutation_test:
        return run_mutation_test()

    exit_code, events, _report = asyncio.run(run_measurement(args.evidence))
    if args.evidence:
        ed = Path(args.evidence)
        ed.mkdir(parents=True, exist_ok=True)
        lines = []
        for rec in events:
            lines.append(json.dumps(rec))
        (ed / "events.jsonl").write_text("\n".join(lines) + "\n")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
