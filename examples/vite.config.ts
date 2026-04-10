import { defineConfig } from 'vite';
import { resolve } from 'path';

/**
 * Vite config for MoQ examples.
 *
 * resolve.alias maps @moqt/* imports directly to TypeScript source files,
 * bypassing dist/. No `pnpm build` needed during development — edit library
 * source, save, Vite hot-reloads via esbuild.
 */
export default defineConfig({
  server: {
    // Default: localhost only. For mobile/device testing:
    //   VITE_HOST=0.0.0.0 npm run dev
    // or: npx vite --host
    ...(process.env.VITE_HOST ? { host: process.env.VITE_HOST } : {}),
  },
  resolve: {
    alias: {
      '@moqt/transport': resolve(__dirname, '../packages/transport/src/index.ts'),
      '@moqt/webtransport': resolve(__dirname, '../packages/webtransport/src/index.ts'),
      '@moqt/msf': resolve(__dirname, '../packages/msf/src/index.ts'),
      '@moqt/loc': resolve(__dirname, '../packages/loc/src/index.ts'),
      '@moqt/playback': resolve(__dirname, '../packages/playback/src/index.ts'),
      '@moqt/player': resolve(__dirname, '../packages/player/src/index.ts'),
      '@moqt/browser': resolve(__dirname, '../packages/browser/src/index.ts'),
      '@playa/player': resolve(__dirname, '../packages/playa/src/index.ts'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        catalog: resolve(__dirname, 'catalog/index.html'),
        connect: resolve(__dirname, 'connect/index.html'),
        player: resolve(__dirname, 'player/index.html'),
        simple: resolve(__dirname, 'simple/index.html'),
        broadcast: resolve(__dirname, 'broadcast/index.html'),
      },
    },
  },
});
