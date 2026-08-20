import { describe, expect, it } from 'vitest';
import { consumeAggregateWithinBudget, normalizeDetailAggregate } from '../../src/detail/aggregatePayload.js';

describe('detail aggregate payload', () => {
  it('hydrates resource, process, network, traffic, and ping data synchronously', () => {
    const payload = {
      history: { data: [{ created_at: '2026-08-20T00:00:00Z', net_up: 2 }] },
      resource_timeline: [{ created_at: new Date(Date.now() - 1000).toISOString(), cpu_use: 37 }],
      process_history: [{ created_at: new Date(Date.now() - 500).toISOString(), process_count: 91 }],
      traffic: { used_percent: 12 },
      ping_targets: { targets: [{ target: '1.1.1.1' }] },
      ping_history: { targets: [{ target: '1.1.1.1', samples: [12] }] },
    };

    const result = normalizeDetailAggregate(payload, (rows) => rows.map((row) => ({ ...row, normalized: true })));

    expect(result.historyRows).toEqual([{ ...payload.history.data[0], normalized: true }]);
    expect(result.networkRows).toBe(result.historyRows);
    expect(result.resourceRows[0].cpu_use).toBe(37);
    expect(result.processRows).toEqual([{ ...payload.process_history[0], normalized: true }]);
    expect(result.traffic).toBe(payload.traffic);
    expect(result.pingTargets).toBe(payload.ping_targets);
    expect(result.pingHistory).toBe(payload.ping_history);
  });
});

describe('delayed detail aggregate lifecycle', () => {
  it('hydrates exactly once after the first-paint budget expires', async () => {
    let resolveAggregate;
    const promise = new Promise((resolve) => { resolveAggregate = resolve; });
    const hydrated = [];
    const firstPaint = consumeAggregateWithinBudget({
      promise,
      budgetMs: 10,
      onHydrate: (payload) => hydrated.push(payload),
      onFailure: () => {},
    });

    await expect(firstPaint).resolves.toEqual({ status: 'timeout' });
    resolveAggregate({ history: { data: [1] } });
    await promise;
    await Promise.resolve();
    expect(hydrated).toEqual([{ history: { data: [1] } }]);
  });

  it('ignores a delayed result after the page generation becomes stale', async () => {
    let resolveAggregate;
    let current = true;
    const promise = new Promise((resolve) => { resolveAggregate = resolve; });
    const hydrated = [];
    await expect(consumeAggregateWithinBudget({
      promise,
      budgetMs: 10,
      isCurrent: () => current,
      onHydrate: (payload) => hydrated.push(payload),
      onFailure: () => {},
    })).resolves.toEqual({ status: 'timeout' });
    current = false;
    resolveAggregate({ history: { data: [1] } });
    await promise;
    await Promise.resolve();
    expect(hydrated).toEqual([]);
  });

  it('reports a delayed rejection so loading can be cleared explicitly', async () => {
    let rejectAggregate;
    const promise = new Promise((resolve, reject) => { rejectAggregate = reject; });
    const failures = [];
    await expect(consumeAggregateWithinBudget({
      promise,
      budgetMs: 10,
      onHydrate: () => {},
      onFailure: (error) => failures.push(error.message),
    })).resolves.toEqual({ status: 'timeout' });
    rejectAggregate(new Error('aggregate unavailable'));
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toEqual(['aggregate unavailable']);
  });
});
