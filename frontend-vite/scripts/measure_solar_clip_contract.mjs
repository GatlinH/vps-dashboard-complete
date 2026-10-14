// Browser-only measurement. No product classifier and no synthetic hit queries.
export async function prepareSolarClipAudit() {
  const s = window.__DBG__?.solarSystem;
  if (!s || s.running || s.simulationTime !== 2446454.4312)
    throw new Error('Paused real product at Configuration A is required');
  const keys = ['sun', 'earth', 'moon'];
  const originalSync = Object.getPrototypeOf(s)._syncHitButtons;
  if (typeof originalSync !== 'function' || originalSync !== s._syncHitButtons)
    throw new Error('Original prototype _syncHitButtons required');
  const entries = Object.fromEntries(keys.map(key => [key, s.hitButtons.find(e => e.mesh === s[key])]));
  if (s.hitButtons.length !== 3 || keys.some(key => !entries[key]?.el.isConnected))
    throw new Error('Three real connected hit buttons required');
  const rect = el => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height,
      x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const snapshot = () => {
    const canvas = rect(s.canvas);
    return {
      jd: s.simulationTime, running: s.running, playbackPaused: s._ephemerisPlaybackPaused,
      atHome: s.cameraAtHome, tween: !!s.cameraTween,
      camera: { position: s.camera.position.toArray(), target: s.cameraTarget.toArray(),
        projection: s.camera.projectionMatrix.toArray(), world: s.camera.matrixWorld.toArray(),
        home: s.homeCameraPosition.toArray() },
      canvas, centers: Object.fromEntries(keys.map(key => [key, rect(entries[key].el)])),
      probes: Object.fromEntries(keys.map(key => {
        const v = s[key].getWorldPosition(s[key].position.clone()).project(s.camera);
        return [key, { x: canvas.left + (v.x * .5 + .5) * canvas.width,
          y: canvas.top + (-v.y * .5 + .5) * canvas.height }];
      })),
      ready: s.ephemerisStatus.status === 'ready',
      targets: Object.fromEntries(keys.map(key => [key, key === 'sun'
        ? !!s.sun?.visible : s.ephemerisStatus.targets[key]?.ok === true])),
    };
  };
  s.scene.updateMatrixWorld(true);
  s.camera.updateMatrixWorld(true);
  const before = snapshot();
  Reflect.apply(originalSync, s, []);
  const after = snapshot();
  const functionSource = originalSync.toString();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(functionSource));
  const witness = {
    instance: crypto.randomUUID(), constructor: s.constructor.name,
    realInstance: s === window.__DBG__.solarSystem && s instanceof Object.getPrototypeOf(s).constructor,
    rendererCanvas: s.renderer.domElement === s.canvas,
    prototypeMethod: originalSync === Object.getPrototypeOf(s)._syncHitButtons,
    originalUnchanged: originalSync === s._syncHitButtons, calls: 1,
    functionSource, functionSha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''),
    before, after,
  };
  // This object records instrumentation only; no product function is replaced.
  window.__solarClipAudit = { s, keys, entries, rect, snapshot, originalSync, witness };
  return { centers: after.centers, witness };
}

export function measureSolarClipContract(meta) {
  const { s, keys, entries, rect, snapshot, originalSync, witness } = window.__solarClipAudit;
  const before = snapshot();
  const registry = {};
  const identify = el => {
    if (!el) return null;
    let id = keys.find(key => entries[key].el === el);
    if (!id) {
      const path = [];
      for (let node = el; node; node = node.parentElement) {
        const index = node.parentElement ? Array.prototype.indexOf.call(node.parentElement.children, node) : 0;
        path.unshift(`${node.localName}[${index}]`);
      }
      id = `dom:${path.join('/')}`;
    }
    if (!registry[id]) {
      const style = getComputedStyle(el);
      registry[id] = { tag: el.tagName, id: el.id, class: el.getAttribute('class'),
        ariaLabel: el.getAttribute('aria-label'), connected: el.isConnected, rect: rect(el),
        style: Object.fromEntries(['clipPath', 'width', 'height', 'boxSizing', 'zIndex',
          'visibility', 'display', 'pointerEvents', 'outline', 'boxShadow', 'forcedColorAdjust']
          .map(name => [name, style[name]])) };
    }
    return id;
  };
  let queries = 0;
  const nativeAt = (x, y) => {
    const top = document.elementFromPoint(x, y);
    const stack = document.elementsFromPoint(x, y);
    queries++;
    return { x, y, top: identify(top), stack: stack.map(identify), apisAgree: top === (stack[0] ?? null) };
  };
  const points = ['probe', 'center'].flatMap(kind => keys.map(key => {
    const p = (kind === 'probe' ? before.probes : before.centers)[key];
    return { kind, key, ...nativeAt(p.x, p.y) };
  }));
  const toward = Math.atan2(before.probes.moon.y - before.centers.earth.y,
    before.probes.moon.x - before.centers.earth.x);
  const directions = Array.from({ length: 16 }, (_, i) => ({ id: `deg-${i * 22.5}`, angle: i * Math.PI / 8 }));
  directions.push({ id: 'toward-moon-probe', angle: toward }, { id: 'opposite-moon-probe', angle: toward + Math.PI });
  const buttons = Object.fromEntries(keys.map(key => {
    const center = before.centers[key];
    return [key, { node: identify(entries[key].el), rays: directions.map(({ id, angle }) => ({
      id, angle, center, rows: Array.from({ length: 2401 }, (_, i) => {
        const raw = nativeAt(center.x + (i / 100) * Math.cos(angle), center.y + (i / 100) * Math.sin(angle));
        return [i, raw.x, raw.y, raw.top, raw.stack, raw.apisAgree];
      }),
    })) }];
  }));
  const after = snapshot();
  return { schema: 1, ...meta, viewport: [innerWidth, innerHeight], devicePixelRatio,
    rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
    witness: { ...witness, originalUnchanged: originalSync === s._syncHitButtons },
    before, after, points, buttons, registry, radialQueryCount: queries - 6, totalQueryCount: queries,
    interaction: { active: identify(document.activeElement),
      focusVisible: keys.filter(key => entries[key].el.matches(':focus-visible')),
      hovered: keys.filter(key => entries[key].el.matches(':hover')) },
    rowEncoding: ['index', 'viewportCssX', 'viewportCssY', 'nativeTopStableId', 'nativeFullStackStableIds', 'nativeApisAgree'],
  };
}
