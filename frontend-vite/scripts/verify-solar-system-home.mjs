import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertLegacySunMoonRemoval, readLegacySolarSources } from './lib/legacySolarDom.mjs';
const table = readFileSync(new URL('../src/modules/serverTable.js', import.meta.url), 'utf8');
const solar = readFileSync(new URL('../src/components/SolarSystem.js', import.meta.url), 'utf8');
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
assert.match(solar, /hasGenericOrbitRing\(spec\.name\)/, 'all planets must share the generic orbit-ring policy');
assert.match(solar, /group\.visible\s*=\s*false/, 'Halley must start hidden until its first valid sample');
const comet = solar.slice(...methodSpan(solar, '_buildHalleyComet() {'));
assert.doesNotMatch(comet, /PlaneGeometry|crossTail|tailGeometry/, 'legacy comet planes must not compete with the particle tail');
assert.equal((solar.match(/new DustTailRenderer\(/g) || []).length, 1, 'one particle renderer owns the visible tail');
assert.match(comet, /tail\.visible\s*=\s*false/, 'the compatibility direction object must not render');
// Planet count. An earlier revision matched /name:'[^']+'/g, which counted a quoting
// style rather than planets and broke the moment the table gained spaces after colons.
const planetTable = solar.slice(solar.indexOf('PLANET_TABLE'), solar.indexOf('];', solar.indexOf('PLANET_TABLE')));
assert.deepEqual([...planetTable.matchAll(/name\s*:\s*['"]([^'"]+)['"]/g)].map((match) => match[1]),
  ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']);

// Every planet, the Moon, and Halley must reach the same ephemeris update.
// Body spins stay in advanceOrbitalBodies; circular positions must not overwrite samples.
const planets = solar.slice(...methodSpan(solar, '_buildPlanets() {'));
assert.match(planets, /const list\s*=\s*PLANET_TABLE/);
assert.match(planets, /list\.forEach\(\(spec,\s*index\)\s*=>/);
assert.match(planets, /this\.ephemerisTargets\[spec\.name\.toLowerCase\(\)\]\s*=\s*mesh/);
assert.match(planets, /this\.ephemerisTargets\.halley\s*=\s*this\.halley\.group/);
assert.match(solar.slice(...methodSpan(solar, '_buildMoon() {')), /this\.ephemerisTargets\.moon\s*=\s*this\.moon/);
const advance = solar.slice(...methodSpan(solar, '_advanceBodies(dt) {'));
assert.match(advance, /advanceOrbitalBodies\(this\.bodies/);
assert.match(advance, /updateEphemerisTargets\(\{\s*simulationTime:\s*this\.simulationTime,\s*providers:\s*this\.ephemerides\.providers,\s*targets:\s*this\.ephemerisTargets,\s*statuses:\s*this\.ephemerisStatus\.targets/);
const runtime = readFileSync(new URL('../src/components/solar/SolarEphemerisRuntime.js', import.meta.url), 'utf8');
const update = runtime.slice(...methodSpan(runtime, 'updateEphemerisTargets('));
assert.match(update, /for\s*\(const \[name,\s*target\] of Object\.entries\(targets\)\)/);
assert.match(update, /providers\[name\]\.sample\(simulationTime\)/);
assert.match(update, /applyPosition\(target,\s*physicalPosition,\s*name,\s*sample\)/);
assert.match(runtime, /for\s*\(const body of bodies\)/);
assert.match(runtime, /body\.mesh\.rotation\.y\s*\+=\s*body\.spin\s*\*\s*dt/);
assert.match(runtime, /hasGenericOrbitRing\([^)]*\)\s*\{\s*return false;/);
assert.doesNotMatch(runtime, /body\.angle\s*\+=\s*body\.speed\s*\*\s*dt/);
assert.doesNotMatch(runtime, /orbitDisplayPosition\(body\.orbit,\s*body\.angle/);
assert.match(runtime, /z:\s*-Math\.sin\(angle\)/, 'retained display orbit helper must use the Mars-aligned negative-z sine');
assert.doesNotMatch(runtime, /body\.mesh\.position\.set\(/);

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
const dustRenderer = readFileSync(new URL('../src/components/solar/DustTailRenderer.js', import.meta.url), 'utf8');
assert.match(dustRenderer, /setDrawRange\(0, visibleCount\)/, 'the particle draw range owns the visible dust output');
assert.match(table, /modelUrl: '\/globe\/xinjian1-opt\.glb\?v=20260909'/); assert.match(table, /fallbackModelUrl: '\/globe\/xinjian1\.glb\?v=20260728'/);
assertLegacySunMoonRemoval({ files: readLegacySolarSources() });
assert.doesNotMatch(css, /\.starship-gltf-stage\s*\{[^}]*inset:\s*0/);
console.log('solar system home contract: ok');
