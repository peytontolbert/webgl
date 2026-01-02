// Web Worker: fetch + parse a large JSON manifest off the main thread.
// This avoids freezing the UI when assets/models/manifest.json is ~tens of MB.

import { fetchJSON } from './asset_fetcher.js';

self.onmessage = async (e) => {
  const msg = e?.data || {};
  const url = String(msg.url || '');
  if (!url) {
    self.postMessage({ ok: false, error: 'manifest_worker: missing url' });
    return;
  }

  try {
    // Use the shared fetch helper for consistency (cache + concurrency limits).
    // Parsing still happens in the worker so it won’t freeze the UI thread.
    const data = await fetchJSON(url, { usePersistentCache: true, useMemoryCache: false, priority: 'high' });
    self.postMessage({ ok: true, data });
  } catch (err) {
    self.postMessage({ ok: false, error: (err && (err.stack || err.message)) ? (err.stack || err.message) : String(err) });
  }
};


