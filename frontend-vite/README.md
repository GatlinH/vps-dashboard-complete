# VPS 星图前端 · Vite 版本

> 现有 `frontend/` 目录的模块化改造骨架，与现有部署**并存**，不影响现有功能。

## 目录结构

```
frontend-vite/
├── package.json          # Vite + 相关依赖
├── vite.config.js        # 构建配置（代理 /api → localhost:5000）
├── index.html            # 入口 HTML
├── src/
│   ├── main.js           # JS 入口（渐进式替换 public.html 内联逻辑）
│   ├── api/
│   │   ├── public.js     # 从 frontend/api-public.js 迁移（ES Module 格式）
│   │   └── admin.js      # 从 frontend/api-admin.js 迁移（ES Module 格式）
│   ├── utils/
│   │   ├── logger.js     # 从 frontend/logger.js 迁移
│   │   └── storage.js    # 从 frontend/secure-storage.js 迁移
│   └── styles/
│       └── main.css      # 公共 CSS 变量和 reset
└── public/               # 静态资源（图标等）
```

## 快速开始

### 本地开发服务器

```bash
cd frontend-vite
npm install
npm run dev
# 开发服务器运行在 http://localhost:5173
# API 请求自动代理到 http://localhost:5000
```

### 构建生产包

```bash
npm run build
# 构建产物输出到 ../frontend-dist/
```

### 预览构建产物

```bash
npm run preview
```

## 迁移路线图

当前版本为**骨架阶段**，API 模块已迁移。完整迁移的后续步骤：

### 阶段一：组件化（2-3天）

1. 将 `frontend/public.html`（137KB）中的 `<style>` 提取到 `src/styles/`
2. 将内联 JS 逻辑拆分为 `src/components/` 下的模块：
   - `ServerCard.js` - 服务器卡片
   - `StarMap.js` - 3D 星图（Three.js 懒加载）
   - `TrafficChart.js` - 流量图表（Chart.js 懒加载）
3. 在 `vite.config.js` 中配置代码分割，将 Three.js / Chart.js 拆到独立 chunk

### 阶段二：管理后台迁移（2-3天）

1. 新增 `admin.html` 入口
2. 将 `frontend/admin.html`（73KB）的内联逻辑拆分为管理组件
3. 利用 `src/api/admin.js` 替换内联的 fetch 调用

### 阶段三：优化（1天）

1. 添加 Service Worker（Vite PWA 插件）
2. 图片资源 hash 化，配置长效缓存
3. 启用 Brotli/gzip 压缩

### 构建产物部署

构建完成后，将 `../frontend-dist/` 下的文件替换 Nginx 的 `/usr/share/nginx/html/`：

```bash
npm run build
cp -r ../frontend-dist/* /usr/share/nginx/html/
```

## 与现有 `frontend/` 的关系

| 文件 | 说明 |
|------|------|
| `frontend/` | **生产中**，现有 HTML/JS，继续维护 |
| `frontend-vite/` | **开发中**，新架构骨架，逐步迁移 |
| `frontend-dist/` | Vite 构建产物（gitignore 中），不提交 |

> ⚠️ 在完整迁移完成前，请勿删除 `frontend/` 目录
