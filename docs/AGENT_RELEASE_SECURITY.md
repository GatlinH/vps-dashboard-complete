# Native Agent Release Trust Model

Agent artifacts are built per target (`linux-amd64`, `linux-arm64`, `windows-amd64`). A release includes:

- `SHA256SUMS`: artifact digest list;
- `manifest.json`: canonical version/platform/architecture/hash binding;
- `manifest.sig`: Ed25519 signature for the exact manifest bytes;
- `manifest.pub`: public key. Its value must match `scripts/release/agent-release-ed25519-public.b64` before trusting a release.

The private key exists only as GitHub Actions secret `AGENT_RELEASE_ED25519_PRIVATE_KEY`. It is never committed, packaged, printed, or placed on a monitored node.

Installers embed the public-key identity from the image/source file `agent-release-ed25519-public.b64`; they **must not** download or trust `manifest.pub` from the same origin as the artifacts. They verify the canonical manifest signature, configured immutable release version, requested Linux platform/architecture asset mapping, then SHA-256 before atomically replacing the executable. A failed verification keeps the current executable unchanged.

## Serving a release

The dashboard does not manufacture releases and starts fail-closed: `install.sh` exits before any replacement unless the operator explicitly supplies all three settings:

```dotenv
AGENT_RELEASE_HOST_DIR=/srv/vps-agent-releases     # host directory, read-only mounted
AGENT_RELEASE_DIR=/opt/vps-agent-releases          # container path
AGENT_RELEASE_VERSION=agent-v1.2.3                 # one published signed version
```

The host directory must contain exactly the published release subdirectory, e.g. `/srv/vps-agent-releases/agent-v1.2.3/{manifest.json,manifest.sig,vps-dashboard-agent-linux-amd64,...}`. Compose mounts it read-only. The API serves only the configured version and an allowlist of manifest/signature/Linux assets at `/api/v1/agent/releases/<version>/…`; changing the URL cannot select another release or arbitrary file.

The current task protocol deliberately does **not** expose a self-update task; release adoption remains an explicit administrator action.
