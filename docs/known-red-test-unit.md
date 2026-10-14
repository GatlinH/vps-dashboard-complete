# Known red: `test:unit` fails two cases on a clean checkout

Status: **open**
Owner: unassigned — assign before the next CI change to `frontend-ci.yml`
Opened: 2026-10-11
Review by: 2026-11-30
Found while: wiring the solar source-contract gates into Frontend CI

> References here are deliberately by path and by content, not by commit SHA.
> This file outlives any branch: a rebase or a squash merge rewrites every SHA
> in it, and a document whose whole job is to be actionable for whoever comes
> next cannot point at objects that no longer exist.

## Why this file exists

`npm run test:unit` is **not** in `.github/workflows/frontend-ci.yml`, and the
reason originally lived only in a commit message. A reason recorded only in a
commit message is a reason that gets lost: the decision was explicitly
temporary, and a temporary exclusion with no owner behaves like an allowlist
entry that outlives its justification — which is exactly what the
`source-map-js` entry in `frontend-vite/npm-audit-allowlist.json` was refused
for.

This document exists so the exclusion has to be closed deliberately rather than
forgotten. **Delete this file in the same commit that adds `test:unit` to CI.**
The invariant is machine-checkable and is enforced by the source-contract
gates: *if this file exists, `frontend-ci.yml` must not mention `test:unit`; if
it does not exist, `frontend-ci.yml` must mention it.* Whichever way it flips,
it flips in a commit someone reviews.

## The failure

On a clean checkout with a real `npm ci`:

```text
Test Files  1 failed | 23 passed (24)
     Tests  2 failed | 391 passed (393)

FAIL test/unit/solarHitClip.test.js
  > circular hit CSS contract > (a) applies a border-box circle(50%) to all three real button builders
  > circular hit CSS contract > (b) has a 24 by 24 CSS fallback matching runtime BOX=24
```

It is deterministic, not flaky.

## Root cause

`solarHitClip.test.js` is committed, and the commit that added the five
`test/helpers/` modules made its imports resolvable, so the module graph now
loads. But the suite drives the real `SolarSystem._syncHitButtons()`, and the
committed `SolarSystem.js` still contains the pre-rework body that dereferences

```text
entry.mesh.geometry.parameters.radius
```

Quote the expression, not a line number: the line moves with every edit, the
expression is what the rework has to change. The matching ~400-line
`SolarSystem.js` rework is **uncommitted in-flight work belonging to another
workstream**.

So the test and the implementation it exercises sit on opposite sides of the
commit boundary. Adding `test:unit` to CI today would bind `main` to code that
is not on the branch — a worse failure mode than the gate not running, because
it is a guaranteed red rather than a silent gap.

## Second, independent blocker

A clean checkout collects **24** test files while a developer worktree has
**34**: ten `test/unit/*.test.js` files are themselves untracked in-flight work.

```text
solarHitBoundary        solarHitBrowserProbe    solarHitContract
solarHitDOMPrecision    solarHitDesignDContract solarHitLayout
solarPauseRace          solarPrecisionContract  solarPrecisionEphemeris
solarRotationModel
```

Even with `solarHitClip` fixed, CI would run a strict subset of what developers
run locally. That gap is invisible today precisely because `test:unit` is not in
CI.

Note for anyone reading the commit that added the five test helpers: its first
draft implied that committing them would take collection from 24 to 34. It does
not — helpers are not test files. The ten untracked suites above are the actual
difference. The message was corrected; the misreading is recorded here because
it is an easy one to repeat.

## Closing conditions

Both must hold before `test:unit` goes into `frontend-ci.yml`:

1. The `SolarSystem.js` rework is committed (by its owner, not by whoever
   happens to be editing CI), and `solarHitClip.test.js` passes on a clean
   checkout.
2. The ten untracked suites are either committed or deliberately deleted, so
   that CI and local runs agree on the test set.

Then, in one commit: add the step, delete this file.

## Explicitly not the fix

- **Do not** commit the `SolarSystem.js` rework to unblock this. Those ~400
  lines have not been reviewed as part of any slice, and smuggling them in via a
  CI change would bypass review.
- **Do not** add `test:unit` with `continue-on-error: true`. A unit suite that
  is allowed to fail is not a gate; the advisory pattern used for the dev-audit
  step is appropriate for an audit signal with a converging allowlist, not for a
  known deterministic failure.
- **Do not** skip or `.skip()` the two failing cases. They encode a real
  contract; silencing them loses the coverage that the rework is supposed to
  deliver.

## Related

- the commit that adds the eight source-contract gates to `frontend-ci.yml` —
  records this exclusion
- the commit that adds the five `test/helpers/` modules — makes the suite's
  imports resolvable
- the `source-map-js` entry in `frontend-vite/npm-audit-allowlist.json` — the
  reasoning this file borrows
- the `Dev dependency audit (advisory)` step in `frontend-ci.yml` — for contrast
  on when `continue-on-error` is legitimate
