# Solar visual feedback

The visible Halley tail is the Finson–Probstein particle output of
`DustTailManager` and `DustTailRenderer`. Its one `THREE.Points` object renders
only the geometry's draw range (four nonzero-beta bands per valid release).
The nucleus and centered circular flame remain. The old planes are removed;
`halley.tail` is an invisible `Object3D` without geometry or material, retained
only for the anti-solar reference axis in `getP1RuntimeSnapshot()`. That snapshot's
legacy direction fields describe the reference axis, not the curved dust tail.

The animation clock uses the common published range **[start, end)**.
`advanceSimulationTime` normalizes once, including frames with a zero delta;
`SolarSystem` then gives that time to body sampling and the dust manager.
For the current range `[2446078.5, 2446643.5)`, exact end becomes `2446078.5`,
and end plus 0.3 days becomes `2446078.8`. End minus epsilon remains before end.
The ephemeris providers themselves accept the **closed** published range, so
the dust manager's 0.1-day quantization may sample the actual end node for a
valid frame just before end. Raw out-of-range or non-finite manager inputs
are rejected before quantization; they are never wrapped or clamped to data.

A wrap invalidates old worker generations and cached observation times.
Before the next render, the manager samples the normalized epoch and writes
one zero-age release into the same particle renderer using a spare pooled
buffer. At zero age all beta bands coincide with the sampled nucleus: this
uses a valid physical boundary state and invents no earlier history. The
worker later replaces it with the computed releases available since range
start. Late pre-wrap results cannot replace this preview. Diagnostics expose
`previewTObs` while it is displayed and `displayTObs` after worker acceptance.
Failed body samples, invalid dust states and worker failures still fail closed.

Only `#solar-system-container[data-solar-viewport]` gets the mobile 16:9 content
box at widths up to 720px. The canvas fills that box, the camera uses its
fractional dimensions, and the drawing buffer follows at the renderer's pixel
ratio. The container remains in document flow without page rotation or clipping.
The canvas retains its original intrinsic 2:1 desktop aspect when no ancestor
sets a height, so a mobile resize cannot change the desktop layout by changing
the canvas backing-store aspect. Explicit desktop container heights still win.

Regression tests run the real scene builder, frame update, providers, manager,
renderer and worker computation, with delayed transferable-buffer delivery.
They cover all four boundary cases, an in-flight result across a wrap, paused
boundary seeks, fail-closed samples and mobile content-box sizing.
`npm run test:solar-system-behavior` also measures the built frontend in Chromium
at 390px, 480px and 1280px, including the single tail output and immediate/settled
wrap states. `--visual-feedback-only` on its Python script runs just these checks.
