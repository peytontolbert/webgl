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
    {
      name: 'webglgta-dump-endpoint',
      /**
       * Add a simple JSON dump endpoint for debugging missing textures/materials.
       *
       * Usage (DevTools):
       *   await __viewerDumpTextures()
       *
       * Writes to: webgl_viewer/tools/out/viewer_dumps/*.json
       */
      configureServer(server) {
        const root = path.resolve(__dirname);
        const outDir = path.join(root, 'tools', 'out', 'viewer_dumps');
        const ensureDir = () => {
          try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* ignore */ }
        };
        const safeStamp = () => {
          const d = new Date();
          // 2026-01-06T12-34-56
          return d.toISOString().replace(/[:.]/g, '-').replace('Z', '');
        };
        const safeKind = (v) => String(v || 'dump').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'dump';

        server.middlewares.use('/__viewer_dump', (req, res, next) => {
          if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.end();
            return;
          }
          if (req.method !== 'POST') return next();

          let body = '';
          req.on('data', (c) => { body += c; if (body.length > 50_000_000) req.destroy(); });
          req.on('end', () => {
            try {
              const obj = body ? JSON.parse(body) : {};
              const kind = safeKind(obj?.kind || obj?.subsystem || obj?.type || 'dump');
              ensureDir();
              const p = path.join(outDir, `viewer_${kind}_${safeStamp()}.json`);
              fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
              res.statusCode = 200;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: true, path: p }));
            } catch (e) {
              res.statusCode = 400;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
            }
          });
        });
      },
      configurePreviewServer(server) {
        // Same endpoint for `vite preview`.
        // (Preview server is connect-based as well.)
        const root = path.resolve(__dirname);
        const outDir = path.join(root, 'tools', 'out', 'viewer_dumps');
        const ensureDir = () => {
          try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* ignore */ }
        };
        const safeStamp = () => {
          const d = new Date();
          return d.toISOString().replace(/[:.]/g, '-').replace('Z', '');
        };
        const safeKind = (v) => String(v || 'dump').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'dump';

        server.middlewares.use('/__viewer_dump', (req, res, next) => {
          if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.end();
            return;
          }
          if (req.method !== 'POST') return next();

          let body = '';
          req.on('data', (c) => { body += c; if (body.length > 50_000_000) req.destroy(); });
          req.on('end', () => {
            try {
              const obj = body ? JSON.parse(body) : {};
              const kind = safeKind(obj?.kind || obj?.subsystem || obj?.type || 'dump');
              ensureDir();
              const p = path.join(outDir, `viewer_${kind}_${safeStamp()}.json`);
              fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
              res.statusCode = 200;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: true, path: p }));
            } catch (e) {
              res.statusCode = 400;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
            }
          });
        });
      },
    },
  ],
  build: {
    assetsDir: 'bundled',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        earth: path.resolve(__dirname, 'earth.html'),
      },
    },
  },
  // The repo's runtime GTA assets under `webgl_viewer/assets/` can be huge (hundreds of thousands
  // of .bin/.png files). If Vite tries to watch them, Linux inotify hits ENOSPC (watcher limit).
  //
  // We serve those assets via the sirv middleware above; they do NOT need to be watched for HMR.
  server: {
    watch: {
      ignored: [
        '**/assets/models/**',
        '**/assets/models_textures/**',
        '**/assets/packs/**',
        '**/assets/textures/**',
        '**/assets/entities_chunks/**',
        '**/assets/entities_chunks_bin/**',
        '**/assets/entities_chunks_inst/**',
        '**/assets/terrain_tiles/**',
        '**/dist/**',
      ],
    },
  },
});


