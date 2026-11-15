import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let renderPublicOverviewPage;
let destroyPublicOverviewPage;
let normalizeServer;
let state;
let storage;
let summarizeOverview;
let setLanguage;
let LANGUAGE_PACKS;
const root = {
  innerHTML: '',
  isConnected: true,
  querySelector: () => null,
  querySelectorAll: () => [],
};
const summaryKeys = [
  'nodes',
  'platforms',
  'cpu',
  'load',
  'ram',
  'disk',
  'rates',
  'traffic',
  'cost',
  'expiry',
];

beforeAll(async () => {
  storage = new Map();
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
  vi.stubGlobal('document', {
    documentElement: { getAttribute: () => 'dark', setAttribute: vi.fn() },
    getElementById: (id) => (id === 'pageRoot' ? root : null),
    querySelectorAll: () => [],
  });
  ({ renderPublicOverviewPage, destroyPublicOverviewPage, summarizeOverview } =
    await import('../../src/pages/overviewPage.js'));
  ({ normalizeServer } = await import('../../src/services/displayData.js'));
  ({ state } = await import('../../src/store/state.js'));

  ({ setLanguage, LANGUAGE_PACKS } = await import('../../src/core/preferences.js'));
});

beforeEach(() => {
  destroyPublicOverviewPage();
  storage.clear();
  setLanguage('zh');
  state.servers = [];
  root.innerHTML = '';
});

afterAll(() => {
  destroyPublicOverviewPage();
  vi.unstubAllGlobals();
});

describe('public overview real summary entry', () => {
  it('renders ten ordered global summaries after groups even with no reports', () => {
    renderPublicOverviewPage();
    expect(
      [...root.innerHTML.matchAll(/data-overview-summary="([^"]+)"/g)].map((match) => match[1]),
    ).toEqual(summaryKeys);
    expect(root.innerHTML.indexOf('overview-summary-grid')).toBeGreaterThan(
      root.innerHTML.indexOf('overview-group-filter'),
    );
    expect(root.innerHTML).toContain('未上报');
    expect(root.innerHTML).toContain('未设置');
  });

  it('uses all servers, preserves node cards and reports matched memory coverage', () => {
    state.servers = [
      normalizeServer({ id: 1, name: 'A', status: 'online', group_id: 1, ram: 16, ram_use: 50 }),
      normalizeServer({ id: 2, name: 'B', status: 'online', group_id: 2, ram: 32 }),
      normalizeServer({ id: 3, name: 'C', status: 'online', group_id: 2, ram_use: 80 }),
    ];
    renderPublicOverviewPage();
    expect(root.innerHTML).toContain('data-overview-summary="ram"');
    expect(root.innerHTML).toContain('48 GB');
    expect(root.innerHTML).toContain('8 GB');
    expect(root.innerHTML).toContain('50%');
    expect(root.innerHTML).toContain('1/3');
    expect(root.innerHTML.match(/class="public-overview-card /g)).toHaveLength(3);
    expect(root.innerHTML).toContain('overview-ping');
    expect(root.innerHTML).not.toContain('overview-network-table');
    storage.set('vps_overview_group_filter', '1');
    renderPublicOverviewPage();
    expect(root.innerHTML).toContain('48 GB');
    expect(root.innerHTML.match(/class="public-overview-card /g)).toHaveLength(1);
  });

  it.each([0, 1, 4, 30])('renders %i nodes without changing global summary shape', (count) => {
    state.servers = Array.from({ length: count }, (_, index) =>
      normalizeServer({ id: index + 1, cpu: 1, status: 'online' }),
    );
    renderPublicOverviewPage();
    expect(root.innerHTML.match(/data-overview-summary=/g)).toHaveLength(10);
    const result = summarizeOverview(state.servers);
    expect(result.status).toEqual({ total: count, online: count, warn: 0, offline: 0 });
    expect(result.cpu.total).toBe(count || null);
    expect(root.innerHTML.match(/data-overview-summary=/g)).toHaveLength(10);
    expect(root.innerHTML.match(/class="public-overview-card /g) || []).toHaveLength(count);
  });

  it.each([0, 1, 4, 30])('removes network details for %i nodes across rerenders', (count) => {
    state.servers = Array.from({ length: count }, (_, index) =>
      normalizeServer({
        id: index + 1,
        name: `Network node ${index + 1}`,
        status: 'online',
        group_id: 1,
        net_up: 0,
        net_down: 1024,
        traffic_used_gb: 0,
        traffic_up_gb: 0,
        traffic_down_gb: 0,
        traffic_limit_gb: 100,
      }),
    );
    for (const language of ['zh', 'en']) {
      setLanguage(language);
      renderPublicOverviewPage();
      expect(root.innerHTML).not.toContain('overview-network-table');
      expect(root.innerHTML).not.toContain('overview-network-table-toggle');
      expect(root.innerHTML).not.toContain(LANGUAGE_PACKS[language].nodeNetworkDetails);
      expect(root.innerHTML).not.toContain(LANGUAGE_PACKS[language].networkDetails);
      expect(root.innerHTML).not.toMatch(/<table\b/);
      expect(root.innerHTML.match(/data-overview-summary=/g)).toHaveLength(10);
      const cards = [...root.innerHTML.matchAll(/<article\b[\s\S]*?<\/article>/g)];
      expect(cards).toHaveLength(count);
      for (const [card] of cards) {
        expect(card).toContain('overview-ping');
        expect(card).toContain('0 KB/s');
        expect(card).toContain('1.00 MB/s');
        expect(card).toContain('0 B / 100.0 GB');
        expect(card).toContain('public-money-btn overview-residual-btn');
      }
    }
  });

  it('renders the escaped highest-load identity inside the actual load summary card', () => {
    state.servers = [
      normalizeServer({ id: 'low', name: 'Ordinary node', status: 'online', cpu_use: 10 }),
      normalizeServer({
        id: 'peak',
        name: '<img src=x onerror="alert(1)"> & highest',
        status: 'online',
        cpu_use: 90,
      }),
    ];
    renderPublicOverviewPage();
    const loadCard = root.innerHTML.match(
      /<section[^>]*data-overview-summary="load"[\s\S]*?<\/section>/,
    )?.[0];
    expect(loadCard).toContain('90%');
    expect(loadCard).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; highest');
    expect(loadCard).not.toContain('<img');
    expect(loadCard).not.toContain('Ordinary node');
  });

  it.each([
    [{ id: 'real-id' }, 'real-id'],
    [{ id: 0 }, '0'],
    [{}, 'Unnamed Node'],
  ])(
    'uses only a real ID or translated unknown name for the load card: %s',
    (identity, expected) => {
      setLanguage('en');
      state.servers = [
        { ...identity, status: 'online', cpu_use: 0, __liveMetricFlags: { cpu_use: true } },
      ];
      renderPublicOverviewPage();
      const loadCard = root.innerHTML.match(
        /<section[^>]*data-overview-summary="load"[\s\S]*?<\/section>/,
      )?.[0];
      expect(loadCard).toContain('0%');
      expect(loadCard).toContain(expected);
    },
  );

  it('renders hidden price as not reported but legal free price as known zero', () => {
    setLanguage('en');
    state.servers = [normalizeServer({ id: 'hidden', price: 0, period: 'monthly' })];
    renderPublicOverviewPage();
    const costCard = () =>
      root.innerHTML.match(/<section[^>]*data-overview-summary="cost"[\s\S]*?<\/section>/)?.[0];
    expect(costCard()).toContain('Not reported');
    expect(costCard()).toContain('0/1');
    state.servers = [normalizeServer({ id: 'free', price: -1 })];
    renderPublicOverviewPage();
    expect(costCard()).not.toContain('Not reported');
    expect(costCard()).toContain('1/1');
    expect(summarizeOverview(state.servers).cost).toMatchObject({
      monthlyActual: 0,
      yearlyActual: 0,
      coverage: 1,
    });
  });

  it('renders English and gives every existing language readable summary strings', () => {
    setLanguage('en');
    renderPublicOverviewPage();
    expect(root.innerHTML).toContain('Architecture &amp; OS');
    expect(root.innerHTML).toContain('Not reported');
    expect(root.innerHTML).toContain('Not set');
    for (const code of Object.keys(LANGUAGE_PACKS)) {
      setLanguage(code);
      renderPublicOverviewPage();
      expect(root.innerHTML).not.toMatch(/>overviewSummary[A-Za-z]+</);
    }
  });
});

describe('overview summary measurement contracts', () => {
  beforeEach(() => expect(summarizeOverview).toBeTypeOf('function'));
  const aggregate = (rows, now) => {
    expect(summarizeOverview).toBeTypeOf('function');
    return summarizeOverview(rows.map(normalizeServer), now);
  };

  it('excludes defaults but includes true zero and real 1/1/20 capacities', () => {
    const missing = aggregate([{ id: 1 }]);
    for (const key of ['cpu', 'ram', 'disk']) {
      expect(missing[key]).toMatchObject({ total: null, totalCoverage: 0, used: null, rate: null });
    }
    const result = aggregate([
      { id: 1, cpu: 0, ram: 0, disk: 0 },
      { id: 2, cpu: 1, ram: 1, disk: 20 },
      { id: 3 },
    ]);
    expect(result.cpu).toMatchObject({ total: 1, totalCoverage: 2 });
    expect(result.ram).toMatchObject({ total: 1, totalCoverage: 2 });
    expect(result.disk).toMatchObject({ total: 20, totalCoverage: 2 });
    expect(aggregate([{ cpu: 0, ram: 0, disk: 0 }]).cpu.total).toBe(0);
  });

  it('rejects empty, invalid, negative and flag-false capacities independently', () => {
    const result = summarizeOverview([
      { cpu: 1, ram: 16, disk: 20, __rawPresentFlags: { cpu: false, ram: true, disk: false } },
      ...['', ' ', null, NaN, Infinity, -1].map((value) => ({
        cpu: value,
        __rawPresentFlags: { cpu: true },
      })),
    ]);
    expect(result.cpu.total).toBeNull();
    expect(result.ram.total).toBe(16);
    expect(result.disk.total).toBeNull();
  });

  it('weights healthy CPU load by real cores but maximum load does not require capacity', () => {
    const result = aggregate([
      { cpu: 1, cpu_use: 20, status: 'online' },
      { cpu: 3, cpu_use: 60, status: 'online' },
      { id: 'peak-90', name: 'Highest without capacity', cpu_use: 90, status: 'online' },
      { cpu: 100, cpu_use: 100, status: 'warn' },
      { cpu: 100, cpu_use: 100, status: 'offline' },
      { cpu: 8, status: 'online' },
    ]);
    expect(result.cpu).toMatchObject({
      total: 212,
      totalCoverage: 5,
      rate: 50,
      coverage: 2,
      capacity: 4,
    });
    expect(result.load).toMatchObject({ value: 90, coverage: 3 });
    expect(result.load).toMatchObject({ id: 'peak-90', name: 'Highest without capacity' });
    expect(result.status).toEqual({ total: 6, online: 4, warn: 1, offline: 1 });
  });

  it.each(['ram', 'disk'])('uses an identical capacity/live set for %s used and rate', (key) => {
    const result = aggregate([
      { [key]: 16, [`${key}_use`]: 50, status: 'online' },
      { [key]: 32, status: 'online' },
      { [`${key}_use`]: 80, status: 'online' },
    ])[key];
    expect(result).toMatchObject({ total: 48, used: 8, rate: 50, coverage: 1, capacity: 16 });
    const excluded = aggregate([
      { [key]: 16, [`${key}_use`]: 50, status: 'warn' },
      { [key]: 32, [`${key}_use`]: 20, status: 'offline' },
      { [key]: 0, [`${key}_use`]: 0, status: 'online' },
    ])[key];
    expect(excluded).toMatchObject({ total: 48, used: null, rate: null, coverage: 0 });
  });

  it('keeps live zero valid and rejects live flags, negative, nonfinite and out-of-range load', () => {
    const rows = [
      {
        status: 'online',
        cpu: 1,
        cpu_use: 0,
        __rawPresentFlags: { cpu: true },
        __liveMetricFlags: { cpu_use: true },
      },
      ...[null, '', -1, NaN, Infinity, 101].map((value) => ({
        status: 'online',
        cpu: 4,
        cpu_use: value,
        __rawPresentFlags: { cpu: true },
        __liveMetricFlags: { cpu_use: true },
      })),
      {
        status: 'online',
        cpu: 4,
        cpu_use: 90,
        __rawPresentFlags: { cpu: true },
        __liveMetricFlags: { cpu_use: false },
      },
    ];
    expect(summarizeOverview(rows).cpu).toMatchObject({ rate: 0, coverage: 1 });
    expect(summarizeOverview(rows).load).toMatchObject({ value: 0, coverage: 1 });
  });

  it('retains the first real highest-load identity on ties, excluding unhealthy and unreported load', () => {
    const result = summarizeOverview([
      {
        id: 'first',
        name: 'First peak',
        status: 'online',
        cpu_use: 90,
        __liveMetricFlags: { cpu_use: true },
      },
      {
        id: 'second',
        name: 'Second peak',
        status: 'online',
        cpu_use: 90,
        __liveMetricFlags: { cpu_use: true },
      },
      {
        id: 'warn',
        name: 'Unhealthy',
        status: 'warn',
        cpu_use: 100,
        __liveMetricFlags: { cpu_use: true },
      },
      {
        id: 'fake',
        name: 'Unreported',
        status: 'online',
        cpu_use: 100,
        __liveMetricFlags: { cpu_use: false },
      },
    ]);
    expect(result.load).toMatchObject({ value: 90, coverage: 2 });
    expect(result.load).toMatchObject({ id: 'first', name: 'First peak' });
    expect(summarizeOverview([]).load).toMatchObject({
      value: null,
      coverage: 0,
      id: null,
      name: null,
    });
  });

  it('aggregates online upload/download independently with real zero and no live flags', () => {
    const result = aggregate([
      { status: 'online', net_up: 0 },
      { status: 'online', net_down: 1024 },
      { status: 'online', net_up: -1, net_down: Infinity },
      { status: 'warn', net_up: 500, net_down: 500 },
      { status: 'offline', net_up: 500, net_down: 500 },
    ]);
    expect(result.rates.net_up).toEqual({ value: 0, coverage: 1 });
    expect(result.rates.net_down).toEqual({ value: 1024, coverage: 1 });
    expect(aggregate([{ status: 'online' }]).rates.net_up.value).toBeNull();
    state.servers = [normalizeServer({ status: 'online', net_up: 0, net_down: 1024 })];
    renderPublicOverviewPage();
    expect(root.innerHTML).toContain('↑ 0 KB/s');
    expect(root.innerHTML).toContain('↓ 1.00 MB/s');
  });

  it('prefers direct cycle used and only falls back with both reported directions', () => {
    const result = aggregate([
      { traffic_used_gb: 0, traffic_up_gb: 10, traffic_down_gb: 20, traffic_limit_gb: 100 },
      { traffic_up_gb: 0, traffic_down_gb: 8, traffic_limit_gb: 20 },
      { traffic_up_gb: 7 },
      { traffic_used_gb: -1, traffic_up_gb: 2, traffic_down_gb: 3, traffic_limit_gb: 0 },
    ]);
    expect(result.traffic.used).toEqual({ value: 13, coverage: 3 });
    expect(result.traffic.up).toEqual({ value: 19, coverage: 4 });
    expect(result.traffic.down).toEqual({ value: 31, coverage: 3 });
    expect(result.traffic.limit).toEqual({ value: 120, coverage: 3 });
    expect(result.traffic.rate).toBeCloseTo((8 / 120) * 100);
    expect(result.traffic.coverage).toBe(2);
    expect(result.traffic.unset).toBe(1);
  });

  it('distinguishes missing/invalid limits from real unset zero and uses a matched rate set', () => {
    expect(aggregate([{}]).traffic.limit.value).toBeNull();
    expect(aggregate([{ traffic_limit_gb: -1 }]).traffic.limit.value).toBeNull();
    expect(aggregate([{ traffic_limit_gb: 0 }]).traffic).toMatchObject({
      limit: { value: 0, coverage: 1 },
      unset: 1,
      rate: null,
    });
    expect(
      aggregate([{ traffic_limit_gb: 100 }, { traffic_limit_gb: 20, traffic_used_gb: 10 }]).traffic,
    ).toMatchObject({ rate: 50, coverage: 1 });
    expect(
      summarizeOverview([{ traffic_limit_gb: 20, __rawPresentFlags: { traffic_limit_gb: false } }])
        .traffic.limit.value,
    ).toBeNull();
  });

  it('requires a real positive price and explicit supported period, excluding hidden zero', () => {
    const missing = aggregate([
      { price: 12 },
      { price: 20, period: 'unknown' },
      { price: -1.01, period: 'monthly' },
      { period: 'yearly' },
    ]);
    expect(missing.cost).toMatchObject({
      monthlyActual: null,
      yearlyActual: null,
      coverage: 0,
      byRegion: [],
      byProvider: [],
    });
    expect(aggregate([{ price: 0, period: 'monthly' }]).cost).toMatchObject({
      monthlyActual: null,
      yearlyActual: null,
      coverage: 0,
      byRegion: [],
      byProvider: [],
    });
  });

  it.each([-1, -0.5, '-0.01'])('counts legal free price %s without requiring a period', (price) => {
    expect(aggregate([{ price, location: 'Free region', provider: 'Free provider' }]).cost).toEqual(
      {
        monthlyActual: 0,
        yearlyActual: 0,
        coverage: 1,
        byRegion: [['Free region', 0]],
        byProvider: [['Free provider', 0]],
      },
    );
    expect(aggregate([{ price, period: 'unknown' }]).cost).toMatchObject({
      monthlyActual: 0,
      yearlyActual: 0,
      coverage: 1,
    });
  });

  it.each([
    null,
    undefined,
    '',
    ' ',
    NaN,
    Infinity,
    -Infinity,
    -2,
    '-1.01',
    'invalid',
    {},
    [],
    true,
    0,
    '0',
  ])('excludes missing, invalid, below-minimum and hidden billing value %s', (price) => {
    expect(
      summarizeOverview([{ price, period: 'monthly', __rawPresentFlags: { price: true } }]).cost,
    ).toMatchObject({ monthlyActual: null, yearlyActual: null, coverage: 0 });
  });

  it.each([-1, 12])(
    'does not account for price %s when its raw presence flag is false or absent',
    (price) => {
      for (const flags of [{ price: false }, {}]) {
        expect(
          summarizeOverview([{ price, period: 'monthly', __rawPresentFlags: flags }]).cost,
        ).toMatchObject({ monthlyActual: null, yearlyActual: null, coverage: 0 });
      }
    },
  );

  it.each([
    ['monthly', 1],
    ['month', 1],
    ['1', 1],
    ['月', 1],
    ['quarterly', 3],
    ['quarter', 3],
    ['3', 3],
    ['季', 3],
    ['semiannual', 6],
    ['semi_annually', 6],
    ['halfyearly', 6],
    ['half_yearly', 6],
    ['halfyear', 6],
    ['6', 6],
    ['半年', 6],
    ['yearly', 12],
    ['annual', 12],
    ['annually', 12],
    ['year', 12],
    ['12', 12],
    ['年', 12],
  ])('monthly-normalizes a positive price with the existing billing alias %s', (period, months) => {
    expect(aggregate([{ price: 120, currency: 'CNY', period }]).cost).toMatchObject({
      monthlyActual: 120 / months,
      yearlyActual: (120 / months) * 12,
      coverage: 1,
    });
  });

  it('keeps hidden, free and positive billing coverage in the same accounted set', () => {
    expect(
      aggregate([
        { price: 0, period: 'monthly', location: 'Hidden', provider: 'Hidden' },
        { price: -1, location: 'Free', provider: 'Free' },
        { price: 24, currency: 'CNY', period: 'yearly', location: 'Paid', provider: 'Paid' },
        { price: 99, period: 'unknown', location: 'Unknown', provider: 'Unknown' },
      ]).cost,
    ).toEqual({
      monthlyActual: 2,
      yearlyActual: 24,
      coverage: 2,
      byRegion: [
        ['Paid', 2],
        ['Free', 0],
      ],
      byProvider: [
        ['Paid', 2],
        ['Free', 0],
      ],
    });
  });

  it('reuses source currency conversion and billing config periods for the same annualized set', () => {
    state.exchangeRates = { USD: 1, CNY: 7.26, EUR: 0.92 };
    const result = aggregate([
      { price: 12, period: 'yearly', currency: 'USD', location: 'US', provider: 'A' },
      {
        price: 0.92,
        agent_config: { billing: { period: 'monthly', currency: 'EUR' } },
        location: 'EU',
        provider: 'A',
      },
      {
        price: 30,
        agent_config: { billing: { period_months: 3 } },
        currency: 'CNY',
        location: 'CN',
        provider: 'B',
      },
      { price: 100, location: 'missing', provider: 'missing' },
    ]);
    expect(result.cost.monthlyActual).toBeCloseTo(24.52);
    expect(result.cost.yearlyActual).toBeCloseTo(294.24);
    expect(result.cost.coverage).toBe(3);
    expect(result.cost.byProvider).toEqual([
      ['A', 14.52],
      ['B', 10],
    ]);
    expect(result.cost.byRegion).toHaveLength(3);
    state.servers = [normalizeServer({ price: -1 }), normalizeServer({ price: 100 })];
    renderPublicOverviewPage();
    expect(root.innerHTML).toContain('已知合计 · 覆盖 1/2');
  });

  it('parses only real expiry and preserves expired, soon and unset counts', () => {
    const now = Date.parse('2026-11-14T00:00:00Z');
    const result = aggregate(
      [
        { id: 1, expiry: '2026-11-13T00:00:00Z' },
        { id: 2, expiry: '2026-11-17T00:00:00Z' },
        { id: 3, expiry: 'not-a-date' },
        { id: 4 },
        { id: 5, expiry: '' },
        { id: 6, expiry: 0 },
      ],
      now,
    );
    expect(result.expiry).toMatchObject({ valid: 2, expired: 1, soon: 1, missing: 4 });
    expect(result.expiry.entries.map((entry) => entry.days)).toEqual([-1, 3]);
  });

  it('rejects impossible calendar expiry and nonnumeric raw containers', () => {
    expect(
      aggregate([{ expiry: '2026-02-31' }, { expiry: '2026-02-30T12:00:00Z' }]).expiry.valid,
    ).toBe(0);
    const result = summarizeOverview(
      [[], {}, true].map((value) => ({ cpu: value, __rawPresentFlags: { cpu: true } })),
    );
    expect(result.cpu.total).toBeNull();
  });
});
