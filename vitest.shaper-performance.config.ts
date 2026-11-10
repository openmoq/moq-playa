import { defineConfig, configDefaults } from 'vitest/config';
import base from './vitest.config.js';

// Explicit host-performance lane; do not inherit the default correctness projects.
export default defineConfig({
  ...(base.resolve === undefined ? {} : { resolve: base.resolve }),
  test: {
    include: ['scripts/net-shaper/shaper.performance.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.diff.test.ts'],
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
    retry: 0,
  },
});
