import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const cesiumSource = readFileSync(new URL('../src/components/CesiumGlobe.js', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8');

const globeSelection = mainSource.match(/function handleGlobeNodeSelection\([\s\S]*?\n}/);
const fanout = cesiumSource.match(/showClusterFanout\([\s\S]*?\n  }\n\n  expandClusterFanout/);
assert.ok(globeSelection, 'globe selection handler must exist');
assert.ok(fanout, 'cluster fanout renderer must exist');
assert.match(globeSelection[0], /if \(selection\.type === 'navigate'\) \{ closeClusterInteraction\(\); navigateToServer\(selection\.member\); return; }/, 'a non-cluster server must still navigate directly');
assert.match(globeSelection[0], /showClusterFanout\(fanoutCluster, selection\.members\);/, 'a co-located anchor must explicitly expand into group HUD shapes');
assert.doesNotMatch(globeSelection[0], /showClusterMemberPicker\(/, 'normal co-located anchors and labels must not open the member picker');
assert.match(fanout[0], /member\.addEventListener\('click', \(event\) => \{ event\.stopPropagation\(\); onMemberClick\?\.\(item\.group\); }\)/, 'only an explicitly-expanded group HUD shape may invoke its picker callback');
assert.match(stylesSource, /\.cluster-member-picker \{[^}]*background: rgba\(3,20,25,\.74\);[^}]*backdrop-filter: blur\(14px\) saturate\(1\.12\);/, 'member picker must use the translucent frosted beacon-callout treatment');
assert.doesNotMatch(stylesSource, /\.cluster-member-picker \{[^}]*rgba\(7,12,23,\.96\)/, 'member picker must not use the opaque legacy panel background');
assert.match(stylesSource, /html body \.google-earth-node-html-label\.is-vps-node\.is-vps-beacon-node \{[\s\S]*?background: rgba\(8, 18, 31, \.60\) !important;[\s\S]*?backdrop-filter: blur\(10px\)/, 'the final loaded stylesheet must override starship beacon labels with translucent frosted styling');
assert.match(cesiumSource, /const MOBILE_IMAGERY_TONE = \{ brightness: 0\.96, contrast: 1\.08, saturation: 1\.04, gamma: 1\.0 \};/, 'mobile imagery tone must be conservative and non-clipping');
assert.match(cesiumSource, /Object\.assign\(base, \{ show: true, alpha: 1\.0, \.\.\.\(isMobileGlobe\(\) \? MOBILE_IMAGERY_TONE : DESKTOP_BASE_IMAGERY_TONE\) }\);/, 'base layer initialization must respect the mobile tone branch');
assert.match(cesiumSource, /Object\.assign\(sat, \{ show: true, alpha: 1\.0, \.\.\.\(isMobileGlobe\(\) \? MOBILE_IMAGERY_TONE : DESKTOP_SAT_IMAGERY_TONE\) }\);/, 'satellite layer initialization must respect the mobile tone branch');
assert.match(cesiumSource, /this\._baseLayer, mobile \? MOBILE_IMAGERY_TONE : DESKTOP_BASE_IMAGERY_TONE/, 'base layer activation must preserve the mobile branch');
assert.match(cesiumSource, /this\._satLayer, mobile \? MOBILE_IMAGERY_TONE : DESKTOP_SAT_IMAGERY_TONE/, 'satellite layer activation must preserve the mobile branch');

console.log('focused globe regressions: ok');
