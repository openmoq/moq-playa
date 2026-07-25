import { defineConfig } from 'vitest/config';

/**
 * Config for the opt-in external-probe differential lane ONLY. Runs the
 * `*.diff.test.ts` files (excluded from the default suite). Requires
 * MOQ_MEDIA_PROBE_BIN to point at a built `moq_media_probe`.
 *
 *   MOQ_MEDIA_PROBE_BIN=/abs/path/to/moq_media_probe pnpm test:corpus:diff
 */
export default defineConfig({
  test: {
    include: ['conformance/media/runner/src/diff/**/*.diff.test.ts'],
    // These launch a subprocess and wait on I/O; keep them serial and patient.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
