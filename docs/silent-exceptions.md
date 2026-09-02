# Silent exception gate

The gate runs Ruff from the repository root with an absolute configuration and
fixed hardening flags:

```sh
python3 scripts/check-silent-exceptions.py
```

Equivalent scan flags are `--ignore-noqa --no-respect-gitignore --no-cache
--config <repo>/backend/ruff.toml`. Ruff must be version 0.16.5. CI ignores
`SILENT_EXC_RUFF`; local runs may use it for tests. The output includes the
resolved executable and version.

## Baseline

Version 4 stores a SHA-256 hash of `backend/ruff.toml`, the Ruff version, and independent buckets
for S110, S112 and BLE001. Each bucket has `total` and a `files` map whose sum
must match total. The gate does not provide a scan-coverage guarantee.
E722 and F821 remain zero-tolerance invariants. Old top-level `total`/`files`
baselines are rejected; migrate explicitly with:

```sh
python3 scripts/check-silent-exceptions.py --update-baseline --yes
```

Current buckets are S110=39, S112=3, BLE001=213. Per-file counts are monotonic
non-increasing: increases and new files fail;
decreases and deleted files pass with `progress` output. A same-file increase
and decrease that nets to zero is a known detection gap. Changes to
`backend/ruff.toml` likewise require updating its hash in the baseline. The
config cannot use an `extend = ...` directive because extended files are
outside the hash coverage. Zero-tolerance E722/F821 failures report relative
file paths and line numbers.

## Hardened bypasses

Noqa suppression, gitignore hiding, Ruff cache/config drift, syntax errors and
unknown diagnostic codes are blocked by the fixed scan and fatal validation.
CI cannot self-attest with `SILENT_EXC_RUFF`, and Ruff identity is version
checked. BLE001 is independently ratcheted, so moving an S110 finding into that
bucket cannot make the gate green.

Changing `except Exception: pass` to `except Exception: return None` reduces
S110 from 39 to 38 while BLE001 stays at 213; the gate passes and prints progress.
The exception is still broad, but no longer silently swallowed, so forcing an
invariant that BLE001 must also decrease would flag legitimate refactors. Review
pull requests where S110 decreases without a corresponding BLE001 decrease.

## Exit codes

`0` passes and prints `SILENT_EXC_GATE_OK`; `1` is a policy/ratchet failure;
`2` is an operational or incomplete-scan error; `3` means a human-approved
baseline update was written.

The Ruff exclude list still omits tests and other intentionally excluded trees;
those remain outside this gate's scope.

Before scanning the backend, a canary must trigger E722, F821, S110, S112 and
BLE001; missing coverage fails closed. The staleness valve fails when baseline
debt exceeds measured debt by more than 10 findings. Baseline writes require
both `--update-baseline --yes` and `SILENT_EXC_BASELINE_WRITE=1`, and are
forbidden when any CI marker (`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`,
`JENKINS_URL`, `BUILDKITE`, `TF_BUILD`) is set. Increases additionally require
`--allow-increase "reason"`, recorded in the baseline with previous totals.
