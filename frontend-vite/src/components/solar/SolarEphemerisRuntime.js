const components = (value) => [value.x ?? value[0], value.y ?? value[1], value.z ?? value[2]];

export function advanceSimulationTime(simulationTime, dt, daysPerSecond, range) {
  const [start, end] = range;
  const span = end - start;
  if (!(span > 0)) return start;
  const next = simulationTime + Math.max(0, dt) * daysPerSecond;
  return start + (((next - start) % span) + span) % span;
}

export function antiSolarDisplayDirection(cometPhysical, sunPhysical = [0, 0, 0]) {
  const comet = components(cometPhysical);
  const sun = components(sunPhysical);
  const dx = comet[0] - sun[0], dy = comet[1] - sun[1], dz = comet[2] - sun[2];
  const length = Math.hypot(dx, dy, dz);
  if (!length) return { x: 1, y: 0, z: 0 };
  return { x: dx / length, y: dz / length, z: -dy / length };
}

export function updateEphemerisTargets({ simulationTime, providers, targets, statuses, applyPosition, applyTail }) {
  for (const name of ['mars', 'halley']) {
    let sample;
    try {
      sample = providers[name].sample(simulationTime);
    } catch (error) {
      sample = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!sample.ok) {
      targets[name].visible = false;
      statuses[name].ok = false;
      statuses[name].error = sample.error || 'sample_failed';
      statuses[name].lastJd = simulationTime;
      statuses[name].lastPhysicalPosition = null;
      statuses[name].lastTailDirection = null;
      continue;
    }
    targets[name].visible = true;
    statuses[name].ok = true;
    statuses[name].error = null;
    statuses[name].lastJd = simulationTime;
    statuses[name].lastPhysicalPosition = components(sample.position);
    applyPosition(targets[name], sample.position, name, sample);
    if (name === 'halley') {
      const distanceAu = Math.hypot(...sample.position);
      const direction = antiSolarDisplayDirection(sample.position);
      statuses[name].lastTailDirection = direction;
      applyTail(targets[name], {
        direction,
        distanceAu,
        length: Math.max(0.5, Math.min(15, Math.max(2, 16 * (1.2 / distanceAu))))
      });
    } else {
      statuses[name].lastTailDirection = null;
    }
  }
}
