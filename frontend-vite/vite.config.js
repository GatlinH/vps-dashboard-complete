import { defineConfig } from 'vite';
import { resolve } from 'path';
import { VitePWA } from 'vite-plugin-pwa';
import { compression } from 'vite-plugin-compression2';

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

    // ② Brotli 预压缩（构建时生成 .br 文件，Nginx 直接 serve，无需实时压缩）
    compression({
      algorithm: 'brotliCompress',
      include: /\.(js|css|html|svg|json)$/,
      threshold: 1024, // 仅压缩 >1KB 的文件
    }),

    // ③ Gzip 预压缩（兜底，不支持 Brotli 的场景）
    compression({
      algorithm: 'gzip',
      include: /\.(js|css|html|svg|json)$/,
      threshold: 1024,
    }),

  ],
});
