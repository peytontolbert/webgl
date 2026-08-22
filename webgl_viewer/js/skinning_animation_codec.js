// Compact GTA skinning palette codecs. Matrix data stays as float16 until a
// renderer needs an individual frame, avoiding a large decoded animation heap.

const PACK_MAGIC = 'SKP1';
const PACK_HEADER_BYTES = 16;
const PALETTE_MAGIC = 'PAL2';
const PALETTE_HEADER_BYTES = 20;
const FRAME_CACHE_LIMIT = 4;
const textDecoder = new TextDecoder();

function readMagic(view, offset = 0) {
    return String.fromCharCode(
        view.getUint8(offset), view.getUint8(offset + 1),
        view.getUint8(offset + 2), view.getUint8(offset + 3)
    );
}

function halfToFloat(bits) {
    const sign = (bits & 0x8000) ? -1 : 1;
    const exponent = (bits >>> 10) & 0x1f;
    const fraction = bits & 0x03ff;
    if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
    if (exponent === 31) return fraction ? NaN : sign * Infinity;
    return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

function normalizeFrameIndex(index, frameCount) {
    const count = Math.max(0, Number(frameCount) | 0);
    if (!count) return -1;
    const value = Number(index) | 0;
    return ((value % count) + count) % count;
}

function normalizeRootMotion(raw, frameCount) {
    const frames = Array.isArray(raw?.frames) ? raw.frames : [];
    if (frames.length < 2 || frames.length !== frameCount) return null;
    const normalized = new Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
        const frame = frames[i];
        if (!Array.isArray(frame) || frame.length < 7) return null;
        const values = frame.slice(0, 7).map(Number);
        if (!values.every(Number.isFinite)) return null;
        const length = Math.hypot(values[3], values[4], values[5], values[6]);
        if (length < 1e-5) return null;
        values[3] /= length;
        values[4] /= length;
        values[5] /= length;
        values[6] /= length;
        normalized[i] = values;
    }
    return {
        space: String(raw?.space || 'ped_local_z_up'),
        format: String(raw?.format || 'position_xyz_rotation_xyzw'),
        frames: normalized,
    };
}

function makeFloat16Clip(meta, values, valueOffset = 0) {
    const boneCount = Math.max(0, Number(meta?.boneCount) | 0);
    const frameCount = Math.max(0, Number(meta?.frameCount) | 0);
    const frameStride = boneCount * 12;
    const offset = Math.max(0, Number(valueOffset) | 0);
    const valueCount = frameCount * frameStride;
    if (!boneCount || frameCount < 2 || !frameStride || !values || offset + valueCount > values.length) {
        throw new Error('Compressed skinning palette is malformed');
    }
    const rootMotion = normalizeRootMotion(meta?.rootMotion, frameCount);
    return {
        name: String(meta?.name || '').trim().toLowerCase(),
        sourceYcd: String(meta?.sourceYcd || ''),
        sourceClip: String(meta?.sourceClip || meta?.sourceClipName || meta?.name || ''),
        composite: meta?.composite === true,
        weaponLayer: meta?.weaponLayer === true,
        requiresProceduralRecoil: meta?.requiresProceduralRecoil === true,
        fullBody: meta?.fullBody === true,
        duration: Math.max(1 / Math.max(1, Number(meta?.fps) || 30), Number(meta?.duration) || (frameCount / Math.max(1, Number(meta?.fps) || 30))),
        fps: Math.max(1, Number(meta?.fps) || 30),
        frameCount,
        boneCount,
        frameStride,
        frameValues: values.subarray(offset, offset + valueCount),
        ...(rootMotion ? { rootMotion } : {}),
    };
}

/**
 * Decode one cached float16 frame. Raw Float32 frames continue to work so
 * unconverted exports remain a valid fallback.
 */
export function getSkinningAnimationFrame(clip, frameIndex) {
    const index = normalizeFrameIndex(frameIndex, clip?.frameCount || clip?.frames?.length || 0);
    if (index < 0 || !clip) return null;
    if (Array.isArray(clip.frames)) return clip.frames[index] || null;
    const values = clip.frameValues;
    const stride = Math.max(0, Number(clip.frameStride) | 0);
    if (!(values instanceof Uint16Array) || !stride || (index + 1) * stride > values.length) return null;

    let cache = clip._decodedFrameCache;
    if (!cache) {
        cache = new Map();
        clip._decodedFrameCache = cache;
    }
    const cached = cache.get(index);
    if (cached) {
        cache.delete(index);
        cache.set(index, cached);
        return cached;
    }
    const start = index * stride;
    const frame = new Float32Array(stride);
    for (let i = 0; i < stride; i++) {
        const value = halfToFloat(values[start + i]);
        if (!Number.isFinite(value)) return null;
        frame[i] = value;
    }
    cache.set(index, frame);
    while (cache.size > FRAME_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return frame;
}

/** Decode a PAL2 emote file without expanding every frame to Float32. */
export function decodeFloat16PaletteClip(arrayBuffer, entry = {}) {
    const view = new DataView(arrayBuffer);
    if (view.byteLength < PALETTE_HEADER_BYTES || readMagic(view) !== PALETTE_MAGIC) {
        throw new Error('Unsupported compressed palette');
    }
    const version = view.getUint16(4, true);
    const boneCount = view.getUint16(6, true);
    const frameCount = view.getUint16(8, true);
    const duration = view.getFloat32(12, true);
    const fps = view.getFloat32(16, true);
    const expectedBytes = PALETTE_HEADER_BYTES + boneCount * frameCount * 12 * 2;
    if (version !== 1 || !boneCount || frameCount < 2 || expectedBytes !== view.byteLength) {
        throw new Error('Compressed palette frame data is malformed');
    }
    return makeFloat16Clip({
        ...entry,
        name: entry.command,
        fullBody: true,
        boneCount,
        frameCount,
        duration,
        fps,
    }, new Uint16Array(arrayBuffer, PALETTE_HEADER_BYTES, boneCount * frameCount * 12));
}

/** Decode an SKP1 animation-set archive emitted by the offline packer. */
export function decodeSkinningAnimationPack(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    if (view.byteLength < PACK_HEADER_BYTES || readMagic(view) !== PACK_MAGIC) {
        throw new Error('Unsupported skinning animation pack');
    }
    const version = view.getUint16(4, true);
    const headerBytes = view.getUint16(6, true);
    const metadataBytes = view.getUint32(8, true);
    const valuesOffset = view.getUint32(12, true);
    if (version !== 1 || headerBytes !== PACK_HEADER_BYTES || valuesOffset < headerBytes + metadataBytes || valuesOffset > view.byteLength || (valuesOffset & 1) !== 0 || ((view.byteLength - valuesOffset) & 1) !== 0) {
        throw new Error('Skinning animation pack header is malformed');
    }
    let metadata;
    try {
        metadata = JSON.parse(textDecoder.decode(new Uint8Array(arrayBuffer, headerBytes, metadataBytes)));
    } catch {
        throw new Error('Skinning animation pack metadata is invalid');
    }
    const boneCount = Math.max(0, Number(metadata?.boneCount) | 0);
    const rawClips = Array.isArray(metadata?.clips) ? metadata.clips : [];
    if (!boneCount || !rawClips.length) throw new Error('Skinning animation pack has no clips');
    const values = new Uint16Array(arrayBuffer, valuesOffset, (view.byteLength - valuesOffset) / 2);
    const clips = {};
    for (const raw of rawClips) {
        const name = String(raw?.name || '').trim().toLowerCase();
        if (!name) continue;
        const clip = makeFloat16Clip({ ...raw, name, boneCount }, values, raw.valueOffset);
        clips[name] = clip;
    }
    if (!Object.keys(clips).length) throw new Error('Skinning animation pack has no valid clips');
    return {
        schema: String(metadata?.schema || 'webglgta-float16-skinning-pack-v1'),
        boneCount,
        clips,
    };
}
