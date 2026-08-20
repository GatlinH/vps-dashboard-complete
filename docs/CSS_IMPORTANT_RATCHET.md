# CSS priority ratchet

The frontend gate counts literal `!important` tokens in CSS below
`frontend-vite/src` and compares each file with the reviewed baseline in
`frontend-vite/css-important-baseline.json`. The check permits removals and
deleted files, but rejects total increases, per-file increases, and tokens in
new CSS files that are absent from the baseline.

Run the gate with `npm run check:css-important` from `frontend-vite`. Update the
baseline only in a reviewed change that explains why the count changed.

`admin-legacy-overrides.css` is a frozen historical cascade. Do not add rules to
it or create another override sheet. When touching an affected area, migrate
stable declarations into the owning component stylesheet. Prefer explicit
component boundaries and CSS layers so normal cascade order can replace
specificity escalation, then lower the baseline in the same change.
