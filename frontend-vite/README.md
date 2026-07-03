# Frontend

`frontend-vite/` 是项目唯一前端源码目录，负责公开首页、VPS 详情页和管理员后台。

## 开发

```bash
cd frontend-vite
npm ci
npm run dev
```

默认开发服务：`http://localhost:5173`。开发环境下 `/api` 会代理到后端 API。

## 构建

```bash
npm run build
```

输出目录：`../frontend-dist/`。该目录是构建产物，默认不提交到 Git。

## 主要入口

| 文件 | 说明 |
|---|---|
| `index.html` | 公开首页/详情页入口 |
| `admin.html` | 管理后台入口 |
| `src/main.js` | 公开页面初始化 |
| `src/admin-main.js` | 后台初始化 |
| `src/api/` | API 客户端 |
| `src/components/` | 地球、星图、节点卡片、后台组件 |
| `src/styles/` | 主站和后台样式 |

## 发布前检查

```bash
npm run build
cd ..
python3 scripts/security-scan.py --include-dist
```

构建产物不得包含可复用的 token、secret、agent key 或密码。
