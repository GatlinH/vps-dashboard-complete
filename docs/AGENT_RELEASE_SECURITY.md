# Native Agent Release Trust Model

Agent artifacts are built per target (`linux-amd64`, `linux-arm64`, `windows-amd64`). A release includes:

- `SHA256SUMS`: artifact digest list;
- `manifest.json`: canonical version/platform/architecture/hash binding;
- `manifest.sig`: Ed25519 signature for the exact manifest bytes;
- `manifest.pub`: public key. Its value must match `scripts/release/agent-release-ed25519-public.b64` before trusting a release.

The private key exists only as GitHub Actions secret `AGENT_RELEASE_ED25519_PRIVATE_KEY`. It is never committed, packaged, printed, or placed on a monitored node.

Installers must verify public-key identity, manifest signature, requested platform/architecture asset mapping, then SHA-256 before replacing an agent. A failed verification keeps the current agent unchanged. The current task protocol deliberately does **not** expose a self-update task; release adoption remains an explicit administrator action until rollback and installer integration are independently tested.
