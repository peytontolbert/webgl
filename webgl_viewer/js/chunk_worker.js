// Web Worker: parse streamed NDJSON entity chunks OR ENT1 binary instance tiles off the main thread,
// and build per-archetype packed instance-matrix buffers.
//
// Protocol (main -> worker):
// - { type:'begin_ndjson', reqId:number, camData:[x,y,z] }
// - { type:'chunk', reqId:number, buffer:ArrayBuffer, offset:number, length:number }
// - { type:'end', reqId:number }
// - { type:'parse_ent1', reqId:number, camData:[x,y,z], buffer:ArrayBuffer }
// - { type:'cancel', reqId:number }
//
// Protocol (worker -> main):
// - { type:'progress', reqId, newHashes:string[] } (optional)
// - { type:'result', reqId, ok:true, ...payload..., matsBuffer:ArrayBuffer } (transferable)
// - { type:'result', reqId, ok:false, error:string }

import { joaat } from './joaat.js';

function _normalizeId(id) {
  const s = String(id ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number.parseInt(s, 10);
    if (!Number.isFinite(n)) return null;
    return String((n >>> 0));
  }
  return String(joaat(s));
}

function _safeNum(x, fallback = 0.0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function _safeTintIndex(v, fallback = 0) {
  // Clamp to [0..255]. Stored as a float in the instance buffer for simplicity.
  const n0 = Number(v);
  if (!Number.isFinite(n0)) return fallback;
  const n = Math.floor(n0);
  return Math.max(0, Math.min(255, n));
}

function _fromRotationTranslationScale(out16, qx, qy, qz, qw, px, py, pz, sx, sy, sz) {
  // Mirrors gl-matrix mat4.fromRotationTranslationScale (column-major)
  // https://github.com/toji/gl-matrix/blob/master/src/mat4.js

  // Normalize quaternion (avoid shear on slightly non-unit inputs)
  const ql = Math.hypot(qx, qy, qz, qw);
  if (ql > 0) {
    const inv = 1.0 / ql;
    qx *= inv; qy *= inv; qz *= inv; qw *= inv;
  } else {
    qx = 0; qy = 0; qz = 0; qw = 1;
  }

  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;

  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;

  out16[0] = (1.0 - (yy + zz)) * sx;
  out16[1] = (xy + wz) * sx;
  out16[2] = (xz - wy) * sx;
  out16[3] = 0.0;
  out16[4] = (xy - wz) * sy;
  out16[5] = (1.0 - (xx + zz)) * sy;
  out16[6] = (yz + wx) * sy;
  out16[7] = 0.0;
  out16[8] = (xz + wy) * sz;
  out16[9] = (yz - wx) * sz;
  out16[10] = (1.0 - (xx + yy)) * sz;
  out16[11] = 0.0;
  out16[12] = px;
  out16[13] = py;
  out16[14] = pz;
  out16[15] = 1.0;
}

function _packResults({ matsByHash, minDistByHash, archetypeCounts }) {
  let totalFloats = 0;
  for (const mats of matsByHash.values()) totalFloats += mats.length;

  const packed = new Float32Array(totalFloats);
  /** @type {Array<{hash:string, offsetFloats:number, lengthFloats:number}>} */
  const matsIndex = [];

  let cursor = 0;
  for (const [hash, mats] of matsByHash.entries()) {
    const len = mats.length;
    packed.set(mats, cursor);
    matsIndex.push({ hash, offsetFloats: cursor, lengthFloats: len });
    cursor += len;
  }

  const minDistEntries = Array.from(minDistByHash.entries());
  const archetypeCountEntries = Array.from(archetypeCounts.entries());

  return { matsBuffer: packed.buffer, matsIndex, minDistEntries, archetypeCountEntries, totalFloats };
}

/** @type {Map<number, any>} */
const _jobs = new Map();

function _getJob(reqId) {
  return _jobs.get(reqId) || null;
}

function _deleteJob(reqId) {
  _jobs.delete(reqId);
}

function _sendProgress(job) {
  if (!job) return;
  if (!job._newHashes || job._newHashes.length === 0) return;
  const out = job._newHashes;
  job._newHashes = [];
  self.postMessage({ type: 'progress', reqId: job.reqId, newHashes: out });
}

function _accumEntity(job, archetypeId, pos, rotQuat, scale, tintIndex = 0, guid = 0, mloParentGuid = 0, mloEntitySetHash = 0, mloFlags = 0) {
  const hash = _normalizeId(archetypeId);
  if (!hash) {
    job.badArchetype++;
    return;
  }

  if (!job._seenHashes.has(hash)) {
    job._seenHashes.add(hash);
    job._newHashes.push(hash);
    // Batch progress updates so we don't spam messages.
    if (job._newHashes.length >= 128) _sendProgress(job);
  }

  job.withArchetype++;

  job.archetypeCounts.set(hash, (job.archetypeCounts.get(hash) ?? 0) + 1);

  const px = _safeNum(pos?.[0], 0.0);
  const py = _safeNum(pos?.[1], 0.0);
  const pz = _safeNum(pos?.[2], 0.0);

  const dx = px - job.camX;
  const dy = py - job.camY;
  const dz = pz - job.camZ;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const prev = job.minDistByHash.get(hash);
  if (prev === undefined || d < prev) job.minDistByHash.set(hash, d);

  const qx = _safeNum(rotQuat?.[0], 0.0);
  const qy = _safeNum(rotQuat?.[1], 0.0);
  const qz = _safeNum(rotQuat?.[2], 0.0);
  const qw = _safeNum(rotQuat?.[3], 1.0);

  const sx = _safeNum(scale?.[0], 1.0);
  const sy = _safeNum(scale?.[1], 1.0);
  const sz = _safeNum(scale?.[2], 1.0);

  let mats = job.matsByHash.get(hash);
  if (!mats) {
    mats = [];
    job.matsByHash.set(hash, mats);
  }

  const m = job._tmpMat16;
  _fromRotationTranslationScale(m, qx, qy, qz, qw, px, py, pz, sx, sy, sz);
  for (let i = 0; i < 16; i++) mats.push(m[i]);
  mats.push(_safeTintIndex(tintIndex, 0));
  // v3+ metadata (stored as floats so one packed Float32Array can hold everything)
  mats.push((Number(guid) >>> 0));
  mats.push((Number(mloParentGuid) >>> 0));
  mats.push((Number(mloEntitySetHash) >>> 0));
  mats.push((Number(mloFlags) >>> 0));
}

function _finalizeNdjsonJob(job) {
  // Flush any remaining decoder bytes.
  if (job._decoder) {
    try {
      job._buf += job._decoder.decode();
    } catch {
      // ignore
    }
  }

  const tail = String(job._buf || '').trim();
  if (tail) {
    try {
      const obj = JSON.parse(tail);
      job.totalLines++;
      job.parsed++;
      const a = obj?.archetype;
      if (a !== undefined && a !== null) {
        const mloParentGuid = Number(obj?.mlo_parent_guid ?? 0) >>> 0;
        const mloSetHash = Number(obj?.mlo_entity_set_hash ?? 0) >>> 0;
        const flags =
          ((obj?.is_mlo_instance ? 1 : 0) >>> 0) |
          ((mloParentGuid ? 1 : 0) << 1) |
          ((mloSetHash ? 1 : 0) << 2);
        _accumEntity(
          job,
          a,
          obj?.position,
          obj?.rotation_quat,
          obj?.scale,
          (obj?.tintIndex ?? obj?.tint),
          (obj?.guid ?? 0),
          mloParentGuid,
          mloSetHash,
          flags
        );
      }
    } catch {
      // ignore
    }
  }

  _sendProgress(job);

  const packed = _packResults({
    matsByHash: job.matsByHash,
    minDistByHash: job.minDistByHash,
    archetypeCounts: job.archetypeCounts,
  });

  const payload = {
    type: 'result',
    reqId: job.reqId,
    ok: true,
    usedBinary: false,
    totalLines: job.totalLines,
    parsed: job.parsed,
    withArchetype: job.withArchetype,
    badArchetype: job.badArchetype,
    instancedArchetypes: job.matsByHash.size,
    ...packed,
  };

  self.postMessage(payload, [packed.matsBuffer]);
  _deleteJob(job.reqId);
}

function _parseEnt1(reqId, camData, buffer) {
  const camX = _safeNum(camData?.[0], 0.0);
  const camY = _safeNum(camData?.[1], 0.0);
  const camZ = _safeNum(camData?.[2], 0.0);

  const dv = new DataView(buffer);
  if (dv.byteLength < 8) throw new Error('ENT1 buffer too small');
  const magic =
    String.fromCharCode(dv.getUint8(0)) +
    String.fromCharCode(dv.getUint8(1)) +
    String.fromCharCode(dv.getUint8(2)) +
    String.fromCharCode(dv.getUint8(3));
  if (magic !== 'ENT1') throw new Error(`Unexpected magic ${magic}`);

  const count = dv.getUint32(4, true);
  // ENT1 v1: stride=44 (hash + pos + quat + scale)
  // ENT1 v2: stride=48 adds a u32 tintIndex after scale.
  // ENT1 v3: stride=64 adds u32 tintIndex + guid + mloParentGuid + mloEntitySetHash + flags
  let stride = 44;
  const start = 8;
  const need44 = start + count * 44;
  const need48 = start + count * 48;
  const need64 = start + count * 64;
  if (need64 <= dv.byteLength) stride = 64;
  else if (need48 <= dv.byteLength) stride = 48;
  else if (need44 <= dv.byteLength) stride = 44;
  else throw new Error('ENT1 truncated');

  const matsByHash = new Map();
  const minDistByHash = new Map();
  const archetypeCounts = new Map();

  const tmp = new Float32Array(16);
  for (let i = 0; i < count; i++) {
    const off = start + i * stride;
    const h = dv.getUint32(off + 0, true) >>> 0;
    const hash = String(h);

    const px = dv.getFloat32(off + 4, true);
    const py = dv.getFloat32(off + 8, true);
    const pz = dv.getFloat32(off + 12, true);

    const qx = dv.getFloat32(off + 16, true);
    const qy = dv.getFloat32(off + 20, true);
    const qz = dv.getFloat32(off + 24, true);
    const qw = dv.getFloat32(off + 28, true);

    const sx = dv.getFloat32(off + 32, true);
    const sy = dv.getFloat32(off + 36, true);
    const sz = dv.getFloat32(off + 40, true);
    const tintIndex = (stride >= 48) ? (dv.getUint32(off + 44, true) >>> 0) : 0;
    const guid = (stride >= 64) ? (dv.getUint32(off + 48, true) >>> 0) : 0;
    const mloParentGuid = (stride >= 64) ? (dv.getUint32(off + 52, true) >>> 0) : 0;
    const mloSetHash = (stride >= 64) ? (dv.getUint32(off + 56, true) >>> 0) : 0;
    const flags = (stride >= 64) ? (dv.getUint32(off + 60, true) >>> 0) : 0;

    archetypeCounts.set(hash, (archetypeCounts.get(hash) ?? 0) + 1);

    const dx = px - camX;
    const dy = py - camY;
    const dz = pz - camZ;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const prev = minDistByHash.get(hash);
    if (prev === undefined || d < prev) minDistByHash.set(hash, d);

    let mats = matsByHash.get(hash);
    if (!mats) {
      mats = [];
      matsByHash.set(hash, mats);
    }
    _fromRotationTranslationScale(tmp, qx, qy, qz, qw, px, py, pz, sx, sy, sz);
    for (let k = 0; k < 16; k++) mats.push(tmp[k]);
    mats.push(_safeTintIndex(tintIndex, 0));
    mats.push(Number(guid));
    mats.push(Number(mloParentGuid));
    mats.push(Number(mloSetHash));
    mats.push(Number(flags));
  }

  const packed = _packResults({ matsByHash, minDistByHash, archetypeCounts });
  const payload = {
    type: 'result',
    reqId,
    ok: true,
    usedBinary: true,
    totalLines: count,
    parsed: count,
    withArchetype: count,
    badArchetype: 0,
    instancedArchetypes: matsByHash.size,
    ...packed,
  };
  self.postMessage(payload, [packed.matsBuffer]);
}

self.onmessage = (e) => {
  const msg = e?.data || {};
  const type = String(msg.type || '');
  const reqId = Number(msg.reqId);
  if (!Number.isFinite(reqId)) return;

  try {
    if (type === 'cancel') {
      _deleteJob(reqId);
      return;
    }

    if (type === 'parse_ent1') {
      const buffer = msg.buffer;
      if (!(buffer instanceof ArrayBuffer)) throw new Error('parse_ent1: missing buffer');
      _parseEnt1(reqId, msg.camData, buffer);
      return;
    }

    if (type === 'begin_ndjson') {
      const cam = msg.camData || [0, 0, 0];
      const camX = _safeNum(cam?.[0], 0.0);
      const camY = _safeNum(cam?.[1], 0.0);
      const camZ = _safeNum(cam?.[2], 0.0);

      _jobs.set(reqId, {
        reqId,
        camX, camY, camZ,
        totalLines: 0,
        parsed: 0,
        withArchetype: 0,
        badArchetype: 0,
        matsByHash: new Map(),
        minDistByHash: new Map(),
        archetypeCounts: new Map(),
        _decoder: new TextDecoder(),
        _buf: '',
        _seenHashes: new Set(),
        _newHashes: [],
        _tmpMat16: new Float32Array(16),
      });
      return;
    }

    if (type === 'chunk') {
      const job = _getJob(reqId);
      if (!job) return;
      const buffer = msg.buffer;
      if (!(buffer instanceof ArrayBuffer)) return;
      const offset = Number(msg.offset) || 0;
      const length = Number(msg.length) || 0;
      if (length <= 0) return;

      // Decode bytes -> text
      const view = new Uint8Array(buffer, Math.max(0, offset), Math.max(0, Math.min(length, buffer.byteLength - offset)));
      job._buf += job._decoder.decode(view, { stream: true });

      // Parse full lines.
      let idx;
      while ((idx = job._buf.indexOf('\n')) !== -1) {
        const line = job._buf.slice(0, idx).trim();
        job._buf = job._buf.slice(idx + 1);
        if (!line) continue;

        try {
          const obj = JSON.parse(line);
          job.totalLines++;
          job.parsed++;
          const a = obj?.archetype;
          if (a === undefined || a === null) continue;
          const mloParentGuid = Number(obj?.mlo_parent_guid ?? 0) >>> 0;
          const mloSetHash = Number(obj?.mlo_entity_set_hash ?? 0) >>> 0;
          const flags =
            ((obj?.is_mlo_instance ? 1 : 0) >>> 0) |
            ((mloParentGuid ? 1 : 0) << 1) |
            ((mloSetHash ? 1 : 0) << 2);
          _accumEntity(
            job,
            a,
            obj?.position,
            obj?.rotation_quat,
            obj?.scale,
            (obj?.tintIndex ?? obj?.tint),
            (obj?.guid ?? 0),
            mloParentGuid,
            mloSetHash,
            flags
          );
        } catch {
          // ignore bad line
        }
      }
      return;
    }

    if (type === 'end') {
      const job = _getJob(reqId);
      if (!job) return;
      _finalizeNdjsonJob(job);
      return;
    }
  } catch (err) {
    _deleteJob(reqId);
    const msgErr = (err && (err.stack || err.message)) ? (err.stack || err.message) : String(err);
    self.postMessage({ type: 'result', reqId, ok: false, error: msgErr });
  }
};


