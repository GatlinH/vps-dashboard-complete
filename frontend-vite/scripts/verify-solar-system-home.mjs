import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const table = readFileSync(new URL('../src/modules/serverTable.js', import.meta.url), 'utf8');
const solar = readFileSync(new URL('../src/components/SolarSystem.js', import.meta.url), 'utf8');
const entry = readFileSync(new URL('../src/ui/sunMoonEntry.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles/starfleet-theme.css', import.meta.url), 'utf8');
assert.match(table, /id="solar-system-container"/);
assert.doesNotMatch(table, /globeSunMount|globeMoonRoot|globeMoonPanel/);
assert.doesNotMatch(table, /renderSunBadge|renderMoonPanel/);
assert.match(solar, /onSunClick/); assert.match(solar, /onMoonClick/); assert.match(solar, /onEarthClick/);
assert.match(table, /openFrontLogin/); assert.match(table, /openMoonOverview/); assert.match(table, /new CesiumGlobe/);
assert.equal((solar.match(/new THREE\.WebGLRenderer/g) || []).length, 1);
assert.equal((solar.match(/requestAnimationFrame/g) || []).length, 1);
const constructorStart = solar.indexOf('constructor(');
const resumeStart = solar.indexOf('resume() {');
assert.ok(constructorStart >= 0 && resumeStart > constructorStart, 'constructor/resume definitions not found');
const constructorBlock = solar.slice(constructorStart, resumeStart);
const resumeBlock = solar.slice(resumeStart, solar.indexOf('pause() {', resumeStart));
assert.doesNotMatch(resumeBlock, /this\._tick\s*=/);
assert.match(solar, /太阳（前往登录）/);
assert.match(solar, /地球（进入三维地球）/);
assert.match(solar, /月球（进入总览）/);
assert.match(solar, /name\s*===\s*['"]Sun['"]/);
assert.match(solar, /name\s*===\s*['"]Earth['"]/);
assert.match(solar, /name\s*===\s*['"]Moon['"]/);
assert.match(solar, /PointLight/);
assert.match(solar, /LineLoop|RingGeometry/);
// Planet count. An earlier revision matched /name:'[^']+'/g, which counted a quoting
// style rather than planets and broke the moment the table gained spaces after colons.
const planetTable = solar.slice(solar.indexOf('PLANET_TABLE'), solar.indexOf('];', solar.indexOf('PLANET_TABLE')));
assert.ok((planetTable.match(/name\s*:\s*['"][^'"]+['"]/g) || []).length >= 4);

// Planet revolution must be position-driven. The previous regex
// /angle\+=.*position\.set\(Math\.cos/ was satisfied by the moon's motion code alone,
// so it stayed green even when the planets were reverted to `rotation.y += k`.
// Anchor on the _advanceBodies definition: the iteration over every tracked body must
// accumulate an angle and derive the position from it, so faking planet motion breaks this.
const advanceStart = solar.indexOf('_advanceBodies(dt) {');
assert.ok(advanceStart > 0, '_advanceBodies(dt) definition not found');
const advance = solar.slice(advanceStart, advanceStart + 1200);
assert.match(advance, /this\.bodies\s*\.?\s*forEach|for\s*\(\s*const\s+\w+\s+of\s+this\.bodies\s*\)/);
assert.match(advance, /angle\s*\+=\s*\w+\.speed\s*\*\s*dt/);
assert.match(advance, /Math\.cos\(\s*\w+\.angle\s*\)/);
assert.match(advance, /Math\.sin\(\s*\w+\.angle\s*\)/);
assert.match(advance, /position\.set\(/);

// Escape handling and the sun entry must not regress to their earlier broken forms.
assert.doesNotMatch(table, /openFrontLogin\?\.\(\)\s*\|\|/);
assert.doesNotMatch(table, /once:\s*true/);
assert.doesNotMatch(table, /solarSystem\.running\s*=/);
assert.doesNotMatch(table, /window\.__solarEscapeHandler/);
assert.match(table, /solarSystem\?\.resume\?\.\(\)/);
assert.match(table, /solarSystem\?\.pause\?\.\(\)/);

// Scene lifecycle and observability.
assert.match(solar, /dispose/);
assert.match(solar, /pause\(/);
assert.match(solar, /resume\(/);
assert.match(solar, /solar-system-hit/);
assert.match(solar, /projected\.x\s*>=\s*-1/ , 'FAIL: hit visibility must check projected.x NDC bounds');
assert.match(solar, /projected\.y\s*>=\s*-1/ , 'FAIL: hit visibility must check projected.y NDC bounds');
assert.match(solar, /Math\.max\(1,\s*requiredDist\s*\/\s*baseDistance\)/, 'FAIL: home camera must only pull back');
assert.match(solar, /aspect[^\n]*hfovHalf|hfovHalf[^\n]*aspect/, 'FAIL: home camera fit must use aspect');
assert.match(solar, /getBodySnapshot/);
assert.match(solar, /cameraAtHome/);
assert.match(solar, /_snapToHome\(\)[\s\S]{0,180}this\.cameraTween\s*=\s*null/);
function methodSpan(source, signature) {
  const start = source.indexOf(signature); assert.ok(start >= 0, `method not found: ${signature}`);
  const closeParams = source.indexOf(')', start);
  const open = source.indexOf('{', closeParams >= 0 ? closeParams : start); let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return [start, i + 1];
  }
  assert.fail(`unclosed method: ${signature}`);
}
const constructorSpan = methodSpan(solar, 'constructor(');
const snapSpan = methodSpan(solar, '_snapToHome() {');
const trueWrites = [...solar.matchAll(/cameraAtHome\s*(=|\|\|=|\?\?=)\s*true/g)];
assert.ok(trueWrites.length >= 2, 'cameraAtHome must have true writes in constructor and _snapToHome');
for (const match of trueWrites) {
  const p = match.index;
  assert.ok((p >= constructorSpan[0] && p < constructorSpan[1]) || (p >= snapSpan[0] && p < snapSpan[1]),
    'cameraAtHome true writes must be confined to constructor and _snapToHome; _snapToHome must be the unique writer or resize() guard invariant can fail');
}
assert.doesNotMatch(solar, /Object\.assign\([^)]*cameraAtHome\s*:/, 'Object.assign cameraAtHome write requires manual review');
assert.match(solar, /this\._syncHitButtons\(\);\s*\n\s*return this;/);
assert.match(solar, /HOME_FOV/);
assert.match(solar, /\(earthSize \+ moonSize\) \* 0\.5 \* 1\.1/, 'FAIL: separation threshold must be half-width sum plus 10% margin (* 0.5 * 1.1) to prevent hit-box overlap');
assert.match(solar, /getWorldPosition/);
assert.match(solar, /len\s*>=\s*0\.5/);
assert.match(table, /modelUrl: '\/globe\/xinjian1\.glb\?v=20260728'/); assert.match(table, /fallbackModelUrl: ''/);
assert.match(entry, /export function renderSunBadge/); assert.match(entry, /export function renderMoonPanel/);
assert.doesNotMatch(css, /\.starship-gltf-stage\s*\{[^}]*inset:\s*0/);
console.log('solar system home contract: ok');
