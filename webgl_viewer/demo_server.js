import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMultiplayerServer } from './multiplayer_server.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const host = process.env.DEMO_HOST || '0.0.0.0';
const port = Math.max(1, Math.min(65535, Number(process.env.DEMO_PORT) || 5173));
const clothingSelectionFile = path.join(root, 'data', 'clothing_selection.json');
const clothingPreviewStatusFile = path.join(root, 'data', 'clothing_preview_status.json');
const tlsCertPath = String(process.env.DEMO_TLS_CERT || '').trim();
const tlsKeyPath = String(process.env.DEMO_TLS_KEY || '').trim();

const MIME_TYPES = {
  '.bin': 'application/octet-stream',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function serveFile(request, response, file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  const extension = path.extname(file).toLowerCase();
  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': extension === '.html' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600',
    'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
  };
  const range = String(request.headers.range || '').match(/^bytes=(\d+)-(\d*)$/);
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
  else fs.createReadStream(file, { start, end }).pipe(response);
  return true;
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
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) request.destroy();
    });
    request.on('end', () => {
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
    if (!serveFile(request, response, path.join(dist, 'index.html'))) {
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
  if (pathname.startsWith('/assets/') || pathname.startsWith('/bundled/')) {
    let file = '';
    try { file = path.resolve(dist, `.${decodeURIComponent(pathname)}`); } catch { /* reject */ }
    if (!file.startsWith(`${dist}${path.sep}`) || !serveFile(request, response, file)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
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
