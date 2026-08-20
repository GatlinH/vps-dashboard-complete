import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/modules/serverTable.js', import.meta.url), 'utf8');

test('initial and heavy detail paths use the aggregate client without compatibility promises', () => {
  assert.equal((source.match(/getServerDetail\(/g) || []).length, 2);
  assert.doesNotMatch(source, /resourceHistoryPromise|processHistoryPromise|externalPingPromise|peerPingPromise/);
  assert.doesNotMatch(source, /Promise\.allSettled\(\[\s*getServerDetail[\s\S]*fetchPingTargets/);
});

test('aggregate hydration and loading cleanup are explicit', () => {
  assert.match(source, /normalizeDetailAggregate\(\s*\n?\s*detailPayload/);
  assert.match(source, /finally \{\s*detailGrid\.querySelectorAll\('\.fleet-chart-card\.chart-loading'\)/);
});
