import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundaries = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
  solar: vi.fn(),
  cesium: vi.fn(),
  starship: vi.fn(),
  starmap: vi.fn(() => () => {}),
}));

vi.mock('../../src/api/public.js', () => ({
  listServersPublic: boundaries.list,
  getServerDetail: boundaries.detail,
}));
vi.mock('../../src/services/displayData.js', async (importOriginal) => ({
  ...(await importOriginal()),
  enrichServersWithIpGeo: async (servers) => servers,
}));
vi.mock('../../src/components/SolarSystem.js', () => ({
  SolarSystem: class {
    constructor(...args) {
      boundaries.solar(...args);
    }
    pause() {}
    resume() {}
    destroy() {}
  },
}));
vi.mock('../../src/components/CesiumGlobe.js', () => ({
  CesiumGlobe: class {
    constructor(...args) {
      boundaries.cesium(...args);
    }
    async init() {}
    updateServers() {}
    setServers() {}
    destroy() {}
  },
}));
vi.mock('../../src/components/StarshipShowcase.js', () => ({
  StarshipShowcase: class {
    constructor(...args) {
      boundaries.starship(...args);
    }
    async init() {}
    destroy() {}
  },
}));
vi.mock('../../src/components/GlobeStarmapMount.jsx', () => ({
  mountGlobeStarmap: boundaries.starmap,
}));
vi.mock('../../src/components/TrafficChart.js', () => ({ TrafficChart: class {} }));
vi.mock('../../src/pages/detailCharts.js', () => ({ renderDetailMonitorCharts: vi.fn() }));

class DomElement extends EventTarget {
  constructor(tagName = 'div') {
    super();
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.classList = {
      contains: (name) => (this.getAttribute('class') || '').split(/\s+/).includes(name),
      add: (...names) =>
        this.setAttribute(
          'class',
          [...new Set([...(this.getAttribute('class') || '').split(/\s+/), ...names])].join(' '),
        ),
      remove: (...names) =>
        this.setAttribute(
          'class',
          (this.getAttribute('class') || '')
            .split(/\s+/)
            .filter((name) => !names.includes(name))
            .join(' '),
        ),
      toggle: (name, force = !this.classList.contains(name)) => {
        force ? this.classList.add(name) : this.classList.remove(name);
        return force;
      },
    };
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-'))
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] =
        String(value);
    if (name === 'style')
      String(value)
        .split(';')
        .forEach((declaration) => {
          const [property, content] = declaration.split(':');
          if (property?.trim()) this.style[property.trim()] = content?.trim();
        });
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  appendChild(child) {
    child.remove();
    this.children.push(child);
    child.parentElement = this;
    return child;
  }
  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }
  remove() {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  get isConnected() {
    return this.tagName === 'DOCUMENT' || Boolean(this.parentElement?.isConnected);
  }
  get textContent() {
    return (this.text || '') + this.children.map((child) => child.textContent).join('');
  }
  set textContent(value) {
    this.innerHTML = '';
    this.text = String(value);
  }
  set innerHTML(markup) {
    this.children.forEach((child) => {
      child.parentElement = null;
    });
    this.children = [];
    this.text = '';
    const stack = [this];
    for (const token of String(markup).match(/<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith('</')) {
        if (stack.length > 1) stack.pop();
      } else if (/^<[a-z]/i.test(token)) {
        const tag = token.match(/^<([\w-]+)/)[1];
        const child = new DomElement(tag);
        for (const attribute of token
          .slice(tag.length + 1)
          .matchAll(/([\w-]+)(?:="([^"]*)"|='([^']*)')?/g))
          child.setAttribute(attribute[1], attribute[2] ?? attribute[3] ?? '');
        stack.at(-1).appendChild(child);
        if (!/\/>$/.test(token) && !['input', 'img', 'br', 'hr', 'meta', 'link'].includes(tag))
          stack.push(child);
      } else if (!token.startsWith('<')) {
        stack.at(-1).text = (stack.at(-1).text || '') + token;
      }
    }
  }
  matches(selector) {
    return selector.split(',').some((part) => {
      const chain = part
        .trim()
        .replace(/\s*>\s*/g, ' > ')
        .split(/\s+/);
      const compound = chain.pop();
      const tag = compound.match(/^[\w-]+/)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      for (const match of compound.matchAll(/([.#])([\w-]+)/g)) {
        if (
          match[1] === '#'
            ? this.getAttribute('id') !== match[2]
            : !this.classList.contains(match[2])
        )
          return false;
      }
      for (const match of compound.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
        if (
          !this.hasAttribute(match[1]) ||
          (match[2] !== undefined && this.getAttribute(match[1]) !== match[2])
        )
          return false;
      }
      if (!chain.length) return true;
      const direct = chain.at(-1) === '>';
      if (direct) chain.pop();
      for (let ancestor = this.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.matches(chain.join(' '))) return true;
        if (direct) return false;
      }
      return false;
    });
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  closest(selector) {
    return this.matches(selector) ? this : (this.parentElement?.closest(selector) ?? null);
  }
  click() {
    this.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
  }
}

const server = {
  id: 104,
  name: 'Real test node',
  status: 'online',
  ip: '192.0.2.104',
  cpu: 2,
  ram: 4,
  disk: 40,
  price: 10,
  period: '月',
  location: 'Tokyo',
};
const aggregate = {
  history: { data: [] },
  resource_timeline: [],
  process_history: [],
  ping_targets: { targets: [] },
  ping_history: { targets: [] },
};

function browser(url) {
  const document = new DomElement('document');
  document.documentElement = new DomElement('html');
  document.body = new DomElement('body');
  document.appendChild(document.documentElement);
  document.documentElement.appendChild(document.body);
  document.body.innerHTML =
    '<div id="app"><main class="display-main"><div id="pageRoot"></div></main></div>';
  document.createElement = (tag) => new DomElement(tag);
  document.getElementById = (id) => document.querySelector(`#${id}`);
  const window = new EventTarget();
  window.location = new URL(url, 'https://example.test');
  window.location.assign = vi.fn();
  window.history = { replaceState: vi.fn() };
  window.__DBG__ = {};
  const storage = new Map();
  window.localStorage = window.sessionStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  window.innerWidth = 390;
  window.innerHeight = 844;
  for (const [name, value] of Object.entries({
    window,
    document,
    location: window.location,
    history: window.history,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    BroadcastChannel: undefined,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    fetch: vi.fn(async () => ({
      ok: true,
      json: async () => ({ rates: { CNY: 7, EUR: 0.9 }, targets: [], data: [] }),
    })),
  }))
    vi.stubGlobal(name, value);
  return { window, document };
}

async function boot(url) {
  vi.resetModules();
  const harness = browser(url);
  const { mountServerTableApp } = await import('../../src/modules/serverTable.js');
  await mountServerTableApp();
  return harness;
}

function footer(harness, vector) {
  const { document } = harness;
  const navs = document.querySelectorAll('nav.mobile-bottom-nav');
  expect(navs).toHaveLength(1);
  const nav = navs[0];
  const app = document.getElementById('app');
  expect(nav.parentElement).toBe(app);
  expect(app.querySelector('main.display-main').parentElement).toBe(app);
  expect(document.getElementById('pageRoot').parentElement).toBe(
    app.querySelector('main.display-main'),
  );
  expect(app.querySelector('aside.mobile-bottom-nav-status').parentElement).toBe(app);
  const buttons = nav.querySelectorAll('button');
  expect(buttons).toHaveLength(4);
  expect(buttons.map((button) => button.getAttribute('type'))).toEqual([
    'button',
    'button',
    'button',
    'button',
  ]);
  expect(buttons.map((button) => button.getAttribute('aria-pressed') === 'true')).toEqual(vector);
  return { nav, buttons };
}

function noRootRenderers(harness) {
  expect(boundaries.solar).not.toHaveBeenCalled();
  expect(boundaries.cesium).not.toHaveBeenCalled();
  expect(boundaries.starship).not.toHaveBeenCalled();
  expect(harness.document.getElementById('solar-system-container')).toBeNull();
  expect(harness.document.getElementById('globe-container')).toBeNull();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  boundaries.list.mockResolvedValue({ servers: [server] });
  boundaries.detail.mockResolvedValue(aggregate);
});

afterEach(() => {
  window?.dispatchEvent(new Event('pagehide'));
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Real public bootstrap and real footer, with external data/GL and controlled DOM only', () => {
  it('attaches the real root component directly to app and survives replacing pageRoot', async () => {
    const harness = await boot('/');
    const { nav } = footer(harness, [false, false, false, false]);
    expect(boundaries.solar).toHaveBeenCalledOnce();
    expect(
      harness.document
        .getElementById('solar-system-container')
        .getAttribute('data-solar-mobile-nav'),
    ).toBe('true');
    harness.document.getElementById('pageRoot').innerHTML =
      '<section>replacement content</section>';
    expect(footer(harness, [false, false, false, false]).nav).toBe(nav);
  });

  it('attaches a fresh overview footer, preserving identity across the actual 10s refresh', async () => {
    const harness = await boot('/?overview=1');
    expect(harness.document.querySelector('.public-overview-page')).not.toBeNull();
    const { nav } = footer(harness, [false, true, false, false]);
    const previousPage = harness.document.querySelector('.public-overview-page');
    noRootRenderers(harness);
    boundaries.list.mockResolvedValue({ servers: [{ ...server, name: 'Updated node' }] });
    await vi.advanceTimersByTimeAsync(10000);
    expect(boundaries.list).toHaveBeenCalledTimes(2);
    expect(harness.document.querySelector('.public-overview-page')).not.toBe(previousPage);
    expect(harness.document.querySelector('.public-overview-page').textContent).toContain(
      'Updated node',
    );
    expect(footer(harness, [false, true, false, false]).nav).toBe(nav);
    noRootRenderers(harness);
  });

  it('attaches a fresh actual detail footer without creating root renderers', async () => {
    const harness = await boot('/?server=104');
    expect(harness.window.__DBG__.DETAIL_TRACE_ERROR).toBeUndefined();
    expect(harness.document.querySelector('.detail-page-shell')).not.toBeNull();
    footer(harness, [false, false, true, false]);
    noRootRenderers(harness);
  });

  it('keeps footer identity through real detail loading, budget timeout and late hydration', async () => {
    let hydrate;
    boundaries.detail.mockImplementation(
      () =>
        new Promise((resolve) => {
          hydrate = resolve;
        }),
    );
    vi.resetModules();
    const harness = browser('/?server=104');
    const { mountServerTableApp } = await import('../../src/modules/serverTable.js');
    const mounting = mountServerTableApp();
    for (let step = 0; step < 30 && !hydrate; step++) await Promise.resolve();
    expect(hydrate).toBeTypeOf('function');
    const loading = harness.document.querySelector('.detail-loading-page');
    expect(loading).not.toBeNull();
    const { nav } = footer(harness, [false, false, true, false]);
    await vi.advanceTimersByTimeAsync(1200);
    await mounting;
    expect(footer(harness, [false, false, true, false]).nav).toBe(nav);
    hydrate(aggregate);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.window.__DBG__.DETAIL_TRACE_ERROR).toBeUndefined();
    expect(harness.window.__DBG__.DETAIL_TRACE).toContain('done');
    expect(harness.document.querySelector('.detail-page-shell')).not.toBe(loading);
    expect(footer(harness, [false, false, true, false]).nav).toBe(nav);
    noRootRenderers(harness);
  });

  it.each([
    ['/?overview=1', [false, true, false, false]],
    ['/?server=104', [false, false, true, false]],
  ])(
    'delegates Earth from %s to root navigation without preloading root renderers',
    async (url, vector) => {
      const harness = await boot(url);
      footer(harness, vector).buttons[3].click();
      expect(harness.window.location.assign).toHaveBeenCalledExactlyOnceWith('/?globe=1');
      noRootRenderers(harness);
      footer(harness, vector);
    },
  );

  it('resolves root Earth flag with the existing switch and consumes it on Return and Escape', async () => {
    const harness = await boot('/?globe=1');
    const { nav, buttons } = footer(harness, [false, false, false, true]);
    expect(boundaries.cesium).toHaveBeenCalledOnce();
    harness.document.getElementById('globeReturnSolarBtn').click();
    expect(harness.window.history.replaceState).toHaveBeenCalledWith(null, '', '/');
    expect(footer(harness, [false, false, false, false]).nav).toBe(nav);
    buttons[3].click();
    await vi.advanceTimersByTimeAsync(0);
    footer(harness, [false, false, false, true]);
    const escape = new Event('keydown');
    Object.defineProperty(escape, 'key', { value: 'Escape' });
    harness.document.dispatchEvent(escape);
    footer(harness, [false, false, false, false]);
    expect(harness.window.history.replaceState).toHaveBeenLastCalledWith(null, '', '/');
  });

  it.each(['/', '/?overview=1', '/?server=104'])(
    'retains real native navigation policies and pagehide cleanup on %s',
    async (url) => {
      const harness = await boot(url);
      const nav = harness.document.querySelector('nav.mobile-bottom-nav');
      expect(nav).not.toBeNull();
      const buttons = nav.querySelectorAll('button');
      buttons[0].click();
      buttons[1].click();
      buttons[2].click();
      expect(harness.window.location.assign.mock.calls).toEqual([
        ['/admin.html'],
        ['/?overview=1'],
        ['/?server=104'],
      ]);
      for (const button of buttons) {
        const key = new Event('keydown', { cancelable: true });
        button.dispatchEvent(key);
        expect(key.defaultPrevented).toBe(false);
      }
      const host = harness.document.getElementById('solar-system-container');
      harness.window.dispatchEvent(new Event('pagehide'));
      expect(harness.document.querySelector('nav.mobile-bottom-nav')).toBeNull();
      expect(harness.document.querySelector('aside.mobile-bottom-nav-status')).toBeNull();
      if (host) expect(host.hasAttribute('data-solar-mobile-nav')).toBe(false);
      harness.window.location.assign.mockClear();
      buttons[0].click();
      harness.window.dispatchEvent(new Event('vps-language-changed'));
      expect(harness.window.location.assign).not.toHaveBeenCalled();
    },
  );

  it.each(['/?login=1', '/verify-email', '/reset-password'])(
    'excludes account route %s even with the Earth flag',
    async (url) => {
      const harness = await boot(`${url}${url.includes('?') ? '&' : '?'}globe=1`);
      expect(harness.document.querySelector('nav.mobile-bottom-nav')).toBeNull();
      expect(harness.document.querySelector('aside.mobile-bottom-nav-status')).toBeNull();
      noRootRenderers(harness);
    },
  );
});
