# Agent task parity

`scripts/check-agent-tasks-parity.py` is a temporary gate requiring the two
`agent_tasks.py` copies to be completely identical. It hashes normalized UTF-8
text (CRLF becomes LF) so `.gitattributes` line endings do not create false drift.
Additional copies can be supplied with `--files`.

Exit codes: `0` means all supplied files match and the `AGENT_PARITY_GATE_OK`
marker is printed; `1` means a real content or inode mismatch; `2` means an
operational or usage error (including duplicate paths, fewer than two paths,
unreadable/non-UTF-8 files, or mixed positional/`--files` arguments).

The durable direction is one shared module with platform shims, or generated copies
with checked-in generated-artifact validation.
