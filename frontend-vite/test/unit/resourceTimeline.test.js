import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  resourceHistoryRequest,
  mergeResourceTimelineHistory,
  resourceTimelineRows,
  shouldReplaceResourceTimeline,
} from '../../src/detail/resourceTimeline.js';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const sample = (secondsAgo, cpu) => ({
  created_at: new Date(NOW - secondsAgo * 1000).toISOString(),
  cpu_use: cpu,
});

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

describe('resource timeline helper', () => {
  it('builds the raw one-hour request contract', () => {
    expect(resourceHistoryRequest()).toEqual({
      days: 1 / 24,
      limit: 900,
      bucketMinutes: 0,
      metric: 'resource_timeline',
    });
  });

  it('filters, deduplicates, and sorts telemetry deterministically', () => {
    const rows = resourceTimelineRows(
      [sample(10, 1), sample(70 * 60, 2), sample(30, 3), sample(30, 4)],
      NOW,
    );
    expect(rows.map((row) => row.cpu_use)).toEqual([4, 1]);
    expect(rows[0].__timeMs).toBeLessThan(rows[1].__timeMs);
  });

  it('keeps a newer live point when an older response arrives late', () => {
    expect(shouldReplaceResourceTimeline([sample(1, 9)], [sample(10, 2)])).toBe(false);
    expect(shouldReplaceResourceTimeline([sample(10, 2)], [sample(1, 9)])).toBe(true);
  });

  it('does not replace fine live data with newer coarse buckets', () => {
    const fine = [sample(20, 1), sample(15, 2), sample(10, 3), sample(5, 4)];
    const coarse = [sample(15 * 60, 5), sample(10 * 60, 6), sample(5 * 60, 7), sample(0, 8)];
    expect(shouldReplaceResourceTimeline(fine, coarse)).toBe(false);
  });

  it('backfills only history older than the existing fine timeline', () => {
    const fine = [sample(20, 1), sample(10, 2), sample(0, 3)];
    const history = [sample(60, 4), sample(30, 5), sample(10, 6), sample(0, 7)];
    const merged = mergeResourceTimelineHistory(fine, history);
    expect(merged.map((row) => row.cpu_use)).toEqual([4, 5, 1, 2, 3]);
  });
});
