# Known red: `test:unit` fails two cases on a clean checkout

Status: **open**
Opened: 2026-10-11
Found while: wiring the solar source-contract gates into Frontend CI (`b249305`)

## Why this file exists

`npm run test:unit` is **not** in `.github/workflows/frontend-ci.yml`, and the
reason currently lives only in `b249305`'s commit message. A reason recorded
only in a commit message is a reason that gets lost: the decision was explicitly
temporary, and a temporary exclusion with no owner behaves exactly like an
allowlist entry that outlives its justification — which is the thing
`eef4158` refused to do for `source-map-js`.

This document exists so the exclusion has to be closed deliberately rather than
forgotten. **Delete this file in the same commit that adds `test:unit` to CI.**

## The failure

On a clean checkout with a real `npm ci`:

```text
Test Files  1 failed | 23 passed (24)
     Tests  2 failed | 391 passed (393)

FAIL test/unit/solarHitClip.test.js
  > circular hit CSS contract > (a) applies a border-box circle(50%) to all three real button builders
  > circular hit CSS contract > (b) has a 24 by 24 CSS fallback matching runtime BOX=24

TypeError: Cannot read properties of undefined (reading 'parameters')
 ❯ src/components/SolarSystem.js:821  entry.mesh.geometry.parameters.radius
 ❯ SolarSystem._syncHitButtons  src/components/SolarSystem.js:820
 ❯ createHitFixture  test/helpers/solarHitFixture.js:152
 ❯ test/unit/solarHitClip.test.js:23
```

It is deterministic, not flaky.

## Root cause

`solarHitClip.test.js` is committed, and `749880d` committed the helper it
imports, so the module graph now loads. But the suite drives the real
`SolarSystem._syncHitButtons()`, and the committed `SolarSystem.js` at HEAD
still contains the pre-rework body that dereferences
`entry.mesh.geometry.parameters`. The matching ~400-line `SolarSystem.js`
rework is **uncommitted in-flight work belonging to another workstream**.

So the test and the implementation it tests are on opposite sides of the commit
boundary. Adding `test:unit` to CI today would bind `main` to code that is not
on the branch — a worse failure mode than the gate not running, because it is a
guaranteed red rather than a silent gap.

## Second, independent blocker

A clean checkout collects **24** test files while the worktree has **34**: ten
`test/unit/*.test.js` files are themselves untracked in-flight work.

```text
solarHitBoundary        solarHitBrowserProbe    solarHitContract
solarHitDOMPrecision    solarHitDesignDContract solarHitLayout
solarPauseRace          solarPrecisionContract  solarPrecisionEphemeris
solarRotationModel
```

Even with `solarHitClip` fixed, CI would be running a strict subset of what
developers run locally. That gap is invisible today precisely because
`test:unit` is not in CI.

Note for anyone reading `749880d`'s first draft: that commit message originally
implied committing the five helpers would take collection from 24 to 34. It does
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
  is allowed to fail is not a gate; the advisory pattern in `cf90ae3` is
  appropriate for an audit signal with a converging allowlist, not for a known
  deterministic failure.
- **Do not** skip or `.skip()` the two failing cases. They encode a real
  contract; silencing them loses the coverage that the rework is supposed to
  deliver.

## Related

- `b249305` — adds eight source-contract gates; records this exclusion
- `749880d` — commits the test helpers three suites already imported
- `eef4158` — the `source-map-js` pin, and the reasoning this file borrows
- `cf90ae3` — the advisory dev-audit gate, for contrast on when
  `continue-on-error` is legitimate
