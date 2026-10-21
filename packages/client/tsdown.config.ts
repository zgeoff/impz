import { defineConfig } from 'tsdown';

// @impz/api and @impz/shared are private, so their code and their types go
// into the bundle.
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  outDir: 'dist',
  dts: {
    tsconfig: '../tsconfig.client-dts.json',
    generator: 'tsgo',
    tsgo: {
      path: decodeURIComponent(new URL('../../node_modules/.bin/tsrs', import.meta.url).pathname),
    },
  },
  deps: { alwaysBundle: ['@impz/api', '@impz/shared'] },
});
