export const ALL_REGIONS = Object.freeze({ kind: 'all' });
export const UNGROUPED_REGION = Object.freeze({ kind: 'ungrouped' });

export function isValidRegion(value) {
  if (typeof value !== 'string' || /[\r\n]/u.test(value)) return false;
  let characterCount = 0;
  let byteCount = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint >= 0xD800 && codePoint <= 0xDFFF) return false;
    characterCount += 1;
    byteCount += codePoint <= 0x7F ? 1 : codePoint <= 0x7FF ? 2 : codePoint <= 0xFFFF ? 3 : 4;
    if (characterCount > 32 || byteCount > 128) return false;
  }
  return true;
}

export function normalizeRegion(value) {
  return isValidRegion(value) ? value : '';
}

export function isExternalPingTarget(target) {
  return target !== null && typeof target === 'object' && !Array.isArray(target)
    && target.type !== 'peer'
    && !(typeof target.key === 'string' && target.key.startsWith('vps-'));
}

export function listTargetRegions(targets) {
  if (!Array.isArray(targets)) return [];
  const groups = new Map();
  for (const target of targets) {
    if (!isExternalPingTarget(target)) continue;
    const region = normalizeRegion(target.region);
    const group = groups.get(region);
    if (group) group.target_count += 1;
    else groups.set(region, { region, ungrouped: region === '', target_count: 1 });
  }
  return [...groups.values()];
}

function normalizeSelection(selection) {
  if (selection?.kind === 'ungrouped') return UNGROUPED_REGION;
  if (selection?.kind === 'region' && selection.region !== '' && isValidRegion(selection.region)) {
    return { kind: 'region', region: selection.region };
  }
  return ALL_REGIONS;
}

export function filterRegionalTargets(targets, selection = ALL_REGIONS) {
  if (!Array.isArray(targets)) return [];
  const normalized = normalizeSelection(selection);
  return targets.filter((target) => {
    if (!isExternalPingTarget(target)) return false;
    if (normalized.kind === 'all') return true;
    const region = normalizeRegion(target.region);
    return normalized.kind === 'ungrouped' ? region === '' : region === normalized.region;
  });
}

export function encodeRegionSelection(selection) {
  const normalized = normalizeSelection(selection);
  return normalized.kind === 'region'
    ? `region:${encodeURIComponent(normalized.region)}`
    : normalized.kind;
}

export function decodeRegionSelection(value) {
  if (value === 'ungrouped') return UNGROUPED_REGION;
  if (typeof value !== 'string' || !value.startsWith('region:')) return ALL_REGIONS;
  try {
    return normalizeSelection({ kind: 'region', region: decodeURIComponent(value.slice(7)) });
  } catch {
    return ALL_REGIONS;
  }
}

export function restoreRegionSelection(selection, targets) {
  const normalized = normalizeSelection(selection);
  if (normalized.kind === 'region'
    && !listTargetRegions(targets).some((group) => group.region === normalized.region)) {
    return ALL_REGIONS;
  }
  return normalized;
}

export function regionSelectionQuery(selection = ALL_REGIONS) {
  const query = new URLSearchParams();
  const normalized = normalizeSelection(selection);
  if (normalized.kind === 'ungrouped') query.set('ungrouped', '1');
  else if (normalized.kind === 'region') query.set('region', normalized.region);
  return query;
}
