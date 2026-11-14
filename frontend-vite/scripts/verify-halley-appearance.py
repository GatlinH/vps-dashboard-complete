import argparse
import base64
import functools
import importlib.util
import json
import os
import select
import socket
import struct
import subprocess
import tempfile
import threading
import time
import traceback
import urllib.request
import zlib
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


spec = importlib.util.spec_from_file_location(
    'frozen_realtime_gate', Path(__file__).with_name('solar-realtime-browser.py'))
realtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(realtime)

FRAME_READY = '''after => {
  const s = window.__DBG__?.solarSystem, c = window.__boundFrameCall;
  const d = s?.dustTailRenderer;
  return document.visibilityState === 'visible' && c?.id > 0 &&
    s.renderer.info.render.frame > Math.max(1, after, c.renderFrameBefore) &&
    c.status.status === 'ready' && Object.keys(c.status.targets).length === 10 &&
    Object.values(c.status.targets).every(t => t.ok && t.lastJd === c.sample.jdTdb) &&
    d?.visibleCount > 0 && d.geometry?.drawRange.count > 0 &&
    s.dustTailManager?.inFlight === false && !s.dustTailManager?.latestPending;
}'''

PRODUCTION_GATE = r'''negativeControls => {
  const s = window.__DBG__.solarSystem, tail = s.dustTailRenderer;
  const renderer = s.renderer, points = tail?.points, geometry = tail?.geometry;
  function requireGeometry() {
    if (!points || !geometry?.attributes.position || !tail.visibleCount || !geometry.drawRange.count)
      throw new Error('GEOMETRY_MISSING');
  }
  requireGeometry();
  const position = geometry.attributes.position, color = geometry.attributes.color;
  if (!color || color.itemSize !== 4 || !tail.material.vertexColors)
    throw new Error('DENSE_UNBOUNDED: production RGBA vertex alpha missing');
  if (!Array.from(position.array.slice(0, tail.visibleCount * 3)).every(Number.isFinite))
    throw new Error('SOURCE_DATA_NONFINITE');
  const material = tail.material, gl = renderer.getContext();
  const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
  const saved = {
    running: s.running, frameId: s.frameId, positions: position.array.slice(),
    colors: color.array.slice(), drawStart: geometry.drawRange.start,
    drawCount: geometry.drawRange.count, count: tail.visibleCount,
    map: material.map, mapData: material.map?.image.data?.slice(),
    size: material.size, attenuation: material.sizeAttenuation,
    opacity: material.opacity, vertexColors: material.vertexColors,
    visible: points.visible, parent: points.parent,
    parentIndex: points.parent.children.indexOf(points),
    pointPosition: points.position.clone(), quaternion: points.quaternion.clone(),
    scale: points.scale.clone(), matrix: points.matrix.clone(), world: points.matrixWorld.clone(),
    matrixAutoUpdate: points.matrixAutoUpdate,
    matrixWorldAutoUpdate: points.matrixWorldAutoUpdate,
    matrixWorldNeedsUpdate: points.matrixWorldNeedsUpdate,
    camera: s.camera.clone(), cameraTarget: s.cameraTarget.clone(),
    epoch: JSON.stringify([s.timeSample, s.simulationTime, s.ephemerisStatus]),
    viewport: renderer.getViewport({copy(v) {return Object.assign(this, v);}}),
    scissor: renderer.getScissor({copy(v) {return Object.assign(this, v);}}),
    scissorTest: renderer.getScissorTest(), target: renderer.getRenderTarget(),
    autoClear: renderer.autoClear,
    nucleusVisible: s.halley.nucleus.visible, cometVisible: s.halley.group.visible
  };
  const channelBits = [gl.RED_BITS, gl.GREEN_BITS, gl.BLUE_BITS, gl.ALPHA_BITS].map(channel => gl.getParameter(channel));
  if (!channelBits.every(bits => bits === 8)) throw new Error('RGBA8_BUFFER_REQUIRED');
  const results = {context: 'live-current-ephemeris-original-view', epoch: s.timeSample, visibleCount: tail.visibleCount, channelBits, controls: []};
  const equal = (left, right) => left.length === right.length && left.every((v, i) => Object.is(v, right[i]));
  const read = () => {
    const data = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('GPU_READ_FAILED');
    return data;
  };
  const png = () => renderer.domElement.toDataURL('image/png').split(',')[1];
  function restoreBuffers() {
    position.array.set(saved.positions);
    color.array.set(saved.colors);
    position.needsUpdate = color.needsUpdate = true;
    geometry.setDrawRange(saved.drawStart, saved.drawCount);
    tail.visibleCount = saved.count;
  }
  function restoreMaterial() {
    material.map = saved.map;
    if (saved.mapData) {
      saved.map.image.data.set(saved.mapData);
      saved.map.needsUpdate = true;
    }
    material.size = saved.size;
    material.sizeAttenuation = saved.attenuation;
    material.opacity = saved.opacity;
    material.vertexColors = saved.vertexColors;
    material.needsUpdate = true;
    points.visible = saved.visible;
    s.halley.nucleus.visible = saved.nucleusVisible;
    s.halley.group.visible = saved.cometVisible;
  }
  function restorePoints() {
    if (points.parent !== saved.parent) {
      saved.parent.add(points);
      saved.parent.children.splice(saved.parent.children.indexOf(points), 1);
      saved.parent.children.splice(saved.parentIndex, 0, points);
    }
    points.position.copy(saved.pointPosition);
    points.quaternion.copy(saved.quaternion);
    points.scale.copy(saved.scale);
    points.matrix.copy(saved.matrix);
    points.matrixWorld.copy(saved.world);
    points.matrixAutoUpdate = saved.matrixAutoUpdate;
    points.matrixWorldAutoUpdate = saved.matrixWorldAutoUpdate;
    points.matrixWorldNeedsUpdate = saved.matrixWorldNeedsUpdate;
  }
  function originalView() {
    return JSON.stringify({camera: s.camera.toJSON(), cameraTarget: s.cameraTarget.toArray(),
      width: gl.drawingBufferWidth, height: gl.drawingBufferHeight,
      position: points.position.toArray(), quaternion: points.quaternion.toArray(), scale: points.scale.toArray()});
  }
  function difference(on, off) {
    let differingPixels = 0, totalDelta = 0;
    for (let offset = 0; offset < on.length; offset += 4) {
      const delta = Math.abs(on[offset] - off[offset]) + Math.abs(on[offset + 1] - off[offset + 1]) + Math.abs(on[offset + 2] - off[offset + 2]);
      if (delta) differingPixels += 1;
      totalDelta += delta;
    }
    return {differingPixels, totalDelta, width, height};
  }
  function layerSignal(capture = false, wholeComet = false) {
    requireGeometry();
    const viewBefore = originalView();
    const before = JSON.stringify([s.timeSample, s.simulationTime, s.ephemerisStatus]);
    const positionsBefore = position.array.slice(), colorsBefore = color.array.slice();
    const originalVisible = points.visible, originalCometVisible = s.halley.group.visible;
    let on, off, onPng, offPng;
    try {
      renderer.render(s.scene, s.camera);
      on = read();
      if (capture) onPng = png();
      points.visible = false;
      if (wholeComet) s.halley.group.visible = false;
      renderer.render(s.scene, s.camera);
      off = read();
      if (capture) offPng = png();
    } finally {
      points.visible = originalVisible;
      s.halley.group.visible = originalCometVisible;
    }
    if (viewBefore !== originalView() || before !== JSON.stringify([s.timeSample, s.simulationTime, s.ephemerisStatus]) ||
        !equal(positionsBefore, position.array) || !equal(colorsBefore, color.array))
      throw new Error('FROZEN_FRAME_CHANGED');
    const evidence = {...difference(on, off), onPng, offPng, epoch: s.timeSample,
      context: wholeComet ? 'live-original-view-whole-comet' : 'live-original-view-tail'};
    if (!evidence.totalDelta) {
      const error = new Error('LAYER_SIGNAL_MISSING');
      error.evidence = evidence;
      throw error;
    }
    return evidence;
  }
  function unoccludedLayerSignal(capture = false) {
    const nucleusVisible = s.halley.nucleus.visible;
    try {
      s.halley.nucleus.visible = false;
      return {...layerSignal(capture), context: 'live-original-view-tail-without-nucleus'};
    } finally {
      s.halley.nucleus.visible = nucleusVisible;
    }
  }
  function liveSignal() {
    const liveView = originalView();
    try {
      results.layer = layerSignal(true);
    } catch (error) {
      if (!String(error.message).startsWith('LAYER_SIGNAL_MISSING') || !s.isMobile) throw error;
      results.layer = error.evidence;
      try {
        results.mobileUnoccludedTail = unoccludedLayerSignal(true);
        results.mobileWholeComet = layerSignal(true, true);
        if (liveView !== originalView() || !equal(saved.positions, position.array) || !equal(saved.colors, color.array))
          throw new Error('ORIGINAL_VIEW_CHANGED');
        results.mobileOcclusionVerification = {originalView: JSON.parse(liveView), positionsPreserved: true, colorsPreserved: true};
        results.witness = 'WITNESS_HALLEY_MOBILE_OCCLUSION_CONFIRMED';
      } catch (witnessError) {
        if (witnessError.evidence) results.mobileFailedWitness = witnessError.evidence;
        throw new Error('ERR_SIGNAL_OCCLUSION_UNVERIFIED: ' + witnessError.message);
      }
    }
  }

  const probeScene = new s.scene.constructor();
  probeScene.background = new material.color.constructor(0);
  const probeCamera = s.camera.clone();
  probeCamera.position.set(0, 0, 10);
  probeCamera.quaternion.identity();
  probeCamera.aspect = width / height;
  probeCamera.lookAt(0, 0, 0);
  probeCamera.updateProjectionMatrix();
  probeCamera.updateMatrixWorld(true);
  function probe(prepare = true) {
    requireGeometry();
    const probeMap = material.map;
    try {
      probeScene.add(points);
      points.position.set(0, 0, 0);
      points.quaternion.identity();
      points.scale.set(1, 1, 1);
      points.matrixAutoUpdate = points.matrixWorldAutoUpdate = true;
      position.setXYZ(0, 0, 0, 0);
      position.needsUpdate = true;
      geometry.setDrawRange(0, 1);
      tail.visibleCount = 1;
      material.size = 32 / renderer.getPixelRatio();
      material.sizeAttenuation = false;
      if (prepare) tail.prepareFrame(probeCamera, renderer);
      material.map = null;
      material.needsUpdate = true;
      renderer.render(probeScene, probeCamera);
      const square = read();
      let minX = width, minY = height, maxX = -1, maxY = -1;
      for (let vertical = 0; vertical < height; vertical += 1) {
        for (let horizontal = 0; horizontal < width; horizontal += 1) {
          const offset = (vertical * width + horizontal) * 4;
          if (square[offset] || square[offset + 1] || square[offset + 2]) {
            minX = Math.min(minX, horizontal); maxX = Math.max(maxX, horizontal);
            minY = Math.min(minY, vertical); maxY = Math.max(maxY, vertical);
          }
        }
      }
      if (maxX < 0) throw new Error('LAYER_SIGNAL_MISSING: probe square has no signal');
      if (maxX - minX + 1 !== 32 || maxY - minY + 1 !== 32)
        throw new Error('PROBE_FOOTPRINT_MISMATCH');
      const centreX = (minX + maxX + 1) / 2, centreY = (minY + maxY + 1) / 2;
      const projected = points.position.clone().applyMatrix4(points.matrixWorld).project(probeCamera);
      const expectedX = (projected.x + 1) * width / 2, expectedY = (projected.y + 1) * height / 2;
      if (Math.abs(expectedX - centreX) > 0.5 || Math.abs(expectedY - centreY) > 0.5)
        throw new Error('PROBE_CENTRE_MISMATCH');
      material.map = probeMap;
      material.needsUpdate = true;
      renderer.render(probeScene, probeCamera);
      const masked = read(), crop = [], quadrantCorners = [0, 0, 0, 0];
      let cornerSignal = 0, coreSignal = 0;
      const filteringGuard = 2 * Math.SQRT2 / 31;
      for (let vertical = minY; vertical <= maxY; vertical += 1) {
        for (let horizontal = minX; horizontal <= maxX; horizontal += 1) {
          const offset = (vertical * width + horizontal) * 4;
          crop.push(...masked.subarray(offset, offset + 4));
          const radius = Math.hypot((horizontal + 0.5 - centreX) / 16, (vertical + 0.5 - centreY) / 16);
          const signal = masked[offset] + masked[offset + 1] + masked[offset + 2];
          if (radius > 1 + filteringGuard) {
            quadrantCorners[(vertical + 0.5 >= centreY ? 2 : 0) + (horizontal + 0.5 >= centreX ? 1 : 0)] += 1;
            cornerSignal += signal;
          } else if (radius < 1 - filteringGuard) coreSignal += signal;
        }
      }
      if (!quadrantCorners.every(count => count > 0)) throw new Error('PROBE_CORNER_REGION_MISSING');
      if (!coreSignal) throw new Error('LAYER_SIGNAL_MISSING: radial probe empty');
      if (cornerSignal) throw new Error((probeMap ? 'SQUARE_SUPPORT' : 'MASK_MISSING') + ': actual production GPU corners leak');
      return {context: 'synthetic-unoccluded-production-mask-32-GPU-px-not-live-ephemeris', size: 32, centreX, centreY, expectedX, expectedY, quadrantCorners, cornerSignal, coreSignal, filteringGuard, rgba: crop};
    } finally {
      restorePoints();
      restoreBuffers();
      restoreMaterial();
    }
  }
  function denseProbe() {
    const instance = new tail.constructor({scene: probeScene, physicalToDisplay: tail.physicalToDisplay});
    try {
      const physical = new Float32Array(5 * 201 * 3), physicalBefore = physical.slice();
      instance.update(physical, 201);
      const attribute = instance.geometry.attributes.position, original = attribute.array.slice();
      const version = attribute.version, drawRange = {...instance.geometry.drawRange};
      instance.material.size = saved.size / renderer.getPixelRatio();
      instance.material.sizeAttenuation = false;
      instance.prepareFrame(probeCamera, renderer);
      if (!equal(physical, physicalBefore) || !equal(attribute.array, original) || attribute.version !== version ||
          instance.visibleCount !== 804 || JSON.stringify(drawRange) !== JSON.stringify(instance.geometry.drawRange))
        throw new Error('POSITION_MUTATED');
      const alphas = Array.from({length: instance.visibleCount}, (_, index) => instance.material.opacity * instance.geometry.attributes.color.getW(index));
      const representatives = alphas.filter(alpha => alpha > 0), totalAlpha = alphas.reduce((sum, alpha) => sum + alpha, 0);
      if (totalAlpha > 0.55 + 0.55 * 2 ** -23) throw new Error('DENSE_UNBOUNDED');
      if (representatives.length !== 1 || totalAlpha !== 0.55) throw new Error('DISPLAY_GROUP_MISSING');
      function denseSignal(capture = false) {
        const visible = instance.points.visible;
        let on, off, onPng, offPng;
        try {
          renderer.render(probeScene, probeCamera); on = read();
          if (capture) onPng = png();
          instance.points.visible = false;
          renderer.render(probeScene, probeCamera); off = read();
          if (capture) offPng = png();
        } finally {instance.points.visible = visible;}
        const evidence = {...difference(on, off), onPng, offPng};
        if (!evidence.totalDelta) throw new Error('LAYER_SIGNAL_MISSING: actual RGBA8 dense production fixture');
        return evidence;
      }
      const signal = denseSignal(true);
      if (negativeControls) {
        const colors = instance.geometry.attributes.color, originalColors = colors.array.slice();
        negative('zero-dense-production-alpha', 'LAYER_SIGNAL_MISSING', () => {
          for (let index = 0; index < instance.visibleCount; index += 1) colors.setW(index, 0);
          colors.needsUpdate = true;
        }, denseSignal);
        colors.array.set(originalColors); colors.needsUpdate = true;
        negative('hidden-dense-production-layer', 'LAYER_SIGNAL_MISSING', () => {instance.points.visible = false;}, denseSignal);
        instance.points.visible = true;
      }
      return {...signal, context: 'synthetic-coincident-804-production-RGBA8-not-live-ephemeris',
        channelBits, sourceCount: 804, representativeCount: representatives.length, totalAlpha,
        pointDiameterGPU: saved.size, positionsPreserved: true, physicalPreserved: true, drawRange};
    } finally {instance.dispose();}
  }
  function negative(name, expected, mutate, check) {
    try {
      mutate();
      check();
      throw new Error('NEGATIVE_CONTROL_ACCEPTED: ' + name);
    } catch (error) {
      if (!String(error.message).startsWith(expected)) throw error;
      results.controls.push({name, rejected: true, error: error.message});
    } finally {
      restorePoints(); restoreBuffers(); restoreMaterial();
    }
  }
  try {
    s.pause();
    renderer.setRenderTarget(null);
    renderer.setViewport(0, 0, width / renderer.getPixelRatio(), height / renderer.getPixelRatio());
    renderer.setScissorTest(false);
    renderer.autoClear = true;
    liveSignal();
    results.probe = probe();
    results.denseProbe = denseProbe();
    if (negativeControls) {
      negative('missing-production-map', 'MASK_MISSING', () => {material.map = null; material.needsUpdate = true;}, probe);
      negative('opaque-production-map', 'SQUARE_SUPPORT', () => {
        material.map.image.data.fill(255); material.map.needsUpdate = true;
      }, probe);
      negative('zero-production-alpha', 'LAYER_SIGNAL_MISSING', () => {
        for (let index = 0; index < tail.visibleCount; index += 1) color.setW(index, 0);
        color.needsUpdate = true;
      }, unoccludedLayerSignal);
      negative('hidden-production-layer', 'LAYER_SIGNAL_MISSING', () => {points.visible = false;}, unoccludedLayerSignal);
      negative('zero-production-probe-alpha', 'LAYER_SIGNAL_MISSING', () => {
        for (let index = 0; index < tail.visibleCount; index += 1) color.setW(index, 0);
        color.needsUpdate = true;
      }, () => probe(false));
      negative('hidden-production-probe-layer', 'LAYER_SIGNAL_MISSING', () => {points.visible = false;}, () => probe(false));
      negative('absent-production-geometry', 'GEOMETRY_MISSING', () => {geometry.setDrawRange(0, 0);}, layerSignal);
    }
    const baselineMemory = {...renderer.info.memory};
    results.lifecycle = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const instance = new tail.constructor({scene: probeScene, physicalToDisplay: tail.physicalToDisplay});
      try {
        instance.update(new Float32Array(15), 1);
        instance.prepareFrame(probeCamera, renderer);
        renderer.render(probeScene, probeCamera);
      } finally {
        instance.dispose(); instance.dispose();
      }
      const memory = {...renderer.info.memory};
      if (memory.geometries !== baselineMemory.geometries || memory.textures !== baselineMemory.textures)
        throw new Error('RESOURCE_LEAK');
      results.lifecycle.push({cycle, baselineMemory, memory});
    }
    if (saved.epoch !== JSON.stringify([s.timeSample, s.simulationTime, s.ephemerisStatus]))
      throw new Error('FROZEN_FRAME_CHANGED');
    return results;
  } catch (error) {
    if (error.evidence) results.layer = error.evidence;
    results.error = String(error.stack || error);
    return results;
  } finally {
    restorePoints(); restoreBuffers(); restoreMaterial();
    renderer.setRenderTarget(saved.target);
    renderer.setViewport(saved.viewport.x, saved.viewport.y, saved.viewport.z, saved.viewport.w);
    renderer.setScissor(saved.scissor.x, saved.scissor.y, saved.scissor.z, saved.scissor.w);
    renderer.setScissorTest(saved.scissorTest);
    renderer.autoClear = saved.autoClear;
    s.camera.copy(saved.camera);
    s.cameraTarget.copy(saved.cameraTarget);
    renderer.render(s.scene, s.camera);
    s.running = saved.running;
    if (saved.running) s.frameId = requestAnimationFrame(s._tick);
    if (!equal(position.array, saved.positions) || !equal(color.array, saved.colors))
      throw new Error('RESTORATION_FAILED');
  }
}'''


def png_size(data):
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'PNG_CAPTURE_INVALID'
    return list(struct.unpack('>II', data[16:24]))


def rgba_png(size, values):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    rows = bytes(values)
    raw = b''.join(b'\0' + rows[row * size * 4:(row + 1) * size * 4]
                   for row in reversed(range(size)))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def main():
    parser = argparse.ArgumentParser(description='Local production Halley GPU/support gate; wide-view aesthetics require independent inspection.')
    parser.add_argument('--dist', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--negative-controls', action='store_true')
    args = parser.parse_args()
    output = Path(args.output)
    assert output.is_absolute() and not output.exists(), 'Use a fresh absolute evidence directory'
    dist = Path(args.dist).resolve()
    assert (dist / 'index.html').is_file(), 'BUILT_FRONTEND_MISSING'
    output.mkdir(parents=True)
    records = []
    browser = chrome = display = server = None
    previous_display = os.environ.get('DISPLAY')
    handles = []

    def record(step, value):
        records.append({'step': step, 'recordedUtcMs': time.time_ns() // 1000000, 'value': value})
        (output / 'browser-results.json').write_text(json.dumps(records, indent=2) + '\n')

    try:
        server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(realtime.QuietHandler, directory=str(dist)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f'http://solar-realtime.test:{server.server_port}/'
        read_fd, write_fd = os.pipe()
        display_log = open(output / 'xvfb.stderr', 'wb')
        handles.append(display_log)
        try:
            display = subprocess.Popen(['Xvfb', '-displayfd', str(write_fd), '-screen', '0', '1280x1000x24', '-nolisten', 'tcp'], pass_fds=(write_fd,), stdout=subprocess.DEVNULL, stderr=display_log)
        finally:
            os.close(write_fd)
        try:
            assert select.select([read_fd], [], [], 10)[0], 'XVFB_READINESS_FAILED'
            display_number = os.read(read_fd, 100).decode().strip()
        finally:
            os.close(read_fd)
        assert display_number.isdigit(), 'XVFB_DISPLAY_INVALID'
        os.environ['DISPLAY'] = ':' + display_number
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright, tempfile.TemporaryDirectory(prefix='halley-native-', dir=os.environ.get('TMPDIR')) as temporary:
            with socket.socket() as port_socket:
                port_socket.bind(('127.0.0.1', 0))
                cdp_port = port_socket.getsockname()[1]
            chrome_log = open(output / 'chromium.stderr', 'wb')
            handles.append(chrome_log)
            chrome = subprocess.Popen([
                playwright.chromium.executable_path, '--no-sandbox', '--no-first-run',
                '--no-default-browser-check', '--disable-dev-shm-usage',
                '--remote-debugging-port=' + str(cdp_port), '--user-data-dir=' + str(Path(temporary) / 'profile'),
                '--host-resolver-rules=MAP solar-realtime.test 127.0.0.1', '--no-proxy-server',
                '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'
            ], stdout=subprocess.DEVNULL, stderr=chrome_log)
            deadline = time.monotonic() + 15
            while True:
                try:
                    urllib.request.urlopen(f'http://127.0.0.1:{cdp_port}/json/version', timeout=1).close()
                    break
                except Exception as error:
                    if chrome.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError('STANDALONE_CDP_FAILED: ' + repr(error)) from error
                    time.sleep(.1)
            browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{cdp_port}', no_defaults=True)
            context = browser.contexts[0]
            context.add_init_script(realtime.INIT)

            def local_only(route):
                request = urlparse(route.request.url)
                if request.hostname != 'solar-realtime.test' or request.port != server.server_port:
                    route.abort()
                elif request.path.startswith('/api/'):
                    route.fulfill(content_type='application/json', body=json.dumps({'success': True, 'servers': [], 'data': []}))
                else:
                    route.continue_()

            context.route('**/*', local_only)
            record('execution-binding', {'standaloneCDP': True, 'nativeDefaultContext': True, 'no_defaults': True, 'httpPort': server.server_port, 'cdpPort': cdp_port, 'dist': str(dist)})
            activation = browser.new_browser_cdp_session()
            for name, width, height, dpr, mobile in [('desktop', 1280, 900, 1, False), ('mobile', 390, 844, 3, True)]:
                page = context.new_page()
                session = context.new_cdp_session(page)
                target_id = session.send('Target.getTargetInfo')['targetInfo']['targetId']
                session.send('Emulation.setDeviceMetricsOverride', {'width': width, 'height': height, 'deviceScaleFactor': dpr, 'mobile': mobile})
                activation.send('Target.activateTarget', {'targetId': target_id})
                session.send('Page.bringToFront')
                page.wait_for_function('document.visibilityState === "visible"', polling=100, timeout=10000)
                page.goto(url)
                if mobile:
                    page.reload()
                activation.send('Target.activateTarget', {'targetId': target_id})
                page.wait_for_function('document.visibilityState === "visible"', polling=100, timeout=10000)
                page.evaluate('window.dispatchEvent(new Event("resize"))')
                page.wait_for_function('window.__DBG__?.solarSystem?.renderer', timeout=60000)
                initial_frame = page.evaluate('window.__DBG__.solarSystem.renderer.info.render.frame')
                page.evaluate(realtime.OBSERVER)
                page.wait_for_function(FRAME_READY, arg=initial_frame, timeout=120000)
                frame = page.evaluate(realtime.SNAPSHOT)
                realtime.validate_bound_frame(frame, 1)
                record(name + '-bound-epoch', frame)
                metrics = page.evaluate('''() => {
                  const s = window.__DBG__.solarSystem, gl = s.renderer.getContext();
                  const r = s.renderer.domElement.getBoundingClientRect();
                  return {isMobile: s.isMobile, deviceDPR: devicePixelRatio,
                    rendererDPR: s.renderer.getPixelRatio(), viewport: [innerWidth, innerHeight],
                    canvasRect: {x:r.x,y:r.y,width:r.width,height:r.height},
                    canvasSize: [s.renderer.domElement.width,s.renderer.domElement.height],
                    drawingBuffer: [gl.drawingBufferWidth,gl.drawingBufferHeight]};
                }''')
                assert metrics['isMobile'] == mobile and metrics['deviceDPR'] == dpr, 'DEVICE_CONSTRUCTION_MISMATCH'
                assert metrics['viewport'] == [width, height], 'DEVICE_VIEWPORT_MISMATCH'
                assert metrics['canvasSize'] == metrics['drawingBuffer'], 'DRAWING_BUFFER_MISMATCH'
                assert metrics['canvasRect']['width'] > 0 and metrics['canvasRect']['height'] > 0, 'CANVAS_RECT_MISSING'
                for index, dimension in enumerate(['width', 'height']):
                    assert abs(metrics['canvasRect'][dimension] * metrics['rendererDPR'] - metrics['drawingBuffer'][index]) < 1.01, 'CANVAS_BUFFER_SCALE_MISMATCH'
                screenshot = page.screenshot(path=str(output / (name + '-wide.png')))
                metrics['widePngSize'] = png_size(screenshot)
                metrics['screenshotScale'] = [metrics['widePngSize'][0] / width, metrics['widePngSize'][1] / height]
                record(name + '-actual-metrics', metrics)
                result = page.evaluate(PRODUCTION_GATE, args.negative_controls)
                for layer_name, filename in [('layer', 'frozen-layer'), ('mobileUnoccludedTail', 'original-view-no-nucleus-tail'),
                                             ('mobileWholeComet', 'original-view-whole-comet'), ('mobileFailedWitness', 'failed-occlusion-witness'),
                                             ('denseProbe', 'fixture-dense-804-RGBA8')]:
                    if result.get(layer_name):
                        for state in ['on', 'off']:
                            encoded = result[layer_name].pop(state + 'Png', None)
                            if encoded:
                                data = base64.b64decode(encoded)
                                assert png_size(data) == metrics['drawingBuffer'], 'LAYER_PNG_BUFFER_MISMATCH'
                                (output / (name + '-' + filename + '-' + state + '.png')).write_bytes(data)
                if result.get('probe'):
                    data = rgba_png(result['probe']['size'], result['probe'].pop('rgba'))
                    (output / (name + '-production-probe-32.png')).write_bytes(data)
                record(name + '-production-appearance', result)
                if result.get('error'):
                    raise RuntimeError(result['error'])
                if args.negative_controls:
                    guard = "    if (!points || !geometry?.attributes.position || !tail.visibleCount || !geometry.drawRange.count)\n      throw new Error('GEOMETRY_MISSING');"
                    assert PRODUCTION_GATE.count(guard) == 1, 'GEOMETRY_GUARD_MUTATION_BINDING_MISSING'
                    mutation = page.evaluate(PRODUCTION_GATE.replace(guard, ''), True)
                    absent_passed = any(control['name'] == 'absent-production-geometry' for control in mutation.get('controls', []))
                    record(name + '-geometry-guard-removed-mutation', {'error': mutation.get('error'), 'absentGeometryNegativePassed': absent_passed})
                    assert mutation.get('error') and not absent_passed and 'LAYER_SIGNAL_MISSING' in mutation['error'], 'GEOMETRY_GUARD_MUTATION_SURVIVED'
                page.close()
            record('status', {'technicalGate': 'PASS', 'wideViewAesthetics': 'INDEPENDENT_ACCEPTANCE_REQUIRED'})
            browser.close()
            browser = None
        return 0
    except Exception:
        failure = traceback.format_exc()
        (output / 'failure.txt').write_text(failure)
        record('status', {'technicalGate': 'FAIL', 'error': failure})
        print(failure, end='')
        return 1
    finally:
        if browser:
            try:
                browser.close()
            except Exception:
                pass
        for process in [chrome, display]:
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        if server:
            server.shutdown()
            server.server_close()
        for handle in handles:
            handle.close()
        if previous_display is None:
            os.environ.pop('DISPLAY', None)
        else:
            os.environ['DISPLAY'] = previous_display


if __name__ == '__main__':
    raise SystemExit(main())
