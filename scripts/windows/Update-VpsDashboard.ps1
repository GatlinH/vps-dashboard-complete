[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SecretsFile)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not (Test-Path $SecretsFile)) { throw "Secrets file not found: $SecretsFile" }
Set-Location $root
git pull --ff-only
$python = Get-Command python -ErrorAction Stop
& $python.Source -m pip install -r (Join-Path $PSScriptRoot 'requirements-agent-windows.txt') | Out-Host
$env:VPS_DASHBOARD_SECRETS_FILE = (Resolve-Path $SecretsFile).Path
$watchtowerLine = Get-Content -LiteralPath $SecretsFile | Where-Object { $_ -match '^WATCHTOWER_HTTP_API_TOKEN=' } | Select-Object -Last 1
if (-not $watchtowerLine) { throw 'WATCHTOWER_HTTP_API_TOKEN is required in the secrets file.' }
$env:WATCHTOWER_HTTP_API_TOKEN = $watchtowerLine.Substring('WATCHTOWER_HTTP_API_TOKEN='.Length)
docker compose -f docker-compose.yml -f docker-compose.windows.yml --profile production pull
docker compose -f docker-compose.yml -f docker-compose.windows.yml --profile production up -d --no-build
Restart-Service -Name VpsDashboardAgent
