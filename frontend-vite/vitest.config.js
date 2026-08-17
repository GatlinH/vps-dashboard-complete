import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.js'],
    exclude: ['node_modules/**', '../frontend-dist/**', 'build/**', 'vendor/**'],
  },
});
