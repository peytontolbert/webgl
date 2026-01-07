/**
 * Shared asset fetch helpers with:
 * - In-flight de-dupe (same URL + same type only fetches once)
 * - Optional persistent caching via Cache Storage (no service worker required)
 * - Global concurrency limiting to avoid ERR_INSUFFICIENT_RESOURCES when streaming many chunks
 *
 * Notes:
 * - Cache Storage is only available in secure contexts (https/localhost). We fall back automatically.
 * - Bump CACHE_NAME when changing asset formats to force a clean slate.
 */

// Bump this whenever we change asset generation or want to invalidate stale cached assets.
// This fixes issues like "terrain_info.json still shows num_textures=0" after re-export.
const CACHE_NAME = 'webglgta-assets-v3';
const DEFAULT_CONCURRENCY = 24;
const DEFAULT_HIGH_SHARE = 0.7; // reserve ~70% capacity for high-priority work when there is backlog

let _concurrency = DEFAULT_CONCURRENCY;
let _highShare = DEFAULT_HIGH_SHARE;
let _activeHigh = 0;
let _activeLow = 0;
// Scheduler tie-break counter (used for deterministic weighted fairness when concurrency is tiny).
let _laneCounter = 0;
/** @type {Array<() => void>} */
const _queueHigh = [];
const _queueLow = [];

/** @type {Map<string, Promise<any>>} */
const _inflight = new Map(); // key = `${as}:${url}`

/** @type {Map<string, any>} */
const _memJson = new Map(); // url -> parsed json

function _supportsDecompressionStream(kind) {
  try {
    if (typeof DecompressionStream !== 'function') return false;
    // Some environments may expose the constructor but not support specific formats.
    // eslint-disable-next-line no-new
    new DecompressionStream(String(kind || ''));
    return true;
  } catch {
    return false;
  }
}

async function _fetchAndDecompressToArrayBuffer(url, { usePersistentCache = true, priority = 'high', compression = 'gzip', signal = undefined } = {}) {
  const resp = await _fetchResponse(url, { usePersistentCache, priority, signal });
  if (!resp.ok) return resp;

  // Prefer streaming decompression when available.
  const body = resp.body;
  if (body && typeof body.pipeThrough === 'function' && _supportsDecompressionStream(compression)) {
    const ds = new DecompressionStream(compression);
    const stream = body.pipeThrough(ds);
    const ab = await new Response(stream).arrayBuffer();
    return ab;
  }

  // If we can't stream-decompress, we can't decode compressed payloads without extra deps.
  // Callers should fall back to the raw (uncompressed) URL in that case.
  throw new Error(`Compressed fetch requires DecompressionStream(${compression}) support`);
}

function _supportsCacheStorage() {
  try {
    return typeof caches !== 'undefined' && typeof caches.open === 'function';
  } catch {
    return false;
  }
}

export function supportsAssetCacheStorage() {
  return _supportsCacheStorage();
}

function _cacheableUrl(url) {
  const u = String(url || '');
  // Only cache our local assets (avoid surprising behavior for remote URLs).
  return u.startsWith('assets/') || u.startsWith('/assets/');
}

function _schedule(fn) {
  // Back-compat: old call sites used _schedule(fn) with no priority.
  return _scheduleWithPriority(fn, 'high');
}

function _scheduleWithPriority(fn, priority) {
  return new Promise((resolve, reject) => {
    const run = () => {
      if (priority === 'low') _activeLow++;
      else _activeHigh++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          if (priority === 'low') _activeLow--;
          else _activeHigh--;

          // Drain queued work while ensuring LOW priority can still make progress.
          // Previously we always drained high first, which could starve low forever
          // when streaming keeps a continuous high backlog (textures would stay "loading" indefinitely).
          const pickNext = () => {
            const hasHigh = _queueHigh.length > 0;
            const hasLow = _queueLow.length > 0;
            if (!hasHigh && !hasLow) return null;
            if (!hasHigh) return _queueLow.shift();
            if (!hasLow) return _queueHigh.shift();

            // Both lanes have backlog:
            // - Ensure high-priority can always claim its reserved share (avoid "high never starts" if low arrived first).
            // - Still allow low-priority to make progress.
            //
            // With very small concurrency (e.g. 1), a pure "maxLow" gate can accidentally starve high (or low).
            // Use deterministic weighted selection in that case.
            if (_concurrency <= 1) {
              const period = 100;
              const highCutoff = Math.max(1, Math.min(period - 1, Math.round(period * _highShare)));
              _laneCounter = (_laneCounter + 1) % period;
              if (_laneCounter < highCutoff) return _queueHigh.shift();
              return _queueLow.shift();
            }

            // Reserve some capacity for high, but allow low to run up to maxLow concurrent tasks.
            const maxLow = Math.max(1, Math.floor(_concurrency * (1.0 - _highShare)));
            const minHigh = Math.max(1, _concurrency - maxLow);
            if (_activeHigh < minHigh) return _queueHigh.shift();
            if (_activeLow < maxLow) return _queueLow.shift();
            return _queueHigh.shift();
          };

          const next = pickNext();
          if (next) next();
        });
    };

    const totalActive = _activeHigh + _activeLow;
    const want = (priority === 'low') ? 'low' : 'high';

    if (totalActive < _concurrency) {
      if (want === 'high') {
        run();
        return;
      }

      // Low lane: when high backlog exists, cap low concurrency so high never starves.
      const highBacklog = _queueHigh.length > 0;
      if (!highBacklog) {
        run();
        return;
      }

      // If we have spare capacity but high is queued, prefer filling reserved high capacity
      // before letting new low work start.
      if (_concurrency <= 1) {
        run();
        return;
      }

      const maxLow = Math.max(1, Math.floor(_concurrency * (1.0 - _highShare)));
      const minHigh = Math.max(1, _concurrency - maxLow);
      if (_activeHigh < minHigh) {
        const nextHigh = _queueHigh.shift();
        if (nextHigh) nextHigh();
        // Queue this low request below.
      } else if (_activeLow < maxLow) {
        run();
        return;
      }
    }

    if (want === 'high') _queueHigh.push(run);
    else _queueLow.push(run);
  });
}

async function _getCache() {
  if (!_supportsCacheStorage()) return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

async function _fetchResponse(url, { usePersistentCache = true, priority = 'high', signal = undefined } = {}) {
  const u = String(url || '');
  if (!u) throw new Error('fetchResponse: empty url');

  const canCache = usePersistentCache && _cacheableUrl(u);
  const cache = canCache ? await _getCache() : null;

  if (cache) {
    const cached = await cache.match(u);
    if (cached) return cached.clone();
  }

  // Avoid "too many outstanding requests" by limiting concurrency.
  // If a caller provides an AbortSignal, respect it:
  // - If it's already aborted, fail fast.
  // - Pass it through to fetch() so the browser can abort the request.
  if (signal?.aborted) {
    // Match fetch() AbortError shape as closely as possible.
    throw new DOMException('Aborted', 'AbortError');
  }
  const resp = await _scheduleWithPriority(() => fetch(u, signal ? { signal } : undefined), priority);
  if (!resp.ok) return resp;

  if (cache) {
    try {
      // Avoid poisoning Cache Storage with HTML fallback responses (common with SPA/static hosts).
      // If an asset URL (like a texture) is missing and the server returns index.html with 200,
      // caching it will make future loads "succeed" at the network layer but fail at decode time.
      const ct = String(resp.headers?.get?.('content-type') || '').toLowerCase();
      const looksHtml = ct.includes('text/html') || ct.includes('application/xhtml');
      if (!looksHtml) {
        await cache.put(u, resp.clone());
      }
    } catch {
      // Ignore quota/put errors.
    }
  }
  return resp;
}

export function setAssetFetchConcurrency(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return;
  _concurrency = Math.max(1, Math.min(128, Math.floor(v)));
}

export function setAssetFetchPriorityConfig({ highShare } = {}) {
  const hs = Number(highShare);
  if (Number.isFinite(hs)) _highShare = Math.max(0.05, Math.min(0.95, hs));
}

export async function clearAssetCacheStorage() {
  if (!_supportsCacheStorage()) return false;
  try {
    return await caches.delete(CACHE_NAME);
  } catch {
    return false;
  }
}

export async function deleteAssetCacheEntry(url) {
  // Remove a single URL from Cache Storage (best-effort).
  // Useful when an entry becomes corrupted (e.g. Content-Length mismatch / truncated body).
  const u = String(url || '');
  if (!u) return false;
  if (!_supportsCacheStorage()) return false;
  try {
    const cache = await _getCache();
    if (!cache) return false;
    return await cache.delete(u);
  } catch {
    return false;
  }
}

export function clearAssetMemoryCaches() {
  try {
    _memJson.clear();
  } catch {
    // ignore
  }
  try {
    _inflight.clear();
  } catch {
    // ignore
  }
}

export async function fetchJSON(url, { usePersistentCache = true, useMemoryCache = true, priority = 'high', signal = undefined } = {}) {
  const u = String(url || '');
  if (!u) throw new Error('fetchJSON: empty url');
  // When a caller provides an AbortSignal, treat this request as "caller-owned":
  // - skip global inflight de-dupe (otherwise one caller aborting could disrupt others)
  // - skip memory caching (to avoid "aborted but cached" edge cases)
  const callerOwned = !!signal;
  if (!callerOwned && useMemoryCache && _memJson.has(u)) return _memJson.get(u);

  const inflightKey = `json:${u}`;
  if (!callerOwned) {
    const existing = _inflight.get(inflightKey);
    if (existing) return await existing;
  }

  const p = (async () => {
    const resp = await _fetchResponse(u, { usePersistentCache, priority, signal });
    if (!resp.ok) throw new Error(`Failed to fetch ${u} (status=${resp.status})`);
    const data = await resp.json();
    if (!callerOwned && useMemoryCache) _memJson.set(u, data);
    return data;
  })();

  if (!callerOwned) _inflight.set(inflightKey, p);
  try {
    return await p;
  } finally {
    if (!callerOwned) _inflight.delete(inflightKey);
  }
}

/**
 * Prefer a gzip sidecar (`<url>.gz`) when the browser supports `DecompressionStream('gzip')`.
 * Falls back to the raw URL if:
 * - the sidecar does not exist (404)
 * - decompression isn't supported
 * - decompression/parsing fails
 */
export async function fetchJSONPreferredCompressed(url, { usePersistentCache = true, useMemoryCache = true, priority = 'high', signal = undefined } = {}) {
  const u = String(url || '');
  if (!u) throw new Error('fetchJSONPreferredCompressed: empty url');
  const callerOwned = !!signal;
  if (!callerOwned && useMemoryCache && _memJson.has(u)) return _memJson.get(u);

  // Only try gzip if the runtime can actually decode it.
  const canGzip = _supportsDecompressionStream('gzip');
  if (canGzip) {
    try {
      const gzUrl = `${u}.gz`;
      const ab = await _fetchAndDecompressToArrayBuffer(gzUrl, { usePersistentCache, priority, compression: 'gzip', signal });
      // If _fetchAndDecompressToArrayBuffer returned a Response (non-ok), it'll throw above; keep defensive.
      if (ab && ab.byteLength !== undefined) {
        const text = new TextDecoder().decode(new Uint8Array(ab));
        const data = JSON.parse(text);
        if (!callerOwned && useMemoryCache) _memJson.set(u, data);
        return data;
      }
    } catch {
      // Fall back to raw URL.
    }
  }

  return await fetchJSON(u, { usePersistentCache, useMemoryCache, priority, signal });
}

export async function fetchText(url, { usePersistentCache = true, priority = 'high', signal = undefined } = {}) {
  const u = String(url || '');
  if (!u) throw new Error('fetchText: empty url');

  const callerOwned = !!signal;
  const inflightKey = `text:${u}`;
  if (!callerOwned) {
    const existing = _inflight.get(inflightKey);
    if (existing) return await existing;
  }

  const p = (async () => {
    const resp = await _fetchResponse(u, { usePersistentCache, priority, signal });
    if (!resp.ok) throw new Error(`Failed to fetch ${u} (status=${resp.status})`);
    return await resp.text();
  })();

  if (!callerOwned) _inflight.set(inflightKey, p);
  try {
    return await p;
  } finally {
    if (!callerOwned) _inflight.delete(inflightKey);
  }
}

// NOTE: `fetchArrayBuffer()` already exists later in this file (back-compat signature),
// along with `fetchArrayBufferWithPriority()` and `fetchArrayBufferPreferredCompressed()`.
// Keep a single definition to avoid "Identifier has already been declared" at module parse time.

/**
 * Stream-parse NDJSON/JSONL from a URL and invoke onObject(obj) for each parsed JSON object.
 *
 * Benefits vs fetchText()+split:
 * - avoids allocating a giant string for the whole file
 * - avoids duplicating memory via split()
 * - starts parsing before the download finishes (lower latency)
 *
 * Notes:
 * - Still parses JSON on the main thread. For extreme loads, move parsing into a Web Worker.
 */
export async function fetchNDJSON(url, { usePersistentCache = true, priority = 'high', onObject, signal = undefined } = {}) {
  const u = String(url || '');
  if (!u) throw new Error('fetchNDJSON: empty url');
  if (typeof onObject !== 'function') throw new Error('fetchNDJSON: onObject callback is required');

  const callerOwned = !!signal;
  const inflightKey = `ndjson:${u}`;
  if (!callerOwned) {
    const existing = _inflight.get(inflightKey);
    if (existing) return await existing;
  }

  const p = (async () => {
    const resp = await _fetchResponse(u, { usePersistentCache, priority, signal });
    if (!resp.ok) throw new Error(`Failed to fetch ${u} (status=${resp.status})`);

    // Streaming path (modern browsers).
    const body = resp.body;
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let parsed = 0;

      while (true) {
        if (signal?.aborted) {
          try { await reader.cancel(); } catch { /* ignore */ }
          throw new DOMException('Aborted', 'AbortError');
        }
        const { value, done } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: !done });

        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            onObject(JSON.parse(line));
            parsed++;
          } catch {
            // ignore bad line
          }
        }

        if (done) break;
      }

      const tail = buf.trim();
      if (tail) {
        try {
          onObject(JSON.parse(tail));
          parsed++;
        } catch {
          // ignore
        }
      }

      return { parsed };
    }

    // Fallback: no streaming body available.
    const text = await resp.text();
    let parsed = 0;
    for (const line of text.split('\n')) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const s = (line || '').trim();
      if (!s) continue;
      try {
        onObject(JSON.parse(s));
        parsed++;
      } catch {
        // ignore
      }
    }
    return { parsed };
  })();

  if (!callerOwned) _inflight.set(inflightKey, p);
  try {
    return await p;
  } finally {
    if (!callerOwned) _inflight.delete(inflightKey);
  }
}

/**
 * Stream raw bytes from a URL and invoke onChunk(Uint8Array) as data arrives.
 *
 * This is useful when the main thread wants to forward bytes to a Worker without
 * decoding/parsing on the UI thread.
 *
 * Notes:
 * - Uses the same concurrency limiting + optional CacheStorage as other fetch helpers.
 * - onChunk is called with Uint8Array views; callers can transfer chunk.buffer.
 */
export async function fetchStreamBytes(url, { usePersistentCache = true, priority = 'high', onChunk, signal = undefined } = {}) {
  const u = String(url || '');
  if (!u) throw new Error('fetchStreamBytes: empty url');
  if (typeof onChunk !== 'function') throw new Error('fetchStreamBytes: onChunk callback is required');

  const resp = await _fetchResponse(u, { usePersistentCache, priority, signal });
  if (!resp.ok) throw new Error(`Failed to fetch ${u} (status=${resp.status})`);

  const body = resp.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    while (true) {
      if (signal?.aborted) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new DOMException('Aborted', 'AbortError');
      }
      const { value, done } = await reader.read();
      if (value && value.byteLength) onChunk(value);
      if (done) break;
    }
    return;
  }

  // Fallback: no streaming body available.
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const buf = await resp.arrayBuffer();
  onChunk(new Uint8Array(buf));
}

export async function fetchArrayBuffer(url, { usePersistentCache = true, signal = undefined } = {}) {
  // Back-compat: keep signature stable; treat as high priority by default.
  const u = String(url || '');
  if (!u) throw new Error('fetchArrayBuffer: empty url');

  const callerOwned = !!signal;
  const inflightKey = `ab:${u}`;
  if (!callerOwned) {
    const existing = _inflight.get(inflightKey);
    if (existing) return await existing;
  }

  const p = (async () => {
    const resp = await _fetchResponse(u, { usePersistentCache, priority: 'high', signal });
    if (!resp.ok) throw new Error(`Failed to fetch ${u} (status=${resp.status})`);
    return await resp.arrayBuffer();
  })();

  if (!callerOwned) _inflight.set(inflightKey, p);
  try {
    return await p;
  } finally {
    if (!callerOwned) _inflight.delete(inflightKey);
  }
}

export async function fetchArrayBufferWithPriority(url, { usePersistentCache = true, priority = 'high', signal = undefined } = {}) {
  const u = String(url || '');
  if (!u) throw new Error('fetchArrayBufferWithPriority: empty url');

  const callerOwned = !!signal;
  const inflightKey = `abp:${priority}:${u}`;
  if (!callerOwned) {
    const existing = _inflight.get(inflightKey);
    if (existing) return await existing;
  }

  const p = (async () => {
    const resp = await _fetchResponse(u, { usePersistentCache, priority, signal });
    if (!resp.ok) throw new Error(`Failed to fetch ${u} (status=${resp.status})`);
    return await resp.arrayBuffer();
  })();

  if (!callerOwned) _inflight.set(inflightKey, p);
  try {
    return await p;
  } finally {
    if (!callerOwned) _inflight.delete(inflightKey);
  }
}

/**
 * Prefer a gzip sidecar (`<url>.gz`) when supported, else fall back to the raw URL.
 * Useful for large `.bin` or `.json` payloads that we want to ship pre-compressed without relying on server headers.
 */
export async function fetchArrayBufferPreferredCompressed(url, { usePersistentCache = true, priority = 'high', signal = undefined } = {}) {
  const u = String(url || '');
  if (!u) throw new Error('fetchArrayBufferPreferredCompressed: empty url');

  const canGzip = _supportsDecompressionStream('gzip');
  if (canGzip) {
    try {
      const gzUrl = `${u}.gz`;
      const ab = await _fetchAndDecompressToArrayBuffer(gzUrl, { usePersistentCache, priority, compression: 'gzip', signal });
      if (ab && ab.byteLength !== undefined) return ab;
    } catch {
      // Fall back to raw URL.
    }
  }

  return await fetchArrayBufferWithPriority(u, { usePersistentCache, priority, signal });
}

export async function fetchBlob(url, { usePersistentCache = true, priority = 'high', signal = undefined } = {}) {
  const u = String(url || '');
  if (!u) throw new Error('fetchBlob: empty url');

  const callerOwned = !!signal;
  const inflightKey = `blob:${u}`;
  if (!callerOwned) {
    const existing = _inflight.get(inflightKey);
    if (existing) return await existing;
  }

  const p = (async () => {
    const resp = await _fetchResponse(u, { usePersistentCache, priority, signal });
    if (!resp.ok) throw new Error(`Failed to fetch ${u} (status=${resp.status})`);
    return await resp.blob();
  })();

  if (!callerOwned) _inflight.set(inflightKey, p);
  try {
    return await p;
  } finally {
    if (!callerOwned) _inflight.delete(inflightKey);
  }
}


