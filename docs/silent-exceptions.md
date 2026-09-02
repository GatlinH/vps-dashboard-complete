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

E722 is not part of the baseline. It must always be zero; any bare `except`
causes the gate to return 1. BLE001 is present in `ruff.toml`'s select list so
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
`requirements-dev.txt`. In CI for this repository, the executable is
`backend/.venv/bin/ruff`.

## Updating the baseline

Updating is manual only. It requires `--yes` or
`SILENT_EXC_BASELINE_WRITE=1`; CI (`CI` or `GITHUB_ACTIONS`) rejects updates.
On success the file is written and the command returns 3, so the run that
updates the baseline is intentionally red. For example:

```sh
python3 scripts/check-silent-exceptions.py --update-baseline --yes
```

## Known blind spots

The gate covers only S110 and S112. Patterns such as `except: return` with a
sentinel (`None`, `False`, `0`, `[]`, etc.) are outside those rules. Hermes'
precise AST scan found 109 silently swallowed exceptions in backend production
code: 83 `pass`, 10 `return False`, 9 `return None`, 5 `continue`, 4 empty
returns, and 4 other sentinel values. This gate therefore locks only the
pass/continue portion of that set.

The Ruff exclude list contains `tests`, so silent exceptions in test code are
not constrained. Anything placed under an excluded directory is likewise
uninspected.
