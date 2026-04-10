import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@moqt/browser': resolve(__dirname, 'packages/browser/src/index.ts'),
      '@playa/player': resolve(__dirname, 'packages/playa/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
  },
});
