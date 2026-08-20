import { resourceTimelineRows } from './resourceTimeline.js';

export function normalizeDetailAggregate(payload = {}, normalizeRows = (rows) => rows) {
  const history = payload.history && typeof payload.history === 'object' ? payload.history : {};
  const historyRows = normalizeRows(history.data || []);
  const resourceRows = resourceTimelineRows(payload.resource_timeline || []);
  const processRows = normalizeRows(payload.process_history || []);
  const pingTargets = payload.ping_targets && typeof payload.ping_targets === 'object' ? payload.ping_targets : null;
  const pingHistory = payload.ping_history && typeof payload.ping_history === 'object' ? payload.ping_history : null;

  return {
    traffic: payload.traffic || null,
    history,
    historyRows,
    networkRows: historyRows,
    resourceRows,
    processRows,
    pingTargets,
    pingHistory,
  };
}

export function consumeAggregateWithinBudget({ promise, budgetMs, onHydrate, onFailure, isCurrent = () => true, scheduler = globalThis }) {
  let settled = false;
  let timedOut = false;
  let timer;
  const late = Promise.resolve(promise).then(
    (value) => {
      settled = true;
      if (timer) scheduler.clearTimeout(timer);
      if (timedOut && isCurrent()) onHydrate(value);
      return { status: 'fulfilled', value };
    },
    (reason) => {
      settled = true;
      if (timer) scheduler.clearTimeout(timer);
      if (timedOut && isCurrent()) onFailure(reason);
      return { status: 'rejected', reason };
    },
  );
  const budget = new Promise((resolve) => {
    timer = scheduler.setTimeout(() => {
      if (!settled) {
        timedOut = true;
        resolve({ status: 'timeout' });
      }
    }, budgetMs);
  });
  return Promise.race([late, budget]);
}
