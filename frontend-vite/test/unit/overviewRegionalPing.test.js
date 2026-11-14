import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeRegionSelection } from '../../src/services/regionalPing.js';

const east = encodeRegionSelection({ kind: 'region', region: '东亚 & /+' });
const west = encodeRegionSelection({ kind: 'region', region: '欧洲' });
const regions = [
  { region: '东亚 & /+', ungrouped: false, target_count: 2 },
  { region: '欧洲', ungrouped: false, target_count: 1 },
  { region: '', ungrouped: true, target_count: 1 },
];
const slot = (status, start, extra = {}) => ({
  start,
  end: start + 300,
  status,
  count: status === 'missing' ? 0 : 1,
  latency_ms: null,
  loss_pct: null,
  report_failure_pct: null,
  ...extra,
});
const payload = (label = '真实目标', overrides = {}) => ({
  hours: 1,
  regions,
  targets: [
    {
      key: 'external-1',
      label,
      type: 'external',
      protocol: 'tcp',
      region: '东亚 & /+',
      summary: { latency_ms: 0, loss_pct: null, observed_at: 1794000300, sample_source: 'agent' },
      slots: [slot('missing', 1794000000), slot('ok', 1794000300, { latency_ms: 0 })],
      points: [],
    },
  ],
  ...overrides,
});

class Element {
  constructor(dataset = {}, classes = '') {
    this.dataset = dataset;
    this.classes = classes.split(' ');
    this.listeners = new Map();
    this.children = [];
    this.isConnected = true;
    this.innerHTML = '';
    this.attributes = new Map();
  }
  matches(selector) {
    return selector.split(',').some((part) => {
      const value = part.trim();
      if (value.includes('[data-ping-region]')) return this.dataset.pingRegion !== undefined;
      if (value.includes('[data-ping-hours]')) return this.dataset.pingHours !== undefined;
      if (value.includes('[data-ping-slot]')) return this.dataset.pingSlot !== undefined;
      if (value.includes('[data-overview-interactive]'))
        return this.dataset.overviewInteractive !== undefined;
      if (value.startsWith('.')) return this.classes.includes(value.slice(1).split(/[ .\[]/)[0]);
      return value === 'button' && this.tagName === 'BUTTON';
    });
  }
  closest(selector) {
    return this.matches(selector) ? this : this.parentElement?.closest(selector) || null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  getAttribute(name) {
    return name === 'data-id' ? this.dataset.id : (this.attributes.get(name) ?? null);
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || new Set();
    handlers.add(handler);
    this.listeners.set(type, handlers);
  }
  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  contains(child) {
    return child === this || this.children.some((entry) => entry.contains(child));
  }
  remove() {
    this.isConnected = false;
  }
  dispatch(type, options = {}) {
    const event = {
      type,
      target: this,
      key: '',
      defaultPrevented: false,
      stopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
      ...options,
    };
    let current = this;
    while (current) {
      event.currentTarget = current;
      for (const handler of current.listeners.get(type) || []) handler(event);
      if (event.stopped) break;
      current = current.parentElement;
    }
    return event;
  }
}

class Observer {
  static instances = [];
  constructor(callback) {
    this.callback = callback;
    this.observed = new Set();
    Observer.instances.push(this);
  }
  observe(element) {
    this.observed.add(element);
  }
  unobserve(element) {
    this.observed.delete(element);
  }
  disconnect() {
    this.observed.clear();
    this.disconnected = true;
  }
  emit(elements, visible = true) {
    this.callback(elements.map((target) => ({ target, isIntersecting: visible })));
  }
}

function rootFor(ids) {
  const root = new Element({}, 'public-overview-page');
  for (const id of ids) root.appendChild(new Element({ serverId: String(id) }, 'overview-ping'));
  return root;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

const controllers = [];
let page;
let display;
let store;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-07T08:00:00Z'));
  Observer.instances = [];
  const localStorage = { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() };
  const location = {
    origin: 'http://local.test',
    protocol: 'http:',
    hostname: 'local.test',
    port: '',
    href: '/',
  };
  vi.stubGlobal('window', {
    localStorage,
    location,
    __DBG__: { API_ROOT: '' },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('location', location);
  vi.stubGlobal('localStorage', localStorage);
  vi.stubGlobal('document', {
    body: new Element(),
    documentElement: { getAttribute: () => 'dark', setAttribute: vi.fn() },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => new Element(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('IntersectionObserver', Observer);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => payload() }));
  page = await import('../../src/pages/overviewPage.js');
  display = await import('../../src/services/displayData.js');
  store = (await import('../../src/store/state.js')).state;
  store.currency = 'CNY';
  store.servers = [];
});

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.destroy());
  page?.destroyPublicOverviewPage?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mounted(ids, fetchOverview = vi.fn().mockResolvedValue(payload())) {
  const { createOverviewPingController } = await import('../../src/services/overviewPing.js');
  const controller = createOverviewPingController({ fetchOverview, Observer });
  controllers.push(controller);
  const root = rootFor(ids);
  controller.mount(root, ids);
  return { controller, root, observer: Observer.instances.at(-1), fetchOverview };
}

describe('overview production metadata and rendering', () => {
  it('keeps complete metadata for filtered responses and removes peers', async () => {
    const { normalizeOverviewPingData } = await import('../../src/services/overviewPing.js');
    const input = payload('东亚', {
      targets: [
        ...payload().targets,
        { key: 'vps-9', type: 'external' },
        { key: 'peer-9', type: 'peer' },
      ],
    });
    const data = normalizeOverviewPingData(input);
    expect(data.regions).toEqual(regions);
    expect(data.targets.map((target) => target.key)).toEqual(['external-1']);
    expect(data.targets[0].summary).toEqual(input.targets[0].summary);
    expect(input.targets).toHaveLength(3);
  });

  it('renders zero ms, null loss, full failure and chronological gaps honestly', async () => {
    const { normalizeOverviewPingData, renderOverviewPing } =
      await import('../../src/services/overviewPing.js');
    const data = normalizeOverviewPingData(
      payload('<真实 & 目标>', {
        targets: [
          {
            ...payload().targets[0],
            label: '<真实 & 目标>',
            slots: [
              slot('fail', 1794000900, { report_failure_pct: 100 }),
              slot('missing', 1794000000),
              slot('loss', 1794000600, { latency_ms: 8, loss_pct: 25 }),
              slot('ok', 1794000300, { latency_ms: 0, loss_pct: null }),
            ],
          },
        ],
      }),
    );
    const html = renderOverviewPing({ id: '1', selection: 'all', hours: 1, data });
    expect(html).toContain('&lt;真实 &amp; 目标&gt;');
    expect(html).toContain('0 ms');
    expect(html).toMatch(/overview-ping-loss[^>]*>—</);
    for (const status of ['ok', 'loss', 'fail', 'missing']) expect(html).toContain(`is-${status}`);
    expect(html.indexOf('data-start="1794000000"')).toBeLessThan(
      html.indexOf('data-start="1794000300"'),
    );
    for (const observed of ['100%', 'agent', '1794000300']) expect(html).toContain(observed);
    expect(html).not.toContain('vps-');
    expect(
      renderOverviewPing({
        id: '1',
        selection: 'all',
        hours: 24,
        data: normalizeOverviewPingData({ regions: [], targets: [] }),
      }),
    ).toContain('暂无外部目标');
  });

  it('records raw inventory before fallbacks and preserves flags on re-normalization', () => {
    const missing = display.normalizeServer({ id: 1, name: '不能伪造的主机名' });
    expect(missing.__rawPresentFlags).toMatchObject({
      cpu: false,
      ram: false,
      disk: false,
      hostname: false,
      net_up: false,
      net_down: false,
      price: false,
    });
    expect(display.normalizeServer(missing).__rawPresentFlags).toEqual(missing.__rawPresentFlags);
    const actual = display.normalizeServer({
      cpu_cores: 2,
      ram_gb: 4,
      disk_gb: 80,
      net_up: 0,
      price: 0,
      agent_config: { inventory_meta: { hostname: 'real-host' } },
    });
    expect(actual.__rawPresentFlags).toMatchObject({
      cpu: true,
      ram: true,
      disk: true,
      hostname: true,
      net_up: true,
      net_down: false,
      price: true,
    });
  });

  it('renders v2 2x2 resources, three statistics and calculator without fallback specs', () => {
    const html = page.renderOverviewNodeCard(
      display.normalizeServer({ id: 7, name: '只有名字', status: 'online' }),
    );
    for (const marker of [
      'is-v2-card',
      'overview-resource-grid',
      'overview-card-stats',
      'public-money-btn',
      'data-server-id="7"',
    ]) {
      expect(html).toContain(marker);
    }
    expect(html).not.toContain('is-dense');
    expect(html).toMatch(/data-overview-field="hostname"[^>]*>—</);
    for (const fallback of ['1 核', '1.00 GB', '20.0 GB']) expect(html).not.toContain(fallback);
    expect(html).not.toMatch(/load[^>]*>0/);
    const actual = page.renderOverviewNodeCard(
      display.normalizeServer({
        id: 8,
        name: '真实',
        cpu_cores: 2,
        ram_gb: 4,
        disk_gb: 80,
        cpu_use: 0,
        ram_use: 25,
        disk_use: 50,
        hostname: 'real-host',
        net_up: 0,
        net_down: 1024,
        traffic_up_gb: 0,
        traffic_down_gb: 2,
        price: 0,
      }),
    );
    for (const observed of ['2 核', '4.00 GB', '80.0 GB', 'real-host', '0%'])
      expect(actual).toContain(observed);
  });

  it('keeps the entire original calculator implementation byte-identical', () => {
    const source = readFileSync(
      new URL('../../src/pages/overviewPage.js', import.meta.url),
      'utf8',
    );
    const calculator = source.slice(source.indexOf('function openPremiumCalculator('));
    expect(createHash('sha256').update(calculator).digest('hex')).toBe(
      'bb35a833128120f4b360c581eab7e71f056a93ff52e3c0c4169d2afaf896ce1f',
    );
  });
});

describe('overview controller, cache and scheduling', () => {
  it('keeps four card selections/windows across refresh remounts with one owner', async () => {
    const { controller, root, observer, fetchOverview } = await mounted([1, 2, 3, 4]);
    observer.emit(root.children);
    await settle();
    controller.selectRegion(1, east);
    controller.selectWindow(2, 6);
    controller.selectRegion(3, 'ungrouped');
    controller.selectWindow(4, 24);
    await settle();
    const states = [1, 2, 3, 4].map((id) => controller.getState(id));
    expect(states.map((value) => [value.selection, value.hours])).toEqual([
      [east, 1],
      ['all', 6],
      ['ungrouped', 1],
      ['all', 24],
    ]);
    const requests = fetchOverview.mock.calls.length;
    const refreshed = rootFor([1, 2, 3, 4]);
    controller.mount(refreshed, [1, 2, 3, 4]);
    observer.emit(refreshed.children);
    await settle();
    expect([1, 2, 3, 4].map((id) => controller.getState(id))).toEqual(states);
    expect(fetchOverview).toHaveBeenCalledTimes(requests);
    expect(refreshed.children[0].innerHTML).toContain('data-ping-region="region:');
    expect(refreshed.children[0].innerHTML).toContain('欧洲');
    expect(Observer.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('resets vanished regions using full metadata rather than filtered targets', async () => {
    const { controller, root, observer, fetchOverview } = await mounted([1]);
    observer.emit(root.children);
    await settle();
    controller.selectRegion(1, west);
    await settle();
    expect(controller.getState(1).selection).toBe(west);
    expect(controller.getState(1).data.regions).toEqual(regions);
    fetchOverview.mockResolvedValue(payload('新区', { regions: [regions[0]] }));
    await vi.advanceTimersByTimeAsync(30000);
    await settle();
    expect(controller.getState(1).selection).toBe('all');
    expect(encodeRegionSelection(fetchOverview.mock.calls.at(-1)[3])).toBe('all');
  });

  it('shows fast B only after slow A and never caches superseded data', async () => {
    const slow = deferred();
    const transport = vi
      .fn()
      .mockResolvedValueOnce(payload())
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce(payload('fast B'));
    const { controller, root, observer } = await mounted([1], transport);
    observer.emit(root.children);
    await settle();
    controller.selectRegion(1, east);
    await settle();
    const signalA = transport.mock.calls[1][4];
    controller.selectRegion(1, west);
    await settle();
    expect(signalA.aborted).toBe(true);
    slow.resolve(payload('slow A'));
    await settle();
    expect(controller.getState(1).selection).toBe(west);
    expect(root.children[0].innerHTML).toContain('fast B');
    expect(root.children[0].innerHTML).not.toContain('slow A');
    expect(controller.getState(1).cache.has(`${east}|1`)).toBe(false);
  });

  it('lazily reads twenty visible cards with at most four concurrent transports', async () => {
    let active = 0;
    let maximum = 0;
    const pending = [];
    const transport = vi.fn(() => {
      active += 1;
      maximum = Math.max(maximum, active);
      const request = deferred();
      pending.push(request);
      return request.promise.finally(() => {
        active -= 1;
      });
    });
    const { root, observer } = await mounted(
      Array.from({ length: 20 }, (_, index) => index + 1),
      transport,
    );
    expect(transport).not.toHaveBeenCalled();
    observer.emit(root.children);
    await settle();
    expect(transport).toHaveBeenCalledTimes(4);
    for (let batch = 0; batch < 5; batch += 1) {
      pending.splice(0).forEach((request) => request.resolve(payload()));
      await settle();
    }
    expect(transport).toHaveBeenCalledTimes(20);
    expect(maximum).toBe(4);
  });

  it('aborts offscreen work, drops queued reads, disposes IDs and stops on destroy', async () => {
    const pending = [];
    const transport = vi.fn((id, hours, source, selection, signal) => {
      const request = deferred();
      pending.push({ request, signal });
      signal.addEventListener('abort', () =>
        request.reject(new DOMException('aborted', 'AbortError')),
      );
      return request.promise;
    });
    const { controller, root, observer } = await mounted([1, 2, 3, 4, 5, 6], transport);
    observer.emit(root.children);
    await settle();
    observer.emit(root.children, false);
    await settle();
    expect(pending.every(({ signal }) => signal.aborted)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(4);
    controller.mount(rootFor([2]), [2]);
    expect(controller.getState(1)).toBeUndefined();
    const detached = root.children[0].innerHTML;
    controller.destroy();
    observer.emit(root.children);
    await vi.advanceTimersByTimeAsync(90000);
    expect(transport).toHaveBeenCalledTimes(4);
    expect(root.children[0].innerHTML).toBe(detached);
    expect(observer.disconnected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects disposed generation responses when the same ID is added again', async () => {
    const slow = deferred();
    const transport = vi
      .fn()
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValue(payload('new node'));
    const { controller, root, observer } = await mounted([1], transport);
    observer.emit(root.children);
    await settle();
    controller.mount(rootFor([]), []);
    const replacement = rootFor([1]);
    controller.mount(replacement, [1]);
    observer.emit(replacement.children);
    await settle();
    slow.resolve(payload('disposed node'));
    await settle();
    expect(replacement.children[0].innerHTML).toContain('new node');
    expect(replacement.children[0].innerHTML).not.toContain('disposed node');
  });
});

describe('overview production events and navigation', () => {
  it('blocks control click/hover/Enter/Space while bare card links to details', () => {
    const card = new Element({ id: '42' }, 'public-overview-card is-v2-card');
    const money = card.appendChild(
      new Element(
        { id: '42', name: 'server', base: '88', overviewInteractive: '' },
        'public-money-btn',
      ),
    );
    const navigate = vi.fn();
    const openCalculator = vi.fn();
    page.bindOverviewCardEvents(card, { navigate, openCalculator });
    for (const key of ['pingRegion', 'pingHours', 'pingSlot']) {
      const control = card.appendChild(
        new Element({ [key]: key === 'pingRegion' ? east : '6', overviewInteractive: '' }),
      );
      expect(control.dispatch('click').stopped).toBe(true);
      expect(control.dispatch('pointerover').stopped).toBe(true);
      for (const activation of ['Enter', ' '])
        expect(control.dispatch('keydown', { key: activation }).stopped).toBe(true);
    }
    expect(navigate).not.toHaveBeenCalled();
    money.dispatch('click');
    expect(openCalculator).toHaveBeenCalledWith({ id: '42', name: 'server', base: 88 });
    expect(navigate).not.toHaveBeenCalled();
    card.dispatch('click');
    card.dispatch('keydown', { key: 'Enter' });
    card.dispatch('keydown', { key: ' ' });
    expect(navigate.mock.calls).toEqual([['/?server=42'], ['/?server=42'], ['/?server=42']]);
  });

  it('activates read-only region/window controls without card navigation', async () => {
    const { controller, root, observer, fetchOverview } = await mounted([1]);
    observer.emit(root.children);
    await settle();
    const regionButton = root.children[0].appendChild(
      new Element({ pingRegion: east, overviewInteractive: '' }),
    );
    const windowButton = root.children[0].appendChild(
      new Element({ pingHours: '24', overviewInteractive: '' }),
    );
    expect(regionButton.dispatch('click').stopped).toBe(true);
    await settle();
    expect(windowButton.dispatch('keydown', { key: ' ' }).stopped).toBe(true);
    await settle();
    expect(controller.getState(1)).toMatchObject({ selection: east, hours: 24 });
    expect(
      fetchOverview.mock.calls.every(
        (call) => call[2] === 'external' && call[4] instanceof AbortSignal,
      ),
    ).toBe(true);
    expect(encodeRegionSelection(fetchOverview.mock.calls.at(-1)[3])).toBe(east);
  });
});
