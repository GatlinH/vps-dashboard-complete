import { defineConfig } from 'vite';
import { resolve } from 'path';

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

    rollupOptions: {
      input: {
        main:  resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
      },

      output: {
        /**
         * 手动代码分割策略：
         *   - chart      Chart.js（流量页懒加载）
         *   - vendor     其余第三方库
         *   - components 自有组件（StarMap 等按需加载时独立 chunk）
         */
        manualChunks(id) {
          // Chart.js → 独立 chunk（流量页动态 import 时才下载）
          if (id.includes('node_modules/chart.js')) return 'chart';

          // Three.js → 独立 chunk（为将来的 Three.js 版星图预留）
          if (id.includes('node_modules/three')) return 'three';

          // 其余 node_modules → vendor chunk
          if (id.includes('node_modules')) return 'vendor';

          // src/components → components chunk（非首屏按需加载）
          if (id.includes('/src/components/')) return 'components';
        },

        // 带 content hash 的文件名，利于长效缓存
        chunkFileNames:  'assets/[name]-[hash].js',
        entryFileNames:  'assets/[name]-[hash].js',
        assetFileNames:  'assets/[name]-[hash][extname]',
      },
    },

    // 生产构建：启用 CSS 代码分割
    cssCodeSplit: true,

    // 调整 chunk 大小警告阈值（chart.js 本身较大）
    chunkSizeWarningLimit: 600,
  },

  // ── 路径别名 ──────────────────────────────────────────────────────────────
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },

  // ── CSS 预处理（如有需要，可改用 sass/less） ──────────────────────────────
  css: {
    devSourcemap: true,
  },
});
