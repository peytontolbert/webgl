// Web Worker: fetch + parse a large JSON manifest off the main thread.
// This avoids freezing the UI when assets/models/manifest.json is ~tens of MB.

self.onmessage = async (e) => {
  const msg = e?.data || {};
  const url = String(msg.url || '');
  if (!url) {
    self.postMessage({ ok: false, error: 'manifest_worker: missing url' });
    return;
  }

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      self.postMessage({ ok: false, error: `Failed to fetch ${url} (status=${resp.status})` });
      return;
    }

    // Use Response.json() in the worker; parsing still needs full data, but doesn’t block the UI thread.
    const data = await resp.json();
    self.postMessage({ ok: true, data });
  } catch (err) {
    self.postMessage({ ok: false, error: (err && (err.stack || err.message)) ? (err.stack || err.message) : String(err) });
  }
};


