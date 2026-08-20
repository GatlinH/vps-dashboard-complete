import { describe, expect, test } from 'vitest';
import { coldStartAxisBounds } from '../../src/detail/telemetryAxis.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);

describe('coldStartAxisBounds', () => {
  test('keeps an empty axis as a full window ending at now', () => {
    expect(coldStartAxisBounds([], HOUR, NOW)).toMatchObject({
      min: NOW - HOUR,
      max: NOW,
      step: HOUR / 4,
      mode: 'fixed-window-ending-now',
      spanMs: HOUR,
    });
  });

  test('anchors sparse cold-start data at the first sample', () => {
    const first = NOW - 20_000;

    expect(coldStartAxisBounds([first, first + 5_000, first + 10_000], HOUR, NOW)).toMatchObject({
      min: first,
      max: first + HOUR,
      step: HOUR / 4,
      mode: 'accumulating-from-first-sample',
      spanMs: HOUR,
    });
  });

  test('rolls only after the samples fill the complete window', () => {
    const first = NOW - HOUR - 15_000;
    const last = NOW - 5_000;

    expect(coldStartAxisBounds([first, last], HOUR, NOW)).toMatchObject({
      min: last - HOUR,
      max: last,
      step: HOUR / 4,
      mode: 'rolling-after-full-window',
      spanMs: HOUR,
    });
  });

  test('derives the live append accumulate and rolling bounds from the same contract', () => {
    const first = NOW - 30_000;
    const accumulating = coldStartAxisBounds([first, NOW], HOUR, NOW);
    expect(accumulating).toMatchObject({
      min: first,
      max: first + HOUR,
      mode: 'accumulating-from-first-sample',
    });

    const latest = first + HOUR + 5_000;
    const rolling = coldStartAxisBounds([first, latest], HOUR, latest);
    expect(rolling).toMatchObject({
      min: latest - HOUR,
      max: latest,
      mode: 'rolling-after-full-window',
    });
  });

  test('allows history-backed live updates to retain their now-aligned window', () => {
    const updateBounds = coldStartAxisBounds([], HOUR, NOW);
    expect(updateBounds).toMatchObject({
      min: NOW - HOUR,
      max: NOW,
      mode: 'fixed-window-ending-now',
    });
  });
});
