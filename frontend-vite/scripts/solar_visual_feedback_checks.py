"""DOM and live-scene regressions, run against the built frontend by the CDP suite."""

import json
import math


async def check_visual_feedback(cdp, js, wait_for, portrait_layout_only=False):
    if portrait_layout_only:
        print("LEGACY_SCIENCE_NOT_RUN: portrait layout only, actual current-real-time production frames; A-G and legacy boundary experiments/guards skipped")
    ready = await wait_for(
        "window.__DBG__?.solarSystem?.dustTailManager && window.__DBG__.solarEphemeris.targets.halley.ok",
        "Halley body and dust worker initialization",
        timeout=25,
    )
    if not ready:
        print("FAIL: H - Halley body/dust pipeline did not initialize")
        return False

    live = await wait_for("""(() => {
      const s = window.__DBG__?.solarSystem, canvas = s?.canvas;
      return location.protocol === 'http:' && location.pathname === '/' &&
        document.readyState === 'complete' && document.visibilityState === 'visible' &&
        s?.running && s.container?.isConnected && canvas instanceof HTMLCanvasElement &&
        canvas.isConnected && canvas.parentElement === s.container &&
        document.querySelector('[data-solar-viewport] > canvas') === canvas &&
        document.body?.isConnected && document.body.getBoundingClientRect().width > 0 &&
        document.body.getBoundingClientRect().height > 0 && s.scene.children.length > 0 && s.bodies.length > 0 &&
        s.renderer.info.render.frame > 0;
    })()""", "visible home with a connected, rendering solar canvas", timeout=25)
    if not live:
        print("FAIL: H - live visible home/canvas prerequisites missing")
        return False
    navigation = await cdp("Page.getNavigationHistory")
    initial = await js("({url: location.href, frame: window.__DBG__.solarSystem.renderer.info.render.frame})")
    print("VISUAL_FEEDBACK_LIVE " + json.dumps(initial))
    if initial["url"] != navigation["entries"][navigation["currentIndex"]]["url"]:
        print("FAIL: H - document URL differs from the actual browser navigation")
        return False
    progressed = await wait_for(
        "window.__DBG__.solarSystem.renderer.info.render.frame > %s" % initial["frame"],
        "native render frame progression", timeout=25,
    )
    if not progressed:
        print("FAIL: H - renderer frames did not progress")
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
      const frameBefore = s.renderer.info.render.frame;
      if (%s) {
        s.running = true;
        try { s._tick(); } finally { s.pause(); }
      }
      const r = s.container.getBoundingClientRect();
      return { width: r.width, height: r.height, frameBefore, frameAfter: s.renderer.info.render.frame };
    })()""" % json.dumps(portrait_layout_only))
    if portrait_layout_only:
        print("PORTRAIT_LAYOUT_DESKTOP_BASELINE " + json.dumps(desktop_before))
        if not (desktop_before["frameAfter"] > desktop_before["frameBefore"] > 0 and
                desktop_before["width"] > 0 and desktop_before["height"] > 0):
            print("FAIL: H - desktop baseline production frame did not advance after resize")
            return False

    if not portrait_layout_only:
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
          drawRangeCount: s.dustTailRenderer.geometry.drawRange.count,
          bodies: Object.fromEntries(Object.entries(s.ephemerisStatus.targets).map(([name, state]) =>
            [name, {ok: state.ok, jd: state.lastJd, position: state.lastPhysicalPosition}]))
        };
      };
      return true;
        })()""")

    good = True
    for width, height, device_dpr in (
        (390, 844, 1), (390, 600, 1), (360, 500, 1), (720, 800, 1),
        (480, 850, 1), (390, 844, 3), (844, 390, 3), (390, 844, 3), (1280, 900, 1),
    ):
        mobile = width <= 720 or (width == 844 and height == 390)
        portrait = width <= 720 and height >= width
        await cdp(
            "Emulation.setDeviceMetricsOverride",
            width=width, height=height, deviceScaleFactor=device_dpr, mobile=mobile,
        )
        await cdp("Emulation.setTouchEmulationEnabled", enabled=mobile)
        native_window = await js("""({width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
          portrait: matchMedia('(orientation: portrait)').matches,
          coarse: matchMedia('(pointer: coarse)').matches, hoverNone: matchMedia('(hover: none)').matches})""")
        print("VISUAL_FEEDBACK_WINDOW " + json.dumps(native_window))
        if (native_window["width"] != width or native_window["height"] != height or
                native_window["dpr"] != device_dpr or native_window["portrait"] != (height >= width) or
                (mobile and not (native_window["coarse"] and native_window["hoverNone"]))):
            print("FAIL: H - native window/DPR/input emulation mismatch")
            return False
        resized = await js("""(() => {
          const s = window.__DBG__.solarSystem, canvas = s?.canvas;
          if (!s || !s.container.isConnected || !(canvas instanceof HTMLCanvasElement) ||
              !canvas.isConnected || canvas.parentElement !== s.container) return false;
          s.resize();
          return true;
        })()""")
        if not resized:
            print("FAIL: H - live canvas missing before the actual resize call")
            return False

        boundaries = []
        production_frame = None
        if portrait_layout_only:
            production_frame = await js("""(() => {
              const s = window.__DBG__.solarSystem, frameBefore = s.renderer.info.render.frame;
              s.running = true;
              try { s._tick(); } finally { s.pause(); }
              return {frameBefore, frameAfter: s.renderer.info.render.frame,
                simulationTime: s.simulationTime, sampleUtcMs: s.timeSample.utcMs,
                actualUtcMs: Date.now(), bodyCount: s.bodies.length, sceneChildren: s.scene.children.length};
            })()""")
            print("PORTRAIT_LAYOUT_PRODUCTION_FRAME " + json.dumps(production_frame))
            if not (production_frame["frameAfter"] > production_frame["frameBefore"] > 0 and
                    production_frame["bodyCount"] > 0 and production_frame["sceneChildren"] > 0):
                print("FAIL: H - production frame did not advance after actual resize")
                return False
            settled = await wait_for(
                "!window.__DBG__.solarSystem.dustTailManager.inFlight && !window.__DBG__.solarSystem.dustTailManager.latestPending",
                "dust result at actual current real time", timeout=25,
            )
            if not settled:
                print("FAIL: H - current-real-time dust result did not settle")
                return False
        for label, time_expression, dt in (() if portrait_layout_only else (
            ("start", "s.ephemerides.range[0]", 0),
            ("end-epsilon", "s.ephemerides.range[1] - 0.001", 0),
            ("exact-end", "s.ephemerides.range[1]", 0),
            ("end-plus-dt", "s.ephemerides.range[1]", 0.025),
        )):
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
                drawRangeCount: s.dustTailRenderer.geometry.drawRange.count,
                bodies: Object.fromEntries(Object.entries(s.ephemerisStatus.targets).map(([name, state]) =>
                  [name, {ok: state.ok, jd: state.lastJd, position: state.lastPhysicalPosition}]))
              };
            })()""")
            boundaries.append({"boundary": label, "immediate": immediate, "settled": final})
            good &= settled and final["halleyVisible"] and final["halleyStatus"]
            good &= final["halleyJd"] == final["simulationTime"]
            good &= final["tailStatus"] == "ready" and final["drawRangeCount"] > 0
            good &= all(body["ok"] and body["jd"] == final["simulationTime"] and
                        len(body["position"] or []) == 3 for body in final["bodies"].values())
            if label in ("exact-end", "end-plus-dt"):
                good &= immediate["halleyVisible"] and immediate["halleyStatus"]
                good &= immediate["drawRangeCount"] > 0
                good &= immediate["tailStatus"] in ("ready", "computing")

        measurements = await js("""(() => {
          const s = window.__DBG__.solarSystem, host = s.container;
          const r = host.getBoundingClientRect(), c = s.canvas.getBoundingClientRect();
          const nav = s.timeControls.element, panel = nav.getBoundingClientRect(), style = getComputedStyle(nav);
          const parentStyle = getComputedStyle(host.parentElement);
          const availableWidth = host.parentElement.clientWidth - parseFloat(parentStyle.paddingLeft) - parseFloat(parentStyle.paddingRight);
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
            return { name: e.mesh.name, label: e.el.getAttribute('aria-label'),
              blockedByTimeControls: nav.contains(document.elementFromPoint(x, y)),
              inside: b.left >= r.left - .5 && b.right <= r.right + .5 && b.top >= r.top - .5 && b.bottom <= r.bottom + .5,
              offset: Math.hypot(b.left + b.width / 2 - x, b.top + b.height / 2 - y) };
          });
          return {
            viewportMarker: host.matches('[data-solar-viewport]') ? 'data-solar-viewport' : null,
            hostId: host.id, canvasParentMatches: s.canvas.parentElement === host,
            canvasConnected: s.canvas.isConnected && host.isConnected, availableWidth,
            isMobile: s.isMobile, deviceDpr: devicePixelRatio,
            landscape: host.getAttribute('data-solar-mobile-landscape'),
            visualViewport: {width: visualViewport.width, height: visualViewport.height,
              left: visualViewport.offsetLeft, top: visualViewport.offsetTop},
            containerLeft: r.left, containerTop: r.top,
            timeControls: {connected: nav.isConnected && nav.parentElement === host,
              top: style.top, left: style.left, bottom: style.bottom, transform: style.transform,
              centeredOffset: Math.abs(panel.left + panel.width / 2 - (r.left + r.width / 2)),
              inside: panel.left >= r.left - .5 && panel.right <= r.right + .5 &&
                panel.top >= r.top - .5 && panel.bottom <= r.bottom + .5},
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
        if portrait_layout_only:
            measurements["scope"] = "portrait-layout-only; LEGACY_SCIENCE_NOT_RUN"
            measurements["productionFrame"] = production_frame
        if width == 1280:
            measurements["desktopBeforeMobileResize"] = desktop_before
            good &= abs(measurements["containerWidth"] - desktop_before["width"]) <= 0.5
            good &= abs(measurements["containerHeight"] - desktop_before["height"]) <= 0.5
        if portrait:
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
              // Scrolling rounds to CSS pixels; the 9:16 box keeps fractions.
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
        good &= measurements["canvasConnected"] and measurements["canvasWidth"] > 0 and measurements["canvasHeight"] > 0
        good &= measurements["containerWidth"] > 0 and measurements["containerHeight"] > 0
        good &= measurements["isMobile"] == mobile
        good &= measurements["pixelRatio"] == min(measurements["deviceDpr"], 1.5 if mobile else 2)
        good &= abs(measurements["cameraAspect"] - measurements["measuredRatio"]) < 0.005
        good &= abs(measurements["canvasWidth"] - measurements["containerWidth"]) <= 0.5
        good &= abs(measurements["canvasHeight"] - measurements["containerHeight"]) <= 0.5
        good &= abs(measurements["bufferWidth"] - measurements["canvasWidth"] * measurements["pixelRatio"]) <= 1
        good &= abs(measurements["bufferHeight"] - measurements["canvasHeight"] * measurements["pixelRatio"]) <= 1
        good &= abs(measurements["bufferWidth"] - math.floor(measurements["containerWidth"] * measurements["pixelRatio"])) <= 1
        good &= abs(measurements["bufferHeight"] - math.floor(measurements["containerHeight"] * measurements["pixelRatio"])) <= 1
        good &= measurements["directionalTailCount"] == 1
        good &= measurements["directionalTailTypes"] == ["Points"]
        good &= measurements["drawRangeCount"] == measurements["visibleParticleCount"] > 0
        if not portrait_layout_only:
            good &= measurements["simulationTime"] > measurements["range"][1]
            good &= abs(measurements["simulationTime"] - (measurements["range"][1] + 0.3)) < 1e-8
        panel = measurements["timeControls"]
        good &= panel["connected"]
        if portrait:
            good &= abs(measurements["measuredRatio"] - 9 / 16) < 0.005
            good &= abs(measurements["containerWidth"] - min(measurements["availableWidth"], height * 9 / 16)) <= 0.5
            good &= measurements["containerHeight"] <= height + 0.5
            good &= measurements["innerHeight"] > measurements["innerWidth"]
            good &= measurements["landscape"] == "false"
            good &= panel["bottom"] == "12px" and panel["centeredOffset"] <= 0.5 and panel["inside"]
            good &= any(str(hit["name"]).lower() == "earth" for hit in measurements["hits"])
            good &= all(not hit["blockedByTimeControls"] for hit in measurements["hits"])
        else:
            good &= panel["top"] == "12px" and panel["left"] == "12px" and panel["transform"] == "none"
        if mobile and not portrait:
            viewport = measurements["visualViewport"]
            good &= measurements["landscape"] == "true"
            good &= abs(measurements["containerWidth"] - viewport["width"]) <= 0.5
            good &= abs(measurements["containerHeight"] - viewport["height"]) <= 0.5
            good &= abs(measurements["containerLeft"] - viewport["left"]) <= 0.5
            good &= abs(measurements["containerTop"] - viewport["top"]) <= 0.5
        good &= len(measurements["hits"]) >= 2
        good &= all(hit["name"] in ("Sun", "Earth", "Moon") for hit in measurements["hits"])
        good &= all(hit["inside"] and hit["offset"] <= 16.5 for hit in measurements["hits"])

    await js("delete window.__solarFeedbackFrame; window.__DBG__.solarSystem.resume(); true")
    if portrait_layout_only:
        print("PASS: H - current-real-time portrait layout only; LEGACY_SCIENCE_NOT_RUN" if good else
              "FAIL: H - current-real-time portrait layout contract; LEGACY_SCIENCE_NOT_RUN")
    else:
        print("PASS: H - solar viewport, single dust output and synchronized boundaries" if good else
              "FAIL: H - solar visual feedback measurements violate the viewport/tail/boundary contract")
    return bool(good)
