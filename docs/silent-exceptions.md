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

Version 3 stores a SHA-256 hash of `backend/ruff.toml` and independent buckets
for S110, S112 and BLE001. Each bucket has `total` and a `files` map whose sum
must match total. The gate does not provide a scan-coverage guarantee.
E722 and F821 remain zero-tolerance invariants. Old top-level `total`/`files`
baselines are rejected; migrate explicitly with:

```sh
python3 scripts/check-silent-exceptions.py --update-baseline --yes
```

Current buckets are S110=39, S112=3, BLE001=213. Per-file counts and totals
must match the baseline exactly. Any increase, decrease, deleted entry, or new
file fails and requires an explicit baseline update, so improvements leave a
reviewed baseline diff instead of consuming hidden headroom. Changes to
`backend/ruff.toml` likewise require updating its hash in the baseline.

## Hardened bypasses

Noqa suppression, gitignore hiding, Ruff cache/config drift, syntax errors and
unknown diagnostic codes are blocked by the fixed scan and fatal validation.
CI cannot self-attest with `SILENT_EXC_RUFF`, and Ruff identity is version
checked. BLE001 is independently ratcheted, so moving an S110 finding into that
bucket cannot make the gate green.

One rewrite channel remains intentionally a review signal rather than an automated
failure: changing `except Exception: pass` to `except Exception: return None`
reduced S110 from 39 to 38 while BLE001 stayed at 213, and the gate returned 0.
The exception is still broad, but no longer silently swallowed, so forcing an
invariant that BLE001 must also decrease would flag legitimate refactors. Review
pull requests where S110 decreases without a corresponding BLE001 decrease.

## Exit codes

`0` passes and prints `SILENT_EXC_GATE_OK`; `1` is a policy/ratchet failure;
`2` is an operational or incomplete-scan error; `3` means a human-approved
baseline update was written.

The Ruff exclude list still omits tests and other intentionally excluded trees;
those remain outside this gate's scope.
