[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$ApiRoot,
  [Parameter(Mandatory=$true)][string]$AgentUuid,
  [Parameter(Mandatory=$true)][string]$AgentKey,
  [Parameter(Mandatory=$true)][string]$ServerId,
  [string]$SecretsFile = (Join-Path $PSScriptRoot "..\..\.env.windows"),
  [int]$Interval = 20,
  [switch]$StartContainers
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$agentDir = Join-Path $env:ProgramData 'VpsDashboardAgent'
$serviceName = 'VpsDashboardAgent'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker Desktop CLI is required.' }
docker version | Out-Null
if (-not (Test-Path $SecretsFile)) { throw "Secrets file not found: $SecretsFile" }
New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
$envFile = Join-Path $agentDir 'agent.env'
@("API_ROOT=$($ApiRoot.TrimEnd('/'))", "AGENT_UUID=$AgentUuid", "AGENT_KEY=$AgentKey", "SERVER_ID=$ServerId", "INTERVAL=$Interval", 'AGENT_VERSION=readonly-agent/1.1.0') | Set-Content -NoNewline:$false -Encoding utf8 $envFile
$acl = Get-Acl $envFile
$acl.SetAccessRuleProtection($true, $false)
foreach ($identity in @('BUILTIN\Administrators','NT AUTHORITY\SYSTEM')) { $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','Allow'))) }
Set-Acl -Path $envFile -AclObject $acl
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { throw 'Python 3.11+ is required for the Windows Master Agent.' }
& $python.Source -m pip install --upgrade pip | Out-Host
& $python.Source -m pip install -r (Join-Path $PSScriptRoot 'requirements-agent-windows.txt') | Out-Host
$svc = Join-Path $PSScriptRoot 'vps-agent-service.py'
if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { & $python.Source $svc stop; & $python.Source $svc remove }
& $python.Source $svc --startup auto install
& $python.Source $svc start
if ($StartContainers) { $env:VPS_DASHBOARD_SECRETS_FILE = (Resolve-Path $SecretsFile).Path
$watchtowerLine = Get-Content -LiteralPath $SecretsFile | Where-Object { $_ -match '^WATCHTOWER_HTTP_API_TOKEN=' } | Select-Object -Last 1
if (-not $watchtowerLine) { throw 'WATCHTOWER_HTTP_API_TOKEN is required in the secrets file.' }
$env:WATCHTOWER_HTTP_API_TOKEN = $watchtowerLine.Substring('WATCHTOWER_HTTP_API_TOKEN='.Length); docker compose -f (Join-Path $root 'docker-compose.yml') -f (Join-Path $root 'docker-compose.windows.yml') --profile production up -d }
Write-Host "Installed $serviceName. Status: $(Get-Service $serviceName | Select-Object -ExpandProperty Status)"
