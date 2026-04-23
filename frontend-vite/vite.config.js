import { defineConfig } from 'vite';
import { resolve } from 'path';
import { brotliCompress, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { VitePWA } from 'vite-plugin-pwa';

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

function precompressAssets() {
  const include = /\.(js|css|html|svg|json)$/i;
  const minSize = 1024;

  return {
    name: 'precompress-assets',
    apply: 'build',
    async generateBundle(_, bundle) {
      const entries = Object.entries(bundle);
      for (const [fileName, output] of entries) {
        const source = output.type === 'asset' ? output.source : output.code;
        if (!source || !include.test(fileName)) continue;

        const sourceBuffer = Buffer.isBuffer(source)
          ? source
          : Buffer.from(String(source));
        if (sourceBuffer.byteLength < minSize) continue;

        const [br, gz] = await Promise.all([
          brotliCompressAsync(sourceBuffer),
          gzipAsync(sourceBuffer),
        ]);

        this.emitFile({
          type: 'asset',
          fileName: `${fileName}.br`,
          source: br,
        });
        this.emitFile({
          type: 'asset',
          fileName: `${fileName}.gz`,
          source: gz,
        });
      }
    },
  };
}

export default defineConfig({
  // ── 开发服务器 ────────────────────────────────────────────────────────────
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },

  // ── 构建输出 ──────────────────────────────────────────────────────────────
  build: {
    outDir: '../frontend-dist',
    emptyOutDir: true,

    // JavaScript 最小化：使用 esbuild（快速）
    minify: 'esbuild',
    esbuild: {
      // 生产构建移除调试输出，进一步缩减体积
      drop: ['console', 'debugger'],
    },

    rollupOptions: {
      input: {
        main:  resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
      },

      output: {
        /**
         * 手动代码分割策略：
         *   - chart      Chart.js（流量页懒加载）
         *   - three      Three.js（预留）
         *   - vendor     其余第三方库
         *   - components 自有组件（StarMap 等按需加载时独立 chunk）
         */
        manualChunks(id) {
          if (id.includes('node_modules/chart.js')) return 'chart';
          if (id.includes('node_modules/three'))    return 'three';
          if (id.includes('node_modules'))           return 'vendor';
          if (id.includes('/src/components/'))       return 'components';
        },

        // 带 content hash 的文件名，利于长效缓存 ← 图片资源哈希化
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]', // 所有资源（含图片/字体）
      },
    },

    cssCodeSplit: true,
    chunkSizeWarningLimit: 600,
    sourcemap: false,
    reportCompressedSize: true,
  },

  // ── 路径别名 ──────────────────────────────────────────────────────────────
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },

  // ── CSS ───────────────────────────────────────────────────────────────────
  css: {
    devSourcemap: true,
  },

  // ── 插件 ─────────────────────────────────────────────────────────────────
  plugins: [

    // ① Service Worker + PWA
    // injectManifest：使用 src/sw.js 作为源文件，构建时注入预缓存清单
    VitePWA({
      registerType: 'autoUpdate',

      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',          // 源文件：src/sw.js
      outDir: '../frontend-dist', // 输出：frontend-dist/sw.js

      // 注入点：替换 src/sw.js 中的 self.__WB_MANIFEST
      injectManifest: {
        injectionPoint: 'self.__WB_MANIFEST',
        // 预缓存所有带 hash 的构建产物
        globPatterns: ['**/*.{js,css,html,svg,woff,woff2}'],
        globIgnores: ['**/node_modules/**/*'],
      },

      // Devtools（开发时可见 SW）
      devOptions: {
        enabled: false, // 开发时禁用 SW，避免缓存干扰
      },

      manifest: {
        name: 'VPS 星图',
        short_name: 'VPS 星图',
        description: '轻量级 VPS 监控仪表板与成本计算器',
        theme_color: '#070b14',
        background_color: '#070b14',
        start_url: '/',
        display: 'standalone',
        scope: '/',
        icons: [
          {
            src: '/icon-192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
    }),

    // ② 构建后预压缩（生成 .br/.gz，供 Nginx 直接 serve）
    precompressAssets(),

  ],
});
