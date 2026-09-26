// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// studio/ reuses Meta's demo modules in place: "@/..." resolves to
// ../demo/frontend/src, exactly as it does inside the demo. Their bare imports
// (relay-runtime, pts, mp4box, ...) are deduped to studio/node_modules, so the
// demo's own node_modules is never needed and never mixed in.
/// <reference types="vitest" />
import react from '@vitejs/plugin-react';
import path from 'node:path';
import {defineConfig} from 'vite';
import relay from 'vite-plugin-relay';

const DEMO_SRC = path.resolve(__dirname, '../demo/frontend/src');

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
      '@': DEMO_SRC,
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
    fs: {allow: [path.resolve(__dirname, '..')]},
  },
  preview: {port: 7362, strictPort: true},
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
