import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureSolarClipContract } from './measure_solar_clip_contract.mjs';

test('synthetic API wiring: records 3 x 18 x 2401 raw rows, unknown nodes and API disagreement', () => {
  const names = ['window', 'document', 'getComputedStyle', 'innerWidth', 'innerHeight', 'devicePixelRatio'];
  const saved = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const keys = ['sun', 'earth', 'moon'];
  const node = (tag, index) => ({
    tagName: tag.toUpperCase(), localName: tag, id: `synthetic-${index}`, isConnected: true,
    parentElement: null, getAttribute: () => '', matches: () => false,
  });
  const other = node('aside', 0);
  const entries = Object.fromEntries(keys.map((key, i) => [key, { el: node('button', i + 1) }]));
  const centers = Object.fromEntries(keys.map((key, i) => [key, { x: 100 + i * 30, y: 70 }]));
  const snapshot = () => ({ centers, probes: centers });
  const sync = () => {};
  let topCalls = 0, stackCalls = 0, lastPoint;
  try {
    Object.assign(globalThis, {
      innerWidth: 320, innerHeight: 700, devicePixelRatio: 3,
      getComputedStyle: () => ({ fontSize: '16px' }),
      window: { __solarClipAudit: { s: { _syncHitButtons: sync }, originalSync: sync,
        keys, entries, snapshot, rect: () => ({ width: 24, height: 24 }), witness: {} } },
      document: {
        documentElement: other, activeElement: other,
        elementFromPoint(x, y) { topCalls++; lastPoint = { x, y }; return other; },
        elementsFromPoint(x, y) {
          stackCalls++;
          assert.deepEqual({ x, y }, lastPoint);
          // Deliberately inconsistent at the last sample: must retain, not erase.
          if (stackCalls === 129660) return [entries.moon.el, other];
          return [other, ...keys.filter(key => Math.hypot(x - centers[key].x, y - centers[key].y) <= 12)
            .map(key => entries[key].el)];
        },
      },
    });
    const row = measureSolarClipContract({ dpr: 3, fontScale: 1, state: 'idle' });
    assert.equal(topCalls, 129660);
    assert.equal(stackCalls, 129660);
    assert.equal(row.radialQueryCount, 129654);
    assert.equal(row.points.length, 6);
    for (const key of keys) {
      assert.equal(row.buttons[key].rays.length, 18);
      for (const ray of row.buttons[key].rays) {
        assert.equal(ray.rows.length, 2401);
        assert.equal(ray.rows[0][1], centers[key].x); // CSS coordinates, not DPR-scaled.
        assert.deepEqual(ray.rows[0][4], ['dom:aside[0]', key]);
        assert.ok(ray.rows[1204][4].includes('dom:aside[0]'));
      }
    }
    const last = row.buttons.moon.rays.at(-1).rows.at(-1);
    assert.deepEqual(last[4], ['moon', 'dom:aside[0]']);
    assert.equal(last[5], false);
    assert.equal(row.registry['dom:aside[0]'].tag, 'ASIDE');
  } finally {
    names.forEach((name, i) => {
      if (saved[i]) Object.defineProperty(globalThis, name, saved[i]);
      else delete globalThis[name];
    });
  }
});
