import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const detailStyles = readFileSync(new URL('../src/styles/detail-starfleet-console.css', import.meta.url), 'utf8');

const pingTargetSelector = mainSource.match(/function pingTargetsFromRows[\s\S]*?\n}\n\nfunction recordLivePingSamples/);
const pingDatasetBuilder = mainSource.match(/function buildPingDatasets[\s\S]*?\n}\n\nconst PING_AXIS_STEPS_MS/);
const bootFunction = mainSource.match(/async function boot\(\) \{[\s\S]*?\n}\n\nboot\(\);/);

assert.ok(pingTargetSelector, 'PING target selector must exist');
assert.ok(pingDatasetBuilder, 'PING dataset builder must exist');
assert.ok(bootFunction, 'boot function must exist');
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
assert.match(
  selectedServerBranch[1],
  /await renderDetailPage\(selectedServerId\)/,
  'selected detail boot must render the detail page directly',
);

console.log('DETAIL_PAGE_REGRESSIONS_VERIFIED external-ping-fallback=absent desktop-metric-grid=equal-width direct-detail-boot=yes');
