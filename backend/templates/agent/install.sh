#!/usr/bin/env bash
set -euo pipefail
API_ROOT=""; AGENT_UUID=""; AGENT_KEY=""; SERVER_ID=""; INSTALL_DIR="/opt/vps-agent"; SERVICE_NAME="vps-agent.service"; INTERVAL="20"
RELEASE_VERSION="__RELEASE_VERSION__"
PINNED_PUBLIC_KEY="__PINNED_PUBLIC_KEY__"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-root) API_ROOT="$2"; shift 2 ;;
    --auto-register) shift ;;
    --uuid) AGENT_UUID="$2"; shift 2 ;;
    --agent-key) AGENT_KEY="$2"; shift 2 ;;
    --server-id) SERVER_ID="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done
if [[ -z "$API_ROOT" || -z "$AGENT_UUID" || -z "$AGENT_KEY" || -z "$SERVER_ID" ]]; then echo "missing required Agent credentials" >&2; exit 1; fi
case "$API_ROOT" in http://*|https://*) ;; *) echo "Invalid --api-root" >&2; exit 1 ;; esac
if [[ ! "$SERVER_ID" =~ ^[0-9]+$ ]] || [[ ! "$INTERVAL" =~ ^[0-9]+$ ]] || (( INTERVAL < 10 || INTERVAL > 3600 )); then echo "invalid server-id or interval" >&2; exit 1; fi
if [[ -z "$RELEASE_VERSION" || -z "$PINNED_PUBLIC_KEY" ]]; then echo "missing configured signed Agent release" >&2; exit 1; fi
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required for signature verification" >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "sha256sum is required" >&2; exit 1; }
ARCH="$(uname -m)"
case "$ARCH" in x86_64|amd64) ASSET_ARCH=amd64 ;; aarch64|arm64) ASSET_ARCH=arm64 ;; *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;; esac
ASSET_NAME="vps-dashboard-agent-linux-$ASSET_ARCH"
BASE_URL="$API_ROOT/api/v1/agent/releases/$RELEASE_VERSION"
mkdir -p "$INSTALL_DIR"; umask 077
workdir="$(mktemp -d "$INSTALL_DIR/.release.XXXXXX")"
trap 'rm -rf "$workdir"' EXIT
curl --fail --silent --show-error --proto '=http,https' "$BASE_URL/manifest.json" -o "$workdir/manifest.json"
curl --fail --silent --show-error --proto '=http,https' "$BASE_URL/manifest.sig" -o "$workdir/manifest.sig"
printf '%s' "$PINNED_PUBLIC_KEY" | base64 -d > "$workdir/manifest.pub.der"
openssl pkey -pubin -inform DER -in "$workdir/manifest.pub.der" -out "$workdir/manifest.pub.pem" >/dev/null 2>&1
/usr/bin/python3 - "$workdir/manifest.json" "$workdir/manifest.canonical" "$RELEASE_VERSION" "$ASSET_NAME" > "$workdir/SHA256SUMS" <<'PY'
import json, re, sys
manifest_path, canonical_path, expected_version, asset_name = sys.argv[1:]
data = json.load(open(manifest_path, encoding='utf-8'))
open(canonical_path, 'wb').write(json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8'))
if data.get('version') != expected_version or not re.fullmatch(r'agent-v[0-9A-Za-z][0-9A-Za-z._-]{0,127}', expected_version):
    raise SystemExit('manifest version mismatch')
assets = data.get('assets')
if not isinstance(assets, list): raise SystemExit('manifest assets invalid')
matched = [a for a in assets if isinstance(a, dict) and a.get('name') == asset_name and a.get('platform') == 'linux' and a.get('arch') in {'amd64','arm64'}]
if len(matched) != 1 or not isinstance(matched[0].get('sha256'), str) or not re.fullmatch(r'[0-9a-f]{64}', matched[0]['sha256']):
    raise SystemExit('requested asset missing or invalid')
print(f"{matched[0]['sha256']}  {asset_name}")
PY
openssl pkeyutl -verify -pubin -inkey "$workdir/manifest.pub.pem" -rawin -in "$workdir/manifest.canonical" -sigfile "$workdir/manifest.sig" >/dev/null
curl --fail --silent --show-error --proto '=http,https' "$BASE_URL/$ASSET_NAME" -o "$workdir/$ASSET_NAME"
(cd "$workdir" && sha256sum --check SHA256SUMS)
tmp_asset="$workdir/$ASSET_NAME"
install -m 0700 "$tmp_asset" "$INSTALL_DIR/vps-dashboard-agent"
printf 'API_ROOT=%q\nAGENT_UUID=%q\nAGENT_KEY=%q\nSERVER_ID=%q\nINTERVAL=%q\n' "$API_ROOT" "$AGENT_UUID" "$AGENT_KEY" "$SERVER_ID" "$INTERVAL" > "$INSTALL_DIR/agent.env"
cat > "/etc/systemd/system/$SERVICE_NAME" <<EOF
[Unit]
Description=VPS Readonly Metrics Agent
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
EnvironmentFile=$INSTALL_DIR/agent.env
ExecStart=$INSTALL_DIR/vps-dashboard-agent
Restart=always
RestartSec=5
User=root
WorkingDirectory=$INSTALL_DIR
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
systemctl status "$SERVICE_NAME" --no-pager --full | sed -n "1,20p"
echo "installed signed release: $SERVICE_NAME ($RELEASE_VERSION)"
