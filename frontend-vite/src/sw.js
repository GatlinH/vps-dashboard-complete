/**
 * src/sw.js  —  Service Worker 源文件（injectManifest 模式）
 *
 * 构建时 vite-plugin-pwa 会：
 *   1. 将 self.__WB_MANIFEST 替换为实际的构建产物清单（含 hash）
 *   2. 把编译后的 SW 写到 ../frontend-dist/sw.js
 *
 * 缓存策略：
 *   precache   → 所有带 hash 的构建产物（JS / CSS / HTML / SVG）
 *   NetworkFirst  → /api/* 调用（5s 超时，失败时降级缓存）
 *   CacheFirst    → CDN 字体 / 第三方库（30天）
 *   StaleWhileRevalidate → 其余外部请求（24h）
 */

import { clientsClaim } from 'workbox-core';
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import {
  NetworkFirst,
  CacheFirst,
  StaleWhileRevalidate,
} from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { createHandlerBoundToURL } from 'workbox-precaching';

// ── 立即激活，不等待旧 SW 失效 ──────────────────────────────────────────────
clientsClaim();
self.skipWaiting();

// ── 预缓存（Workbox 注入构建清单） ─────────────────────────────────────────
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// ── SPA 路由：导航请求回落到 index.html ────────────────────────────────────
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    // admin.html 不走 SPA fallback（独立入口）
    denylist: [/^\/admin/],
  })
);

// ── API 调用：Network First（5s 超时，降级1小时缓存）─────────────────────
registerRoute(
  ({ url }) => url.pathname.startsWith('/api'),
  new NetworkFirst({
    cacheName: 'api-cache-v1',
    networkTimeoutSeconds: 5,
    plugins: [
      new ExpirationPlugin({ maxAgeSeconds: 3600, maxEntries: 50 }),
    ],
  })
);

// ── CDN 字体 / 第三方库：Cache First（30天）──────────────────────────────
registerRoute(
  ({ url }) => /^https:\/\/(cdn\.|cdnjs\.|fonts\.)/.test(url.href),
  new CacheFirst({
    cacheName: 'cdn-cache-v1',
    plugins: [
      new ExpirationPlugin({ maxAgeSeconds: 2_592_000, maxEntries: 30 }),
    ],
  })
);

// ── ipapi.co（IP 查询）：Network First（1小时）───────────────────────────
registerRoute(
  ({ url }) => url.hostname === 'ipapi.co',
  new NetworkFirst({
    cacheName: 'ipapi-cache-v1',
    plugins: [
      new ExpirationPlugin({ maxAgeSeconds: 3600, maxEntries: 20 }),
    ],
  })
);

// ── 其余外部请求：Stale While Revalidate（24h）───────────────────────────
registerRoute(
  ({ url }) => url.origin !== self.location.origin,
  new StaleWhileRevalidate({
    cacheName: 'external-cache-v1',
    plugins: [
      new ExpirationPlugin({ maxAgeSeconds: 86_400, maxEntries: 50 }),
    ],
  })
);

// ── 消息：主动跳过等待（页面发 SKIP_WAITING 时立即更新）────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
