// Tiny dependency-free WASM backend for bulk instance culling inside chunk_worker.js.
//
// ABI:
//   memory export: caller copies Float32 instance records, optional 6 frustum planes, and receives u32 indices.
//   cull(matsPtr, count, stride, planesPtr, useFrustum,
//        baseRadius, padding,
//        camX, camY, camZ, fwdX, fwdY, fwdZ,
//        maxDistance, maxBehindDistance,
//        outPtr, maxOut) -> visible count
//
// It intentionally returns visible local instance indices instead of compacted matrices so JS can reuse the
// existing dedupe, heap selection, and material packing logic without changing renderer contracts.

const I32 = 0x7f;
const F32 = 0x7d;

function u32(n) {
    let v = Number(n) >>> 0;
    const out = [];
    do {
        let b = v & 0x7f;
        v >>>= 7;
        if (v) b |= 0x80;
        out.push(b);
    } while (v);
    return out;
}

function f32Bytes(v) {
    const b = new ArrayBuffer(4);
    new DataView(b).setFloat32(0, Number(v), true);
    return Array.from(new Uint8Array(b));
}

function utf8(s) {
    const bytes = Array.from(new TextEncoder().encode(String(s)));
    return [...u32(bytes.length), ...bytes];
}

function section(id, bytes) {
    return [id, ...u32(bytes.length), ...bytes];
}

function vec(bytesArray) {
    return [...u32(bytesArray.length), ...bytesArray.flat()];
}

function i32Const(v) { return [0x41, ...u32(v)]; }
function f32Const(v) { return [0x43, ...f32Bytes(v)]; }
function localGet(i) { return [0x20, ...u32(i)]; }
function localSet(i) { return [0x21, ...u32(i)]; }
function f32Load(offset = 0) { return [0x2a, ...u32(2), ...u32(offset)]; }
function i32Store(offset = 0) { return [0x36, ...u32(2), ...u32(offset)]; }
function f32LoadFromBase(baseLocal, byteOffset) {
    return [...localGet(baseLocal), ...i32Const(byteOffset), 0x6a, ...f32Load()];
}

function buildCullerModuleBytes() {
    const P = {
        mats: 0,
        count: 1,
        stride: 2,
        planes: 3,
        useFrustum: 4,
        baseRadius: 5,
        padding: 6,
        camX: 7,
        camY: 8,
        camZ: 9,
        fwdX: 10,
        fwdY: 11,
        fwdZ: 12,
        maxDistance: 13,
        maxBehindDistance: 14,
        out: 15,
        maxOut: 16,
    };
    const L = {
        i: 17,
        visible: 18,
        baseOff: 19,
        accepted: 20,
        plane: 21,
        planeOff: 22,
        px: 23,
        py: 24,
        pz: 25,
        sx: 26,
        sy: 27,
        sz: 28,
        scale: 29,
        radius: 30,
        ox: 31,
        oy: 32,
        oz: 33,
        dist2: 34,
        dot: 35,
        maxD2: 36,
        maxBehind2: 37,
    };

    const loadMat = (floatIndex) => f32LoadFromBase(L.baseOff, floatIndex * 4);
    const loadPlane = (floatIndex) => f32LoadFromBase(L.planeOff, floatIndex * 4);
    const squareLoad = (floatIndex) => [...loadMat(floatIndex), ...loadMat(floatIndex), 0x94];
    const setI32 = (idx, expr) => [...expr, ...localSet(idx)];
    const setF32 = (idx, expr) => [...expr, ...localSet(idx)];

    const body = [
        // local decls: 6 i32, 15 f32
        ...u32(2), ...u32(6), I32, ...u32(15), F32,

        ...setI32(L.i, i32Const(0)),
        ...setI32(L.visible, i32Const(0)),
        ...setF32(L.maxD2, [...localGet(P.maxDistance), ...localGet(P.maxDistance), 0x94]),
        ...setF32(L.maxBehind2, [...localGet(P.maxBehindDistance), ...localGet(P.maxBehindDistance), 0x94]),

        0x02, 0x40, // block exit
        0x03, 0x40, // loop
        ...localGet(L.i), ...localGet(P.count), 0x4f, 0x0d, 0x01, // if i >= count, break
        ...localGet(L.visible), ...localGet(P.maxOut), 0x4f, 0x0d, 0x01, // if visible >= maxOut, break

        ...setI32(L.baseOff, [
            ...localGet(P.mats),
            ...localGet(L.i), ...localGet(P.stride), 0x6c,
            ...i32Const(2), 0x74,
            0x6a,
        ]),
        ...setF32(L.px, loadMat(12)),
        ...setF32(L.py, loadMat(13)),
        ...setF32(L.pz, loadMat(14)),
        ...setI32(L.accepted, i32Const(1)),

        // Optional frustum sphere test.
        ...localGet(P.useFrustum),
        0x04, 0x40, // if
        ...setF32(L.sx, [...squareLoad(0), ...squareLoad(1), 0x92, ...squareLoad(2), 0x92, 0x91]),
        ...setF32(L.sy, [...squareLoad(4), ...squareLoad(5), 0x92, ...squareLoad(6), 0x92, 0x91]),
        ...setF32(L.sz, [...squareLoad(8), ...squareLoad(9), 0x92, ...squareLoad(10), 0x92, 0x91]),
        ...setF32(L.scale, [...f32Const(1.0), ...localGet(L.sx), ...localGet(L.sy), ...localGet(L.sz), 0x97, 0x97, 0x97]),
        ...setF32(L.radius, [...localGet(P.baseRadius), ...localGet(L.scale), 0x94, ...localGet(P.padding), 0x92]),
        ...setI32(L.plane, i32Const(0)),
        0x02, 0x40, // block planeExit
        0x03, 0x40, // loop planeLoop
        ...localGet(L.plane), ...i32Const(6), 0x4f, 0x0d, 0x01,
        ...localGet(L.accepted), 0x45, 0x0d, 0x01,
        ...setI32(L.planeOff, [...localGet(P.planes), ...localGet(L.plane), ...i32Const(4), 0x74, 0x6a]),
        // signed distance = p.xyz dot center + p.w
        ...loadPlane(0), ...localGet(L.px), 0x94,
        ...loadPlane(1), ...localGet(L.py), 0x94, 0x92,
        ...loadPlane(2), ...localGet(L.pz), 0x94, 0x92,
        ...loadPlane(3), 0x92,
        ...localGet(L.radius), 0x8c, 0x5d, // dist < -radius
        0x04, 0x40,
        ...setI32(L.accepted, i32Const(0)),
        0x0b,
        ...setI32(L.plane, [...localGet(L.plane), ...i32Const(1), 0x6a]),
        0x0c, 0x00,
        0x0b, // end plane loop
        0x0b, // end plane block
        0x0b, // end if useFrustum

        // Distance and behind-camera reject.
        ...localGet(L.accepted),
        0x04, 0x40,
        ...setF32(L.ox, [...localGet(L.px), ...localGet(P.camX), 0x93]),
        ...setF32(L.oy, [...localGet(L.py), ...localGet(P.camY), 0x93]),
        ...setF32(L.oz, [...localGet(L.pz), ...localGet(P.camZ), 0x93]),
        ...setF32(L.dist2, [
            ...localGet(L.ox), ...localGet(L.ox), 0x94,
            ...localGet(L.oy), ...localGet(L.oy), 0x94, 0x92,
            ...localGet(L.oz), ...localGet(L.oz), 0x94, 0x92,
        ]),
        ...localGet(L.dist2), ...localGet(L.maxD2), 0x5e,
        0x04, 0x40,
        ...setI32(L.accepted, i32Const(0)),
        0x0b,
        ...setF32(L.dot, [
            ...localGet(L.ox), ...localGet(P.fwdX), 0x94,
            ...localGet(L.oy), ...localGet(P.fwdY), 0x94, 0x92,
            ...localGet(L.oz), ...localGet(P.fwdZ), 0x94, 0x92,
        ]),
        ...localGet(L.dot), ...f32Const(0.0), 0x5d,
        0x04, 0x40,
        ...localGet(L.dist2), ...localGet(L.maxBehind2), 0x5e,
        0x04, 0x40,
        ...setI32(L.accepted, i32Const(0)),
        0x0b,
        0x0b,
        0x0b,

        // Output local instance index.
        ...localGet(L.accepted),
        0x04, 0x40,
        ...localGet(P.out), ...localGet(L.visible), ...i32Const(2), 0x74, 0x6a,
        ...localGet(L.i),
        ...i32Store(),
        ...setI32(L.visible, [...localGet(L.visible), ...i32Const(1), 0x6a]),
        0x0b,

        ...setI32(L.i, [...localGet(L.i), ...i32Const(1), 0x6a]),
        0x0c, 0x00,
        0x0b, // end main loop
        0x0b, // end exit block
        ...localGet(L.visible),
        0x0b, // end func
    ];

    const params = [
        I32, I32, I32, I32, I32,
        F32, F32,
        F32, F32, F32, F32, F32, F32,
        F32, F32,
        I32, I32,
    ];
    const typeSection = [
        ...u32(1),
        0x60,
        ...u32(params.length), ...params,
        ...u32(1), I32,
    ];
    const functionSection = [...u32(1), ...u32(0)];
    const memorySection = [...u32(1), 0x00, ...u32(1)];
    const exportSection = [
        ...u32(2),
        ...utf8('memory'), 0x02, ...u32(0),
        ...utf8('cull'), 0x00, ...u32(0),
    ];
    const funcBody = [...u32(body.length), ...body];
    const codeSection = [...u32(1), ...funcBody];

    return new Uint8Array([
        0x00, 0x61, 0x73, 0x6d,
        0x01, 0x00, 0x00, 0x00,
        ...section(1, typeSection),
        ...section(3, functionSection),
        ...section(5, memorySection),
        ...section(7, exportSection),
        ...section(10, codeSection),
    ]);
}

let _moduleBytes = null;
let _compiledModule = null;

export function createWasmCuller() {
    if (typeof WebAssembly === 'undefined') return null;
    if (!_moduleBytes) _moduleBytes = buildCullerModuleBytes();
    if (!WebAssembly.validate(_moduleBytes)) return null;
    if (!_compiledModule) _compiledModule = new WebAssembly.Module(_moduleBytes);

    const instance = new WebAssembly.Instance(_compiledModule, {});
    const memory = instance.exports.memory;
    const cull = instance.exports.cull;
    if (!(memory instanceof WebAssembly.Memory) || typeof cull !== 'function') return null;

    const align = (value, bytes = 16) => (value + (bytes - 1)) & ~(bytes - 1);
    const ensureCapacity = (byteLength) => {
        const current = memory.buffer.byteLength;
        if (current >= byteLength) return;
        const needPages = Math.ceil(byteLength / 65536);
        const currentPages = Math.floor(current / 65536);
        memory.grow(Math.max(0, needPages - currentPages));
    };

    return {
        cullIndices({
            matrices,
            offsetFloats = 0,
            lengthFloats = 0,
            stride = 22,
            planes = null,
            useFrustum = false,
            radius = 0,
            padding = 0,
            cam = [0, 0, 0],
            dir = [0, 0, -1],
            maxDistance = 1e30,
            maxBehindDistance = 1e30,
            maxOut = 0,
        } = {}) {
            const src = matrices instanceof Float32Array ? matrices : null;
            const strideFloats = Math.max(16, Math.floor(Number(stride) || 22));
            const off = Math.max(0, Math.floor(Number(offsetFloats) || 0));
            const len = Math.max(0, Math.floor(Number(lengthFloats) || 0));
            const count = Math.floor(len / strideFloats);
            const outCap = Math.max(0, Math.min(count, Math.floor(Number(maxOut) || count)));
            if (!src || count <= 0 || outCap <= 0) {
                return { tested: 0, visible: 0, rejected: 0, indices: new Uint32Array(0) };
            }

            const matsPtr = 0;
            const matsBytes = len * 4;
            const planesPtr = align(matsPtr + matsBytes, 16);
            const outPtr = align(planesPtr + 24 * 4, 16);
            ensureCapacity(outPtr + outCap * 4);

            new Float32Array(memory.buffer, matsPtr, len).set(src.subarray(off, off + len));

            const hasPlanes = !!(useFrustum && planes && planes.length >= 24 && Number(radius) > 0);
            if (hasPlanes) {
                new Float32Array(memory.buffer, planesPtr, 24).set(planes.subarray ? planes.subarray(0, 24) : Array.prototype.slice.call(planes, 0, 24));
            }

            const visible = cull(
                matsPtr,
                count,
                strideFloats,
                planesPtr,
                hasPlanes ? 1 : 0,
                Number(radius) || 0,
                Math.max(0, Number(padding) || 0),
                Number(cam?.[0]) || 0,
                Number(cam?.[1]) || 0,
                Number(cam?.[2]) || 0,
                Number(dir?.[0]) || 0,
                Number(dir?.[1]) || 0,
                Number(dir?.[2]) || -1,
                Number.isFinite(Number(maxDistance)) ? Number(maxDistance) : 1e30,
                Number.isFinite(Number(maxBehindDistance)) ? Number(maxBehindDistance) : 1e30,
                outPtr,
                outCap,
            ) | 0;

            const n = Math.max(0, Math.min(outCap, visible));
            const indices = new Uint32Array(new Uint32Array(memory.buffer, outPtr, n));
            return { tested: count, visible: n, rejected: Math.max(0, count - n), indices };
        },
    };
}

