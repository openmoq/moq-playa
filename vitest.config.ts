import { defineConfig, configDefaults } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    // Unit and simulation suites must exercise WORKSPACE SOURCE, not the
    // published `dist`. Each package's `exports` map points at `dist/index.js`,
    // so without these aliases a local `pnpm test` silently tests stale
    // generated code — a real-class composition ran against a prebuilt bundle
    // and made a production fix look like a no-op. CI's build-before-test order
    // masked it rather than preventing it. The published export surface stays
    // covered separately by `smoke:exports`.
    // Mirrors the list in `examples/vite.config.ts`.
    alias: {
      '@moqt/transport': resolve(__dirname, 'packages/transport/src/index.ts'),
      '@moqt/webtransport': resolve(__dirname, 'packages/webtransport/src/index.ts'),
      '@moqt/quic': resolve(__dirname, 'packages/quic/src/index.ts'),
      '@moqt/msf': resolve(__dirname, 'packages/msf/src/index.ts'),
      '@moqt/loc': resolve(__dirname, 'packages/loc/src/index.ts'),
      '@moqt/playback': resolve(__dirname, 'packages/playback/src/index.ts'),
      '@moqt/player': resolve(__dirname, 'packages/player/src/index.ts'),
      '@moqt/browser': resolve(__dirname, 'packages/browser/src/index.ts'),
      '@playa/player': resolve(__dirname, 'packages/playa/src/index.ts'),
    },
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'conformance/media/runner/src/**/*.test.ts',
      'examples/node-relay/src/**/*.test.ts',
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
