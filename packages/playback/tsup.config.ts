import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist/browser',
  format: ['esm', 'iife'],
  globalName: 'MoqtPlayback',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
  target: 'es2022',
  noExternal: [/.*/],
  outExtension({ format }) {
    return {
      js: format === 'iife' ? '.global.js' : '.js',
    };
  },
});
