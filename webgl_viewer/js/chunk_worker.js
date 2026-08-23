// Web Worker: parse streamed NDJSON entity chunks OR ENT1 binary instance tiles off the main thread,
// and build per-archetype packed instance-matrix buffers.
//
// Protocol (main -> worker):
// - { type:'begin_ndjson', reqId:number, camData:[x,y,z], storeKey?:string, storeOnly?:boolean, worldBounds?:object }
// - { type:'chunk', reqId:number, buffer:ArrayBuffer, offset:number, length:number }
// - { type:'end', reqId:number }
// - { type:'parse_ent1', reqId:number, camData:[x,y,z], buffer:ArrayBuffer, storeKey?:string, storeOnly?:boolean, worldBounds?:object }
// - { type:'cancel', reqId:number }
// - { type:'rebuild_stored', reqId:number, keys:string[], camData:[x,y,z], camDir:[x,y,z], maxCandidates:number, maxModelDistance:number, behindPenalty:number, frustumPlanes?:Float32Array|number[], cullRadiusEntries?:Array<[hash,radius]> }
// - { type:'drop_stored', reqId:number, keys:string[] }
//
// Protocol (worker -> main):
// - { type:'progress', reqId, newHashes:string[] } (optional)
// - { type:'result', reqId, ok:true, ...payload..., matsBuffer:ArrayBuffer } (transferable)
// - { type:'result', reqId, ok:false, error:string }

import { joaat } from './joaat.js';
import { createWasmCuller } from './wasm_culler.js';
import { canAttemptWebGpuCulling, createWebGpuCuller, getWebGpuCullingAvailability } from './webgpu_culler.js';

let _wasmCuller = null;
let _wasmCullerFailed = false;
let _webGpuCuller = null;
let _webGpuCullerFailed = false;
let _webGpuCullerPromise = null;
let _webGpuMatrixScratch = new Float32Array(0);
let _webGpuRadiusScratch = new Float32Array(0);
let _webGpuOwnerScratch = new Uint32Array(0);

function _nextScratchCapacity(required) {
  const value = Math.max(1, Math.ceil(Number(required) || 0));
  return 2 ** Math.ceil(Math.log2(value));
}

function _getWebGpuScratch(instanceCount, stride) {
  const matrixFloats = instanceCount * stride;
  if (_webGpuMatrixScratch.length < matrixFloats) {
    _webGpuMatrixScratch = new Float32Array(_nextScratchCapacity(matrixFloats));
  }
  if (_webGpuRadiusScratch.length < instanceCount) {
    _webGpuRadiusScratch = new Float32Array(_nextScratchCapacity(instanceCount));
  }
  if (_webGpuOwnerScratch.length < instanceCount) {
    _webGpuOwnerScratch = new Uint32Array(_nextScratchCapacity(instanceCount));
  }
  return {
    matrices: _webGpuMatrixScratch.subarray(0, matrixFloats),
    radii: _webGpuRadiusScratch.subarray(0, instanceCount),
    owners: _webGpuOwnerScratch.subarray(0, instanceCount),
  };
}

function _getWasmCuller() {
  if (_wasmCullerFailed) return null;
  if (_wasmCuller) return _wasmCuller;
  try {
    _wasmCuller = createWasmCuller();
    if (!_wasmCuller) _wasmCullerFailed = true;
    return _wasmCuller;
  } catch {
    _wasmCullerFailed = true;
    _wasmCuller = null;
    return null;
  }
}

async function _getWebGpuCuller() {
  if (_webGpuCullerFailed) return null;
  if (_webGpuCuller) return _webGpuCuller;
  if (!canAttemptWebGpuCulling()) {
    _webGpuCullerFailed = true;
    return null;
  }
  if (!_webGpuCullerPromise) {
    _webGpuCullerPromise = createWebGpuCuller()
      .then((culler) => {
        _webGpuCuller = culler || null;
        if (!_webGpuCuller) _webGpuCullerFailed = true;
        return _webGpuCuller;
      })
      .catch(() => {
        _webGpuCullerFailed = true;
        _webGpuCuller = null;
        return null;
      })
      .finally(() => {
        _webGpuCullerPromise = null;
      });
  }
  return await _webGpuCullerPromise;
}

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

function _isWithinWorldBounds(bounds, x, y) {
  if (!bounds || typeof bounds !== 'object') return true;
  const minX = Number(bounds.minX);
  const minY = Number(bounds.minY);
  const maxX = Number(bounds.maxX);
  const maxY = Number(bounds.maxY);
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY) return true;
  return x >= minX && x <= maxX && y >= minY && y <= maxY;
}

function _instanceTransformSignature(arr, offset, stride) {
  // YMAP exports can repeat the same drawable record through overlapping map
  // layers. Quantizing to exporter precision makes the comparison stable while
  // retaining rotation, scale, translation, and tint differences.
  const q = (index, scale) => {
    const n = Number(arr[offset + index]);
    return Number.isFinite(n) ? Math.round(n * scale) : 0;
  };
  return [
    q(0, 10000), q(1, 10000), q(2, 10000),
    q(4, 10000), q(5, 10000), q(6, 10000),
    q(8, 10000), q(9, 10000), q(10, 10000),
    q(12, 1000), q(13, 1000), q(14, 1000),
    stride >= 17 ? q(16, 1) : 0,
  ].join(',');
}

function _parseFrustumPlanes(raw) {
  if (!raw) return null;
  const a = (Array.isArray(raw) || ArrayBuffer.isView(raw)) ? raw : null;
  if (!a || a.length < 24) return null;
  const out = new Float32Array(24);
  for (let i = 0; i < 24; i++) {
    const n = Number(a[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}

function _sphereIntersectsPlanes(planes, x, y, z, radius) {
  if (!planes || planes.length < 24) return true;
  const r = Math.max(0.0, Number(radius) || 0.0);
  for (let i = 0; i < 6; i++) {
    const o = i * 4;
    if ((planes[o] * x + planes[o + 1] * y + planes[o + 2] * z + planes[o + 3]) < -r) return false;
  }
  return true;
}

function _instanceMaxScale(arr, offset) {
  const sx = Math.hypot(Number(arr[offset + 0]) || 0, Number(arr[offset + 1]) || 0, Number(arr[offset + 2]) || 0);
  const sy = Math.hypot(Number(arr[offset + 4]) || 0, Number(arr[offset + 5]) || 0, Number(arr[offset + 6]) || 0);
  const sz = Math.hypot(Number(arr[offset + 8]) || 0, Number(arr[offset + 9]) || 0, Number(arr[offset + 10]) || 0);
  const s = Math.max(sx, sy, sz);
  return Number.isFinite(s) && s > 0 ? s : 1.0;
}

function _radiusMapFromEntries(entries) {
  const out = new Map();
  if (!Array.isArray(entries)) return out;
  for (const it of entries) {
    const hash = String(Array.isArray(it) ? it[0] : it?.hash ?? '');
    const radius = Number(Array.isArray(it) ? it[1] : it?.radius);
    if (hash && Number.isFinite(radius) && radius > 0) out.set(hash, radius);
  }
  return out;
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
  /** @type {Array<{hash:string, offsetFloats:number, lengthFloats:number, strideFloats:number}>} */
  const matsIndex = [];

  let cursor = 0;
  for (const [hash, mats] of matsByHash.entries()) {
    const len = mats.length;
    packed.set(mats, cursor);
    // All worker-produced world instances use the v4 layout. Preserve this
    // alongside the packed slice: length alone is ambiguous for 17/21/22.
    matsIndex.push({ hash, offsetFloats: cursor, lengthFloats: len, strideFloats: 22 });
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
  // Position: accept [x,y,z] or {x,y,z}/{X,Y,Z}
  const px = _safeNum(Array.isArray(pos) ? pos?.[0] : (pos?.x ?? pos?.X), 0.0);
  const py = _safeNum(Array.isArray(pos) ? pos?.[1] : (pos?.y ?? pos?.Y), 0.0);
  const pz = _safeNum(Array.isArray(pos) ? pos?.[2] : (pos?.z ?? pos?.Z), 0.0);
  if (!_isWithinWorldBounds(job.worldBounds, px, py)) return;

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

function _parseEnt1(reqId, camData, buffer, { storeKey = null, storeOnly = false, worldBounds = null, dedupeExactRecords = false } = {}) {
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
  const rawBytes = dedupeExactRecords ? new Uint8Array(buffer) : null;
  const exactRecords = dedupeExactRecords ? new Set() : null;
  let dedupedExactRecords = 0;

  const tmp = new Float32Array(16);
  for (let i = 0; i < count; i++) {
    const off = start + i * stride;
    if (exactRecords) {
      const recordKey = String.fromCharCode(...rawBytes.subarray(off, off + stride));
      if (exactRecords.has(recordKey)) {
        dedupedExactRecords++;
        continue;
      }
      exactRecords.add(recordKey);
    }
    const h = dv.getUint32(off + 0, true) >>> 0;
    const hash = String(h);

    const px = dv.getFloat32(off + 4, true);
    const py = dv.getFloat32(off + 8, true);
    const pz = dv.getFloat32(off + 12, true);
    if (!_isWithinWorldBounds(worldBounds, px, py)) continue;

    let qx = dv.getFloat32(off + 16, true);
    let qy = dv.getFloat32(off + 20, true);
    let qz = dv.getFloat32(off + 24, true);
    const qw = dv.getFloat32(off + 28, true);

    const sx = dv.getFloat32(off + 32, true);
    const sy = dv.getFloat32(off + 36, true);
    const sz = dv.getFloat32(off + 40, true);
    const tintIndex = (stride >= 48) ? (dv.getUint32(off + 44, true) >>> 0) : 0;
    const guid = (stride >= 64) ? (dv.getUint32(off + 48, true) >>> 0) : 0;
    const mloParentGuid = (stride >= 64) ? (dv.getUint32(off + 52, true) >>> 0) : 0;
    const mloSetHash = (stride >= 64) ? (dv.getUint32(off + 56, true) >>> 0) : 0;
    const flags = (stride >= 64) ? (dv.getUint32(off + 60, true) >>> 0) : 0;

    // ENT1 stores the raw CEntityDef quaternion. CodeWalker conjugates ordinary
    // YMAP entity rotations when constructing their world transform. MLO roots
    // and interior children are already world-space and must remain untouched.
    const isMloInstance = (flags & 1) !== 0;
    const hasMloParent = mloParentGuid !== 0;
    if (!isMloInstance && !hasMloParent) {
      qx = -qx;
      qy = -qy;
      qz = -qz;
    }

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
    parsed: count - dedupedExactRecords,
    withArchetype: count - dedupedExactRecords,
    badArchetype: 0,
    dedupedExactRecords,
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

self.onmessage = async (e) => {
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
      const maxVisibleInstances = Math.max(1, Math.floor(Number(msg.maxVisibleInstances ?? 12000)));
      const maxInstancesPerArchetype = Math.max(1, Math.floor(Number(msg.maxInstancesPerArchetype ?? 128)));
      const maxBehindDistance = Math.min(maxD, Math.max(24.0, Number(msg.maxBehindModelDistance ?? (maxD * 0.55))));
      const nonRenderableHashes = new Set(
        (Array.isArray(msg.nonRenderableHashes) ? msg.nonRenderableHashes : []).map((h) => String(h))
      );
      const frustumPlanes = _parseFrustumPlanes(msg.frustumPlanes);
      const radiusByHash = _radiusMapFromEntries(msg.cullRadiusEntries);
      const frustumPadding = Math.max(0.0, _safeNum(msg.frustumPadding, 0.0));
      let frustumTested = 0;
      let frustumCulled = 0;

      // Aggregate per-hash slices across stored chunks.
      // Current parser output is v4: 16 mat + tint + guid + MLO metadata + ymap hash.
      // The historic 21-float stride corrupts positions during rebuild distance selection.
      const stride = 22;
      /** @type {Map<string, { totalLen:number, bestDist2:number, bestDot:number, frustumAny:boolean, slices:Array<{arr:Float32Array, off:number, len:number, visibleIndices?:Uint32Array}> }>} */
      const infos = new Map();
      const mloInstanceEntries = [];
      const seenMloInstances = new Set();
      const mloChildBounds = new Map();

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

          // MLO roots are metadata-only archetypes in optimized manifests. Preserve
          // their identity and transform before drawable eligibility filtering so
          // room/portal ownership cannot disappear with non-renderable geometry.
          const end = Math.min(arr.length, off + len);
          for (let i = off; i + (stride - 1) < end; i += stride) {
            const flags = Number(arr[i + 20]) >>> 0;
            const mloParentGuid = Number(arr[i + 18]) >>> 0;
            if (mloParentGuid) {
              const x = Number(arr[i + 12]);
              const y = Number(arr[i + 13]);
              const z = Number(arr[i + 14]);
              if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
                let bounds = mloChildBounds.get(mloParentGuid);
                if (!bounds) {
                  bounds = [x, y, z, x, y, z, 0];
                  mloChildBounds.set(mloParentGuid, bounds);
                }
                bounds[0] = Math.min(bounds[0], x);
                bounds[1] = Math.min(bounds[1], y);
                bounds[2] = Math.min(bounds[2], z);
                bounds[3] = Math.max(bounds[3], x);
                bounds[4] = Math.max(bounds[4], y);
                bounds[5] = Math.max(bounds[5], z);
                bounds[6]++;
              }
            }
            if ((flags & 1) === 0) continue;
            const parentGuid = Number(arr[i + 17]) >>> 0;
            if (!parentGuid) continue;
            const key = `${hash}:${parentGuid}`;
            if (seenMloInstances.has(key)) continue;
            seenMloInstances.add(key);
            const packedRoot = [hash, parentGuid];
            for (let n = 0; n < 16; n++) packedRoot.push(Number(arr[i + n]));
            mloInstanceEntries.push(packedRoot);
          }

          if (nonRenderableHashes.has(hash)) continue;

          let info = infos.get(hash);
          if (!info) {
            info = { totalLen: 0, bestDist2: 1e30, bestDot: 0.0, frustumAny: false, slices: [] };
            infos.set(hash, info);
          }
          info.totalLen += len;
          info.slices.push({ arr, off, len });
        }
      }

      // MLO room AABBs are not consistently usable: a number of otherwise
      // valid FiveM resources publish map-sized sentinel boxes. Carry the
      // authored child transform envelope beside each root so the main thread
      // can activate the complete interior without guessing from one portal.
      for (const packedRoot of mloInstanceEntries) {
        const parentGuid = Number(packedRoot?.[1]) >>> 0;
        const bounds = mloChildBounds.get(parentGuid);
        if (bounds) packedRoot.push(...bounds);
      }

      let sourceInstances = 0;
      for (const info of infos.values()) sourceInstances += Math.floor(info.totalLen / stride);

      const isDemoRebuild = keys.some((k) => String(k || '').startsWith('__demo_'));
      const wasmMinInstances = Math.max(1, Math.floor(Number(msg.wasmCullingMinInstances ?? 50000)));
      const wasmMinSliceInstances = Math.max(1, Math.floor(Number(msg.wasmCullingMinSliceInstances ?? 512)));
      const wasmRequested = !!msg.enableWasmCulling && !isDemoRebuild && sourceInstances >= wasmMinInstances;
      const wasmCuller = wasmRequested ? _getWasmCuller() : null;
      const wasmStats = { enabled: !!wasmCuller, tested: 0, kept: 0, rejected: 0 };
      const webGpuMinInstances = Math.max(1, Math.floor(Number(msg.webGpuCullingMinInstances ?? 100000)));
      const webGpuMinSliceInstances = Math.max(1, Math.floor(Number(msg.webGpuCullingMinSliceInstances ?? 2048)));
      let webGpuReason = 'disabled';
      if (msg.enableWebGpuCulling) {
        webGpuReason = sourceInstances >= webGpuMinInstances
          ? 'requested'
          : `below-min-instances:${sourceInstances}<${webGpuMinInstances}`;
      }
      const webGpuAvailability = getWebGpuCullingAvailability();
      const webGpuApiAvailable = webGpuAvailability.available;
      if (msg.enableWebGpuCulling && sourceInstances >= webGpuMinInstances && !webGpuApiAvailable) {
        webGpuReason = webGpuAvailability.reason;
      }
      const webGpuRequested = !!msg.enableWebGpuCulling && sourceInstances >= webGpuMinInstances && webGpuApiAvailable;
      const webGpuCuller = webGpuRequested ? await _getWebGpuCuller() : null;
      if (webGpuCuller) {
        webGpuReason = 'enabled';
      } else if (webGpuRequested) {
        webGpuReason = 'adapter-or-device-unavailable';
      }
      const webGpuStats = { enabled: !!webGpuCuller, tested: 0, kept: 0, rejected: 0 };
      const consumeVisibleIndices = (info, slice, indices) => {
        if (!(indices instanceof Uint32Array)) return;
        if (indices.length > 0) info.frustumAny = true;
        for (let n = 0; n < indices.length; n++) {
          const i = slice.off + (indices[n] * stride);
          const px = slice.arr[i + 12];
          const py = slice.arr[i + 13];
          const pz = slice.arr[i + 14];
          const dx = px - cx;
          const dy = py - cy;
          const dz = pz - cz;
          const dist2 = dx * dx + dy * dy + dz * dz;
          if (dist2 < info.bestDist2) {
            info.bestDist2 = dist2;
            info.bestDot = dx * fx + dy * fy + dz * fz;
          }
        }
      };
      const webGpuHandledSlices = new Set();
      const runWebGpuBatch = async () => {
        if (!webGpuCuller) return false;
        const batchSlices = [];
        let totalCount = 0;
        for (const [hash, info] of infos.entries()) {
          const hasFrustumRadius = !!(frustumPlanes && radiusByHash.has(hash));
          const baseRadius = hasFrustumRadius ? Math.max(0.5, _safeNum(radiusByHash.get(hash), 0.5)) : 0.0;
          for (const slice of info.slices) {
            const count = Math.floor(Number(slice.len ?? 0) / stride);
            if (count < webGpuMinSliceInstances) continue;
            batchSlices.push({ info, slice, start: totalCount, count, radius: baseRadius });
            totalCount += count;
          }
        }
        if (!batchSlices.length || totalCount <= 0) {
          webGpuReason = 'no-eligible-slices';
          return false;
        }

        const scratch = _getWebGpuScratch(totalCount, stride);
        const matrices = scratch.matrices;
        const radii = scratch.radii;
        const ownerByInstance = scratch.owners;
        for (let owner = 0; owner < batchSlices.length; owner++) {
          const item = batchSlices[owner];
          const dstFloat = item.start * stride;
          const sourceLength = item.count * stride;
          matrices.set(item.slice.arr.subarray(item.slice.off, item.slice.off + sourceLength), dstFloat);
          radii.fill(item.radius, item.start, item.start + item.count);
          ownerByInstance.fill(owner, item.start, item.start + item.count);
        }

        try {
          const res = await webGpuCuller.cullIndices({
            matrices,
            lengthFloats: matrices.length,
            stride,
            planes: frustumPlanes,
            useFrustum: !!frustumPlanes,
            radii,
            padding: frustumPadding,
            cam: [cx, cy, cz],
            dir: [fx, fy, fz],
            maxDistance: maxD,
            maxBehindDistance,
            maxOut: totalCount,
          });
          if (!res || !(res.indices instanceof Uint32Array)) {
            webGpuReason = 'invalid-compute-output';
            return false;
          }
          webGpuStats.tested += Math.max(0, Math.floor(Number(res.tested) || 0));
          webGpuStats.kept += Math.max(0, Math.floor(Number(res.visible) || 0));
          webGpuStats.rejected += Math.max(0, Math.floor(Number(res.rejected) || 0));
          const visibleCounts = new Uint32Array(batchSlices.length);
          for (let i = 0; i < res.indices.length; i++) {
            const globalIndex = res.indices[i] >>> 0;
            if (globalIndex >= totalCount) continue;
            const owner = ownerByInstance[globalIndex] >>> 0;
            if (owner < batchSlices.length) visibleCounts[owner]++;
          }
          const visibleBySlice = Array.from(
            visibleCounts,
            (count) => new Uint32Array(count),
          );
          const visibleCursors = new Uint32Array(batchSlices.length);
          for (let i = 0; i < res.indices.length; i++) {
            const globalIndex = res.indices[i] >>> 0;
            if (globalIndex >= totalCount) continue;
            const owner = ownerByInstance[globalIndex] >>> 0;
            const item = batchSlices[owner];
            if (!item) continue;
            visibleBySlice[owner][visibleCursors[owner]++] = globalIndex - item.start;
          }
          for (let owner = 0; owner < batchSlices.length; owner++) {
            const item = batchSlices[owner];
            const indices = visibleBySlice[owner];
            item.slice.visibleIndices = indices;
            webGpuHandledSlices.add(item.slice);
            consumeVisibleIndices(item.info, item.slice, indices);
          }
          webGpuReason = `enabled-batched:${batchSlices.length}`;
          return true;
        } catch {
          _webGpuCullerFailed = true;
          try { _webGpuCuller?.destroy?.(); } catch { /* ignore */ }
          _webGpuCuller = null;
          webGpuReason = 'compute-failed';
          return false;
        }
      };
      const runWasmSlice = (hash, slice, baseRadius, useFrustumForHash) => {
        if (!wasmCuller || !slice || !slice.arr) return null;
        const count = Math.floor(Number(slice.len ?? 0) / stride);
        if (count < wasmMinSliceInstances) return null;
        try {
          const res = wasmCuller.cullIndices({
            matrices: slice.arr,
            offsetFloats: slice.off,
            lengthFloats: slice.len,
            stride,
            planes: frustumPlanes,
            useFrustum: !!useFrustumForHash,
            radius: baseRadius,
            padding: frustumPadding,
            cam: [cx, cy, cz],
            dir: [fx, fy, fz],
            maxDistance: maxD,
            maxBehindDistance,
            maxOut: count,
          });
          if (!res || !(res.indices instanceof Uint32Array)) return null;
          wasmStats.tested += Math.max(0, Math.floor(Number(res.tested) || 0));
          wasmStats.kept += Math.max(0, Math.floor(Number(res.visible) || 0));
          wasmStats.rejected += Math.max(0, Math.floor(Number(res.rejected) || 0));
          slice.visibleIndices = res.indices;
          return res.indices;
        } catch {
          _wasmCullerFailed = true;
          _wasmCuller = null;
          return null;
        }
      };

      await runWebGpuBatch();

      // Update bestDist2/bestDot after optional bulk culling.
      for (const [hash, info] of infos.entries()) {
        const hasFrustumRadius = !!(frustumPlanes && radiusByHash.has(hash));
        const baseRadius = hasFrustumRadius ? Math.max(0.5, _safeNum(radiusByHash.get(hash), 0.5)) : 0.0;
        for (const s of info.slices) {
          if (webGpuHandledSlices.has(s)) continue;

          const wasmIndices = runWasmSlice(hash, s, baseRadius, hasFrustumRadius);
          if (wasmIndices) {
            consumeVisibleIndices(info, s, wasmIndices);
            continue;
          }

          let jsVisibleIndices = null;
          let localIndex = 0;
          for (let i = s.off; i + (stride - 1) < (s.off + s.len); i += stride) {
            const px = s.arr[i + 12];
            const py = s.arr[i + 13];
            const pz = s.arr[i + 14];
            if (hasFrustumRadius) {
              if (!jsVisibleIndices) jsVisibleIndices = [];
              frustumTested++;
              const radius = baseRadius * Math.max(1.0, _instanceMaxScale(s.arr, i)) + frustumPadding;
              if (!_sphereIntersectsPlanes(frustumPlanes, px, py, pz, radius)) {
                frustumCulled++;
                localIndex++;
                continue;
              }
              jsVisibleIndices.push(localIndex);
            }
            info.frustumAny = true;
            const dx = px - cx;
            const dy = py - cy;
            const dz = pz - cz;
            const dist2 = dx * dx + dy * dy + dz * dz;
            if (dist2 < info.bestDist2) {
              info.bestDist2 = dist2;
                info.bestDot = dx * fx + dy * fy + dz * fz;
            }
            localIndex++;
          }
          if (jsVisibleIndices) s.visibleIndices = Uint32Array.from(jsVisibleIndices);
        }
      }

      // Score + pick candidates.
      const scored = [];
      for (const [hash, info] of infos.entries()) {
        if (frustumPlanes && radiusByHash.has(hash) && !info.frustumAny) continue;
        const d = Math.sqrt(Math.max(0, info.bestDist2));
        if (d > maxD) continue;
        const ba = (Number(info.bestDot) >= 0) ? 1.0 : behindPenalty;
        scored.push({ hash, d, dot: info.bestDot, score: d * ba, totalLen: info.totalLen });
      }
      scored.sort((a, b) => (a.score - b.score) || (a.hash < b.hash ? -1 : 1));
      const keep = (maxCandidates > 0) ? scored.slice(0, maxCandidates) : scored;

      // Select individual transforms before transfer. Archetype-only selection still uploads every
      // copy of a nearby model, including copies far outside the playable bubble.
      let remainingInstances = maxVisibleInstances;
      const selected = [];
      let duplicateInstancesDropped = 0;
      let eligibleInstances = 0;
      let selectedInstances = 0;
      for (const e of keep) {
        const info = infos.get(e.hash);
        if (!info) continue;
        const desiredCount = Math.min(maxInstancesPerArchetype, remainingInstances);
        const nearest = []; // max-heap: the farthest retained instance stays at index 0
        const selectedTransforms = new Set();
        const isWorse = (a, b) => (a.dist > b.dist) || (a.dist === b.dist && a.offset > b.offset);
        const pushNearest = (candidate) => {
          if (desiredCount <= 0) return;
          if (nearest.length < desiredCount) {
            let child = nearest.length;
            nearest.push(candidate);
            while (child > 0) {
              const parent = (child - 1) >> 1;
              if (!isWorse(nearest[child], nearest[parent])) break;
              [nearest[child], nearest[parent]] = [nearest[parent], nearest[child]];
              child = parent;
            }
            return;
          }
          if (!isWorse(nearest[0], candidate)) return;
          nearest[0] = candidate;
          let parent = 0;
          while (true) {
            const left = parent * 2 + 1;
            const right = left + 1;
            let worst = parent;
            if (left < nearest.length && isWorse(nearest[left], nearest[worst])) worst = left;
            if (right < nearest.length && isWorse(nearest[right], nearest[worst])) worst = right;
            if (worst === parent) break;
            [nearest[parent], nearest[worst]] = [nearest[worst], nearest[parent]];
            parent = worst;
          }
        };
        const hasFrustumRadius = !!(frustumPlanes && radiusByHash.has(e.hash));
        const baseRadius = hasFrustumRadius ? Math.max(0.5, _safeNum(radiusByHash.get(e.hash), 0.5)) : 0.0;
        const considerCandidate = (arr, i, skipBoundsCull = false) => {
          const px = arr[i + 12];
          const py = arr[i + 13];
          const pz = arr[i + 14];
          if (!skipBoundsCull && hasFrustumRadius) {
            const radius = baseRadius * Math.max(1.0, _instanceMaxScale(arr, i)) + frustumPadding;
            if (!_sphereIntersectsPlanes(frustumPlanes, px, py, pz, radius)) return;
          }
          const ox = px - cx;
          const oy = py - cy;
          const oz = pz - cz;
          const dist = Math.hypot(ox, oy, oz);
          if (dist > maxD) return;
          const dot = ox * fx + oy * fy + oz * fz;
          if (dot < 0.0 && dist > maxBehindDistance) return;
          const transformKey = _instanceTransformSignature(arr, i, stride);
          if (selectedTransforms.has(transformKey)) {
            duplicateInstancesDropped++;
            return;
          }
          selectedTransforms.add(transformKey);
          eligibleInstances++;
          pushNearest({ arr, offset: i, dist });
        };
        for (const s of info.slices) {
          const end = s.off + s.len;
          if (s.visibleIndices instanceof Uint32Array) {
            for (let n = 0; n < s.visibleIndices.length; n++) {
              considerCandidate(s.arr, s.off + (s.visibleIndices[n] * stride), true);
            }
            continue;
          }
          for (let i = s.off; i + (stride - 1) < end; i += stride) {
            considerCandidate(s.arr, i, false);
          }
        }
        nearest.sort((a, b) => (a.dist - b.dist) || (a.offset - b.offset));
        const mats = [];
        for (const candidate of nearest) {
          for (let j = 0; j < stride; j++) mats.push(candidate.arr[candidate.offset + j]);
        }
        const keptForHash = nearest.length;
        selectedInstances += keptForHash;
        remainingInstances -= keptForHash;
        if (keptForHash > 0) selected.push({ ...e, mats });
      }

      // Pack kept hashes into one transferable buffer (same format as parse results).
      let totalFloats = 0;
      for (const e of selected) totalFloats += e.mats.length;
      const packed = new Float32Array(totalFloats);
      const matsIndex = [];
      const minDistEntries = [];
      const bestDotEntries = [];

      let cursor = 0;
      for (const e of selected) {
        const start = cursor;
        packed.set(e.mats, cursor);
        cursor += e.mats.length;
        matsIndex.push({ hash: e.hash, offsetFloats: start, lengthFloats: cursor - start, strideFloats: 22 });
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
        mloInstanceEntries,
        totalFloats: packed.length,
        sourceInstances,
        duplicateInstancesDropped,
        cappedInstances: Math.max(0, eligibleInstances - selectedInstances),
        frustumEnabled: !!frustumPlanes,
        frustumTested,
        frustumCulled,
        wasmCullingEnabled: !!wasmStats.enabled,
        wasmCullingTested: wasmStats.tested,
        wasmCullingKept: wasmStats.kept,
        wasmCullingRejected: wasmStats.rejected,
        webGpuCullingEnabled: !!webGpuStats.enabled,
        webGpuCullingRequested: !!webGpuRequested,
        webGpuCullingReason: webGpuReason,
        webGpuCullingTested: webGpuStats.tested,
        webGpuCullingKept: webGpuStats.kept,
        webGpuCullingRejected: webGpuStats.rejected,
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
      _parseEnt1(reqId, msg.camData, buffer, {
        storeKey: msg.storeKey,
        storeOnly: msg.storeOnly,
        worldBounds: msg.worldBounds,
        dedupeExactRecords: msg.dedupeExactRecords === true,
      });
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
        worldBounds: msg.worldBounds || null,
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


