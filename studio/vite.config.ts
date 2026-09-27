// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// "@/..." resolves to src/meta, the Meta demo modules studio vendors, laid out
// as they were in the demo's src/, so their own "@/" imports work unchanged.
// Shared packages are deduped so each is bundled once.
/// <reference types="vitest" />
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import {defineConfig, type Plugin} from 'vite';
import relay from 'vite-plugin-relay';

const META_SRC = path.resolve(__dirname, './src/meta');
const GALLERY = path.resolve(__dirname, '../demo/data/gallery');

/**
 * Bundle clips from Meta's SAM 2 demo gallery (demo/data/gallery, Apache-2.0,
 * in the repo already) as the browser-only build's samples: VITE_SAMPLES is
 * a comma list of file names there. They are served (dev) or emitted
 * (build) under samples/, with samples/index.json listing them. Only that
 * folder's files, by name: no other footage can get in.
 */
function samples(): Plugin {
  const names = (process.env.VITE_SAMPLES ?? '')
    .split(',')
    .map(n => n.trim())
    .filter(n => n !== '');
  for (const n of names) {
    if (path.basename(n) !== n || !fs.existsSync(path.join(GALLERY, n))) {
      throw new Error(`VITE_SAMPLES: ${n} is not a file in demo/data/gallery`);
    }
  }
  const index = JSON.stringify(names.map(file => ({file})));
  return {
    name: 'sam-ui-samples',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0].replace(server.config.base, '/');
        if (url === '/samples/index.json') {
          res.setHeader('Content-Type', 'application/json');
          res.end(index);
        } else if (url.startsWith('/samples/') && names.includes(url.slice('/samples/'.length))) {
          res.setHeader('Content-Type', 'video/mp4');
          fs.createReadStream(path.join(GALLERY, url.slice('/samples/'.length))).pipe(res);
        } else {
          next();
        }
      });
    },
    generateBundle() {
      if (names.length === 0) {
        return;
      }
      this.emitFile({type: 'asset', fileName: 'samples/index.json', source: index});
      for (const file of names) {
        this.emitFile({type: 'asset', fileName: `samples/${file}`, source: fs.readFileSync(path.join(GALLERY, file))});
      }
    },
  };
}

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
  // "/sam-ui/" for GitHub Pages (npm run build:pages)
  base: process.env.VITE_BASE ?? '/',
  resolve: {
    alias: {
      '@': META_SRC,
      '~': path.resolve(__dirname, './src'),
    },
    dedupe: SHARED_PACKAGES,
  },
  plugins: [react(), relay, samples()],
  // ONNX Runtime Web finds its .wasm next to its own module (import.meta.url),
  // which pre-bundling would move
  optimizeDeps: {exclude: ['onnxruntime-web']},
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
