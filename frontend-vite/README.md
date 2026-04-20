# VPS 星图前端 · Vite 版本

当前仓库已完成前端迁移：`frontend-vite/` 是唯一前端源码目录，生产部署使用 `frontend-dist/` 构建产物。

## 快速开始

```bash
cd frontend-vite
npm ci
npm run dev
```

- 开发地址：`http://localhost:5173`
- `/api` 自动代理到 `http://localhost:5000`

## 生产构建

```bash
npm run build
# 输出目录：../frontend-dist/
```

构建完成后，Nginx 通过 `backend/docker-compose.yml` 中的挂载读取 `frontend-dist/`。

## 目录结构

```text
frontend-vite/
├── index.html
├── admin.html
├── src/
│   ├── main.js
│   ├── admin-main.js
│   ├── api/
│   ├── components/
│   ├── styles/
│   └── utils/
├── public/
├── package.json
└── vite.config.js
```

## 验证清单（删除 legacy frontend 后）

- [x] CI 不再读取 `frontend/` 目录
- [x] 部署流程改为远程执行 `frontend-vite` 构建
- [x] Nginx 挂载目录为 `frontend-dist/`
- [x] 仓库文档已更新为 Vite 单前端路径
