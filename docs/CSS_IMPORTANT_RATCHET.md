# CSS priority ratchet

The frontend gate counts literal `!important` tokens in CSS below
`frontend-vite/src` and compares each file with the reviewed baseline in
`frontend-vite/css-important-baseline.json`. The check permits removals and
deleted files, but rejects total increases, per-file increases, and tokens in
new CSS files that are absent from the baseline.

Run the gate with `npm run check:css-important` from `frontend-vite`. Update the
baseline only in a reviewed change that explains why the count changed.

The repository-wide maintenance measurement is `scripts/check-css-debt.py`.
It scans `frontend-vite/src/**/*.css` (excluding any `node_modules` or `dist`
path), counts physical lines using `splitlines()`, and counts literal
`!important` occurrences using `!\s*important` (case-insensitive). This conservative
count includes comments and cannot cover `!/*comment*/important`; review remains the
backstop. Its JSON output is deterministic and the ratchet compares total and per-file
occurrence counts; decreases are allowed. `physical_lines` is informational only.
Use `python3 scripts/check-css-debt.py --update-baseline --yes` for a reviewed,
human-only baseline update (or set `CSS_BASELINE_WRITE=1`). Updates are refused in
CI, refused for an empty scan, and deliberately return exit code 3 so the updating
run can never be green. CI never updates baselines automatically. Orphan baseline
files are errors by default; `--no-strict` is the explicit relaxation.

Exit codes are: 0 pass (and a fixed success marker is printed), 1 gate failure,
2 operational error (also a failure), and 3 baseline updated (manual action).
The parser rejects abbreviated options; use `--update-baseline` rather than old
short aliases.

`admin-legacy-overrides.css` is a frozen historical cascade. Do not add rules to
it or create another override sheet. When touching an affected area, migrate
stable declarations into the owning component stylesheet. Prefer explicit
component boundaries and CSS layers so normal cascade order can replace
specificity escalation, then lower the baseline in the same change.
