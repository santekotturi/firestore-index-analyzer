import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  platform: 'node',
  bundle: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
