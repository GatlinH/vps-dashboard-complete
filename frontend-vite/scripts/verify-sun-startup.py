import argparse
import base64
import contextlib
import functools
import hashlib
import importlib.util
import io
import json
import math
import os
import select
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import unittest
import urllib.request
import zlib
from array import array
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


METHOD = 'actual-production-sun-native-linear-v1'
COMPLETENESS = 'SUN_NATIVE_PIXEL_COMPLETENESS'
ROI_COMPLETENESS = 'SUN_NATIVE_ROI_COMPLETENESS'
LIMB = 'SUN_NATIVE_LIMB_RATIO'
GRANULATION = 'SUN_NATIVE_GRANULATION'
BODY = 'SUN_NATIVE_BODY_CONTRIBUTION'
BACKGROUND = 'SUN_NATIVE_BACKGROUND_CONTRIBUTION'
GLOW_WIDTH = 'SUN_NATIVE_GLOW_FULLWIDTH'
GLOW_PEAK = 'SUN_NATIVE_GLOW_PEAK'
COMPILE = 'SUN_NATIVE_GPU_COMPILE'
GL_ERROR = 'SUN_NATIVE_GL_ERROR'
NATIVE_PYTHON = '/root/.hermes/cache/scratch/solar-rt-browser-20261029-venv/bin/python'
BROWSERS = '/root/.hermes/cache/scratch/solar-rt-browser-20261029-browsers'
FRONTEND = Path(__file__).resolve().parents[1]
REPOSITORY = FRONTEND.parent
NEGATIVE_PREFIXES = {
    'noise0': [GRANULATION],
    'limb0': [LIMB],
    'flat': [LIMB, GRANULATION],
    'hidden': [BODY],
    'glow28': [GLOW_WIDTH],
    'glowBackground': [BACKGROUND],
    'missing': [COMPLETENESS],
    'empty': [COMPLETENESS],
    'short': [COMPLETENESS],
}


class GateFailure(AssertionError):
    def __init__(self, prefix, metrics=None, detail=''):
        self.prefix = prefix
        self.metrics = metrics
        self.detail = detail
        super().__init__(f'{prefix}: {detail}; metrics={json.dumps(metrics, allow_nan=False)}')


def guard(condition, prefix, metrics=None, detail='', removed=frozenset()):
    if prefix not in removed and not condition:
        raise GateFailure(prefix, metrics, detail)


def finite(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


def validate_complete(metadata, pixels, removed=frozenset()):
    width, height = metadata.get('width'), metadata.get('height')
    valid_shape = type(width) is int and type(height) is int and width > 0 and height > 0
    expected = width * height * 4 if valid_shape else None
    actual = len(pixels) if isinstance(pixels, (bytes, bytearray, memoryview)) else None
    metrics = {'width': width, 'height': height, 'expectedBytes': expected, 'actualBytes': actual}
    guard(valid_shape and actual is not None and actual > 0 and actual == expected,
          COMPLETENESS, metrics, 'missing, empty or incomplete actual RGBA readback', removed)
    return metrics


def validate_program(program):
    diagnostics = program.get('diagnostics') if isinstance(program, dict) else None
    valid = isinstance(program, dict) and program.get('present') is True
    valid = valid and all(program.get(key) is True for key in
                          ('linkStatus', 'vertexCompileStatus', 'fragmentCompileStatus'))
    valid = valid and not (isinstance(diagnostics, dict) and diagnostics.get('runnable') is False)
    guard(valid, COMPILE, program, 'actual production material currentProgram must be runnable')


def validate_gl(checks):
    guard(bool(checks) and all(check.get('calls') and check['calls'][-1] == 0
                              and not check.get('errors') and not check.get('contextLost') for check in checks),
          GL_ERROR, checks, 'actual GL error checks, including readback, must finish at NO_ERROR')


def validate_capture(frame, binding):
    metadata = frame['metadata']
    validate_complete(metadata, frame['pixels'])
    validate_program(metadata.get('program'))
    validate_gl(metadata.get('glChecks', []))
    guard(not metadata.get('exceptions') and metadata.get('framebufferComplete') is True,
          'SUN_NATIVE_RENDER_READBACK', metadata.get('exceptions'), 'render/read framebuffer failure')
    source = metadata.get('source', {})
    actual = binding['binding']
    guard(all(source.get(key) is True for key in ('actualHomepageInstance', 'sameRenderer', 'sameMaterial', 'sameGeometry'))
          and all(source.get(key) == actual.get(key) for key in ('sunUuid', 'materialUuid', 'geometryUuid')),
          'SUN_NATIVE_SOURCE_BINDING', source, 'another renderer, material, Sun or geometry is not acceptance')
    guard(metadata.get('method') == METHOD and metadata.get('rowOrder') == 'bottom-left',
          'SUN_NATIVE_METHOD', {'method': metadata.get('method'), 'rowOrder': metadata.get('rowOrder')})
    guard(metadata.get('scientific') == binding['originalScientific'], 'SUN_NATIVE_FROZEN_EPOCH',
          metadata.get('scientific'), 'paired captures must consume the identical actual epoch and transforms')
    world_matrix = metadata.get('pose', {}).get('worldMatrix', [])
    original_matrix = actual.get('matrixWorld', [])
    guard(len(world_matrix) == len(original_matrix) == 16
          and all(finite(value) and abs(value - original) <= 64 * math.ulp(max(1, abs(value), abs(original)))
                  for value, original in zip(world_matrix, original_matrix)),
          'SUN_NATIVE_ORIGINAL_POSE', metadata.get('pose'), 'only Float64 transform arithmetic tolerance; never phase selection')
    guard(metadata.get('frameAfter', 0) > metadata.get('frameBefore', 0),
          'SUN_NATIVE_ACTUAL_RENDER', {'before': metadata.get('frameBefore'), 'after': metadata.get('frameAfter')})
    if metadata['control'] != 'hidden':
        draw = metadata.get('sunDraw') or {}
        guard(all(draw.get(key) is True for key in ('actualRenderer', 'actualSun', 'actualGeometry',
                                                   'actualMaterial', 'glCurrentProgramIsMaterial')),
              'SUN_NATIVE_ACTUAL_SUN_DRAW', draw, 'actual mesh draw must bind its actual material program')
    if metadata['kind'] == 'isolated-linear':
        target = metadata.get('target') or {}
        guard(metadata['width'] == metadata['height'] == 1024 and metadata.get('colorSpace') == 'srgb-linear'
              and target.get('samples') == 0 and target.get('type') == 1009 and target.get('format') == 1023
              and target.get('internalFormat') == 'RGBA8' and target.get('colorSpace') == 'srgb-linear'
              and metadata['mapping'].get('radiusPixels') == 128 and metadata['mapping'].get('halfExtentR') == 4,
              'SUN_NATIVE_LINEAR_TARGET', target, '1024 square RGBA8 linear non-MSAA target required')
    guard(metadata.get('colorSpace') in ('srgb-linear', 'srgb'), 'SUN_NATIVE_COLORSPACE', metadata.get('colorSpace'))
    return True


def luminance(frame):
    if 'luminance' not in frame:
        metadata, pixels = frame['metadata'], frame['pixels']
        validate_complete(metadata, pixels)
        table = [channel / 255 for channel in range(256)]
        if metadata['colorSpace'] == 'srgb':
            table = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in table]
        else:
            guard(metadata['colorSpace'] == 'srgb-linear', 'SUN_NATIVE_COLORSPACE', metadata['colorSpace'])
        frame['luminance'] = array('d', (0.2126 * table[pixels[offset]] + 0.7152 * table[pixels[offset + 1]]
                                       + 0.0722 * table[pixels[offset + 2]] for offset in range(0, len(pixels), 4)))
    return frame['luminance']


def roi_indices(metadata, lower=0, upper=math.inf):
    width, height = metadata['width'], metadata['height']
    center_x, center_y = metadata['mapping']['centerPixels']
    radius = metadata['mapping']['radiusPixels']
    guard(finite(radius) and radius > 0 and finite(center_x) and finite(center_y),
          ROI_COMPLETENESS, metadata['mapping'], 'actual nonzero projected radius required')
    extent = radius * upper
    left = max(0, math.floor(center_x - extent)) if math.isfinite(extent) else 0
    right = min(width, math.ceil(center_x + extent)) if math.isfinite(extent) else width
    bottom = max(0, math.floor(center_y - extent)) if math.isfinite(extent) else 0
    top = min(height, math.ceil(center_y + extent)) if math.isfinite(extent) else height
    for vertical in range(bottom, top):
        for horizontal in range(left, right):
            normalized = math.hypot(horizontal + 0.5 - center_x, vertical + 0.5 - center_y) / radius
            if lower <= normalized <= upper:
                yield vertical * width + horizontal, normalized


def summarize(values):
    count, mean, second, total_abs, maximum = 0, 0.0, 0.0, 0.0, 0.0
    for value in values:
        count += 1
        delta = value - mean
        mean += delta / count
        second += delta * (value - mean)
        total_abs += abs(value)
        maximum = max(maximum, abs(value))
    return {'count': count, 'mean': mean if count else None, 'meanAbs': total_abs / count if count else None,
            'stdDev': math.sqrt(max(0, second / count)) if count else None, 'maxAbs': maximum if count else None}


def limb_stats(frame):
    values = luminance(frame)
    center = summarize(values[index] for index, _ in roi_indices(frame['metadata'], 0, 0.02))
    annulus = summarize(values[index] for index, _ in roi_indices(frame['metadata'], 0.845, 0.855))
    ratio = annulus['mean'] / center['mean'] if center['count'] and annulus['count'] and center['mean'] > 0 else None
    return {'method': METHOD, 'center': center, 'annulus': annulus, 'ratio': ratio,
            'lower': 0.666, 'upper': 0.766,
            'margins': {'lower': ratio - 0.666 if ratio is not None else None,
                        'upper': 0.766 - ratio if ratio is not None else None}}


def difference_stats(left, right, lower=0, upper=math.inf, normalization=1):
    left_meta, right_meta = left['metadata'], right['metadata']
    guard(all(left_meta[key] == right_meta[key] for key in ('width', 'height', 'colorSpace'))
          and left_meta['mapping']['centerPixels'] == right_meta['mapping']['centerPixels']
          and left_meta['mapping']['radiusPixels'] == right_meta['mapping']['radiusPixels'],
          'SUN_NATIVE_MATCHED_PAIR', {'left': left_meta['captureId'], 'right': right_meta['captureId']})
    left_luma, right_luma = luminance(left), luminance(right)
    changed, support = 0, 0.0

    def differences():
        nonlocal changed, support
        for index, normalized in roi_indices(left_meta, lower, upper):
            offset = index * 4
            if any(left['pixels'][offset + channel] != right['pixels'][offset + channel] for channel in range(3)):
                changed += 1
                support = max(support, normalized)
            yield (left_luma[index] - right_luma[index]) / normalization

    stats = summarize(differences())
    stats.update({'changedPixels': changed, 'supportRadiusR': support, 'normalization': normalization,
                  'roi': {'lowerR': lower, 'upperR': upper if math.isfinite(upper) else 'canvas-boundary'},
                  'source': {'left': left_meta['captureId'], 'right': right_meta['captureId'],
                             'materialUuid': left_meta['source']['materialUuid']}})
    return stats


def validate_limb_stats(stats, removed=frozenset()):
    guard(stats['center']['count'] > 0 and stats['annulus']['count'] > 0 and finite(stats['ratio']),
          ROI_COMPLETENESS, stats, 'center and annulus must both contain actual pixels', removed)
    guard(finite(stats['ratio']) and 0.666 <= stats['ratio'] <= 0.766, LIMB, stats,
          'production limb function only; no gamma or maximum normalization', removed)


def validate_granule_stats(stats, removed=frozenset()):
    guard(stats['count'] > 0 and finite(stats['stdDev']), ROI_COMPLETENESS, stats, removed=removed)
    guard(finite(stats['stdDev']) and stats['stdDev'] >= 0.035, GRANULATION, stats,
          'StdDev((Lproduction - Lnoise0) / 0.8) at r <= 0.3R, original pose', removed)


def validate_body_stats(stats, removed=frozenset()):
    guard(stats['count'] > 0 and finite(stats['maxAbs']), ROI_COMPLETENESS, stats, removed=removed)
    guard(stats['changedPixels'] > 0 and stats['maxAbs'] > 0, BODY, stats,
          'matched actual Sun-on/off body pixels, not scene visibility flags', removed)


def validate_background_stats(stats, removed=frozenset()):
    guard(stats['count'] > 0 and finite(stats['maxAbs']), ROI_COMPLETENESS, stats, removed=removed)
    guard(finite(stats['maxAbs']) and stats['maxAbs'] < 0.03, BACKGROUND, stats,
          'matched Sun contribution outside 2.8R, not raw starfield luminance', removed)


def validate_glow_stats(stats, glows):
    guard(bool(glows) and all(len(sprite.get('scale', [])) == 3 and abs(sprite['scale'][0] - 9) <= 1e-9
                             and abs(sprite['scale'][1] - 9) <= 1e-9 for sprite in glows),
          GLOW_WIDTH, glows, 'actual production sprite fullwidth must remain 9')
    guard(stats['count'] > 0 and finite(stats['maxAbs']), ROI_COMPLETENESS, stats)
    guard(stats['maxAbs'] <= 0.18 and all(finite(sprite.get('opacity')) and sprite['opacity'] <= 0.18 for sprite in glows),
          GLOW_PEAK, {'actualContribution': stats, 'actualSprites': glows}, 'measured peak and actual opacity <= 0.18')


def validate_background_fault(stats, glow_stats, glows, removed=frozenset()):
    validate_glow_stats(glow_stats, glows)
    validate_background_stats(stats, removed)


def expected_rejection(action, expected_prefix):
    try:
        action()
    except GateFailure as failure:
        return {'status': 'KILLED' if failure.prefix == expected_prefix else 'WRONG_PREFIX',
                'expectedPrefix': expected_prefix, 'actualPrefix': failure.prefix, 'metrics': failure.metrics}
    return {'status': 'INERT', 'expectedPrefix': expected_prefix, 'actualPrefix': None}


def reverse_guard(action, own_prefix, unrelated_prefix):
    protected = expected_rejection(lambda: action(frozenset()), own_prefix)
    unrelated = expected_rejection(lambda: action(frozenset({unrelated_prefix})), own_prefix)
    own_removed = expected_rejection(lambda: action(frozenset({own_prefix})), own_prefix)
    return {'ownPrefix': own_prefix, 'guardPresent': protected, 'unrelatedRemoved': unrelated,
            'ownRemoved': own_removed,
            'ok': protected['status'] == unrelated['status'] == 'KILLED' and own_removed['status'] == 'INERT'}


class Evidence:
    def __init__(self, output):
        self.output = output
        output.mkdir(parents=True, exist_ok=True)
        self.write_json('native-session.json', {'pid': os.getpid(), 'argv': sys.argv, 'wallStart': time.time()})

    def write_bytes(self, name, data):
        with (self.output / name).open('xb') as stream:
            stream.write(data)

    def write_json(self, name, data):
        self.write_bytes(name, (json.dumps(data, indent=2, ensure_ascii=False, allow_nan=False) + '\n').encode())

    def event(self, kind, data):
        with (self.output / 'native-events.jsonl').open('a', encoding='utf-8') as stream:
            stream.write(json.dumps({'kind': kind, 'wall': time.time(), 'data': data}, ensure_ascii=False, allow_nan=False) + '\n')


def png_bytes(metadata, pixels):
    validate_complete(metadata, pixels)
    width, height = metadata['width'], metadata['height']

    def chunk(kind, payload):
        return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload) & 0xffffffff)

    stride = width * 4
    rows = b''.join(b'\x00' + pixels[vertical * stride:(vertical + 1) * stride] for vertical in range(height - 1, -1, -1))
    color = chunk(b'gAMA', struct.pack('>I', 100000)) if metadata['colorSpace'] == 'srgb-linear' else chunk(b'sRGB', b'\x00')
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
            + color + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def persist_capture(evidence, name, metadata):
    encoded = metadata.pop('rgbaBase64', None)
    pixels = None
    decode_error = None
    if encoded is not None:
        try:
            pixels = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as error:
            decode_error = str(error)
    artifacts = {'metadata': name + '.json', 'rgba': None, 'png': None, 'decodeError': decode_error}
    if pixels is not None:
        artifacts.update({'rgba': name + '.rgba', 'sha256': hashlib.sha256(pixels).hexdigest(), 'actualBytes': len(pixels)})
        evidence.write_bytes(artifacts['rgba'], pixels)
        try:
            encoded_png = png_bytes(metadata, pixels)
        except GateFailure:
            encoded_png = None
        if encoded_png is not None:
            artifacts['png'] = name + '-raw.png'
            evidence.write_bytes(artifacts['png'], encoded_png)
    metadata['artifacts'] = artifacts
    evidence.write_json(artifacts['metadata'], metadata)
    evidence.event('actual-capture', {'name': name, 'artifacts': artifacts, 'runnerStatus': 'CAPTURED_NOT_YET_VALIDATED'})
    return {'metadata': metadata, 'pixels': pixels}


def checked(evidence, label, action, metrics=None):
    try:
        result = action()
    except GateFailure as failure:
        evidence.event('validation', {'label': label, 'status': 'FAIL', 'prefix': failure.prefix, 'metrics': failure.metrics})
        raise
    evidence.event('validation', {'label': label, 'status': 'PASS', 'metrics': metrics})
    return result


def healthy_metrics(frames):
    profile = limb_stats(frames['limb'])
    granule = difference_stats(frames['productionBody'], frames['noise0Body'], 0, 0.3, 0.8)
    granule['margin'] = granule['stdDev'] - 0.035 if granule['stdDev'] is not None else None
    body = difference_stats(frames['productionBody'], frames['hidden'], 0, 1)
    background = difference_stats(frames['productionGlow'], frames['hidden'], 2.8)
    background['margin'] = 0.03 - background['maxAbs'] if background['maxAbs'] is not None else None
    glow = difference_stats(frames['productionGlow'], frames['productionBody'])
    glow['margin'] = 0.18 - glow['maxAbs'] if glow['maxAbs'] is not None else None
    return {'limb': profile, 'granule': granule, 'body': body, 'background': background, 'glow': glow}


def home_metrics(frames):
    body = difference_stats(frames['homeBody'], frames['homeHidden'], 0, 0.95)
    noise = difference_stats(frames['homeProduction'], frames['homeNoise0'], 0, 0.3)
    limb = difference_stats(frames['homeProduction'], frames['homeLimb0'], 0.65, 0.95)
    flat = difference_stats(frames['homeProduction'], frames['homeFlat'], 0, 0.95)
    glow28 = difference_stats(frames['homeGlow28'], frames['homeProduction'])
    return {'body': body, 'noiseEffect': noise, 'limbEffect': limb, 'flatEffect': flat, 'glow28Response': glow28,
            'mapping': frames['homeProduction']['metadata']['mapping'],
            'observation': 'actual paused homepage GPU differences and real screenshots; not human aesthetic approval',
            'mobilePolicy': 'no .035 homepage granulation requirement and no imposed phone visibility envelope'}


def validate_home(stats, mobile):
    validate_body_stats(stats['body'])
    for name, prefix in (('noiseEffect', 'SUN_NATIVE_HOME_NOISE_EFFECT'), ('limbEffect', 'SUN_NATIVE_HOME_LIMB_EFFECT'),
                         ('flatEffect', 'SUN_NATIVE_HOME_FLAT_EFFECT')):
        effect = stats[name]
        guard(effect['count'] > 0 and finite(effect['maxAbs']), ROI_COMPLETENESS, effect)
        guard(effect['changedPixels'] > 0 and effect['maxAbs'] > 0, prefix, effect, 'actual corresponding same-frame effect required')
    mapping = stats['mapping']
    expected_size = (390, 844) if mobile else (1280, 900)
    expected_device_dpr, expected_renderer_dpr = (3, 1.5) if mobile else (1, 1)
    viewport, rectangle = mapping['viewport'], mapping['canvasRect']
    guard((viewport['width'], viewport['height']) == expected_size and viewport['devicePixelRatio'] == expected_device_dpr
          and mapping['rendererDpr'] == expected_renderer_dpr,
          'SUN_NATIVE_HOME_VIEWPORT_DPR', mapping, 'fresh actual constructor tier and production DPR cap required')
    guard(rectangle['width'] > 0 and rectangle['height'] > 0
          and rectangle['x'] < expected_size[0] and rectangle['x'] + rectangle['width'] > 0
          and rectangle['y'] < expected_size[1] and rectangle['y'] + rectangle['height'] > 0,
          'SUN_NATIVE_HOME_CANVAS_RECT', mapping, 'actual canvas must intersect the native visible viewport')


def negative_results(frames):
    noise = difference_stats(frames['noise0Body'], frames['noise0Body'], 0, 0.3, 0.8)
    limb = limb_stats(frames['limb0Law'])
    flat_limb = limb_stats(frames['flatBody'])
    flat_noise = difference_stats(frames['flatBody'], frames['flatBody'], 0, 0.3, 0.8)
    hidden = difference_stats(frames['hidden'], frames['hidden'], 0, 1)
    glow28 = difference_stats(frames['glow28'], frames['hidden'], 2.8)
    glow_response = difference_stats(frames['glow28'], frames['productionGlow'])
    glow28_background = expected_rejection(lambda: validate_background_stats(glow28), BACKGROUND)
    background = difference_stats(frames['glowBackground'], frames['hidden'], 2.8)
    background_glow = difference_stats(frames['glowBackground'], frames['productionBody'])
    background_sprites = frames['glowBackground']['metadata']['glows']
    outcomes = {
        'noise0': [expected_rejection(lambda: validate_granule_stats(noise), GRANULATION)],
        'limb0': [expected_rejection(lambda: validate_limb_stats(limb), LIMB)],
        'flat': [expected_rejection(lambda: validate_limb_stats(flat_limb), LIMB),
                 expected_rejection(lambda: validate_granule_stats(flat_noise), GRANULATION)],
        'hidden': [expected_rejection(lambda: validate_body_stats(hidden), BODY)],
        'glow28': [expected_rejection(lambda: validate_glow_stats(
            difference_stats(frames['glow28'], frames['productionBody']), frames['glow28']['metadata']['glows']), GLOW_WIDTH)],
        'glowBackground': [expected_rejection(lambda: validate_background_fault(background, background_glow, background_sprites), BACKGROUND)],
    }
    good = frames['productionBody']
    for name, pixels in (('missing', None), ('empty', b''), ('short', good['pixels'][:-1])):
        outcomes[name] = [expected_rejection(lambda pixels=pixels: validate_complete(good['metadata'], pixels), COMPLETENESS)]
    reverse = {
        'flat': reverse_guard(lambda removed: validate_limb_stats(flat_limb, removed), LIMB, GRANULATION),
        'noise0': reverse_guard(lambda removed: validate_granule_stats(noise, removed), GRANULATION, LIMB),
        'empty': reverse_guard(lambda removed: validate_complete(good['metadata'], b'', removed), COMPLETENESS, LIMB),
        'glowBackground': reverse_guard(lambda removed: validate_background_fault(
            background, background_glow, background_sprites, removed), BACKGROUND, GLOW_WIDTH),
    }
    return {'expectedPrefixes': NEGATIVE_PREFIXES, 'outcomes': outcomes, 'reverseGuards': reverse,
            'glow28Actual': {'outside2_8R': glow28, 'responseToProduction': glow_response,
                             'fullwidthGuard': outcomes['glow28'][0], 'backgroundGuard': glow28_background,
                             'note': 'scale 28 violates fullwidth; its pixel background guard remains explicitly INERT'},
            'glowBackgroundActual': {'outside2_8R': background, 'glowContribution': background_glow,
                                     'actualSprites': background_sprites,
                                     'fault': 'actual child glow translated to 3.2R in camera plane; Sun pose, scale 9 and opacity .18 unchanged'},
            'ok': all(item['status'] == 'KILLED' for tests in outcomes.values() for item in tests)
                  and all(item['ok'] for item in reverse.values()) and glow28_background['status'] == 'INERT'}


def import_realtime():
    specification = importlib.util.spec_from_file_location('sun_native_realtime', FRONTEND / 'scripts/solar-realtime-browser.py')
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def compile_helper(evidence, report):
    command = [str(FRONTEND / 'node_modules/.bin/esbuild'),
               str(FRONTEND / 'test/helpers/sunNativeProbe.js'), '--bundle', '--platform=browser',
               '--format=iife', '--global-name=SunNativeTools', '--target=es2022', '--log-level=warning']
    process = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=FRONTEND, check=False)
    evidence.write_bytes('esbuild.stderr.log', process.stderr)
    status = {'command': command, 'returncode': process.returncode, 'stdoutBytes': len(process.stdout),
              'bundleSha256': hashlib.sha256(process.stdout).hexdigest(), 'writtenToDist': False,
              'bundleStorage': 'memory only; injected script removed before page closes'}
    report['commands'].append(status)
    evidence.event('command', status)
    guard(process.returncode == 0 and process.stdout, 'SUN_NATIVE_HELPER_BUNDLE', status)
    return process.stdout.decode()


def bound_snapshot_expression():
    return '''() => ({
      visibility: document.visibilityState,
      rendererFrame: window.__DBG__.solarSystem.renderer.info.render.frame,
      secureContext: window.isSecureContext,
      wall: window.__nativeWallNow(), perf: performance.now(),
      call: structuredClone(window.__boundFrameCall),
      toolbarText: document.querySelector('.time-control-panel')?.innerText,
      scripts: [...document.scripts].map(script => script.src).filter(Boolean)
    })'''


def run_widget(context, bundle, url, mobile, realtime, evidence, report):
    label = 'mobile' if mobile else 'desktop'
    page = context.new_page()
    session = None
    script = None
    probe_created = False
    observer_saved = False
    pending_failure = None
    frames = {}
    widget = {'isMobile': mobile, 'captures': {}, 'statuses': [], 'construction': 'actual built homepage after CDP device metrics; no test Sun constructor'}
    report['widgets'][label] = widget

    def capture(name, control, home=False, glow=False):
        method = 'captureHome' if home else 'captureIsolated'
        metadata = page.evaluate('([method, control, glow]) => window.__sunNativeProbe[method](control, glow)', [method, control, glow])
        if home:
            screenshot = f'{label}-{name}-screenshot.png'
            screenshot_bytes = page.screenshot()
            evidence.write_bytes(screenshot, screenshot_bytes)
            paused = page.evaluate('() => window.__sunNativeProbe.assertPaused()')
            guard(paused['scientific'] == metadata['scientific'], 'SUN_NATIVE_SCREENSHOT_SAME_SAMPLE', paused)
            metadata['screenshot'] = {'path': screenshot, 'sha256': hashlib.sha256(screenshot_bytes).hexdigest(),
                                      'bytes': len(screenshot_bytes), 'scientific': paused['scientific']}
            evidence.event('actual-home-screenshot', {'widget': label, 'capture': name, **metadata['screenshot']})
        frame = persist_capture(evidence, f'{label}-{name}', metadata)
        frames[name] = frame
        widget['captures'][name] = frame['metadata']['artifacts']['metadata']
        checked(evidence, f'{label}-{name}-actual-readback', lambda: validate_capture(frame, widget['binding']))
        widget['statuses'].append({'capture': name, 'status': 'ACTUAL_READBACK_VALIDATED'})
        return frame

    try:
        size = {'width': 390, 'height': 844} if mobile else {'width': 1280, 'height': 900}
        page.set_viewport_size(size)
        session = context.new_cdp_session(page)
        session.send('Emulation.setDeviceMetricsOverride', {**size, 'deviceScaleFactor': 3 if mobile else 1, 'mobile': mobile})
        page.on('console', lambda message: report['console_errors'].append({'widget': label, 'message': message.text})
                if message.type == 'error' else None)
        page.on('pageerror', lambda error: report['console_errors'].append({'widget': label, 'message': str(error)}))
        page.goto(url, wait_until='domcontentloaded', timeout=60000)
        page.bring_to_front()
        page.wait_for_function('window.__DBG__?.solarSystem?.renderer', timeout=60000)
        page.evaluate('async () => { await window.__DBG__.solarSystem.textureLoadPromise; }')
        page.evaluate('''() => {
          const solar = window.__DBG__.solarSystem;
          window.__sunObserverSaved = { advance: solar._advanceBodies,
            installed: solar.__frameObservationInstalled, bound: window.__boundFrameCall };
        }''')
        observer_saved = True
        page.evaluate(realtime.OBSERVER)
        page.wait_for_function('''() => {
          const solar = window.__DBG__?.solarSystem, call = window.__boundFrameCall;
          return document.visibilityState === 'visible' && call?.status?.status === 'ready'
            && Object.keys(call.status.targets).length === 10 && solar.renderer.info.render.frame > call.renderFrameBefore;
        }''', timeout=90000)
        script = page.add_script_tag(content='(function(){' + bundle + ';window.__sunNativeTools=SunNativeTools;})();')
        metadata = page.evaluate('''() => {
          window.__sunNativeProbe = window.__sunNativeTools.createSunNativeProbe();
          return window.__sunNativeProbe.metadata;
        }''')
        probe_created = True
        bound = page.evaluate(bound_snapshot_expression())
        widget['binding'] = metadata
        widget['actualBoundFrame'] = bound
        widget['bindingArtifact'] = f'{label}-binding.json'
        evidence.write_json(widget['bindingArtifact'], {'binding': metadata, 'actualBoundFrame': bound})
        realtime.validate_bound_frame(bound, 1)
        guard(bound['secureContext'] is False, 'SUN_NATIVE_ORDINARY_HTTP', bound['secureContext'])
        guard(metadata['originalScientific']['sample'] == bound['call']['sample'],
              'SUN_NATIVE_BOUND_EPOCH', metadata['originalScientific'], 'original paused frame must be the actual bound render')
        guard(metadata['isMobile'] is mobile and metadata['rendererDpr'] == (1.5 if mobile else 1)
              and metadata['deviceDpr'] == (3 if mobile else 1), 'SUN_NATIVE_CONSTRUCTOR_TIER', metadata['homeMapping'])
        expected_uniforms = {'uGrade': 1, 'uNoiseAmplitude': 0.24, 'uLimb': 0.6, 'uSpotStrength': 0.55}
        guard(all(metadata['binding']['uniforms'].get(name) == value for name, value in expected_uniforms.items()),
              'SUN_NATIVE_PRODUCTION_DEFAULTS', metadata['binding']['uniforms'], 'native failure must not tune defaults')
        validate_program(metadata['binding']['program'])
        validate_gl([metadata['initialGl']])
        before = page.evaluate('() => window.__sunNativeProbe.assertPaused()')
        page.wait_for_timeout(100)
        after = page.evaluate('() => window.__sunNativeProbe.assertPaused()')
        guard(before['rendererFrame'] == after['rendererFrame'], 'SUN_NATIVE_PAUSE_FRAME_STABLE', {'before': before, 'after': after})
        widget['pauseProof'] = {'before': before, 'after': after}

        capture('limb', 'limb')
        profile = limb_stats(frames['limb'])
        checked(evidence, f'{label}-limb', lambda: validate_limb_stats(profile), profile)
        capture('productionBody', 'production')
        capture('noise0Body', 'noise0')
        granule = difference_stats(frames['productionBody'], frames['noise0Body'], 0, 0.3, 0.8)
        granule['margin'] = granule['stdDev'] - 0.035 if granule['stdDev'] is not None else None
        checked(evidence, f'{label}-granulation-original-pose', lambda: validate_granule_stats(granule), granule)
        capture('hidden', 'hidden')
        body = difference_stats(frames['productionBody'], frames['hidden'], 0, 1)
        checked(evidence, f'{label}-body-contribution', lambda: validate_body_stats(body), body)
        capture('productionGlow', 'production', glow=True)
        metrics = healthy_metrics(frames)
        checked(evidence, f'{label}-background-contribution', lambda: validate_background_stats(metrics['background']), metrics['background'])
        checked(evidence, f'{label}-glow-invariants', lambda: validate_glow_stats(metrics['glow'], frames['productionGlow']['metadata']['glows']), metrics['glow'])
        widget['mechanism'] = {'status': 'PASS', 'metrics': metrics}
        if report['negativeControlsRequested']:
            capture('limb0Body', 'limb0')
            capture('limb0Law', 'limb0Law')
            capture('flatBody', 'flat')
            capture('glow28', 'glow28', glow=True)
            capture('glowBackground', 'glowBackground', glow=True)
        for name, control, glow in (('homeProduction', 'production', True), ('homeNoise0', 'noise0', True),
                                    ('homeLimb0', 'limb0', True), ('homeFlat', 'flat', True), ('homeHidden', 'hidden', True),
                                    ('homeGlow28', 'glow28', True), ('homeBody', 'production', False)):
            capture(name, control, home=True, glow=glow)
        observation = home_metrics(frames)
        checked(evidence, f'{label}-actual-home-effects', lambda: validate_home(observation, mobile), observation)
        widget['homeObservation'] = {'status': 'MEASURED_REQUIRED_SIGNALS_PRESENT', 'metrics': observation}
        return frames
    except BaseException as error:
        pending_failure = error
        widget['statuses'].append({'status': 'FAIL', 'prefix': getattr(error, 'prefix', 'SUN_NATIVE_BROWSER_RUNTIME'),
                                   'metrics': getattr(error, 'metrics', None), 'error': str(error)})
        raise
    finally:
        restoration_failure = None
        if probe_created:
            try:
                restoration = page.evaluate('() => window.__sunNativeProbe.restore()')
                widget['restoration'] = restoration
                evidence.event('actual-restoration', {'widget': label, 'report': restoration})
                guard(restoration.get('ok') is True, 'SUN_NATIVE_RESTORE_ALL', restoration)
                if restoration['wasRunning']:
                    page.wait_for_function('''before => {
                      const solar = window.__DBG__.solarSystem;
                      return document.visibilityState === 'visible' && solar.running && solar.frameId !== 0
                        && solar.renderer.info.render.frame > before;
                    }''', arg=restoration['rendererFrameAfter'], timeout=15000)
                    resumed = page.evaluate(realtime.SNAPSHOT)
                    realtime.validate_bound_frame(resumed, 1)
                    widget['resumedActualBoundFrame'] = resumed
                    evidence.event('actual-production-frames-resumed', {'widget': label, 'frame': resumed})
            except BaseException as error:
                restoration_failure = error
                widget['restorationFailure'] = {'prefix': getattr(error, 'prefix', 'SUN_NATIVE_RESTORE_RUNTIME'), 'error': str(error)}
                evidence.event('restoration-failure', {'widget': label, **widget['restorationFailure']})
        if observer_saved:
            try:
                widget['observerCleanup'] = page.evaluate('''() => {
                  const solar = window.__DBG__.solarSystem, saved = window.__sunObserverSaved;
                  solar._advanceBodies = saved.advance;
                  if (saved.installed === undefined) delete solar.__frameObservationInstalled;
                  else solar.__frameObservationInstalled = saved.installed;
                  if (saved.bound === undefined) delete window.__boundFrameCall;
                  else window.__boundFrameCall = saved.bound;
                  const same = solar._advanceBodies === saved.advance;
                  delete window.__sunObserverSaved;
                  delete window.__sunNativeProbe;
                  delete window.__sunNativeTools;
                  return { sameOriginalAdvanceMethod: same, injectedGlobalsRemoved: !window.__sunNativeProbe && !window.__sunNativeTools };
                }''')
            except BaseException as error:
                widget['observerCleanup'] = {'error': str(error)}
        if script is not None:
            with contextlib.suppress(Exception):
                script.evaluate('element => element.remove()')
                script.dispose()
        if session is not None:
            with contextlib.suppress(Exception):
                session.detach()
        try:
            page.close()
            widget['pageClosed'] = True
        except Exception as error:
            widget['pageCloseError'] = str(error)
        if restoration_failure is not None and pending_failure is None:
            raise restoration_failure


def stop_process(process, label, evidence, report):
    if process is None:
        report['processes'].setdefault(label, {'status': 'NOT_STARTED', 'returncode': None})
        return
    action = 'already-exited'
    if process.poll() is None:
        action = 'terminate'
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            action = 'kill'
            process.kill()
            process.wait(timeout=10)
    record = {**report['processes'].get(label, {}), 'pid': process.pid, 'status': 'EXITED',
              'action': action, 'returncode': process.returncode}
    report['processes'][label] = record
    evidence.event('process-exit', {'label': label, **record})


def run_native(dist, evidence, report):
    report['nativeAttempted'] = True
    realtime = import_realtime()
    bundle = compile_helper(evidence, report)
    server = server_thread = display = chrome = playwright_manager = playwright = browser = context = profile = None
    read_fd = write_fd = None
    logs = []
    browser_env_before = os.environ.get('PLAYWRIGHT_BROWSERS_PATH')
    os.environ['PLAYWRIGHT_BROWSERS_PATH'] = browser_env_before or BROWSERS
    native_frames = {}
    try:
        try:
            server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(realtime.QuietHandler, directory=str(dist)))
        except OSError as error:
            raise GateFailure('SUN_NATIVE_LOCAL_SOCKET', {'errno': error.errno, 'operation': 'ordinary-HTTP server bind',
                                                         'owner': 'parent native runner; not project unavailability'}, str(error)) from error
        server.daemon_threads = True
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        report['server'] = {'host': '127.0.0.1', 'port': server.server_port, 'root': str(dist), 'status': 'RUNNING'}
        read_fd, write_fd = os.pipe()
        display_out = (evidence.output / 'xvfb.stdout.log').open('xb')
        display_err = (evidence.output / 'xvfb.stderr.log').open('xb')
        logs.extend([display_out, display_err])
        display_command = ['Xvfb', '-displayfd', str(write_fd), '-screen', '0', '1280x1000x24', '-nolisten', 'tcp']
        display = subprocess.Popen(display_command, pass_fds=(write_fd,), stdout=display_out, stderr=display_err)
        report['processes']['xvfb'] = {'pid': display.pid, 'command': display_command, 'status': 'RUNNING'}
        os.close(write_fd)
        write_fd = None
        guard(bool(select.select([read_fd], [], [], 10)[0]), 'SUN_NATIVE_XVFB_READINESS', {'pid': display.pid})
        screen = os.read(read_fd, 100).decode().strip()
        os.close(read_fd)
        read_fd = None
        guard(screen.isdigit(), 'SUN_NATIVE_XVFB_READINESS', {'displayfd': screen})
        report['allocatedDisplay'] = ':' + screen
        from playwright.sync_api import sync_playwright
        playwright_manager = sync_playwright()
        playwright = playwright_manager.start()
        try:
            with socket.socket() as port_socket:
                port_socket.bind(('127.0.0.1', 0))
                port = port_socket.getsockname()[1]
        except OSError as error:
            raise GateFailure('SUN_NATIVE_LOCAL_SOCKET', {'errno': error.errno, 'operation': 'free CDP port allocation',
                                                         'owner': 'parent native runner'}, str(error)) from error
        profile = tempfile.TemporaryDirectory(prefix='sun-native-profile-', dir=evidence.output)
        chrome_out = (evidence.output / 'chromium.stdout.log').open('xb')
        chrome_err = (evidence.output / 'chromium.stderr.log').open('xb')
        logs.extend([chrome_out, chrome_err])
        chrome_command = [playwright.chromium.executable_path, '--no-sandbox', '--no-first-run', '--no-default-browser-check',
                          '--disable-dev-shm-usage', f'--remote-debugging-port={port}',
                          f'--user-data-dir={Path(profile.name) / "profile"}',
                          '--host-resolver-rules=MAP solar-realtime.test 127.0.0.1', '--no-proxy-server',
                          '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank']
        chrome = subprocess.Popen(chrome_command, env={**os.environ, 'DISPLAY': ':' + screen}, stdout=chrome_out, stderr=chrome_err)
        report['processes']['chromium'] = {'pid': chrome.pid, 'command': chrome_command, 'status': 'RUNNING'}
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        deadline = time.monotonic() + 15
        while True:
            try:
                with opener.open(f'http://127.0.0.1:{port}/json/version', timeout=1) as response:
                    report['cdpVersion'] = json.loads(response.read())
                break
            except Exception as error:
                guard(time.monotonic() < deadline and chrome.poll() is None, 'SUN_NATIVE_CHROMIUM_READINESS',
                      {'pid': chrome.pid, 'returncode': chrome.poll(), 'lastError': str(error)})
                time.sleep(0.1)
        browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{port}', no_defaults=True)
        guard(bool(browser.contexts), 'SUN_NATIVE_DEFAULT_CONTEXT', {'contexts': len(browser.contexts)})
        context = browser.contexts[0]
        context.add_init_script(realtime.INIT)

        def local_route(route):
            parsed = urlparse(route.request.url)
            if parsed.scheme != 'http' or parsed.hostname != 'solar-realtime.test' or parsed.port != server.server_port:
                report['routes']['blockedNonlocal'].append({'scheme': parsed.scheme, 'host': parsed.hostname, 'path': parsed.path})
                route.abort()
            elif parsed.path.startswith('/api/'):
                report['routes']['syntheticNonScientificApis'].append(parsed.path)
                route.fulfill(content_type='application/json', body=json.dumps({'success': True, 'servers': [], 'data': []}))
            else:
                report['routes']['actualLocal'].append(parsed.path)
                route.continue_()

        context.route('**/*', local_route)
        url = f'http://solar-realtime.test:{server.server_port}/'
        report['url'] = url
        for mobile in (False, True):
            label = 'mobile' if mobile else 'desktop'
            native_frames[label] = run_widget(context, bundle, url, mobile, realtime, evidence, report)
        if report['negativeControlsRequested']:
            for label, frames in native_frames.items():
                negatives = negative_results(frames)
                report['widgets'][label]['negatives'] = negatives
                evidence.event('actual-negative-discrimination', {'widget': label, 'results': negatives})
                guard(negatives['ok'], 'SUN_NATIVE_NEGATIVE_DISCRIMINATION', negatives,
                      'inert controls must retain their actual response/prefix, never fake a kill')
    finally:
        for label, resource in (('context', context), ('browser', browser)):
            if resource is not None:
                try:
                    resource.close()
                    report['cleanup'][label] = 'CLOSED'
                except Exception as error:
                    report['cleanup'][label] = {'error': str(error)}
        for process, label in ((chrome, 'chromium'), (display, 'xvfb')):
            try:
                stop_process(process, label, evidence, report)
            except Exception as error:
                report['cleanup'][label] = {'error': str(error), 'pid': process.pid if process else None}
        if server is not None:
            try:
                if server_thread is not None:
                    server.shutdown()
                server.server_close()
                if server_thread is not None:
                    server_thread.join(timeout=10)
                report['server']['status'] = 'STOPPED'
                report['cleanup']['serverThreadAlive'] = server_thread.is_alive() if server_thread else False
            except Exception as error:
                report['cleanup']['server'] = {'error': str(error)}
        for descriptor in (read_fd, write_fd):
            if descriptor is not None:
                with contextlib.suppress(OSError):
                    os.close(descriptor)
        for stream in logs:
            stream.close()
        if profile is not None:
            try:
                profile.cleanup()
                report['cleanup']['profileRemoved'] = True
            except Exception as error:
                report['cleanup']['profile'] = {'error': str(error)}
        if playwright is not None:
            try:
                playwright.stop()
                report['cleanup']['playwright'] = 'STOPPED'
            except Exception as error:
                report['cleanup']['playwright'] = {'error': str(error)}
        if browser_env_before is None:
            os.environ.pop('PLAYWRIGHT_BROWSERS_PATH', None)
        else:
            os.environ['PLAYWRIGHT_BROWSERS_PATH'] = browser_env_before
        bundle = None
    guard(all(report['processes'].get(label, {}).get('status') == 'EXITED' for label in ('chromium', 'xvfb'))
          and report.get('server', {}).get('status') == 'STOPPED' and report['cleanup'].get('serverThreadAlive') is False
          and report['cleanup'].get('playwright') == 'STOPPED',
          'SUN_NATIVE_PROCESS_CLEANUP', {'processes': report['processes'], 'cleanup': report['cleanup']})


def replay_artifacts(source, evidence, report):
    original = json.loads((source / 'run.json').read_text())
    report['mode'] = 'independent-raw-artifact-replay-not-a-new-native-run'
    report['originalRunner'] = {'status': original.get('status'), 'exitCode': original.get('exitCode'), 'failure': original.get('failure')}
    guard(original.get('nativeAttempted') and original.get('widgets'), 'SUN_NATIVE_EVIDENCE_INCOMPLETE', report['originalRunner'])
    for label in ('desktop', 'mobile'):
        widget = original.get('widgets', {}).get(label, {})
        guard(widget.get('bindingArtifact'), 'SUN_NATIVE_EVIDENCE_INCOMPLETE', {'widget': label})
        binding = json.loads((source / widget['bindingArtifact']).read_text())['binding']
        frames = {}
        for name, filename in widget.get('captures', {}).items():
            metadata = json.loads((source / filename).read_text())
            raw_name = metadata.get('artifacts', {}).get('rgba')
            raw_path = source / raw_name if raw_name else None
            pixels = raw_path.read_bytes() if raw_path and raw_path.is_file() else None
            frame = {'metadata': metadata, 'pixels': pixels}
            validate_capture(frame, binding)
            guard(hashlib.sha256(pixels).hexdigest() == metadata['artifacts']['sha256'],
                  'SUN_NATIVE_RAW_IDENTITY', {'widget': label, 'capture': name})
            frames[name] = frame
        required = {'limb', 'productionBody', 'noise0Body', 'hidden', 'productionGlow', 'homeProduction',
                    'homeNoise0', 'homeLimb0', 'homeFlat', 'homeHidden', 'homeGlow28', 'homeBody'}
        if report['negativeControlsRequested']:
            required.update(('limb0Body', 'limb0Law', 'flatBody', 'glow28', 'glowBackground'))
        guard(required <= frames.keys(), 'SUN_NATIVE_EVIDENCE_INCOMPLETE', {'widget': label, 'missing': sorted(required - frames.keys())})
        metrics = healthy_metrics(frames)
        validate_limb_stats(metrics['limb'])
        validate_granule_stats(metrics['granule'])
        validate_body_stats(metrics['body'])
        validate_background_stats(metrics['background'])
        validate_glow_stats(metrics['glow'], frames['productionGlow']['metadata']['glows'])
        home = home_metrics(frames)
        validate_home(home, label == 'mobile')
        record = {'mechanism': metrics, 'homeObservation': home}
        if report['negativeControlsRequested']:
            record['negatives'] = negative_results(frames)
            evidence.event('replayed-negative-discrimination', {'widget': label, 'results': record['negatives']})
            guard(record['negatives']['ok'], 'SUN_NATIVE_NEGATIVE_DISCRIMINATION', record['negatives'])
        report['widgets'][label] = record
        evidence.event('independent-raw-replay', {'widget': label, 'record': record})


class ValidatorTests(unittest.TestCase):
    def rejection(self, prefix, action):
        with self.assertRaises(GateFailure) as captured:
            action()
        self.assertEqual(captured.exception.prefix, prefix)

    def test_missing_pixels_has_own_prefix(self):
        self.rejection(COMPLETENESS, lambda: validate_complete({'width': 1, 'height': 1}, None))

    def test_empty_pixels_has_own_prefix(self):
        self.rejection(COMPLETENESS, lambda: validate_complete({'width': 1, 'height': 1}, b''))

    def test_short_real_source_bytes_has_own_prefix(self):
        source_bytes = Path(__file__).read_bytes()
        self.rejection(COMPLETENESS, lambda: validate_complete({'width': len(source_bytes), 'height': 1}, source_bytes))

    def test_empty_reverse_guard_is_independent(self):
        result = reverse_guard(lambda removed: validate_complete({'width': 1, 'height': 1}, b'', removed), COMPLETENESS, LIMB)
        self.assertTrue(result['ok'])

    def test_flat_reverse_guard_is_independent(self):
        stats = {'center': {'count': 1}, 'annulus': {'count': 1}, 'ratio': 1}
        self.assertTrue(reverse_guard(lambda removed: validate_limb_stats(stats, removed), LIMB, GRANULATION)['ok'])

    def test_noise0_reverse_guard_is_independent(self):
        stats = {'count': 3, 'stdDev': 0}
        self.assertTrue(reverse_guard(lambda removed: validate_granule_stats(stats, removed), GRANULATION, LIMB)['ok'])

    def test_limb_bounds_unchanged(self):
        for ratio in (0.666, 0.716, 0.766):
            validate_limb_stats({'center': {'count': 1}, 'annulus': {'count': 1}, 'ratio': ratio})
        self.rejection(LIMB, lambda: validate_limb_stats({'center': {'count': 1}, 'annulus': {'count': 1}, 'ratio': 1}))

    def test_granule_bound_unchanged(self):
        validate_granule_stats({'count': 3, 'stdDev': 0.035})
        self.rejection(GRANULATION, lambda: validate_granule_stats({'count': 3, 'stdDev': 0.0349}))

    def test_background_is_strict_and_not_starfield_luma(self):
        validate_background_stats({'count': 3, 'maxAbs': 0.029})
        self.rejection(BACKGROUND, lambda: validate_background_stats({'count': 3, 'maxAbs': 0.03}))

    def test_glow28_is_width_kill_and_background_inert(self):
        self.assertEqual(NEGATIVE_PREFIXES['glow28'], [GLOW_WIDTH])
        stats = {'count': 3, 'maxAbs': 0.02652941176470588}
        glows = [{'scale': [28, 28, 1], 'opacity': 0.18}]
        self.rejection(GLOW_WIDTH, lambda: validate_glow_stats(stats, glows))
        self.assertEqual(expected_rejection(lambda: validate_background_stats(stats), BACKGROUND)['status'], 'INERT')

    def test_background_fault_reverse_guard_is_independent(self):
        self.assertEqual(NEGATIVE_PREFIXES['glowBackground'], [BACKGROUND])
        stats = {'count': 3, 'maxAbs': 0.03}
        glows = [{'scale': [9, 9, 1], 'opacity': 0.18}]
        result = reverse_guard(lambda removed: validate_background_fault(stats, stats, glows, removed), BACKGROUND, GLOW_WIDTH)
        self.assertTrue(result['ok'])
        self.assertEqual(result['ownRemoved']['status'], 'INERT')

    def test_background_fault_retains_width_and_peak_guards(self):
        background = {'count': 3, 'maxAbs': 0.03}
        removed = frozenset({BACKGROUND})
        self.rejection(GLOW_WIDTH, lambda: validate_background_fault(
            background, background, [{'scale': [28, 28, 1], 'opacity': 0.18}], removed))
        self.rejection(GLOW_PEAK, lambda: validate_background_fault(
            background, {'count': 3, 'maxAbs': 0.181}, [{'scale': [9, 9, 1], 'opacity': 0.18}], removed))

    def test_empty_roi_cannot_pass(self):
        self.rejection(ROI_COMPLETENESS, lambda: validate_granule_stats({'count': 0, 'stdDev': 0.1}))

    def test_hidden_requires_actual_pixel_signal(self):
        self.rejection(BODY, lambda: validate_body_stats({'count': 3, 'maxAbs': 0, 'changedPixels': 0}))

    def test_inert_negative_is_not_faked(self):
        result = expected_rejection(lambda: validate_background_stats({'count': 3, 'maxAbs': 0.029}), BACKGROUND)
        self.assertEqual(result['status'], 'INERT')
        self.assertIsNone(result['actualPrefix'])

    def test_wrong_prefix_is_not_a_kill(self):
        result = expected_rejection(lambda: validate_granule_stats({'count': 0, 'stdDev': 0}), GRANULATION)
        self.assertEqual(result['status'], 'WRONG_PREFIX')

    def test_runnable_false_is_specific_failure(self):
        program = {'present': True, 'linkStatus': True, 'vertexCompileStatus': True, 'fragmentCompileStatus': True,
                   'diagnostics': {'runnable': False}}
        self.rejection(COMPILE, lambda: validate_program(program))

    def test_missing_program_is_failure(self):
        self.rejection(COMPILE, lambda: validate_program({'present': False}))

    def test_actual_gl_errors_are_specific_failure(self):
        self.rejection(GL_ERROR, lambda: validate_gl([{'calls': [1282, 0], 'errors': [1282], 'contextLost': False}]))

    def test_zero_gl_is_healthy_scalar_guard_only(self):
        validate_gl([{'calls': [0], 'errors': [], 'contextLost': False}])

    def test_statistics_are_population_stddev(self):
        stats = summarize((1, 2, 3))
        self.assertEqual(stats['count'], 3)
        self.assertAlmostEqual(stats['stdDev'], math.sqrt(2 / 3))


def run_self_tests(evidence):
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ValidatorTests))
    log = stream.getvalue()
    evidence.write_bytes('validator-unit-tests.log', log.encode())
    sys.stdout.write(log)
    return {'kind': 'synthetic-scalar-and-incomplete-data-unit-tests-only-not-native-pixel-evidence',
            'testsRun': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors), 'ok': result.wasSuccessful()}


def absolute_path(value):
    path = Path(value)
    if not path.is_absolute():
        raise argparse.ArgumentTypeError('an absolute path is required')
    return path.resolve()


def main(argv=None):
    parser = argparse.ArgumentParser(description='Separate actual native Sun gate. Atomic startup is NOT IMPLEMENTED in this slice.')
    parser.add_argument('--dist', type=absolute_path)
    parser.add_argument('--output', type=absolute_path, required=True)
    parser.add_argument('--sun-only', action='store_true')
    parser.add_argument('--negative-controls', action='store_true')
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--replay', type=absolute_path)
    arguments = parser.parse_args(argv)
    if arguments.output == REPOSITORY or REPOSITORY in arguments.output.parents:
        parser.error('--output must be an appended evidence run outside the production worktree')
    if not arguments.self_test and arguments.dist is None:
        parser.error('--dist ABS is required')
    evidence = Evidence(arguments.output)
    report = {'mode': 'validator-unit-tests' if arguments.self_test else 'actual-visible-native-Sun-only',
              'startup': {'implemented': False, 'status': 'NOT_IMPLEMENTED', 'wholeTaskDone': False},
              'sunOnly': arguments.sun_only, 'negativeControlsRequested': arguments.negative_controls,
              'nativeAttempted': False, 'commands': [], 'widgets': {}, 'console_errors': [], 'processes': {}, 'cleanup': {},
              'routes': {'syntheticNonScientificApis': [], 'blockedNonlocal': [], 'actualLocal': []},
              'humanAesthetics': {'status': 'NOT_ASSESSED', 'approvalClaim': False}}
    exit_code = 1
    print('SUN_ONLY: startup is NOT IMPLEMENTED; this slice cannot accept the whole Sun/loading task.', flush=True)
    try:
        if arguments.self_test:
            report['selfTests'] = run_self_tests(evidence)
            guard(report['selfTests']['ok'], 'SUN_NATIVE_VALIDATOR_UNIT_TESTS', report['selfTests'])
            report['status'] = 'UNIT_TESTS_PASS_NOT_NATIVE_ACCEPTANCE'
        else:
            guard(arguments.sun_only, 'SUN_NATIVE_STARTUP_NOT_IMPLEMENTED', report['startup'], 'explicit --sun-only is required')
            guard(arguments.dist.is_dir() and (arguments.dist / 'index.html').is_file(),
                  'SUN_NATIVE_ACTUAL_DIST', {'dist': str(arguments.dist)}, 'existing actual built frontend-dist is required')
            report['dist'] = str(arguments.dist)
            if arguments.replay:
                replay_artifacts(arguments.replay, evidence, report)
                report['status'] = 'RAW_REPLAY_PASS_SUN_ONLY'
            else:
                run_native(arguments.dist, evidence, report)
                report['status'] = 'NATIVE_SUN_ONLY_PASS' if arguments.negative_controls else 'SUN_ONLY_HEALTHY_WITHOUT_DISCRIMINATION'
        exit_code = 0
    except BaseException as error:
        prefix = getattr(error, 'prefix', 'SUN_NATIVE_RUNNER_EXCEPTION')
        report['failure'] = {'prefix': prefix, 'metrics': getattr(error, 'metrics', None), 'error': str(error)}
        report['status'] = 'BLOCKED_PARENT_LOCAL_SOCKET' if prefix == 'SUN_NATIVE_LOCAL_SOCKET' else 'FAIL'
        exit_code = 3 if prefix == 'SUN_NATIVE_LOCAL_SOCKET' else (2 if prefix == 'SUN_NATIVE_STARTUP_NOT_IMPLEMENTED' else 1)
        evidence.write_bytes('failure.log', traceback.format_exc().encode())
        evidence.event('runner-failure', report['failure'])
        print(str(error), file=sys.stderr, flush=True)
    finally:
        report['exitCode'] = exit_code
        report['wallEnd'] = time.time()
        evidence.write_json('run.json', report)
        print(json.dumps({'status': report['status'], 'exitCode': exit_code, 'startup': report['startup'],
                          'evidence': str(evidence.output)}, ensure_ascii=False), flush=True)
    return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
