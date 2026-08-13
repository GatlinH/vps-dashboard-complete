import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const MAIN = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

test('network timeline is never replaced by selected-range history', () => {
  // First paint: selected range must not outrank dedicated 6h network rows.
  assert.match(MAIN, /const upSeries = trafficUpSeries;\s*\n\s*const downSeries = trafficDownSeries;/);
  // Range refresh must commit the dedicated response into its own cache and
  // preserve that cache rather than constructing a probe/history fallback.
  assert.match(MAIN, /if \(returnedNetworkRows\.length\) detailCache\.networkRows = returnedNetworkRows;/);
  assert.match(MAIN, /const networkRows = detailCache\.networkRows \|\| \[\];/);
  assert.match(MAIN, /networkProbeRows: networkRows,/);
  assert.doesNotMatch(MAIN, /networkProbeRows: probeRows,/);
});

test('network endpoint remains a fixed 6-hour bounded contract', () => {
  assert.match(MAIN, /fetchNetworkTimeline\(current\.id\)/);
  assert.match(MAIN, /fetchNetworkTimeline\(resolvedServer\.id\)/);
});
