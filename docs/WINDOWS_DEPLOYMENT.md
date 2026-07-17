# Windows 部署

## 支持范围

- Docker Desktop（Linux containers）运行 Dashboard 容器。
- 原生 Windows Service `VpsDashboardAgent` 上报主机只读指标与 peer TCP probes。
- Linux `install.sh` / systemd / Watchtower 不在 Windows 上使用。

## 前置条件

以管理员权限安装 Docker Desktop、Git、Python 3.11+。Docker Desktop 必须处于 Linux containers 模式。将 secrets 文件放在例如 `C:\VpsDashboard\secrets.env`，格式与 `backend/.env.example` 相同，不能放入仓库。

## 安装

先从受控 Agent 注册流程取得 UUID、Key 与 Server ID。不要在共享 shell 历史中保留 Key；建议通过受保护的部署工具注入。以管理员 PowerShell 运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows\Install-VpsDashboard.ps1 -ApiRoot "http://127.0.0.1:5000" -AgentUuid "<agent-uuid>" -AgentKey "<agent-key>" -ServerId "<server-id>" -SecretsFile "C:\VpsDashboard\secrets.env" -StartContainers
```

Windows Compose override 使用 named volumes，避免 Linux `/etc`、`/var/log`、`/var/lib` bind mounts；Watchtower 不默认启动。Agent 密钥保存在 `%ProgramData%\VpsDashboardAgent\agent.env`，仅 SYSTEM 与 Administrators 可读取。

## 运维

```powershell
Get-Service VpsDashboardAgent
Restart-Service VpsDashboardAgent
.\scripts\windows\Update-VpsDashboard.ps1 -SecretsFile "C:\VpsDashboard\secrets.env"
```

Docker Desktop volume 包含数据；删除 volume 是破坏性操作。
