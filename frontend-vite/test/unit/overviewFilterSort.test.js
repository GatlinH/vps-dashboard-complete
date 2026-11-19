import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import postcss from 'postcss';
import {
  overviewSortValue,
  loadOverviewChoice,
  saveOverviewChoice,
} from '../../src/pages/overviewFilterSort.js';

let render;
let destroy;
let normalizeServer;
let state;
let preferences;
let createMobileBottomNav;
let theme = 'dark';
const storage = new Map();
const controls = [];
const pingHosts = [];
const container = {
  children: [],
  append(...children) {
    this.children.push(...children);
  },
};
function element(attributes = {}) {
  const listeners = new Map();
  return {
    attributes,
    children: [],
    dataset: {},
    isConnected: true,
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    getAttribute: (name) => attributes[name] ?? null,
    append(...children) {
      this.children.push(...children);
    },
    appendChild(child) {
      this.children.push(child);
    },
    remove() {
      this.isConnected = false;
    },
    addEventListener(type, listener) {
      const handlers = listeners.get(type) || [];
      handlers.push(listener);
      listeners.set(type, handlers);
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) || []).filter((handler) => handler !== listener),
      );
    },
    dispatch(type, target = this, key) {
      for (const listener of listeners.get(type) || [])
        listener({ type, target, key, preventDefault() {}, stopPropagation() {} });
    },
    click() {
      this.dispatch('click');
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
    classList: { toggle: vi.fn() },
  };
}
const root = {
  attributes: {},
  setAttribute(name, value) {
    this.attributes[name] = value;
  },
  getAttribute(name) {
    return this.attributes[name] ?? null;
  },
  removeAttribute(name) {
    delete this.attributes[name];
  },
  isConnected: true,
  get innerHTML() {
    return this.html || '';
  },
  set innerHTML(html) {
    this.html = html;
    for (const host of pingHosts) host.isConnected = false;
    pingHosts.length = 0;
    for (const match of html.matchAll(/class="overview-ping" data-server-id="([^"]+)"/g)) {
      const host = element();
      host.dataset.serverId = match[1];
      host.contains = () => true;
      pingHosts.push(host);
    }
    controls.length = 0;
    for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      const attributes = Object.fromEntries(
        [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((attribute) => [
          attribute[1],
          attribute[2],
        ]),
      );
      controls.push({
        ...element(attributes),
        dataset: { currency: attributes['data-currency'] },
        textContent: match[2].replace(/<[^>]*>/g, ''),
      });
    }
    if (html.includes('id="languageSelect"')) controls.push(element({ id: 'languageSelect' }));
  },
  querySelector(selector) {
    if (selector === '.public-overview-page')
      return this.innerHTML.includes('lcars-theme-applied') ? this : null;
    return selector.startsWith('#')
      ? controls.find((control) => control.attributes.id === selector.slice(1))
      : null;
  },
  querySelectorAll(selector) {
    if (selector === '.overview-ping[data-server-id]') return pingHosts;
    if (selector.startsWith('.currency-btn'))
      return controls.filter((control) => control.attributes['data-currency']);
    if (selector === '.overview-group-tab')
      return controls.filter((control) => control.attributes['data-group-key']);
    const attribute = selector.match(/^\[([^\]]+)\]$/)?.[1];
    return attribute ? controls.filter((control) => attribute in control.attributes) : [];
  },
};
const button = (attribute, value) =>
  controls.find((control) => control.attributes[attribute] === value);

beforeAll(async () => {
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  vi.stubGlobal('localStorage', localStorage);
  vi.stubGlobal('window', {
    localStorage,
    location: { origin: 'http://local.test' },
    __DBG__: { API_ROOT: '' },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal('location', window.location);
  vi.stubGlobal(
    'CustomEvent',
    class {
      constructor(type) {
        this.type = type;
      }
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ regions: [{ region: 'Asia' }], targets: [] }),
    })),
  );
  vi.stubGlobal('document', {
    createElement: () => element(),
    documentElement: {
      getAttribute: () => theme,
      setAttribute: (name, value) => {
        if (name === 'data-theme') theme = value;
      },
    },
    getElementById: (id) =>
      id === 'pageRoot' ? root : id === 'app' ? container : root.querySelector(`#${id}`),
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
  });
  ({ renderPublicOverviewPage: render, destroyPublicOverviewPage: destroy } =
    await import('../../src/pages/overviewPage.js'));
  ({ normalizeServer } = await import('../../src/services/displayData.js'));
  ({ state } = await import('../../src/store/state.js'));
  preferences = await import('../../src/core/preferences.js');
  ({ createMobileBottomNav } = await import('../../src/components/solar/MobileBottomNav.js'));
});
beforeEach(() => {
  destroy();
  storage.clear();
  state.currency = 'CNY';
  preferences.configureLanguageSwitcher({ isOverviewMode: () => false });
  preferences.setLanguage('zh');
  state.servers = [
    normalizeServer({ id: 1, name: 'A', status: 'online', group_id: 1 }),
    normalizeServer({ id: 2, name: 'B', status: 'warn', group_id: 2 }),
  ];
});

const cardIds = () =>
  [
    ...root.innerHTML.matchAll(/<article class="public-overview-card[^\"]*" data-id="([^\"]+)"/g),
  ].map((match) => Number(match[1]));
const rerender = () => render(rerender);

it.each([0, 1, 4, 30])(
  'renders the cold HUD frame without rails or endcaps and ten summaries for %i nodes',
  (count) => {
    state.servers = Array.from({ length: count }, (_, index) =>
      normalizeServer({ id: index + 1, name: `Node ${index + 1}`, status: 'online' }),
    );
    rerender();
    expect(root.getAttribute('data-theme-style')).toBe('lcars');
    expect(root.innerHTML).toContain('lcars-theme-applied');
    expect(root.innerHTML).not.toMatch(/class="lcars-(?:frame|elbow|beam|rail)"/);
    expect([...root.innerHTML.matchAll(/class="lcars-endcap" aria-hidden="true"/g)]).toHaveLength(
      0,
    );
    expect(cardIds()).toHaveLength(count);
    expect([...root.innerHTML.matchAll(/data-overview-summary=/g)]).toHaveLength(10);
    expect(root.innerHTML).not.toMatch(/<table\b|overview-network-table/);
    destroy();
    expect(root.getAttribute('data-theme-style')).toBeNull();
  },
);

it('has four group-scoped status slices and keeps ten global summaries through real clicks', () => {
  state.servers.push(normalizeServer({ id: 3, name: 'C', group_id: 2, status: 'offline' }));
  rerender();
  expect(controls.filter((control) => control.attributes['data-overview-status'])).toHaveLength(4);
  button('data-group-key', '2').click();
  for (const [key, ids, count] of [
    ['all', [3, 2], 2],
    ['online', [], 0],
    ['warn', [2], 1],
    ['offline', [3], 1],
  ]) {
    button('data-overview-status', key).click();
    expect(storage.get('vps_overview_status_filter')).toBe(key);
    expect(cardIds()).toEqual(ids);
    expect(button('data-overview-status', key).textContent).toContain(String(count));
    expect(button('data-overview-status', key).getAttribute('aria-pressed')).toBe('true');
    expect([...root.innerHTML.matchAll(/data-overview-summary=/g)]).toHaveLength(10);
    expect(root.innerHTML).toMatch(
      /data-overview-summary="nodes"[\s\S]*?overview-summary-value">3</,
    );
    if (!ids.length) expect(root.innerHTML).toContain(preferences.t('overviewNoNodes'));
  }
});

it.each(['default', 'cpu', 'ram', 'speed', 'expiry', 'traffic'])(
  'sorts actual cards by %s without letting controller priority override metrics',
  (key) => {
    state.servers = [
      normalizeServer({
        id: 1,
        name: 'master',
        status: 'online',
        cpu_use: 0,
        ram_use: 0,
        net_up: 0,
        net_down: 0,
        traffic_used_gb: 0,
        expiry: '2027-02-01',
      }),
      normalizeServer({
        id: 2,
        name: 'high',
        status: 'online',
        cpu_use: 90,
        ram_use: 90,
        net_up: 100,
        net_down: 20,
        traffic_up_gb: 5,
        traffic_down_gb: 5,
        expiry: '2027-01-01',
      }),
      normalizeServer({ id: 3, name: 'unknown', status: 'offline' }),
    ];
    rerender();
    expect(controls.filter((control) => control.attributes['data-overview-sort'])).toHaveLength(6);
    button('data-overview-sort', key).click();
    expect(storage.get('vps_overview_sort')).toBe(key);
    expect(cardIds()).toEqual(key === 'default' ? [1, 3, 2] : [2, 1, 3]);
    expect(root.innerHTML).toContain('is-master');
    expect(button('data-overview-sort', key).getAttribute('aria-pressed')).toBe('true');
    expect(root.innerHTML.indexOf('overview-filter-sort')).toBeGreaterThan(
      root.innerHTML.indexOf('overview-summary-grid'),
    );
    expect(root.innerHTML.indexOf('overview-filter-sort')).toBeLessThan(
      root.innerHTML.indexOf('public-overview-main-grid'),
    );
  },
);

it('uses the real default comparator for equal metrics', () => {
  state.servers = [
    normalizeServer({ id: 1, name: 'master', cpu_use: 50 }),
    normalizeServer({ id: 2, name: 'A', cpu_use: 50 }),
  ];
  rerender();
  button('data-overview-sort', 'cpu').click();
  expect(cardIds()).toEqual([1, 2]);
});

it('rejects invalid storage and tampered buttons and reads current storage, not old closures', () => {
  for (const key of [
    'vps_overview_group_filter',
    'vps_overview_status_filter',
    'vps_overview_sort',
  ])
    storage.set(key, 'illegal');
  rerender();
  expect(button('data-group-key', 'all').getAttribute('aria-selected')).toBe('true');
  expect(button('data-overview-status', 'all').getAttribute('aria-pressed')).toBe('true');
  expect(button('data-overview-sort', 'default').getAttribute('aria-pressed')).toBe('true');
  for (const [attribute, value, key, fallback] of [
    ['data-group-key', '2', 'vps_overview_group_filter', 'all'],
    ['data-overview-status', 'warn', 'vps_overview_status_filter', 'all'],
    ['data-overview-sort', 'cpu', 'vps_overview_sort', 'default'],
  ]) {
    const control = button(attribute, value);
    control.attributes[attribute] = 'illegal';
    control.click();
    expect(storage.get(key)).toBe(fallback);
  }
  storage.set('vps_overview_status_filter', 'warn');
  storage.set('vps_overview_sort', 'ram');
  button('data-group-key', '2').click();
  expect(cardIds()).toEqual([2]);
  expect(button('data-overview-sort', 'ram').getAttribute('aria-pressed')).toBe('true');
  render();
  button('data-overview-status', 'all').click();
  expect(button('data-overview-status', 'all').getAttribute('aria-pressed')).toBe('true');
});

it.each([0, 1, 4, 30])(
  'renders %i genuine nodes without placeholders after control clicks',
  (count) => {
    state.servers = Array.from({ length: count }, (_, index) =>
      normalizeServer({ id: index + 1, name: `node-${index}`, status: 'online' }),
    );
    rerender();
    button('data-overview-status', 'online').click();
    button('data-overview-sort', 'cpu').click();
    expect(cardIds()).toHaveLength(count);
    button('data-overview-status', 'offline').click();
    expect(cardIds()).toEqual([]);
  },
);

it.each(['cpu', 'ram', 'speed', 'traffic'])(
  'keeps real zero distinct from missing, invalid and partial %s values',
  (key) => {
    const metric = key === 'cpu' || key === 'ram' ? `${key}_use` : null;
    const zero = normalizeServer({
      cpu_use: 0,
      ram_use: 0,
      net_up: 0,
      net_down: 0,
      traffic_used_gb: 0,
    });
    expect(overviewSortValue(zero, key)).toBe(0);
    expect(overviewSortValue(normalizeServer({}), key)).toBeNull();
    if (metric) {
      for (const value of [-1, 101, Infinity, NaN, '', null, true])
        expect(
          overviewSortValue({ [metric]: value, __liveMetricFlags: { [metric]: true } }, key),
        ).toBeNull();
    } else {
      expect(
        overviewSortValue(
          normalizeServer(key === 'speed' ? { net_up: 9 } : { traffic_up_gb: 9 }),
          key,
        ),
      ).toBeNull();
      expect(
        overviewSortValue(
          normalizeServer(key === 'speed' ? { net_up: -1, net_down: 9 } : { traffic_used_gb: -1 }),
          key,
        ),
      ).toBeNull();
    }
  },
);

it('rejects invalid expiry and tolerates unavailable persistence', () => {
  for (const expiry of [null, '', 'not-a-date', Infinity, '2027-02-30'])
    expect(overviewSortValue({ expiry }, 'expiry')).toBeNull();
  const unavailable = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  expect(loadOverviewChoice(unavailable, 'key', ['all'], 'all')).toBe('all');
  expect(saveOverviewChoice(unavailable, 'key', 'bad', ['all'], 'all')).toBe('all');
});

it('runs original wrapper, topbar setters and footer after group/status/sort replacement', async () => {
  const expectNoNetworkTable = () => {
    expect(root.innerHTML).not.toContain('overview-network-table');
    expect(root.innerHTML).not.toContain('overview-network-table-toggle');
    expect(root.innerHTML).not.toContain(preferences.t('nodeNetworkDetails'));
    expect(root.innerHTML).not.toContain(preferences.t('networkDetails'));
    expect(root.innerHTML).not.toMatch(/<table\b/);
    expect(root.innerHTML.match(/data-overview-summary=/g)).toHaveLength(10);
  };
  const source = readFileSync(new URL('../../src/modules/serverTable.js', import.meta.url), 'utf8');
  const names = [
    'renderPublicOverviewPage',
    'bindTopbarEvents',
    'setCurrency',
    'mountMobileBottomNav',
    'isCesiumVisible',
  ];
  const bodies = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
    .body.filter((node) => node.type === 'FunctionDeclaration' && names.includes(node.id.name))
    .map((node) => source.slice(node.start, node.end))
    .join('\n');
  const { updateRateDisplay } = await import('../../src/utils/currency.js');
  const context = vm.createContext({
    renderPublicOverviewPageModule: render,
    document,
    window,
    state,
    setLanguage: preferences.setLanguage,
    toggleTheme: preferences.toggleTheme,
    updateRateDisplay,
    selectedServerId: null,
    overviewMode: true,
    createMobileBottomNav,
    route: new URLSearchParams('overview=1'),
  });
  const wrapper = vm.runInContext(
    `let mobileBottomNav = null; ${bodies}; renderPublicOverviewPage`,
    context,
  );
  preferences.configureLanguageSwitcher({ isOverviewMode: () => true, renderOverview: wrapper });
  const intervals = vi.spyOn(globalThis, 'setInterval');
  wrapper();
  expectNoNetworkTable();
  await vi.waitFor(() =>
    expect(pingHosts.find((host) => host.dataset.serverId === '2').innerHTML).toContain('Asia'),
  );
  const initialPing = pingHosts.find((host) => host.dataset.serverId === '2');
  const regionValue = initialPing.innerHTML.match(/<option value="([^"]+)"[^>]*>Asia<\/option>/)[1];
  const regionControl = { tagName: 'SELECT', value: regionValue, dataset: { pingRegion: 'all' } };
  regionControl.closest = () => regionControl;
  initialPing.dispatch('change', regionControl);
  const hoursValue = initialPing.innerHTML.match(/data-ping-hours="(6)"/)[1];
  const hoursControl = { tagName: 'BUTTON', dataset: { pingHours: hoursValue } };
  hoursControl.closest = () => hoursControl;
  for (const type of ['click', 'change', 'keydown'])
    expect(initialPing.listenerCount(type)).toBe(1);
  initialPing.dispatch('keydown', hoursControl, 'Enter');
  const nav = container.children.at(-2);
  expect(nav.children[1].getAttribute('aria-pressed')).toBe('true');
  for (const [attribute, value] of [
    ['data-group-key', '2'],
    ['data-overview-status', 'warn'],
    ['data-overview-sort', 'cpu'],
  ]) {
    button(attribute, value).click();
    expectNoNetworkTable();
    const themeButton = root.querySelector('#themeToggle');
    expect(themeButton.listenerCount('click')).toBe(1);
    themeButton.click();
    expectNoNetworkTable();
    expect(storage.get('display_theme')).toBe(theme);
    const language = root.querySelector('#languageSelect');
    expect(language.listenerCount('change')).toBe(1);
    language.value = 'en';
    language.dispatch('change');
    expectNoNetworkTable();
    expect(storage.get('display_language')).toBe('en');
    button('data-currency', 'USD').click();
    expectNoNetworkTable();
    expect(state.currency).toBe('USD');
    expect(nav.children[1].getAttribute('aria-pressed')).toBe('true');
    expect(container.children.at(-2)).toBe(nav);
    expect(root.querySelector('#themeToggle').listenerCount('click')).toBe(1);
    expect(pingHosts.map((host) => Number(host.dataset.serverId))).toEqual(cardIds());
    const currentPing = pingHosts[0];
    expect(currentPing.innerHTML).toContain(`data-ping-region="${regionValue}"`);
    expect(currentPing.innerHTML).toMatch(/data-ping-hours="6"[^>]*aria-pressed="true"/);
    expect(initialPing.listenerCount('click')).toBe(0);
    expect(currentPing.listenerCount('click')).toBe(1);
  }
  expect(intervals).toHaveBeenCalledTimes(1);
  intervals.mockRestore();
  vm.runInContext('mobileBottomNav.destroy()', context);
});
afterAll(() => {
  destroy();
  vi.unstubAllGlobals();
});

it('persists a real group click before requesting the production owner rerender', () => {
  const request = vi.fn(() => {
    expect(storage.get('vps_overview_group_filter')).toBe('2');
    render(request);
  });
  render(request);
  button('data-group-key', '2').click();
  expect(request).toHaveBeenCalledTimes(1);
  expect(button('data-group-key', '2').getAttribute('aria-selected')).toBe('true');
});

it('renders the compact v2 sequence without hero, aside or duplicate section headings', () => {
  rerender();
  expect(root.innerHTML).toContain('overview-layout-v2');
  expect(root.innerHTML).not.toMatch(
    /overview-layout-p1|public-overview-hero|public-overview-visual|<aside|public-overview-section-head/,
  );
  const sequence = [
    'public-overview-floating-topbar',
    'overview-group-filter',
    'overview-summary-grid',
    'overview-filter-sort',
    'public-overview-main-grid',
  ];
  expect(sequence.map((marker) => root.innerHTML.indexOf(marker))).toEqual(
    sequence
      .map((marker) => root.innerHTML.indexOf(marker))
      .sort((first, second) => first - second),
  );
  expect(root.innerHTML).toContain('id="themeToggle"');
  expect(root.innerHTML).toContain('id="languageSelect"');
  expect(root.innerHTML).not.toContain('overview-network-table');
  expect(root.innerHTML).not.toContain('overview-network-table-toggle');
  expect(root.innerHTML).not.toContain(preferences.t('nodeNetworkDetails'));
});

it('keeps all thirty expiry rows reachable behind closed summary details', () => {
  state.servers = Array.from({ length: 30 }, (_, index) =>
    normalizeServer({
      id: index + 1,
      name: `expiry-long-${index}`,
      expiry: '2027-01-01',
      status: 'offline',
      price: 10,
      period: 'monthly',
      location: `region-${index}`,
      provider: `provider-${index}`,
    }),
  );
  rerender();
  const summary = root.innerHTML.slice(
    root.innerHTML.indexOf('overview-summary-grid'),
    root.innerHTML.indexOf('overview-filter-sort'),
  );
  expect(summary).toMatch(/<details class="overview-summary-details"[^>]*>/);
  expect(summary).not.toMatch(/<details[^>]*\bopen\b/);
  expect(summary).toContain('expiry-long-29');
  expect(summary).toContain('data-panel="abnormal"');
  expect(summary).toContain('data-overview-cost-panel="region"');
  expect(summary).toContain('data-overview-cost-panel="provider"');
});

it('preserves cost slices through owner rerenders and currency/language changes', () => {
  rerender();
  expect(button('data-overview-cost-view', 'region')).toBeDefined();
  button('data-overview-cost-view', 'region').click();
  state.currency = 'USD';
  preferences.setLanguage('en');
  rerender();
  expect(button('data-overview-cost-view', 'region').getAttribute('aria-pressed')).toBe('true');
  expect(root.innerHTML).toMatch(/data-overview-cost-panel="region"(?! hidden)/);
  expect(button('data-overview-status', 'all').getAttribute('aria-pressed')).toBe('true');
});

it('labels traffic as the usage/positive-limit set without changing RAM semantics', () => {
  rerender();
  const traffic = root.innerHTML.split('data-overview-summary="traffic"')[1].split('</section>')[0];
  expect(traffic).toContain(preferences.t('overviewSummaryTrafficMatched'));
  expect(traffic).not.toContain(preferences.t('overviewSummaryMatched'));
});

it('renders expiry and abnormal panels exactly once, only in the expiry card', () => {
  rerender();
  for (const key of ['expiry', 'abnormal']) {
    expect([...root.innerHTML.matchAll(new RegExp(`data-panel="${key}"`, 'g'))]).toHaveLength(1);
    expect(root.innerHTML.indexOf(`data-panel="${key}"`)).toBeGreaterThan(
      root.innerHTML.indexOf('data-overview-summary="expiry"'),
    );
  }
});

it('keeps primary captions visible outside closed details', () => {
  state.servers = [
    normalizeServer({
      id: 1,
      name: 'peak-real-node',
      status: 'online',
      arch: 'x86_64',
      os: 'Debian',
      cpu: 4,
      cpu_use: 50,
      ram: 16,
      ram_use: 50,
      disk: 100,
      disk_use: 25,
      net_up: 8,
      net_down: 16,
      traffic_used_gb: 10,
      traffic_limit_gb: 100,
      price: 12,
      period: 'monthly',
    }),
  ];
  rerender();
  const visible = (key) =>
    root.innerHTML.split(`data-overview-summary="${key}"`)[1].split('<details')[0];
  expect(visible('nodes')).toContain(preferences.t('online'));
  expect(visible('platforms')).toContain('x86_64');
  expect(visible('platforms')).toContain('Debian');
  expect(visible('cpu')).toContain(preferences.t('overviewSummaryAverage'));
  expect(visible('cpu')).toContain('1/1');
  expect(visible('load')).toContain('peak-real-node');
  for (const key of ['ram', 'disk']) {
    expect(visible(key)).toContain(preferences.t('overviewSummaryUsed'));
    expect(visible(key)).toContain('%');
  }
  expect(visible('rates')).toContain('↓');
  expect(visible('traffic')).toContain(preferences.t('overviewSummaryLimit'));
  expect(visible('cost')).toContain(preferences.t('overviewSummaryKnown'));
  expect(visible('cost')).toContain(preferences.t('overviewSummaryAnnual'));
});

it('isolates legacy control geometry and gives tablet summaries two columns', () => {
  const main = postcss.parse(
    readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8'),
  );
  main.walkRules((rule) => {
    if (
      !rule.selector.includes('.public-overview-page') ||
      !/\.(theme-toggle|language-select|currency-btn|detail-currency-switch|public-overview-tools)/.test(
        rule.selector,
      )
    )
      return;
    rule.walkDecls((declaration) => {
      if (
        declaration.important &&
        /^(width|min-width|max-width|min-height|padding|gap|flex)$/.test(declaration.prop)
      ) {
        expect(
          rule.selector
            .split(',')
            .every((selector) => selector.includes(':not(.overview-layout-v2)')),
        ).toBe(true);
      }
    });
  });
  const themeCss = postcss.parse(
    readFileSync(new URL('../../src/styles/starfleet-theme.css', import.meta.url), 'utf8'),
  );
  let tablet = false;
  themeCss.walkAtRules('media', (media) => {
    if (!media.params.includes('1280px')) return;
    media.walkRules((rule) => {
      if (!rule.selector.includes('.overview-layout-v2 .overview-summary-grid')) return;
      rule.walkDecls('grid-template-columns', (declaration) => {
        tablet ||= declaration.value === 'repeat(2, minmax(0, 1fr))';
      });
    });
  });
  expect(tablet).toBe(true);
});

it('removes the LCARS root marker when the overview route exits', () => {
  rerender();
  const checkRoute = window.addEventListener.mock.calls.find(([type]) => type === 'popstate')[1];
  root.innerHTML = '<section class="detail-page-shell"></section>';
  checkRoute();
  expect(root.getAttribute('data-theme-style')).toBeNull();
});
