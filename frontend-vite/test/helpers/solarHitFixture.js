import { vi } from 'vitest';
import * as THREE from 'three';
import { SolarSystem } from '../../src/components/SolarSystem.js';
import { geometryMetrics, limits } from './solarHitGeometry.js';

export const names = ['Sun', 'Earth', 'Moon'];
export const labels = ['太阳（前往登录）', '地球（进入三维地球）', '月球（进入总览）'];

// Production projection, positioning and button creation, with in-memory elements.
// This cannot prove CSS layout, elementFromPoint or native keyboard dispatch.
export function createHitFixture(
  probes,
  {
    width = 390,
    height = (width * 9) / 16,
    left = 0,
    top = 0,
    containerLeft = left,
    containerTop = top,
    clientLeft = 0,
    clientTop = 0,
    scrollLeft = 0,
    scrollTop = 0,
    layoutQuantum = 0,
    rectFloat32 = false,
  } = {},
) {
  const children = [];
  const container = {
    style: {},
    clientLeft,
    clientTop,
    scrollLeft,
    scrollTop,
    getBoundingClientRect: () => ({ left: containerLeft, top: containerTop, width, height }),
    appendChild(el) {
      if (!children.includes(el)) children.push(el);
      el.isConnected = true;
      el.parentElement = container;
    },
  };
  vi.stubGlobal('getComputedStyle', (el) => ({ position: 'relative', ...el.style }));
  vi.stubGlobal('document', {
    body: container,
    createElement(tag) {
      const attributes = {},
        events = {};
      return {
        tagName: tag.toUpperCase(),
        style: { opacity: '1', display: 'block' },
        isConnected: false,
        tabIndex: 0,
        disabled: false,
        hidden: false,
        events,
        get offsetParent() {
          return this.isConnected ? container : null;
        },
        setAttribute: (name, value) => (attributes[name] = value),
        getAttribute: (name) => attributes[name],
        removeAttribute: (name) => delete attributes[name],
        addEventListener(name, callback) {
          (events[name] ||= []).push(callback);
        },
        getBoundingClientRect() {
          let width = Number.parseFloat(this.style.width),
            height = Number.parseFloat(this.style.height);
          const quantize = (value) =>
            layoutQuantum ? Math.trunc(value / layoutQuantum) * layoutQuantum : value;
          const translate = this.style.transform?.match(
            /^translate\(([-\d.e+]+)px, ([-\d.e+]+)px\)$/,
          );
          let tx = Number(translate?.[1] || 0),
            ty = Number(translate?.[2] || 0);
          if (this.style.transform === 'translate(-50%, -50%)') {
            tx = -width / 2;
            ty = -height / 2;
          }
          // Optional numerical model, not a native-browser result: LayoutUnit
          // layout plus binary32 transformed edges. Default remains binary64.
          if (rectFloat32) {
            tx = Math.fround(tx);
            ty = Math.fround(ty);
          }
          let x =
              containerLeft +
              clientLeft -
              scrollLeft +
              quantize(Number.parseFloat(this.style.left)) +
              tx,
            y =
              containerTop +
              clientTop -
              scrollTop +
              quantize(Number.parseFloat(this.style.top)) +
              ty;
          if (rectFloat32) {
            const right = Math.fround(x + width),
              bottom = Math.fround(y + height);
            x = Math.fround(x);
            y = Math.fround(y);
            width = right - x;
            height = bottom - y;
          }
          return {
            left: x,
            top: y,
            width,
            height,
          };
        },
        click() {
          for (const callback of events.click || []) callback();
        },
        remove() {
          const index = children.indexOf(this);
          if (index >= 0) children.splice(index, 1);
          this.isConnected = false;
        },
      };
    },
  });
  const meshes = [probes.sun, probes.earth, probes.moon].map(({ x, y }, index) => {
    const mesh = new THREE.Object3D();
    mesh.name = names[index];
    mesh.position.set((x / width - 0.5) * 2, -(y / height - 0.5) * 2, 0);
    mesh.updateMatrixWorld(true);
    return mesh;
  });
  const system = Object.assign(Object.create(SolarSystem.prototype), {
    container,
    canvas: {
      parentElement: container,
      getBoundingClientRect: () => ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
      }),
    },
    camera: new THREE.Camera(),
    sun: meshes[0],
    earth: meshes[1],
    moon: meshes[2],
    hitButtons: [],
    _hitWorldScratch: new THREE.Vector3(),
    _activate: vi.fn(),
  });
  system._buildHitButtons();
  system._syncHitButtons();
  let centerReads = 0;
  return {
    system,
    children,
    get centerReads() {
      return centerReads;
    },
    centers() {
      centerReads++;
      return system.hitButtons.map(({ el }) => {
        if (!el.isConnected) throw new Error('Missing DOM must block all geometry reads');
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2 - left, y: rect.top + rect.height / 2 - top };
      });
    },
  };
}

export function inspectHitFixture(fixture, probes) {
  const { system } = fixture;
  const children = fixture.children.filter((el) => el.tagName === 'BUTTON');
  const rows = system.hitButtons.map(({ el, ...entry }) => ({
    name: entry.mesh.name,
    connected: el.isConnected,
    visibility: el.style.visibility,
    opacity: Number(el.style.opacity),
    display: el.style.display,
    unsolvableMarker: '__unsolvable' in entry || '__unsolvable' in el,
    diameter: [Number.parseFloat(el.style.width), Number.parseFloat(el.style.height)],
  }));
  const live =
    children.length === 3 &&
    rows.length === 3 &&
    rows.every(
      (row) =>
        row.connected &&
        row.visibility === 'visible' &&
        row.opacity >= 0.01 &&
        row.display !== 'none' &&
        !row.unsolvableMarker,
    );
  const report = {
    scope: 'Computed circular geometry and in-memory DOM; native browser assertions deferred',
    rows,
    liveCount: children.length,
    assertions: { 1: live },
    blocked: live ? [] : [2, 3, 4, 5, 6, 7, 8],
    nativeKeyboard: 'NOT RUN: needs browser outside sandbox',
  };
  if (!live) {
    report.centerReads = fixture.centerReads;
    report.failedAssertions = [1];
    return report;
  }
  const [sun, earth, moon] = fixture.centers();
  const metrics = geometryMetrics(probes, { sun, earth, moon });
  const domOrder = children.map((el) => el.getAttribute('aria-label'));
  const activations = children.map((el, index) => {
    const counts = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      system._activate.mockClear();
      el.click();
      counts.push({
        count: system._activate.mock.calls.length,
        target: system._activate.mock.calls[0]?.[0],
      });
    }
    return { name: names[index], clicks: counts };
  });
  const nativeButtonPrerequisites =
    domOrder.every((label, index) => label === labels[index]) &&
    children.every(
      (el) =>
        el.tagName === 'BUTTON' &&
        el.type === 'button' &&
        el.tabIndex === 0 &&
        !el.disabled &&
        !el.hidden &&
        !el.events.keydown &&
        !el.events.keyup,
    ) &&
    activations.every((row) =>
      row.clicks.every((click) => click.count === 1 && click.target === row.name),
    );
  Object.assign(report, {
    centers: { sun, earth, moon },
    centerReads: fixture.centerReads,
    metrics,
    domOrder,
    activations,
    nativeButtonPrerequisites,
    assertions: {
      1: true,
      2: !metrics.real,
      3: metrics.probeGap < 1.6 || metrics.pair >= limits.separation - limits.floatMargin,
      4:
        !metrics.inOffsetEnvelope ||
        (metrics.offsetEarth <= limits.offset &&
          metrics.offsetMoon <= limits.offset &&
          metrics.drift <= limits.drift),
      5:
        (metrics.anchorRadius < 14.2 ||
          metrics.probeGap < 1.6 ||
          metrics.sunClearance >= limits.sunClearance - limits.floatMargin) &&
        metrics.centerOwned.sun,
      // Local prerequisite only; never claim actual Enter/Space from click().
      '6-local': nativeButtonPrerequisites,
    },
  });
  report.failedAssertions = Object.entries(report.assertions)
    .filter(([, passed]) => !passed)
    .map(([number]) => (number === '6-local' ? number : Number(number)));
  return report;
}
