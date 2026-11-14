import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMobileBottomNav } from '../../src/components/solar/MobileBottomNav.js';
import { LANGUAGE_PACKS, setLanguage, t } from '../../src/core/preferences.js';

const tableSource = readFileSync(
  new URL('../../src/modules/serverTable.js', import.meta.url),
  'utf8',
);
const program = parse(tableSource, { ecmaVersion: 'latest', sourceType: 'module' });

class Element extends EventTarget {
  constructor(tagName = 'div') {
    super();
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this.classList = { remove: vi.fn() };
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
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
}

function descendants(element) {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}

function mountHarness(createMobileBottomNav = vi.fn()) {
  const elements = new Map();
  const app = new Element();
  const outerApp = new Element();
  outerApp.appendChild(app);
  Object.defineProperty(app, 'innerHTML', {
    set(markup) {
      app.children = [];
      for (const match of markup.matchAll(/id="([^"]+)"/g)) elements.set(match[1], new Element());
      app.appendChild(elements.get('page-globe'));
      elements
        .get('page-globe')
        .append(elements.get('solar-system-container'), elements.get('globe-container'));
    },
  });
  elements.set('pageRoot', app);
  elements.set('app', outerApp);
  const document = {
    body: new Element(),
    getElementById: (id) => elements.get(id),
    createElement: (tag) => new Element(tag),
  };
  const window = new EventTarget();
  window.location = { assign: vi.fn() };
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  const context = vm.createContext({
    document,
    window,
    createMobileBottomNav,
    state: { servers: [], serversSource: '' },
    route: new URLSearchParams(),
    isCesiumVisible: () => false,
    showCesiumGlobe: vi.fn(),
    t: (key) => key,
  });
  const mount = program.body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id.name === 'mountDisplayPage',
  );
  const sharedMount = program.body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id.name === 'mountMobileBottomNav',
  );
  vm.runInContext(
    `let mobileBottomNav = null; function disposeMobileBottomNav() { mobileBottomNav?.destroy(); mobileBottomNav = null; } ${sharedMount ? tableSource.slice(sharedMount.start, sharedMount.end) : ''} ${tableSource.slice(mount.start, mount.end)}`,
    context,
  );
  return { mount: () => context.mountDisplayPage(), app, outerApp, elements, window, context };
}

afterEach(() => vi.unstubAllGlobals());

const trustedSource = '后台接口 /api/v1/servers + IP 坐标定位';

function controllerHarness(
  snapshot = { serversSource: trustedSource, servers: [{ id: 104 }] },
  visible = false,
  overrides = {},
) {
  const container = new Element();
  const solarHost = new Element();
  container.appendChild(solarHost);
  const window = new EventTarget();
  window.localStorage = { getItem: vi.fn(() => '104'), setItem: vi.fn() };
  const navigate = vi.fn();
  const switchGlobe = vi.fn(async () => {
    visible = true;
  });
  const getSnapshot = vi.fn(() => snapshot);
  const document = {
    createElement: (tag) => new Element(tag),
    querySelectorAll: () => [],
    getElementById: () => null,
    documentElement: new Element(),
  };
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  const options = {
    container,
    solarHost,
    navigate,
    getSnapshot,
    isVisible: () => visible,
    switchGlobe,
    ...overrides,
  };
  const controller = createMobileBottomNav(options);
  const buttons = () => descendants(container).filter((element) => element.tagName === 'button');
  const click = (index) => {
    expect(buttons()).toHaveLength(4);
    const event = new Event('click', { bubbles: true, cancelable: true });
    buttons()[index].dispatchEvent(event);
    return event;
  };
  const status = () =>
    descendants(container).find((element) => element.getAttribute('role') === 'status');
  return {
    container,
    solarHost,
    window,
    options,
    controller,
    buttons,
    click,
    status,
    navigate,
    switchGlobe,
    getSnapshot,
    setSnapshot: (value) => {
      snapshot = value;
    },
    setVisible: (value) => {
      visible = value;
    },
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function pending() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Mobile controller production behavior with controlled external boundaries', () => {
  it.each(['overview', 'detail'])(
    'accepts a nullable solar host on %s and disposes normally',
    (activeTab) => {
      const harness = controllerHarness(undefined, false, { solarHost: null, activeTab });
      expect(harness.buttons()).toHaveLength(4);
      expect(harness.solarHost.hasAttribute('data-solar-mobile-nav')).toBe(false);
      const oldButtons = harness.buttons();
      harness.controller.destroy();
      harness.controller.destroy();
      expect(harness.buttons()).toHaveLength(0);
      expect(harness.status()).toBeUndefined();
      oldButtons[0].dispatchEvent(new Event('click'));
      expect(harness.navigate).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['root', false, [false, false, false, false]],
    ['root', true, [false, false, false, true]],
    ['overview', false, [false, true, false, false]],
    ['detail', false, [false, false, true, false]],
  ])(
    'syncs the complete %s vector with actual Earth visibility %s',
    (activeTab, visible, vector) => {
      const harness = controllerHarness(undefined, visible, { activeTab });
      const pressed = () =>
        harness.buttons().map((button) => button.getAttribute('aria-pressed') === 'true');
      expect(pressed()).toEqual(vector);
      harness.setVisible(!visible);
      harness.controller.syncView();
      expect(pressed()).toEqual(activeTab === 'root' ? [false, false, false, !visible] : vector);
    },
  );

  it('owns exactly four ordered native buttons, keeps focus/input native and all inactive by default', () => {
    const harness = controllerHarness();
    expect(harness.buttons()).toHaveLength(4);
    expect(harness.buttons().map((button) => button.children[1].textContent)).toEqual([
      '后台',
      '资产',
      '详情',
      '地球',
    ]);
    for (const button of harness.buttons()) {
      expect(button.type).toBe('button');
      expect(button.getAttribute('aria-pressed')).toBe('false');
      const key = new Event('keydown', { cancelable: true });
      button.dispatchEvent(key);
      expect(key.defaultPrevented).toBe(false);
    }
    const nav = harness.buttons()[0].parentElement;
    for (const name of ['pointerdown', 'pointerup', 'click', 'dblclick']) {
      const event = new Event(name, { cancelable: true });
      const stop = vi.spyOn(event, 'stopPropagation');
      nav.dispatchEvent(event);
      expect(stop).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(false);
    }
    expect(harness.click(0).defaultPrevented).toBe(false);
    expect(harness.navigate).toHaveBeenLastCalledWith('/admin.html');
    harness.click(1);
    expect(harness.navigate).toHaveBeenLastCalledWith('/?overview=1');
  });

  it.each([
    [
      'cached/untrusted',
      { serversSource: '', servers: [{ id: 104 }] },
      '节点数据加载中，请稍后再试',
    ],
    [
      'fresh empty',
      { serversSource: trustedSource, servers: [] },
      '暂无节点，请先在资产列表中添加节点',
    ],
    [
      'multiple without selection',
      { serversSource: trustedSource, servers: [{ id: 104 }, { id: 205 }] },
      '请先在资产列表中选择目标节点',
    ],
    [
      'stale route in multiple nodes',
      { serversSource: trustedSource, servers: [{ id: 104 }, { id: 205 }], routeServerId: '999' },
      '请先在资产列表中选择目标节点',
    ],
  ])('stays on the root for %s with a visible polite hint', (_name, snapshot, message) => {
    const harness = controllerHarness(snapshot);
    harness.click(2);
    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.status().hidden).toBe(false);
    expect(harness.status().textContent).toBe(message);
    expect(harness.status().getAttribute('aria-live')).toBe('polite');
    expect(harness.window.localStorage.getItem).not.toHaveBeenCalled();
  });

  it.each([
    [{ servers: [{ id: 104 }] }, 104],
    [{ servers: [{ id: '104' }] }, 104],
    [{ servers: [{ id: 104 }, { id: 205 }], routeServerId: '205' }, 205],
    [{ servers: [{ id: 104 }], routeServerId: '999' }, 104],
  ])('navigates only to the real trusted target %#', (snapshot, expectedId) => {
    const harness = controllerHarness({ serversSource: trustedSource, ...snapshot });
    harness.click(2);
    expect(harness.navigate).toHaveBeenCalledExactlyOnceWith(`/?server=${expectedId}`);
  });

  it.each([
    undefined,
    null,
    NaN,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    '104oops',
    '1e2',
    '104.0',
    ' 104 ',
    '0104',
    '',
    '0',
    '-104',
    'Infinity',
  ])('does not repair or navigate to invalid server id %s', (id) => {
    const harness = controllerHarness({ serversSource: trustedSource, servers: [{ id }] });
    harness.click(2);
    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.status().hidden).toBe(false);
  });

  it.each(['104oops', '0', '-104', '1.5', '9007199254740992', ' 104 ', '0104'])(
    'does not repair malformed route token %s',
    (routeServerId) => {
      const harness = controllerHarness({
        serversSource: trustedSource,
        servers: [{ id: 104 }],
        routeServerId,
      });
      harness.click(2);
      expect(harness.navigate).not.toHaveBeenCalled();
      expect(harness.status().textContent).toBe('请先在资产列表中选择目标节点');
    },
  );

  it('reads a new snapshot on each action, not captured cache or a made-up selected id', () => {
    const harness = controllerHarness({
      serversSource: '',
      servers: [{ id: 1 }],
      currentSelectedId: 1,
    });
    harness.click(2);
    harness.setSnapshot({ serversSource: trustedSource, servers: [{ id: 104 }] });
    harness.click(2);
    expect(harness.getSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.navigate).toHaveBeenCalledExactlyOnceWith('/?server=104');
    expect(harness.status().hidden).toBe(true);
  });

  it('locks pending globe double clicks, activates only on real visibility and skips an already-visible view', async () => {
    const harness = controllerHarness();
    const deferred = pending();
    harness.switchGlobe.mockReturnValueOnce(deferred.promise);
    harness.click(3);
    harness.click(3);
    expect(harness.switchGlobe).toHaveBeenCalledOnce();
    expect(harness.buttons()[3].getAttribute('aria-pressed')).toBe('false');
    harness.setVisible(true);
    deferred.resolve({});
    await settle();
    expect(harness.buttons()[3].getAttribute('aria-pressed')).toBe('true');
    harness.click(3);
    expect(harness.switchGlobe).toHaveBeenCalledOnce();
    harness.setVisible(false);
    harness.controller.syncView();
    expect(harness.buttons()[3].getAttribute('aria-pressed')).toBe('false');
  });

  it.each(['null', 'reject'])(
    'does not fake activation after %s and permits retry',
    async (kind) => {
      const harness = controllerHarness();
      harness.switchGlobe.mockImplementationOnce(() =>
        kind === 'null' ? Promise.resolve(null) : Promise.reject(new Error('boundary failure')),
      );
      harness.click(3);
      await settle();
      expect(harness.buttons()[3].getAttribute('aria-pressed')).toBe('false');
      harness.click(3);
      await settle();
      expect(harness.switchGlobe).toHaveBeenCalledTimes(2);
      expect(harness.buttons()[3].getAttribute('aria-pressed')).toBe('true');
    },
  );

  it('isolates destroyed pending promises from a remounted controller and its lock', async () => {
    const harness = controllerHarness();
    const oldPending = pending();
    const newPending = pending();
    harness.switchGlobe
      .mockReturnValueOnce(oldPending.promise)
      .mockReturnValueOnce(newPending.promise);
    const oldButton = harness.buttons()[3];
    harness.click(3);
    harness.controller.destroy();
    const replacement = createMobileBottomNav(harness.options);
    harness.click(3);
    oldPending.resolve(null);
    await settle();
    harness.click(3);
    expect(harness.switchGlobe).toHaveBeenCalledTimes(2);
    expect(oldButton.getAttribute('aria-pressed')).toBe('false');
    expect(harness.buttons()[3].getAttribute('aria-pressed')).toBe('false');
    harness.setVisible(true);
    newPending.resolve({});
    await settle();
    expect(harness.buttons()[3].getAttribute('aria-pressed')).toBe('true');
    replacement.destroy();
  });

  it('removes owned elements/listeners only, restores the exact previous host attribute and is idempotent', () => {
    const harness = controllerHarness();
    expect(harness.solarHost.hasAttribute('data-solar-mobile-nav')).toBe(true);
    const unrelated = new Element();
    harness.container.appendChild(unrelated);
    const oldButtons = harness.buttons();
    const remove = vi.spyOn(harness.window, 'removeEventListener');
    harness.controller.destroy();
    harness.controller.destroy();
    expect(harness.container.children).toEqual([harness.solarHost, unrelated]);
    expect(harness.solarHost.hasAttribute('data-solar-mobile-nav')).toBe(false);
    oldButtons[0].dispatchEvent(new Event('click'));
    expect(harness.navigate).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('vps-language-changed', expect.any(Function));
    harness.solarHost.setAttribute('data-solar-mobile-nav', 'previous-owner');
    const replacement = createMobileBottomNav(harness.options);
    replacement.destroy();
    expect(harness.solarHost.getAttribute('data-solar-mobile-nav')).toBe('previous-owner');
    harness.solarHost.setAttribute('data-solar-mobile-nav', '');
    createMobileBottomNav(harness.options).destroy();
    expect(harness.solarHost.getAttribute('data-solar-mobile-nav')).toBe('');
  });

  it('uses seven zh/en preference keys, responds to language events and falls back to Chinese', () => {
    const harness = controllerHarness({ serversSource: '', servers: [] });
    const keys = [
      'mobileNavAdmin',
      'mobileNavAssets',
      'mobileNavDetails',
      'mobileNavEarth',
      'mobileNavLoading',
      'mobileNavEmpty',
      'mobileNavSelect',
    ];
    keys.forEach((key) => {
      expect(LANGUAGE_PACKS.zh[key]).toBeTruthy();
      expect(LANGUAGE_PACKS.en[key]).toBeTruthy();
    });
    harness.click(2);
    setLanguage('en');
    expect(harness.buttons().map((button) => button.children[1].textContent)).toEqual([
      'Admin',
      'Assets',
      'Details',
      'Earth',
    ]);
    expect(harness.status().textContent).toBe(t('mobileNavLoading'));
    const fallbackLanguage = Object.keys(LANGUAGE_PACKS).find(
      (language) => !['zh', 'en'].includes(language),
    );
    setLanguage(fallbackLanguage);
    expect(harness.buttons().map((button) => button.children[1].textContent)).toEqual([
      '后台',
      '资产',
      '详情',
      '地球',
    ]);
    harness.controller.destroy();
    setLanguage('zh');
  });
});

describe('Production root mount behavior (external DOM boundary, not native acceptance)', () => {
  it('disposes the old root before replacement and cleans the current root on pagehide', () => {
    const destroys = [];
    const controller = vi.fn(({ container }) => {
      const destroy = vi.fn(() => expect(container).toBe(harness.outerApp));
      destroys.push(destroy);
      return { destroy, syncView: vi.fn() };
    });
    const harness = mountHarness(controller);
    harness.mount();
    harness.mount();
    expect(destroys[0]).toHaveBeenCalledOnce();
    const pagehide = program.body.filter(
      (node) =>
        node.type === 'ExpressionStatement' &&
        tableSource.slice(node.start, node.end).includes("'pagehide'") &&
        tableSource.slice(node.start, node.end).includes('disposeMobileBottomNav'),
    );
    expect(pagehide).toHaveLength(1);
    vm.runInContext(tableSource.slice(pagehide[0].start, pagehide[0].end), harness.context);
    harness.window.dispatchEvent(new Event('pagehide'));
    harness.window.dispatchEvent(new Event('pagehide'));
    expect(destroys[1]).toHaveBeenCalledOnce();
  });

  it('passes live source, route, visibility and navigation boundaries to the controller', () => {
    const controller = vi.fn(() => ({ destroy: vi.fn(), syncView: vi.fn() }));
    const harness = mountHarness(controller);
    harness.mount();
    const options = controller.mock.calls[0][0];
    harness.context.state.servers = [{ id: 205 }];
    harness.context.state.serversSource = trustedSource;
    harness.context.route.set('server', '205');
    expect(options.getSnapshot()).toEqual({
      servers: [{ id: 205 }],
      serversSource: trustedSource,
      routeServerId: '205',
    });
    options.navigate('/?server=205');
    expect(harness.window.location.assign).toHaveBeenCalledWith('/?server=205');
    expect(options.isVisible).toBe(harness.context.isCesiumVisible);
    expect(options.switchGlobe).toBe(harness.context.showCesiumGlobe);
  });

  it('syncs the live controller at the end of both actual view transitions', () => {
    for (const name of ['showSolarSystem', 'showCesiumGlobe']) {
      const transition = program.body.find(
        (node) => node.type === 'FunctionDeclaration' && node.id.name === name,
      );
      const lastStatement = transition.body.body.at(-1);
      expect(tableSource.slice(lastStatement.start, lastStatement.end)).toBe(
        'mobileBottomNav?.syncView();',
      );
    }
    const init = program.body.find(
      (node) => node.type === 'FunctionDeclaration' && node.id.name === 'initGlobe',
    );
    expect(tableSource.slice(init.start, init.end)).not.toContain('disposeMobileBottomNav');
  });

  it('mounts four native actions through the actual mountDisplayPage entry', () => {
    const controller = vi.fn(({ container }) => {
      const nav = new Element('nav');
      for (const label of ['后台', '资产', '详情', '地球']) {
        const button = new Element('button');
        button.type = 'button';
        button.textContent = label;
        nav.appendChild(button);
      }
      container.appendChild(nav);
      return { destroy: () => nav.remove(), syncView: vi.fn() };
    });
    const harness = mountHarness(controller);
    harness.mount();
    const buttons = descendants(harness.outerApp).filter((element) => element.tagName === 'button');
    expect(buttons).toHaveLength(4);
    expect(controller.mock.calls[0][0].container).toBe(harness.outerApp);
    expect(controller).toHaveBeenCalledTimes(1);
    expect(controller.mock.calls[0][0].solarHost).toBe(
      harness.elements.get('solar-system-container'),
    );
  });
});
