# Backend

`backend/` 是 Flask API 服务，负责认证、服务器资产、指标历史、探针、Telegram 告警、站点设置、审计和后台运维接口。

## 依赖

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

依赖源文件：

- `requirements.in`：人工维护的直接依赖
- `requirements.txt`：锁定版本

更新依赖时使用：

```bash
pip install pip-tools
pip-compile requirements.in -o requirements.txt
```

## 本地运行

```bash
cp .env.example .env
# 编辑 .env，填入数据库、Redis 和 JWT/SECRET_KEY
flask run
```

默认 API：`http://localhost:5000`。

## Docker

项目根目录执行：

```bash
docker compose up -d --build
```

生产环境中 API 应只绑定本机或容器内网，不应直接暴露公网。

## 安全边界

- 管理接口、备份接口、Telegram 配置和用户管理必须鉴权。
- Public API 只能返回展示安全字段。
- Agent 使用 UUID/key/HMAC/nonce 等机制鉴权，密钥不应写入 URL。
- 数据库、Redis、真实 `.env`、allowlist 和备份不入库。

## 测试

```bash
pytest
```

发布前建议在项目根目录运行：

```bash
python3 scripts/security-scan.py
```
