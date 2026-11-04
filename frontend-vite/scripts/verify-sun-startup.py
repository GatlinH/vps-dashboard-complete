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
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
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


STARTUP_METHOD = 'actual-production-atomic-startup-native-v1'
STARTUP_TARGETS = ('mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'moon', 'halley')
STARTUP_SLOTS = STARTUP_TARGETS[:9] + ('earth_clouds', 'saturn_ring')
STARTUP_RATES = (1, 60, 3600, 86400)
STARTUP_REVEAL = 'STARTUP_NATIVE_ATOMIC_REVEAL'
STARTUP_BACKGROUND = 'STARTUP_NATIVE_OWNED_BACKGROUND'
STARTUP_SCIENCE = 'STARTUP_NATIVE_REAL_SCIENCE'
STARTUP_FRESH = 'STARTUP_NATIVE_FRESH_SAMPLE'
STARTUP_DISPOSE = 'STARTUP_NATIVE_LATE_DISPOSE'


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


STARTUP_INIT = r'''(() => {
  const options = __STARTUP_CASE__;
  const wallNow = Date.now.bind(Date);
  const clone = value => value == null ? value : structuredClone(value);
  const undo = [], resources = new Map(), loaders = new WeakSet(), loaderNames = new WeakMap(), frames = new WeakMap(), ownedRaf = new Map(), boundDebug = new WeakSet();
  let solar = null, renderer = null, mounted = false, tick = null, lastRender = null, publishing = null;
  let observer = null, debugObject = null, allowDisposedCurrent = false, pendingTextures = 0, sciencePending = 0;
  const native = window.__startupNative = {
    method: 'actual-production-atomic-startup-native-v1', calls: {}, renders: [], visibility: [], advances: [],
    originalFunctions: {}, errors: [], counters: {trackAfterDestroy: 0, renderAfterDestroy: 0,
      rafScheduledAfterDestroy: 0, rafCallbacksAfterDestroy: 0, lateTextureCallbacks: 0,
      releaseAfterDestroy: 0, lateBindingChanges: 0, textureCallbacks: 0, textureFailures: 0,
      manifestCompletions: 0, scienceCompletions: 0, backgroundLateReleases: 0, guardCallsAfterDestroy: 0},
    binding: {}, firstVisible: null, readback: null, destroyBaseline: null,
    control: {kind: options.control || null, triggered: false, patches: [], measurements: [], fabricatedScience: false}
  };
  const identifier = resource => resource?.uuid ?? resource?.getHex?.() ?? resource?.kind ?? null;
  const count = name => { native.calls[name] = (native.calls[name] || 0) + 1; };
  function restoreProperty(object, name, descriptor) {
    if (descriptor) Object.defineProperty(object, name, descriptor);
    else delete object[name];
    const restored = Object.getOwnPropertyDescriptor(object, name);
    if (descriptor ? !restored || Reflect.ownKeys(descriptor).some(key => !Object.is(descriptor[key], restored[key]))
        || Reflect.ownKeys(descriptor).length !== Reflect.ownKeys(restored).length : restored !== undefined)
      throw new Error(`descriptor restoration mismatch: ${name}`);
  }
  function replace(object, name, replacement, control = false) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    const original = object[name];
    undo.push(() => restoreProperty(object, name, descriptor));
    Object.defineProperty(object, name, {value: replacement(original), writable: true, configurable: true});
    if (control) native.control.patches.push(name);
  }
  function register(resource, fromTrack = false) {
    if (!resource || typeof resource.dispose !== 'function') return;
    const kind = resource.isTexture ? 'texture' : resource.isMaterial ? 'material' : resource.isBufferGeometry ? 'geometry' : null;
    if (!kind) return;
    if (resources.has(resource)) { resources.get(resource).fromTrack ||= fromTrack; return; }
    const entry = {uuid: resource.uuid, kind, fromTrack, allocatedAfterDestroy: !!solar?.disposed, disposeCalls: 0};
    resources.set(resource, entry);
    replace(resource, 'dispose', original => function(...args) {
      ++entry.disposeCalls;
      entry.disposedAt = performance.now();
      return original.apply(this, args);
    });
  }
  function actualTargets() {
    return Object.fromEntries(Object.entries(solar?.ephemerisTargets || {}).map(([name, target]) =>
      [name, {uuid: target.uuid, visible: target.visible, position: target.position.toArray()}]));
  }
  function computedVisibility() {
    const canvas = solar?.canvas;
    if (!canvas) return {visible: false, connected: false};
    const style = getComputedStyle(canvas), rect = canvas.getBoundingClientRect();
    let hiddenAncestor = false;
    for (let node = canvas; node instanceof Element; node = node.parentElement) {
      const computed = getComputedStyle(node);
      if (computed.display === 'none' || computed.visibility === 'hidden' || computed.visibility === 'collapse'
          || Number(computed.opacity) === 0) hiddenAncestor = true;
    }
    return {visible: canvas.isConnected && !hiddenAncestor && rect.width > 0 && rect.height > 0,
      connected: canvas.isConnected, display: style.display, visibility: style.visibility, opacity: style.opacity,
      width: rect.width, height: rect.height, documentVisibility: document.visibilityState,
      ariaHidden: canvas.getAttribute('aria-hidden')};
  }
  function programEvidence() {
    const material = solar?.sun?.material, gl = renderer?.getContext();
    const program = material && renderer?.properties.get(material)?.currentProgram;
    const shaders = program?.program && gl?.getAttachedShaders(program.program) || [];
    const compiled = type => shaders.filter(shader => gl.getShaderParameter(shader, gl.SHADER_TYPE) === type)
      .every(shader => gl.getShaderParameter(shader, gl.COMPILE_STATUS)) && shaders.length >= 2;
    return {present: !!program?.program, currentProgramId: program?.id ?? null,
      materialUuid: material?.uuid, linkStatus: !!program?.program && gl.getProgramParameter(program.program, gl.LINK_STATUS),
      vertexCompileStatus: !!gl && compiled(gl.VERTEX_SHADER), fragmentCompileStatus: !!gl && compiled(gl.FRAGMENT_SHADER),
      diagnostics: {runnable: program?.diagnostics?.runnable ?? null},
      contextLost: !gl || gl.isContextLost()};
  }
  function sampleObservation(reason) {
    if (!solar) return {};
    const visible = computedVisibility(), material = solar.sun?.material;
    return {reason, ...visible, wall: wallNow(), perf: performance.now(), snapshot: solar._startupSnapshot(),
      sample: clone(solar.timeSample), status: clone(solar.ephemerisStatus), targets: actualTargets(),
      epochReady: !!solar.ephemerides?.isEpochReady(solar.timeSample?.jdTdb), tick: clone(tick),
      lastRender: clone(lastRender), publishRenderId: publishing?.renderId ?? null,
      frameInput: clone(publishing?.frameInput), sceneBackground: identifier(solar.scene?.background),
      sameStartupScene: solar._startup.scene === solar.scene,
      sunMaterialName: material?.name, sunShaderMaterial: !!material?.isShaderMaterial,
      sunUniforms: Object.fromEntries(Object.entries(material?.uniforms || {}).map(([name, uniform]) =>
        [name, uniform.value?.isColor ? [uniform.value.r, uniform.value.g, uniform.value.b] : uniform.value])),
      program: programEvidence()};
  }
  function readPaint() {
    const gl = renderer.getContext(), width = solar.canvas.width, height = solar.canvas.height;
    const pixels = new Uint8Array(width * height * 4), colors = new Set();
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const error = gl.getError();
    let nonZeroRgb = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const color = (pixels[index] << 16) | (pixels[index + 1] << 8) | pixels[index + 2];
      if (color) ++nonZeroRgb;
      if (colors.size < 256) colors.add(color);
    }
    let binary = '';
    for (let offset = 0; offset < pixels.length; offset += 8192)
      binary += String.fromCharCode(...pixels.subarray(offset, offset + 8192));
    native.readback = {width, height, bytes: pixels.length, nonZeroRgb, distinctRgb: colors.size,
      framebufferComplete: complete, error, contextLost: gl.isContextLost(), renderId: lastRender?.id,
      colorSpace: renderer.outputColorSpace, rowOrder: 'bottom-left', rgbaBase64: btoa(binary)};
  }
  function note(reason) {
    if (!mounted || !solar || solar.disposed) return;
    const observation = sampleObservation(reason);
    native.visibility.push({reason, perf: observation.perf, wall: observation.wall, visible: observation.visible,
      computed: {display: observation.display, visibility: observation.visibility, opacity: observation.opacity,
        connected: observation.connected, width: observation.width, height: observation.height},
      phase: observation.snapshot.phase, hasFirstFrame: !!observation.snapshot.firstFrame,
      lastSuccessfulRenderId: lastRender?.id ?? null, publishRenderId: publishing?.renderId ?? null});
    if (observation.visible && !native.firstVisible) {
      observation.glError = renderer.getContext().getError();
      native.firstVisible = observation;
      if (lastRender?.success) readPaint();
    }
  }
  function frameInput(frame) {
    return frame ? {entryUtcMs: frame.entryUtcMs, sample: clone(frame.sample), targets: clone(frame.targets),
      renderBefore: frame.renderBefore, sampleReferenceActual: frame.sampleReference === solar.timeSample,
      startupReferenceActual: frame.startup === solar._startup} : null;
  }
  function wrap(name, before, after) {
    replace(solar, name, original => function(...args) {
      count(name);
      before?.(args);
      const result = original.apply(this, args);
      after?.(result, args);
      return result;
    });
  }
  function wrapLoader(loader, slotName) {
    loaderNames.set(loader, slotName);
    if (loaders.has(loader)) return;
    loaders.add(loader);
    replace(loader, 'load', original => function(url, success, progress, failure) {
      const slotName = loaderNames.get(this);
      ++pendingTextures;
      const onSuccess = texture => {
        --pendingTextures;
        ++native.counters.textureCallbacks;
        register(texture);
        const before = identifier(solar._resolveTextureTarget(slotName)?.material?.[solar._resolveTextureTarget(slotName)?.slot]);
        const slot = solar._startup.slots[slotName];
        const previous = {...slot};
        if (solar.disposed) ++native.counters.lateTextureCallbacks;
        if (solar.disposed && native.control.kind === 'postdispose-callback') {
          slot.state = 'PENDING';
          allowDisposedCurrent = true;
        }
        try { return success?.(texture); }
        finally {
          const target = solar._resolveTextureTarget(slotName);
          const after = identifier(target?.material?.[target?.slot]);
          if (solar.disposed && before !== after) {
            ++native.counters.lateBindingChanges;
            native.control.measurements.push({slotName, before, after, actualTextureUuid: texture.uuid});
          }
          allowDisposedCurrent = false;
          if (solar.disposed && native.control.kind === 'postdispose-callback') Object.assign(slot, previous);
          note('texture-callback');
        }
      };
      const onFailure = error => {
        --pendingTextures;
        ++native.counters.textureFailures;
        if (solar.disposed) ++native.counters.lateTextureCallbacks;
        return failure?.(error);
      };
      const result = original.call(this, url, onSuccess, progress, onFailure);
      register(result);
      return result;
    });
  }
  function installControls() {
    const kind = native.control.kind;
    if (kind === 'reveal-staggered') {
      replace(solar, '_startupCaptureFrame', original => function(...args) {
        const result = original.apply(this, args);
        const pending = Object.values(this._startup.slots).filter(slot => slot.state === 'PENDING').length;
        if (!native.control.triggered && pending && performance.now() > this._startup.start + 300) {
          native.control.triggered = true;
          native.control.measurements.push({pending, originalReturnedNull: result === null});
          Object.assign(this.canvas.style, this._startup.canvasStyle);
          note('control-reveal-staggered');
        }
        return result;
      }, true);
    } else if (kind === 'unowned-background-shortcut') {
      replace(solar, '_startupCaptureFrame', original => function(...args) {
        const background = this._startup.background;
        const owner = background.owner;
        if (native.control.triggered && background.kind === 'FALLBACK') background.owner = this._startup.activeMountId;
        let result;
        try { result = original.apply(this, args); }
        finally { background.owner = owner; }
        if (result && background.kind === 'FALLBACK') {
          native.control.triggered = true;
          native.control.measurements.push({originalOwner: owner, resource: identifier(this.scene.background),
            actualFallback: background.kind, actualSample: clone(result.sample)});
          background.owner = null;
        }
        return result;
      }, true);
    } else if (kind === 'fake-science-on-4s') {
      replace(solar, '_startupPublish', original => function(...args) {
        const result = original.apply(this, args);
        if (!native.control.triggered && performance.now() >= this._startup.deadline
            && this.ephemerisStatus.status !== 'ready') {
          native.control.triggered = true;
          native.control.measurements.push({perf: performance.now(), deadline: this._startup.deadline,
            actualStatus: clone(this.ephemerisStatus), noFabricatedPositionsOrOk: true});
          Object.assign(this.canvas.style, this._startup.canvasStyle);
          note('control-fake-science-on-4s');
        }
        return result;
      }, true);
    } else if (kind === 'stale-first-sample') {
      let retained = null;
      replace(solar.realTimeClock, 'sample', original => function(...args) {
        const actual = original.apply(this, args);
        if (!retained && solar.ephemerides?.isEpochReady(actual.jdTdb)) retained = actual;
        return retained || actual;
      }, true);
      replace(solar, '_startupCaptureFrame', original => function(entry, ...args) {
        if (!retained) return original.call(this, entry, ...args);
        // Hold the real ready sample before its first publication, then let
        // the intended freshness fault reach the actual publish boundary.
        if (entry - retained.utcMs < 30) return null;
        const result = original.call(this, retained.utcMs, ...args);
        if (result) {
          result.entryUtcMs = entry;
          native.control.triggered = true;
          native.control.measurements.push({actualRetainedSample: clone(retained), actualEntryUtcMs: entry,
            staleMs: entry - retained.utcMs, originalClockInvoked: true});
        }
        return result;
      }, true);
    } else if (kind === 'postdispose-callback') {
      replace(solar, '_startupCurrent', original => function(...args) {
        const result = original.apply(this, args);
        if (this.disposed && allowDisposedCurrent) {
          native.control.triggered = true;
          native.control.measurements.push({originalResult: result, actualMountId: this._startup.activeMountId,
            insideActualTextureCallback: true});
          return true;
        }
        return result;
      }, true);
    }
  }
  function attach(value) {
    if (solar === value) return;
    if (solar) { native.errors.push('multiple actual handles'); return; }
    solar = value;
    const required = ['_track', '_buildRenderer', '_startupMount', '_startupCurrent', '_startupCaptureFrame',
      '_startupPublish', '_startupRetry', '_startupDispose', '_tick', '_advanceBodies', '_startupSnapshot',
      '_startupRelease', '_startupSettleSlot', '_startupBackground', '_swapPlanetTexture', '_loadEphemerides'];
    native.binding = {actualHandle: required.every(name => typeof solar?.[name] === 'function')
      && solar.debug === debugObject && !!solar._startup,
      attachedBeforeBuilders: !solar.renderer && Array.isArray(solar.disposables) && solar.disposables.length === 0,
      originalsRetained: true, sameRenderer: false};
    if (!native.binding.actualHandle || !native.binding.attachedBeforeBuilders) return;
    for (const name of required) native.originalFunctions[name] = Function.prototype.toString.call(solar[name]);
    wrap('_startupCurrent', () => { if (solar.disposed) ++native.counters.guardCallsAfterDestroy; });
    wrap('_track', args => { for (const resource of args) register(resource, true);
      if (solar.disposed) native.counters.trackAfterDestroy += args.length; });
    wrap('_startupRelease', args => {
      register(args[0]);
      if (solar.disposed && args[0]?.isTexture) {
        ++native.counters.releaseAfterDestroy;
        if (args[0] === solar._startup.backgroundPending) ++native.counters.backgroundLateReleases;
      }
    });
    wrap('_startupSettleSlot', null, result => { if (solar.disposed && result) ++native.counters.lateBindingChanges; });
    wrap('_startupBackground', null, result => { if (solar.disposed && result) ++native.counters.lateBindingChanges; });
    wrap('_swapPlanetTexture', args => wrapLoader(args[0], args[1]));
    wrap('_startupLoadTextures', null, result => result?.then(() => ++native.counters.manifestCompletions,
      error => native.errors.push(String(error))));
    wrap('_loadEphemerides', () => ++sciencePending, result => result.then(() => {
      --sciencePending; ++native.counters.scienceCompletions;
    }, error => { --sciencePending; native.errors.push(String(error)); }));
    wrap('_startupRetry');
    wrap('_startupDispose');
    wrap('_buildRenderer', null, () => {
      renderer = solar.renderer;
      native.binding.sameRenderer = renderer === solar.renderer;
      replace(renderer, 'render', original => function(scene, camera, ...args) {
        const observation = {id: native.renders.length + 1, before: this.info.render.frame,
          sample: clone(solar.timeSample), targets: actualTargets(), status: clone(solar.ephemerisStatus),
          sameRenderer: this === solar.renderer, sameScene: scene === solar.scene, sameCamera: camera === solar.camera,
          visibleBefore: computedVisibility(), perf: performance.now(), wall: wallNow(), success: false};
        if (solar.disposed) ++native.counters.renderAfterDestroy;
        native.renders.push(observation);
        note('renderer-before');
        try {
          const result = original.call(this, scene, camera, ...args);
          observation.after = this.info.render.frame;
          observation.success = observation.after > observation.before;
          observation.visibleAfter = computedVisibility();
          if (observation.success) lastRender = observation;
          note('renderer-after');
          return result;
        } catch (error) { observation.error = String(error); throw error; }
      });
    });
    wrap('_startupMount', null, () => {
      mounted = true;
      observer = new MutationObserver(() => note('computed-style-mutation'));
      observer.observe(document.documentElement, {attributes: true, childList: true, subtree: true,
        attributeFilter: ['style', 'class', 'hidden']});
      note('actual-mounted-hidden');
    });
    wrap('_tick', () => { tick = {id: (tick?.id || 0) + 1, enterWall: wallNow(), enterPerf: performance.now()}; note('tick-entry'); },
      () => { tick.exitWall = wallNow(); tick.exitPerf = performance.now(); note('tick-exit'); });
    wrap('_advanceBodies', null, () => native.advances.push({wall: wallNow(), perf: performance.now(),
      sample: clone(solar.timeSample), status: clone(solar.ephemerisStatus), targets: actualTargets()}));
    wrap('_startupCaptureFrame', null, result => { if (result) frames.set(result, frameInput(result)); });
    wrap('_startupPublish', args => {
      publishing = {renderId: lastRender?.id ?? null, frameInput: frames.get(args[0]) || frameInput(args[0])};
      note('publish-before');
    }, () => { note('publish-after-original'); publishing = null; });
    wrap('destroy', null, () => {
      native.destroyBaseline = {background: identifier(solar.scene?.background), renderCount: native.renders.length,
        perf: performance.now(), resources: [...resources.values()].map(clone)};
    });
    const request = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
    replace(window, 'requestAnimationFrame', () => function(callback) {
      const owned = callback === solar._tick;
      if (owned && solar.disposed) ++native.counters.rafScheduledAfterDestroy;
      const id = request.call(window, timestamp => {
        ownedRaf.delete(id);
        if (owned && solar.disposed) ++native.counters.rafCallbacksAfterDestroy;
        return callback(timestamp);
      });
      if (owned) ownedRaf.set(id, true);
      return id;
    });
    replace(window, 'cancelAnimationFrame', () => function(id) { ownedRaf.delete(id); return cancel.call(window, id); });
    installControls();
  }
  function bindDebug(object) {
    if (!object || typeof object !== 'object') return;
    if (boundDebug.has(object)) return;
    boundDebug.add(object);
    debugObject = object;
    let handle = object.solarSystem;
    const descriptor = Object.getOwnPropertyDescriptor(object, 'solarSystem');
    Object.defineProperty(object, 'solarSystem', {configurable: true, enumerable: true,
      get: () => handle, set: value => { handle = value; attach(value); }});
    undo.push(() => restoreProperty(object, 'solarSystem', descriptor));
    if (handle) attach(handle);
  }
  const debugDescriptor = Object.getOwnPropertyDescriptor(window, '__DBG__');
  let debug = window.__DBG__;
  Object.defineProperty(window, '__DBG__', {configurable: true, get: () => debug,
    set: value => { debug = value; bindDebug(value); }});
  if (debug) bindDebug(debug);
  native.observe = () => sampleObservation('explicit-native-checkpoint');
  native.export = () => ({method: native.method, binding: clone(native.binding), calls: clone(native.calls),
    originalFunctions: clone(native.originalFunctions), counters: clone(native.counters), errors: clone(native.errors),
    firstVisible: clone(native.firstVisible), current: native.observe(), readback: clone(native.readback),
    renders: clone(native.renders), visibility: clone(native.visibility), advances: clone(native.advances),
    resources: [...resources.values()].map(clone), control: clone(native.control), ui: clone(native.ui),
    destroy: solar?.disposed ? {disposed: solar.disposed, phase: solar._startup.phase, active: solar._startupSnapshot().active,
      canvasConnected: solar.canvas.isConnected, sceneChildren: solar.scene.children.length,
      sceneBackground: identifier(solar.scene.background), baselineBackground: native.destroyBaseline?.background,
      pendingOwnedRaf: ownedRaf.size, pendingTextureCallbacks: pendingTextures, sciencePromisesPending: sciencePending,
      baseline: clone(native.destroyBaseline)} : null});
  native.pending = () => ({textures: pendingTextures, science: sciencePending,
    lateCallbacks: native.counters.lateTextureCallbacks, backgroundLateReleases: native.counters.backgroundLateReleases});
  native.restore = () => {
    if (native.restored) return {originalsRestored: true, alreadyRestored: true};
    observer?.disconnect();
    const failures = [];
    for (const restore of [...undo].reverse()) {
      try { restore(); } catch (error) { failures.push(error); }
    }
    try { restoreProperty(window, '__DBG__', debugDescriptor); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'startup observer restoration failed');
    native.restored = true;
    return {originalsRestored: true, restoredDescriptors: undo.length};
  };
})();'''


def startup_visibility(record):
    return record.get('firstVisible') or record.get('current') or {}


def validate_startup_atomic(record, removed=frozenset()):
    visible = record.get('firstVisible') or {}
    snapshot = visible.get('snapshot') or {}
    first = snapshot.get('firstFrame') or {}
    render = visible.get('lastRender') or {}
    slots = snapshot.get('slots') or {}
    valid = (visible.get('visible') is True and snapshot.get('phase') == 'FIRST_VISIBLE'
             and set(slots) == set(STARTUP_SLOTS) and first.get('activeMountId') == snapshot.get('activeMountId')
             and all(slot.get('state') in ('SUCCESS', 'COMMITTED_FALLBACK')
                     and slot.get('owner') == snapshot.get('activeMountId') and slot.get('resource') is not None
                     for slot in slots.values())
             and render.get('success') is True and render.get('sameRenderer') is True
             and render.get('sameScene') is True and render.get('sameCamera') is True
             and type(render.get('id')) is int and render['id'] > 0
             and finite(render.get('before')) and finite(render.get('after')) and render['after'] > render['before']
             and first.get('renderFrame') == render.get('after')
             and visible.get('publishRenderId') == render.get('id')
             and visible.get('frameInput', {}).get('renderBefore') == render.get('before')
             and visible.get('frameInput', {}).get('sampleReferenceActual') is True
             and first.get('sample') == render.get('sample') == visible.get('frameInput', {}).get('sample')
             and all(not event.get('visible') or event.get('hasFirstFrame') is True
                     for event in record.get('visibility', [])))
    guard(valid, STARTUP_REVEAL, {'firstVisible': visible, 'visibility': record.get('visibility')},
          'computed canvas visibility must follow the same successful actual renderer frame and fixed owned slots', removed)


def validate_startup_background(record, removed=frozenset()):
    visible = startup_visibility(record)
    snapshot = visible.get('snapshot') or {}
    background = snapshot.get('background') or {}
    guard(background.get('state') == 'READY' and background.get('kind') in ('TEXTURE', 'FALLBACK')
          and background.get('owner') == background.get('activeMountId') == snapshot.get('activeMountId')
          and background.get('resource') is not None and background.get('resource') == visible.get('sceneBackground')
          and visible.get('sameStartupScene') is True,
          STARTUP_BACKGROUND, background, 'initial unowned scene.background is not a committed background', removed)


def validate_startup_science(record, removed=frozenset()):
    visible = startup_visibility(record)
    sample = visible.get('sample') or {}
    status = visible.get('status') or {}
    targets = visible.get('targets') or {}
    applied = status.get('targets') or {}
    valid = (set(targets) == set(applied) == set(STARTUP_TARGETS)
             and sample.get('rate') in STARTUP_RATES and finite(sample.get('utcMs')) and finite(sample.get('jdTdb'))
             and status.get('status') == 'ready' and not status.get('error') and visible.get('epochReady') is True
             and status.get('lastAppliedJd') == sample.get('jdTdb')
             and status.get('lastAppliedUtcMs') == sample.get('utcMs'))
    for name in STARTUP_TARGETS:
        target, state = targets.get(name, {}), applied.get(name, {})
        physical = state.get('lastPhysicalPosition')
        position = target.get('position')
        good = (target.get('visible') is True and state.get('ok') is True and not state.get('error')
                and state.get('lastJd') == sample.get('jdTdb') and isinstance(physical, list)
                and len(physical) == 3 and all(finite(value) for value in physical) and math.hypot(*physical) > 0
                and isinstance(position, list) and len(position) == 3 and all(finite(value) for value in position))
        valid = valid and good
        if good:
            expected = import_realtime().physical_to_display(physical)
            if name == 'moon':
                earth = applied.get('earth', {}).get('lastPhysicalPosition')
                if not isinstance(earth, list) or len(earth) != 3 or not all(finite(value) for value in earth):
                    valid = False
                    continue
                earth_display = import_realtime().physical_to_display(earth)
                expected = [earth_display[0] + physical[0] * 1089.68,
                            earth_display[1] + physical[2] * 1089.68,
                            earth_display[2] - physical[1] * 1089.68]
            valid = valid and math.dist(position, expected) <= 1e-8
    first = visible.get('snapshot', {}).get('firstFrame')
    if first:
        valid = valid and first.get('sample') == sample and set(first.get('targets', {})) == set(STARTUP_TARGETS)
        for name, target in first.get('targets', {}).items():
            valid = valid and (target.get('ok') is True and not target.get('error')
                               and target.get('lastJd') == sample.get('jdTdb')
                               and target.get('lastAppliedUtcMs') == sample.get('utcMs')
                               and target.get('lastPhysicalPosition') == applied.get(name, {}).get('lastPhysicalPosition')
                               and target.get('position') == targets.get(name, {}).get('position'))
    guard(valid, STARTUP_SCIENCE, {'sample': sample, 'status': status, 'targets': targets,
                                 'epochReady': visible.get('epochReady')},
          'all ten IDs must consume actual corpus samples, identical UTC/JD and real applied positions', removed)


def validate_startup_fresh(record, removed=frozenset()):
    """Compare rounded entry +/-16.7 endpoints at the timestamps' Float64 scale.

    Endpoint rounding is <=0.5 timestamp ULP (2**-44 ms near 1000,
    2**-13 ms near 1.8e12), plus <=2**-49 ms for the fixed 16.7 cap.
    The next representable timestamp outside either endpoint stays stale.
    """
    visible = startup_visibility(record)
    first = visible.get('snapshot', {}).get('firstFrame') or {}
    sample = visible.get('sample') or {}
    entry = first.get('entryUtcMs')
    tick = visible.get('tick') or {}
    good = (finite(entry) and finite(sample.get('utcMs')) and sample.get('rate') in STARTUP_RATES
            and finite(tick.get('enterWall')) and tick['enterWall'] <= entry <= visible.get('wall', -1)
            and (sample.get('rate') != 1 or (entry - 16.7 <= sample['utcMs'] <= entry + 16.7
                                            and tick['enterWall'] <= sample['utcMs'] <= visible.get('wall', -1))))
    guard(good, STARTUP_FRESH, {'entryUtcMs': entry, 'sample': sample, 'nativeTick': tick},
          '1x entry freshness is <=16.7 ms; accelerated rates retain their actual native UI clock', removed)


def validate_startup_dispose(record, removed=frozenset()):
    cleanup = record.get('destroy') or {}
    resources = record.get('resources') or []
    counters = record.get('counters') or {}
    kinds = {resource.get('kind') for resource in resources if resource.get('fromTrack')}
    valid = (cleanup.get('disposed') is True and cleanup.get('phase') == 'DISPOSED'
             and cleanup.get('active') is False and cleanup.get('canvasConnected') is False
             and cleanup.get('sceneChildren') == 0 and cleanup.get('pendingOwnedRaf') == 0
             and {'texture', 'geometry', 'material'} <= kinds
             and all(resource.get('disposeCalls') == 1 for resource in resources)
             and counters.get('trackAfterDestroy', 0) == 0 and counters.get('renderAfterDestroy', 0) == 0
             and counters.get('rafScheduledAfterDestroy', 0) == 0 and counters.get('lateBindingChanges', 0) == 0
             and cleanup.get('sceneBackground') == cleanup.get('baselineBackground')
             and counters.get('lateTextureCallbacks', 0) > 0 and counters.get('releaseAfterDestroy', 0) > 0
             and cleanup.get('pendingTextureCallbacks') == 0 and cleanup.get('sciencePromisesPending') == 0)
    guard(valid, STARTUP_DISPOSE, {'destroy': cleanup, 'resources': resources, 'counters': counters},
          'drained real late callbacks cannot schedule ghosts, commit disposed resources or resurrect the scene', removed)


def validate_startup_binding(record):
    required = ('_track', '_buildRenderer', '_startupMount', '_startupCurrent', '_tick', '_startupCaptureFrame', '_startupPublish')
    binding = record.get('binding') or {}
    calls = record.get('calls') or {}
    guard(record.get('method') == STARTUP_METHOD and binding.get('actualHandle') is True
          and binding.get('attachedBeforeBuilders') is True and binding.get('sameRenderer') is True
          and binding.get('originalsRetained') is True and all(calls.get(name, 0) > 0 for name in required)
          and all(record.get('originalFunctions', {}).get(name) for name in required),
          'STARTUP_NATIVE_SOURCE_BINDING', {'binding': binding, 'calls': calls},
          'empty guessed debug handles and test-bundle THREE instances are not actual acceptance')


def validate_startup_corpus(network):
    science = [request for request in network.get('requests', []) if request.get('scientific') and request.get('status') == 200]
    guard(bool(science) and any(request.get('path', '').endswith('.f64') for request in science)
          and all(request.get('actualCorpus') is True and request.get('sha256') == request.get('sourceSha256')
                  and request.get('bytes', 0) > 0 for request in science),
          'STARTUP_NATIVE_CORPUS_BINDING', science, 'successful scientific HTTP responses must be unchanged real public corpus bytes')


def validate_startup_paint(record):
    visible = record.get('firstVisible') or {}
    readback = record.get('readback') or {}
    program = visible.get('program') or {}
    validate_program(program)
    guard(readback.get('width', 0) > 0 and readback.get('height', 0) > 0
          and readback.get('bytes') == readback.get('width', 0) * readback.get('height', 0) * 4
          and readback.get('nonZeroRgb', 0) > 0 and readback.get('distinctRgb', 0) > 1
          and readback.get('framebufferComplete') is True and readback.get('error') == 0
          and readback.get('contextLost') is False and visible.get('glError') == 0
          and readback.get('renderId') == visible.get('lastRender', {}).get('id'),
          'STARTUP_NATIVE_SUCCESSFUL_PAINT', readback, 'actual current renderer framebuffer, not a coordinator-only flag')
    uniforms = visible.get('sunUniforms') or {}
    guard(set(('uCoreColor', 'uEdgeColor', 'uGrade', 'uNoiseAmplitude', 'uLimb', 'uSpotStrength')) <= set(uniforms)
          and visible.get('sunMaterialName') == 'SunIllustrativeSurface' and visible.get('sunShaderMaterial') is True
          and all((finite(value) if isinstance(value, (int, float)) else isinstance(value, list)
                   and len(value) == 3 and all(finite(channel) for channel in value)) for value in uniforms.values()),
          'STARTUP_NATIVE_SUN_MATERIAL', uniforms, 'unchanged actual Sun currentProgram and finite accepted uniforms')


def validate_startup_published(record, network, rate):
    validate_startup_binding(record)
    validate_startup_atomic(record)
    validate_startup_background(record)
    validate_startup_science(record)
    validate_startup_fresh(record)
    validate_startup_corpus(network)
    validate_startup_paint(record)
    sample = record['firstVisible']['snapshot']['firstFrame']['sample']
    guard(sample['rate'] == rate, 'STARTUP_NATIVE_SUPPORTED_RATE', {'expected': rate, 'sample': sample, 'ui': record.get('ui')})
    first = record['firstVisible']
    first['gates'] = {'fixedOwned11Slots': True, 'ownedReadyBackground': True, 'real10TargetIds': list(STARTUP_TARGETS),
                      'sameAppliedUtcJd': True, 'entryFreshnessMs': abs(sample['utcMs'] - first['snapshot']['firstFrame']['entryUtcMs']),
                      'rate': rate, 'sameSuccessfulRenderId': first['lastRender']['id'], 'actualCurrentSunProgram': True,
                      'actualGlHealthy': True, 'actualFramebufferPaint': True}
    record['firstFrame'] = {'actualSnapshot': first['snapshot']['firstFrame'], 'gates': first['gates']}


def validate_startup_wait(record, expired=False):
    current = record.get('current') or {}
    snapshot = current.get('snapshot') or {}
    guard(current.get('visible') is False and snapshot.get('firstFrame') is None
          and snapshot.get('phase') in ('LOADING', 'RETRY') and current.get('status', {}).get('status') != 'ready',
          STARTUP_SCIENCE, current, 'visual deadline never fabricates physical readiness or a visible science frame')
    if expired:
        slots = snapshot.get('slots') or {}
        guard(current.get('perf', 0) >= snapshot.get('deadline', math.inf) and set(slots) == set(STARTUP_SLOTS)
              and all(slot.get('state') in ('SUCCESS', 'COMMITTED_FALLBACK')
                      and slot.get('owner') == snapshot.get('activeMountId') for slot in slots.values()),
              'STARTUP_NATIVE_VISUAL_DEADLINE', snapshot, 'real 4s visual deadline settles the fixed set independently of science')
        validate_startup_background({'current': current})


def startup_head_and_index():
    location = REPOSITORY / '.git'
    git_dir = location if location.is_dir() else Path(location.read_text().strip().removeprefix('gitdir: '))
    if not git_dir.is_absolute():
        git_dir = (REPOSITORY / git_dir).resolve()
    common = git_dir
    if (git_dir / 'commondir').is_file():
        common = (git_dir / (git_dir / 'commondir').read_text().strip()).resolve()
    head = (git_dir / 'HEAD').read_text().strip()
    if head.startswith('ref: '):
        reference = head[5:]
        ref_file = next((base / reference for base in (git_dir, common) if (base / reference).is_file()), None)
        if ref_file:
            head = ref_file.read_text().strip()
        else:
            packed = (common / 'packed-refs').read_text().splitlines()
            head = next(line.split()[0] for line in packed if line.endswith(' ' + reference))
    guard(len(head) == 40 and all(character in '0123456789abcdef' for character in head),
          'STARTUP_NATIVE_HEAD_BINDING', {'head': head}, 'read actual full HEAD without invoking git')
    entries = {}
    index_path = git_dir / 'index'
    if index_path.is_file():
        data = index_path.read_bytes()
        if data[:4] == b'DIRC' and struct.unpack('>I', data[4:8])[0] in (2, 3):
            count, offset = struct.unpack('>I', data[8:12])[0], 12
            for _ in range(count):
                beginning = offset
                object_id = data[offset + 40:offset + 60].hex()
                flags = struct.unpack('>H', data[offset + 60:offset + 62])[0]
                offset += 62 + (2 if flags & 0x4000 else 0)
                ending = data.index(b'\x00'.decode('unicode_escape').encode(), offset)
                name = data[offset:ending].decode()
                entries[name] = object_id
                offset = beginning + ((ending + 1 - beginning + 7) // 8) * 8
    return head, entries


def startup_source_binding(dist):
    head, index = startup_head_and_index()
    paths = [FRONTEND / 'src/components/SolarSystem.js', Path(__file__), FRONTEND / 'test/unit/solarStartup.test.js',
             FRONTEND / 'test/helpers/sunNativeProbe.js']
    for root in (FRONTEND / 'src/components/solar', FRONTEND / 'public/assets/solar/de440-1900-2100',
                 FRONTEND / 'public/assets/solar/p1'):
        paths.extend(path for path in root.rglob('*') if path.is_file())
    sources, dirty = {}, {}
    for path in sorted(set(paths)):
        if not path.is_file():
            continue
        relative = str(path.relative_to(REPOSITORY))
        data = path.read_bytes()
        sources[relative] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
        object_id = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        if relative in index and object_id != index[relative]:
            dirty[relative] = {'indexBlobSha1': index[relative], 'workingBlobSha1': object_id, **sources[relative]}
        elif relative not in index:
            dirty[relative] = {'untrackedInMeasuredIndex': True, **sources[relative]}
    built = {str(path.relative_to(dist)): {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size}
             for path in sorted(dist.rglob('*')) if path.is_file() and (path.suffix in ('.js', '.html', '.map')
                                                                       or path.name == 'manifest.json')}
    return {'method': 'measured-file-sha256-and-readonly-HEAD/index-no-git-command', 'testedFullHEAD': head,
            'dirtyBinding': dirty, 'dirtyScope': 'measured source/corpus/helper/unit/verifier paths, not a whole-repository clean claim',
            'sources': sources, 'distRoot': str(dist), 'distFiles': built,
            'productionFingerprint': hashlib.sha256(json.dumps({name: value for name, value in sources.items()
                                                                if name != str(Path(__file__).relative_to(REPOSITORY))}, sort_keys=True).encode()).hexdigest()}


class StartupScenario:
    def __init__(self, name, rules, evidence):
        self.name, self.rules, self.evidence = name, rules, evidence
        self.condition = threading.Condition()
        self.release_events = {rule['hold']: threading.Event() for rule in rules if rule.get('hold')}
        self.requests, self.active, self.peak_active, self.hits = [], 0, 0, {}
        self.faults_enabled = True

    def release(self, group=None):
        for name, event in self.release_events.items():
            if group is None or group == name:
                event.set()

    def snapshot(self):
        with self.condition:
            return {'case': self.name, 'concurrency': 'independent ThreadingHTTPServer handlers; no route sleep',
                    'active': self.active, 'peakActive': self.peak_active,
                    'hits': dict(self.hits), 'requests': [dict(request) for request in self.requests]}

    def drain(self, timeout=30):
        with self.condition:
            return self.condition.wait_for(lambda: self.active == 0, timeout=timeout)

    def select(self, path):
        selected = []
        with self.condition:
            self.active += 1
            self.peak_active = max(self.peak_active, self.active)
            for rule in self.rules:
                match = (path == rule.get('path') if rule.get('path') else path.startswith(tuple(rule['prefixes'])))
                if match:
                    key = rule['name']
                    self.hits[key] = self.hits.get(key, 0) + 1
                    if not rule.get('once') or self.hits[key] == 1:
                        selected.append(dict(rule))
        return selected


class StartupHTTPHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, controller, **kwargs):
        self.controller = controller
        super().__init__(*args, **kwargs)

    def log_message(self, *_args):
        return

    def do_GET(self):
        scenario = self.controller['scenario']
        path = urlparse(self.path).path
        if scenario is None:
            return super().do_GET()
        request = {'path': path, 'start': time.monotonic(), 'threadId': threading.get_ident(),
                   'scientific': path.startswith(('/assets/solar/de440-1900-2100/', '/assets/solar/p1/')),
                   'status': None, 'bytes': 0, 'actualCorpus': False}
        rules = scenario.select(path)
        request['rules'] = [rule['name'] for rule in rules]
        try:
            for rule in rules:
                if rule.get('hold'):
                    request.setdefault('held', []).append(rule['hold'])
                    request['delayReleased'] = scenario.release_events[rule['hold']].wait(timeout=60)
            filename = Path(self.translate_path(self.path))
            if filename.is_dir():
                filename /= 'index.html'
            status = 200 if filename.is_file() else 404
            data = filename.read_bytes() if status == 200 else b'Not found'
            for rule in rules:
                if scenario.faults_enabled and rule.get('response'):
                    status = rule['response']
                    data = b'Not found' if status == 404 else b'{"textures":'
                    request['controlledFault'] = rule['name']
            digest = hashlib.sha256(data).hexdigest()
            public = FRONTEND / 'public' / path.lstrip('/')
            source_digest = hashlib.sha256(public.read_bytes()).hexdigest() if request['scientific'] and public.is_file() else None
            request.update(status=status, bytes=len(data), sha256=digest, sourceSha256=source_digest,
                           actualCorpus=request['scientific'] and status == 200 and digest == source_digest,
                           responseStart=time.monotonic())
            self.send_response(status)
            self.send_header('Content-Type', self.guess_type(str(filename)))
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
            self.end_headers()
            self.wfile.write(data)
            request['delivered'] = True
        except (BrokenPipeError, ConnectionResetError) as error:
            request['deliveryError'] = type(error).__name__
        except Exception as error:
            request['handlerError'] = str(error)
        finally:
            request['end'] = time.monotonic()
            with scenario.condition:
                scenario.requests.append(request)
                scenario.active -= 1
                scenario.condition.notify_all()
            scenario.evidence.event('startup-http', {'case': scenario.name, **request})


def startup_case_matrix(dist, negatives):
    manifest_path = dist / 'assets/solar/textures-v1/manifest.json'
    guard(manifest_path.is_file(), 'STARTUP_NATIVE_FIXTURE', {'path': str(manifest_path)}, 'actual texture corpus manifest is required')
    manifest = json.loads(manifest_path.read_text())
    texture_paths = {}
    for name in STARTUP_SLOTS:
        tier = manifest.get('textures', {}).get(name, {}).get('tiers', {}).get('desktop', {})
        guard(isinstance(tier.get('file'), str), 'STARTUP_NATIVE_FIXTURE', {'slot': name}, 'no missing-fixture negative kills')
        texture_paths[name] = '/assets/solar/textures-v1/' + tier['file']
    background, texture_manifest = '/globe/backgrounds/heic1509a-bg.jpg', '/assets/solar/textures-v1/manifest.json'
    science_manifest = '/assets/solar/de440-1900-2100/manifest.json'

    def hold(name, path=None, group='visual', prefixes=None):
        return {'name': name, 'path': path, 'prefixes': prefixes, 'hold': group}

    def fault(name, path, response, once=False):
        return {'name': name, 'path': path, 'response': response, 'once': once}

    science = hold('science', group='science', prefixes=['/assets/solar/de440-1900-2100/', '/assets/solar/p1/'])
    visual_all = [hold('background', background), hold('manifest', texture_manifest)]
    destroy_rules = [hold('background', background), hold('science', science_manifest, group='science')]
    destroy_rules += [hold('texture-' + name, path) for name, path in texture_paths.items()]
    cases = [{'name': 'cold-desktop', 'rate': 1}, {'name': 'cold-mobile', 'rate': 1, 'mobile': True}]
    cases += [{'name': 'ui-rate-' + str(rate), 'rate': rate, 'rules': [science], 'holdMode': 'ui'}
              for rate in STARTUP_RATES[1:]]
    cases += [
        {'name': 'delayed-background', 'rules': [hold('background', background)], 'holdMode': 'visual', 'pending': 'background'},
        {'name': 'delayed-one-asset', 'rules': [hold('one-asset', texture_paths['earth'])], 'holdMode': 'visual', 'pending': 'earth'},
        {'name': 'delayed-manifest', 'rules': [hold('manifest', texture_manifest)], 'holdMode': 'visual', 'pending': 'manifest'},
        {'name': 'delayed-science', 'rules': [science], 'holdMode': 'deadline'},
        {'name': 'visual-deadline-science-still-loading', 'rules': visual_all + [science], 'holdMode': 'deadline',
         'fallbacks': list(STARTUP_SLOTS), 'backgroundKind': 'FALLBACK'},
        {'name': 'background-404', 'rules': [fault('background-404', background, 404)], 'backgroundKind': 'FALLBACK'},
        {'name': 'texture-404', 'rules': [fault('texture-404', texture_paths['earth'], 404)], 'fallbacks': ['earth']},
        {'name': 'missing-manifest', 'rules': [fault('missing-manifest', texture_manifest, 404)], 'fallbacks': list(STARTUP_SLOTS)},
        {'name': 'malformed-manifest', 'rules': [fault('malformed-manifest', texture_manifest, 200)], 'fallbacks': list(STARTUP_SLOTS)},
        {'name': 'late-manifest', 'rules': [hold('late-manifest', texture_manifest)], 'holdMode': 'late-manifest',
         'fallbacks': list(STARTUP_SLOTS)},
        {'name': 'data-error-actual-retry', 'rules': [fault('science-manifest-first-404', science_manifest, 404, once=True)], 'holdMode': 'retry'},
        {'name': 'destroy-before-loads-drain-late-callbacks', 'rules': destroy_rules, 'holdMode': 'destroy'},
    ]
    if negatives:
        cases += [
            {'name': 'control-reveal-staggered', 'control': 'reveal-staggered', 'rules': [hold('manifest', texture_manifest)],
             'holdMode': 'control', 'prefix': STARTUP_REVEAL},
            {'name': 'control-unowned-initial-background', 'control': 'unowned-background-shortcut',
             'rules': visual_all, 'holdMode': 'control-deadline', 'prefix': STARTUP_BACKGROUND},
            {'name': 'control-fake-science-on-4s', 'control': 'fake-science-on-4s', 'rules': visual_all + [science],
             'holdMode': 'control', 'prefix': STARTUP_SCIENCE},
            {'name': 'control-stale-first-sample', 'control': 'stale-first-sample',
             'rules': [hold('background', background)], 'holdMode': 'control-deadline', 'prefix': STARTUP_FRESH},
            {'name': 'control-postdispose-callback', 'control': 'postdispose-callback',
             'rules': destroy_rules, 'holdMode': 'destroy', 'prefix': STARTUP_DISPOSE},
        ]
    return cases


def startup_control_result(record, prefix):
    validate_startup_binding(record)
    control = record.get('control') or {}
    guard(control.get('triggered') is True and control.get('patches') and control.get('measurements')
          and control.get('fabricatedScience') is False,
          'STARTUP_NATIVE_CONTROL_FIXTURE', control, 'actual method guard must trigger on a measured real fixture')
    validators = {STARTUP_REVEAL: validate_startup_atomic, STARTUP_BACKGROUND: validate_startup_background,
                  STARTUP_SCIENCE: validate_startup_science, STARTUP_FRESH: validate_startup_fresh,
                  STARTUP_DISPOSE: validate_startup_dispose}
    validator = validators[prefix]
    rejection = expected_rejection(lambda: validator(record), prefix)
    own_removed = True
    try:
        validator(record, removed=frozenset([prefix]))
    except Exception:
        own_removed = False
    unrelated = next(candidate for candidate in validators if candidate != prefix)
    reverse = expected_rejection(lambda: validator(record, removed=frozenset([unrelated])), prefix)
    result = {'actualBinding': record['binding'], 'actualControl': control, 'expectedPrefix': prefix,
              'rejection': rejection, 'ownGuardRemovedPass': own_removed, 'unrelatedGuardRemoved': reverse,
              'fixtureFailureCountsAsKill': False, 'sourceMutatedOnDisk': False}
    guard(rejection['status'] == 'KILLED' and own_removed and reverse['status'] == 'KILLED',
          'STARTUP_NATIVE_NEGATIVE_DISCRIMINATION', result, 'production-bound prefix and reverse-guard discrimination are both required')
    return result


def validate_startup_requests(network, spec):
    guard(not any(request.get('handlerError') for request in network['requests']),
          'STARTUP_NATIVE_HTTP_HANDLER', network, 'threaded actual request fixture must complete without handler errors')
    rules = spec.get('rules', [])
    for rule in rules:
        hits = [request for request in network['requests'] if rule['name'] in request.get('rules', [])]
        guard(bool(hits), 'STARTUP_NATIVE_CONTROL_FIXTURE', {'rule': rule, 'hits': network['hits']}, 'every selected fault/delay must hit its actual URL')
        if rule.get('response'):
            guard(any(request.get('controlledFault') == rule['name'] and request.get('status') == rule['response'] for request in hits),
                  'STARTUP_NATIVE_CONTROL_FIXTURE', {'rule': rule, 'hits': hits})
    delayed = [request for request in network['requests'] if request.get('held')]
    if delayed:
        earliest = min(request['start'] for request in delayed)
        release = max(request.get('responseStart', request['end']) for request in delayed)
        independent = [request for request in network['requests'] if not request.get('held')
                       and request['start'] >= earliest and request['end'] < release]
        guard(network['peakActive'] >= 2 and bool(independent) and all(request.get('delayReleased') for request in delayed),
              'STARTUP_NATIVE_INDEPENDENT_DELAYS', {'peakActive': network['peakActive'], 'delayed': delayed,
                                                   'unrelatedCompletedDuringDelay': independent},
              'hold scheduling belongs to independent HTTP handler threads, not serialized synchronous browser routing')


def run_startup_case(context, url, spec, controller, evidence, report):
    name = spec['name']
    scenario = StartupScenario(name, spec.get('rules', []), evidence)
    controller['scenario'] = scenario
    page = context.new_page()
    session = None
    result = {'spec': spec, 'status': 'RUNNING', 'construction': 'actual built homepage/default context/cold cache/native visible Chromium',
              'sourceBinding': 'startup-source-binding.json', 'checkpoints': [], 'cleanup': {}}
    report['startup']['cases'][name] = result
    record = None
    before_retry = None
    try:
        mobile = bool(spec.get('mobile'))
        size = {'width': 390, 'height': 844} if mobile else {'width': 1280, 'height': 900}
        page.set_viewport_size(size)
        session = context.new_cdp_session(page)
        for method, arguments in (
            ('Emulation.setDeviceMetricsOverride', {**size, 'deviceScaleFactor': 3 if mobile else 1, 'mobile': mobile}),
            ('Network.enable', {}), ('Network.setCacheDisabled', {'cacheDisabled': True}),
            ('Network.clearBrowserCache', {}), ('Network.setBypassServiceWorker', {'bypass': True}),
            ('Storage.clearDataForOrigin', {'origin': url.rstrip('/'), 'storageTypes': 'all'})):
            session.send(method, arguments)
        result['cache'] = {'disabled': True, 'browserCacheCleared': True, 'serviceWorkerBypassed': True,
                           'ownedOriginStorageCleared': True, 'responseCacheControl': 'no-store'}
        page.on('console', lambda message: evidence.event('startup-console', {'case': name, 'type': message.type, 'text': message.text}))
        page.on('pageerror', lambda error: evidence.event('startup-pageerror', {'case': name, 'error': str(error)}))
        page.add_init_script(STARTUP_INIT.replace('__STARTUP_CASE__', json.dumps({'control': spec.get('control')})))
        page.bring_to_front()
        page.goto(url, wait_until='domcontentloaded', timeout=60000)
        page.wait_for_function('window.__startupNative?.binding?.actualHandle && window.__DBG__?.solarSystem?.renderer', timeout=60000)
        guard(page.evaluate('document.visibilityState') == 'visible', 'STARTUP_NATIVE_VISIBLE_CONTEXT', {'case': name})
        mode, rate = spec.get('holdMode'), spec.get('rate', 1)
        if rate != 1:
            button = page.locator(f'.time-control-panel button[data-rate="{rate}"]')
            button.focus()
            page.keyboard.press('Enter')
            page.evaluate('rate => { window.__startupNative.ui = {method: "focused actual UI button + Enter", rate, focusedRate: document.activeElement?.dataset.rate}; }', rate)
            page.wait_for_function('rate => window.__DBG__.solarSystem.timeSample.rate === rate', arg=rate, timeout=15000)
            scenario.release('science')
        elif mode == 'visual':
            page.wait_for_function('performance.now() >= window.__DBG__.solarSystem._startup.start + 800', timeout=15000)
            checkpoint = page.evaluate('window.__startupNative.observe()')
            result['checkpoints'].append(checkpoint)
            snapshot = checkpoint['snapshot']
            pending = spec['pending']
            withheld = (snapshot['background']['state'] == 'PENDING' if pending == 'background'
                        else any(slot['state'] == 'PENDING' for slot in snapshot['slots'].values()) if pending == 'manifest'
                        else snapshot['slots'][pending]['state'] == 'PENDING')
            guard(not checkpoint['visible'] and snapshot['firstFrame'] is None and withheld
                  and checkpoint['perf'] < snapshot['deadline'], 'STARTUP_NATIVE_DELAY_BARRIER', checkpoint)
            scenario.release()
        elif mode in ('deadline', 'late-manifest', 'control-deadline'):
            page.wait_for_function('performance.now() >= window.__DBG__.solarSystem._startup.deadline + 250', timeout=20000)
            checkpoint_record = page.evaluate('window.__startupNative.export()')
            result['checkpoints'].append(checkpoint_record['current'])
            if mode == 'deadline':
                validate_startup_wait(checkpoint_record, expired=True)
            elif mode == 'late-manifest':
                checkpoint = checkpoint_record['current']
                guard(all(slot['state'] == 'COMMITTED_FALLBACK' for slot in checkpoint['snapshot']['slots'].values()),
                      'STARTUP_NATIVE_LATE_MANIFEST', checkpoint)
            scenario.release()
        elif mode == 'retry':
            page.wait_for_function('window.__DBG__.solarSystem._startupSnapshot().phase === "DATA_ERROR"', timeout=60000)
            page.wait_for_function('Object.values(window.__DBG__.solarSystem._startupSnapshot().slots).every(slot => slot.state !== "PENDING") && window.__DBG__.solarSystem._startupSnapshot().background.state === "READY"', timeout=20000)
            before_retry = page.evaluate('window.__startupNative.observe()')
            guard(not before_retry['visible'] and before_retry['status']['status'] == 'error', 'STARTUP_NATIVE_ACTUAL_DATA_ERROR', before_retry)
            result['checkpoints'].append(before_retry)
            scenario.faults_enabled = False
            page.get_by_role('button', name='RETRY · 重试', exact=True).click()
        elif mode == 'destroy':
            page.wait_for_function('window.__startupNative.pending().textures >= 11 && window.__startupNative.renders.length > 0', timeout=20000)
            checkpoint = page.evaluate('window.__startupNative.observe()')
            guard(not checkpoint['visible'] and checkpoint['perf'] < checkpoint['snapshot']['deadline'],
                  'STARTUP_NATIVE_CONTROL_FIXTURE', checkpoint, 'actual pending textures must be allocated before destroy/deadline')
            result['checkpoints'].append(checkpoint)
            # Chromium's occupied connection pool cannot issue an unrelated
            # browser request here. An actual unheld server-file response from
            # another client proves handler liveness during the same holds.
            # The browser-only host resolver alias is not visible to urllib.
            # Reach the same measured server port directly from this client.
            with urllib.request.urlopen(f'http://127.0.0.1:{urlparse(url).port}/manifest.webmanifest?startup-independent-witness=' + name,
                                        timeout=10) as witness:
                witness_bytes = witness.read()
                guard(witness.status == 200 and bool(witness_bytes),
                      'STARTUP_NATIVE_INDEPENDENT_DELAYS', {'case': name},
                      'actual unheld metadata witness must complete before hold release')
            page.evaluate('window.__DBG__.solarSystem.destroy()')
            scenario.release()
            page.wait_for_function('window.__startupNative.pending().textures === 0 && window.__startupNative.pending().science === 0 && window.__startupNative.pending().backgroundLateReleases > 0', timeout=60000)
            page.wait_for_timeout(200)
        if spec.get('control') and mode != 'destroy':
            page.wait_for_function('window.__startupNative.control.triggered && window.__startupNative.firstVisible', timeout=60000)
            scenario.release()
        elif mode != 'destroy':
            page.wait_for_function('window.__startupNative.firstVisible?.snapshot?.firstFrame', timeout=60000)
        guard(scenario.drain(), 'STARTUP_NATIVE_HTTP_DRAIN', scenario.snapshot())
        if mode != 'destroy':
            page.wait_for_function('window.__startupNative.pending().textures === 0 && window.__startupNative.pending().science === 0', timeout=60000)
        record = page.evaluate('window.__startupNative.export()')
        network = scenario.snapshot()
        validate_startup_requests(network, spec)
        if spec.get('control'):
            result['negative'] = startup_control_result(record, spec['prefix'])
            result['status'] = 'ACTUAL_GUARD_CONTROL_KILLED_REVERSE_PASS'
        elif mode == 'destroy':
            validate_startup_binding(record)
            validate_startup_dispose(record)
            result['status'] = 'ACTUAL_DESTROY_DRAIN_PASS'
        else:
            validate_startup_published(record, network, rate)
            first = record['firstVisible']['snapshot']
            for slot_name in spec.get('fallbacks', []):
                guard(first['slots'][slot_name]['state'] == 'COMMITTED_FALLBACK', 'STARTUP_NATIVE_EXPECTED_FALLBACK', first['slots'][slot_name])
            if spec.get('backgroundKind'):
                guard(first['background']['kind'] == spec['backgroundKind'], 'STARTUP_NATIVE_EXPECTED_FALLBACK', first['background'])
            if before_retry:
                guard(first['activeMountId'] == before_retry['snapshot']['activeMountId']
                      and first['slots'] == before_retry['snapshot']['slots'] and first['background'] == before_retry['snapshot']['background']
                      and record['calls'].get('_startupRetry', 0) == 1 and record['counters']['scienceCompletions'] >= 2,
                      'STARTUP_NATIVE_CURRENT_INSTANCE_RETRY', {'before': before_retry['snapshot'], 'after': first, 'calls': record['calls']})
                result['retry'] = {'sameActualInstance': True, 'actualRetryUi': True, 'committedVisualChoicesPreserved': True}
            if mode in ('late-manifest', 'deadline'):
                guard(record['current']['snapshot']['slots'] == first['slots']
                      and record['current']['snapshot']['background'] == first['background'],
                      'STARTUP_NATIVE_NO_LATE_HOT_SWAP', record['current']['snapshot'])
            result['firstFrame'] = record['firstFrame']
            result['status'] = 'ACTUAL_STARTUP_CASE_PASS'
    except BaseException as error:
        result['status'] = 'FAIL'
        result['failure'] = {'prefix': getattr(error, 'prefix', 'STARTUP_NATIVE_CASE_EXCEPTION'), 'error': str(error),
                             'metrics': getattr(error, 'metrics', None)}
        evidence.write_bytes(name + '-failure.log', traceback.format_exc().encode())
    finally:
        scenario.release()
        if record is None:
            with contextlib.suppress(Exception):
                record = page.evaluate('window.__startupNative.export()')
        if record:
            payload = (record.get('readback') or {}).pop('rgbaBase64', None)
            if payload:
                pixels = base64.b64decode(payload, validate=True)
                evidence.write_bytes(name + '-first-visible.rgba', pixels)
                evidence.write_bytes(name + '-first-visible.png', png_bytes(record['readback'], pixels))
                record['readback']['artifacts'] = {'rgba': name + '-first-visible.rgba', 'png': name + '-first-visible.png',
                                                 'sha256': hashlib.sha256(pixels).hexdigest()}
            record['originalFunctionSha256'] = {key: hashlib.sha256(value.encode()).hexdigest()
                                               for key, value in record.get('originalFunctions', {}).items()}
            evidence.write_json(name + '-observation.json', record)
            result['observation'] = name + '-observation.json'
            if not spec.get('control') and mode != 'destroy' and result['status'] == 'ACTUAL_STARTUP_CASE_PASS':
                with contextlib.suppress(Exception):
                    screenshot = page.screenshot()
                    evidence.write_bytes(name + '-native.png', screenshot)
                    result['nativeScreenshot'] = {'path': name + '-native.png', 'sha256': hashlib.sha256(screenshot).hexdigest(),
                                                   'sameFirstRenderClaim': False}
        try:
            result['cleanup']['destroy'] = page.evaluate('() => { const solar = window.__DBG__?.solarSystem; if (solar && !solar.disposed) solar.destroy(); return !!solar?.disposed; }')
            cleanup_record = page.evaluate('window.__startupNative.export()')
            cleanup_measurements = {key: cleanup_record.get(key) for key in ('destroy', 'resources', 'counters', 'calls')}
            evidence.write_json(name + '-cleanup-observation.json', cleanup_measurements)
            result['cleanup']['actualCounters'] = name + '-cleanup-observation.json'
            result['cleanup']['restore'] = page.evaluate('window.__startupNative.restore()')
        except Exception as error:
            result['cleanup']['error'] = str(error)
            result['status'] = 'FAIL'
        if session:
            with contextlib.suppress(Exception):
                session.detach()
        page.close()
        result['cleanup']['pageClosed'] = True
        guard(scenario.drain(), 'STARTUP_NATIVE_HTTP_DRAIN', scenario.snapshot())
        network = scenario.snapshot()
        evidence.write_json(name + '-http.json', network)
        result['network'] = name + '-http.json'
        evidence.write_json(name + '-case.json', result)
        evidence.event('startup-case', result)
    return result


def run_startup_cases(context, url, specs, controller, evidence, report):
    for spec in specs:
        run_startup_case(context, url, spec, controller, evidence, report)
    failures = {name: result.get('failure', result.get('cleanup')) for name, result in report['startup']['cases'].items()
                if result['status'] == 'FAIL'}
    guard(not failures, 'STARTUP_NATIVE_CASE_MATRIX', failures, 'all actual startup cases and requested guard controls must pass')
    report['startup']['completedCaseCount'] = len(specs)
    report['startup']['acceptedRates'] = list(STARTUP_RATES)
    report['startup']['negativeDiscrimination'] = 'PASS' if report['negativeControlsRequested'] else 'NOT_EXECUTED'


def run_native(dist, evidence, report, startup=False):
    report['nativeAttempted'] = True
    realtime = import_realtime()
    bundle = None if startup else compile_helper(evidence, report)
    controller = {'scenario': None}
    specs = startup_case_matrix(dist, report['negativeControlsRequested']) if startup else None
    if startup:
        binding = startup_source_binding(dist)
        evidence.write_json('startup-source-binding.json', binding)
        report['startup'].update(method=STARTUP_METHOD, status='RUNNING', cases={}, caseMatrix=specs,
                                 sourceBinding='startup-source-binding.json', testedFullHEAD=binding['testedFullHEAD'],
                                 dirtyBinding=binding['dirtyBinding'], wholeTaskDone=False)
    server = server_thread = display = chrome = playwright_manager = playwright = browser = context = profile = None
    read_fd = write_fd = None
    logs = []
    browser_env_before = os.environ.get('PLAYWRIGHT_BROWSERS_PATH')
    os.environ['PLAYWRIGHT_BROWSERS_PATH'] = browser_env_before or BROWSERS
    native_frames = {}
    try:
        try:
            handler = functools.partial(StartupHTTPHandler, controller=controller, directory=str(dist)) if startup else functools.partial(realtime.QuietHandler, directory=str(dist))
            server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
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
        if startup:
            run_startup_cases(context, url, specs, controller, evidence, report)
        else:
            for mobile in (False, True):
                label = 'mobile' if mobile else 'desktop'
                native_frames[label] = run_widget(context, bundle, url, mobile, realtime, evidence, report)
        if report['negativeControlsRequested'] and not startup:
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
        if startup:
            after = startup_source_binding(dist)
            evidence.write_json('startup-source-binding-after.json', after)
            report['startup']['productionSourceUnchanged'] = after['productionFingerprint'] == binding['productionFingerprint']
            report['startup']['builtFilesUnchanged'] = after['distFiles'] == binding['distFiles']
    if startup:
        guard(report['startup']['productionSourceUnchanged'] and report['startup']['builtFilesUnchanged'],
              'STARTUP_NATIVE_FROZEN_SOURCE', report['startup'], 'in-memory guard controls leave no production/dist edits')
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


class StartupValidatorTests(unittest.TestCase):
    def fixture(self):
        sample = {'utcMs': 1000, 'jdTdb': 2460000, 'rate': 1}
        physical = [1, 0.2, 0.1]
        display = import_realtime().physical_to_display(physical)
        targets, applied, first_targets = {}, {}, {}
        for name in STARTUP_TARGETS:
            position = [display[0] + physical[0] * 1089.68, display[1] + physical[2] * 1089.68,
                        display[2] - physical[1] * 1089.68] if name == 'moon' else list(display)
            targets[name] = {'visible': True, 'position': position}
            applied[name] = {'ok': True, 'error': None, 'lastJd': sample['jdTdb'], 'lastPhysicalPosition': list(physical)}
            first_targets[name] = {**applied[name], 'position': position, 'lastAppliedUtcMs': sample['utcMs']}
        first = {'activeMountId': 7, 'entryUtcMs': 1000, 'sample': sample, 'targets': first_targets, 'renderFrame': 2}
        slots = {name: {'state': 'SUCCESS', 'owner': 7, 'resource': name} for name in STARTUP_SLOTS}
        snapshot = {'activeMountId': 7, 'phase': 'FIRST_VISIBLE', 'slots': slots, 'firstFrame': first,
                    'background': {'state': 'READY', 'kind': 'TEXTURE', 'owner': 7, 'activeMountId': 7, 'resource': 'bg'}}
        visible = {'visible': True, 'wall': 1010, 'snapshot': snapshot, 'sample': sample, 'targets': targets,
                   'status': {'status': 'ready', 'error': None, 'lastAppliedJd': sample['jdTdb'],
                              'lastAppliedUtcMs': sample['utcMs'], 'targets': applied}, 'epochReady': True,
                   'tick': {'enterWall': 1000}, 'sceneBackground': 'bg', 'sameStartupScene': True,
                   'lastRender': {'id': 4, 'before': 1, 'after': 2, 'success': True, 'sameRenderer': True,
                                  'sameScene': True, 'sameCamera': True, 'sample': sample}, 'publishRenderId': 4,
                   'frameInput': {'renderBefore': 1, 'sampleReferenceActual': True, 'sample': sample}}
        return {'syntheticUnitOnly': True, 'firstVisible': visible, 'visibility': [{'visible': False}, {'visible': True, 'hasFirstFrame': True}]}

    def rejected(self, prefix, action):
        with self.assertRaises(GateFailure) as caught:
            action()
        self.assertEqual(caught.exception.prefix, prefix)

    def test_scalar_healthy_startup_shape_not_native_evidence(self):
        record = self.fixture()
        for validator in (validate_startup_atomic, validate_startup_background, validate_startup_science, validate_startup_fresh):
            validator(record)

    def test_guessed_empty_debug_handle_fails(self):
        self.rejected('STARTUP_NATIVE_SOURCE_BINDING', lambda: validate_startup_binding({}))

    def test_no_successful_actual_render_fails(self):
        record = self.fixture()
        record['firstVisible']['lastRender']['success'] = False
        self.rejected(STARTUP_REVEAL, lambda: validate_startup_atomic(record))

    def test_wrong_renderer_or_frame_id_fails(self):
        for key, value in (('sameRenderer', False), ('after', 1), ('id', 99)):
            record = self.fixture()
            record['firstVisible']['lastRender'][key] = value
            self.rejected(STARTUP_REVEAL, lambda: validate_startup_atomic(record))

    def test_staggered_reveal_and_reverse_guard(self):
        record = self.fixture()
        record['visibility'].insert(0, {'visible': True, 'hasFirstFrame': False})
        self.rejected(STARTUP_REVEAL, lambda: validate_startup_atomic(record))
        validate_startup_atomic(record, removed=frozenset([STARTUP_REVEAL]))
        self.rejected(STARTUP_REVEAL, lambda: validate_startup_atomic(record, removed=frozenset([STARTUP_BACKGROUND])))

    def test_fixed_eleven_slot_set_and_ownership(self):
        for change in ('missing', 'pending', 'owner'):
            record = self.fixture()
            slots = record['firstVisible']['snapshot']['slots']
            if change == 'missing':
                slots.pop('earth_clouds')
            else:
                slots['earth']['state' if change == 'pending' else 'owner'] = 'PENDING' if change == 'pending' else None
            self.rejected(STARTUP_REVEAL, lambda: validate_startup_atomic(record))

    def test_initial_unowned_background_and_reverse_guard(self):
        record = self.fixture()
        record['firstVisible']['snapshot']['background']['owner'] = None
        self.rejected(STARTUP_BACKGROUND, lambda: validate_startup_background(record))
        validate_startup_background(record, removed=frozenset([STARTUP_BACKGROUND]))
        self.rejected(STARTUP_BACKGROUND, lambda: validate_startup_background(record, removed=frozenset([STARTUP_REVEAL])))

    def test_mismatched_real_scene_background(self):
        record = self.fixture()
        record['firstVisible']['sceneBackground'] = 'other'
        self.rejected(STARTUP_BACKGROUND, lambda: validate_startup_background(record))

    def test_science_deadline_cannot_assert_fake_ready(self):
        record = self.fixture()
        record['firstVisible']['status']['status'] = 'loading'
        self.rejected(STARTUP_SCIENCE, lambda: validate_startup_science(record))
        validate_startup_science(record, removed=frozenset([STARTUP_SCIENCE]))
        self.rejected(STARTUP_SCIENCE, lambda: validate_startup_science(record, removed=frozenset([STARTUP_FRESH])))

    def test_exact_ten_target_ids_required(self):
        record = self.fixture()
        record['firstVisible']['targets'].pop('halley')
        self.rejected(STARTUP_SCIENCE, lambda: validate_startup_science(record))

    def test_actual_applied_utc_jd_must_match(self):
        for key in ('lastAppliedJd', 'lastAppliedUtcMs'):
            record = self.fixture()
            record['firstVisible']['status'][key] += 1
            self.rejected(STARTUP_SCIENCE, lambda: validate_startup_science(record))

    def test_actual_physical_position_not_zero_or_nonfinite(self):
        for physical in ([0, 0, 0], [None, 0, 1]):
            record = self.fixture()
            record['firstVisible']['status']['targets']['mars']['lastPhysicalPosition'] = physical
            self.rejected(STARTUP_SCIENCE, lambda: validate_startup_science(record))

    def test_applied_display_position_is_not_merely_ok_status(self):
        record = self.fixture()
        record['firstVisible']['targets']['moon']['position'][0] += 0.01
        self.rejected(STARTUP_SCIENCE, lambda: validate_startup_science(record))

    def test_firstframe_targets_use_same_physical_sample(self):
        record = self.fixture()
        record['firstVisible']['snapshot']['firstFrame']['targets']['earth']['lastAppliedUtcMs'] = 0
        self.rejected(STARTUP_SCIENCE, lambda: validate_startup_science(record))

    def test_freshness_boundary_and_supported_rates(self):
        for rate in STARTUP_RATES:
            record = self.fixture()
            record['firstVisible']['sample']['rate'] = rate
            validate_startup_fresh(record)
        record = self.fixture()
        record['firstVisible']['sample']['utcMs'] = 1016.7
        record['firstVisible']['wall'] = 1020
        validate_startup_fresh(record)

    def test_freshness_float64_boundaries_and_just_outside(self):
        for entry in (1000, 1_793_664_000_000):
            for direction in (-1, 1):
                with self.subTest(entry=entry, direction=direction):
                    record = self.fixture()
                    visible = record['firstVisible']
                    visible['snapshot']['firstFrame']['entryUtcMs'] = entry
                    visible['tick']['enterWall'] = entry - 20
                    visible['wall'] = entry + 20
                    boundary = entry + direction * 16.7
                    visible['sample']['utcMs'] = boundary
                    validate_startup_fresh(record)
                    visible['sample']['utcMs'] = math.nextafter(boundary, direction * math.inf)
                    self.rejected(STARTUP_FRESH, lambda: validate_startup_fresh(record))

    def test_freshness_epoch_scale_integer_stale_controls(self):
        entry = 1_793_664_000_000
        for offset in (-1000, -17, -16, 0, 16, 17, 1000):
            with self.subTest(offset=offset):
                record = self.fixture()
                visible = record['firstVisible']
                visible['snapshot']['firstFrame']['entryUtcMs'] = entry
                visible['tick']['enterWall'] = entry - 1000
                visible['wall'] = entry + 1000
                visible['sample']['utcMs'] = entry + offset
                if abs(offset) <= 16.7:
                    validate_startup_fresh(record)
                else:
                    self.rejected(STARTUP_FRESH, lambda: validate_startup_fresh(record))

    def test_stale_entry_and_reverse_guard(self):
        record = self.fixture()
        record['firstVisible']['snapshot']['firstFrame']['entryUtcMs'] = 1030
        record['firstVisible']['tick']['enterWall'] = 1030
        record['firstVisible']['wall'] = 1040
        self.rejected(STARTUP_FRESH, lambda: validate_startup_fresh(record))
        validate_startup_fresh(record, removed=frozenset([STARTUP_FRESH]))
        self.rejected(STARTUP_FRESH, lambda: validate_startup_fresh(record, removed=frozenset([STARTUP_SCIENCE])))

    def test_unsupported_rate_fails(self):
        record = self.fixture()
        record['firstVisible']['sample']['rate'] = 2
        self.rejected(STARTUP_FRESH, lambda: validate_startup_fresh(record))

    def disposal(self):
        return {'syntheticUnitOnly': True, 'destroy': {'disposed': True, 'phase': 'DISPOSED', 'active': False,
                'canvasConnected': False, 'sceneChildren': 0, 'pendingOwnedRaf': 0, 'sceneBackground': 'bg',
                'baselineBackground': 'bg', 'pendingTextureCallbacks': 0, 'sciencePromisesPending': 0},
                'resources': [{'uuid': kind, 'kind': kind, 'fromTrack': True, 'disposeCalls': 1}
                              for kind in ('texture', 'geometry', 'material')],
                'counters': {'lateTextureCallbacks': 11, 'releaseAfterDestroy': 12}}

    def test_nonempty_actual_registry_required(self):
        record = self.disposal()
        validate_startup_dispose(record)
        record['resources'] = []
        self.rejected(STARTUP_DISPOSE, lambda: validate_startup_dispose(record))

    def test_late_callback_and_ghost_discrimination(self):
        for key in ('trackAfterDestroy', 'renderAfterDestroy', 'rafScheduledAfterDestroy', 'lateBindingChanges'):
            record = self.disposal()
            record['counters'][key] = 1
            self.rejected(STARTUP_DISPOSE, lambda: validate_startup_dispose(record))
            validate_startup_dispose(record, removed=frozenset([STARTUP_DISPOSE]))
            self.rejected(STARTUP_DISPOSE, lambda: validate_startup_dispose(record, removed=frozenset([STARTUP_REVEAL])))

    def test_callbacks_must_really_drain_and_resource_dispose_once(self):
        for key in ('pendingTextureCallbacks', 'sciencePromisesPending', 'pendingOwnedRaf'):
            record = self.disposal()
            record['destroy'][key] = 1
            self.rejected(STARTUP_DISPOSE, lambda: validate_startup_dispose(record))
        record = self.disposal()
        record['resources'][0]['disposeCalls'] = 2
        self.rejected(STARTUP_DISPOSE, lambda: validate_startup_dispose(record))

    def test_fake_corpus_and_missing_control_fixture_are_not_kills(self):
        self.rejected('STARTUP_NATIVE_CORPUS_BINDING', lambda: validate_startup_corpus({'requests': []}))
        self.rejected('STARTUP_NATIVE_SOURCE_BINDING', lambda: startup_control_result({}, STARTUP_REVEAL))


def run_self_tests(evidence):
    stream = io.StringIO()
    suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(test_class)
                               for test_class in (ValidatorTests, StartupValidatorTests))
    result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
    log = stream.getvalue()
    evidence.write_bytes('validator-unit-tests.log', log.encode())
    sys.stdout.write(log)
    return {'kind': 'Sun-and-startup-synthetic-validator-unit-tests-only-not-native-or-physical-evidence',
            'testsRun': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors), 'ok': result.wasSuccessful()}


def absolute_path(value):
    path = Path(value)
    if not path.is_absolute():
        raise argparse.ArgumentTypeError('an absolute path is required')
    return path.resolve()


def main(argv=None):
    parser = argparse.ArgumentParser(description='Actual native Sun or atomic startup acceptance; neither mode closes the whole task.')
    parser.add_argument('--dist', type=absolute_path)
    parser.add_argument('--output', type=absolute_path, required=True)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--sun-only', action='store_true', help='Standalone unchanged Sun gates; never accepts startup')
    modes.add_argument('--startup-only', action='store_true', help='Actual cold native atomic startup, fault, retry and teardown gates')
    parser.add_argument('--negative-controls', action='store_true')
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--replay', type=absolute_path)
    arguments = parser.parse_args(argv)
    if arguments.output == REPOSITORY or REPOSITORY in arguments.output.parents:
        parser.error('--output must be an appended evidence run outside the production worktree')
    if not arguments.self_test and arguments.dist is None:
        parser.error('--dist ABS is required')
    if not arguments.self_test and not (arguments.sun_only or arguments.startup_only):
        parser.error('explicit --sun-only or --startup-only is required')
    if arguments.startup_only and arguments.replay:
        parser.error('--startup-only requires actual native execution, not replay')
    evidence = Evidence(arguments.output)
    report = {'mode': 'validator-unit-tests' if arguments.self_test else ('actual-visible-native-startup-only' if arguments.startup_only else 'actual-visible-native-Sun-only'),
              'startup': {'status': 'NOT_EXECUTED' if arguments.startup_only else 'NOT_EVALUATED_SUN_ONLY', 'wholeTaskDone': False},
              'sunOnly': arguments.sun_only, 'startupOnly': arguments.startup_only, 'negativeControlsRequested': arguments.negative_controls,
              'nativeAttempted': False, 'commands': [], 'widgets': {}, 'console_errors': [], 'processes': {}, 'cleanup': {},
              'routes': {'syntheticNonScientificApis': [], 'blockedNonlocal': [], 'actualLocal': []},
              'humanAesthetics': {'status': 'NOT_ASSESSED', 'approvalClaim': False}}
    exit_code = 1
    print('STARTUP_ONLY: actual native observation; whole-task acceptance remains with parent.' if arguments.startup_only
          else 'SUN_ONLY / SELF_TEST: standalone gates do not accept startup.', flush=True)
    try:
        if arguments.self_test:
            report['selfTests'] = run_self_tests(evidence)
            guard(report['selfTests']['ok'], 'SUN_NATIVE_VALIDATOR_UNIT_TESTS', report['selfTests'])
            report['status'] = 'UNIT_TESTS_PASS_NOT_NATIVE_ACCEPTANCE'
        else:
            guard(arguments.dist.is_dir() and (arguments.dist / 'index.html').is_file(),
                  'SUN_NATIVE_ACTUAL_DIST', {'dist': str(arguments.dist)}, 'existing actual built frontend-dist is required')
            report['dist'] = str(arguments.dist)
            if arguments.replay:
                replay_artifacts(arguments.replay, evidence, report)
                report['status'] = 'RAW_REPLAY_PASS_SUN_ONLY'
            else:
                run_native(arguments.dist, evidence, report, startup=arguments.startup_only)
                if arguments.startup_only:
                    report['status'] = 'NATIVE_STARTUP_ONLY_PASS' if arguments.negative_controls else 'STARTUP_HEALTHY_WITHOUT_DISCRIMINATION'
                    report['startup']['status'] = report['status']
                else:
                    report['status'] = 'NATIVE_SUN_ONLY_PASS' if arguments.negative_controls else 'SUN_ONLY_HEALTHY_WITHOUT_DISCRIMINATION'
        exit_code = 0
    except BaseException as error:
        prefix = getattr(error, 'prefix', 'SUN_NATIVE_RUNNER_EXCEPTION')
        report['failure'] = {'prefix': prefix, 'metrics': getattr(error, 'metrics', None), 'error': str(error)}
        report['status'] = 'BLOCKED_PARENT_LOCAL_SOCKET' if prefix == 'SUN_NATIVE_LOCAL_SOCKET' else 'FAIL'
        if arguments.startup_only:
            report['startup']['status'] = 'NOT_EXECUTED_PARENT_LOCAL_SOCKET' if prefix == 'SUN_NATIVE_LOCAL_SOCKET' else 'FAIL'
        exit_code = 3 if prefix == 'SUN_NATIVE_LOCAL_SOCKET' else 1
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
