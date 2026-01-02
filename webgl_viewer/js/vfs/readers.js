/**
 * Minimal random-access readers for the browser.
 *
 * Design goals:
 * - Works with local files picked by the user (File / Blob)
 * - Works with HTTP range (server must support `Range` + CORS)
 *
 * A reader exposes:
 * - size: total byte size (number)
 * - read(offset, length): Promise<Uint8Array>
 */

export class FileBlobReader {
  /**
   * @param {File|Blob} file
   */
  constructor(file) {
    if (!file) throw new Error('FileBlobReader: missing file');
    this._file = file;
    this.size = Number(file.size) || 0;
  }

  /**
   * @param {number} offset
   * @param {number} length
   * @returns {Promise<Uint8Array>}
   */
  async read(offset, length) {
    const off = Math.max(0, Math.floor(Number(offset) || 0));
    const len = Math.max(0, Math.floor(Number(length) || 0));
    if (len === 0) return new Uint8Array(0);
    const end = Math.min(this.size, off + len);
    const ab = await this._file.slice(off, end).arrayBuffer();
    return new Uint8Array(ab);
  }
}

export class HttpRangeReader {
  /**
   * @param {string} url
   * @param {{ size?: number, headers?: Record<string,string> }} [opts]
   */
  constructor(url, opts = {}) {
    const u = String(url || '');
    if (!u) throw new Error('HttpRangeReader: missing url');
    this.url = u;
    this.size = Number(opts.size) || 0; // optional; can be discovered via HEAD/GET
    this._headers = (opts && opts.headers && typeof opts.headers === 'object') ? opts.headers : {};
  }

  async _ensureSize() {
    if (this.size > 0) return this.size;
    // Try HEAD first.
    try {
      const resp = await fetch(this.url, { method: 'HEAD', headers: this._headers });
      if (resp.ok) {
        const cl = resp.headers.get('content-length');
        const n = Number(cl);
        if (Number.isFinite(n) && n > 0) {
          this.size = n;
          return n;
        }
      }
    } catch {
      // ignore
    }
    // Fallback: a range request for byte 0.
    const resp = await fetch(this.url, {
      method: 'GET',
      headers: { ...this._headers, Range: 'bytes=0-0' },
    });
    if (!resp.ok && resp.status !== 206) throw new Error(`HttpRangeReader: failed to probe size (status=${resp.status})`);
    const cr = resp.headers.get('content-range'); // bytes 0-0/123
    if (cr) {
      const m = /\/(\d+)\s*$/.exec(cr);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 0) {
          this.size = n;
          return n;
        }
      }
    }
    throw new Error('HttpRangeReader: could not determine size (no Content-Length/Content-Range)');
  }

  /**
   * @param {number} offset
   * @param {number} length
   * @returns {Promise<Uint8Array>}
   */
  async read(offset, length) {
    const off = Math.max(0, Math.floor(Number(offset) || 0));
    const len = Math.max(0, Math.floor(Number(length) || 0));
    if (len === 0) return new Uint8Array(0);
    const size = await this._ensureSize();
    const end = Math.min(size - 1, off + len - 1);
    if (end < off) return new Uint8Array(0);

    const resp = await fetch(this.url, {
      method: 'GET',
      headers: { ...this._headers, Range: `bytes=${off}-${end}` },
    });
    if (!(resp.ok || resp.status === 206)) throw new Error(`HttpRangeReader: range read failed (status=${resp.status})`);
    const ab = await resp.arrayBuffer();
    return new Uint8Array(ab);
  }
}


