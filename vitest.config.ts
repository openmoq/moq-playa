import { defineConfig, configDefaults } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@moqt/browser': resolve(__dirname, 'packages/browser/src/index.ts'),
      '@playa/player': resolve(__dirname, 'packages/playa/src/index.ts'),
    },
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'conformance/media/runner/src/**/*.test.ts',
      'examples/node-publisher/src/**/*.test.ts',
      'examples/broadcast/**/*.test.ts',
      'examples/shared/**/*.test.ts',
    ],
    // The external-probe differential lane (`*.diff.test.ts`) requires a built
    // LibMoQ probe via MOQ_MEDIA_PROBE_BIN; it is opt-in via `test:corpus:diff`
    // and must NEVER run in the default suite.
    exclude: [...configDefaults.exclude, '**/*.diff.test.ts'],
  },
});
