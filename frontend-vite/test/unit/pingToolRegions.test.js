import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PingTool } from '../../src/components/admin/PingTool.js';
import { request } from '../../src/api/base.js';

vi.mock('../../src/api/admin.js', () => ({ tcpPing: vi.fn() }));
vi.mock('../../src/api/public.js', () => ({ getIPInfo: vi.fn() }));
vi.mock('../../src/api/base.js', () => ({ request: vi.fn() }));

const configurations = new Map();
const saveCalls = () =>
  request.mock.calls.filter(
    ([path, options]) => path.endsWith('/agent-config') && options?.method === 'PUT',
  );
const savedPayload = () => JSON.parse(saveCalls().at(-1)[1].body);
const renderedKeys = (editor) =>
  [...editor.innerHTML.matchAll(/<input[^>]*data-f="key"[^>]*value="([^"]*)"/gu)].map(
    (match) => match[1],
  );
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
};

function node() {
  return {
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    rows: [],
    listeners: {},
    children: [],
    addEventListener(event, listener) {
      this.listeners[event] = listener;
    },
    querySelectorAll(selector) {
      return selector === '.pt-target-row' ? this.rows : [];
    },
    querySelector(selector) {
      return this.children.find((child) => `.${child.className}` === selector) || null;
    },
    replaceChildren(...children) {
      this.children = children;
    },
    appendChild(child) {
      this.children.push(child);
    },
  };
}

function editedRow(target, changes = {}, index = 0) {
  const fields = { ...target, ...changes };
  return {
    dataset: { key: target.key },
    inputs: Object.entries(fields).map(([field, value]) => ({
      dataset: { i: String(index), f: field },
      value: String(value ?? ''),
      disabled: field === 'port' && fields.protocol === 'icmp',
      setCustomValidity(message) {
        this.validationMessage = message;
      },
      reportValidity: vi.fn(),
    })),
  };
}

async function fixture(servers, { wait = true } = {}) {
  const elements = new Map();
  for (const id of [
    'pt-server-select',
    'pt-region-select',
    'pt-source-note',
    'pt-target-editor',
    'pt-load',
    'pt-add-row',
    'pt-run',
    'pt-run-node',
    'pt-save',
    'pt-clear',
    'pt-export',
    'pt-ip-lookup',
    'pt-ip-input',
    'pt-ip-result',
    'pt-summary',
    'pt-results',
  ]) {
    elements.set(`#${id}`, node());
  }
  const editor = elements.get('#pt-target-editor');
  let editorHTML = '';
  Object.defineProperty(editor, 'innerHTML', {
    get: () => editorHTML,
    set: (value) => {
      editorHTML = value;
      editor.rows = [];
    },
  });
  const root = {
    innerHTML: '',
    querySelector: (selector) => elements.get(selector),
    querySelectorAll: (selector) =>
      selector === '#pt-target-editor [data-i]' ? editor.rows.flatMap((row) => row.inputs) : [],
  };
  vi.stubGlobal('document', { getElementById: () => root, createElement: () => node() });
  const tool = new PingTool('fixture');
  const loaded = Promise.resolve(tool.setServers(servers));
  if (wait) await loaded;
  return { tool, editor, elements, loaded };
}

const target = (key, region, protocol = 'tcp') => ({
  key,
  label: key,
  protocol,
  host: `${key}.example.test`,
  port: 443,
  region,
});
const makeServer = (id, pingTargets) => {
  configurations.set(id, {
    report_interval: 30,
    custom_setting: { enabled: true },
    ping_targets: pingTargets,
  });
  return Object.freeze({ id, name: `VPS ${id}`, ip: '192.0.2.1' });
};
const select = (name) => `region:${encodeURIComponent(name)}`;

beforeEach(() => {
  vi.clearAllMocks();
  request.mockReset();
  configurations.clear();
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true),
  );
  request.mockImplementation(async (path, options) => {
    const match = path.match(/^\/servers\/(\d+)\/agent-(overview|config)$/u);
    if (!match) throw new Error(`Unexpected transport: ${path}`);
    const serverId = Number(match[1]);
    if (match[2] === 'config') {
      expect(options.method).toBe('PUT');
      configurations.set(serverId, {
        ...configurations.get(serverId),
        ...JSON.parse(options.body),
      });
    }
    return {
      server_id: serverId,
      agent_config: structuredClone(configurations.get(serverId) || {}),
    };
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('PingTool regional configuration lifecycle', () => {
  it('edits region, exports and saves other config intact, then reloads the region', async () => {
    const server = makeServer(101, [target('stable-key', '东亚')]);
    const { tool, editor } = await fixture([server]);
    editor.rows = [
      editedRow(tool._targets[0], { region: 'Europe & West/北', label: 'Edited label' }),
    ];
    tool._collectTargets();
    const exported = tool._targets.map((entry) => tool._exportTarget(entry));
    expect(exported[0]).toMatchObject({
      key: 'stable-key',
      region: 'Europe & West/北',
      label: 'Edited label',
    });
    const payload = tool._savedPayload(exported);
    expect(payload).toEqual({ ping_targets: exported });
    editor.rows = [];
    await tool._saveTargets();
    expect(saveCalls()).toEqual([
      ['/servers/101/agent-config', { method: 'PUT', body: JSON.stringify(payload) }],
    ]);
    await tool._loadTargetsFromServer();
    expect(tool._targets[0]).toMatchObject({ key: 'stable-key', region: 'Europe & West/北' });
    expect(tool._agentConfig).toMatchObject({
      report_interval: 30,
      custom_setting: { enabled: true },
    });
    expect(server).not.toHaveProperty('agent_config');
  });

  it('collects existing edits before filtering and saves hidden targets from full memory', async () => {
    const initial = [
      target('east-1', '东亚'),
      target('east-2', '东亚', 'icmp'),
      target('west-1', 'Europe', 'http'),
      target('west-2', 'Europe'),
    ];
    const { tool, editor } = await fixture([makeServer(101, initial)]);
    editor.rows = [editedRow(tool._targets[0], { label: 'unsaved edit' })];
    tool._setRegionSelection(select('Europe'));
    expect(tool._targets[0].label).toBe('unsaved edit');
    expect(editor.innerHTML).toContain('west-1');
    expect(editor.innerHTML).not.toContain('east-1');
    expect(editor.innerHTML).toContain('data-i="2"');
    editor.rows = [
      editedRow(tool._targets[2], { region: 'Europe/北', label: 'west edited' }, 2),
      editedRow(tool._targets[3], {}, 3),
    ];
    await tool._saveTargets();
    const saved = savedPayload().ping_targets;
    expect(saved.map((entry) => entry.key)).toEqual(initial.map((entry) => entry.key));
    expect(saved[0]).toMatchObject({ region: '东亚', label: 'unsaved edit' });
    expect(saved[1]).toMatchObject({ region: '东亚', protocol: 'icmp' });
    expect(saved[2]).toMatchObject({ region: 'Europe/北', label: 'west edited', protocol: 'http' });
    expect(saved[3].region).toBe('Europe');
  });

  it('renders literal sentinel-like names separately from empty and unknown metadata', async () => {
    const { tool, editor, elements } = await fixture([
      makeServer(101, [
        target('literal-default', 'default'),
        target('literal-ungrouped', '__ungrouped__'),
        target('empty-target', ''),
        target('unknown-target', null),
        target('object-target', {}),
      ]),
    ]);
    expect(elements.get('#pt-region-select').innerHTML).toContain('未分组');
    tool._setRegionSelection(select('default'));
    expect(editor.innerHTML).toContain('literal-default');
    expect(editor.innerHTML).not.toContain('empty-target');
    tool._setRegionSelection(select('__ungrouped__'));
    expect(editor.innerHTML).toContain('literal-ungrouped');
    expect(editor.innerHTML).not.toContain('empty-target');
    tool._setRegionSelection('ungrouped');
    expect(tool._targets.slice(2).map((entry) => entry.region)).toEqual(['', '', '']);
    expect(editor.innerHTML).toContain('empty-target');
    expect(editor.innerHTML).toContain('unknown-target');
    expect(editor.innerHTML).toContain('object-target');
    expect(editor.innerHTML).not.toContain('literal-default');
    expect(editor.innerHTML).not.toContain('literal-ungrouped');
  });

  it('adds multiple targets in the selected region without colliding and removes only the keyed row', async () => {
    const { tool } = await fixture([
      makeServer(101, [
        target('target-1', '东亚'),
        target('target-3', 'Europe'),
        target('fixed', 'Europe'),
      ]),
    ]);
    tool._setRegionSelection(select('Europe'));
    tool._addTarget();
    tool._addTarget();
    expect(tool._targets).toHaveLength(5);
    expect(new Set(tool._targets.map((entry) => entry.key)).size).toBe(5);
    expect(tool._targets.slice(3).map((entry) => entry.region)).toEqual(['Europe', 'Europe']);
    const addedKey = tool._targets[3].key;
    tool._removeTarget(addedKey);
    expect(tool._targets.map((entry) => entry.key)).toEqual([
      'target-1',
      'target-3',
      'fixed',
      tool._targets[3].key,
    ]);
    expect(tool._targets[0].region).toBe('东亚');
    tool._setRegionSelection('ungrouped');
    tool._addTarget();
    expect(tool._targets.at(-1).region).toBe('');
  });

  it('keeps target keys stable when a region changes and moves the edited row between filters', async () => {
    const { tool, editor, elements } = await fixture([
      makeServer(101, [target('stable', '东亚'), target('west', 'Europe')]),
    ]);
    tool._setRegionSelection(select('东亚'));
    editor.rows = [editedRow(tool._targets[0], { region: '香港/東京' })];
    tool._setRegionSelection(select('香港/東京'));
    expect(tool._targets[0]).toMatchObject({ key: 'stable', region: '香港/東京' });
    expect(editor.innerHTML).toContain('stable');
    expect(editor.innerHTML).not.toContain('west');
    expect(elements.get('#pt-region-select').innerHTML).toContain('香港/東京');
  });

  it.each(['a'.repeat(33), '🌏'.repeat(33), 'bad\nregion', 'bad\rregion'])(
    'rejects invalid edited regions without transport or partially changing config: %j',
    async (invalidRegion) => {
      const server = makeServer(101, [target('first', '东亚'), target('second', 'Europe')]);
      const { tool, editor } = await fixture([server]);
      editor.rows = [
        editedRow(tool._targets[0], { region: 'valid change' }),
        editedRow(tool._targets[1], { region: invalidRegion }, 1),
      ];
      await tool._saveTargets();
      expect(saveCalls()).toEqual([]);
      expect(tool._targets.map((entry) => entry.region)).toEqual(['东亚', 'Europe']);
      expect(configurations.get(101).ping_targets.map((entry) => entry.region)).toEqual([
        '东亚',
        'Europe',
      ]);
      expect(alert).toHaveBeenCalled();
    },
  );

  it('accepts the valid 32-code-point UTF-8 boundary without changing keys', async () => {
    const { tool, editor } = await fixture([makeServer(101, [target('emoji-key', '')])]);
    editor.rows = [editedRow(tool._targets[0], { region: '🌏'.repeat(32) })];
    await tool._saveTargets();
    expect(savedPayload().ping_targets[0]).toMatchObject({
      key: 'emoji-key',
      region: '🌏'.repeat(32),
    });
  });

  it('clears to explicit [] preserving other config and never reloads defaults', async () => {
    const server = makeServer(101, [target('configured', '东亚')]);
    const { tool, editor } = await fixture([server]);
    await tool._clearSavedTargets();
    expect(savedPayload()).toEqual({ ping_targets: [] });
    await tool._loadTargetsFromServer();
    expect(tool._targets).toEqual([]);
    expect(editor.innerHTML).not.toContain('configured');
    expect(editor.innerHTML).not.toContain('value="hk"');
    expect(tool._agentConfig).toMatchObject({
      report_interval: 30,
      custom_setting: { enabled: true },
    });
    expect(server).not.toHaveProperty('agent_config');
  });

  it('restores independent, legal selections when switching VPS and updating the server list', async () => {
    const servers = [
      makeServer(101, [target('east', '东亚'), target('west', 'Europe')]),
      makeServer(202, [target('two-west', 'Europe'), target('two-empty', '')]),
    ];
    const { tool, elements, editor } = await fixture(servers);
    tool._setRegionSelection(select('东亚'));
    const serverSelect = elements.get('#pt-server-select');
    await serverSelect.listeners.change({ target: { value: '202' } });
    expect(elements.get('#pt-region-select').value).toBe('all');
    tool._setRegionSelection('ungrouped');
    await serverSelect.listeners.change({ target: { value: '101' } });
    expect(elements.get('#pt-region-select').value).toBe(select('东亚'));
    expect(editor.innerHTML).toContain('east');
    expect(editor.innerHTML).not.toContain('west');
    await serverSelect.listeners.change({ target: { value: '202' } });
    expect(elements.get('#pt-region-select').value).toBe('ungrouped');
    await tool.setServers([makeServer(202, [target('new-only', 'Elsewhere')])]);
    expect(tool._selectedServerId).toBe(202);
    expect(elements.get('#pt-region-select').value).toBe('ungrouped');
    tool._setRegionSelection(select('Elsewhere'));
    await tool.setServers([makeServer(202, [target('changed', 'New region')])]);
    expect(elements.get('#pt-region-select').value).toBe('all');
    await tool.setServers([makeServer(303, [target('replacement', '')])]);
    expect(tool._selectedServerId).toBe(303);
  });

  it('does not expose peer vps-* entries in the external manager', async () => {
    const { tool, editor, elements } = await fixture([
      makeServer(101, [target('public', '东亚'), target('vps-99', 'Peer region')]),
    ]);
    expect(tool._targets.map((entry) => entry.key)).toEqual(['public']);
    expect(editor.innerHTML).not.toContain('vps-99');
    expect(elements.get('#pt-region-select').innerHTML).not.toContain('Peer region');
  });
});

describe('PingTool protected source at the constructor/setServers entry', () => {
  const persistedTargets = () => [
    target('1-asia-1', '东亚'),
    target('1-asia-2', '东亚', 'icmp'),
    target('1-eu-1', '欧洲', 'http'),
    target('1-un', ''),
    target('1-literal', 'default'),
  ];

  it('reads five persisted targets from protected transport, never the public DTO or four presets', async () => {
    const server = makeServer(1, persistedTargets());
    const snapshot = structuredClone(server);
    const { tool, editor, elements } = await fixture([server]);
    expect(request).toHaveBeenCalledWith('/servers/1/agent-overview');
    expect(renderedKeys(editor)).toEqual(persistedTargets().map((entry) => entry.key));
    expect(renderedKeys(editor)).not.toEqual(['hk', 'jp', 'sg', 'us']);
    for (const region of ['东亚', '欧洲', 'default', '未分组']) {
      expect(elements.get('#pt-region-select').innerHTML).toContain(region);
    }
    expect(elements.get('#pt-source-note').textContent).not.toContain('未配置');
    tool._setRegionSelection(select('欧洲'));
    editor.rows = [editedRow(tool._targets[2], { label: 'European edit' }, 2)];
    await tool._saveTargets();
    expect(savedPayload()).toEqual({ ping_targets: expect.any(Array) });
    expect(savedPayload().ping_targets.map((entry) => entry.key)).toEqual(
      persistedTargets().map((entry) => entry.key),
    );
    expect(savedPayload().ping_targets.map((entry) => entry.region)).toEqual([
      '东亚',
      '东亚',
      '欧洲',
      '',
      'default',
    ]);
    expect(savedPayload().ping_targets[2].label).toBe('European edit');
    expect(server).toEqual(snapshot);
    expect(server).not.toHaveProperty('agent_config');
  });

  it('locks edits and saves while the protected read is pending, without preset previews or probes', async () => {
    const pending = deferred();
    request.mockImplementationOnce(() => pending.promise);
    const { tool, editor, elements, loaded } = await fixture([makeServer(1, persistedTargets())], {
      wait: false,
    });
    expect(elements.get('#pt-source-note').textContent).toContain('读取中');
    for (const id of [
      'pt-region-select',
      'pt-add-row',
      'pt-save',
      'pt-clear',
      'pt-export',
      'pt-run',
      'pt-run-node',
    ]) {
      expect(elements.get(`#${id}`).disabled).toBe(true);
    }
    expect(renderedKeys(editor)).toEqual([]);
    tool._addTarget();
    await tool._saveTargets();
    await tool._clearSavedTargets();
    expect(tool._targets).toEqual([]);
    expect(saveCalls()).toEqual([]);
    pending.resolve({ server_id: 1, agent_config: { ping_targets: persistedTargets() } });
    await loaded;
    expect(renderedKeys(editor)).toHaveLength(5);
    expect(elements.get('#pt-save').disabled).toBe(false);
  });

  it('discards slow A after fast B including when A rejects', async () => {
    const pending = deferred();
    request.mockImplementationOnce(() => pending.promise);
    const servers = [
      makeServer(1, persistedTargets()),
      makeServer(2, [target('b-only', 'Europe')]),
    ];
    const { tool, editor, elements, loaded } = await fixture(servers, { wait: false });
    await elements.get('#pt-server-select').listeners.change({ target: { value: '2' } });
    expect(renderedKeys(editor)).toEqual(['b-only']);
    pending.resolve({ server_id: 1, agent_config: { ping_targets: persistedTargets() } });
    await loaded;
    expect(tool._selectedServerId).toBe(2);
    expect(renderedKeys(editor)).toEqual(['b-only']);
    expect(elements.get('#pt-save').disabled).toBe(false);
    const staleFailure = deferred();
    request.mockImplementationOnce(() => staleFailure.promise);
    const oldLoad = elements.get('#pt-server-select').listeners.change({ target: { value: '1' } });
    await elements.get('#pt-server-select').listeners.change({ target: { value: '2' } });
    staleFailure.reject(new Error('403 stale A'));
    await oldLoad;
    expect(renderedKeys(editor)).toEqual(['b-only']);
    expect(elements.get('#pt-save').disabled).toBe(false);
  });

  it('discards an older response for a same-node reload', async () => {
    const pending = deferred();
    request.mockImplementationOnce(() => pending.promise);
    const { tool, editor, elements, loaded } = await fixture(
      [makeServer(1, [target('latest', 'Europe')])],
      { wait: false },
    );
    await elements.get('#pt-load').listeners.click();
    pending.resolve({ server_id: 1, agent_config: { ping_targets: persistedTargets() } });
    await loaded;
    expect(tool._selectedServerId).toBe(1);
    expect(renderedKeys(editor)).toEqual(['latest']);
    expect(elements.get('#pt-save').disabled).toBe(false);
  });

  it.each(['network', '401 Unauthorized', '403 Forbidden', '500 Server error'])(
    'fails closed after a previously successful read when reload rejects: %s',
    async (message) => {
      const { tool, editor, elements } = await fixture([makeServer(1, persistedTargets())]);
      request.mockRejectedValueOnce(new Error(message));
      await elements.get('#pt-load').listeners.click();
      expect(elements.get('#pt-source-note').textContent).toContain('读取失败');
      expect(elements.get('#pt-source-note').textContent).not.toContain('未配置');
      expect(renderedKeys(editor)).toEqual([]);
      expect(elements.get('#pt-save').disabled).toBe(true);
      expect(elements.get('#pt-clear').disabled).toBe(true);
      tool._addTarget();
      await tool._saveTargets();
      await tool._clearSavedTargets();
      expect(saveCalls()).toEqual([]);
      await elements.get('#pt-load').listeners.click();
      expect(renderedKeys(editor)).toHaveLength(5);
      expect(elements.get('#pt-save').disabled).toBe(false);
    },
  );

  it.each(
    [
      null,
      [],
      {},
      { server_id: 2, agent_config: {} },
      { server_id: 1 },
      { server_id: 1, agent_config: null },
      { server_id: 1, agent_config: [] },
      { server_id: 1, agent_config: 'invalid' },
      { server_id: 1, agent_config: { ping_targets: null } },
      { server_id: 1, agent_config: { ping_targets: {} } },
      { server_id: 1, agent_config: { ping_targets: [null] } },
      { server_id: 1, agent_config: { ping_targets: ['invalid'] } },
    ].map((payload) => ({ payload })),
  )(
    'rejects invalid protected payload without opening preset saving: $payload',
    async ({ payload }) => {
      request.mockResolvedValueOnce(payload);
      const { tool, editor, elements } = await fixture([makeServer(1, persistedTargets())]);
      expect(elements.get('#pt-source-note').textContent).toContain('读取失败');
      expect(renderedKeys(editor)).toEqual([]);
      expect(elements.get('#pt-save').disabled).toBe(true);
      await tool._saveTargets();
      await tool._clearSavedTargets();
      expect(saveCalls()).toEqual([]);
    },
  );

  it.each([{}, { report_interval: 30 }])(
    'previews presets only after a valid genuinely unconfigured response: %j',
    async (config) => {
      configurations.set(1, config);
      const { tool, editor, elements } = await fixture([
        Object.freeze({ id: 1, name: 'Unconfigured' }),
      ]);
      expect(renderedKeys(editor)).toEqual(['hk', 'jp', 'sg', 'us']);
      expect(elements.get('#pt-source-note').textContent).toContain('未配置');
      expect(saveCalls()).toEqual([]);
      await tool._saveTargets();
      expect(savedPayload().ping_targets.map((entry) => entry.key)).toEqual([
        'hk',
        'jp',
        'sg',
        'us',
      ]);
    },
  );

  it('keeps explicit empty targets distinct from unconfigured defaults', async () => {
    const { tool, editor, elements } = await fixture([makeServer(1, [])]);
    expect(renderedKeys(editor)).toEqual([]);
    expect(tool._targets).toEqual([]);
    expect(elements.get('#pt-source-note').textContent).toContain('已保存为空');
    expect(saveCalls()).toEqual([]);
    expect(elements.get('#pt-save').disabled).toBe(false);
  });

  it('locks saving with no active server and drops a removed server response', async () => {
    const pending = deferred();
    request.mockImplementationOnce(() => pending.promise);
    const { tool, editor, elements, loaded } = await fixture([makeServer(1, persistedTargets())], {
      wait: false,
    });
    await tool.setServers([]);
    pending.resolve({ server_id: 1, agent_config: { ping_targets: persistedTargets() } });
    await loaded;
    expect(renderedKeys(editor)).toEqual([]);
    expect(elements.get('#pt-save').disabled).toBe(true);
    await tool._saveTargets();
    expect(saveCalls()).toEqual([]);
  });
});
