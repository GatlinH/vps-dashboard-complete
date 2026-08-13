import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESOURCE_TIMELINE_DAYS,
  RESOURCE_TIMELINE_LIMIT,
  resourceHistoryRequest,
  resourceTimelineRows,
  shouldReplaceResourceTimeline,
} from '../src/detail/resourceTimeline.js';

const NOW = Date.now();

const row = (secondsAgo, cpu) => ({
  created_at: new Date(NOW - secondsAgo * 1000).toISOString(),
  cpu_use: cpu,
  ram_use: cpu + 10,
});

test('resource CPU/RAM request is raw one-hour telemetry, never a range bucket', () => {
  assert.deepEqual(resourceHistoryRequest(), {
    days: RESOURCE_TIMELINE_DAYS,
    limit: RESOURCE_TIMELINE_LIMIT,
    bucketMinutes: 0,
    metric: 'resource_timeline',
  });
  assert.equal(RESOURCE_TIMELINE_DAYS, 1 / 24);
});

test('resource timeline always orders old-to-new for a left-to-right chart', () => {
  const rows = resourceTimelineRows([row(5, 30), row(55, 10), row(25, 20)], NOW);
  assert.deepEqual(rows.map((item) => item.cpu_use), [10, 20, 30]);
  assert.ok(rows[0].__timeMs < rows.at(-1).__timeMs);
});

test('late stale history cannot replace a newer appended live resource point', () => {
  const current = [row(60, 10), row(0, 40)];
  const staleHttpResponse = [row(60, 10), row(20, 30)];
  assert.equal(shouldReplaceResourceTimeline(current, staleHttpResponse), false);
  assert.equal(shouldReplaceResourceTimeline(staleHttpResponse, current), true);
});

test('timezone-less backend timestamps are treated as UTC', () => {
  const timestamp = new Date(NOW - 10_000).toISOString().replace(/\.\d{3}Z$/, '');
  const rows = resourceTimelineRows([{ created_at: timestamp, cpu_use: 9 }], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].__timeMs, Date.parse(`${timestamp}Z`));
});

test('duplicate timestamps retain one deterministic point', () => {
  const same = new Date(NOW - 10_000).toISOString();
  const rows = resourceTimelineRows([{ created_at: same, cpu_use: 1 }, { created_at: same, cpu_use: 2 }], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cpu_use, 2);
});
