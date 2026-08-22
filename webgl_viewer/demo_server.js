import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMultiplayerServer } from './multiplayer_server.js';

const root = path.dirname(fileURLToPath(import.meta.url));
// `/demo` is the compact runtime. The full build is generated separately and
// must be selected explicitly when it is needed.
const dist = path.resolve(root, process.env.DEMO_DIST_ROOT || 'dist-thin');
if (dist !== root && !dist.startsWith(root + path.sep)) {
  throw new Error('DEMO_DIST_ROOT must resolve inside the project root');
}
const sourceAssets = path.join(root, 'assets');
const extensionsRoot = path.join(root, 'nexus_extensions');
// Production keeps Guardian beside this server; the local viewer keeps it at
// the repository root. Resolve the canonical bundle in either layout.
const guardianRoot = fs.existsSync(path.join(root, 'guardian'))
  ? path.join(root, 'guardian')
  : path.resolve(root, '..', 'guardian');
const duckGameRoot = path.join(root, 'duck-game');
const host = process.env.DEMO_HOST || '0.0.0.0';
const port = Math.max(1, Math.min(65535, Number(process.env.DEMO_PORT) || 5173));
const clothingSelectionFile = path.join(root, 'data', 'clothing_selection.json');
const clothingPreviewStatusFile = path.join(root, 'data', 'clothing_preview_status.json');
const tlsCertPath = String(process.env.DEMO_TLS_CERT || '').trim();
const tlsKeyPath = String(process.env.DEMO_TLS_KEY || '').trim();

const MIME_TYPES = {
  '.bin': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
};

const NEXUS_BOOT_MARKER = '<!-- nexus-staged-boot -->';
const NEXUS_BOOT_TAGS = [
  'nexus_bootstrap_dispatcher.js',
  'nexus_client_performance.js',
  'nexus_character_select.js',
  'nexus_demo_boundary_recovery.js',
  'nexus_loading.js',
  'nexus_interaction_shell.js',
  'nexus_laptop.js',
  'nexus_track_asset_picker.js',
  'nexus_deferred_extensions.js',
].map((name) => `  <script type="module" src="/nexus_extensions/${name}"></script>`).join('\n');

function serveDemoIndex(request, response, file) {
  let html;
  try { html = fs.readFileSync(file, 'utf8'); } catch { return false; }
  if (!html.includes(NEXUS_BOOT_MARKER)) {
    const entry = /  <script type="module"(?: crossorigin)? src="(?:\.\/bundled\/main-[^"?]+\.js|js\/main\.js)(?:\?[^\"]*)?"><\/script>/;
    if (!entry.test(html)) return false;
    html = html.replace(entry, `${NEXUS_BOOT_MARKER}\n${NEXUS_BOOT_TAGS}\n$&`);
  }
  const body = Buffer.from(html, 'utf8');
  response.writeHead(200, {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(body.length),
  });
  if (request.method === 'HEAD') response.end();
  else response.end(body);
  return true;
}

function serveFile(request, response, file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  const extension = path.extname(file).toLowerCase();
  const range = String(request.headers.range || '').match(/^bytes=(\d+)-(\d*)$/);
  const acceptsBrotli = /(?:^|,)\s*br(?:\s*;|\s*,|$)/i.test(String(request.headers['accept-encoding'] || ''));
  const brotliFile = `${file}.br`;
  let servedFile = file;
  if (!range && acceptsBrotli) {
    try {
      const brotliStat = fs.statSync(brotliFile);
      if (brotliStat.isFile() && brotliStat.mtimeMs >= stat.mtimeMs) {
        servedFile = brotliFile;
        stat = brotliStat;
      }
    } catch { /* fall back to the identity representation */ }
  }
  const headers = {
    'Accept-Ranges': 'bytes',
    // Manifests and texture indexes can be updated in-place in the thin demo.
    // Revalidate JSON on refresh so a running client does not retain an old
    // asset closure while hashed media and JavaScript remain cacheable.
    'Cache-Control': (extension === '.html' || extension === '.json' || extension === '.js')
      ? 'no-cache, no-store, must-revalidate'
      : 'public, max-age=3600',
    'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
    Vary: 'Accept-Encoding',
  };
  if (servedFile === brotliFile) headers['Content-Encoding'] = 'br';
  // Empty placeholder assets occur in compact exports. A read stream cannot
  // accept an end offset of -1, so answer them directly instead of crashing
  // the entire demo process.
  if (stat.size === 0) {
    headers['Content-Length'] = '0';
    response.writeHead(200, headers);
    response.end();
    return true;
  }
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (range) {
    start = Math.max(0, Math.min(end, Number(range[1]) || 0));
    end = range[2] ? Math.max(start, Math.min(end, Number(range[2]) || end)) : end;
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  response.writeHead(status, headers);
  if (request.method === 'HEAD') response.end();
  else {
    const stream = fs.createReadStream(servedFile, { start, end });
    // A deployment may replace an asset after stat() but before the stream is
    // opened. Contain that per-request failure instead of taking down Node.
    stream.once('error', (error) => {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Asset stream failed');
      } else {
        response.destroy(error);
      }
    });
    stream.pipe(response);
  }
  return true;
}

function resolveContainedFile(rootDir, relativePath) {
  const file = path.resolve(rootDir, relativePath);
  return file.startsWith(`${rootDir}${path.sep}`) ? file : '';
}

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  throw new Error('dist/index.html is missing; run npm run build before starting the demo server');
}

if (!!tlsCertPath !== !!tlsKeyPath) {
  throw new Error('DEMO_TLS_CERT and DEMO_TLS_KEY must be configured together');
}
if (tlsCertPath && (!fs.existsSync(tlsCertPath) || !fs.existsSync(tlsKeyPath))) {
  throw new Error('Configured demo TLS certificate or key does not exist');
}

const requestHandler = (request, response) => {
  let pathname = '/';
  try { pathname = new URL(request.url || '/', 'http://localhost').pathname; } catch { /* use root */ }
  if (pathname === '/__clothing_selection' && request.method === 'POST') {
    let body = '';
    let rejected = false;
    request.on('data', (chunk) => {
      if (rejected) return;
      body += chunk;
      if (body.length > 2_000_000) {
        rejected = true;
        response.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: false, error: 'Selection payload exceeds 2 MB' }));
      }
    });
    request.on('end', () => {
      if (rejected) return;
      try {
        const payload = JSON.parse(body || '{}');
        if (payload.schema !== 'webglgta-clothingpack5m-selection-v1' || !Array.isArray(payload.items)) throw new Error('Invalid clothing selection');
        payload.items = payload.items.slice(0, 500);
        fs.mkdirSync(path.dirname(clothingSelectionFile), { recursive: true });
        fs.writeFileSync(clothingSelectionFile, JSON.stringify(payload, null, 2), 'utf8');
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true, items: payload.items.length }));
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
      }
    });
    request.on('error', () => {
      if (rejected || response.headersSent) return;
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: 'Invalid selection request' }));
    });
    return;
  }
  if (pathname === '/__clothing_preview_status' && request.method === 'GET') {
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
    try { response.end(fs.readFileSync(clothingPreviewStatusFile, 'utf8')); }
    catch { response.end(JSON.stringify({ state: 'offline', detail: 'Preview worker has not reported yet' })); }
    return;
  }
  if (pathname === '/') {
    response.writeHead(302, { Location: '/demo' });
    response.end();
    return;
  }
  if (pathname === '/demo' || pathname === '/demo/') {
    if (!serveDemoIndex(request, response, path.join(dist, 'index.html'))) {
      response.writeHead(500);
      response.end('Demo entry point unavailable');
    }
    return;
  }
  if (pathname === '/clothing' || pathname === '/clothing/') {
    if (!serveFile(request, response, path.join(dist, 'clothing.html'))) {
      response.writeHead(500);
      response.end('Clothing catalog unavailable');
    }
    return;
  }
  if (pathname.startsWith('/guardian/')) {
    let decoded = '';
    try { decoded = decodeURIComponent(pathname); } catch { /* reject */ }
    const file = resolveContainedFile(guardianRoot, decoded.slice('/guardian/'.length));
    if (file && serveFile(request, response, file)) return;
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Guardian app not found');
    return;
  }
  if (pathname.startsWith('/duck-game/')) {
    let decoded = '';
    try { decoded = decodeURIComponent(pathname); } catch { /* reject */ }
    const file = resolveContainedFile(duckGameRoot, decoded.slice('/duck-game/'.length));
    if (file && serveFile(request, response, file)) return;
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Duck Game app not found');
    return;
  }
  if (pathname.startsWith('/nexus_extensions/')) {
    let decoded = '';
    try { decoded = decodeURIComponent(pathname); } catch { /* reject */ }
    const file = resolveContainedFile(extensionsRoot, decoded.slice('/nexus_extensions/'.length));
    if (file && serveFile(request, response, file)) return;
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Extension not found');
    return;
  }
  if (pathname.startsWith('/assets/') || pathname.startsWith('/bundled/')) {
    let decoded = '';
    try { decoded = decodeURIComponent(pathname); } catch { /* reject */ }
    if (decoded.startsWith('/assets/')) {
      const relative = decoded.slice('/assets/'.length);
      // The selected runtime owns the complete world closure. Falling back to
      // source for /assets/demo would mix an older district descriptor or its
      // collision/entity packs into a newer deployment, which is unsafe.
      // Non-world assets may still fall back individually for thin deploys.
      const sourceFile = resolveContainedFile(sourceAssets, relative);
      const distFile = resolveContainedFile(path.join(dist, 'assets'), relative);
      if (distFile && serveFile(request, response, distFile)) return;
      if (!relative.startsWith('demo/') && sourceFile && serveFile(request, response, sourceFile)) return;
    } else {
      const file = resolveContainedFile(dist, `.${decoded}`);
      if (file && serveFile(request, response, file)) return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('This host serves only the WebGL GTA demo');
};

const tlsEnabled = !!tlsCertPath;
const server = tlsEnabled
  ? https.createServer({ cert: fs.readFileSync(tlsCertPath), key: fs.readFileSync(tlsKeyPath) }, requestHandler)
  : http.createServer(requestHandler);

installMultiplayerServer(server);
server.listen(port, host, () => {
  console.log(`WebGL GTA demo listening on ${tlsEnabled ? 'https' : 'http'}://${host}:${port}/demo`);
});

export { server };
