# 001: Single Renderer Feasibility Spike

## Question
Can the homepage move toward one Three.js renderer/canvas for earth + starship + bussard animation, instead of multiple stacked canvases?

## Prototype
Temporary page: `/spike-single-renderer.html`

Implemented a standalone single renderer scene with:
- one WebGLRenderer / one canvas
- lightweight earth proxy
- current optimized `star_trek_dsc_enterprise_user.glb`
- GLTF AnimationMixer for `bussard_right` / `bussard_left`
- shared render loop and HUD stats

## Evidence
- Prototype canvas count: 1
- Prototype GLB loaded: true
- Prototype GLB loadMs: 1910 in browser probe
- Prototype mixer advanced: 1.70 -> 2.00 in 3s sample
- Prototype renderer info: 215 draw calls, 818,827 triangles, 189 geometries, 26 textures
- Current homepage canvas count: 4
- Current homepage still uses star effects canvas + globe canvas + starship canvas

## Verdict: VALIDATED
Core approach is feasible: earth + starship + GLB animation can share a single Three.js renderer/canvas.

## Caveats
- The prototype uses an earth proxy, not the full production ThreeGlobe labels/nodes/raycasting.
- Automated browser rAF is throttled, so reported FPS is not reliable for real-user FPS.
- A production migration needs staged porting of labels, VPS picking, sun/moon UI, and detail-page isolation.

## Recommendation
Proceed only as staged refactor:
1. Extract ThreeGlobe scene construction into reusable methods.
2. Add starship group to the same scene behind a feature flag/query param.
3. Remove independent StarshipShowcase renderer only after parity checks.
4. Keep rollback path to current multi-canvas homepage.
