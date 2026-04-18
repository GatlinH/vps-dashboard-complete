/**
 * ⚠️  此文件不参与构建，仅作占位。
 *
 * 真正的 Service Worker 源文件位于：
 *   src/sw.js  （injectManifest 模式）
 *
 * 构建后 Workbox 会将注入了预缓存清单的 sw.js 输出到：
 *   ../frontend-dist/sw.js
 *
 * 如需修改 SW 缓存策略，请编辑 src/sw.js。
 */

const CACHE_PREFIX = 'vps-starmap';
const CACHE_VERSION = 'v1';
const CACHE_NAME = `${CACHE_PREFIX}-${CACHE_VERSION}`;
const ASSETS_CACHE = `${CACHE_PREFIX}-assets-${CACHE_VERSION}`;
const API_CACHE = `${CACHE_PREFIX}-api-${CACHE_VERSION}`;

// ── 安装：缓存基础资源 ────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // 仅缓存 HTML 入口（js/css 由 Workbox manifest 处理）
      return cache.addAll([
        '/',
        '/index.html',
        '/admin.html',
      ]).catch(err => console.warn('[SW] Initial cache failed:', err));
    }).then(() => self.skipWaiting())
  );
});

// ── 激活：清理过期缓存 ────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(names => {
      return Promise.all(
        names.map(name => {
          if (name.startsWith(CACHE_PREFIX) && !name.includes(CACHE_VERSION)) {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// ── Fetch：智能路由（网络优先 vs 缓存优先） ─────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 跳过非 GET 或 HTTPS（开发时 localhost 可能是 HTTP）
  if (request.method !== 'GET') return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // API 调用：Network First（联网优先，失败时降级缓存）
  if (url.pathname.startsWith('/api')) {
    event.respondWith(networkFirstStrategy(request, API_CACHE));
    return;
  }

  // 静态资源（js/css）：Cache First（缓存优先，快速加载）
  if (/\.(js|css|woff|woff2|svg)$/.test(url.pathname)) {
    event.respondWith(cacheFirstStrategy(request, ASSETS_CACHE));
    return;
  }

  // HTML 页面：Network First（保持最新）
  if (url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(networkFirstStrategy(request, CACHE_NAME));
    return;
  }

  // 其他：Network First
  event.respondWith(networkFirstStrategy(request, CACHE_NAME));
});

// ── 策略：Network First ──────────────────────────────────────────────────────
function networkFirstStrategy(request, cacheName) {
  return fetch(request)
    .then(response => {
      // 仅缓存 2xx 响应
      if (!response || response.status !== 200 || response.type !== 'basic') {
        return response;
      }
      const clone = response.clone();
      caches.open(cacheName).then(cache => cache.put(request, clone));
      return response;
    })
    .catch(() => {
      // 网络失败 → 返回缓存
      return caches.match(request).then(cached => {
        if (cached) return cached;
        // 离线且无缓存 → 返回离线页面（可选）
        if (request.destination === 'document') {
          return caches.match('/index.html');
        }
        return new Response('离线模式，无可用缓存', { status: 503 });
      });
    });
}

// ── 策略：Cache First ────────────────────────────────────────────────────────
function cacheFirstStrategy(request, cacheName) {
  return caches.match(request).then(cached => {
    if (cached) return cached;
    return fetch(request).then(response => {
      if (!response || response.status !== 200) return response;
      const clone = response.clone();
      caches.open(cacheName).then(cache => cache.put(request, clone));
      return response;
    });
  });
}

// ── 消息处理：支持更新通知 ────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

console.log('[SW] Service Worker loaded');
