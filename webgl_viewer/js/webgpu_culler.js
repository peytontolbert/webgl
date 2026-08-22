// Optional WebGPU compute backend for bulk instance culling.
//
// This mirrors the WASM culler ABI at the JS boundary: packed matrix records in,
// visible local instance indices out. It is intentionally not a hard dependency
// for the WebGL2 renderer; callers should try it only for very dense rebuilds
// where upload + compute + readback is cheaper than CPU filtering.

const WGSL = `
struct Params {
    count: u32,
    stride: u32,
    useFrustum: u32,
    maxOut: u32,
    baseRadius: f32,
    padding: f32,
    maxDistance: f32,
    maxBehindDistance: f32,
    cam: vec4<f32>,
    dir: vec4<f32>,
};

struct Output {
    count: atomic<u32>,
    indices: array<u32>,
};

@group(0) @binding(0) var<storage, read> matrices: array<f32>;
@group(0) @binding(1) var<storage, read> planes: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: Params;
@group(0) @binding(3) var<storage, read_write> outData: Output;
@group(0) @binding(4) var<storage, read> radii: array<f32>;

fn matrixValue(instanceIndex: u32, elementIndex: u32) -> f32 {
    return matrices[instanceIndex * params.stride + elementIndex];
}

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= params.count) {
        return;
    }

    let px = matrixValue(i, 12u);
    let py = matrixValue(i, 13u);
    let pz = matrixValue(i, 14u);
    var accepted = true;

    var instanceBaseRadius = params.baseRadius;
    if (params.baseRadius < 0.0) {
        instanceBaseRadius = radii[i];
    }
    if (params.useFrustum != 0u && instanceBaseRadius > 0.0) {
        let sx = sqrt(
            matrixValue(i, 0u) * matrixValue(i, 0u) +
            matrixValue(i, 1u) * matrixValue(i, 1u) +
            matrixValue(i, 2u) * matrixValue(i, 2u)
        );
        let sy = sqrt(
            matrixValue(i, 4u) * matrixValue(i, 4u) +
            matrixValue(i, 5u) * matrixValue(i, 5u) +
            matrixValue(i, 6u) * matrixValue(i, 6u)
        );
        let sz = sqrt(
            matrixValue(i, 8u) * matrixValue(i, 8u) +
            matrixValue(i, 9u) * matrixValue(i, 9u) +
            matrixValue(i, 10u) * matrixValue(i, 10u)
        );
        let r = instanceBaseRadius * max(1.0, max(sx, max(sy, sz))) + params.padding;
        for (var p = 0u; p < 6u; p = p + 1u) {
            let plane = planes[p];
            let dist = plane.x * px + plane.y * py + plane.z * pz + plane.w;
            if (dist < -r) {
                accepted = false;
            }
        }
    }

    if (accepted) {
        let dx = px - params.cam.x;
        let dy = py - params.cam.y;
        let dz = pz - params.cam.z;
        let dist2 = dx * dx + dy * dy + dz * dz;
        if (dist2 > params.maxDistance * params.maxDistance) {
            accepted = false;
        }
        let facing = dx * params.dir.x + dy * params.dir.y + dz * params.dir.z;
        if (facing < 0.0 && dist2 > params.maxBehindDistance * params.maxBehindDistance) {
            accepted = false;
        }
    }

    if (accepted) {
        let outIndex = atomicAdd(&outData.count, 1u);
        if (outIndex < params.maxOut) {
            outData.indices[outIndex] = i;
        }
    }
}
`;

export function getWebGpuCullingAvailability() {
    if (typeof globalThis !== 'undefined' && globalThis.isSecureContext === false) {
        return { available: false, reason: 'secure-context-required' };
    }
    if (typeof navigator === 'undefined' || !navigator.gpu) {
        return { available: false, reason: 'navigator.gpu-unavailable' };
    }
    return { available: true, reason: 'available' };
}

function canUseWebGpuApi() {
    return getWebGpuCullingAvailability().available;
}

function finiteNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function writeParams({
    count,
    stride,
    useFrustum,
    maxOut,
    radius,
    padding,
    cam,
    dir,
    maxDistance,
    maxBehindDistance,
}) {
    const out = new ArrayBuffer(64);
    const dv = new DataView(out);
    dv.setUint32(0, count >>> 0, true);
    dv.setUint32(4, stride >>> 0, true);
    dv.setUint32(8, useFrustum ? 1 : 0, true);
    dv.setUint32(12, maxOut >>> 0, true);
    dv.setFloat32(16, finiteNumber(radius, 0), true);
    dv.setFloat32(20, Math.max(0, finiteNumber(padding, 0)), true);
    dv.setFloat32(24, finiteNumber(maxDistance, 1e30), true);
    dv.setFloat32(28, finiteNumber(maxBehindDistance, 1e30), true);
    dv.setFloat32(32, finiteNumber(cam?.[0], 0), true);
    dv.setFloat32(36, finiteNumber(cam?.[1], 0), true);
    dv.setFloat32(40, finiteNumber(cam?.[2], 0), true);
    dv.setFloat32(44, 0, true);
    let dx = finiteNumber(dir?.[0], 0);
    let dy = finiteNumber(dir?.[1], 0);
    let dz = finiteNumber(dir?.[2], -1);
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl;
    dy /= dl;
    dz /= dl;
    dv.setFloat32(48, dx, true);
    dv.setFloat32(52, dy, true);
    dv.setFloat32(56, dz, true);
    dv.setFloat32(60, 0, true);
    return out;
}

function copyPlanes(planes) {
    const out = new Float32Array(24);
    if (planes && planes.length >= 24) {
        const src = planes.subarray ? planes.subarray(0, 24) : Array.prototype.slice.call(planes, 0, 24);
        out.set(src);
    }
    return out;
}

export function canAttemptWebGpuCulling() {
    return canUseWebGpuApi();
}

export async function createWebGpuCuller({
    powerPreference = 'high-performance',
    label = 'webglgta-webgpu-culler',
} = {}) {
    if (!canUseWebGpuApi()) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference }).catch(() => null);
    if (!adapter) return null;
    const device = await adapter.requestDevice({ label }).catch(() => null);
    if (!device) return null;
    return new WebGpuInstanceCuller(device, label);
}

export class WebGpuInstanceCuller {
    constructor(device, label = 'webglgta-webgpu-culler') {
        this.device = device;
        this.label = label;
        const module = device.createShaderModule({ label: `${label}-shader`, code: WGSL });
        this.pipeline = device.createComputePipeline({
            label: `${label}-pipeline`,
            layout: 'auto',
            compute: { module, entryPoint: 'main' },
        });
        this.bindGroupLayout = this.pipeline.getBindGroupLayout(0);
        this._buffers = null;
        this.bufferReallocations = 0;
    }

    _destroyBuffers() {
        const buffers = this._buffers;
        this._buffers = null;
        if (!buffers) return;
        for (const key of ['matrices', 'planes', 'params', 'output', 'readback', 'radii']) {
            try { buffers[key]?.destroy?.(); } catch { /* ignore */ }
        }
    }

    _nextCapacity(required, minimum = 4) {
        const value = Math.max(minimum, Math.ceil(Number(required) || 0));
        return 2 ** Math.ceil(Math.log2(value));
    }

    _ensureBuffers(matrixBytes, outputBytes, radiusBytes) {
        const current = this._buffers;
        if (current
            && current.matrixCapacity >= matrixBytes
            && current.outputCapacity >= outputBytes
            && current.radiusCapacity >= radiusBytes) {
            return current;
        }

        const device = this.device;
        const matrixCapacity = this._nextCapacity(matrixBytes);
        const outputCapacity = this._nextCapacity(outputBytes, 8);
        const radiusCapacity = this._nextCapacity(radiusBytes);
        this._destroyBuffers();
        const buffers = {
            matrixCapacity,
            outputCapacity,
            radiusCapacity,
            matrices: device.createBuffer({
                label: `${this.label}-matrices`,
                size: matrixCapacity,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            }),
            planes: device.createBuffer({
                label: `${this.label}-planes`,
                size: 24 * 4,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            }),
            params: device.createBuffer({
                label: `${this.label}-params`,
                size: 64,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            }),
            output: device.createBuffer({
                label: `${this.label}-output`,
                size: outputCapacity,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
            }),
            readback: device.createBuffer({
                label: `${this.label}-readback`,
                size: outputCapacity,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            }),
            radii: device.createBuffer({
                label: `${this.label}-radii`,
                size: radiusCapacity,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            }),
        };
        buffers.bindGroup = device.createBindGroup({
            label: `${this.label}-bindgroup`,
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: buffers.matrices } },
                { binding: 1, resource: { buffer: buffers.planes } },
                { binding: 2, resource: { buffer: buffers.params } },
                { binding: 3, resource: { buffer: buffers.output } },
                { binding: 4, resource: { buffer: buffers.radii } },
            ],
        });
        this._buffers = buffers;
        this.bufferReallocations++;
        return buffers;
    }

    async cullIndices({
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
        radii = null,
    } = {}) {
        const src = matrices instanceof Float32Array ? matrices : null;
        const strideFloats = Math.max(16, Math.floor(finiteNumber(stride, 22)));
        const off = Math.max(0, Math.floor(finiteNumber(offsetFloats, 0)));
        const len = Math.max(0, Math.floor(finiteNumber(lengthFloats, 0)));
        const count = Math.floor(len / strideFloats);
        const outCap = Math.max(0, Math.min(count, Math.floor(finiteNumber(maxOut, count))));
        if (!src || count <= 0 || outCap <= 0) {
            return { tested: 0, visible: 0, rejected: 0, indices: new Uint32Array(0) };
        }

        const device = this.device;
        const queue = device.queue;
        const matrixBytes = len * 4;
        const outputBytes = 4 + outCap * 4;
        const hasPerInstanceRadii = radii instanceof Float32Array && radii.length >= count;
        const radiusData = hasPerInstanceRadii ? radii.subarray(0, count) : new Float32Array(1);
        const hasPlanes = !!(
            useFrustum && planes && planes.length >= 24
            && (hasPerInstanceRadii || Number(radius) > 0)
        );
        const matrixSlice = src.subarray(off, off + len);
        const planeData = copyPlanes(planes);
        const paramData = writeParams({
            count,
            stride: strideFloats,
            useFrustum: hasPlanes,
            maxOut: outCap,
            radius: hasPerInstanceRadii ? -1 : radius,
            padding,
            cam,
            dir,
            maxDistance,
            maxBehindDistance,
        });

        const buffers = this._ensureBuffers(matrixBytes, outputBytes, Math.max(4, radiusData.byteLength));

        try {
            queue.writeBuffer(buffers.matrices, 0, matrixSlice);
            queue.writeBuffer(buffers.planes, 0, planeData);
            queue.writeBuffer(buffers.params, 0, paramData);
            queue.writeBuffer(buffers.radii, 0, radiusData);
            queue.writeBuffer(buffers.output, 0, new Uint32Array([0]));

            const encoder = device.createCommandEncoder({ label: `${this.label}-encoder` });
            const pass = encoder.beginComputePass({ label: `${this.label}-pass` });
            pass.setPipeline(this.pipeline);
            pass.setBindGroup(0, buffers.bindGroup);
            pass.dispatchWorkgroups(Math.ceil(count / 128));
            pass.end();
            encoder.copyBufferToBuffer(buffers.output, 0, buffers.readback, 0, outputBytes);
            queue.submit([encoder.finish()]);
            await queue.onSubmittedWorkDone();
            await buffers.readback.mapAsync(GPUMapMode.READ);

            const mapped = new Uint32Array(buffers.readback.getMappedRange());
            const visible = Math.max(0, Math.min(outCap, mapped[0] | 0));
            const indices = new Uint32Array(visible);
            indices.set(mapped.subarray(1, 1 + visible));
            buffers.readback.unmap();
            return {
                tested: count,
                visible,
                rejected: Math.max(0, count - visible),
                indices,
                bufferReallocations: this.bufferReallocations,
            };
        } finally {
            try { if (buffers.readback.mapState === 'mapped') buffers.readback.unmap(); } catch { /* ignore */ }
        }
    }

    destroy() {
        this._destroyBuffers();
        try { this.device?.destroy?.(); } catch { /* ignore */ }
    }
}
