// Web Worker: parse streamed NDJSON entity chunks OR ENT1 binary instance tiles off the main thread,
// and build per-archetype packed instance-matrix buffers.
//
// Protocol (main -> worker):
// - { type:'begin_ndjson', reqId:number, camData:[x,y,z], storeKey?:string, storeOnly?:boolean }
// - { type:'chunk', reqId:number, buffer:ArrayBuffer, offset:number, length:number }
// - { type:'end', reqId:number }
// - { type:'parse_ent1', reqId:number, camData:[x,y,z], buffer:ArrayBuffer, storeKey?:string, storeOnly?:boolean }
// - { type:'cancel', reqId:number }
// - { type:'rebuild_stored', reqId:number, keys:string[], camData:[x,y,z], camDir:[x,y,z], maxCandidates:number, maxModelDistance:number, behindPenalty:number }
// - { type:'drop_stored', reqId:number, keys:string[] }
//
// Protocol (worker -> main):
// - { type:'progress', reqId, newHashes:string[] } (optional)
// - { type:'result', reqId, ok:true, ...payload..., matsBuffer:ArrayBuffer } (transferable)
// - { type:'result', reqId, ok:false, error:string }

import { joaat } from './joaat.js';

function _normalizeId(id) {
  if (id === null || id === undefined) return null;

  // Fast path: already numeric (some exports emit numbers).
  if (typeof id === 'number') {
    if (!Number.isFinite(id)) return null;
    return String((id >>> 0));
  }

  const s = String(id).trim();
  if (!s) return null;

  // Tolerate common exporter formats: signed/unsigned decimal, hex, float-like numeric strings.
  const hex = s.match(/^0x([0-9a-f]+)$/i);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    if (!Number.isFinite(n)) return null;
    return String((n >>> 0));
  }

  if (/^-?\d+$/.test(s)) {
    const n = Number.parseInt(s, 10);
    if (!Number.isFinite(n)) return null;
    return String((n >>> 0));
  }

  if (/^-?\d+\.\d+$/.test(s)) {
    const n = Math.trunc(Number(s));
    if (!Number.isFinite(n)) return null;
    return String((n >>> 0));
  }

  return String(joaat(s));
}

function _ymapHashFromPath(p) {
  // Match CodeWalker/RPF short-name hashing: base filename (no extension), lowercased, joaat.
  const s0 = String(p || '').trim();
  if (!s0) return 0;
  const s = s0.replace(/\\/g, '/');
  const parts = s.split('/');
  const last = parts.length ? parts[parts.length - 1] : s;
  const base = last.replace(/\.ymap$/i, '').trim().toLowerCase();
  if (!base) return 0;
  try { return (joaat(base) >>> 0); } catch { return 0; }
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

// Stored chunk parses (worker-owned) to support rebuild off the main thread.
// key -> { packed:Float32Array, matsIndex:Array<{hash, offsetFloats, lengthFloats}> }
const _stored = new Map();

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

function _accumEntity(job, archetypeId, pos, rotQuat, scale, tintIndex = 0, guid = 0, mloParentGuid = 0, mloEntitySetHash = 0, mloFlags = 0, ymapHash = 0) {
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

  // Position: accept [x,y,z] or {x,y,z}/{X,Y,Z}
  const px = _safeNum(Array.isArray(pos) ? pos?.[0] : (pos?.x ?? pos?.X), 0.0);
  const py = _safeNum(Array.isArray(pos) ? pos?.[1] : (pos?.y ?? pos?.Y), 0.0);
  const pz = _safeNum(Array.isArray(pos) ? pos?.[2] : (pos?.z ?? pos?.Z), 0.0);

  const dx = px - job.camX;
  const dy = py - job.camY;
  const dz = pz - job.camZ;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const prev = job.minDistByHash.get(hash);
  if (prev === undefined || d < prev) job.minDistByHash.set(hash, d);

  // Quaternion: accept [x,y,z,w] (preferred), or {x,y,z,w}/{X,Y,Z,W}.
  // Some sources may provide [w,x,y,z]; apply a light heuristic when given a raw 4-array.
  let qx, qy, qz, qw;
  if (Array.isArray(rotQuat) && rotQuat.length >= 4) {
    const a0 = _safeNum(rotQuat[0], 0.0);
    const a1 = _safeNum(rotQuat[1], 0.0);
    const a2 = _safeNum(rotQuat[2], 0.0);
    const a3 = _safeNum(rotQuat[3], 1.0);
    const abs0 = Math.abs(a0);
    const abs3 = Math.abs(a3);
    const looksLikeWxyz = abs0 > 0.5 && abs3 < 0.75;
    if (looksLikeWxyz) {
      qx = a1; qy = a2; qz = a3; qw = a0;
    } else {
      qx = a0; qy = a1; qz = a2; qw = a3;
    }
  } else if (rotQuat && typeof rotQuat === 'object') {
    qx = _safeNum(rotQuat?.x ?? rotQuat?.X, 0.0);
    qy = _safeNum(rotQuat?.y ?? rotQuat?.Y, 0.0);
    qz = _safeNum(rotQuat?.z ?? rotQuat?.Z, 0.0);
    qw = _safeNum(rotQuat?.w ?? rotQuat?.W, 1.0);
  } else {
    qx = 0.0; qy = 0.0; qz = 0.0; qw = 1.0;
  }

  // IMPORTANT: YMAP CEntityDef.rotation is stored inverted for normal entities.
  // CodeWalker inverts it when building world orientation.
  // Our exporter writes raw CEntityDef.rotation into `rotation_quat` for base entities,
  // so invert here unless:
  // - this is an MLO instance (flags bit 0), OR
  // - this is an interior child entity (mloParentGuid != 0) and rotation is already world-space.
  const isMloInstance = ((Number(mloFlags) >>> 0) & 1) !== 0;
  const hasMloParent = (Number(mloParentGuid) >>> 0) !== 0;
  if (!isMloInstance && !hasMloParent) {
    qx = -qx; qy = -qy; qz = -qz; // conjugate (inverse for unit quaternion)
  }

  // Scale: accept [sx,sy,sz] or {x,y,z}/{X,Y,Z}
  // Scale: guard against zero/near-zero scales, which create singular matrices.
  // Singular instance matrices can produce NaNs in the vertex shader (inverse/normal transforms),
  // which then can "poison" the whole frame (grey/white screen depending on driver).
  const sx0 = _safeNum(Array.isArray(scale) ? scale?.[0] : (scale?.x ?? scale?.X), 1.0);
  const sy0 = _safeNum(Array.isArray(scale) ? scale?.[1] : (scale?.y ?? scale?.Y), 1.0);
  const sz0 = _safeNum(Array.isArray(scale) ? scale?.[2] : (scale?.z ?? scale?.Z), 1.0);
  const epsS = 1e-6;
  const sx = (Math.abs(sx0) < epsS) ? 1.0 : sx0;
  const sy = (Math.abs(sy0) < epsS) ? 1.0 : sy0;
  const sz = (Math.abs(sz0) < epsS) ? 1.0 : sz0;

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
  // v4 metadata: ymap hash (u32). Stored as float so it can live in the packed Float32Array.
  mats.push((Number(ymapHash) >>> 0));
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
      const a =
        obj?.archetype ??
        obj?.archetype_hash ??
        obj?.archetypeHash ??
        obj?.archetype_id ??
        obj?.archetypeId ??
        obj?.archetypeHash32 ??
        null;
      if (a !== undefined && a !== null) {
        const mloParentGuid = Number(obj?.mlo_parent_guid ?? 0) >>> 0;
        const mloSetHash = Number(obj?.mlo_entity_set_hash ?? 0) >>> 0;
        const flags =
          ((obj?.is_mlo_instance ? 1 : 0) >>> 0) |
          ((mloParentGuid ? 1 : 0) << 1) |
          ((mloSetHash ? 1 : 0) << 2);
        const ymapHash = (() => {
          const yh = obj?.ymap_hash ?? obj?.ymapHash ?? obj?.ymap_hash32 ?? null;
          if (yh !== null && yh !== undefined) {
            const n = Number(yh);
            if (Number.isFinite(n)) return (n >>> 0);
          }
          return _ymapHashFromPath(obj?.ymap);
        })();
        _accumEntity(
          job,
          a,
          (obj?.position ?? obj?.pos),
          (obj?.rotation_quat ?? obj?.rotationQuat ?? obj?.rotation_quaternion ?? obj?.rotationQuaternion ?? obj?.quat ?? obj?.quaternion ?? obj?.rotation),
          (obj?.scale ?? obj?.scl),
          (obj?.tintIndex ?? obj?.tint),
          (obj?.guid ?? 0),
          mloParentGuid,
          mloSetHash,
          flags,
          ymapHash
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

  const storeKey = String(job.storeKey || '').trim();
  const storeOnly = !!job.storeOnly && !!storeKey;
  if (storeOnly) {
    // Keep packed buffers in the worker; main thread will request rebuild results.
    // Store a typed view for convenient access.
    _stored.set(storeKey, { packed: new Float32Array(packed.matsBuffer), matsIndex: packed.matsIndex });
    delete payload.matsBuffer;
    delete payload.matsIndex;
    payload.stored = true;
    payload.storeKey = storeKey;
    self.postMessage(payload);
  } else {
    self.postMessage(payload, [packed.matsBuffer]);
  }
  _deleteJob(job.reqId);
}

function _parseEnt1(reqId, camData, buffer, { storeKey = null, storeOnly = false } = {}) {
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
    // ENT1 bins currently do not carry ymap identity; store 0 so gating can treat as "unknown" (fail-open).
    mats.push(0);
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
  const sk = String(storeKey || '').trim();
  const so = !!storeOnly && !!sk;
  if (so) {
    _stored.set(sk, { packed: new Float32Array(packed.matsBuffer), matsIndex: packed.matsIndex });
    delete payload.matsBuffer;
    delete payload.matsIndex;
    payload.stored = true;
    payload.storeKey = sk;
    self.postMessage(payload);
  } else {
    self.postMessage(payload, [packed.matsBuffer]);
  }
}

self.onmessage = (e) => {
  const msg = e?.data || {};
  const type = String(msg.type || '');
  const reqId = Number(msg.reqId);
  if (!Number.isFinite(reqId)) return;

  try {
    if (type === 'drop_stored') {
      const keys = Array.isArray(msg.keys) ? msg.keys : [];
      for (const k of keys) _stored.delete(String(k || ''));
      self.postMessage({ type: 'result', reqId, ok: true, dropped: keys.length });
      return;
    }

    if (type === 'rebuild_stored') {
      const keys = Array.isArray(msg.keys) ? msg.keys : [];
      const cam = msg.camData || [0, 0, 0];
      const dir = msg.camDir || [0, 0, -1];
      const cx = _safeNum(cam?.[0], 0.0);
      const cy = _safeNum(cam?.[1], 0.0);
      const cz = _safeNum(cam?.[2], 0.0);
      const dx0 = _safeNum(dir?.[0], 0.0);
      const dy0 = _safeNum(dir?.[1], 0.0);
      const dz0 = _safeNum(dir?.[2], -1.0);
      const dlen = Math.hypot(dx0, dy0, dz0) || 1.0;
      const fx = dx0 / dlen, fy = dy0 / dlen, fz = dz0 / dlen;

      const maxCandidates = Math.max(0, Math.floor(Number(msg.maxCandidates ?? 0)));
      const maxD = Number.isFinite(Number(msg.maxModelDistance)) ? Math.max(0, Number(msg.maxModelDistance)) : 1e30;
      const behindPenalty = Number.isFinite(Number(msg.behindPenalty)) ? Math.max(1.0, Number(msg.behindPenalty)) : 1.6;

      // Aggregate per-hash slices across stored chunks.
      const stride = 21; // 16 mat + tint + guid + mloParentGuid + mloEntitySetHash + flags
      /** @type {Map<string, { totalLen:number, bestDist2:number, bestDot:number, slices:Array<{arr:Float32Array, off:number, len:number}> }>} */
      const infos = new Map();

      for (const k0 of keys) {
        const k = String(k0 || '').trim();
        if (!k) continue;
        const entry = _stored.get(k);
        if (!entry || !entry.packed || !entry.matsIndex) continue;
        const arr = entry.packed;
        const idx = entry.matsIndex;
        for (const it of idx) {
          const hash = String(it?.hash ?? '');
          if (!hash) continue;
          const off = Math.max(0, Math.floor(Number(it?.offsetFloats ?? 0)));
          const len = Math.max(0, Math.floor(Number(it?.lengthFloats ?? 0)));
          if (!len) continue;

          let info = infos.get(hash);
          if (!info) {
            info = { totalLen: 0, bestDist2: 1e30, bestDot: 0.0, slices: [] };
            infos.set(hash, info);
          }
          info.totalLen += len;
          info.slices.push({ arr, off, len });

          // Update bestDist2/bestDot for this hash from this slice.
          for (let i = off; i + (stride - 1) < (off + len); i += stride) {
            const px = arr[i + 12];
            const py = arr[i + 13];
            const pz = arr[i + 14];
            const dx = px - cx;
            const dy = py - cy;
            const dz = pz - cz;
            const dist2 = dx * dx + dy * dy + dz * dz;
            if (dist2 < info.bestDist2) {
              info.bestDist2 = dist2;
              info.bestDot = dx * fx + dy * fy + dz * fz;
            }
          }
        }
      }

      // Score + pick candidates.
      const scored = [];
      for (const [hash, info] of infos.entries()) {
        const d = Math.sqrt(Math.max(0, info.bestDist2));
        if (d > maxD) continue;
        const ba = (Number(info.bestDot) >= 0) ? 1.0 : behindPenalty;
        scored.push({ hash, d, dot: info.bestDot, score: d * ba, totalLen: info.totalLen });
      }
      scored.sort((a, b) => (a.score - b.score) || (a.hash < b.hash ? -1 : 1));
      const keep = (maxCandidates > 0) ? scored.slice(0, maxCandidates) : scored;

      // Pack kept hashes into one transferable buffer (same format as parse results).
      let totalFloats = 0;
      for (const e of keep) totalFloats += e.totalLen;
      const packed = new Float32Array(totalFloats);
      const matsIndex = [];
      const minDistEntries = [];
      const bestDotEntries = [];

      let cursor = 0;
      for (const e of keep) {
        const info = infos.get(e.hash);
        if (!info) continue;
        const start = cursor;
        for (const s of info.slices) {
          packed.set(s.arr.subarray(s.off, s.off + s.len), cursor);
          cursor += s.len;
        }
        matsIndex.push({ hash: e.hash, offsetFloats: start, lengthFloats: cursor - start });
        minDistEntries.push([e.hash, e.d]);
        bestDotEntries.push([e.hash, e.dot]);
      }

      self.postMessage({
        type: 'result',
        reqId,
        ok: true,
        matsBuffer: packed.buffer,
        matsIndex,
        minDistEntries,
        bestDotEntries,
        totalFloats: packed.length,
      }, [packed.buffer]);
      return;
    }

    if (type === 'cancel') {
      _deleteJob(reqId);
      return;
    }

    if (type === 'parse_ent1') {
      const buffer = msg.buffer;
      if (!(buffer instanceof ArrayBuffer)) throw new Error('parse_ent1: missing buffer');
      _parseEnt1(reqId, msg.camData, buffer, { storeKey: msg.storeKey, storeOnly: msg.storeOnly });
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
        storeKey: msg.storeKey || null,
        storeOnly: !!msg.storeOnly,
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
          const a =
            obj?.archetype ??
            obj?.archetype_hash ??
            obj?.archetypeHash ??
            obj?.archetype_id ??
            obj?.archetypeId ??
            obj?.archetypeHash32 ??
            null;
          if (a === undefined || a === null) continue;
          const mloParentGuid = Number(obj?.mlo_parent_guid ?? 0) >>> 0;
          const mloSetHash = Number(obj?.mlo_entity_set_hash ?? 0) >>> 0;
          const flags =
            ((obj?.is_mlo_instance ? 1 : 0) >>> 0) |
            ((mloParentGuid ? 1 : 0) << 1) |
            ((mloSetHash ? 1 : 0) << 2);
          const ymapHash = (() => {
            const yh = obj?.ymap_hash ?? obj?.ymapHash ?? obj?.ymap_hash32 ?? null;
            if (yh !== null && yh !== undefined) {
              const n = Number(yh);
              if (Number.isFinite(n)) return (n >>> 0);
            }
            return _ymapHashFromPath(obj?.ymap);
          })();
          const scaleArg =
            (obj?.scale ?? obj?.scl)
            ?? ((obj?.scaleXY !== undefined || obj?.scale_xy !== undefined || obj?.scaleZ !== undefined || obj?.scale_z !== undefined)
              ? [
                Number(obj?.scaleXY ?? obj?.scale_xy ?? 1.0),
                Number(obj?.scaleXY ?? obj?.scale_xy ?? 1.0),
                Number(obj?.scaleZ ?? obj?.scale_z ?? 1.0),
              ]
              : null);
          _accumEntity(
            job,
            a,
            (obj?.position ?? obj?.pos),
            (obj?.rotation_quat ?? obj?.rotationQuat ?? obj?.rotation_quaternion ?? obj?.rotationQuaternion ?? obj?.quat ?? obj?.quaternion ?? obj?.rotation),
            scaleArg,
            (obj?.tintIndex ?? obj?.tint),
            (obj?.guid ?? 0),
            mloParentGuid,
            mloSetHash,
            flags,
            ymapHash
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


