import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const detailPageSource = readFileSync(new URL('../src/pages/detailPage.js', import.meta.url), 'utf8');
const detailStyles = readFileSync(new URL('../src/styles/detail-starfleet-console.css', import.meta.url), 'utf8');

const pingTargetSelector = mainSource.match(/function pingTargetsFromRows[\s\S]*?\n}\n\nfunction recordLivePingSamples/);
const pingDatasetBuilder = mainSource.match(/function buildPingDatasets[\s\S]*?\n}\n\nconst PING_AXIS_STEPS_MS/);
const bootFunction = mainSource.match(/async function boot\(\) \{[\s\S]*?\n}\n\nboot\(\);/);
const detailRenderFunction = mainSource.match(/async function renderDetailPage\(serverId\) \{[\s\S]*?\n}\s*function denseFallbackSeries/);
const loadingShell = detailPageSource.match(/export function detailLoadingShell\([^)]*\) \{[\s\S]*?\n}\s*export function renderDetailNotFound/);

assert.ok(pingTargetSelector, 'PING target selector must exist');
assert.ok(pingDatasetBuilder, 'PING dataset builder must exist');
assert.ok(bootFunction, 'boot function must exist');
assert.ok(detailRenderFunction, 'detail renderer must exist');
assert.ok(loadingShell, 'detail loading shell must exist');
assert.doesNotMatch(
  pingTargetSelector[0],
  /names\.add\('节点延迟'\)/,
  'generic persisted latency_ms must not become an external PING target when configured targets are empty',
);
assert.doesNotMatch(
  pingDatasetBuilder[0],
  /key === '节点延迟'.*row\.latency_ms/,
  'generic persisted latency_ms must not become an external PING chart dataset',
);
assert.match(
  detailStyles,
  /@media \(min-width: 1201px\) \{[\s\S]*?\.fleet-detail-console\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/,
  'desktop ENV, ALC, RES, and NET cards must use four equal-width grid tracks',
);
const selectedServerBranch = bootFunction[0].match(/else if \(selectedServerId\) \{([\s\S]*?)\n  } else if \(loginMode\)/);
assert.ok(selectedServerBranch, 'boot must retain a selected-server branch before login routing');
assert.doesNotMatch(
  selectedServerBranch[1],
  /mountDisplayPage\(\)/,
  'selected detail boot must not mount legacy display DOM before renderDetailPage',
);
assert.match(indexSource, /document\.documentElement\.classList\.add\('detail-pending'\)/, 'detail routes must enable the preboot guard');
assert.match(indexSource, /\.detail-pending #starfield[\s\S]*?\.detail-pending \.display-shell/, 'preboot guard must hide only legacy overview layers');
assert.match(mainSource, /app\.innerHTML = detailLoadingShell\(resolvedServer\);\n  document\.documentElement\.classList\.remove\('detail-pending'\)/, 'detail renderer must release the preboot guard when it takes ownership');
assert.match(
  selectedServerBranch[1],
  /await renderDetailPage\(selectedServerId\)/,
  'selected detail boot must render the detail page directly',
);
assert.match(loadingShell[0], /fleet-detail-console/, 'loading state must use the native fleet detail console');
assert.match(loadingShell[0], /正在同步实时与历史指标/, 'loading state must expose a detail-native sync status');
assert.match(loadingShell[0], /class="probe-card detail-loading-metric"/, 'loading state must include metric skeleton cards');
const loadingMetricLabels = loadingShell[0].match(/const metricLabels = \[([^\]]+)\]/);
assert.ok(loadingMetricLabels, 'loading state must declare its metric skeleton cards');
assert.equal(
  loadingMetricLabels[1].split(',').length,
  4,
  'loading state must render exactly four metric skeleton cards',
);
assert.doesNotMatch(mainSource, /detail-loading-card/, 'detail render flow must not inject the legacy centered loading card');
assert.equal(
  (detailRenderFunction[0].match(/app\.innerHTML = detailLoadingShell\(resolvedServer\);/g) || []).length,
  1,
  'normal detail rendering must mount the loading shell only once',
);
assert.match(detailStyles, /\.detail-loading-console/, 'detail loading skeleton styles must remain detail scoped');

console.log('DETAIL_PAGE_REGRESSIONS_VERIFIED external-ping-fallback=absent desktop-metric-grid=equal-width direct-detail-boot=yes native-loading-shell=yes single-mount=yes');
