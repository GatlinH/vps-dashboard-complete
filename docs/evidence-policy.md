# Evidence policy

Verification evidence — screenshots, metric dumps, raw gate logs — is **not
committed to this repository**. This file records that decision and the
measurement behind it, so the next person weighing "should I just commit the
screenshots?" has the numbers rather than the instinct.

## The rule

| artifact | where it goes |
| --- | --- |
| screenshots, captured PNG/JPEG frames | never committed; CI artifact, or discarded after review |
| raw gate stdout/stderr, `events.jsonl` | never committed; paste the relevant excerpt into the PR or commit message |
| metric dumps (`metrics.json`) that nothing reads | never committed; quote the handful of numbers that carried the argument |
| test **fixtures** that code reads at runtime | committed, under `frontend-vite/test/fixtures/`, with their generator and their provenance — see below |

The distinction is not size, it is **whether anything reads the file**. A
fixture is an input to a test. Evidence is an output of a review that has
already concluded. Evidence earns its value when a human reads it during
review; committing it keeps paying storage for value already collected.

## What this is based on

The solar-system work on `ci/solar-gates-and-vitest5` (PR #266) accumulated an
`evidence/` directory alongside the code: 24 tracked files, and across the 41
commits on that branch

```
47 distinct blobs under evidence/, 26.20 MB
```

Of that, **25.9 MB — 98.8% — is three screenshots**: `baseline.png`,
`no_map.png` and `second_pass.png`, each ~1.44 MB, each committed **six
times**, once per "refresh evidence" commit. Every copy has a distinct blob
hash, because each run re-rendered the frame, so git cannot deduplicate them:

```
baseline.png      6 distinct blobs   8.63 MB
no_map.png        6 distinct blobs   8.62 MB
second_pass.png   6 distinct blobs   8.63 MB
metrics.json      7 distinct blobs   0.11 MB
events.jsonl      6 distinct blobs   0.01 MB
```

Six re-renders of the same three screenshots is not an accident of this
branch; it is what happens by default. Any gate that writes an image, in any
workflow that re-runs the gate, produces the same pattern.

### Nothing reads them

`frontend-vite/scripts/verify-solar-legibility.py` writes all four artifacts
unconditionally once an evidence directory is set:

```python
(ed / "metrics.json").write_text(json.dumps(report, indent=2))
(ed / "baseline.png").write_bytes(baseline_png)
(ed / "no_map.png").write_bytes(nomap_png)
(ed / "second_pass.png").write_bytes(second_png)
```

Those four lines are the *only* occurrences of those filenames in the
repository. Nothing reads them back — the `baseline_png` referenced elsewhere
in that script is an in-memory capture, not the committed file.

The script also excludes `evidence/` from its own provenance dirty-check:

```python
# Evidence lives inside the repo; writing it must not trip the dirty guard, so
# any path under this top-level directory is excluded from the provenance diff
EVIDENCE_EXCLUDE_PREFIX = "evidence/"
```

That exclusion is the tell. The gate had to be taught to ignore its own output
in order to keep working, which means the output was never an input to
anything.

### Why it has to be decided before merge, not after

Deleting a file in a later commit does not shrink history. Removing committed
blobs requires rewriting history with `git filter-repo` and every collaborator
re-cloning. Until then, every clone, every CI checkout and every fork pays the
full cost forever. This is a one-way door, which is why it belongs in a
decision record rather than in a reviewer's judgement call at the bottom of a
large PR.

## What to do instead

1. **Keep evidence out of the branch.** The evidence directory is already
   opt-in: `verify-solar-legibility.py` only writes it when `--evidence` or
   `SOLAR_LEGIBILITY_EVIDENCE` is given, and both default to unset. Point them
   outside the working tree, or at an ignored path.
2. **Put the argument in the PR, not the artifact.** A reviewer reads
   `A5_pass2 mercury radius 3.85 pixels 24 floor 23.5` and the exit code. They
   do not open a 1.4 MB screenshot. If a number carried the argument, quote the
   number.
3. **If an image genuinely must be shareable**, upload it as a CI artifact —
   `actions/upload-artifact` is already configured in `frontend-ci.yml` with
   `retention-days: 7` — or attach it to the PR comment, which stores it
   outside the git object database.
4. **If the team later decides images must be retained long-term**, land that
   decision as its own small PR amending this file, naming the storage
   mechanism (LFS or external). Do not establish it as a side effect of a large
   feature branch.

## Fixtures are different, and have their own requirement

A file that code reads is a fixture, belongs in the repository, and must be
accounted for. `frontend-vite/test/fixtures/p3-holdout.json` is the instructive
case rather than a clean counter-example.

It is 1.85 MB — 8 targets × 1051 states — and its size is load-bearing, not
sloppiness: `frontend-vite/test/unit/solarP1.test.js:42` reads it and checks
every in-range epoch against the published ephemeris (relative error ≤ 1e-4,
direction ≤ 0.05°), asserting `epoch_count === 1051` per target. Shrinking it
is a change to what the test proves, not a cleanup.

It also carries real provenance inside the JSON: `source` (`NASA/JPL Horizons
API`), the `coordinate_contract` (ICRF, ecliptic of J2000.0, TDB, AU), and per
target a `target_command` Horizons body id, a `jd_range`, an `epoch_count` and
three `source_sha256` hashes of the raw dumps.

What is missing is reproducibility. `build-p3-holdout-fixture.mjs:17` defaults
its input to `evidence/P3-horizons-holdout-manifest.json`, which is not tracked
and is not present in the working tree. The committed hashes let you verify a
dump you already have; they do not let you obtain one. So the fixture's
integrity is checkable while its regeneration is not.

A committed fixture must therefore arrive with:

- its generator, in the repository;
- the generating command, and the identity (hash or version) of every input;
- **either** the input committed, **or** a documented way to re-fetch it — for
  `p3-holdout.json` that means recording the Horizons query itself (body ids,
  epoch range, step, center, reference frame), which is what actually
  reconstitutes the dump;
- a size justified by what it has to prove, with the justification written
  down, so a later reader can tell a load-bearing 1.85 MB from an unexamined
  one.

If an input genuinely cannot be committed, say so explicitly and name the input
and its version, so the gap is visible rather than implicit.

## Enforcement

None of this is machine-enforced today, and the honest reason is that the
existing `evidence/` content predates the policy and still sits on the branch
that introduced it. `main` tracks nothing under `evidence/`; PR #266 tracks 24
files there.

Once that branch is cleaned, the cheap guard is an `evidence/` line in
`.gitignore` plus a source-contract check that fails when `git ls-files`
returns any path under `evidence/`.

Do **not** write that check as a ban on tracked `*.png`. `main` tracks 42 PNG
files, all of them under `frontend-vite/public/`, and they are product assets
the application serves. The predicate has to be the evidence location, not the
file extension.

Until that check exists, this file is the record, and reviewers should treat an
`evidence/` path appearing in a diff as something to question.
