/**
 * src/main.js - Vite 入口文件
 * 渐进式迁移：当前仅引入公共 API 模块和样式，供后续页面组件扩展使用
 */
import './styles/main.css'
import { listServersPublic } from './api/public.js'

// 应用入口 - 渐进式替换现有 public.html 的内联逻辑
async function init() {
  const app = document.getElementById('app')
  if (!app) return

  try {
    const { servers } = await listServersPublic()
    app.innerHTML = `<p>已加载 ${servers.length} 台服务器</p>`
  } catch (err) {
    app.innerHTML = `<p>加载失败: ${err.message}</p>`
  }
}

init()
