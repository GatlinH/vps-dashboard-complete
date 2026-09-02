# Agent task parity

`scripts/check-agent-tasks-parity.py` is a temporary gate requiring the two
`agent_tasks.py` copies to be completely identical. It hashes normalized UTF-8
text (CRLF becomes LF) so `.gitattributes` line endings do not create false drift.
Additional copies can be supplied with `--files`.

The durable direction is one shared module with platform shims, or generated copies
with checked-in generated-artifact validation.
