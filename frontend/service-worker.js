// frontend/service-worker.js - Service Worker 离线支持（已隔离管理接口缓存）

const CACHE_VERSION = 'v2';
const CACHE_NAME = `vps-dashboard-${CACHE_VERSION}`;

// 仅缓存公开静态资源；/admin.html 及所有管理/鉴权接口明确排除
const STATIC_ASSETS = [
    '/public.html',
    '/offline.html',
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
    '/frontend/api-public.js',
    '/styles/main.css',
    'https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js',
];

/**
 * 判断路径是否属于管理/鉴权类，这些路径永远走 network-only 策略，
 * 即使离线也不返回缓存内容。
 */
function isAdminOrAuthPath(pathname) {
    const blocklist = [
        '/admin.html',
        '/api/v1/auth/',
        '/api/v1/servers/',
        '/api/v1/probe/',
        '/api/v1/telegram/',
    ];
    return blocklist.some(p => pathname.startsWith(p));
}

// ── 安装：预缓存公开静态资源 ─────────────────────────────────────────────────

self.addEventListener('install', (event) => {
    console.log('[SW] Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('[SW] Caching public static assets');
                return Promise.allSettled(
                    STATIC_ASSETS.map(url => cache.add(url))
                ).then(results => {
                    results.forEach((r, i) => {
                        if (r.status === 'rejected') {
                            console.warn(`[SW] Failed to cache ${STATIC_ASSETS[i]}:`, r.reason);
                        }
                    });
                });
            })
            .then(() => self.skipWaiting())
    );
});

// ── 激活：清理旧版本缓存 ─────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
    console.log('[SW] Activating...');
    event.waitUntil(
        caches.keys().then(cacheNames =>
            Promise.all(
                cacheNames
                    .filter(name => name !== CACHE_NAME)
                    .map(name => {
                        console.log(`[SW] Deleting old cache: ${name}`);
                        return caches.delete(name);
                    })
            )
        ).then(() => self.clients.claim())
    );
});

// ── 请求拦截 ─────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // 1. 跨域请求：不干预
    if (url.origin !== location.origin) return;

    // 2. 非 GET 请求：不干预（POST/PUT/DELETE 等写操作直接发网络）
    if (request.method !== 'GET') return;

    // 3. 管理/鉴权路径：network-only，严禁写入缓存
    if (isAdminOrAuthPath(url.pathname)) {
        event.respondWith(
            fetch(request).catch(() => {
                // 管理接口离线时返回 503，不提供缓存降级
                return new Response(
                    JSON.stringify({ error: 'offline', msg: '管理接口暂时不可用，请检查网络连接' }),
                    { status: 503, headers: { 'Content-Type': 'application/json' } }
                );
            })
        );
        return;
    }

    // 4. 其余公开 GET 请求：缓存优先，网络回退
    event.respondWith(
        caches.match(request).then(cached => {
            if (cached) return cached;

            return fetch(request)
                .then(response => {
                    // 仅缓存成功的 200 响应
                    if (response && response.status === 200 && response.type === 'basic') {
                        const toCache = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(request, toCache));
                    }
                    return response;
                })
                .catch(() => {
                    if (request.destination === 'document') {
                        return caches.match('/offline.html');
                    }
                });
        })
    );
});

// ── 消息处理 ─────────────────────────────────────────────────────────────────

self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
    if (event.data?.type === 'CLEAR_CACHE') caches.delete(CACHE_NAME);
});

console.log('[SW] Loaded (v2 - admin paths excluded from cache)');
