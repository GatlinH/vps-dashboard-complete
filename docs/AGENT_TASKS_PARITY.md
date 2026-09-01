# Agent task parity

`scripts/check-agent-tasks-parity.py` verifies that the Unix and Windows
`agent_tasks.py` copies have identical SHA-256 content hashes. It prints both
hashes and exits non-zero on drift or missing files. The files remain separate
to preserve platform packaging behavior.
