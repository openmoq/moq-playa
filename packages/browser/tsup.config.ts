import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist/browser',
  format: ['esm', 'iife'],
  globalName: 'MoqtBrowser',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
  target: 'es2022',
  platform: 'browser',
  noExternal: [/.*/],
  outExtension({ format }) {
    return {
      js: format === 'iife' ? '.global.js' : '.js',
    };
  },
});
