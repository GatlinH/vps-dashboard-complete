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

export function hasGenericOrbitRing() {
  return false;
}

export function orbitDisplayPosition(radius, angle, xFactor = 1) {
  return { x: Math.cos(angle) * radius * xFactor, z: -Math.sin(angle) * radius * xFactor };
}

export function advanceOrbitalBodies(bodies, dt, earthCloudMesh = null) {
  for (const body of bodies) {
    body.mesh.rotation.y += body.spin * dt;
    if (body.name === 'Earth' && earthCloudMesh) earthCloudMesh.rotation.y += body.spin * 1.18 * dt;
  }
}

function failTarget(target, status, simulationTime, error) {
  target.visible = false;
  status.ok = false;
  status.error = error instanceof Error ? error.message : String(error || 'sample_failed');
  status.lastJd = simulationTime;
  status.lastPhysicalPosition = null;
  status.lastTailDirection = null;
}

export function updateEphemerisTargets({ simulationTime, providers, targets, statuses, applyPosition, applyTail }) {
  for (const [name, target] of Object.entries(targets)) {
    const status = statuses[name];
    try {
      const sample = providers[name].sample(simulationTime);
      if (!sample?.ok) {
        failTarget(target, status, simulationTime, sample?.error);
        continue;
      }
      let physicalPosition = components(sample.position);
      if (name === 'moon') {
        const earthSample = providers.earth.sample(simulationTime);
        if (!earthSample?.ok) {
          failTarget(target, status, simulationTime, earthSample?.error);
          continue;
        }
        const earthPosition = components(earthSample.position);
        physicalPosition = physicalPosition.map((value, axis) => value - earthPosition[axis]);
      }
      applyPosition(target, physicalPosition, name, sample);
      let tailDirection = null;
      if (name === 'halley') {
        const distanceAu = Math.hypot(...sample.position);
        tailDirection = antiSolarDisplayDirection(sample.position);
        applyTail(target, {
          direction: tailDirection,
          distanceAu,
          length: Math.max(0.5, Math.min(15, Math.max(2, 16 * (1.2 / distanceAu))))
        });
      }
      target.visible = true;
      status.ok = true;
      status.error = null;
      status.lastJd = simulationTime;
      status.lastPhysicalPosition = physicalPosition;
      status.lastTailDirection = tailDirection;
    } catch (error) {
      failTarget(target, status, simulationTime, error);
    }
  }
}
