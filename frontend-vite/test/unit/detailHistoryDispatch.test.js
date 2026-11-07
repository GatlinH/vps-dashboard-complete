import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDetailTab } from '../../src/modules/detailTab.js';
import {
  setDetailHistoryDays,
  syncDetailHistoryStateFromStorage,
} from '../../src/detail/historyRange.js';

vi.hoisted(() => {
  globalThis.window = { __DBG__: {} };
});

const legalDays = [0, 1, 4, 7, 30, 90];
const normalizationCases = [
  ...legalDays.flatMap((days) => [
    { label: `numeric ${days}`, requested: days, normalized: days },
    { label: `string ${days}`, requested: String(days), normalized: days },
  ]),
  ...[-1, 2, 30.5, 91, NaN, Infinity, undefined, 'invalid'].map((requested) => ({
    label: `invalid ${String(requested)}`,
    requested,
    normalized: 1,
  })),
];

function createHarness(search = '?server=1', initialDays = 1) {
  const storage = new Map([['detailHistoryDays', String(initialDays)]]);
  vi.stubGlobal('window', { __DBG__: {} });
  vi.stubGlobal('location', { search });
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => storage.get(key) ?? null),
    setItem: vi.fn((key, value) => storage.set(key, String(value))),
  });

  const callbackSnapshots = [];
  let tab;
  const refreshHistoryRange = vi.fn((serverId) => {
    callbackSnapshots.push({
      serverId,
      callbackDays: tab.getHistoryDays(),
      persistedDays: localStorage.getItem('detailHistoryDays'),
      debugDays: window.__DBG__.DETAIL_HISTORY_DAYS,
    });
  });
  tab = createDetailTab({
    syncHistoryDays: syncDetailHistoryStateFromStorage,
    persistHistoryDays: setDetailHistoryDays,
    refreshHistoryRange,
  });
  return { tab, refreshHistoryRange, callbackSnapshots };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detail history range dispatch through production modules', () => {
  it('refreshes 30, 90, and 0 immediately rather than one selection late', () => {
    const { tab, refreshHistoryRange, callbackSnapshots } = createHarness();
    const afterSetter = [30, 90, 0].map((days) => tab.setHistoryDays(days));

    expect(afterSetter).toEqual([30, 90, 0]);
    expect(refreshHistoryRange).toHaveBeenCalledTimes(3);
    expect(callbackSnapshots).toEqual(
      [30, 90, 0].map((days) => ({
        serverId: '1',
        callbackDays: days,
        persistedDays: String(days),
        debugDays: days,
      })),
    );
  });

  it.each(normalizationCases)(
    'publishes the persisted result before one refresh for $label',
    ({ requested, normalized }) => {
      const initialDays = normalized === 1 ? 90 : 1;
      const { tab, refreshHistoryRange, callbackSnapshots } = createHarness(
        '?server=1',
        initialDays,
      );

      expect(tab.getHistoryDays()).toBe(initialDays);
      expect(tab.setHistoryDays(requested)).toBe(normalized);
      expect(tab.getHistoryDays()).toBe(normalized);
      expect(localStorage.setItem).toHaveBeenCalledTimes(1);
      expect(localStorage.setItem).toHaveBeenCalledWith('detailHistoryDays', String(normalized));
      expect(refreshHistoryRange).toHaveBeenCalledTimes(1);
      expect(refreshHistoryRange).toHaveBeenCalledWith('1');
      expect(callbackSnapshots).toEqual([
        {
          serverId: '1',
          callbackDays: normalized,
          persistedDays: String(normalized),
          debugDays: normalized,
        },
      ]);
    },
  );

  it.each(['', '?days=30', '?server=', '?server=&server=7'])(
    'persists without refreshing when the server query is absent or empty: %s',
    (search) => {
      const { tab, refreshHistoryRange, callbackSnapshots } = createHarness(search);

      for (const { requested, normalized } of normalizationCases) {
        expect(tab.setHistoryDays(requested)).toBe(normalized);
        expect(tab.getHistoryDays()).toBe(normalized);
        expect(window.__DBG__.DETAIL_HISTORY_DAYS).toBe(normalized);
        expect(localStorage.getItem('detailHistoryDays')).toBe(String(normalized));
      }

      expect(localStorage.setItem).toHaveBeenCalledTimes(normalizationCases.length);
      expect(refreshHistoryRange).not.toHaveBeenCalled();
      expect(callbackSnapshots).toEqual([]);
    },
  );

  it.each([
    ['?server=0', '0'],
    ['?server=0007%2Fedge', '0007/edge'],
    ['?server=first&server=second', 'first'],
  ])('retains the production server query semantics for %s', (search, serverId) => {
    const { tab, refreshHistoryRange, callbackSnapshots } = createHarness(search);

    expect(tab.setHistoryDays(30)).toBe(30);
    expect(refreshHistoryRange).toHaveBeenCalledTimes(1);
    expect(refreshHistoryRange).toHaveBeenCalledWith(serverId);
    expect(callbackSnapshots).toEqual([
      { serverId, callbackDays: 30, persistedDays: '30', debugDays: 30 },
    ]);
  });

  it('publishes the normalized result even when localStorage persistence throws', () => {
    const { tab, refreshHistoryRange, callbackSnapshots } = createHarness('?server=1', 90);
    localStorage.setItem.mockImplementationOnce(() => {
      throw new Error('storage unavailable');
    });

    expect(tab.setHistoryDays('invalid')).toBe(1);
    expect(tab.getHistoryDays()).toBe(1);
    expect(localStorage.setItem).toHaveBeenCalledTimes(1);
    expect(refreshHistoryRange).toHaveBeenCalledTimes(1);
    expect(callbackSnapshots).toEqual([
      { serverId: '1', callbackDays: 1, persistedDays: '90', debugDays: 1 },
    ]);
  });
});
