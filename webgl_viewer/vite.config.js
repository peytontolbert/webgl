import { defineConfig } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import sirv from 'sirv';

// IMPORTANT:
// - We keep `dist/assets/` for large runtime/exported GTA assets (terrain_info.json, textures, models, etc.)
// - We move Vite's bundled JS/CSS output out of `dist/assets/` so our postbuild sync doesn't overwrite it.
export default defineConfig({
  // Make built asset URLs relative (e.g. "./bundled/xxx.js") so the viewer can be hosted
  // under a subpath without breaking absolute "/bundled/..." references.
  base: './',
  plugins: [
    {
      name: 'webglgta-runtime-assets',
      /**
       * In Vite dev, mount the repo's runtime/exported `assets/` directory at `/assets/...`
       * so requests like `/assets/models_textures/*.png` don't hit SPA fallback (`index.html`).
       */
      configureServer(server) {
        const root = path.resolve(__dirname);
        const runtimeAssets = path.join(root, 'assets');
        // IMPORTANT: missing /assets/* must be a real 404 (not SPA index.html fallback),
        // otherwise the client will fetch HTML and try to decode it as an image.
        server.middlewares.use('/assets', sirv(runtimeAssets, { dev: true, etag: true, single: false }));
        server.middlewares.use('/assets', (req, res, next) => {
          if (res.headersSent) return next();
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Not found');
        });
      },
      /**
       * In `vite preview`, prefer serving `dist/assets` if it exists, otherwise fall back to `assets`.
       * This makes preview behave like production while still working before a full build.
       */
      configurePreviewServer(server) {
        const root = path.resolve(__dirname);
        const distAssets = path.join(root, 'dist', 'assets');
        const runtimeAssets = path.join(root, 'assets');
        // Prefer dist/assets, but fall back per-request to repo assets/ when a specific file
        // wasn't synced into dist yet (avoids confusing 404s during incremental workflows).
        const hasDist = fs.existsSync(distAssets);
        if (hasDist) {
          server.middlewares.use('/assets', sirv(distAssets, { dev: false, etag: true, single: false }));
          server.middlewares.use('/assets', sirv(runtimeAssets, { dev: false, etag: true, single: false }));
        } else {
          server.middlewares.use('/assets', sirv(runtimeAssets, { dev: false, etag: true, single: false }));
        }
        server.middlewares.use('/assets', (req, res, next) => {
          if (res.headersSent) return next();
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Not found');
        });
      },
    },
  ],
  build: {
    assetsDir: 'bundled',
  },
});


