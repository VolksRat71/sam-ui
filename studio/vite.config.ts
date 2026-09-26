// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// "@/..." resolves to src/meta, the Meta demo modules studio vendors, laid out
// as they were in the demo's src/, so their own "@/" imports work unchanged.
// Shared packages are deduped so each is bundled once.
/// <reference types="vitest" />
import react from '@vitejs/plugin-react';
import path from 'node:path';
import {defineConfig} from 'vite';
import relay from 'vite-plugin-relay';

const META_SRC = path.resolve(__dirname, './src/meta');

const SHARED_PACKAGES = [
  'react',
  'react-dom',
  'react-relay',
  'relay-runtime',
  'invariant',
  'mp4box',
  'pts',
  'serialize-error',
  'react-device-detect',
  '@carbon/icons-react',
];

export default defineConfig({
  resolve: {
    alias: {
      '@': META_SRC,
      '~': path.resolve(__dirname, './src'),
    },
    dedupe: SHARED_PACKAGES,
  },
  plugins: [react(), relay],
  worker: {
    format: 'es',
    plugins: () => [relay],
  },
  server: {
    port: 7362,
    strictPort: true,
  },
  preview: {port: 7362, strictPort: true},
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
