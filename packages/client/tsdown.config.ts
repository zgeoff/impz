import { defineConfig } from 'tsdown';

// @impz/api and @impz/shared are private, so their code and their types go
// into the bundle.
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  outDir: 'dist',
  dts: { tsconfig: '../tsconfig.client-dts.json' },
  deps: { alwaysBundle: ['@impz/api', '@impz/shared'] },
});
