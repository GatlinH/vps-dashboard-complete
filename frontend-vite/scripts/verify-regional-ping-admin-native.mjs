#!/usr/bin/env node
import assert from 'node:assert/strict'

const usage = `Usage: node scripts/verify-regional-ping-admin-native.mjs \\
  --base-url http://127.0.0.1:35807 --cdp-base http://127.0.0.1:45027 \\
  --auth-bootstrap-path /__lab/auth --server-id 1

Requires Node 24 native fetch/WebSocket and a running Chromium CDP endpoint.
Only loopback synthetic persisted UI fixtures are allowed. No credentials accepted.
Reads protected APIs and real admin DOM; never probes, saves, or clears targets.
Creates and closes its own isolated browser context; never closes the browser.
The sole authentication bootstrap is a GET to the supplied fixture path.
Native RED/GREEN requires execution against the actual served admin bundle.`

const timeoutMs = 15000
const fixtureKind = 'synthetic persisted UI fixtures, not live VPS measurements'
const report = { status: 'PENDING', fixtureKind }
let socket
let contextId
let targetId
let sessionId
let nextId = 0
let protocolFailure
const pending = new Map()
const uiReads = new Map()
let observeUiUrl
const loadingPattern = /读取中|加载中|正在读取|loading/i

function loopbackUrl(value, name, protocols = ['http:', 'https:']) {
  const url = new URL(value)
  assert(protocols.includes(url.protocol), `${name}: unsupported protocol`)
  assert(
    ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname),
    `${name}: only loopback hosts allowed`,
  )
  assert(!url.username && !url.password, `${name}: credentials forbidden`)
  assert(!url.search && !url.hash, `${name}: query/fragment forbidden`)
  return url
}

function parseArgs() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage)
    return null
  }
  const options = {}
  const names = ['--base-url', '--cdp-base', '--auth-bootstrap-path', '--server-id']
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    assert(names.includes(name), `Unknown option: ${name}`)
    assert(!Object.hasOwn(options, name), `Duplicate option: ${name}`)
    assert(args[index + 1] && !args[index + 1].startsWith('--'), `Missing ${name}`)
    options[name] = args[index + 1]
  }
  for (const name of names) assert(options[name], `Required option: ${name}`)
  const base = loopbackUrl(options['--base-url'], 'base URL')
  const cdp = loopbackUrl(options['--cdp-base'], 'CDP URL')
  assert(base.pathname === '/' && cdp.pathname === '/', 'Use origin URLs only')
  const authPath = options['--auth-bootstrap-path']
  assert(/^\/__lab\/[a-zA-Z0-9/_-]+$/.test(authPath), 'Bootstrap must be a credential-free /__lab/ path')
  const auth = new URL(authPath, base)
  assert(auth.origin === base.origin && auth.pathname.startsWith('/__lab/'), 'Invalid bootstrap origin/path')
  const serverId = options['--server-id']
  assert(/^\d+$/.test(serverId), 'server-id must be numeric')
  return { base: base.origin, cdp: cdp.origin, auth: auth.href, serverId }
}

async function jsonGet(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
  assert(response.ok, `${url}: HTTP ${response.status}`)
  return response.json()
}

function failPending(error) {
  protocolFailure = error
  for (const request of pending.values()) {
    clearTimeout(request.timer)
    request.reject(error)
  }
  pending.clear()
}

async function connect(url) {
  loopbackUrl(url, 'CDP WebSocket', ['ws:', 'wss:'])
  socket = new WebSocket(url)
  socket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data)
      if (message.sessionId === sessionId && observeUiUrl) {
        const params = message.params
        if (message.method === 'Network.requestWillBeSent' && params.request.url === observeUiUrl) {
          uiReads.set(params.requestId, { url: params.request.url, method: params.request.method, settled: false })
        }
        const read = uiReads.get(params?.requestId)
        if (read && message.method === 'Network.responseReceived') read.status = params.response.status
        if (read && message.method === 'Network.loadingFinished') read.settled = true
        if (read && message.method === 'Network.loadingFailed') {
          read.settled = true
          read.error = params.errorText
        }
      }
      if (!message.id) return
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) request.reject(new Error(`${request.method}: ${JSON.stringify(message.error)}`))
      else request.resolve(message.result)
    } catch (error) {
      failPending(error)
    }
  })
  socket.addEventListener('error', () => failPending(new Error('CDP WebSocket error')))
  socket.addEventListener('close', () => failPending(new Error('CDP WebSocket closed')))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connection timeout')), timeoutMs)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')) }, { once: true })
  })
}

function command(method, params = {}, page = false) {
  if (protocolFailure) return Promise.reject(protocolFailure)
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method}: timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer, method })
    try {
      socket.send(JSON.stringify({ id, method, params, ...(page ? { sessionId } : {}) }))
    } catch (error) {
      clearTimeout(timer)
      pending.delete(id)
      reject(error)
    }
  })
}

async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs }, true)
  assert(!result.exceptionDetails, `Runtime exception: ${JSON.stringify(result.exceptionDetails)}`)
  return result.result.value
}

async function waitFor(expression, description) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timeout waiting for ${description}`)
}

async function snapshot() {
  const dom = await evaluate(`(() => {
    const editor = document.querySelector('#pt-target-editor');
    const region = document.querySelector('#pt-region-select');
    const save = document.querySelector('#pt-save');
    return {
      url: location.href,
      present: !!editor && !!region && !!save,
      keys: Array.from(editor?.querySelectorAll('input[data-f="key"]') || [], input => input.value),
      options: Array.from(region?.options || [], option => ({ value: option.value, text: option.textContent.trim(), selected: option.selected })),
      sourceNote: document.querySelector('#pt-source-note')?.textContent || '',
      editorText: editor?.textContent || '',
      saveDisabled: save?.disabled,
      selectedServer: document.querySelector('#pt-server-select')?.value
    };
  })()`)
  report.actual = { ...dom, count: dom.keys.length }
  report.uiProtectedReads = [...uiReads.values()]
  return dom
}

async function settledSnapshot() {
  const deadline = Date.now() + timeoutMs
  let stable = 0
  while (Date.now() < deadline) {
    const dom = await snapshot()
    const loading = loadingPattern.test(dom.sourceNote)
      || [...uiReads.values()].some((read) => !read.settled)
    assert(!loading || dom.saveDisabled === true, 'Loading unresolved but save is enabled')
    if (dom.present && !loading && (dom.keys.length || /失败|错误|未配置|error/i.test(dom.sourceNote))) {
      if (++stable === 2) return dom
    } else stable = 0
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timeout waiting for real DOM loading state to settle')
}

async function run(options) {
  report.urls = {
    inspect: `${options.base}/__lab/inspect`,
    bootstrap: options.auth,
    admin: `${options.base}/admin.html`,
    me: `${options.base}/api/v1/auth/me`,
    overview: `${options.base}/api/v1/servers/${options.serverId}/agent-overview`,
    list: `${options.base}/api/v1/servers/`,
    cdp: `${options.cdp}/json/version`,
  }
  const fixture = await jsonGet(report.urls.inspect)
  assert.equal(fixture.fixture_kind, fixtureKind, 'Refusing non-synthetic service')
  assert(fixture.configs && Object.hasOwn(fixture.configs, options.serverId), 'Synthetic config missing for server')
  report.fixtureServerId = options.serverId
  const publicList = await jsonGet(report.urls.list)
  assert(!/"(?:agent_config|ping_targets)"\s*:/.test(JSON.stringify(publicList)), 'Public list leaks private config')
  report.publicListHasConfig = false
  const version = await jsonGet(report.urls.cdp)
  await connect(version.webSocketDebuggerUrl)
  contextId = (await command('Target.createBrowserContext')).browserContextId
  targetId = (await command('Target.createTarget', { url: 'about:blank', browserContextId: contextId })).targetId
  sessionId = (await command('Target.attachToTarget', { targetId, flatten: true })).sessionId
  await command('Page.enable', {}, true)
  await command('Runtime.enable', {}, true)
  await command('Network.enable', {}, true)
  const navigation = await command('Page.navigate', { url: options.auth }, true)
  assert(!navigation.errorText, `Bootstrap navigation: ${navigation.errorText}`)
  await waitFor(`location.origin === ${JSON.stringify(options.base)} && location.pathname === '/admin.html' && document.readyState === 'complete'`, 'authenticated admin.html')
  const api = await evaluate(`(async () => {
    const urls = ${JSON.stringify(report.urls)};
    const output = {};
    for (const name of ['me', 'overview']) {
      const response = await fetch(urls[name], { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(${timeoutMs}) });
      if (!response.ok) throw new Error(name + ': HTTP ' + response.status);
      output[name] = await response.json();
    }
    return output;
  })()`)
  const identity = api.me.data ?? api.me
  const role = identity.role ?? identity.user?.role
  report.role = role
  assert(['owner', 'admin'].includes(String(role).toLowerCase()), 'Authenticated Owner/admin required')
  const overview = api.overview.data ?? api.overview
  assert.equal(String(overview.server_id), options.serverId, 'Protected overview server_id mismatch')
  assert(!Object.hasOwn(overview, 'agent_key'), 'Overview must not return plaintext AgentKey')
  const targets = overview.agent_config?.ping_targets
  assert(Array.isArray(targets) && targets.length > 0, 'Protected expected targets must be nonempty')
  assert.equal(targets.length, 5, 'Synthetic persisted fixture must contain five targets')
  report.fixtureCount = targets.length
  const expectedKeys = targets.map((target) => target.key)
  assert(expectedKeys.every((key) => typeof key === 'string' && key.length > 0), 'Expected full keys required')
  assert.equal(new Set(expectedKeys).size, 5, 'Expected keys must be unique')
  const expectedRegions = [...new Set(targets.map((target) => target.region || '未分组'))].sort()
  report.expected = { count: targets.length, keys: expectedKeys, regions: expectedRegions }
  assert.deepEqual(expectedRegions, ['东亚 & /+', '欧洲', '未分组', 'default'].sort(), 'Required fixture regions missing, including literal default')
  assert.equal(targets.filter((target) => target.region === '东亚 & /+').length, 2, 'Fixture must contain two East Asia targets')
  observeUiUrl = report.urls.overview
  await evaluate(`(() => {
    const button = document.querySelector('button[data-tab="network"]');
    if (!button) throw new Error('Network tab button missing');
    button.click();
  })()`)
  await waitFor(`!!document.querySelector('#pt-server-select option[value="${options.serverId}"]')`, 'server selector')
  await evaluate(`(() => {
    const select = document.querySelector('#pt-server-select');
    select.value = ${JSON.stringify(options.serverId)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  const dom = await settledSnapshot()
  assert.equal(dom.selectedServer, options.serverId, 'Selected server mismatch')
  assert.equal(dom.keys.length, targets.length, `Actual DOM ${dom.keys.length} ≠ persisted ${targets.length}`)
  assert.equal(new Set(dom.keys).size, dom.keys.length, 'Duplicate DOM keys')
  assert.deepEqual([...dom.keys].sort(), [...expectedKeys].sort(), 'DOM full key set differs from protected GET')
  assert.equal(dom.options.filter((option) => option.value === 'all').length, 1, 'Exactly one all-regions option required')
  const actualRegions = dom.options.filter((option) => option.value !== 'all').map((option) => {
    if (option.value === 'ungrouped') return '未分组'
    assert(option.value.startsWith('region:'), `Invalid region option: ${option.value}`)
    const region = decodeURIComponent(option.value.slice(7))
    assert.equal(option.text, region, 'Region option label/value mismatch')
    return region
  }).sort()
  report.actual.regions = actualRegions
  assert.deepEqual(actualRegions, expectedRegions, 'DOM region set differs from protected GET')
  assert(!/未配置|失败|错误|读取中|加载中|loading|error/i.test(dom.sourceNote), 'Incorrect unconfigured/error/loading state')
  assert.equal(dom.saveDisabled, false, 'Loaded configuration must be ready, not unresolved')
  assert(uiReads.size > 0, 'Real UI did not issue a protected agent-overview GET')
  for (const read of uiReads.values()) {
    assert.equal(read.method, 'GET', 'Protected UI read must be GET')
    assert(read.settled && !read.error && read.status >= 200 && read.status < 300, `Protected UI read failed: ${JSON.stringify(read)}`)
  }
}

async function main() {
  try {
    const options = parseArgs()
    if (!options) return
    await run(options)
    assert(!protocolFailure, String(protocolFailure))
    report.status = 'PASS'
  } catch (error) {
    report.status = 'FAIL'
    report.error = error.stack ?? String(error)
    process.exitCode = 1
  } finally {
    for (const [method, params] of [
      ['Target.closeTarget', targetId ? { targetId } : null],
      ['Target.disposeBrowserContext', contextId ? { browserContextId: contextId } : null],
    ]) {
      if (!params) continue
      try { await command(method, params) } catch (error) {
        report.status = 'FAIL'
        report.cleanupError = String(error)
        process.exitCode = 1
      }
    }
    if (socket) socket.close()
    if (report.status !== 'PENDING') console.log(JSON.stringify(report, null, 2))
  }
}

await main()
