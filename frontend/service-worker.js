// frontend/service-worker.js - Service Worker 离线支持

const CACHE_VERSION = 'v1';
const CACHE_NAME = `vps-dashboard-${CACHE_VERSION}`;
const RUNTIME_CACHE = `vps-dashboard-runtime-${CACHE_VERSION}`;

// 需要缓存的静态资源
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/frontend/app.js',
    '/frontend/charts.js',
    '/frontend/performance.js',
    '/frontend/logger.js',
    '/frontend/i18n.js',
    '/frontend/error-boundary.js',
    '/frontend/notifications.js',
    '/frontend/audit.js',
    '/frontend/metrics.js',
    '/frontend/export.js',
    '/frontend/secure-storage.js',
    '/styles/main.css',
    '/images/logo.png',
    'https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js',
];

// 安装事件 - 缓存静态资源
self.addEventListener('install', (event) => {
    console.log('[Service Worker] Installing...');

    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[Service Worker] Caching static assets');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => self.skipWaiting())
    );
});

// 激活事件 - 清理旧缓存
self.addEventListener('activate', (event) => {
    console.log('[Service Worker] Activating...');

    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cacheName) => {
                        if (cacheName !== CACHE_NAME && cacheName !== RUNTIME_CACHE) {
                            console.log(`[Service Worker] Deleting old cache: ${cacheName}`);
                            return caches.delete(cacheName);
                        }
                    })
                );
            })
            .then(() => self.clients.claim())
    );
});

// 拦截网络请求
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // 不缓存跨域请求
    if (url.origin !== location.origin) {
        return;
    }

    // 不缓存非 GET 请求
    if (request.method !== 'GET') {
        return;
    }

    // 不缓存 API 请求（这些应该始终新鲜）
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    // 如果成功，缓存响应
                    if (response && response.status === 200) {
                        const responseToCache = response.clone();
                        caches.open(RUNTIME_CACHE).then((cache) => {
                            cache.put(request, responseToCache);
                        });
                    }
                    return response;
                })
                .catch(() => {
                    // 如果失败，尝试从缓存读取
                    return caches.match(request)
                        .then((response) => {
                            if (response) {
                                // 标记为离线响应
                                const cloned = response.clone();
                                cloned.headers.set('X-From-Cache', 'true');
                                return cloned;
                            }
                            return caches.match('/offline.html');
                        });
                })
        );
        return;
    }

    // 对于其他资源，使用缓存优先策略
    event.respondWith(
        caches.match(request)
            .then((response) => {
                // 如果有缓存，返回缓存
                if (response) {
                    return response;
                }

                // 否则，尝试从网络获取
                return fetch(request)
                    .then((response) => {
                        // 如果网络请求失败
                        if (!response || response.status !== 200) {
                            return response;
                        }

                        // 缓存新的响应
                        const responseToCache = response.clone();
                        caches.open(RUNTIME_CACHE)
                            .then((cache) => {
                                cache.put(request, responseToCache);
                            });

                        return response;
                    })
                    .catch(() => {
                        // 网络和缓存都失败，返回离线页面
                        if (request.destination === 'document') {
                            return caches.match('/offline.html');
                        }
                        // 其他资源，返回通用错误页面
                        return caches.match('/error.html');
                    });
            })
    );
});

// 后台同步（用于离线操作）
self.addEventListener('sync', (event) => {
    console.log('[Service Worker] Background sync:', event.tag);

    if (event.tag === 'sync-audit-logs') {
        event.waitUntil(
            // 从 IndexedDB 读取待同步的日志
            // 并发送到后端
            Promise.resolve()
        );
    }

    if (event.tag === 'sync-metrics') {
        event.waitUntil(
            // 从 IndexedDB 读取待同步的指标
            // 并发送到后端
            Promise.resolve()
        );
    }
});

// 处理消息（来自页面）
self.addEventListener('message', (event) => {
    console.log('[Service Worker] Message:', event.data);

    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }

    if (event.data && event.data.type === 'CLEAR_CACHE') {
        caches.delete(CACHE_NAME);
        caches.delete(RUNTIME_CACHE);
    }
});

console.log('[Service Worker] Loaded');
