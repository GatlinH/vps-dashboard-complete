# Silent exception gate

Ruff is configured in `backend/ruff.toml` for Python 3.11. The repository-root
`scripts/check-silent-exceptions.py` anchors paths independently of the current
working directory and uses `.github/quality/silent-exception-baseline.json` as
a ratchet.

## Counting scope

The baseline numbers are the count of **S110 plus S112** findings returned by
running this command from `backend/`:

```sh
cd backend && .venv/bin/ruff check --output-format json .
```

That command passes no `--select` or `--exclude`; it fully inherits
`backend/ruff.toml` (including its `lint.select` and `exclude` settings). The
gate uses exactly this scan and then counts only S110 and S112 in its JSON
result. Do not compare the baseline directly with a command that adds
`--select`: `--select` overrides `ruff.toml`'s `lint.select`, and adding
`--exclude` changes the scanned set as well, so the numbers will necessarily
differ.

E722 and F821 are not part of the baseline. Both must always be zero; any bare
`except` or undefined name causes the gate to return 1, with file and line
reported for F821. BLE001 is present in `ruff.toml`'s select list so
developers can inspect it locally, but it is not included in the baseline gate.
The current count is 213 (Hermes measurement); this batch does not remediate
it and there is no gate/ratchet protecting that count.

## Exit codes

- `0`: passed; prints `SILENT_EXC_GATE_OK`.
- `1`: gate failure (including E722 or a ratchet violation).
- `2`: operational error (for example, unusable Ruff or baseline).
- `3`: baseline was updated. This is an explicit human action and is expected
  to be red in CI.

## Ruff executable resolution

Before scanning, the script probes `ruff --version` and resolves an executable
in this order:

1. `SILENT_EXC_RUFF` (when set);
2. `backend/.venv/bin/ruff`;
3. `ruff` found on `PATH`;
4. the current interpreter with `-m ruff`.

If none is usable, it returns 2 and asks for `ruff==0.16.5` from
`requirements-dev.txt`. In CI, `backend/.venv` is not present; resolution
falls through to the Ruff installed on `PATH` from `requirements-dev.txt`.

## Updating the baseline

Updating is manual only. It requires `--yes` or
`SILENT_EXC_BASELINE_WRITE=1`; CI (`CI` or `GITHUB_ACTIONS`) rejects updates.
On success the file is written and the command returns 3, so the run that
updates the baseline is intentionally red. For example:

```sh
python3 scripts/check-silent-exceptions.py --update-baseline --yes
```

## Known blind spots

These are measured bypasses in the current gate, with concrete remediation planned:

1. `# noqa` suppression is not disabled because the scan does not pass
   `--ignore-noqa`. For example, `except Exception:  # noqa: S110, BLE001` produces
   zero diagnostics, so a one-line comment can erase any debt from the gate.
2. Ruff respects `.gitignore` and does not scan ignored, untracked paths. Adding a
   debt-bearing file path to `.gitignore` makes every diagnostic in that file vanish,
   lowers the count, and can make the gate pass.
3. A syntax-error file is treated as clean by the counter. Ruff 0.16.5 reports
   `invalid-syntax`, but the counting loop only recognizes E722/F821/S110/S112 and
   silently drops that diagnostic. Making `backend/api/servers.py` syntactically
   invalid removed its five S110 findings, dropping the total from 42 to 37 and
   passing the ratchet.
4. `SILENT_EXC_RUFF` can self-attest. It is the first executable candidate, CI does
   not ignore it, and only a successful `--version` exit code is checked. A shell
   stub can print `ruff 0.16.5`, replay fabricated baseline S110 records during
   `check`, and return 0 with `SILENT_EXC_GATE_OK`; pull requests can inject this
   variable through their branch workflow.
5. The metric is misaligned: BLE001 is selected in `ruff.toml` but excluded from the
   ratchet. `except Exception:` with logging or `return None` yields only BLE001,
   while `pass` yields S110 plus BLE001. Rewriting `except: pass` to
   `except: return None` lowers the S110 count and passes while the defect remains,
   so the 62-to-42 reduction cannot currently distinguish remediation from moving
   debt into the BLE001 bucket.

Next-batch hardening: add `--ignore-noqa`, `--respect-gitignore=false`, an explicit
`--config`, and `--no-cache`; validate Ruff identity and version (and ignore
`SILENT_EXC_RUFF` in CI); treat unknown diagnostic codes and nonzero Ruff exits as
fatal; include BLE001 in bucketed ratchets; and reconcile orphaned baseline entries.

The gate ratchet covers only S110 and S112. Patterns such as `except: return` with a
sentinel (`None`, `False`, `0`, `[]`, etc.) are outside those rules. Hermes'
precise AST scan found 109 silently swallowed exceptions in backend production
code: 83 `pass`, 10 `return False`, 9 `return None`, 5 `continue`, 4 empty
returns, and 4 other sentinel values. This gate therefore locks only the
pass/continue portion of that set.

The Ruff exclude list contains `tests`, so silent exceptions in test code are
not constrained. Anything placed under an excluded directory is likewise
uninspected.
