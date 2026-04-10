import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: '../frontend-dist',
    rollupOptions: {
      input: {
        public: 'index.html',
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:5000',
    },
  },
})
