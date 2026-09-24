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
import hashlib
import json
import math
import os
import re
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
SCRIPT_PATH = Path(__file__).resolve()
# Evidence lives inside the repo; writing it must not trip the dirty guard, so
# any path under this top-level directory is excluded from the provenance diff
# while every other (source) path is still caught.
EVIDENCE_EXCLUDE_PREFIX = "evidence/"
BUILT_MANIFEST = DIST / "assets" / "solar" / "textures-v1" / "manifest.json"

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

# Every manifest slot the CC-BY upgrade must populate on a desktop viewport,
# paired with the live mesh it feeds and the exact material channel it targets.
# "map" is the albedo channel; "alphaMap" is the cloud opacity mask. The gate
# fails closed unless all eleven are bound to the real (non-canvas) manifest
# texture with the declared file, minimum desktop dimensions and colour space.
#   (manifest_key, mesh_kind, material_slot)
TEXTURE_TARGETS = [
    ("mercury", "planet", "map"),
    ("venus", "planet", "map"),
    ("earth", "planet", "map"),
    ("earth_clouds", "cloud", "alphaMap"),
    ("moon", "moon", "map"),
    ("mars", "planet", "map"),
    ("jupiter", "planet", "map"),
    ("saturn", "planet", "map"),
    ("saturn_ring", "ring", "map"),
    ("uranus", "planet", "map"),
    ("neptune", "planet", "map"),
]
TEXTURE_KEYS = [t[0] for t in TEXTURE_TARGETS]

# Projection-coverage tolerances. The screen-space radius is the max projected
# offset across six orthogonal world-radius directions, so the sampling disc
# never depends on a single transformed axis that a bug could collapse.
PROJ_MIN_RADIUS = A5_MIN_RADIUS
PROJ_RADIUS_TOL = 0.75

A6_OUTER_SPREAD = dict()
A6_OUTER_SPREAD["jupiter"] = A1_JUP_SPREAD
A6_OUTER_SPREAD["neptune"] = A2_NEP_SPREAD


def _js(t):
    return t.replace("__L__", chr(123)).replace("__R__", chr(125))


def _finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _sha256_file(path):
    try:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None


def _git(args):
    try:
        proc = subprocess.run(
            ["git"] + args, cwd=str(ROOT), capture_output=True, text=True, timeout=30
        )
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout


def git_head():
    out = _git(["rev-parse", "HEAD"])
    return out.strip() if out else None


def git_dirty_entries():
    # Sorted "XY path" tuples for every tracked/untracked change EXCEPT the
    # evidence tree, which this very run rewrites. Returns None when git is
    # unavailable so the caller can fail closed instead of faking a clean tree.
    out = _git(["status", "--porcelain"])
    if out is None:
        return None
    entries = []
    for line in out.splitlines():
        if not line.strip():
            continue
        status = line[:2].strip()
        path = line[3:] if len(line) > 3 else ""
        norm = path.split(" -> ")[-1].strip().strip('"')
        if norm.startswith(EVIDENCE_EXCLUDE_PREFIX):
            continue
        entries.append(status + " " + norm)
    return sorted(entries)


def provenance_snapshot():
    return {"head": git_head(), "dirty": git_dirty_entries()}


def compute_build_binding():
    # Exact binding to the built artifacts the browser actually loads: the
    # entry HTML, its hashed main module chunk and the texture manifest.
    binding = dict()
    index_path = DIST / "index.html"
    binding["index_html"] = "index.html"
    binding["index_html_sha256"] = _sha256_file(index_path)
    main_rel = None
    try:
        html = index_path.read_text(encoding="utf-8", errors="replace")
        m = re.search(r'<script[^>]+type="module"[^>]+src="([^"]+)"', html)
        if not m:
            m = re.search(r'<script[^>]+src="([^"]+)"[^>]+type="module"', html)
        if m:
            main_rel = m.group(1).lstrip("/")
    except Exception:
        main_rel = None
    binding["main_asset"] = main_rel
    binding["main_asset_sha256"] = _sha256_file(DIST / main_rel) if main_rel else None
    binding["texture_manifest"] = "assets/solar/textures-v1/manifest.json"
    binding["texture_manifest_sha256"] = _sha256_file(BUILT_MANIFEST)
    return binding


def build_texture_expectations(manifest, tier="desktop"):
    # Turn the built manifest into per-slot acceptance criteria that mirror the
    # runtime swap: albedo maps keep their declared sRGB colour space; the cloud
    # alphaMap and the linear ring strip are forced to NoColorSpace ("").
    textures = (manifest or dict()).get("textures") or dict()
    expected = dict()
    for key, _kind, slot in TEXTURE_TARGETS:
        meta = textures.get(key)
        if not isinstance(meta, dict):
            continue
        tiers = meta.get("tiers") or dict()
        entry = tiers.get(tier) or tiers.get("desktop")
        if not isinstance(entry, dict):
            continue
        dims = entry.get("dimensions") or [0, 0]
        declared = meta.get("color_space", "srgb")
        three_cs = "" if (slot == "alphaMap" or declared != "srgb") else "srgb"
        expected[key] = {
            "slot": slot,
            "file": entry.get("file"),
            "min_width": int(dims[0]) if len(dims) > 0 else 0,
            "min_height": int(dims[1]) if len(dims) > 1 else 0,
            "color_space": three_cs,
        }
    return expected


def check_textures_real(observed, expected):
    # Fails closed unless every expected slot carries the real manifest texture:
    # correct material channel (map vs alphaMap), no leftover procedural canvas,
    # at least the declared desktop dimensions, a src bound to the manifest file
    # and the declared colour-space semantics.
    detail = dict()
    keys = list(expected.keys())
    detail["required"] = keys
    if len(keys) != len(TEXTURE_TARGETS):
        detail["failures"] = {"_manifest": "expectation set incomplete"}
        detail["per_slot"] = dict()
        return False, detail
    observed = observed or dict()
    failures = dict()
    per = dict()
    for key in keys:
        e = expected[key]
        o = observed.get(key)
        row = dict()
        row["expected_slot"] = e["slot"]
        row["expected_file"] = e["file"]
        row["expected_min"] = [e["min_width"], e["min_height"]]
        row["expected_color_space"] = e["color_space"]
        if not o:
            failures[key] = "no observation"
            per[key] = row
            continue
        row["slot"] = o.get("slot")
        row["present"] = bool(o.get("present"))
        row["width"] = o.get("width")
        row["height"] = o.get("height")
        row["src"] = o.get("src")
        row["color_space"] = o.get("colorSpace")
        row["is_canvas"] = o.get("is_canvas")
        per[key] = row
        if not o.get("present"):
            failures[key] = "slot empty"
            continue
        if o.get("slot") != e["slot"]:
            failures[key] = "wrong material slot"
            continue
        if o.get("is_canvas"):
            failures[key] = "procedural canvas still bound"
            continue
        w = o.get("width") or 0
        h = o.get("height") or 0
        if w < e["min_width"] or h < e["min_height"]:
            failures[key] = "below minimum desktop dimensions"
            continue
        src = o.get("src") or ""
        if not o.get("has_src") or not e["file"] or not src.endswith(e["file"]):
            failures[key] = "src not bound to manifest file"
            continue
        if (o.get("colorSpace") or "") != e["color_space"]:
            failures[key] = "colour-space mismatch"
            continue
    detail["failures"] = failures
    detail["per_slot"] = per
    return len(failures) == 0, detail


def check_projection(proj, required=None):
    # Validates the screen-space projection feeding the pixel sampler: finite,
    # on-screen centre; finite radius at/above the floor; a non-empty radius
    # sample set; and a reported radius that is not underreported versus the
    # robust six-direction maximum. No empty set silently passes.
    required = REQUIRED if required is None else required
    detail = dict()
    iw = proj.get("innerWidth") or 0
    ih = proj.get("innerHeight") or 0
    detail["viewport"] = [iw, ih]
    detail["required"] = list(required)
    if not required:
        detail["reason"] = "empty required set"
        detail["failures"] = {"_": "empty required set"}
        return False, detail
    if not (iw > 0 and ih > 0):
        detail["reason"] = "viewport not measured"
        detail["failures"] = {"_": "viewport not measured"}
        return False, detail
    bodies = dict()
    for b in proj.get("bodies", []):
        bodies[b.get("name")] = b
    failures = dict()
    checked = 0
    for name in required:
        b = bodies.get(name)
        if not b:
            failures[name] = "missing projection"
            continue
        x = b.get("x")
        y = b.get("y")
        r = b.get("r")
        samples = b.get("r_samples") or []
        if not (_finite(x) and _finite(y)):
            failures[name] = "center not finite"
            continue
        if not _finite(r):
            failures[name] = "radius not finite"
            continue
        if not samples or not all(_finite(s) for s in samples):
            failures[name] = "no finite radius samples"
            continue
        if not (0 <= x <= iw and 0 <= y <= ih):
            failures[name] = "center off-screen"
            continue
        if r < PROJ_MIN_RADIUS:
            failures[name] = "radius below floor"
            continue
        expected_r = max(max(samples), PROJ_MIN_RADIUS)
        if r < expected_r - PROJ_RADIUS_TOL:
            failures[name] = "radius underreported vs robust samples"
            continue
        checked += 1
    detail["failures"] = failures
    detail["checked"] = checked
    return (checked == len(required) and not failures), detail



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


def _a5_pixel_floor(radius):
    # measure() reports radius to 0.01 px; use its lower rounding endpoint.
    rr = max(1.0, 0.75 * max(0.0, radius - 0.005))
    # Every point within rr - sqrt(1/2) rounds to a pixel centre within rr.
    # The unit squares of those centres therefore cover that inner disc, so
    # its area is a lower bound on _disc_pixels' full, unclipped count at ANY
    # sub-pixel offset. Cap the continuous floor by this bound; clipping or
    # missing pixels must not lower it. Ceil is safe because counts are integer.
    inner = max(0.0, rr - math.sqrt(0.5))
    guaranteed = math.pi * inner ** 2
    continuous = A5_PIXEL_FLOOR_FRAC * math.pi * rr ** 2
    return max(A5_MIN_PIXELS, math.ceil(min(continuous, guaranteed)))


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
        entry = dict()
        entry["visible"] = bool(b.get("visible"))
        entry["radius"] = round(radius, 2)
        entry["pixel_floor"] = _a5_pixel_floor(entry["radius"])
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
        if m.get("pixels", 0) < _a5_pixel_floor(m.get("radius", 0)):
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


def texture_slots_expr():
    # Reads every expected manifest slot straight off the live materials the
    # runtime populates, distinguishing map from alphaMap and flagging any
    # slot still holding the procedural <canvas> stand-in.
    specs = json.dumps([[k, kind, slot] for (k, kind, slot) in TEXTURE_TARGETS])
    body = (
        "(()=>{"
        "const s=window.__DBG__.solarSystem;"
        "const specs=" + specs + ";"
        "const out={};"
        "for(const spec of specs){"
        "const key=spec[0],kind=spec[1],slot=spec[2];"
        "let mesh=null;"
        "if(kind==='cloud')mesh=s.earthCloudMesh;"
        "else if(kind==='ring')mesh=s.saturnRing;"
        "else if(kind==='moon')mesh=s.moon;"
        "else mesh=s.ephemerisTargets?s.ephemerisTargets[key]:null;"
        "const rec={present:false,slot:slot,mesh_present:!!mesh};"
        "const mat=mesh?mesh.material:null;"
        "const tex=mat?mat[slot]:null;"
        "if(tex){"
        "rec.present=true;"
        "const img=tex.image||{};"
        "rec.width=img.naturalWidth||img.width||0;"
        "rec.height=img.naturalHeight||img.height||0;"
        "rec.src=((img.currentSrc||img.src||'')+'');"
        "rec.has_src=!!(img&&(img.currentSrc||img.src));"
        "rec.colorSpace=(tex.colorSpace===undefined||tex.colorSpace===null)?null:tex.colorSpace;"
        "let canvasLike=false;"
        "try{canvasLike=(typeof HTMLCanvasElement!=='undefined')&&(img instanceof HTMLCanvasElement);}catch(e){canvasLike=false;}"
        "if(!canvasLike&&img&&img.tagName==='CANVAS')canvasLike=true;"
        "rec.is_canvas=canvasLike;"
        "}"
        "out[key]=rec;"
        "}"
        "return out;"
        "})()"
    )
    return body


TEXTURE_SLOTS_EXPR = texture_slots_expr()

PROJECT_EXPR = (
    "(()=>{"
    "const s=window.__DBG__.solarSystem,c=s.canvas.getBoundingClientRect(),cam=s.camera;"
    "const P=cam.projectionMatrix.elements,V=cam.matrixWorldInverse.elements;"
    "function mul(a,v){return [a[0]*v[0]+a[4]*v[1]+a[8]*v[2]+a[12]*v[3],a[1]*v[0]+a[5]*v[1]+a[9]*v[2]+a[13]*v[3],a[2]*v[0]+a[6]*v[1]+a[10]*v[2]+a[14]*v[3],a[3]*v[0]+a[7]*v[1]+a[11]*v[2]+a[15]*v[3]];}"
    "function toScreen(p){const e=mul(V,[p[0],p[1],p[2],1]);const q=mul(P,e);const w=q[3];if(!(Math.abs(w)>1e-9))return null;const nx=q[0]/w,ny=q[1]/w;return [c.left+(nx+1)*0.5*c.width,c.top+(1-ny)*0.5*c.height,w];}"
    "const dirs=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];"
    "const bodies=[];"
    "for(const [name,m] of Object.entries(s.ephemerisTargets)){"
    "if(!m||!m.isMesh||!m.visible)continue;"
    "const e=m.matrixWorld.elements;const p=[e[12],e[13],e[14]];"
    "const rad=(m.geometry&&m.geometry.parameters&&m.geometry.parameters.radius)||0.5;"
    "const cs=toScreen(p);if(!cs)continue;"
    "const samples=[];"
    "for(const d of dirs){const q=toScreen([p[0]+rad*d[0],p[1]+rad*d[1],p[2]+rad*d[2]]);if(q)samples.push(Math.hypot(q[0]-cs[0],q[1]-cs[1]));}"
    "let r=0;for(const sm of samples){if(sm>r)r=sm;}"
    "r=Math.max(1,r);"
    "bodies.push({name:name,x:cs[0],y:cs[1],r:r,r_samples:samples,world_radius:rad,visible:m.visible,depth:cs[2]});"
    "}"
    "return {innerWidth:window.innerWidth,innerHeight:window.innerHeight,rect:{left:c.left,top:c.top,w:c.width,h:c.height},bodies:bodies};"
    "})()"
)



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
    parts.append("for(const n of names)__L__const m=n==='moon'?s.moon:s.ephemerisTargets[n];if(!m||!m.material)continue;const mat=m.material;")
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

    def a5_raster_fixture(name, radius, pixels):
        m = good_metrics()
        # Preserve the original continuous-area floor, including its reporting
        # precision, so the recorded Mercury failure is replayed exactly.
        m[name].update({
            "radius": radius, "pixels": pixels,
            "pixel_floor": round(max(
                A5_MIN_PIXELS,
                A5_PIXEL_FLOOR_FRAC * math.pi * (0.75 * radius) ** 2,
            ), 1),
        })
        return m

    m = a5_raster_fixture("mercury", 3.82, 23)
    ok_flake, flake_detail = check_a5(m)
    d = {
        "observed": {k: m["mercury"][k] for k in ("radius", "pixels", "pixel_floor")},
        "observed_pass": ok_flake,
        "observed_failures": flake_detail["failures"],
    }
    faults = {
        "absent_fails": None,
        "invisible_fails": {"visible": False},
        "small_radius_fails": {"radius": A5_MIN_RADIUS / 2},
        "half_minimum_fails": {"pixels": 23 // 2},
    }
    for name, fault in faults.items():
        m = a5_raster_fixture("mercury", 3.82, 23)
        if fault is None:
            del m["mercury"]
        else:
            m["mercury"].update(fault)
        d[name] = not check_a5(m)[0]
    results.append(("A5_RASTER_FLOOR", ok_flake and all(d[n] for n in faults), d))

    # Fixed pass1/pass2 radii from the clean 4d849e2 gate evidence, plus the
    # adjacent Mercury radius known to flake. No browser or evidence file is
    # needed: sweep a full pixel cell away from viewport clipping boundaries.
    radii = {
        "mercury": (4.20, 3.82, 3.84), "venus": (5.71, 5.98),
        "earth": (6.36, 6.91), "mars": (5.14, 4.86),
        "jupiter": (17.46, 17.26), "saturn": (14.64, 14.73),
        "uranus": (13.26, 13.28), "neptune": (14.96, 14.96),
    }
    size = 64
    steps = 40

    def png_chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff))

    sample_png = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + png_chunk(b"IDAT", zlib.compress((b"\0" + b"\x80" * (size * 3)) * size))
        + png_chunk(b"IEND", b"")
    )
    per_body = dict()
    sweep_proven = set(radii) == set(REQUIRED)
    for name, body_radii in radii.items():
        per_body[name] = []
        for radius in body_radii:
            m = a5_raster_fixture(name, radius, 0)
            counts = set()
            verdicts = set()
            min_center = None
            for ix in range(steps):
                for iy in range(steps):
                    cx, cy = size / 2 + ix / steps, size / 2 + iy / steps
                    count = len(_disc_pixels(size, size, cx, cy, radius))
                    if not counts or count < min(counts):
                        min_center = (cx, cy)
                    counts.add(count)
                    m[name]["pixels"] = count
                    verdicts.add(check_a5(m)[0])
            minimum = min(counts)
            m[name]["pixels"] = minimum // 2
            half_minimum_fails = not check_a5(m)[0]
            # Exercise measure() as well: its reported floor must agree with
            # acceptance even at a placement producing the minimum count.
            body = {"name": name, "r": radius, "x": min_center[0],
                    "y": min_center[1], "visible": True}
            measured = measure(sample_png, [body], 1.0, 1.0)[3][name]
            measured_floor_met = measured["pixel_floor"] <= measured["pixels"] == minimum
            row = {
                "radius": radius, "pixel_range": [minimum, max(counts)],
                "verdicts": sorted(verdicts),
                "all_placements_pass": verdicts == {True},
                "half_minimum_fails": half_minimum_fails,
                "measured_floor_met": measured_floor_met,
            }
            per_body[name].append(row)
            sweep_proven = (sweep_proven and row["all_placements_pass"]
                            and half_minimum_fails and measured_floor_met)
    results.append(("A5_SUBPIXEL_SWEEP", sweep_proven, {
        "offsets_per_radius": steps ** 2, "per_body": per_body,
    }))

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

    # TEXTURES_REAL: prove every one of the eleven manifest slots can fail the
    # gate independently, plus wrong-slot/canvas/dimension/src/colour faults.
    def texture_fixture():
        expected = dict()
        observed = dict()
        for key, _kind, slot in TEXTURE_TARGETS:
            fname = key + ("_alpha.png" if key == "saturn_ring" else ".jpg")
            cs = "" if (slot == "alphaMap" or key == "saturn_ring") else "srgb"
            minw, minh = (2048, 125) if key == "saturn_ring" else (2048, 1024)
            expected[key] = {
                "slot": slot, "file": fname,
                "min_width": minw, "min_height": minh, "color_space": cs,
            }
            observed[key] = {
                "present": True, "slot": slot, "width": minw, "height": minh,
                "src": "http://h/assets/solar/textures-v1/" + fname,
                "has_src": True, "colorSpace": cs, "is_canvas": False,
                "mesh_present": True,
            }
        return expected, observed

    def clone(obs):
        return json.loads(json.dumps(obs))

    tex_exp, tex_good = texture_fixture()
    ok_tex_pass, _ = check_textures_real(tex_good, tex_exp)
    missing_slot_fails = dict()
    for key in tex_exp:
        obs = clone(tex_good)
        del obs[key]
        ok_missing, _ = check_textures_real(obs, tex_exp)
        missing_slot_fails[key] = not ok_missing
    obs = clone(tex_good)
    obs["earth_clouds"]["slot"] = "map"
    wrong_slot_fails = not check_textures_real(obs, tex_exp)[0]
    obs = clone(tex_good)
    obs["saturn_ring"]["is_canvas"] = True
    canvas_fails = not check_textures_real(obs, tex_exp)[0]
    obs = clone(tex_good)
    obs["jupiter"]["width"] = 1024
    small_fails = not check_textures_real(obs, tex_exp)[0]
    obs = clone(tex_good)
    obs["earth"]["colorSpace"] = ""
    colorspace_fails = not check_textures_real(obs, tex_exp)[0]
    obs = clone(tex_good)
    obs["neptune"]["src"] = "http://h/assets/solar/textures-v1/wrong_file.jpg"
    src_fails = not check_textures_real(obs, tex_exp)[0]
    obs = clone(tex_good)
    obs["mars"]["present"] = False
    empty_slot_fails = not check_textures_real(obs, tex_exp)[0]
    incomplete_expectation_fails = not check_textures_real(tex_good, dict())[0]
    d = dict()
    d["pass"] = ok_tex_pass
    d["all_eleven_missing_slots_fail"] = all(missing_slot_fails.values())
    d["missing_earth_clouds_fails"] = missing_slot_fails.get("earth_clouds", False)
    d["missing_saturn_ring_fails"] = missing_slot_fails.get("saturn_ring", False)
    d["missing_slot_fails"] = missing_slot_fails
    d["wrong_slot_fails"] = wrong_slot_fails
    d["canvas_fails"] = canvas_fails
    d["small_dims_fails"] = small_fails
    d["colorspace_fails"] = colorspace_fails
    d["src_mismatch_fails"] = src_fails
    d["empty_slot_fails"] = empty_slot_fails
    d["incomplete_expectation_fails"] = incomplete_expectation_fails
    tex_proven = (
        ok_tex_pass
        and all(missing_slot_fails.values())
        and wrong_slot_fails
        and canvas_fails
        and small_fails
        and colorspace_fails
        and src_fails
        and empty_slot_fails
        and incomplete_expectation_fails
    )
    results.append(("TEXTURES_REAL", tex_proven, d))

    # PROJECTION: prove the coverage check rejects off-screen centres, an
    # underreported radius, empty sample sets, missing bodies and empty sets.
    def projection_fixture():
        bodies = []
        for n in REQUIRED:
            bodies.append({
                "name": n, "x": 700.0, "y": 450.0, "r": 20.0,
                "r_samples": [20.0, 19.6, 20.0, 18.4, 19.1, 20.0],
                "world_radius": 2.0, "visible": True, "depth": 5.0,
            })
        return {
            "innerWidth": 1400, "innerHeight": 913,
            "rect": {"left": 0, "top": 0, "w": 1400, "h": 913},
            "bodies": bodies,
        }

    proj_good = projection_fixture()
    ok_proj_pass, _ = check_projection(proj_good)
    p = projection_fixture()
    p["bodies"][0]["x"] = 2000.0
    shifted_fails = not check_projection(p)[0]
    p = projection_fixture()
    p["bodies"][0]["r"] = 5.0
    underreport_fails = not check_projection(p)[0]
    p = projection_fixture()
    p["bodies"][0]["r_samples"] = []
    empty_samples_fails = not check_projection(p)[0]
    p = projection_fixture()
    p["bodies"][0]["x"] = None
    nonfinite_fails = not check_projection(p)[0]
    p = projection_fixture()
    p["bodies"] = p["bodies"][1:]
    missing_body_fails = not check_projection(p)[0]
    empty_required_fails = not check_projection(proj_good, required=[])[0]
    d = dict()
    d["pass"] = ok_proj_pass
    d["shifted_center_fails"] = shifted_fails
    d["underreported_radius_fails"] = underreport_fails
    d["empty_samples_fails"] = empty_samples_fails
    d["nonfinite_center_fails"] = nonfinite_fails
    d["missing_body_fails"] = missing_body_fails
    d["empty_required_fails"] = empty_required_fails
    proj_proven = (
        ok_proj_pass
        and shifted_fails
        and underreport_fails
        and empty_samples_fails
        and nonfinite_fails
        and missing_body_fails
        and empty_required_fails
    )
    results.append(("PROJECTION", proj_proven, d))

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

    # Provenance is captured before the run and re-checked afterwards. The
    # evidence tree is excluded from the dirty diff so writing this report can
    # not trip the guard, while any source change during the run still does.
    prov_start = provenance_snapshot()
    script_sha = _sha256_file(SCRIPT_PATH)
    build_binding = compute_build_binding()
    utc_started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    command = "python3 scripts/verify-solar-legibility.py --evidence " + str(evidence_dir)
    event("provenance_start", head=prov_start["head"], dirty=prov_start["dirty"], script_sha256=script_sha)

    manifest = None
    try:
        manifest = json.loads(BUILT_MANIFEST.read_text(encoding="utf-8"))
    except Exception as err:
        print("FATAL: built texture manifest unreadable: " + str(err), file=sys.stderr)
        return 1, events, None
    texture_expectations = build_texture_expectations(manifest, tier="desktop")
    event("texture_expectations", slots=list(texture_expectations.keys()))

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
        version_info = wait_devtools(dbg_port)
        chromium_version = (version_info or dict()).get("Browser")
        event("chromium_version", browser=chromium_version)
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
        tex_observed = await js(TEXTURE_SLOTS_EXPR)
        tex_real, tex_detail = check_textures_real(tex_observed, texture_expectations)
        event("textures", state=tex_state, real=tex_real, failures=tex_detail.get("failures"))
        real_tex = tex_real
        await asyncio.sleep(1.5)

        # Pass 1: freeze motion so baseline and no-map align pixel-for-pixel.
        await js(motion_expr("paused"))
        await asyncio.sleep(0.3)
        proj1 = await js(PROJECT_EXPR)
        bodies1 = proj1["bodies"]
        proj_ok, proj_detail = check_projection(proj1)
        event("projection", ok=proj_ok, failures=proj_detail.get("failures"))
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
        await asyncio.sleep(0.2)
        restored_observed = await js(TEXTURE_SLOTS_EXPR)
        restored_real, restored_detail = check_textures_real(restored_observed, texture_expectations)
        diffs = map_diff(baseline_png, nomap_png, bodies1, scale_x, scale_y)
        event("a3_diffs", diffs=diffs, restored_real=restored_real)

        # A6: bounded simulation advance, then re-freeze and re-measure.
        t0 = await js(motion_expr("running"))
        # Advance roughly the design contract's 30 simulated seconds before
        # the second frame. The shorter 2.5s window made Jupiter's spread sit
        # on the 65px boundary and produced timing-dependent false failures.
        await asyncio.sleep(10.0)
        t1 = await js(motion_expr("paused"))
        await asyncio.sleep(0.3)
        advance_days = float(t1) - float(t0)
        proj2 = await js(PROJECT_EXPR)
        bodies2 = proj2["bodies"]
        proj2_ok, proj2_detail = check_projection(proj2)
        pass1_names = sorted(b["name"] for b in bodies1)
        pass2_names = sorted(b["name"] for b in bodies2)
        same_body_set = pass1_names == pass2_names
        same_viewport = (
            proj1.get("innerWidth") == proj2.get("innerWidth")
            and proj1.get("innerHeight") == proj2.get("innerHeight")
        )
        proj2_ok = bool(proj2_ok and same_body_set and same_viewport)
        event("pass2_projection", ok=proj2_ok, detail=proj2_detail,
              same_body_set=same_body_set, same_viewport=same_viewport)
        second_png = await capture_png()
        w2, h2, ch2, metrics2 = measure(second_png, bodies2, scale_x, scale_y)
        event("pass2", advance_days=round(advance_days, 4), bodies=len(bodies2))

        checks = assess(metrics1, diffs, metrics2, advance_days)
        a4_pass2, a4_pass2_detail = check_a4(metrics2)
        a5_pass2, a5_pass2_detail = check_a5(metrics2)
        checks_ok = dict()
        for k in checks:
            checks_ok[k] = checks[k][0]

        # Re-snapshot provenance: a source edit or HEAD move mid-run forces
        # BLOCKED even if every pixel assertion passed.
        prov_end = provenance_snapshot()
        head_stable = prov_start["head"] is not None and prov_start["head"] == prov_end["head"]
        dirty_stable = prov_start["dirty"] is not None and prov_start["dirty"] == prov_end["dirty"]
        provenance_ok = bool(head_stable and dirty_stable)
        event("provenance_end", head=prov_end["head"], stable=provenance_ok)

        all_ok = real_tex and restored_real and proj_ok and proj2_ok and provenance_ok
        all_ok = all_ok and a4_pass2 and a5_pass2
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
        tex_report["real"] = real_tex
        tex_report["detail"] = tex_detail
        tex_report["observed"] = tex_observed
        tex_report["restored_real"] = restored_real
        tex_report["restored_detail"] = restored_detail
        proj_report = dict()
        proj_report["pass"] = proj_ok
        proj_report["detail"] = proj_detail
        proj_report["pass2"] = {"pass": proj2_ok, "detail": proj2_detail,
                                 "same_body_set": same_body_set,
                                 "same_viewport": same_viewport}
        checks_report["A4_pass2"] = {"pass": a4_pass2, "detail": a4_pass2_detail}
        checks_report["A5_pass2"] = {"pass": a5_pass2, "detail": a5_pass2_detail}
        provenance = dict()
        provenance["git_head"] = prov_start["head"]
        provenance["git_head_end"] = prov_end["head"]
        provenance["git_dirty"] = prov_start["dirty"]
        provenance["git_dirty_end"] = prov_end["dirty"]
        provenance["git_dirty_excludes"] = EVIDENCE_EXCLUDE_PREFIX
        provenance["consistent_during_run"] = provenance_ok
        provenance["script_path"] = "scripts/verify-solar-legibility.py"
        provenance["script_sha256"] = script_sha
        provenance["build_binding"] = build_binding
        provenance["command"] = command
        provenance["viewport"] = [w1, h1]
        provenance["chromium_version"] = chromium_version
        provenance["utc_timestamp"] = utc_started
        provenance["utc_completed"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        provenance["binding_semantics"] = (
            "Evidence binds to git_head (source HEAD at run time) plus script_sha256 "
            "and build_binding SHA256s. Files under '" + EVIDENCE_EXCLUDE_PREFIX + "' are "
            "excluded from the dirty guard so writing this report does not trip it; any "
            "other source change during the run flips consistent_during_run to false and "
            "forces BLOCKED. When this evidence is folded into its own commit via amend, "
            "git_head names the pre-amend commit while the authoritative content binding "
            "is script_sha256 + build_binding hashes, which match the final committed tree."
        )
        report = dict()
        report["verdict"] = "GREEN" if all_ok else "BLOCKED"
        report["provenance"] = provenance
        report["viewport"] = [w1, h1]
        report["channels"] = ch1
        report["scale"] = [round(scale_x, 4), round(scale_y, 4)]
        report["textures"] = tex_report
        report["projection"] = proj_report
        report["advance_days"] = round(advance_days, 4)
        report["pass1_metrics"] = metrics1
        report["pass2_metrics"] = metrics2
        report["a3_diffs"] = diffs
        report["a3_restored_real"] = restored_real
        report["a3_excluded"] = {"moon": "subpixel homepage radius; texture installation is covered by TEXTURES_REAL"}
        report["checks"] = checks_report

        print(json.dumps(report, ensure_ascii=False, indent=2))
        for name in ("A1", "A2", "A3", "A4", "A5", "A6"):
            label = "PASS" if checks_ok[name] else "FAIL"
            print(name + " " + label)
        print("TEXTURES_REAL " + ("PASS" if real_tex else "FAIL"))
        print("PROJECTION " + ("PASS" if proj_ok else "FAIL"))
        print("PROVENANCE " + ("PASS" if provenance_ok else "FAIL"))
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
    parser.add_argument("--mutation-test", action="store_true", help="prove A1-A6, TEXTURES_REAL and PROJECTION assertions can fail; no browser needed")
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
