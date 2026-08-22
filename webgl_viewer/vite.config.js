import { defineConfig } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import sirv from 'sirv';
import { spawn } from 'node:child_process';
import { installMultiplayerServer } from './multiplayer_server.js';

function readDotEnvFile(file) {
  const out = {};
  try {
    const txt = fs.readFileSync(file, 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
  } catch {
    // optional
  }
  return out;
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function readRequestJson(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

let liveExportChain = Promise.resolve();

function runProcess(cmd, args, { cwd, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const trim = (s) => (s.length > 24000 ? s.slice(s.length - 24000) : s);
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error(`process timed out after ${timeoutMs}ms: ${cmd}`));
    }, timeoutMs);
    child.stdout.on('data', (b) => { stdout = trim(stdout + String(b)); });
    child.stderr.on('data', (b) => { stderr = trim(stderr + String(b)); });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`process exited ${code}: ${cmd}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

function cleanHashes(input, max = 24) {
  const src = Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (const v of src) {
    const s = String(v?.hash ?? v ?? '').trim();
    if (!/^-?\d+$/.test(s)) continue;
    const n = Number.parseInt(s, 10);
    if (!Number.isFinite(n)) continue;
    const h = String(n >>> 0);
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(h);
    if (out.length >= max) break;
  }
  return out;
}

function installLiveExportEndpoint(server, root) {
  const repoRoot = path.resolve(root, '..');
  const env = { ...readDotEnvFile(path.join(repoRoot, '.env')), ...process.env };
  const gamePath = String(env.gta_location || env.gta5_path || '').replace(/^['"]|['"]$/g, '');
  const python = String(env.PYTHON || env.PYTHON_EXE || 'python');
  const outDir = path.join(root, 'tools', 'out', 'live_export');
  const assetsDir = path.join(root, 'assets');

  server.middlewares.use('/__live_export', async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          gamePathConfigured: !!gamePath,
          gamePathExists: !!(gamePath && fs.existsSync(gamePath)),
          mode: 'archetype-export',
        });
        return;
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      if (!gamePath || !fs.existsSync(gamePath)) {
        sendJson(res, 500, { ok: false, error: 'Missing GTA path. Set gta_location or gta5_path in .env.' });
        return;
      }

      const body = await readRequestJson(req);
      const hashes = cleanHashes(body.hashes, Math.max(1, Math.min(64, Number(body.top || body.limit || 24) || 24)));
      if (!hashes.length) {
        sendJson(res, 400, { ok: false, error: 'No numeric hashes provided.' });
        return;
      }

      const exportTextures = !!body.exportTextures;
      fs.mkdirSync(outDir, { recursive: true });
      const inputPath = path.join(outDir, `live_hashes_${Date.now()}_${Math.floor(Math.random() * 100000)}.json`);
      fs.writeFileSync(inputPath, JSON.stringify({ hashes }, null, 2), 'utf8');

      const started = Date.now();
      const task = async () => {
        const args = [
          path.join(repoRoot, 'export_drawables_from_list.py'),
          '--game-path',
          gamePath,
          '--assets-dir',
          assetsDir,
          '--input',
          inputPath,
          '--top',
          String(hashes.length),
          '--skip-existing',
          '--write-report',
        ];
        if (exportTextures) args.push('--export-textures');
        const result = await runProcess(python, args, { cwd: repoRoot });
        return {
          ok: true,
          hashes,
          exportTextures,
          durationMs: Date.now() - started,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      };

      liveExportChain = liveExportChain.catch(() => undefined).then(task);
      const result = await liveExportChain;
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: String(e?.message || e || 'live export failed'),
        stdout: e?.stdout || '',
        stderr: e?.stderr || '',
      });
    }
  });
}

function installSpawnEndpoint(server, root) {
  const repoRoot = path.resolve(root, '..');
  const env = { ...readDotEnvFile(path.join(repoRoot, '.env')), ...process.env };
  const python = String(env.PYTHON || env.PYTHON_EXE || 'python');
  const assetsDir = path.join(root, 'assets');

  server.middlewares.use('/__spawn', async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }

      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname.replace(/^\/+/, '');
      if (pathname === 'scripts') {
        const body = req.method === 'POST' ? await readRequestJson(req, 64 * 1024) : {};
        const refresh =
          body.refresh === true ||
          url.searchParams.get('refresh') === '1' ||
          url.searchParams.get('refresh') === 'true';
        const indexPath = path.join(assetsDir, 'runtime_script_index.json');
        if (!refresh && fs.existsSync(indexPath)) {
          try {
            sendJson(res, 200, JSON.parse(fs.readFileSync(indexPath, 'utf8')));
            return;
          } catch {
            // Fall through and rebuild below.
          }
        }

        const args = [
          path.join(repoRoot, 'inspect_gta_scripts.py'),
          '--assets-dir',
          assetsDir,
        ];
        if (body.gamePath || url.searchParams.get('gamePath')) {
          args.push('--game-path', String(body.gamePath || url.searchParams.get('gamePath')));
        }
        const result = await runProcess(python, args, { cwd: repoRoot, timeoutMs: 2 * 60 * 1000 });
        const summary = String(result.stdout || '').trim();
        const payload = fs.existsSync(indexPath)
          ? JSON.parse(fs.readFileSync(indexPath, 'utf8'))
          : { ok: false, error: 'script indexer did not write runtime_script_index.json' };
        payload.indexer = summary ? JSON.parse(summary) : null;
        sendJson(res, payload?.ok ? 200 : 500, payload);
        return;
      }

      if (pathname && pathname !== 'resolve') {
        sendJson(res, 404, { ok: false, error: 'unknown spawn endpoint' });
        return;
      }

      const body = req.method === 'POST' ? await readRequestJson(req, 64 * 1024) : {};
      const args = [
        path.join(repoRoot, 'resolve_gta_spawn.py'),
        '--assets-dir',
        assetsDir,
      ];
      const addMany = (name, values) => {
        const src = Array.isArray(values) ? values : (values ? [values] : []);
        for (const v of src) {
          const s = String(v || '').trim();
          if (!s) continue;
          args.push(name, s);
        }
      };
      addMany('--resources-root', body.resourcesRoot || url.searchParams.getAll('resourcesRoot'));
      addMany('--save-dir', body.saveDir || url.searchParams.getAll('saveDir'));

      const allowSaveHeuristic =
        body.allowSaveHeuristic === true ||
        url.searchParams.get('allowSaveHeuristic') === '1' ||
        String(env.GTA_SPAWN_ALLOW_SAVE_HEURISTIC || '').trim() === '1';
      if (allowSaveHeuristic) args.push('--allow-save-heuristic');

      const result = await runProcess(python, args, { cwd: repoRoot, timeoutMs: 60 * 1000 });
      const text = String(result.stdout || '').trim();
      const data = text ? JSON.parse(text) : { ok: false, error: 'empty spawn resolver output' };
      sendJson(res, data?.ok ? 200 : 500, data);
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: String(e?.message || e || 'spawn resolve failed'),
        stdout: e?.stdout || '',
        stderr: e?.stderr || '',
      });
    }
  });
}

function installGameplayEndpoint(server, root) {
  const repoRoot = path.resolve(root, '..');
  const env = { ...readDotEnvFile(path.join(repoRoot, '.env')), ...process.env };
  const python = String(env.PYTHON || env.PYTHON_EXE || 'python');
  const assetsDir = path.join(root, 'assets');
  const manifestPath = path.join(assetsDir, 'runtime_gameplay_manifest.json');

  server.middlewares.use('/__gameplay', async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }

      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname.replace(/^\/+/, '');
      if (pathname && pathname !== 'manifest') {
        sendJson(res, 404, { ok: false, error: 'unknown gameplay endpoint' });
        return;
      }

      const body = req.method === 'POST' ? await readRequestJson(req, 128 * 1024) : {};
      const refresh =
        body.refresh === true ||
        url.searchParams.get('refresh') === '1' ||
        url.searchParams.get('refresh') === 'true';

      if (!refresh && fs.existsSync(manifestPath)) {
        try {
          sendJson(res, 200, JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
          return;
        } catch {
          // Fall through and rebuild below.
        }
      }

      const host = String(body.host || url.searchParams.get('host') || env.FIVEM_REMOTE_HOST || 'peyton@192.168.0.85');
      const serverRoot = String(body.serverRoot || url.searchParams.get('serverRoot') || env.FIVEM_SERVER_ROOT || '/data/NexusAI/fivem_server');
      const args = [
        path.join(repoRoot, 'import_remote_fivem_gameplay.py'),
        '--host',
        host,
        '--server-root',
        serverRoot,
        '--assets-dir',
        assetsDir,
        '--pretty',
      ];
      if (body.noDb === true || url.searchParams.get('noDb') === '1') args.push('--no-db');
      const maxFiles = Number(body.maxFiles || url.searchParams.get('maxFiles') || 180);
      if (Number.isFinite(maxFiles)) args.push('--max-files', String(Math.max(1, Math.min(1000, Math.floor(maxFiles)))));

      let result = null;
      try {
        result = await runProcess(python, args, { cwd: repoRoot, timeoutMs: 3 * 60 * 1000 });
      } catch (e) {
        if (fs.existsSync(manifestPath)) {
          const payload = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          payload.endpointWarning = String(e?.message || e || 'gameplay manifest refresh failed');
          payload.endpointStdout = e?.stdout || '';
          payload.endpointStderr = e?.stderr || '';
          sendJson(res, 200, payload);
          return;
        }
        throw e;
      }

      const payload = fs.existsSync(manifestPath)
        ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        : { ok: false, error: 'gameplay importer did not write runtime_gameplay_manifest.json' };
      const summary = String(result?.stdout || '').trim();
      payload.importer = summary ? JSON.parse(summary) : null;
      sendJson(res, payload?.ok ? 200 : 500, payload);
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: String(e?.message || e || 'gameplay manifest failed'),
        stdout: e?.stdout || '',
        stderr: e?.stderr || '',
      });
    }
  });
}

// IMPORTANT:
// - We keep `dist/assets/` for large runtime/exported GTA assets (terrain_info.json, textures, models, etc.)
// - We move Vite's bundled JS/CSS output out of `dist/assets/` so our postbuild sync doesn't overwrite it.
export default defineConfig({
  // Make built asset URLs relative (e.g. "./bundled/xxx.js") so the viewer can be hosted
  // under a subpath without breaking absolute "/bundled/..." references.
  base: './',
  plugins: [
    {
      name: 'webglgta-live-export',
      configureServer(server) {
        const root = path.resolve(__dirname);
        installLiveExportEndpoint(server, root);
        installSpawnEndpoint(server, root);
        installGameplayEndpoint(server, root);
        installMultiplayerServer(server.httpServer);
      },
      configurePreviewServer(server) {
        const root = path.resolve(__dirname);
        installLiveExportEndpoint(server, root);
        installSpawnEndpoint(server, root);
        installGameplayEndpoint(server, root);
        installMultiplayerServer(server.httpServer);
      },
    },
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
        clothing: path.resolve(__dirname, 'clothing.html'),
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


