import { defineConfig } from 'vite';
import { resolve } from 'path';
import { brotliCompress, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { VitePWA } from 'vite-plugin-pwa';
import cesium from 'vite-plugin-cesium';

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

        this.emitFile({ type: 'asset', fileName: `${fileName}.br`, source: br });
        this.emitFile({ type: 'asset', fileName: `${fileName}.gz`, source: gz });
      }
    },
  };
}

export default defineConfig({
  envDir: '..',   // 从仓库根读取 .env(集中管理密钥)
  define: {
    CESIUM_BASE_URL: JSON.stringify('/cesium'),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../frontend-dist',
    emptyOutDir: true,
    minify: 'esbuild',
    esbuild: {
      drop: ["debugger"],
    },
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
      },
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/chart.js')) return 'chart';
          if (id.includes('node_modules/cesium')) return undefined;
          if (id.includes('node_modules/@deck.gl') || id.includes('node_modules/@luma.gl')) return 'deckgl';
          if (id.includes('node_modules')) return 'vendor';
          if (id.includes('/src/components/')) return 'components';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
    cssCodeSplit: true,
    chunkSizeWarningLimit: 3200,
    sourcemap: false,
    reportCompressedSize: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  css: {
    devSourcemap: true,
  },
  plugins: [
    cesium({
      rebuildCesium: true,
      cesiumBaseUrl: '/cesium',
    }),
    VitePWA({
      injectRegister: false,
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      outDir: '../frontend-dist',
      injectManifest: {
        injectionPoint: 'self.__WB_MANIFEST',
        globPatterns: ['**/*.{js,css,html,svg,woff,woff2}'],
        globIgnores: ['**/node_modules/**/*'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      devOptions: {
        enabled: false,
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
    precompressAssets(),
  ],
});
