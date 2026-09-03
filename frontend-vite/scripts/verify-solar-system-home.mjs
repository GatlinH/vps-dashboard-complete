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
assert.match(constructorBlock, /this\._tick\s*=\s*this\._tick\.bind\(this\)/);
assert.doesNotMatch(resumeBlock, /this\._tick\s*=\s*this\._tick\.bind\(this\)/);
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
assert.match(solar, /getBodySnapshot/);
assert.match(table, /modelUrl: '\/globe\/xinjian1\.glb\?v=20260728'/); assert.match(table, /fallbackModelUrl: ''/);
assert.match(entry, /export function renderSunBadge/); assert.match(entry, /export function renderMoonPanel/);
assert.doesNotMatch(css, /\.starship-gltf-stage\s*\{[^}]*inset:\s*0/);
console.log('solar system home contract: ok');
