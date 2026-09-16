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

export function hasGenericOrbitRing(name) {
  return name !== 'Mars';
}

export function orbitDisplayPosition(radius, angle, xFactor = 1) {
  return { x: Math.cos(angle) * radius * xFactor, z: -Math.sin(angle) * radius * xFactor };
}

export function advanceOrbitalBodies(bodies, dt, earthCloudMesh = null) {
  for (const body of bodies) {
    if (body.name !== 'Mars') {
      body.angle += body.speed * dt;
      if (body.orbit > 0) {
        const { x, z } = orbitDisplayPosition(body.orbit, body.angle, body.xFactor != null ? body.xFactor : 1);
        if (body.parent) {
          body.mesh.position.set(
            body.parent.mesh.position.x + x,
            body.parent.mesh.position.y + (body.yFactor ? Math.sin(body.angle) * body.orbit * body.yFactor : 0),
            body.parent.mesh.position.z + z
          );
        } else {
          body.mesh.position.set(x, 0, z);
        }
      }
    }
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
  for (const name of ['mars', 'halley']) {
    let sample;
    try {
      sample = providers[name].sample(simulationTime);
    } catch (error) {
      sample = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!sample.ok) {
      failTarget(targets[name], statuses[name], simulationTime, sample.error || 'sample_failed');
      continue;
    }
    try {
      const physicalPosition = components(sample.position);
      applyPosition(targets[name], sample.position, name, sample);
      let tailDirection = null;
      if (name === 'halley') {
        const distanceAu = Math.hypot(...sample.position);
        tailDirection = antiSolarDisplayDirection(sample.position);
        applyTail(targets[name], {
          direction: tailDirection,
          distanceAu,
          length: Math.max(0.5, Math.min(15, Math.max(2, 16 * (1.2 / distanceAu))))
        });
      }
      targets[name].visible = true;
      statuses[name].ok = true;
      statuses[name].error = null;
      statuses[name].lastJd = simulationTime;
      statuses[name].lastPhysicalPosition = physicalPosition;
      statuses[name].lastTailDirection = tailDirection;
    } catch (error) {
      failTarget(targets[name], statuses[name], simulationTime, error);
    }
  }
}
