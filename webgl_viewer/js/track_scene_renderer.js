import { glMatrix } from './glmatrix.js';
import { ShaderProgram } from './shader_program.js';
import { extractFrustumPlanes, aabbIntersectsFrustum } from './frustum_culling.js';

const HEADER_BYTES = 44;
const GAMEPLAY_LOCATOR_NODE = /^AC_(?:START|PIT|TIME|HOTLAP_START)(?:_|$)/i;

function isNonVisualLocatorGroup(identity, group) {
    const sourceNodes = Array.isArray(group?.sourceNodes) ? group.sourceNodes.map(String).filter(Boolean) : [];
    if (sourceNodes.length && sourceNodes.every((name) => GAMEPLAY_LOCATOR_NODE.test(name))) return true;
    // Compatibility with pre-sourceNodes 4b descriptors. The authored KN5
    // contains only timing/start/pit locator cubes in this material group.
    return String(identity?.source || '').toLowerCase() === '4b.kn5'
        && String(group?.material || '').toLowerCase() === 'grail-new';
}

const vertexSource = `#version 300 es
layout(location = 0) in vec3 aPackedPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aTangent;
layout(location = 3) in vec2 aUV;
uniform mat4 uViewProjectionMatrix;
uniform mat4 uModelMatrix;
uniform vec3 uMinimum;
uniform vec3 uSpan;
uniform float uPositionIsAbsolute;
out float vHeight;
out vec3 vNormal;
out vec3 vTangent;
out vec2 vUV;
out vec3 vWorldPosition;
void main() {
    vec3 quantizedPosition = uMinimum + (aPackedPosition / 65535.0) * uSpan;
    // Version 3 sectors retain source-space float positions for paint and
    // kerb geometry. Global 16-bit quantization across the 7 km circuit made
    // those narrow surfaces visibly stair-step even at the previous “full” LOD.
    vec3 dataPosition = mix(quantizedPosition, aPackedPosition, uPositionIsAbsolute);
    vec4 worldPosition = uModelMatrix * vec4(dataPosition, 1.0);
    vHeight = dataPosition.z;
    vNormal = normalize(mat3(uModelMatrix) * aNormal);
    vTangent = normalize(mat3(uModelMatrix) * aTangent);
    vUV = aUV;
    vWorldPosition = worldPosition.xyz;
    gl_Position = uViewProjectionMatrix * worldPosition;
}`;

// The asset inspector uses a one-pixel ID buffer.  Rendering a one-pixel
// projection keeps the result tied to the same indexed geometry and depth
// test as the visible track without retaining ~190 MB of duplicate CPU mesh
// data or iterating millions of triangles on the main thread.
const pickVertexSource = `#version 300 es
layout(location = 0) in vec3 aPackedPosition;
layout(location = 3) in vec2 aUV;
uniform mat4 uViewProjectionMatrix;
uniform mat4 uModelMatrix;
uniform vec3 uMinimum;
uniform vec3 uSpan;
uniform float uPositionIsAbsolute;
out vec2 vUV;
void main() {
    vec3 quantizedPosition = uMinimum + (aPackedPosition / 65535.0) * uSpan;
    vec3 dataPosition = mix(quantizedPosition, aPackedPosition, uPositionIsAbsolute);
    vUV = aUV;
    gl_Position = uViewProjectionMatrix * uModelMatrix * vec4(dataPosition, 1.0);
}`;

const pickFragmentSource = `#version 300 es
precision highp float;
uniform vec3 uPickColor;
uniform sampler2D uDiffuse;
uniform float uHasDiffuse;
uniform float uAlphaCutoff;
in vec2 vUV;
out vec4 fragColor;
void main() {
    if (uAlphaCutoff >= 0.0 && uHasDiffuse > 0.5
        && texture(uDiffuse, vUV).a < uAlphaCutoff) discard;
    fragColor = vec4(uPickColor, 1.0);
}
`;

const fragmentSource = `#version 300 es
// The circuit is positioned kilometres from the demo origin. mediump loses
// enough position/derivative precision at that scale to make normal maps
// shimmer, especially on the road at grazing angles.
precision highp float;
uniform vec3 uColor;
uniform sampler2D uDiffuse;
uniform sampler2D uNormalMap;
uniform sampler2D uDetail;
uniform sampler2D uDetailNormal;
uniform sampler2D uNormalDetail;
uniform sampler2D uVariation;
uniform sampler2D uMaps;
uniform sampler2D uMask;
uniform sampler2D uDetailR;
uniform sampler2D uDetailG;
uniform sampler2D uDetailB;
uniform sampler2D uDetailA;
uniform float uUseDiffuse;
uniform float uUseNormalMap;
uniform float uUseDetail;
uniform float uUseDetailNormal;
uniform float uUseNormalDetail;
uniform float uUseVariation;
uniform float uUseMaps;
uniform float uUseMask;
uniform float uUseLayerMaps;
uniform float uDetailUVMultiplier;
uniform vec2 uDetailNormalUVMultiplier;
uniform vec2 uVariationScale;
uniform vec4 uLayerUVMultiplier;
uniform float uDetailNormalBlend;
uniform float uVariationGain;
uniform float uAmbient;
uniform float uDiffuseStrength;
uniform float uSpecularStrength;
uniform float uSpecularExponent;
uniform float uEmissive;
uniform float uMagicMultiplier;
uniform float uFresnelC;
uniform float uFresnelExponent;
uniform float uFresnelMaxLevel;
uniform float uTarmacSpecularMultiplier;
uniform float uCutout;
uniform float uAlphaCutoff;
in float vHeight;
in vec3 vNormal;
in vec3 vTangent;
in vec2 vUV;
in vec3 vWorldPosition;
out vec4 fragColor;
void main() {
    vec4 base = mix(vec4(uColor, 1.0), texture(uDiffuse, vUV), uUseDiffuse);
    // In the Kunos multilayer shader, txDiffuse is the broad/far surface and
    // txDetail[RGBA] are the close-up surfaces selected by txMask.  The
    // previous renderer normalized detail layers and replaced the base map,
    // which destroyed the authored road/kerb/grass transition.
    float authoredSpecular = base.a;
    if (uUseDetail > 0.5) {
        vec3 detail = texture(uDetail, vUV * uDetailUVMultiplier).rgb;
        base.rgb *= mix(vec3(1.0), detail * 2.0, 0.30);
    }
    // ksGrass uses txVariation as a world-space macro-colour map.  It is not
    // a second albedo UV set: the authored scale vector is planar X/Z world
    // scale.  Ignoring it made the Nordschleife grass, bushes, and treelines
    // uniformly flat despite those textures being present in the package.
    if (uUseVariation > 0.5) {
        vec3 variation = texture(uVariation, vWorldPosition.xz * uVariationScale).rgb;
        base.rgb *= mix(vec3(1.0), variation * 2.0, clamp(uVariationGain, 0.0, 1.0));
    }
    // Assetto's multilayer materials use an RGBA splat mask with four detail
    // maps. Treating them as a single diffuse map left large asphalt, kerb,
    // and terrain regions visibly wrong even though those source maps had
    // been packaged with the scene.
    if (uUseMask > 0.5 && uUseLayerMaps > 0.5) {
        vec4 weights = max(texture(uMask, vUV), vec4(0.0));
        vec4 layerR = texture(uDetailR, vUV * uLayerUVMultiplier.r);
        vec4 layerG = texture(uDetailG, vUV * uLayerUVMultiplier.g);
        vec4 layerB = texture(uDetailB, vUV * uLayerUVMultiplier.b);
        vec4 layerA = texture(uDetailA, vUV * uLayerUVMultiplier.a);
        float totalWeight = min(1.0, weights.r + weights.g + weights.b + weights.a);
        vec3 layers = layerR.rgb * weights.r + layerG.rgb * weights.g
            + layerB.rgb * weights.b + layerA.rgb * weights.a;
        base.rgb = base.rgb * (1.0 - totalWeight) + layers;
        authoredSpecular = authoredSpecular * (1.0 - totalWeight)
            + layerR.a * weights.r + layerG.a * weights.g
            + layerB.a * weights.b + layerA.a * weights.a;
    }
    if (uCutout > 0.5 && base.a < uAlphaCutoff) discard;
    vec3 surfaceNormal = normalize(vNormal);
    // KN5 does not store tangent data in the compact sector, so derive the
    // tangent frame from the retained UVs and interpolated positions.
    if (uUseNormalMap > 0.5 || uUseDetailNormal > 0.5 || uUseNormalDetail > 0.5) {
        // TNM v4 preserves the KN5 tangent required by Assetto's road
        // shader. Older cached sectors fall back to a derivative frame.
        vec3 tangent = vTangent - surfaceNormal * dot(surfaceNormal, vTangent);
        if (dot(tangent, tangent) < 0.00001) {
            vec3 dpdx = dFdx(vWorldPosition);
            vec3 dpdy = dFdy(vWorldPosition);
            vec2 duvdx = dFdx(vUV);
            vec2 duvdy = dFdy(vUV);
            float determinant = duvdx.x * duvdy.y - duvdx.y * duvdy.x;
            tangent = abs(determinant) > 0.00001
                ? (dpdx * duvdy.y - dpdy * duvdx.y) / determinant
                : vec3(1.0, 0.0, 0.0);
            tangent = tangent - surfaceNormal * dot(surfaceNormal, tangent);
        }
        if (dot(tangent, tangent) > 0.00001) {
            tangent = normalize(tangent);
            vec3 bitangent = normalize(cross(surfaceNormal, tangent));
            vec3 mappedNormal = uUseNormalMap > 0.5
                ? texture(uNormalMap, vUV).xyz * 2.0 - 1.0
                : vec3(0.0, 0.0, 1.0);
            if (uUseDetailNormal > 0.5) {
                vec3 detailNormal = texture(uDetailNormal, vUV * uDetailNormalUVMultiplier).xyz * 2.0 - 1.0;
                // Reoriented normal-map blend, preserving a valid tangent-space Z.
                mappedNormal.xy += detailNormal.xy;
                mappedNormal.z = max(0.001, mappedNormal.z * detailNormal.z);
                mappedNormal = normalize(mappedNormal);
            }
            // ksPerPixelMultiMap_NMDetail has a distinct txNormalDetail slot.
            // It uses the material's detail UV multiplier and blend value,
            // rather than txDetailNM's detailNMMult vector.
            if (uUseNormalDetail > 0.5) {
                vec3 normalDetail = texture(uNormalDetail, vUV * uDetailUVMultiplier).xyz * 2.0 - 1.0;
                float blend = max(0.0, uDetailNormalBlend);
                mappedNormal.xy += normalDetail.xy * blend;
                mappedNormal.z = max(0.001, mappedNormal.z * mix(1.0, normalDetail.z, clamp(blend, 0.0, 1.0)));
                mappedNormal = normalize(mappedNormal);
            }
            surfaceNormal = normalize(mat3(tangent, bitangent, surfaceNormal) * mappedNormal);
        }
    }
    vec3 light = normalize(vec3(0.35, 0.72, 0.60));
    float diffuseLight = max(0.0, dot(surfaceNormal, light));
    float mapSpecular = uUseMaps > 0.5 ? max(texture(uMaps, vUV).r, texture(uMaps, vUV).g) : authoredSpecular;
    float specularPower = max(1.0, uSpecularExponent);
    float specular = max(0.0, dot(reflect(-light, surfaceNormal), vec3(0.0, 0.0, 1.0)));
    specular = pow(specular, specularPower) * mapSpecular * max(0.0, uSpecularStrength) * max(0.0, uTarmacSpecularMultiplier);
    float fresnel = pow(1.0 - max(0.0, surfaceNormal.z), max(0.01, uFresnelExponent)) * uFresnelC * uFresnelMaxLevel;
    float shade = max(0.0, uAmbient) + max(0.0, uDiffuseStrength) * diffuseLight + specular + fresnel;
    fragColor = vec4(base.rgb * max(0.0, uMagicMultiplier) * shade + vec3(max(0.0, uEmissive)), base.a);
}`;

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function positiveScale(value, fallback = 1) {
    const number = finite(value, fallback);
    return Math.max(0.0001, Math.abs(number || fallback));
}

function materialProperty(group, name, fallback = 0) {
    return finite(group?.properties?.[name], fallback);
}

function materialVector(group, name) {
    const value = group?.propertyVectors?.[name];
    return Array.isArray(value) ? value.map((component) => finite(component, 0)) : [];
}

function decodedBounds(decoded) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const positions = decoded?.positions;
    if (!positions) return null;
    for (let index = 0; index + 2 < positions.length; index += 3) {
        const packedX = positions[index];
        const packedY = positions[index + 1];
        const packedZ = positions[index + 2];
        const x = decoded.absolutePositions ? packedX : decoded.minimum[0] + (packedX / 65535.0) * decoded.span[0];
        const y = decoded.absolutePositions ? packedY : decoded.minimum[1] + (packedY / 65535.0) * decoded.span[1];
        const z = decoded.absolutePositions ? packedZ : decoded.minimum[2] + (packedZ / 65535.0) * decoded.span[2];
        min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z);
        max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); max[2] = Math.max(max[2], z);
    }
    return min.every(Number.isFinite) && max.every(Number.isFinite) ? { min, max } : null;
}

function transformAabb(matrix, min, max, outMin, outMax) {
    outMin[0] = outMin[1] = outMin[2] = Infinity;
    outMax[0] = outMax[1] = outMax[2] = -Infinity;
    for (let xi = 0; xi < 2; xi++) for (let yi = 0; yi < 2; yi++) for (let zi = 0; zi < 2; zi++) {
        const x = xi ? max[0] : min[0];
        const y = yi ? max[1] : min[1];
        const z = zi ? max[2] : min[2];
        const tx = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
        const ty = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
        const tz = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
        outMin[0] = Math.min(outMin[0], tx); outMin[1] = Math.min(outMin[1], ty); outMin[2] = Math.min(outMin[2], tz);
        outMax[0] = Math.max(outMax[0], tx); outMax[1] = Math.max(outMax[1], ty); outMax[2] = Math.max(outMax[2], tz);
    }
}

async function fetchGzipArrayBuffer(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Track scene request failed (${response.status})`);
    if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot decompress the streamed track scene');
    const stream = response.body?.pipeThrough?.(new DecompressionStream('gzip'));
    if (!stream) throw new Error('Track scene response body is unavailable');
    return new Response(stream).arrayBuffer();
}

function decode(buffer) {
    if (buffer.byteLength < HEADER_BYTES) throw new Error('Track scene sector is truncated');
    const view = new DataView(buffer);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    const version = view.getUint32(4, true);
    const vertexCount = view.getUint32(8, true);
    const indexCount = view.getUint32(12, true);
    const groupCount = view.getUint32(16, true);
    if (magic !== 'TNM1' || ![1, 2, 3, 4].includes(version) || vertexCount < 3 || indexCount < 3 || indexCount % 3 || groupCount < 1) throw new Error('Track scene sector header is invalid');
    const minimum = [view.getFloat32(20, true), view.getFloat32(24, true), view.getFloat32(28, true)];
    const span = [view.getFloat32(32, true), view.getFloat32(36, true), view.getFloat32(40, true)];
    if (![...minimum, ...span].every(Number.isFinite) || span.some((value) => value <= 0)) throw new Error('Track scene quantization bounds are invalid');
    const positionBytes = vertexCount * 3 * (version >= 3 ? Float32Array.BYTES_PER_ELEMENT : Uint16Array.BYTES_PER_ELEMENT);
    const normalOffset = HEADER_BYTES + positionBytes;
    const tangentOffset = normalOffset + (version >= 2 ? vertexCount * 3 : 0);
    const uvOffset = tangentOffset + (version >= 4 ? vertexCount * 3 : 0);
    const indexOffset = uvOffset + (version >= 2 ? vertexCount * 2 * Float32Array.BYTES_PER_ELEMENT : 0);
    const expected = indexOffset + indexCount * Uint32Array.BYTES_PER_ELEMENT;
    if (buffer.byteLength < expected) throw new Error('Track scene sector payload is truncated');
    const positions = version >= 3
        ? new Float32Array(buffer, HEADER_BYTES, vertexCount * 3)
        : new Uint16Array(buffer, HEADER_BYTES, vertexCount * 3);
    // The compact writer deliberately does not pad between uint16 positions and
    // uint32 indices. Copying handles sectors with an odd vertex count safely.
    const indices = new Uint32Array(indexCount);
    for (let index = 0; index < indexCount; index++) indices[index] = view.getUint32(indexOffset + index * 4, true);
    const normals = version >= 2 ? new Int8Array(buffer.slice(normalOffset, tangentOffset)) : null;
    const tangents = version >= 4 ? new Int8Array(buffer.slice(tangentOffset, uvOffset)) : null;
    const uvs = version >= 2 ? new Float32Array(vertexCount * 2) : null;
    if (uvs) for (let index = 0; index < uvs.length; index++) uvs[index] = view.getFloat32(uvOffset + index * 4, true);
    return { positions, normals, tangents, uvs, indices, vertexCount, indexCount, minimum, span, absolutePositions: version >= 3 };
}

export class TrackSceneRenderer {
    constructor(gl) {
        this.gl = gl;
        this.program = new ShaderProgram(gl);
        this.pickProgram = new ShaderProgram(gl);
        this.modelMatrix = glMatrix.mat4.create();
        this.ready = false;
        this.loading = false;
        this.error = null;
        this.models = [];
        this.sceneUrl = null;
        this.sceneQuality = 'balanced';
        this._frustumPlanes = [];
        this.stats = { sectors: 0, totalSectors: 0, vertices: 0, triangles: 0, bytes: 0, primaryLoaded: false };
        this.onProgress = null;
        this.textureCache = new Map();
        this._pickRecords = new Map();
        this._nextPickId = 1;
        this._pickFramebuffer = null;
        this._pickColorTexture = null;
        this._pickDepthBuffer = null;
        this._pickPixel = new Uint8Array(4);
        this._pickMatrix = glMatrix.mat4.create();
        this._pickViewProjection = glMatrix.mat4.create();
        this._lastRenderStats = { drawCalls: 0, triangles: 0, instances: 0, drawItems: 0, totalRenderMs: 0 };
        this._anisotropyExtension = null;
        this._maxAnisotropy = 1;
    }

    async init(modelMatrix = null) {
        await this.program.createProgram(vertexSource, fragmentSource);
        await this.pickProgram.createProgram(pickVertexSource, pickFragmentSource);
        if (modelMatrix) glMatrix.mat4.copy(this.modelMatrix, modelMatrix);
        const gl = this.gl;
        this._anisotropyExtension = gl.getExtension('EXT_texture_filter_anisotropic');
        if (this._anisotropyExtension) {
            this._maxAnisotropy = Math.max(1, Number(gl.getParameter(this._anisotropyExtension.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) || 1);
        }
        this.uniforms = {
            viewProjection: gl.getUniformLocation(this.program.program, 'uViewProjectionMatrix'),
            model: gl.getUniformLocation(this.program.program, 'uModelMatrix'),
            minimum: gl.getUniformLocation(this.program.program, 'uMinimum'),
            span: gl.getUniformLocation(this.program.program, 'uSpan'),
            positionIsAbsolute: gl.getUniformLocation(this.program.program, 'uPositionIsAbsolute'),
            color: gl.getUniformLocation(this.program.program, 'uColor'),
            diffuse: gl.getUniformLocation(this.program.program, 'uDiffuse'),
            normalMap: gl.getUniformLocation(this.program.program, 'uNormalMap'),
            detail: gl.getUniformLocation(this.program.program, 'uDetail'),
            detailNormal: gl.getUniformLocation(this.program.program, 'uDetailNormal'),
            normalDetail: gl.getUniformLocation(this.program.program, 'uNormalDetail'),
            variation: gl.getUniformLocation(this.program.program, 'uVariation'),
            maps: gl.getUniformLocation(this.program.program, 'uMaps'),
            mask: gl.getUniformLocation(this.program.program, 'uMask'),
            detailR: gl.getUniformLocation(this.program.program, 'uDetailR'),
            detailG: gl.getUniformLocation(this.program.program, 'uDetailG'),
            detailB: gl.getUniformLocation(this.program.program, 'uDetailB'),
            detailA: gl.getUniformLocation(this.program.program, 'uDetailA'),
            useDiffuse: gl.getUniformLocation(this.program.program, 'uUseDiffuse'),
            useNormalMap: gl.getUniformLocation(this.program.program, 'uUseNormalMap'),
            useDetail: gl.getUniformLocation(this.program.program, 'uUseDetail'),
            useDetailNormal: gl.getUniformLocation(this.program.program, 'uUseDetailNormal'),
            useNormalDetail: gl.getUniformLocation(this.program.program, 'uUseNormalDetail'),
            useVariation: gl.getUniformLocation(this.program.program, 'uUseVariation'),
            useMaps: gl.getUniformLocation(this.program.program, 'uUseMaps'),
            useMask: gl.getUniformLocation(this.program.program, 'uUseMask'),
            useLayerMaps: gl.getUniformLocation(this.program.program, 'uUseLayerMaps'),
            detailUVMultiplier: gl.getUniformLocation(this.program.program, 'uDetailUVMultiplier'),
            detailNormalUVMultiplier: gl.getUniformLocation(this.program.program, 'uDetailNormalUVMultiplier'),
            variationScale: gl.getUniformLocation(this.program.program, 'uVariationScale'),
            layerUVMultiplier: gl.getUniformLocation(this.program.program, 'uLayerUVMultiplier'),
            detailNormalBlend: gl.getUniformLocation(this.program.program, 'uDetailNormalBlend'),
            variationGain: gl.getUniformLocation(this.program.program, 'uVariationGain'),
            ambient: gl.getUniformLocation(this.program.program, 'uAmbient'),
            diffuseStrength: gl.getUniformLocation(this.program.program, 'uDiffuseStrength'),
            specularStrength: gl.getUniformLocation(this.program.program, 'uSpecularStrength'),
            specularExponent: gl.getUniformLocation(this.program.program, 'uSpecularExponent'),
            emissive: gl.getUniformLocation(this.program.program, 'uEmissive'),
            magicMultiplier: gl.getUniformLocation(this.program.program, 'uMagicMultiplier'),
            fresnelC: gl.getUniformLocation(this.program.program, 'uFresnelC'),
            fresnelExponent: gl.getUniformLocation(this.program.program, 'uFresnelExponent'),
            fresnelMaxLevel: gl.getUniformLocation(this.program.program, 'uFresnelMaxLevel'),
            tarmacSpecularMultiplier: gl.getUniformLocation(this.program.program, 'uTarmacSpecularMultiplier'),
            cutout: gl.getUniformLocation(this.program.program, 'uCutout'),
            alphaCutoff: gl.getUniformLocation(this.program.program, 'uAlphaCutoff'),
        };
        this.pickUniforms = {
            viewProjection: gl.getUniformLocation(this.pickProgram.program, 'uViewProjectionMatrix'),
            model: gl.getUniformLocation(this.pickProgram.program, 'uModelMatrix'),
            minimum: gl.getUniformLocation(this.pickProgram.program, 'uMinimum'),
            span: gl.getUniformLocation(this.pickProgram.program, 'uSpan'),
            positionIsAbsolute: gl.getUniformLocation(this.pickProgram.program, 'uPositionIsAbsolute'),
            color: gl.getUniformLocation(this.pickProgram.program, 'uPickColor'),
            diffuse: gl.getUniformLocation(this.pickProgram.program, 'uDiffuse'),
            hasDiffuse: gl.getUniformLocation(this.pickProgram.program, 'uHasDiffuse'),
            alphaCutoff: gl.getUniformLocation(this.pickProgram.program, 'uAlphaCutoff'),
        };
        this.positionLocation = gl.getAttribLocation(this.program.program, 'aPackedPosition');
        this.normalLocation = gl.getAttribLocation(this.program.program, 'aNormal');
        this.tangentLocation = gl.getAttribLocation(this.program.program, 'aTangent');
        this.uvLocation = gl.getAttribLocation(this.program.program, 'aUV');
        this._fallbackTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._fallbackTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        this.ready = true;
    }

    async load(metaUrl = 'assets/tracks/nordschleife/scene/scene.json') {
        const requestedUrl = String(metaUrl || 'assets/tracks/nordschleife/scene/scene.json');
        if (!this.ready || this.loading) return this.models.length > 0;
        if (this.models.length && this.sceneUrl === requestedUrl) return true;
        if (this.models.length) this._disposeSceneResources();
        this.loading = true;
        this.error = null;
        this.sceneUrl = requestedUrl;
        try {
            const response = await fetch(requestedUrl, { cache: 'no-store' });
            if (response.status === 404) return false;
            if (!response.ok) throw new Error(`Track scene metadata request failed (${response.status})`);
            const metadata = await response.json();
            if (metadata?.schema !== 'webglgta-track-scene-v1' || !Array.isArray(metadata.models)) throw new Error('Track scene metadata is invalid');
            // The broad, recognizable circuit mesh must be present before the
            // smaller layout extras.  A player can use /track while loading is
            // still underway, so preserving the Assetto INI order here could
            // put them on the collision ribbon with no visible circuit.
            const entries = metadata.models.slice().sort((left, right) => {
                const primary = 'ks_nordschleife.kn5';
                return Number(String(right?.source || '').toLowerCase() === primary)
                    - Number(String(left?.source || '').toLowerCase() === primary);
            });
            this.stats.totalSectors = entries.length;
            this._publishProgress();
            for (const entry of entries) {
                const file = String(entry?.file || '');
                const groups = Array.isArray(entry?.groups) ? entry.groups : [];
                if (!file || !groups.length) continue;
                const url = new URL(file, new URL(requestedUrl, window.location.href));
                const decoded = decode(await fetchGzipArrayBuffer(url));
                const model = this._upload(decoded, groups, url, entry?.bounds, {
                    source: String(entry?.source || file),
                    file,
                });
                this.models.push(model);
                this.stats.sectors++;
                this.stats.vertices += decoded.vertexCount;
                this.stats.triangles += decoded.indexCount / 3;
                this.stats.bytes += decoded.positions.byteLength + decoded.indices.byteLength;
                if (String(entry?.source || '').toLowerCase() === 'ks_nordschleife.kn5') this.stats.primaryLoaded = true;
                this._publishProgress();
                // Yield a real frame between source sectors. `setTimeout(0)`
                // still allowed a long chain of GPU uploads to monopolize the
                // main thread, making the follow camera appear to shake while
                // Full Detail was arriving.
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
            return this.models.length > 0;
        } catch (error) {
            this.error = String(error?.message || error || 'Track scene load failed');
            console.warn('Full Nordschleife scene unavailable:', error);
            this._disposeSceneResources();
            return false;
        } finally {
            this.loading = false;
        }
    }

    setQuality(quality = 'balanced') {
        const next = quality === 'full' ? 'full' : 'balanced';
        this.sceneQuality = next;
        const sceneUrl = next === 'full'
            // v3 is the verified full authored-precision package: all 18
            // renderable static sectors, all referenced textures, retained
            // source triangles, and v4 tangent data for the normal maps.
            ? 'assets/tracks/nordschleife/scene_full_v3/scene.json'
            : 'assets/tracks/nordschleife/scene/scene.json';
        return this.load(sceneUrl);
    }

    _publishProgress() {
        try { this.onProgress?.({ ...this.stats, loading: this.loading, error: this.error }); } catch { /* UI diagnostics are optional */ }
    }

    _upload(decoded, groups, baseUrl, authoredBounds = null, identity = null) {
        const gl = this.gl;
        const vao = gl.createVertexArray();
        const positionBuffer = gl.createBuffer();
        const indexBuffer = gl.createBuffer();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, decoded.positions, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this.positionLocation);
        gl.vertexAttribPointer(this.positionLocation, 3, decoded.absolutePositions ? gl.FLOAT : gl.UNSIGNED_SHORT, false, 0, 0);
        const normalBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
        if (decoded.normals) {
            gl.bufferData(gl.ARRAY_BUFFER, decoded.normals, gl.STATIC_DRAW);
            gl.enableVertexAttribArray(this.normalLocation);
            gl.vertexAttribPointer(this.normalLocation, 3, gl.BYTE, true, 0, 0);
        } else {
            gl.disableVertexAttribArray(this.normalLocation);
            gl.vertexAttrib3f(this.normalLocation, 0, 0, 1);
        }
        const tangentBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, tangentBuffer);
        if (decoded.tangents) {
            gl.bufferData(gl.ARRAY_BUFFER, decoded.tangents, gl.STATIC_DRAW);
            gl.enableVertexAttribArray(this.tangentLocation);
            gl.vertexAttribPointer(this.tangentLocation, 3, gl.BYTE, true, 0, 0);
        } else {
            gl.disableVertexAttribArray(this.tangentLocation);
            gl.vertexAttrib3f(this.tangentLocation, 0, 0, 0);
        }
        const uvBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
        if (decoded.uvs) {
            gl.bufferData(gl.ARRAY_BUFFER, decoded.uvs, gl.STATIC_DRAW);
            gl.enableVertexAttribArray(this.uvLocation);
            gl.vertexAttribPointer(this.uvLocation, 2, gl.FLOAT, false, 0, 0);
        } else {
            gl.disableVertexAttribArray(this.uvLocation);
            gl.vertexAttrib2f(this.uvLocation, 0, 0);
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, decoded.indices, gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        const measuredBounds = decodedBounds(decoded);
        const validAuthoredBounds = Array.isArray(authoredBounds?.min) && authoredBounds.min.length === 3
            && Array.isArray(authoredBounds?.max) && authoredBounds.max.length === 3;
        const renderableGroups = groups.filter((group) => !isNonVisualLocatorGroup(identity, group));
        const model = {
            vao, positionBuffer, normalBuffer, tangentBuffer, uvBuffer, indexBuffer, minimum: decoded.minimum, span: decoded.span,
            absolutePositions: !!decoded.absolutePositions,
            source: String(identity?.source || ''),
            file: String(identity?.file || ''),
            boundsMin: validAuthoredBounds
                ? authoredBounds.min.map((value, index) => finite(value, decoded.minimum[index]))
                : (measuredBounds?.min || decoded.minimum.slice()),
            boundsMax: validAuthoredBounds
                ? authoredBounds.max.map((value, index) => finite(value, decoded.minimum[index] + decoded.span[index]))
                : (measuredBounds?.max || decoded.minimum.map((value, index) => value + decoded.span[index])),
            viewBoundsMin: [0, 0, 0], viewBoundsMax: [0, 0, 0],
            groups: renderableGroups.map((group, groupIndex) => {
                const textureEntries = group && typeof group.textures === 'object' ? group.textures : (group?.texture ? { diffuse: group.texture } : {});
                const textures = {};
                for (const [channel, value] of Object.entries(textureEntries)) {
                    if (value) textures[channel] = new URL(String(value), baseUrl).toString();
                }
                const properties = group && typeof group.properties === 'object' ? group.properties : {};
                const propertyVectors = group && typeof group.propertyVectors === 'object' ? group.propertyVectors : {};
                const alphaMode = ['opaque', 'cutout', 'blend'].includes(group?.alphaMode) ? group.alphaMode : 'opaque';
                const pickId = this._nextPickId++;
                const record = {
                    pickId,
                    groupIndex,
                    offset: Math.max(0, Math.floor(finite(group?.offset))),
                    count: Math.max(0, Math.floor(finite(group?.count))),
                    material: String(group?.material || ''),
                    shader: String(group?.shader || ''),
                    color: Array.isArray(group?.color) ? group.color.slice(0, 3).map((value) => Math.max(0, Math.min(255, finite(value)))) : [104, 108, 96],
                    textures,
                    properties,
                    propertyVectors,
                    alphaMode,
                    sourceNodes: Array.isArray(group?.sourceNodes) ? group.sourceNodes.map(String) : [],
                    isMultilayer: /multilayer/i.test(String(group?.shader || '')),
                };
                this._pickRecords.set(pickId, { model: null, group: record });
                return record;
            }).filter((group) => group.count >= 3),
        };
        for (const group of model.groups) {
            const record = this._pickRecords.get(group.pickId);
            if (record) record.model = model;
        }
        return model;
    }

    _textureFor(url) {
        if (!url) return null;
        const cached = this.textureCache.get(url);
        if (cached) return cached.ready ? cached.texture : null;
        const record = { ready: false, texture: null };
        this.textureCache.set(url, record);
        const image = new Image();
        image.decoding = 'async';
        image.onload = () => {
            try {
                const gl = this.gl;
                const texture = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, texture);
                // KN5 UVs are converted to bottom-origin coordinates by the
                // source reader. HTML image rows remain top-origin, so this
                // upload flip is required to keep the converted UVs aligned
                // with the original Assetto texture orientation.
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
                gl.generateMipmap(gl.TEXTURE_2D);
                if (this._anisotropyExtension && this._maxAnisotropy > 1) {
                    gl.texParameterf(gl.TEXTURE_2D, this._anisotropyExtension.TEXTURE_MAX_ANISOTROPY_EXT, this._maxAnisotropy);
                }
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                record.texture = texture;
                record.ready = true;
            } catch { /* texture remains on the material-color fallback */ }
        };
        image.src = url;
        return null;
    }

    _ensurePickTarget() {
        if (this._pickFramebuffer) return true;
        const gl = this.gl;
        const framebuffer = gl.createFramebuffer();
        const color = gl.createTexture();
        const depth = gl.createRenderbuffer();
        if (!framebuffer || !color || !depth) return false;
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.bindTexture(gl.TEXTURE_2D, color);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
        gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, 1, 1);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
        const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (!complete) {
            try { gl.deleteFramebuffer(framebuffer); } catch { /* ignore */ }
            try { gl.deleteTexture(color); } catch { /* ignore */ }
            try { gl.deleteRenderbuffer(depth); } catch { /* ignore */ }
            return false;
        }
        this._pickFramebuffer = framebuffer;
        this._pickColorTexture = color;
        this._pickDepthBuffer = depth;
        return true;
    }

    _screenRay(x, y, width, height, viewProjectionMatrix) {
        const inverse = glMatrix.mat4.create();
        if (!glMatrix.mat4.invert(inverse, viewProjectionMatrix)) return null;
        const nx = (2 * x / width) - 1;
        const ny = 1 - (2 * y / height);
        const unproject = (z) => {
            const px = nx, py = ny, pz = z, pw = 1;
            const ox = inverse[0] * px + inverse[4] * py + inverse[8] * pz + inverse[12] * pw;
            const oy = inverse[1] * px + inverse[5] * py + inverse[9] * pz + inverse[13] * pw;
            const oz = inverse[2] * px + inverse[6] * py + inverse[10] * pz + inverse[14] * pw;
            const ow = inverse[3] * px + inverse[7] * py + inverse[11] * pz + inverse[15] * pw;
            return Math.abs(ow) > 1e-8 ? [ox / ow, oy / ow, oz / ow] : [ox, oy, oz];
        };
        const near = unproject(-1);
        const far = unproject(1);
        const dx = far[0] - near[0], dy = far[1] - near[1], dz = far[2] - near[2];
        const length = Math.hypot(dx, dy, dz) || 1;
        return { originViewer: near, dirViewer: [dx / length, dy / length, dz / length] };
    }

    pickAssetAtScreen({ x, y, viewportWidth, viewportHeight, viewProjectionMatrix, maxPixelDistance = 0 } = {}) {
        const width = Math.max(1, Number(viewportWidth) || 1);
        const height = Math.max(1, Number(viewportHeight) || 1);
        const px = Number(x), py = Number(y);
        const ray = viewProjectionMatrix ? this._screenRay(px, py, width, height, viewProjectionMatrix) : null;
        const emptyReport = () => ({
            schema: 'webglgta-demo-asset-pick-v1',
            timeIso: new Date().toISOString(),
            click: { x: px, y: py, viewportWidth: width, viewportHeight: height, maxPixelDistance, ray },
            selected: null,
            nearby: [],
            rendererStats: this.getRenderStats(),
            textureFrame: { schema: 'webglgta-texture-frame-report-v1', limit: 25, missingFromExportedSet: [], placeholderUrls: [] },
        });
        if (!this.ready || !this.models.length || !viewProjectionMatrix || !Number.isFinite(px) || !Number.isFinite(py) || !this._ensurePickTarget()) return emptyReport();

        const gl = this.gl;
        const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        const previousViewport = gl.getParameter(gl.VIEWPORT);
        const blendEnabled = gl.isEnabled(gl.BLEND);
        const cullEnabled = gl.isEnabled(gl.CULL_FACE);
        const ditherEnabled = gl.isEnabled(gl.DITHER);
        const depthEnabled = gl.isEnabled(gl.DEPTH_TEST);
        const depthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
        const previousActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
        gl.activeTexture(gl.TEXTURE0);
        const previousTexture0 = gl.getParameter(gl.TEXTURE_BINDING_2D);
        try {
            const nx = (2 * px / width) - 1;
            const ny = 1 - (2 * py / height);
            glMatrix.mat4.identity(this._pickMatrix);
            this._pickMatrix[0] = width;
            this._pickMatrix[5] = height;
            this._pickMatrix[12] = -width * nx;
            this._pickMatrix[13] = -height * ny;
            glMatrix.mat4.multiply(this._pickViewProjection, this._pickMatrix, viewProjectionMatrix);

            gl.bindFramebuffer(gl.FRAMEBUFFER, this._pickFramebuffer);
            gl.viewport(0, 0, 1, 1);
            gl.disable(gl.BLEND);
            gl.disable(gl.CULL_FACE);
            gl.disable(gl.DITHER);
            gl.enable(gl.DEPTH_TEST);
            gl.depthMask(true);
            gl.clearColor(0, 0, 0, 0);
            gl.clearDepth(1);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.useProgram(this.pickProgram.program);
            gl.uniformMatrix4fv(this.pickUniforms.viewProjection, false, this._pickViewProjection);
            gl.uniformMatrix4fv(this.pickUniforms.model, false, this.modelMatrix);
            gl.uniform1i(this.pickUniforms.diffuse, 0);
            for (const model of this.models) {
                gl.uniform3fv(this.pickUniforms.minimum, model.minimum);
                gl.uniform3fv(this.pickUniforms.span, model.span);
                gl.uniform1f(this.pickUniforms.positionIsAbsolute, model.absolutePositions ? 1 : 0);
                gl.bindVertexArray(model.vao);
                for (const group of model.groups) {
                    const id = group.pickId;
                    const diffuseUrl = group.textures?.diffuse;
                    const diffuseTexture = diffuseUrl ? this.textureCache.get(diffuseUrl)?.texture : null;
                    const authoredCutoff = Number(group.properties?.ksalpharef ?? group.properties?.alpharef);
                    const alphaCutoff = group.alphaMode === 'cutout'
                        ? Math.max(0.01, Math.min(0.99, Number.isFinite(authoredCutoff) ? authoredCutoff : 0.5))
                        : (group.alphaMode === 'blend' ? 0.01 : -1);
                    gl.activeTexture(gl.TEXTURE0);
                    gl.bindTexture(gl.TEXTURE_2D, diffuseTexture || null);
                    gl.uniform1f(this.pickUniforms.hasDiffuse, diffuseTexture ? 1 : 0);
                    gl.uniform1f(this.pickUniforms.alphaCutoff, alphaCutoff);
                    gl.uniform3f(this.pickUniforms.color, (id & 255) / 255, ((id >>> 8) & 255) / 255, ((id >>> 16) & 255) / 255);
                    gl.drawElements(gl.TRIANGLES, group.count, gl.UNSIGNED_INT, group.offset * Uint32Array.BYTES_PER_ELEMENT);
                }
            }
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._pickPixel);
        } finally {
            gl.bindVertexArray(null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
            gl.viewport(previousViewport[0], previousViewport[1], previousViewport[2], previousViewport[3]);
            if (blendEnabled) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
            if (cullEnabled) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
            if (ditherEnabled) gl.enable(gl.DITHER); else gl.disable(gl.DITHER);
            if (depthEnabled) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
            gl.depthMask(depthMask);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, previousTexture0);
            gl.activeTexture(previousActiveTexture);
        }

        const pickId = this._pickPixel[0] | (this._pickPixel[1] << 8) | (this._pickPixel[2] << 16);
        const record = this._pickRecords.get(pickId);
        if (!record?.model || !record?.group) return emptyReport();
        const { model, group } = record;
        const textures = {};
        for (const [slot, url] of Object.entries(group.textures || {})) {
            const cached = this.textureCache.get(url);
            textures[slot] = { rel: url, state: cached?.ready ? 'resident' : 'pending', missingFromIndex: false, missing404: false, rejected: false };
        }
        const selected = {
            pick: { method: 'trackGpuIdBuffer', distancePx: 0, score: 0, groupId: pickId },
            identity: {
                hash: `track:${model.source}:${group.groupIndex}`,
                lod: this.sceneQuality === 'full' ? 'high' : 'medium',
                file: model.file,
                source: model.source,
                material: group.material,
                groupIndex: group.groupIndex,
            },
            instance: {
                index: group.groupIndex,
                count: 1,
                dataPosition: null,
                centerData: model.boundsMin.map((value, index) => (value + model.boundsMax[index]) * 0.5),
                boundsData: { min: model.boundsMin.slice(), max: model.boundsMax.slice() },
            },
            mesh: { vertices: null, triangles: group.count / 3, indexOffset: group.offset, indexCount: group.count },
            material: {
                shaderName: group.shader,
                shaderFamily: group.isMultilayer ? 'multilayer' : 'track',
                renderBucket: group.alphaMode,
                raw: { properties: group.properties, propertyVectors: group.propertyVectors, textures: group.textures },
            },
            textures,
            culling: { visible: true, renderer: 'TrackSceneRenderer' },
        };
        return { ...emptyReport(), selected };
    }

    getRenderStats() {
        return { ...this._lastRenderStats };
    }

    render(viewProjectionMatrix, { fastStateRestore = false, frustumCulling = true } = {}) {
        if (!this.ready || !this.models.length) return;
        const renderStarted = performance.now();
        let drawCalls = 0;
        let triangles = 0;
        const visibleModels = new Set();
        const gl = this.gl;
        const cullWasEnabled = fastStateRestore ? false : gl.isEnabled(gl.CULL_FACE);
        gl.useProgram(this.program.program);
        gl.uniformMatrix4fv(this.uniforms.viewProjection, false, viewProjectionMatrix);
        gl.uniformMatrix4fv(this.uniforms.model, false, this.modelMatrix);
        gl.uniform1i(this.uniforms.diffuse, 0);
        gl.uniform1i(this.uniforms.normalMap, 1);
        gl.uniform1i(this.uniforms.detail, 2);
        gl.uniform1i(this.uniforms.detailNormal, 3);
        gl.uniform1i(this.uniforms.normalDetail, 10);
        gl.uniform1i(this.uniforms.variation, 11);
        gl.uniform1i(this.uniforms.maps, 4);
        gl.uniform1i(this.uniforms.mask, 5);
        gl.uniform1i(this.uniforms.detailR, 6);
        gl.uniform1i(this.uniforms.detailG, 7);
        gl.uniform1i(this.uniforms.detailB, 8);
        gl.uniform1i(this.uniforms.detailA, 9);
        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        const blendWasEnabled = fastStateRestore ? false : gl.isEnabled(gl.BLEND);
        const depthWriteWasEnabled = fastStateRestore ? true : gl.getParameter(gl.DEPTH_WRITEMASK);
        const planes = frustumCulling ? extractFrustumPlanes(viewProjectionMatrix, this._frustumPlanes) : null;
        const drawPass = (transparent) => {
            for (const model of this.models) {
                if (planes) {
                    transformAabb(this.modelMatrix, model.boundsMin, model.boundsMax, model.viewBoundsMin, model.viewBoundsMax);
                    if (!aabbIntersectsFrustum(planes, model.viewBoundsMin, model.viewBoundsMax)) continue;
                }
                gl.uniform3fv(this.uniforms.minimum, model.minimum);
                gl.uniform3fv(this.uniforms.span, model.span);
                gl.uniform1f(this.uniforms.positionIsAbsolute, model.absolutePositions ? 1 : 0);
                gl.bindVertexArray(model.vao);
                for (const group of model.groups) {
                    if ((group.alphaMode === 'blend') !== transparent) continue;
                    gl.uniform3f(this.uniforms.color, group.color[0] / 255, group.color[1] / 255, group.color[2] / 255);
                    const diffuse = this._textureFor(group.textures.diffuse);
                    const normal = this._textureFor(group.textures.normal);
                    const detail = this._textureFor(group.textures.detail);
                    const detailNormal = this._textureFor(group.textures.detailNormal);
                    const normalDetail = this._textureFor(group.textures.normalDetail);
                    const variation = this._textureFor(group.textures.variation);
                    const maps = this._textureFor(group.textures.maps);
                    const mask = this._textureFor(group.textures.mask);
                    const detailR = this._textureFor(group.textures.detailR);
                    const detailG = this._textureFor(group.textures.detailG);
                    const detailB = this._textureFor(group.textures.detailB);
                    const detailA = this._textureFor(group.textures.detailA);
                    for (const [unit, texture] of [[0, diffuse], [1, normal], [2, detail], [3, detailNormal], [4, maps], [5, mask], [6, detailR], [7, detailG], [8, detailB], [9, detailA], [10, normalDetail], [11, variation]]) {
                        gl.activeTexture(gl.TEXTURE0 + unit);
                        gl.bindTexture(gl.TEXTURE_2D, texture || this._fallbackTexture);
                    }
                    gl.uniform1f(this.uniforms.useDiffuse, diffuse ? 1 : 0);
                    gl.uniform1f(this.uniforms.useNormalMap, normal ? 1 : 0);
                    const authoredUseDetail = group.properties.usedetail;
                    const useDetail = detail && (authoredUseDetail === undefined || finite(authoredUseDetail) > 0.5);
                    gl.uniform1f(this.uniforms.useDetail, useDetail ? 1 : 0);
                    gl.uniform1f(this.uniforms.useDetailNormal, detailNormal ? 1 : 0);
                    gl.uniform1f(this.uniforms.useNormalDetail, normalDetail ? 1 : 0);
                    gl.uniform1f(this.uniforms.useVariation, variation ? 1 : 0);
                    gl.uniform1f(this.uniforms.useMaps, maps ? 1 : 0);
                    gl.uniform1f(this.uniforms.useMask, mask ? 1 : 0);
                    gl.uniform1f(this.uniforms.useLayerMaps, group.isMultilayer && detailR && detailG && detailB && detailA ? 1 : 0);
                    gl.uniform1f(this.uniforms.detailUVMultiplier, Math.max(0.05, finite(group.properties.detailuvmultiplier ?? group.properties.detailuvmult, 1)));
                    const detailNormalVector = materialVector(group, 'detailnmmult');
                    // detailNMMult is stored in the KN5 property's vector
                    // components (Y/Z), not its scalar header.  For example
                    // the official Nordschleife asphalt is [0, 6, 60, ...].
                    const detailNormalX = positiveScale(detailNormalVector[1] ?? materialProperty(group, 'detailnmmult', 1), 1);
                    const detailNormalY = positiveScale(detailNormalVector[2] ?? detailNormalX, detailNormalX);
                    gl.uniform2f(this.uniforms.detailNormalUVMultiplier, detailNormalX, detailNormalY);
                    const grassScale = materialVector(group, 'scale');
                    gl.uniform2f(this.uniforms.variationScale,
                        positiveScale(grassScale[1] ?? 1, 1),
                        positiveScale(grassScale[2] ?? grassScale[1] ?? 1, 1));
                    gl.uniform1f(this.uniforms.variationGain, materialProperty(group, 'gain', 1.0));
                    gl.uniform1f(this.uniforms.detailNormalBlend, materialProperty(group, 'detailnormalblend', 1.0));
                    gl.uniform4f(this.uniforms.layerUVMultiplier,
                        positiveScale(materialProperty(group, 'multr', 1), 1),
                        positiveScale(materialProperty(group, 'multg', 1), 1),
                        positiveScale(materialProperty(group, 'multb', 1), 1),
                        positiveScale(materialProperty(group, 'multa', 1), 1));
                    gl.uniform1f(this.uniforms.ambient, materialProperty(group, 'ksambient', 0.34));
                    gl.uniform1f(this.uniforms.diffuseStrength, materialProperty(group, 'ksdiffuse', 0.66));
                    gl.uniform1f(this.uniforms.specularStrength, materialProperty(group, 'ksspecular', 0.0));
                    gl.uniform1f(this.uniforms.specularExponent, materialProperty(group, 'ksspecularexp', 18));
                    gl.uniform1f(this.uniforms.emissive, materialProperty(group, 'ksemissive', 0.0));
                    gl.uniform1f(this.uniforms.magicMultiplier, materialProperty(group, 'magicmult', 1.0));
                    gl.uniform1f(this.uniforms.fresnelC, materialProperty(group, 'fresnelc', 0.0));
                    gl.uniform1f(this.uniforms.fresnelExponent, materialProperty(group, 'fresnelexp', 1.0));
                    gl.uniform1f(this.uniforms.fresnelMaxLevel, materialProperty(group, 'fresnelmaxlevel', 0.0));
                    gl.uniform1f(this.uniforms.tarmacSpecularMultiplier, materialProperty(group, 'tarmacspecularmultiplier', 1.0));
                    gl.uniform1f(this.uniforms.cutout, group.alphaMode === 'cutout' ? 1 : 0);
                    gl.uniform1f(this.uniforms.alphaCutoff, Math.max(0.01, Math.min(0.99, finite(group.properties.ksalpharef ?? group.properties.alpharef, 0.5))));
                    gl.drawElements(gl.TRIANGLES, group.count, gl.UNSIGNED_INT, group.offset * Uint32Array.BYTES_PER_ELEMENT);
                    drawCalls++;
                    triangles += group.count / 3;
                }
                visibleModels.add(model);
            }
        };
        gl.disable(gl.BLEND);
        gl.depthMask(true);
        drawPass(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        drawPass(true);
        gl.bindVertexArray(null);
        gl.depthMask(depthWriteWasEnabled);
        if (blendWasEnabled) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
        if (cullWasEnabled) gl.enable(gl.CULL_FACE);
        this._lastRenderStats = {
            drawCalls,
            triangles,
            instances: visibleModels.size,
            bucketDraws: drawCalls,
            submeshDraws: drawCalls,
            drawItems: drawCalls,
            coarseFrustumCulled: Math.max(0, this.models.length - visibleModels.size),
            projectedSizeCulled: 0,
            lodDistanceCulled: 0,
            latePassCulled: 0,
            budgetCulled: 0,
            diffuseWanted: drawCalls,
            diffusePlaceholder: 0,
            diffuseReal: drawCalls,
            diffuseMissingFromIndex: 0,
            drawItemsMissingUv: 0,
            totalRenderMs: performance.now() - renderStarted,
        };
    }

    _disposeSceneResources() {
        const gl = this.gl;
        for (const model of this.models) {
            try { gl.deleteVertexArray(model.vao); } catch { /* ignore */ }
            try { gl.deleteBuffer(model.positionBuffer); } catch { /* ignore */ }
            try { gl.deleteBuffer(model.normalBuffer); } catch { /* ignore */ }
            try { gl.deleteBuffer(model.tangentBuffer); } catch { /* ignore */ }
            try { gl.deleteBuffer(model.uvBuffer); } catch { /* ignore */ }
            try { gl.deleteBuffer(model.indexBuffer); } catch { /* ignore */ }
        }
        this.models = [];
        for (const entry of this.textureCache.values()) {
            try { if (entry.texture) gl.deleteTexture(entry.texture); } catch { /* ignore */ }
        }
        this.textureCache.clear();
        this._pickRecords.clear();
        this._nextPickId = 1;
        this._lastRenderStats = { drawCalls: 0, triangles: 0, instances: 0, drawItems: 0, totalRenderMs: 0 };
        this.stats = { sectors: 0, totalSectors: 0, vertices: 0, triangles: 0, bytes: 0, primaryLoaded: false };
        this._publishProgress();
    }

    dispose() {
        const gl = this.gl;
        this._disposeSceneResources();
        try { if (this._fallbackTexture) gl.deleteTexture(this._fallbackTexture); } catch { /* ignore */ }
        try { if (this._pickFramebuffer) gl.deleteFramebuffer(this._pickFramebuffer); } catch { /* ignore */ }
        try { if (this._pickColorTexture) gl.deleteTexture(this._pickColorTexture); } catch { /* ignore */ }
        try { if (this._pickDepthBuffer) gl.deleteRenderbuffer(this._pickDepthBuffer); } catch { /* ignore */ }
        try { if (this.pickProgram?.program) gl.deleteProgram(this.pickProgram.program); } catch { /* ignore */ }
        this._pickFramebuffer = null;
        this._pickColorTexture = null;
        this._pickDepthBuffer = null;
        this.sceneUrl = null;
    }
}
