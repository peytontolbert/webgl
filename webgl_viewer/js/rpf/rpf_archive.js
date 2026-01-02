/**
 * Minimal RPF7 archive reader (CodeWalker-compatible).
 *
 * Scope:
 * - Parses RPF7 header + entry table + names table
 * - Builds a path->entry index
 * - Extracts raw file bytes (optionally deflate-decompress when possible)
 *
 * Not implemented (yet):
 * - AES / NG TOC decryption (requires GTA5 keys)
 * - File payload decryption beyond a stub (some entries are encrypted)
 * - Nested RPFs (child rpfs inside rpfs)
 */

const RPF7_MAGIC = 0x52504637; // "RPF7" LE

/** @param {Uint8Array} u8 @param {number} off */
function u32le(u8, off) {
  return (u8[off] | (u8[off + 1] << 8) | (u8[off + 2] << 16) | (u8[off + 3] << 24)) >>> 0;
}
/** @param {Uint8Array} u8 @param {number} off */
function u16le(u8, off) {
  return (u8[off] | (u8[off + 1] << 8)) >>> 0;
}
/** @param {Uint8Array} u8 @param {number} off */
function u24le(u8, off) {
  return (u8[off] | (u8[off + 1] << 8) | (u8[off + 2] << 16)) >>> 0;
}

function normalizePath(p) {
  return String(p || '')
    .replace(/\//g, '\\')
    .replace(/\\+/g, '\\')
    .trim()
    .toLowerCase();
}

function readCString(namesU8, off) {
  const start = Math.max(0, Number(off) || 0);
  let end = start;
  while (end < namesU8.length && namesU8[end] !== 0) end++;
  // Names are ASCII-ish; UTF-8 decoding is fine for the subset.
  try {
    return new TextDecoder('utf-8').decode(namesU8.subarray(start, end));
  } catch {
    // Fallback (latin1-ish)
    let s = '';
    for (let i = start; i < end; i++) s += String.fromCharCode(namesU8[i]);
    return s;
  }
}

async function decompressDeflate(u8) {
  if (!u8 || u8.byteLength === 0) return new Uint8Array(0);
  if (typeof DecompressionStream !== 'function') {
    throw new Error('Deflate decompression requires DecompressionStream support');
  }
  // Browser DecompressionStream supports 'deflate' in modern Chromium/Firefox.
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

export class RpfArchive {
  /**
   * @param {{ read:(offset:number,length:number)=>Promise<Uint8Array>, size:number }} reader
   * @param {{ name?: string, basePath?: string }} [opts]
   */
  constructor(reader, opts = {}) {
    if (!reader || typeof reader.read !== 'function') throw new Error('RpfArchive: invalid reader');
    this.reader = reader;
    this.name = String(opts.name || 'archive.rpf');
    this.basePath = normalizePath(opts.basePath || this.name); // used as root prefix for entries

    this.version = 0;
    this.entryCount = 0;
    this.namesLength = 0;
    this.encryption = 0;

    /** @type {Array<any>} */
    this.entries = [];
    /** @type {Map<string, any>} */
    this.entryByPath = new Map();
    this._namesU8 = null;
  }

  async init() {
    // Header: u32 version, u32 entryCount, u32 namesLen, u32 encryption
    const hdr = await this.reader.read(0, 16);
    if (hdr.byteLength < 16) throw new Error('RpfArchive: truncated header');

    const version = u32le(hdr, 0);
    if (version !== RPF7_MAGIC) {
      throw new Error(`RpfArchive: unsupported magic/version 0x${version.toString(16)}`);
    }
    this.version = version;
    this.entryCount = u32le(hdr, 4);
    this.namesLength = u32le(hdr, 8);
    this.encryption = u32le(hdr, 12);

    // Read entry table + names table. (CodeWalker reads them as raw contiguous blocks.)
    const entriesBytes = this.entryCount * 16;
    const entriesU8 = await this.reader.read(16, entriesBytes);
    if (entriesU8.byteLength < entriesBytes) throw new Error('RpfArchive: truncated entry table');
    const namesU8 = await this.reader.read(16 + entriesBytes, this.namesLength);
    if (namesU8.byteLength < this.namesLength) throw new Error('RpfArchive: truncated names table');

    // Encryption handling:
    // - NONE (0) and OPEN ("OPEN") mean TOC is not encrypted.
    // - AES / NG require GTA5 keys (not implemented here).
    if (!(this.encryption === 0 || this.encryption === 0x4E45504F)) {
      const encHex = `0x${this.encryption.toString(16)}`;
      throw new Error(`RpfArchive: TOC encryption ${encHex} not supported in browser mode yet`);
    }
    this._namesU8 = namesU8;

    // Parse entries.
    this.entries = new Array(this.entryCount);
    for (let i = 0; i < this.entryCount; i++) {
      const off = i * 16;
      const y = u32le(entriesU8, off + 0);
      const x = u32le(entriesU8, off + 4);

      let e = null;
      if (x === 0x7fffff00) {
        e = this._parseDirEntry(entriesU8, off);
        e.kind = 'dir';
      } else if ((x & 0x80000000) === 0) {
        e = this._parseBinaryEntry(entriesU8, off);
        e.kind = 'bin';
      } else {
        e = this._parseResourceEntry(entriesU8, off);
        e.kind = 'res';
      }
      e.h1 = y >>> 0;
      e.h2 = x >>> 0;
      e.index = i;

      e.name = readCString(namesU8, e.nameOffset);
      e.nameLower = String(e.name || '').toLowerCase();
      this.entries[i] = e;
    }

    // Build directory tree paths (CodeWalker style).
    const root = this.entries[0];
    if (!root || root.kind !== 'dir') throw new Error('RpfArchive: entry[0] is not a directory (unexpected)');
    root.path = this.basePath;

    // Walk directory stack; assign paths to children.
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      const start = Number(dir.entriesIndex) || 0;
      const end = start + (Number(dir.entriesCount) || 0);
      for (let j = start; j < end && j < this.entries.length; j++) {
        const child = this.entries[j];
        child.parentIndex = dir.index;
        if (child.kind === 'dir') {
          child.path = `${dir.path}\\${child.nameLower}`;
          stack.push(child);
        } else {
          child.path = `${dir.path}\\${child.nameLower}`;
        }
      }
    }

    // Build lookup map.
    this.entryByPath.clear();
    for (const e of this.entries) {
      if (!e || !e.path) continue;
      this.entryByPath.set(e.path, e);
    }

    return this;
  }

  _parseDirEntry(u8, off) {
    return {
      nameOffset: u32le(u8, off + 0),
      entriesIndex: u32le(u8, off + 8),
      entriesCount: u32le(u8, off + 12),
    };
  }

  _parseBinaryEntry(u8, off) {
    // Packed like CodeWalker:
    // buf (u64 LE): [nameOffset:16][fileSize:24][fileOffset:24]
    const nameOffset = u16le(u8, off + 0);
    const fileSize = u24le(u8, off + 2);
    const fileOffset = u24le(u8, off + 5);
    const fileUncompressedSize = u32le(u8, off + 8);
    const encryptionType = u32le(u8, off + 12);
    const isEncrypted = (encryptionType === 1);
    return {
      nameOffset,
      fileSize,
      fileOffset,
      fileUncompressedSize,
      encryptionType,
      isEncrypted,
    };
  }

  _parseResourceEntry(u8, off) {
    const nameOffset = u16le(u8, off + 0);
    const fileSize = u24le(u8, off + 2);
    const fileOffset = (u24le(u8, off + 5) & 0x7fffff) >>> 0;
    const systemFlags = u32le(u8, off + 8);
    const graphicsFlags = u32le(u8, off + 12);
    // In CodeWalker, resource entries can be encrypted for some types (eg .ysc). We don’t have that detection yet.
    return {
      nameOffset,
      fileSize,
      fileOffset,
      systemFlags,
      graphicsFlags,
      isEncrypted: false,
    };
  }

  /**
   * @param {string} path
   * @returns {any|null}
   */
  getEntry(path) {
    const p = normalizePath(path);
    if (!p) return null;
    // Allow both:
    // - "update.rpf\\common\\data\\..."
    // - "common\\data\\..." (prefixed with basePath)
    if (this.entryByPath.has(p)) return this.entryByPath.get(p);
    const prefixed = `${this.basePath}\\${p}`.replace(/\\+/g, '\\');
    return this.entryByPath.get(prefixed) || null;
  }

  /**
   * Extract a file entry to bytes.
   *
   * Notes:
   * - Offsets are in 512-byte sectors (CodeWalker multiplies by 512).
   * - For compressed binary entries, `fileSize > 0` indicates deflate compression.
   * - For resource entries, CodeWalker skips a 0x10 header then deflates the rest.
   *
   * @param {any} entry
   * @param {{ decompress?: boolean }} [opts]
   * @returns {Promise<Uint8Array>}
   */
  async extractEntry(entry, opts = {}) {
    const e = entry;
    if (!e || !e.kind) throw new Error('RpfArchive.extractEntry: invalid entry');
    if (e.kind === 'dir') throw new Error('RpfArchive.extractEntry: cannot extract a directory');

    const decompress = (opts.decompress === undefined) ? true : !!opts.decompress;
    const sectorOffset = Number(e.fileOffset) || 0;
    const absOffset = sectorOffset * 512;

    if (e.kind === 'bin') {
      // CodeWalker reads compressed size if fileSize > 0 else uncompressed size.
      const storedSize = (Number(e.fileSize) || 0) > 0 ? Number(e.fileSize) : Number(e.fileUncompressedSize || 0);
      const raw = await this.reader.read(absOffset, storedSize);
      if (e.isEncrypted) {
        throw new Error('RpfArchive: encrypted file payloads are not supported in browser mode yet');
      }
      if (decompress && (Number(e.fileSize) || 0) > 0) {
        return await decompressDeflate(raw);
      }
      return raw;
    }

    // Resource entry.
    const fs = Number(e.fileSize) || 0;
    if (fs <= 0x10) return new Uint8Array(0);
    const raw = await this.reader.read(absOffset + 0x10, fs - 0x10);
    if (e.isEncrypted) {
      throw new Error('RpfArchive: encrypted resource payloads are not supported in browser mode yet');
    }
    if (decompress) {
      try {
        return await decompressDeflate(raw);
      } catch {
        // Some resources may not be deflated (or browser lacks DecompressionStream); fall back to raw.
        return raw;
      }
    }
    return raw;
  }

  /**
   * Convenience: extract by path.
   * @param {string} path
   * @param {{ decompress?: boolean }} [opts]
   */
  async extract(path, opts = {}) {
    const e = this.getEntry(path);
    if (!e) throw new Error(`RpfArchive: entry not found: ${path}`);
    return await this.extractEntry(e, opts);
  }
}


