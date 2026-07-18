import assert from 'node:assert/strict';
import { normalizePublicServer, groupClusterMembers } from '../src/services/serverGroups.js';

const canonical = normalizePublicServer({ id: 1, group: 'legacy', tags: ['wrong'], note: 'wrong note', group_info: { name: 'Tokyo', purpose: 'Low latency', color: '#0088FF' } });
assert.equal(canonical.group, 'Tokyo');
assert.equal(canonical.groupPurpose, 'Low latency');
assert.equal(canonical.groupColor, '#0088FF');
const tree = groupClusterMembers([canonical, normalizePublicServer({ id: 2, group: 'Tokyo', group_info: { name: 'Tokyo', purpose: 'Low latency', color: '#0088FF' } })]);
assert.deepEqual(tree.map(({ name, purpose, members }) => [name, purpose, members.length]), [['Tokyo', 'Low latency', 2]]);
assert.equal(normalizePublicServer({ id: 3, group: 'legacy', tags: ['Fallback'] }).groupPurpose, 'Fallback');
console.log('server group domain regression checks passed');
