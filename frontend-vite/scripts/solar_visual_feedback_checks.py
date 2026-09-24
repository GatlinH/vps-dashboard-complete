"""DOM and live-scene regressions, run against the built frontend by the CDP suite."""

import json


async def check_visual_feedback(cdp, js, wait_for):
    ready = await wait_for(
        "window.__DBG__?.solarSystem?.dustTailManager && window.__DBG__.solarEphemeris.targets.halley.ok",
        "Halley body and dust worker initialization",
        timeout=25,
    )
    if not ready:
        print("FAIL: H - Halley body/dust pipeline did not initialize")
        return False

    await js("window.__DBG__.solarSystem.pause(); true")
    settled = await wait_for(
        "!window.__DBG__.solarSystem.dustTailManager.inFlight",
        "the last running dust job",
        timeout=25,
    )
    if not settled:
        print("FAIL: H - dust worker did not settle")
        return False

    await cdp("Emulation.setDeviceMetricsOverride", width=1280, height=900, deviceScaleFactor=1, mobile=False)
    desktop_before = await js("""(() => {
      const s = window.__DBG__.solarSystem; s.resize();
      const r = s.container.getBoundingClientRect();
      return { width: r.width, height: r.height };
    })()""")

    # Run one real frame with a deterministic delta, then cancel its next rAF.
    # This exercises SolarSystem's shared clock and tick wiring, not a parallel
    # browser-only implementation of the boundary policy.
    await js("""(() => {
      window.__solarFeedbackFrame = (time, dt) => {
        const s = window.__DBG__.solarSystem, getDelta = s.clock.getDelta;
        s.simulationTime = time;
        s.clock.getDelta = () => dt;
        s.orbitState.motionState = 'running';
        s.orbitState.isDragging = false;
        s.running = true;
        try { s._tick(); } finally { s.pause(); s.clock.getDelta = getDelta; }
        return {
          simulationTime: s.simulationTime,
          halleyVisible: s.halley.group.visible,
          halleyStatus: s.ephemerisStatus.targets.halley.ok,
          halleyJd: s.ephemerisStatus.targets.halley.lastJd,
          tailStatus: s.dustTailManager.status,
          drawRangeCount: s.dustTailRenderer.geometry.drawRange.count
        };
      };
      return true;
    })()""")

    good = True
    for width, height in ((390, 844), (480, 850), (1280, 900)):
        await cdp(
            "Emulation.setDeviceMetricsOverride",
            width=width, height=height, deviceScaleFactor=1, mobile=width <= 720,
        )
        await js("window.__DBG__.solarSystem.resize(); true")

        boundaries = []
        for label, time_expression, dt in (
            ("start", "s.ephemerides.range[0]", 0),
            ("end-epsilon", "s.ephemerides.range[1] - 0.001", 0),
            ("exact-end", "s.ephemerides.range[1]", 0),
            ("end-plus-dt", "s.ephemerides.range[1]", 0.025),
        ):
            immediate = await js(
                "(() => { const s = window.__DBG__.solarSystem; return window.__solarFeedbackFrame(%s, %s); })()"
                % (time_expression, dt)
            )
            settled = await wait_for(
                "!window.__DBG__.solarSystem.dustTailManager.inFlight && !window.__DBG__.solarSystem.dustTailManager.latestPending",
                "dust result at " + label,
                timeout=25,
            )
            final = await js("""(() => {
              const s = window.__DBG__.solarSystem;
              return {
                simulationTime: s.simulationTime,
                halleyVisible: s.halley.group.visible,
                halleyStatus: s.ephemerisStatus.targets.halley.ok,
                halleyJd: s.ephemerisStatus.targets.halley.lastJd,
                tailStatus: s.dustTailManager.status,
                drawRangeCount: s.dustTailRenderer.geometry.drawRange.count
              };
            })()""")
            boundaries.append({"boundary": label, "immediate": immediate, "settled": final})
            good &= settled and final["halleyVisible"] and final["halleyStatus"]
            good &= final["halleyJd"] == final["simulationTime"]
            good &= final["tailStatus"] == "ready" and final["drawRangeCount"] > 0
            if label in ("exact-end", "end-plus-dt"):
                good &= immediate["halleyVisible"] and immediate["halleyStatus"]
                good &= immediate["drawRangeCount"] > 0
                good &= immediate["tailStatus"] in ("ready", "computing")

        measurements = await js("""(() => {
          const s = window.__DBG__.solarSystem, host = s.container;
          const r = host.getBoundingClientRect(), c = s.canvas.getBoundingClientRect();
          const directional = [];
          s.halley.group.traverseVisible(o => {
            if ((o.isMesh && o !== s.halley.nucleus) || o.isPoints || o.isLine ||
                (o.isSprite && (o.scale.x !== o.scale.y || o.position.length() > 0))) directional.push(o.type);
          });
          const dust = s.dustTailRenderer;
          if (dust.points.parent && dust.points.visible && dust.geometry.drawRange.count > 0) directional.push(dust.points.type);
          const hits = s.hitButtons.filter(e => e.el.isConnected && getComputedStyle(e.el).visibility !== 'hidden').map(e => {
            const b = e.el.getBoundingClientRect(), p = e.mesh.getWorldPosition(e.mesh.position.clone()).project(s.camera);
            const x = c.left + (p.x * .5 + .5) * c.width, y = c.top + (-p.y * .5 + .5) * c.height;
            return { name: e.mesh.userData.bodyName, label: e.el.getAttribute('aria-label'),
              inside: b.left >= r.left - .5 && b.right <= r.right + .5 && b.top >= r.top - .5 && b.bottom <= r.bottom + .5,
              offset: Math.hypot(b.left + b.width / 2 - x, b.top + b.height / 2 - y) };
          });
          return {
            viewportMarker: host.matches('[data-solar-viewport]') ? 'data-solar-viewport' : null,
            hostId: host.id, canvasParentMatches: s.canvas.parentElement === host,
            innerWidth, innerHeight, containerWidth: r.width, containerHeight: r.height,
            canvasWidth: c.width, canvasHeight: c.height, bufferWidth: s.canvas.width, bufferHeight: s.canvas.height,
            pixelRatio: s.renderer.getPixelRatio(), measuredRatio: r.width / r.height,
            cameraAspect: s.camera.aspect, bodyOverflow: document.body.scrollWidth - innerWidth,
            directionalTailCount: directional.length, directionalTailTypes: directional,
            drawRangeCount: dust.geometry.drawRange.count, visibleParticleCount: dust.visibleCount,
            halleyVisible: s.halley.group.visible, halleyStatus: s.ephemerisStatus.targets.halley,
            simulationTime: s.simulationTime, range: s.ephemerides.range,
            tailStatus: s.dustTailManager.status, tailDisplayTime: s.dustTailManager.displayTObs, hits
          };
        })()""")
        measurements["boundaries"] = boundaries
        if width == 1280:
            measurements["desktopBeforeMobileResize"] = desktop_before
            good &= abs(measurements["containerWidth"] - desktop_before["width"]) <= 0.5
            good &= abs(measurements["containerHeight"] - desktop_before["height"]) <= 0.5
        if width <= 720:
            # Content after the solar panel must stay in document flow and be
            # reachable by scrolling; a landscape-sized/clipped page fails this.
            scroll_probe = await js("""(() => {
              const probe = document.createElement('div'), end = document.createElement('button');
              probe.style.cssText = `height:${innerHeight + 100}px;position:relative`;
              end.style.cssText = 'position:absolute;bottom:0;left:0';
              end.textContent = 'Scroll reachability probe';
              probe.appendChild(end); document.getElementById('pageRoot').appendChild(probe);
              end.scrollIntoView({block:'end', behavior:'instant'});
              const r = end.getBoundingClientRect();
              const overflowY = [document.documentElement, document.body].map(el => getComputedStyle(el).overflowY);
              // Scrolling rounds to CSS pixels; the 16:9 box keeps fractions.
              const reachable = r.top >= -.5 && r.bottom <= innerHeight + .5 && scrollY > 0 &&
                overflowY.every(value => value !== 'hidden' && value !== 'clip');
              const result = {reachable, top:r.top, bottom:r.bottom, scrollY, overflowY};
              probe.remove(); window.scrollTo({top:0, left:0, behavior:'instant'});
              return result;
            })()""")
            measurements["pageContentReachable"] = scroll_probe["reachable"]
            measurements["pageScrollProbe"] = scroll_probe
            good &= measurements["pageContentReachable"]
        print("VISUAL_FEEDBACK " + json.dumps(measurements, ensure_ascii=False))
        good &= measurements["viewportMarker"] == "data-solar-viewport"
        good &= measurements["canvasParentMatches"] and measurements["bodyOverflow"] <= 0
        good &= abs(measurements["canvasWidth"] - measurements["containerWidth"]) <= 0.5
        good &= abs(measurements["canvasHeight"] - measurements["containerHeight"]) <= 0.5
        good &= abs(measurements["bufferWidth"] - measurements["canvasWidth"] * measurements["pixelRatio"]) <= 1
        good &= abs(measurements["bufferHeight"] - measurements["canvasHeight"] * measurements["pixelRatio"]) <= 1
        good &= measurements["directionalTailCount"] == 1
        good &= measurements["directionalTailTypes"] == ["Points"]
        good &= measurements["drawRangeCount"] == measurements["visibleParticleCount"] > 0
        good &= measurements["range"][0] <= measurements["simulationTime"] < measurements["range"][1]
        good &= abs(measurements["simulationTime"] - (measurements["range"][0] + 0.3)) < 1e-8
        if width <= 720:
            good &= abs(measurements["measuredRatio"] - 16 / 9) < 0.005
            good &= abs(measurements["cameraAspect"] - 16 / 9) < 0.005
            good &= measurements["innerHeight"] > measurements["innerWidth"]
        good &= len(measurements["hits"]) >= 2
        good &= all(hit["inside"] and hit["offset"] <= 16.5 for hit in measurements["hits"])

    await js("delete window.__solarFeedbackFrame; window.__DBG__.solarSystem.resume(); true")
    print("PASS: H - solar viewport, single dust output and synchronized boundaries" if good else
          "FAIL: H - solar visual feedback measurements violate the viewport/tail/boundary contract")
    return bool(good)
