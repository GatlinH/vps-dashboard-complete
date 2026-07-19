import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

assert.match(source, /const PING_AXIS_STEPS_MS\s*=\s*\[\s*0\s*,\s*20\s*,\s*50\s*,\s*100\s*,\s*200\s*,\s*300\s*,\s*400\s*,\s*500\s*\];/);
assert.match(source, /function pingStepValue\(ms\)\s*\{[\s\S]*?const steps = PING_AXIS_STEPS_MS;/);
assert.match(source, /function pingStepLabel\(pos\)\s*\{[\s\S]*?PING_AXIS_STEPS_MS\.length[\s\S]*?PING_AXIS_STEPS_MS\[idx\]/);
assert.match(source, /renderDetailMonitorCharts\(args\)\s*\{[\s\S]*?pingStepLabel,[\s\S]*?PING_AXIS_STEPS_MS,/);

console.log('PING_AXIS_WIRING_VERIFIED declaration=true renderer-dependency=true');
