import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const MAIN = readFileSync(new URL('../src/modules/serverTable.js', import.meta.url), 'utf8');

test('network timeline is never replaced by selected-range history', () => {
  // First paint and heavy refresh both hydrate network rows from the aggregate
  // history payload, then preserve that dedicated cache during redraws.
  assert.match(MAIN, /const networkRows = aggregate\.networkRows;/);
  assert.match(MAIN, /if \(networkRows\.length\) detailCache\.networkRows = networkRows;/);
  assert.match(MAIN, /const networkRows = detailCache\.networkRows \|\| \[\];/);
  assert.match(MAIN, /networkProbeRows: networkRows,/);
  assert.doesNotMatch(MAIN, /networkProbeRows: probeRows,/);
  assert.doesNotMatch(MAIN, /networkUseProbe/);
  assert.doesNotMatch(MAIN, /probeUpSeries/);
});

test('network data remains part of the single aggregate request contract', () => {
  assert.equal((MAIN.match(/getServerDetail\(/g) || []).length, 2);
  assert.doesNotMatch(MAIN, /fetchNetworkTimeline\(/);
});
