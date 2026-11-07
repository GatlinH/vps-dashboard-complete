import { fetchRegionalPingOverview } from './displayData.js';
import { decodeRegionSelection, encodeRegionSelection, isExternalPingTarget } from './regionalPing.js';

const queue = [];
let activeRequests = 0;

function pump() {
  while (activeRequests < 4 && queue.length) {
    const job = queue.shift();
    if (!job.valid()) continue;
    activeRequests += 1;
    Promise.resolve().then(job.run).catch(() => {}).finally(() => {
      activeRequests -= 1;
      pump();
    });
  }
}

function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function finiteValue(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function timestamp(value) {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value))) return Number(value) * 1000;
  return Date.parse(value);
}

function readableTime(value) {
  const time = timestamp(value);
  return Number.isFinite(time) ? `${new Date(time).toISOString()} (${value})` : '—';
}

export function normalizeOverviewPingData(input) {
  const targets = Array.isArray(input?.targets) ? input.targets : [];
  return {
    ...input,
    hours: Number(input?.window_hours ?? input?.hours) || 1,
    regions: Array.isArray(input?.regions) ? input.regions.map((group) => ({ ...group })) : [],
    targets: targets.filter(isExternalPingTarget).map((target) => ({
      ...target,
      summary: { ...target.summary },
      slots: (Array.isArray(target.slots) ? target.slots : []).map((slot) => {
        const status = ['ok', 'loss', 'fail', 'missing'].includes(slot.status) ? slot.status : 'missing';
        return { ...slot, status,
          latency_ms: status === 'missing' || status === 'fail' ? null : finiteValue(slot.latency_ms),
          loss_pct: finiteValue(slot.loss_pct), report_failure_pct: finiteValue(slot.report_failure_pct) };
      }).sort((first, second) => (timestamp(first.start) || 0) - (timestamp(second.start) || 0)),
    })),
  };
}

function metric(value, unit) {
  const number = finiteValue(value);
  return number == null ? '—' : `${number}${unit}`;
}

export function renderOverviewPing({ id, selection = 'all', hours = 1, data }) {
  const normalized = normalizeOverviewPingData(data);
  const selected = encodeRegionSelection(typeof selection === 'string' ? decodeRegionSelection(selection) : selection);
  const groups = [{ value: 'all', label: '全部地区' }, ...normalized.regions.map((group) => ({
    value: group.ungrouped || group.region === '' ? 'ungrouped' : encodeRegionSelection({ kind: 'region', region: group.region }),
    label: group.ungrouped || group.region === '' ? '未分组' : group.region,
  }))];
  const controls = `<div class="overview-ping-controls" data-overview-interactive>
    <label>区域 PING <select aria-label="PING 地区" data-ping-region="${escapeText(selected)}" data-overview-interactive>${groups.map((group) => `<option value="${escapeText(group.value)}"${group.value === selected ? ' selected' : ''}>${escapeText(group.label)}</option>`).join('')}</select></label>
    <div class="overview-ping-windows">${[1, 6, 24].map((windowHours) => `<button type="button" data-ping-hours="${windowHours}" data-overview-interactive aria-pressed="${Number(hours) === windowHours}">${windowHours}h</button>`).join('')}</div></div>`;
  const targets = normalized.targets.map((target) => {
    const summary = target.summary;
    const hasSamples = summary.observed_at != null || target.slots.some((slot) => slot.status !== 'missing');
    const latency = !hasSamples || finiteValue(summary.report_failure_pct) === 100 ? null : summary.latency_ms;
    const summaryTitle = `观测时间：${readableTime(summary.observed_at)}；样本来源：${summary.sample_source ?? '—'}；上报失败率：${metric(summary.report_failure_pct, '%')}`;
    const slots = target.slots.map((slot, index) => {
      const title = `目标：${target.label ?? target.key}；时间：${readableTime(slot.start)} → ${readableTime(slot.end)}；状态：${slot.status}；延迟：${metric(slot.latency_ms, ' ms')}；丢包率：${metric(slot.loss_pct, '%')}；上报失败率：${metric(slot.report_failure_pct, '%')}`;
      return `<span class="overview-ping-slot is-${slot.status}" data-ping-slot="${index}" data-start="${escapeText(slot.start)}" data-overview-interactive tabindex="0" title="${escapeText(title)}" aria-label="${escapeText(title)}"></span>`;
    }).join('');
    return `<div class="overview-ping-target"><div class="overview-ping-summary" title="${escapeText(summaryTitle)}"><b>${escapeText(target.label ?? target.key)}</b><span>${metric(latency, ' ms')}</span><span class="overview-ping-loss">${metric(hasSamples ? summary.loss_pct : null, '%')}</span></div>
      ${hasSamples ? '' : '<span class="overview-ping-empty">等待 Agent / 缺测</span>'}<div class="overview-ping-slots">${slots}</div></div>`;
  }).join('');
  return `<div class="overview-ping-content" data-ping-id="${escapeText(id)}">${controls}${targets || `<span class="overview-ping-empty">${data == null || data.pending ? '等待 Agent / 缺测' : data.error ? 'PING 读取失败 / 缺测' : '暂无外部目标'}</span>`}</div>`;
}

export function createOverviewPingController({ fetchOverview = fetchRegionalPingOverview, Observer = globalThis.IntersectionObserver } = {}) {
  const states = new Map();
  const hosts = new Map();
  let destroyed = false;

  function current(state, host = state.host) {
    return !destroyed && !state.disposed && states.get(state.id) === state && state.host === host && host?.isConnected !== false;
  }

  function paint(state) {
    if (current(state)) state.host.innerHTML = renderOverviewPing({ id: state.id, selection: state.selection,
      hours: state.hours, data: state.data ?? { regions: state.regions, targets: [], pending: !state.error, error: state.error } });
  }

  function cancel(state) {
    if (state.request) {
      state.seq += 1;
      state.request.abort.abort();
      state.request = null;
    }
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index].state === state) queue.splice(index, 1);
    }
  }

  function legalSelection(state, encoded) {
    if (encoded === 'all') return true;
    const selection = decodeRegionSelection(encoded);
    return state.regions.some((group) => selection.kind === 'ungrouped'
      ? group.ungrouped || group.region === '' : selection.kind === 'region' && group.region === selection.region);
  }

  function read(state, refresh = false) {
    if (!current(state) || !state.visible || state.request) return;
    const key = `${state.selection}|${state.hours}`;
    const cached = state.cache.get(key);
    if (!refresh && cached && Date.now() - cached.at < 30000) {
      state.data = cached.data;
      paint(state);
      return;
    }
    const host = state.host;
    const selection = state.selection;
    const hours = state.hours;
    const seq = ++state.seq;
    const request = { abort: new AbortController() };
    state.request = request;
    const valid = () => current(state, host) && state.visible && state.seq === seq && state.request === request;
    queue.push({ state, valid, run: async () => {
      if (!valid()) return;
      try {
        const response = await fetchOverview(state.id, hours, 'external', decodeRegionSelection(selection), request.abort.signal);
        if (!valid()) return;
        const data = normalizeOverviewPingData(response);
        state.regions = data.regions;
        state.request = null;
        state.error = false;
        if (!legalSelection(state, selection)) {
          state.selection = 'all';
          state.data = null;
          paint(state);
          read(state, true);
          return;
        }
        state.cache.set(key, { data, at: Date.now() });
        state.data = data;
        paint(state);
      } catch (error) {
        if (!valid()) return;
        state.request = null;
        state.error = error?.name !== 'AbortError';
        paint(state);
      }
    } });
    pump();
  }

  const observer = Observer ? new Observer((entries) => {
    if (destroyed) return;
    for (const entry of entries) {
      const state = hosts.get(entry.target);
      if (!state || !current(state, entry.target)) continue;
      state.visible = entry.isIntersecting;
      if (state.visible) read(state);
      else cancel(state);
    }
  }) : null;
  const timer = setInterval(() => {
    for (const state of states.values()) if (state.visible) read(state, true);
  }, 30000);

  function detach(state) {
    cancel(state);
    if (state.host) {
      observer?.unobserve(state.host);
      hosts.delete(state.host);
      for (const [type, handler] of state.handlers) state.host.removeEventListener(type, handler);
    }
    state.host = null;
    state.visible = false;
    state.handlers = [];
  }

  function selectRegion(id, encoded) {
    const state = states.get(String(id));
    const selection = encodeRegionSelection(decodeRegionSelection(encoded));
    if (!state || destroyed || !legalSelection(state, selection) || state.selection === selection) return;
    cancel(state);
    state.selection = selection;
    state.data = null;
    state.error = false;
    paint(state);
    read(state);
  }

  function selectWindow(id, hours) {
    const state = states.get(String(id));
    const windowHours = Number(hours);
    if (!state || destroyed || ![1, 6, 24].includes(windowHours) || state.hours === windowHours) return;
    cancel(state);
    state.hours = windowHours;
    state.data = null;
    state.error = false;
    paint(state);
    read(state);
  }

  return {
    mount(root, ids) {
      if (destroyed) return;
      const allowed = new Set(ids.map(String));
      const nextHosts = new Map([...root.querySelectorAll('.overview-ping[data-server-id]')]
        .filter((host) => allowed.has(String(host.dataset.serverId))).map((host) => [String(host.dataset.serverId), host]));
      for (const [id, state] of states) {
        if (!nextHosts.has(id)) {
          detach(state);
          state.disposed = true;
          states.delete(id);
        }
      }
      for (const [id, host] of nextHosts) {
        let state = states.get(id);
        if (!state) {
          state = { id, selection: 'all', hours: 1, seq: 0, cache: new Map(), regions: [], data: null, handlers: [] };
          states.set(id, state);
        }
        if (state.host === host) continue;
        detach(state);
        state.host = host;
        hosts.set(host, state);
        const interact = (event) => {
          const control = event.target.closest?.('[data-ping-region], [data-ping-hours], [data-ping-slot]');
          if (!control || !host.contains(control)) return;
          event.stopPropagation();
          const keyboard = event.type === 'keydown' && ['Enter', ' '].includes(event.key);
          const select = control.tagName === 'SELECT';
          if (keyboard && !select) event.preventDefault();
          if (!(event.type === 'change' || event.type === 'click' && !select || keyboard && !select)) return;
          if (control.dataset.pingRegion !== undefined) selectRegion(id, select ? control.value : control.dataset.pingRegion);
          else if (control.dataset.pingHours !== undefined) selectWindow(id, control.dataset.pingHours);
        };
        state.handlers = ['click', 'change', 'keydown', 'pointerover'].map((type) => [type, interact]);
        for (const [type, handler] of state.handlers) host.addEventListener(type, handler);
        paint(state);
        if (observer) observer.observe(host);
        else { state.visible = true; read(state); }
      }
    },
    getState(id) {
      const state = states.get(String(id));
      return state ? { selection: state.selection, hours: state.hours, seq: state.seq, cache: state.cache, data: state.data } : undefined;
    },
    selectRegion,
    selectWindow,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(timer);
      observer?.disconnect();
      for (const state of states.values()) { detach(state); state.disposed = true; }
      states.clear();
      hosts.clear();
    },
  };
}
