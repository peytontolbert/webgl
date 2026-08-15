import { glMatrix } from './glmatrix.js';
import { ShaderProgram } from './shader_program.js';
import { TexturePathResolver } from './texture_path_resolver.js';
import { extractFrustumPlanes } from './frustum_culling.js';

const VEHICLE_WHEEL_PIVOTS = Object.freeze({
    27922: Object.freeze([-0.7025, 1.3375, -0.0775]),
    26418: Object.freeze([0.7025, 1.3375, -0.0775]),
    27902: Object.freeze([-0.7025, -1.3375, -0.0775]),
    26398: Object.freeze([0.7025, -1.3375, -0.0775]),
});

const vsSource = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aTexcoord;
layout(location=3) in vec4 aTangent;
layout(location=8) in vec4 aColor0;
layout(location=11) in vec4 aColor1;
layout(location=9) in vec2 aTexcoord1;
layout(location=10) in vec2 aTexcoord2;
layout(location=13) in vec4 aBlendWeights;
layout(location=14) in vec4 aBlendIndices;

// mat4 takes 4 attribute slots; we bind at locations 4..7
layout(location=4) in vec4 aI0;
layout(location=5) in vec4 aI1;
layout(location=6) in vec4 aI2;
layout(location=7) in vec4 aI3;

// Optional per-instance tint palette index (0..255). Present when instance stride is 17 floats.
layout(location=12) in float aTintIndex;

uniform mat4 uViewProjectionMatrix;
uniform mat4 uModelMatrix;
uniform bool uGpuFrustumCulling;
uniform vec4 uGpuFrustumPlanes[6];
uniform float uGpuCullRadius;
// Directional shadow mapping (light-space transform for current frame).
uniform mat4 uLightViewProj;
uniform vec4 uUv0ScaleOffset; // (scaleU, scaleV, offsetU, offsetV)
uniform vec4 uUv1ScaleOffset; // (scaleU, scaleV, offsetU, offsetV)
uniform vec4 uUv2ScaleOffset; // (scaleU, scaleV, offsetU, offsetV)
uniform vec3 uGlobalAnimUV0;  // dot(globalAnimUV0, vec3(uv,1))
uniform vec3 uGlobalAnimUV1;  // dot(globalAnimUV1, vec3(uv,1))
// Optional low-cost locomotion fallback for static ped component drawables.
// x=enabled, y=movement 0..1, z=phase radians, w=stride multiplier.
uniform vec4 uCharacterLocomotion;
uniform bool uFragmentTransformEnabled;
uniform vec3 uFragmentPivot;
uniform mat3 uFragmentRotation;
uniform bool uSkinningEnabled;
uniform sampler2D uBoneTexture; // 1 x (paletteBoneCount * 3), RGBA32F rows

out vec3 vWorldPos;
out vec3 vN;
out vec4 vT;
out vec2 vUv;
out vec2 vUv1;
out vec2 vUv2;
out vec4 vColor0;
out vec4 vColor1;
out vec4 vLightSpacePos;
flat out float vTintIndex;

vec3 safeNormalize(vec3 v) {
    float l = length(v);
    return (l > 1e-8) ? (v / l) : vec3(0.0, 1.0, 0.0);
}

bool instanceSphereOutsideFrustum(vec3 center, float radius) {
    for (int i = 0; i < 6; i++) {
        if (dot(uGpuFrustumPlanes[i].xyz, center) + uGpuFrustumPlanes[i].w < -radius) return true;
    }
    return false;
}

void emitCulledVertex() {
    vWorldPos = vec3(0.0);
    vN = vec3(0.0, 1.0, 0.0);
    vT = vec4(1.0, 0.0, 0.0, 1.0);
    vUv = aTexcoord;
    vUv1 = aTexcoord1;
    vUv2 = aTexcoord2;
    vColor0 = aColor0;
    vColor1 = aColor1;
    vTintIndex = aTintIndex;
    vLightSpacePos = vec4(0.0);
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}

vec3 rotateAboutX(vec3 v, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return vec3(v.x, c * v.y - s * v.z, s * v.y + c * v.z);
}

float gaitAngle(vec3 sourcePosition, bool arm) {
    float move = clamp(uCharacterLocomotion.y, 0.0, 1.0);
    float sidePhase = sourcePosition.x < 0.0 ? 0.0 : 3.14159265;
    float base = sin(uCharacterLocomotion.z + sidePhase);
    float stride = max(0.35, uCharacterLocomotion.w);
    return base * move * stride * (arm ? -0.34 : 0.30);
}

vec3 characterDeformPosition(vec3 sourcePosition) {
    if (uCharacterLocomotion.x < 0.5 || uCharacterLocomotion.y < 0.005) return sourcePosition;

    // Freemode components share GTA ped-local coordinates: Z is up, legs sit near
    // the centerline below the pelvis, and arms are outboard of the torso. This is
    // intentionally limited to the player renderer; world drawables stay static.
    bool isLeg = abs(sourcePosition.x) < 0.32 && sourcePosition.z < 0.10;
    if (isLeg) {
        vec3 pivot = vec3(0.0, 0.0, 0.08);
        return pivot + rotateAboutX(sourcePosition - pivot, gaitAngle(sourcePosition, false));
    }

    bool isArm = abs(sourcePosition.x) > 0.30 && sourcePosition.z > -0.30 && sourcePosition.z < 0.56;
    if (isArm) {
        float shoulderX = sourcePosition.x < 0.0 ? -0.33 : 0.33;
        vec3 pivot = vec3(shoulderX, 0.0, 0.50);
        return pivot + rotateAboutX(sourcePosition - pivot, gaitAngle(sourcePosition, true));
    }
    return sourcePosition;
}

vec3 characterDeformDirection(vec3 direction, vec3 sourcePosition) {
    if (uCharacterLocomotion.x < 0.5 || uCharacterLocomotion.y < 0.005) return direction;
    bool isLeg = abs(sourcePosition.x) < 0.32 && sourcePosition.z < 0.10;
    if (isLeg) return rotateAboutX(direction, gaitAngle(sourcePosition, false));
    bool isArm = abs(sourcePosition.x) > 0.30 && sourcePosition.z > -0.30 && sourcePosition.z < 0.56;
    if (isArm) return rotateAboutX(direction, gaitAngle(sourcePosition, true));
    return direction;
}

vec4 boneRow(int paletteIndex, int row) {
    ivec2 sz = textureSize(uBoneTexture, 0);
    int maxPaletteBones = max(0, sz.y / 3);
    if (maxPaletteBones <= 0) {
        if (row == 0) return vec4(1.0, 0.0, 0.0, 0.0);
        if (row == 1) return vec4(0.0, 1.0, 0.0, 0.0);
        return vec4(0.0, 0.0, 1.0, 0.0);
    }
    int pi = clamp(paletteIndex, 0, maxPaletteBones - 1);
    return texelFetch(uBoneTexture, ivec2(0, pi * 3 + clamp(row, 0, 2)), 0);
}

vec3 skinPositionByBone(int paletteIndex, vec3 p) {
    vec4 hp = vec4(p, 1.0);
    vec4 r0 = boneRow(paletteIndex, 0);
    vec4 r1 = boneRow(paletteIndex, 1);
    vec4 r2 = boneRow(paletteIndex, 2);
    return vec3(dot(r0, hp), dot(r1, hp), dot(r2, hp));
}

vec3 skinDirectionByBone(int paletteIndex, vec3 d) {
    vec4 r0 = boneRow(paletteIndex, 0);
    vec4 r1 = boneRow(paletteIndex, 1);
    vec4 r2 = boneRow(paletteIndex, 2);
    return vec3(dot(r0.xyz, d), dot(r1.xyz, d), dot(r2.xyz, d));
}

ivec4 blendPaletteIndices() {
    return ivec4(
        int(floor(aBlendIndices.x + 0.5)),
        int(floor(aBlendIndices.y + 0.5)),
        int(floor(aBlendIndices.z + 0.5)),
        int(floor(aBlendIndices.w + 0.5))
    );
}

vec4 normalizedBlendWeights() {
    vec4 w = max(aBlendWeights, vec4(0.0));
    float s = w.x + w.y + w.z + w.w;
    return (s > 1e-6) ? (w / s) : vec4(1.0, 0.0, 0.0, 0.0);
}

vec3 skinPosition(vec3 p) {
    ivec4 bi = blendPaletteIndices();
    vec4 w = normalizedBlendWeights();
    return skinPositionByBone(bi.x, p) * w.x
        + skinPositionByBone(bi.y, p) * w.y
        + skinPositionByBone(bi.z, p) * w.z
        + skinPositionByBone(bi.w, p) * w.w;
}

vec3 skinDirection(vec3 d) {
    ivec4 bi = blendPaletteIndices();
    vec4 w = normalizedBlendWeights();
    return skinDirectionByBone(bi.x, d) * w.x
        + skinDirectionByBone(bi.y, d) * w.y
        + skinDirectionByBone(bi.z, d) * w.z
        + skinDirectionByBone(bi.w, d) * w.w;
}

void main() {
    mat4 inst = mat4(aI0, aI1, aI2, aI3);
    if (uGpuFrustumCulling) {
        float instScale = max(length(aI0.xyz), max(length(aI1.xyz), length(aI2.xyz)));
        float radius = max(0.0, uGpuCullRadius) * max(1.0, instScale);
        if (instanceSphereOutsideFrustum(aI3.xyz, radius)) {
            emitCulledVertex();
            return;
        }
    }
    vec3 sourcePosition = uFragmentTransformEnabled
        ? uFragmentPivot + uFragmentRotation * (aPosition - uFragmentPivot)
        : aPosition;
    vec3 localPosition = uSkinningEnabled ? skinPosition(sourcePosition) : characterDeformPosition(sourcePosition);
    vec4 dataPos = inst * vec4(localPosition, 1.0);
    vec4 worldPos = uModelMatrix * dataPos;
    vWorldPos = worldPos.xyz;
    // Correct normal/tangent transform includes the instance transform too.
    //
    // IMPORTANT robustness:
    // Some entities can have degenerate scales (0 on an axis) or otherwise singular instance transforms.
    // inverse() on a singular matrix yields NaNs on many drivers, which can "poison" lighting and make
    // the whole frame appear grey/white. Guard by falling back to a non-inverted transform.
    mat3 m3 = mat3(uModelMatrix * inst);
    float detM3 = determinant(m3);
    mat3 nmat = (abs(detM3) > 1e-10) ? transpose(inverse(m3)) : mat3(uModelMatrix);
    vec3 sourceNormal = uFragmentTransformEnabled ? uFragmentRotation * aNormal : aNormal;
    vec3 sourceTangent = uFragmentTransformEnabled ? uFragmentRotation * aTangent.xyz : aTangent.xyz;
    vec3 localNormal = uSkinningEnabled ? skinDirection(sourceNormal) : characterDeformDirection(sourceNormal, sourcePosition);
    vec3 localTangent = uSkinningEnabled ? skinDirection(sourceTangent) : characterDeformDirection(sourceTangent, sourcePosition);
    vN = safeNormalize(nmat * localNormal);
    vec3 tw = safeNormalize(nmat * localTangent);
    vT = vec4(tw, aTangent.w);
    // Match CodeWalker BasicVS GlobalUVAnim() then apply per-material scale/offset (GTA-style).
    vec3 uvw = vec3(aTexcoord, 1.0);
    vec2 uvA = vec2(dot(uGlobalAnimUV0, uvw), dot(uGlobalAnimUV1, uvw));
    vUv = uvA * uUv0ScaleOffset.xy + uUv0ScaleOffset.zw;
    vUv1 = aTexcoord1 * uUv1ScaleOffset.xy + uUv1ScaleOffset.zw;
    vUv2 = aTexcoord2 * uUv2ScaleOffset.xy + uUv2ScaleOffset.zw;
    // IMPORTANT (CodeWalker parity):
    // CodeWalker shaders consistently use input.Colour0.b / input.Colour1.b as tint selectors
    // and terrain blending uses Colour1.g/b. Preserve raw channel meaning.
    vColor0 = aColor0;
    vColor1 = aColor1;
    vTintIndex = aTintIndex;
    vLightSpacePos = uLightViewProj * worldPos;
    gl_Position = uViewProjectionMatrix * worldPos;
}
`;

const fsSource = `#version 300 es
precision mediump float;
// NOTE: Do not add precision qualifiers for sampler types (eg sampler2DShadow) here.
// Several WebGL2/ANGLE stacks reject sampler precision qualifiers and will fail shader compilation,
// causing InstancedModelRenderer to never become ready (drawables disappear / screen looks "greyed out").
in vec3 vWorldPos;
in vec3 vN;
in vec4 vT;
in vec2 vUv;
in vec2 vUv1;
in vec2 vUv2;
in vec4 vColor0;
in vec4 vColor1;
in vec4 vLightSpacePos;
flat in float vTintIndex;
out vec4 fragColor;

uniform vec3 uColor;
uniform int uVertexColorMode; // 0=off, 1=Colour0.rgb, 2=Colour1.rgb
uniform bool uDoubleSidedLighting;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform float uAmbient;
// Shadow map (directional). Use sampler2D + manual compare (more portable than sampler2DShadow on WebGL stacks).
uniform bool uShadowEnabled;
uniform sampler2D uShadowMap;
// x=bias, y=normalBiasScale, z=darkness (0..1), w=pcfRadius (0..2-ish)
uniform vec4 uShadowParams;
uniform vec2 uShadowTexel; // 1/size
uniform bool uHasDiffuse;
uniform sampler2D uDiffuse;
// UV selectors: 0=UV0(vUv), 1=UV1(vUv1), 2=UV2(vUv2)
uniform int uDiffuseUvSet;
uniform bool uHasDiffuse2;
uniform sampler2D uDiffuse2;
uniform bool uDiffuse2UseUv1;

uniform bool uHasNormal;
uniform sampler2D uNormal;
uniform float uNormalScale;
// UV selectors: 0=UV0(vUv), 1=UV1(vUv1), 2=UV2(vUv2)
uniform int uNormalUvSet;
uniform bool uHasDetail;
uniform sampler2D uDetail;
uniform vec4 uDetailSettings; // x,y,z,w (BasicPS uses y as intensity, zw as UV scale)
uniform int uDetailUvSet;

// Mesh attribute presence flags (parity + correctness guards).
// CodeWalker TerrainPS uses Texcoord1 for Colourmask; if UV1 isn't present, do not sample the mask.
uniform bool uMeshHasUv1;

uniform bool uHasSpec;
uniform sampler2D uSpec;
uniform float uSpecularIntensity;
uniform float uSpecularPower;
uniform float uSpecularFalloffMult;
uniform vec3 uSpecMaskWeights; // dot(spec.rgb, weights)
uniform float uSpecularFresnel; // CodeWalker BasicPS: specularFresnel (best-effort)
uniform int uSpecUvSet;

uniform bool uHasEmissive;
uniform sampler2D uEmissive;
uniform float uEmissiveIntensity;
uniform int uEmissiveUvSet;

uniform bool uHasAO;
uniform sampler2D uAO;
uniform float uAOStrength;
uniform int uAOUvSet;

// GTA tint palettes are 256 pixels wide. Colour0.b/Colour1.b select X and
// the entity tint index selects the palette row.
uniform bool uEnableTintPalette;
uniform sampler2D uTintPalette;
// Tint modes (CodeWalker-ish):
// 0 = none
// 1 = legacy viewer instance index sampled across X (kept for old custom assets)
// 2 = weapon palette: derive palette X from diffuse alpha (round(a*255)-32) * (1/128)
// 3 = vertex colour 0: use vColor0.b directly as palette X (0..1)
// 4 = vertex colour 1: use vColor1.b directly as palette X (0..1)
uniform int uTintMode;
// Freemode hair texture 0 stores dye masks, not display-ready RGB.
uniform bool uPedHairTint;
uniform vec3 uPedHairPrimary;
uniform vec3 uPedHairHighlight;

// Color pipeline:
// - When textures are uploaded as sRGB (preferred), sampling returns linear and uDecodeSrgb should be false.
// - When sRGB textures aren't supported, we upload as RGBA and must decode manually in shader.
uniform bool uDecodeDiffuseSrgb;
uniform bool uDecodeDiffuse2Srgb;
uniform bool uDecodeEmissiveSrgb;
uniform bool uDecodeTintPaletteSrgb;
// Some texture upload paths flip on upload (PNG/KTX2 via UNPACK_FLIP_Y_WEBGL), but DDS-compressed uploads
// don't reliably honor UNPACK_FLIP_Y_WEBGL. For DDS, we flip UV.y in shader to match PNG/KTX2 parity.
uniform bool uFlipDiffuseY;
uniform bool uFlipDiffuse2Y;
uniform bool uFlipNormalY;
uniform bool uFlipDetailY;
uniform bool uFlipSpecY;
uniform bool uFlipEmissiveY;
uniform bool uFlipAOY;
uniform bool uFlipAlphaMaskY;
uniform bool uFlipHeightY;
// Output:
// - When true (legacy), encode to sRGB in this shader for direct-to-canvas rendering.
// - When false, output linear so a final post-process pass can tonemap+encode once.
uniform bool uOutputSrgb;

// Normal map decode:
// uNormalEncoding: 0=RG (default), 1=AG (common for packed normals)
// uNormalReconstructZ: if true, reconstruct Z from XY (BC5-style) instead of using sampled B.
uniform int uNormalEncoding;
uniform bool uNormalReconstructZ;

// Shader family selector:
// 0 = basic (BasicPS-like)
// 1 = decal (alpha mask / projected-style)
// 2 = glass (blended + reflective approx)
// 3 = env (opaque reflective approx)
// 4 = parallax (basic + parallax mapping if height map present)
// 5 = wetness (basic + wetness response)
// 6 = terrain (CodeWalker TerrainShader-style multi-layer blend; best-effort)
// 7 = water (CodeWalker WaterShader-style; best-effort)
uniform int uShaderFamily;
// Terrain-family specialization:
// 0 = default (vc1 = mix(mask, Colour1, Colour0.a) like most TerrainPS variants)
// 1 = colourmask-only (vc1 = mask) for *_cm* variants (see CodeWalker TerrainPS.hlsl cases)
// 2 = vertex-colour only (vc1 = Colour1) for *_4lyr_lod variant where CW ignores colourmask
uniform int uTerrainMaskMode;

// Decal support (minimal):
uniform bool uHasAlphaMask;
uniform sampler2D uAlphaMask;
// CodeWalker decal modes (best-effort):
// 1 = regular decal
// 2 = decal_dirt (TextureAlphaMask * c, then alpha = sum(mask), rgb=0)
uniform int uDecalMode;
uniform bool uHasDecalAlphaMaskVec;
uniform vec4 uDecalAlphaMaskVec;

// Glass/reflect support (approx; no probes/cubemaps yet):
uniform float uReflectionIntensity;
uniform float uFresnelPower;
uniform vec3 uEnvColor;
uniform bool uHasEnvMap;
uniform sampler2D uEnvMap;
uniform bool uDecodeEnvSrgb;
uniform bool uFlipEnvY;

// Dirt/damage/puddles (best-effort)
uniform bool uHasDirt;
uniform sampler2D uDirt;
uniform float uDirtLevel;
uniform vec3 uDirtColor;
uniform bool uFlipDirtY;

uniform bool uHasDamage;
uniform sampler2D uDamage;
uniform bool uHasDamageMask;
uniform sampler2D uDamageMask;
uniform bool uFlipDamageY;
uniform bool uFlipDamageMaskY;

uniform bool uHasPuddleMask;
uniform sampler2D uPuddleMask;
uniform bool uFlipPuddleMaskY;
uniform vec4 uPuddleParams;
uniform vec4 uPuddleScaleRange;

// Decal tint
uniform vec3 uDecalTint;

// Parallax support (best-effort):
uniform bool uHasHeight;
uniform sampler2D uHeight;
uniform vec2 uParallaxScaleBias; // x=scale, y=bias

// Wetness support (best-effort):
uniform float uWetness;   // 0..1
uniform float uWetDarken; // 0..1-ish
uniform float uWetSpecBoost; // 1..?

// Alpha control:
// uAlphaMode: 0=opaque, 1=cutout, 2=blend
uniform int uAlphaMode;
uniform float uAlphaCutoff;
uniform float uAlphaScale;
uniform float uHardAlphaBlend; // if >0.5 and alphaMode==blend, discard low alpha and keep depth writes

// Distance-map special case (CodeWalker distanceMapSampler / IsDistMap)
uniform bool uIsDistMap;

// Water (best-effort, forward-only approximation)
uniform float uTime;
uniform int uWaterMode;          // 0=default, 1=river foam, 2=terrain foam (CodeWalker WaterPS ShaderMode)
uniform float uRippleSpeed;      // RippleSpeed
uniform float uRippleScale;      // RippleScale
uniform float uRippleBumpiness;  // RippleBumpiness
// CodeWalker water inputs (scene/material semantics)
uniform bool uWaterEnableTexture;  // EnableTexture
uniform bool uWaterEnableBumpMap;  // EnableBumpMap
uniform bool uWaterEnableFoamMap;  // EnableFoamMap
uniform bool uWaterEnableFlow;     // EnableFlow
uniform bool uWaterEnableFogtex;   // EnableFogtex
uniform vec4 uWaterFlowParams;     // gFlowParams
uniform vec4 uWaterFogParams;      // WaterFogParams (xy base, zw inverse size)

uniform vec3 uCameraPos;
uniform bool uFogEnabled;
uniform vec3 uFogColor;
uniform float uFogStart;
uniform float uFogEnd;
uniform bool uWireframe;
uniform vec3 uWireframeColor;

vec3 decodeSrgb(vec3 c) {
    // Exact-ish sRGB -> linear (matches GPU sRGB decode much better than pow(2.2)).
    // Ref: IEC 61966-2-1:1999
    vec3 x = clamp(c, 0.0, 1.0);
    vec3 low = x / 12.92;
    vec3 high = pow((x + 0.055) / 1.055, vec3(2.4));
    bvec3 cut = lessThanEqual(x, vec3(0.04045));
    return vec3(cut.x ? low.x : high.x,
                cut.y ? low.y : high.y,
                cut.z ? low.z : high.z);
}
vec3 encodeSrgb(vec3 c) {
    // Linear -> sRGB for display.
    vec3 x = max(c, vec3(0.0));
    vec3 low = x * 12.92;
    vec3 high = 1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055;
    bvec3 cut = lessThanEqual(x, vec3(0.0031308));
    return vec3(cut.x ? low.x : high.x,
                cut.y ? low.y : high.y,
                cut.z ? low.z : high.z);
}

vec2 selectUv(int uvSet) {
    if (uvSet == 2) return vUv2;
    if (uvSet == 1) return vUv1;
    return vUv;
}

vec2 selectUv3(int uvSet, vec2 uv0, vec2 uv1, vec2 uv2) {
    if (uvSet == 2) return uv2;
    if (uvSet == 1) return uv1;
    return uv0;
}

vec2 maybeFlipY(vec2 uv, bool flipY) {
    return flipY ? vec2(uv.x, 1.0 - uv.y) : uv;
}

float tintPaletteEntityRow() {
    // CodeWalker: (TintPaletteIndex + 0.5) / palette.Height. The index is
    // per entity, so it must remain a varying rather than a draw-call uniform.
    int paletteHeight = max(textureSize(uTintPalette, 0).y, 1);
    float row = clamp(floor(max(vTintIndex, 0.0) + 0.5), 0.0, float(paletteHeight - 1));
    return (row + 0.5) / float(paletteHeight);
}

float tintPaletteWeaponRow() {
    // weapon_*_palette shaders always sample the center of row zero.
    int paletteHeight = max(textureSize(uTintPalette, 0).y, 1);
    return 0.5 / float(paletteHeight);
}

vec2 parallaxUv(vec2 uv, vec3 Vt) {
    // Best-effort parallax offset mapping.
    // uParallaxScaleBias.x controls strength; y is bias.
    float s = uParallaxScaleBias.x;
    float b = uParallaxScaleBias.y;
    // If we don't have an explicit height map, some GTA parallax shaders pack height into normal alpha.
    // Best-effort: for parallax family only, use uNormal.a as height when available.
    bool usePackedHeight = (!uHasHeight) && (uShaderFamily == 4) && uHasNormal;
    if (!uHasHeight && !usePackedHeight) return uv;
    if (abs(s) < 1e-6 && abs(b) < 1e-6) return uv;
    // Height in 0..1
    float h = usePackedHeight
        ? texture(uNormal, maybeFlipY(uv, uFlipNormalY)).a
        : texture(uHeight, maybeFlipY(uv, uFlipHeightY)).r;
    float height = h * s + b;
    // Avoid division by 0 / extreme offsets at grazing angles.
    float vz = max(0.15, abs(Vt.z));
    vec2 off = (Vt.xy / vz) * height;
    return uv + off;
}

vec2 envLatLongUv(vec3 dir) {
    float dl = length(dir);
    vec3 d = (dl > 1e-8) ? (dir / dl) : vec3(0.0, 1.0, 0.0);
    float u = atan(d.z, d.x) / (2.0 * 3.14159265) + 0.5;
    float v = asin(clamp(d.y, -1.0, 1.0)) / 3.14159265 + 0.5;
    return vec2(u, v);
}

vec3 safeNormalize(vec3 v) {
    float l = length(v);
    return (l > 1e-8) ? (v / l) : vec3(0.0, 1.0, 0.0);
}

float diffuseAmount(vec3 N, vec3 L) {
    float ndl = dot(N, L);
    return uDoubleSidedLighting ? abs(ndl) : max(ndl, 0.0);
}

float shadowAmount(vec3 N, vec3 L) {
    if (!uShadowEnabled) return 0.0;
    // Project from clip -> NDC -> UV
    vec3 p = vLightSpacePos.xyz / max(1e-6, vLightSpacePos.w);
    vec2 uv = p.xy * 0.5 + 0.5;
    float z = p.z * 0.5 + 0.5;
    // Outside the shadow frustum -> unshadowed
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || z < 0.0 || z > 1.0) return 0.0;

    float ndl = clamp(dot(safeNormalize(N), safeNormalize(L)), 0.0, 1.0);
    float bias = max(0.0, uShadowParams.x) + max(0.0, uShadowParams.y) * (1.0 - ndl);
    float r = max(0.0, uShadowParams.w);
    vec2 stepUv = uShadowTexel * max(1.0, r);

    // 3x3 PCF (cheap, stable). Manual compare against depth texture.
    float sumLit = 0.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 o = vec2(float(x), float(y)) * stepUv;
            float d = texture(uShadowMap, uv + o).r; // depth in [0..1]
            sumLit += ((z - bias) <= d) ? 1.0 : 0.0;
        }
    }
    float lit = sumLit * (1.0 / 9.0);
    return clamp(1.0 - lit, 0.0, 1.0); // 0=lit, 1=full shadow
}

void main() {
    vec3 N = safeNormalize(vN);
    vec3 T = safeNormalize(vT.xyz);
    // CodeWalker BasicVS computes Bitangent as cross(tangent, normal) * tangent.w (see BasicVS_PNCCTTTX.hlsl).
    // Match that handedness here so normal map Y axis matches CodeWalker.
    vec3 B = safeNormalize(cross(T, N) * vT.w);
    if (uDoubleSidedLighting && !gl_FrontFacing) {
        N = -N;
        T = -T;
        B = -B;
    }

    // --- Terrain path (CodeWalker TerrainPS-style blend, for terrain_cb_* drawables) ---
    // We keep this within WebGL2 minimum texture unit counts by repurposing existing samplers.
    //
    // Diffuse layers (Colourmap1..4 in CodeWalker):
    //  - c1: uDiffuse
    //  - c2: uDiffuse2
    //  - c3: uEmissive  (as a colour layer; emissiveIntensity is ignored here)
    //  - c4: uEnvMap    (as a 2D colour layer)
    //
    // Colourmask (CodeWalker Colourmask):
    //  - m: uAlphaMask sampled on vUv1
    //
    // Normal layers (Normalmap1..4 in CodeWalker), repurposed:
    //  - b1: uNormal
    //  - b2: uDetail
    //  - b3: uDirt
    //  - b4: uDamage
    //
    // This matches CodeWalker’s *blending* and *NormalMap()* reconstruction closely.
    if (uShaderFamily == 6) {
        vec2 tc0 = vUv;
        vec2 tc1 = vUv1;

        vec4 bc0 = vec4(0.5, 0.5, 0.5, 1.0);

        // Colourmap1..4 (tc0)
        vec4 c1 = uHasDiffuse ? texture(uDiffuse, maybeFlipY(tc0, uFlipDiffuseY)) : bc0;
        vec4 c2 = uHasDiffuse2 ? texture(uDiffuse2, maybeFlipY(tc0, uFlipDiffuse2Y)) : c1;
        vec4 c3 = uHasEmissive ? texture(uEmissive, maybeFlipY(tc0, uFlipEmissiveY)) : c1;
        vec4 c4 = uHasEnvMap ? texture(uEnvMap, maybeFlipY(tc0, uFlipEnvY)) : c1;

        // Decode colour layers (best-effort): reuse available decode flags.
        vec3 col1 = uDecodeDiffuseSrgb ? decodeSrgb(c1.rgb) : c1.rgb;
        vec3 col2 = uDecodeDiffuse2Srgb ? decodeSrgb(c2.rgb) : c2.rgb;
        vec3 col3 = uDecodeEmissiveSrgb ? decodeSrgb(c3.rgb) : c3.rgb;
        vec3 col4 = uDecodeEnvSrgb ? decodeSrgb(c4.rgb) : c4.rgb;

        vec4 mask = (uHasAlphaMask && uMeshHasUv1) ? texture(uAlphaMask, maybeFlipY(tc1, uFlipAlphaMaskY)) : vColor1;
        // CodeWalker TerrainPS.hlsl has shader variants:
        // - default: vc1 = m*(1-vc0.a) + vc1*vc0.a
        // - *_cm* :  vc1 = m
        vec4 vc1 = (uTerrainMaskMode == 1)
            ? mask
            : ((uTerrainMaskMode == 2)
                ? vColor1
                : mix(mask, vColor1, clamp(vColor0.a, 0.0, 1.0)));

        // CodeWalker TerrainPS: blend using vc1.b and vc1.g across layers 1..4.
        vec3 t1 = mix(col1, col2, clamp(vc1.b, 0.0, 1.0));
        vec3 t2 = mix(col3, col4, clamp(vc1.b, 0.0, 1.0));
        vec3 base = mix(t1, t2, clamp(vc1.g, 0.0, 1.0));

        // IMPORTANT: CodeWalker TerrainPS does NOT multiply albedo by Colour0.rgb by default.
        // (EnableVertexColour path is disabled in TerrainPS.hlsl.)

        // Terrain tint palette (best-effort): multiply by the same tint pipeline as basic.
        if (uEnableTintPalette) {
            float tintY = tintPaletteEntityRow();
            // Tint palette is a colour lookup texture; decode if it wasn't uploaded as sRGB.
            // (Some compressed upload paths can't use sRGB internal formats.)
            #define TINT_SAMPLE(uv) (uDecodeTintPaletteSrgb ? decodeSrgb(texture(uTintPalette, (uv)).rgb) : texture(uTintPalette, (uv)).rgb)
            if (uTintMode == 1) {
                float idx = clamp(vTintIndex, 0.0, 255.0);
                vec2 tuv = vec2((idx + 0.5) / 256.0, tintY);
                base *= TINT_SAMPLE(tuv);
            } else if (uTintMode == 3) {
                base *= TINT_SAMPLE(vec2(clamp(vColor0.b, 0.0, 1.0), tintY));
            } else if (uTintMode == 4) {
                base *= TINT_SAMPLE(vec2(clamp(vColor1.b, 0.0, 1.0), tintY));
            }
            #undef TINT_SAMPLE
        }

        // Per-layer normal blending + CodeWalker NormalMap() reconstruction.
        // We only use XY from the blended normal texture, matching CodeWalker TerrainPS.
        if (uHasNormal || uHasDetail || uHasDirt || uHasDamage) {
            vec4 b1 = (uHasNormal) ? texture(uNormal, maybeFlipY(tc0, uFlipNormalY)) : vec4(0.5, 0.5, 0.5, 1.0);
            vec4 b2 = (uHasDetail) ? texture(uDetail, maybeFlipY(tc0, uFlipDetailY)) : b1;
            vec4 b3 = (uHasDirt) ? texture(uDirt, maybeFlipY(tc0, uFlipDirtY)) : b1;
            vec4 b4 = (uHasDamage) ? texture(uDamage, maybeFlipY(tc0, uFlipDamageY)) : b1;

            vec4 n1 = mix(b1, b2, clamp(vc1.b, 0.0, 1.0));
            vec4 n2 = mix(b3, b4, clamp(vc1.b, 0.0, 1.0));
            vec4 nv = mix(n1, n2, clamp(vc1.g, 0.0, 1.0));

            // CodeWalker NormalMap(): nmv.xy in [0..1] → [-1..1], z = sqrt(1 - dot(nxy,nxy)),
            // then scale xy by bumpiness (clamped to >= 0.001) before combining with (N,T,B).
            vec2 nmv = (uNormalEncoding == 1) ? nv.ag : nv.rg;
            vec2 nxy = nmv * 2.0 - 1.0;
            float z = sqrt(abs(1.0 - dot(nxy, nxy)));
            vec2 bxy = nxy * max(uNormalScale, 0.001); // reuse uNormalScale as bumpiness in terrain family
            vec3 t3 = (T * bxy.x) + (B * bxy.y) + (N * z);
            N = normalize(t3);
        }

        vec3 L = normalize(uLightDir);
        float diff = diffuseAmount(N, L);
        float sh = shadowAmount(N, L);
        float k = 1.0 - (clamp(uShadowParams.z, 0.0, 1.0) * sh);
        // Lighting model:
        // - Keep the old LDR behavior when uLightColor==1: (ambient + NdotL*(1-ambient))
        // - But do NOT multiply ambient by uLightColor (that blows out HDR frames).
        vec3 lit = vec3(uAmbient) + (uLightColor * (diff * (1.0 - uAmbient) * k));
        vec3 c = base * lit;

        if (uFogEnabled) {
            float dist = length(vWorldPos - uCameraPos);
            float fogF = smoothstep(uFogStart, uFogEnd, dist);
            c = mix(c, uFogColor, fogF);
        }

        fragColor = vec4(uOutputSrgb ? encodeSrgb(c) : c, 1.0);
        return;
    }

    // --- Water path (best-effort CodeWalker WaterPS) ---
    // To avoid adding new sampler uniforms, this reuses:
    //  - uDirt as "foam" (uHasDirt/uFlipDirtY)
    //  - uDamage as "flow" (uHasDamage/uFlipDamageY)
    if (uShaderFamily == 7) {
        // CodeWalker WaterPS.hlsl parity (RenderMode=0 path).
        // CodeWalker WaterVS.hlsli animates Texcoord0 for ShaderMode==1 (river foam):
        //   tc = tc + float2(ScaledTime * RippleSpeed, 0)
        // Flow sampling uses the *base* input texcoord (unanimated) in VS (GetWaterFlow).
        vec2 tc0Base = vUv;
        vec2 tc0 = tc0Base;
        if (uWaterMode == 1) {
            tc0 = tc0 + vec2(uTime * uRippleSpeed, 0.0);
        }

        // CodeWalker is Z-up; our viewer is Y-up. Use XZ as the water plane for fog/flow mapping.
        vec2 world2 = vec2(vWorldPos.x, vWorldPos.z);

        // Default base colour/alpha (CodeWalker).
        vec4 c = vec4(0.1, 0.18, 0.25, 0.8);

        // Fog texture pre-pass: only when foam map isn't enabled.
        if ((!uWaterEnableFoamMap) && uWaterEnableFogtex && uHasEnvMap) {
            vec2 fogtc = clamp((world2 - uWaterFogParams.xy) * uWaterFogParams.zw, 0.0, 1.0);
            fogtc.y = 1.0 - fogtc.y;
            vec4 wf = texture(uEnvMap, maybeFlipY(fogtc, uFlipEnvY));
            c.rgb = uDecodeEnvSrgb ? decodeSrgb(wf.rgb) : wf.rgb;
            c.a = 0.9;
        }

        // Ripple normal (CodeWalker RippleNormal()).
        // Requires both WaterBumpSampler (mapped to uDetail) and WaterBumpSampler2 (mapped to uSpec).
        vec3 rippleNorm = N;
        if ((!uWaterEnableFoamMap) && uHasDetail && uHasSpec) {
            // input.Flow.zw:
            // - default (when flow disabled): (0.02, 0.03)
            // - when enabled: sample FlowSampler.xy in [0..1] -> [-1..1] (we reuse uDamage)
            vec2 flowZW = vec2(0.02, 0.03);
            if (uWaterEnableFlow && uHasDamage) {
                // Match CodeWalker WaterVS: sample flow using the *base* (unanimated) UVs.
                vec2 fv = texture(uDamage, maybeFlipY(tc0Base, uFlipDamageY)).xy;
                flowZW = fv * 2.0 - 1.0;
            }

            vec2 r0xy = flowZW * uRippleSpeed;
            float k = min(length(r0xy), 1.0);

            // r1.xy uses uWaterFlowParams.x; r1.zw uses uWaterFlowParams.y
            vec2 r1xy = world2 - vec2(r0xy.x * uWaterFlowParams.x, r0xy.y * uWaterFlowParams.x);
            vec2 r1zw = world2 - vec2(r0xy.x * uWaterFlowParams.y, r0xy.y * uWaterFlowParams.y);

            vec2 uvA = (r1xy * uRippleScale) * 2.3;
            vec2 uvB = ((r1zw * uRippleScale) + vec2(0.5)) * 2.3;

            vec4 r2 = texture(uSpec, maybeFlipY(uvA, uFlipSpecY));    // WaterBumpSampler2
            vec4 r3 = texture(uDetail, maybeFlipY(uvA, uFlipDetailY)); // WaterBumpSampler
            vec4 r4 = texture(uSpec, maybeFlipY(uvB, uFlipSpecY));
            vec4 r1 = texture(uDetail, maybeFlipY(uvB, uFlipDetailY));

            r3.zw = r1.xy;
            r2.zw = r4.xy;
            r1 = r2 + r3;
            r2 = r3 + vec4(0.5);
            r1 = r1 - r2;

            vec4 r0v = mix(r2, r2 + r1, k);
            r0v = r0v * 2.0 - 2.0;
            // gFlowParams.zzww
            r0v *= vec4(uWaterFlowParams.z, uWaterFlowParams.w, uWaterFlowParams.z, uWaterFlowParams.w);

            vec2 rxy = r0v.xy + r0v.zw;
            vec2 off = rxy * uRippleBumpiness;

            float v2w = clamp(vColor0.r, 0.0, 1.0); // vertex red channel
            vec3 nn = N;
            // CodeWalker adds to norm.xy; in Y-up, add to XZ.
            nn.xz = nn.xz + (off * v2w);
            rippleNorm = normalize(nn);
        }

        // Base normal choice: CodeWalker uses vertex normal when foam map is enabled, ripple otherwise.
        vec3 norm = uWaterEnableFoamMap ? normalize(vN) : rippleNorm;

        // Base colour selection:
        // - If texture enabled: c.rgb = Colourmap.rgb (keep alpha)
        // - Else if foam enabled: c = Foammap (rgba)
        if (uWaterEnableTexture && uHasDiffuse) {
            vec4 d = texture(uDiffuse, maybeFlipY(tc0, uFlipDiffuseY));
            c.rgb = uDecodeDiffuseSrgb ? decodeSrgb(d.rgb) : d.rgb;
        } else if (uWaterEnableFoamMap && uHasDirt) {
            c = texture(uDirt, maybeFlipY(tc0, uFlipDirtY));
        }

        // RenderMode==0: bump map normal (Bumpmap.xy, bumpiness=0.5).
        if (uWaterEnableBumpMap && uHasNormal) {
            vec4 nv = texture(uNormal, maybeFlipY(tc0, uFlipNormalY));
            vec2 nmv = (uNormalEncoding == 1) ? nv.ag : nv.rg;
            vec2 nxy = nmv * 2.0 - 1.0;
            float z = sqrt(abs(1.0 - dot(nxy, nxy)));
            vec2 bxy = nxy * max(0.5, 0.001);
            vec3 nts = vec3(bxy, z);
            norm = normalize(T * nts.x + B * nts.y + normalize(vN) * nts.z);
        }

        // Spec (CodeWalker shape).
        vec3 L = normalize(uLightDir);
        vec3 incident = normalize(vWorldPos - uCameraPos);
        vec3 refl = normalize(reflect(incident, norm));
        float specb = clamp(dot(refl, L), 0.0, 1.0);
        float specp = max(exp(specb * 10.0) - 1.0, 0.0);

        // Foam alpha modes (CodeWalker ShaderMode).
        if (uWaterMode == 1) {
            c.a *= clamp(vColor0.g, 0.0, 1.0);
        } else if (uWaterMode == 2) {
            c.a *= clamp(c.r, 0.0, 1.0);
            c.a *= clamp(vColor0.r, 0.0, 1.0);
        }
        c.a = clamp(c.a * max(0.0, uAlphaScale), 0.0, 1.0);

        // Lighting (forward approx): lambert + CodeWalker spec scale.
        float diff = max(dot(norm, L), 0.0);
        float sh = shadowAmount(norm, L);
        float k = 1.0 - (clamp(uShadowParams.z, 0.0, 1.0) * sh);
        vec3 lit = vec3(uAmbient) + (uLightColor * (diff * (1.0 - uAmbient) * k));
        vec3 outRgb = c.rgb * lit;
        outRgb += uLightColor * (0.00006 * specp * max(0.0, uSpecularIntensity) * k);

        if (uFogEnabled) {
            float dist = length(vWorldPos - uCameraPos);
            float fogF = smoothstep(uFogStart, uFogEnd, dist);
            outRgb = mix(outRgb, uFogColor, fogF);
        }

        fragColor = vec4(uOutputSrgb ? encodeSrgb(outRgb) : outRgb, clamp(c.a, 0.0, 1.0));
        return;
    }

    if (uWireframe) {
        vec3 L = normalize(uLightDir);
        float diff = max(dot(N, L), 0.0);
        vec3 c = uWireframeColor * (0.76 + diff * 0.24);
        if (uFogEnabled) {
            float dist = length(vWorldPos - uCameraPos);
            float fogF = smoothstep(uFogStart, uFogEnd, dist);
            c = mix(c, uFogColor, fogF);
        }
        fragColor = vec4(encodeSrgb(c), 1.0);
        return;
    }

    // --- Decal path (minimal) ---
    if (uShaderFamily == 1) {
        vec3 base = uColor;
        float outA = 1.0;
        int decalMode = uDecalMode;
        if (uHasDiffuse) {
            vec4 d = texture(uDiffuse, maybeFlipY(vUv, uFlipDiffuseY));
            vec3 drgb = uDecodeDiffuseSrgb ? decodeSrgb(d.rgb) : d.rgb;
            base *= drgb;
            outA = d.a;
        }
        if (uHasAlphaMask) {
            float m = texture(uAlphaMask, maybeFlipY(vUv, uFlipAlphaMaskY)).r;
            outA *= m;
        }
        // CodeWalker decal_dirt path: use vector mask against the sampled colour, then output alpha-only.
        if (decalMode == 2 && uHasDecalAlphaMaskVec) {
            vec4 c = vec4(base, outA);
            vec4 mask = uDecalAlphaMaskVec * c;
            outA = clamp(mask.r + mask.g + mask.b + mask.a, 0.0, 1.0);
            base = vec3(0.0);
        } else {
            // CodeWalker "spec-only" decals use red channel as alpha.
            if (decalMode == 4) outA = clamp(base.r, 0.0, 1.0);
            // NOTE: CodeWalker BasicPS does NOT multiply decal base colour by Colour0.rgb here.
            // It only uses Colour0.a for decal alpha modulation (handled below).
            // Decal tint (best-effort)
            base *= clamp(uDecalTint, 0.0, 10.0);
            if (uEnableTintPalette) {
                float tintY = tintPaletteEntityRow();
                #define TINT_SAMPLE(uv) (uDecodeTintPaletteSrgb ? decodeSrgb(texture(uTintPalette, (uv)).rgb) : texture(uTintPalette, (uv)).rgb)
                if (uTintMode == 1) {
                    float idx = clamp(vTintIndex, 0.0, 255.0);
                    vec2 tuv = vec2((idx + 0.5) / 256.0, tintY);
                    base *= TINT_SAMPLE(tuv);
                } else if (uTintMode == 2) {
                    float tx = (round(outA * 255.009995) - 32.0) * (1.0 / 128.0);
                    base *= TINT_SAMPLE(vec2(tx, tintPaletteWeaponRow()));
                    outA = 1.0;
                } else if (uTintMode == 3) {
                    base *= TINT_SAMPLE(vec2(clamp(vColor0.b, 0.0, 1.0), tintY));
                } else if (uTintMode == 4) {
                    base *= TINT_SAMPLE(vec2(clamp(vColor1.b, 0.0, 1.0), tintY));
                }
                #undef TINT_SAMPLE
            }
            // CodeWalker: decal alpha is also modulated by vertex colour alpha for regular decals.
            outA *= clamp(vColor0.a, 0.0, 1.0);

            // CodeWalker normal-only/spec-only decals don't contribute diffuse colour; approximate by alpha-only.
            if (decalMode >= 3) base = vec3(0.0);
            if (decalMode >= 3 && outA <= 0.0) discard;
        }
        outA = clamp(outA * max(0.0, uAlphaScale), 0.0, 1.0);
        if (uFogEnabled) {
            float dist = length(vWorldPos - uCameraPos);
            float fogF = smoothstep(uFogStart, uFogEnd, dist);
            base = mix(base, uFogColor, fogF);
        }
        fragColor = vec4(uOutputSrgb ? encodeSrgb(base) : base, outA);
        return;
    }

    // --- Glass/reflect path (approx) ---
    if (uShaderFamily == 2) {
        vec3 base = uColor;
        float outA = 0.25;
        if (uHasDiffuse) {
            vec4 d = texture(uDiffuse, maybeFlipY(vUv, uFlipDiffuseY));
            vec3 drgb = uDecodeDiffuseSrgb ? decodeSrgb(d.rgb) : d.rgb;
            base *= drgb;
            outA = d.a;
        }
        // NOTE: CodeWalker BasicPS does NOT multiply base albedo by Colour0.rgb by default.
        if (uEnableTintPalette) {
            float tintY = tintPaletteEntityRow();
            #define TINT_SAMPLE(uv) (uDecodeTintPaletteSrgb ? decodeSrgb(texture(uTintPalette, (uv)).rgb) : texture(uTintPalette, (uv)).rgb)
            if (uTintMode == 1) {
                float idx = clamp(vTintIndex, 0.0, 255.0);
                vec2 tuv = vec2((idx + 0.5) / 256.0, tintY);
                base *= TINT_SAMPLE(tuv);
            } else if (uTintMode == 2) {
                float tx = (round(outA * 255.009995) - 32.0) * (1.0 / 128.0);
                base *= TINT_SAMPLE(vec2(tx, tintPaletteWeaponRow()));
                outA = 1.0;
            } else if (uTintMode == 3) {
                base *= TINT_SAMPLE(vec2(clamp(vColor0.b, 0.0, 1.0), tintY));
            } else if (uTintMode == 4) {
                base *= TINT_SAMPLE(vec2(clamp(vColor1.b, 0.0, 1.0), tintY));
            }
            #undef TINT_SAMPLE
        }
        vec3 V = normalize(uCameraPos - vWorldPos);
        float ndv = clamp(dot(normalize(N), V), 0.0, 1.0);
        float fres = pow(1.0 - ndv, max(0.5, uFresnelPower));
        vec3 c = mix(base, uEnvColor, clamp(fres * max(0.0, uReflectionIntensity), 0.0, 1.0));
        outA = clamp(outA * max(0.0, uAlphaScale), 0.0, 1.0);
        if (uFogEnabled) {
            float dist = length(vWorldPos - uCameraPos);
            float fogF = smoothstep(uFogStart, uFogEnd, dist);
            c = mix(c, uFogColor, fogF);
        }
        fragColor = vec4(uOutputSrgb ? encodeSrgb(c) : c, outA);
        return;
    }

    // For env/parallax/wetness families we use the main path below, with feature toggles.
    // Compute view direction (world + tangent) once.
    vec3 Vw = normalize(uCameraPos - vWorldPos);
    vec3 Vt = vec3(dot(Vw, T), dot(Vw, B), dot(Vw, N));

    // Parallax: compute per-UV-set corrected UVs (only used when uHasHeight).
    vec2 uv0p = parallaxUv(vUv, Vt);
    vec2 uv1p = parallaxUv(vUv1, Vt);
    vec2 uv2p = parallaxUv(vUv2, Vt);

    // Tangent-space normal map (CodeWalker BasicPS-style).
    // Key differences vs a generic normal-map path:
    // - Uses XY only (reconstructs Z by default)
    // - Detail normal is sampled twice and blended in *before* (XY*2-1), weighted by specmap alpha (sv.w)
    if (uHasNormal) {
        vec2 uvN = selectUv3(uNormalUvSet, uv0p, uv1p, uv2p);
        vec2 uvS = selectUv3(uSpecUvSet, uv0p, uv1p, uv2p);
        vec2 uvD = selectUv3(uDetailUvSet, uv0p, uv1p, uv2p);

        vec4 ntex = texture(uNormal, maybeFlipY(uvN, uFlipNormalY));
        // Normal map stores XY in 0..1
        vec2 nmv = (uNormalEncoding == 1) ? ntex.ag : ntex.rg;

        // Specmap alpha is used as a weight for detail normal contribution in CodeWalker.
        vec4 sv = uHasSpec ? texture(uSpec, maybeFlipY(uvS, uFlipSpecY)) : vec4(0.1);

        if (uHasDetail) {
            vec2 uv0 = uvD * max(vec2(0.0), uDetailSettings.zw);
            vec2 uv1 = uv0 * 3.17;
            vec2 d0 = texture(uDetail, maybeFlipY(uv0, uFlipDetailY)).xy - vec2(0.5);
            vec2 d1 = texture(uDetail, maybeFlipY(uv1, uFlipDetailY)).xy - vec2(0.5);
            vec2 det = (d0 + d1) * max(0.0, uDetailSettings.y);
            nmv = det * sv.a + nmv;
        }

        // Convert to -1..1
        vec2 nxy = nmv * 2.0 - 1.0;
        float bump = max(uNormalScale, 0.001);
        vec2 bxy = nxy * bump;

        // Reconstruct Z from the *unscaled* XY (matches CodeWalker NormalMap()).
        float z = (uNormalReconstructZ)
            ? sqrt(abs(1.0 - dot(nxy, nxy)))
            : (ntex.b * 2.0 - 1.0);

        vec3 nts = vec3(bxy, z);
        N = normalize(T * nts.x + B * nts.y + N * nts.z);
    }

    vec3 L = normalize(uLightDir);
    float diff = diffuseAmount(N, L);
    vec3 base = uColor;
    float alphaRaw = 1.0;   // CodeWalker c.a before AlphaScale and before "force opaque" behavior.
    vec3 texRgb0 = vec3(1.0); // raw decoded diffuse rgb (for IsDistMap parity; excludes uColor/tint)
    bool hasAlpha = false;

    if (uHasDiffuse) {
        vec2 uvD0 = selectUv3(uDiffuseUvSet, uv0p, uv1p, uv2p);
        vec4 d = texture(uDiffuse, maybeFlipY(uvD0, uFlipDiffuseY));
        vec3 drgb = uDecodeDiffuseSrgb ? decodeSrgb(d.rgb) : d.rgb;
        texRgb0 = drgb;
        if (uPedHairTint) {
            // Hair RGB is a data mask. Gamma-decoding it crushes the low mask values
            // and makes dark default hair effectively disappear.
            float primaryMask = clamp(d.r, 0.0, 1.0);
            float highlightMask = clamp(d.g, 0.0, 1.0);
            float neutralMask = clamp(d.b, 0.0, 1.0);
            vec3 dyed = (uPedHairPrimary * primaryMask)
                + (uPedHairHighlight * highlightMask)
                + (mix(uPedHairPrimary, uPedHairHighlight, 0.5) * neutralMask);
            float maskSum = max(primaryMask + highlightMask + neutralMask, 0.001);
            float strandDetail = clamp(0.65 + max(max(d.r, d.g), d.b), 0.65, 1.15);
            base *= (dyed / maskSum) * strandDetail;
        } else {
            base *= drgb;
        }
        alphaRaw = d.a;
        hasAlpha = true;
    }
    // Diffuse2 layer (CodeWalker BasicPS: c = c2.a*c2 + (1-c2.a)*c, sampled on Texcoord1)
    if (uHasDiffuse2) {
        vec2 uvD2 = uDiffuse2UseUv1 ? uv1p : uv0p;
        vec4 d2 = texture(uDiffuse2, maybeFlipY(uvD2, uFlipDiffuse2Y));
        vec3 d2rgb = uDecodeDiffuse2Srgb ? decodeSrgb(d2.rgb) : d2.rgb;
        float a2 = clamp(d2.a, 0.0, 1.0);
        vec3 c2 = uColor * d2rgb;
        // HLSL: c = a2*c2 + (1-a2)*c
        base = (a2 * c2) + ((1.0 - a2) * base);
        // Alpha follows same rule for float4:
        //   c.a = a2*c2.a + (1-a2)*c.a
        // Here c2.a == a2, so: c.a = a2*a2 + (1-a2)*alphaRaw
        alphaRaw = (a2 * a2) + ((1.0 - a2) * alphaRaw);
        hasAlpha = true;
    }
    // NOTE: CodeWalker BasicPS does NOT multiply base albedo by Colour0.rgb by default.
    // CPV/color-only shaders are the exception: their albedo is carried by vertex color.
    if (uVertexColorMode == 1) {
        base *= clamp(vColor0.rgb, 0.0, 1.0);
    } else if (uVertexColorMode == 2) {
        base *= clamp(vColor1.rgb, 0.0, 1.0);
    }
    // Tint ordering parity:
    // - weapon palettes (EnableTint==2) happen BEFORE IsDistMap and BEFORE discard (uses raw alpha)
    // - regular tinting (EnableTint==1, via BasicVS output) happens AFTER IsDistMap/alpha logic
    vec3 tintMulLate = vec3(1.0);
    bool applyTintLate = false;
    if (uEnableTintPalette) {
        float tintY = tintPaletteEntityRow();
        #define TINT_SAMPLE(uv) (uDecodeTintPaletteSrgb ? decodeSrgb(texture(uTintPalette, (uv)).rgb) : texture(uTintPalette, (uv)).rgb)
        if (uTintMode == 2) {
            // CodeWalker BasicPS "weapon_*_palette": tx = (round(a*255.009995)-32) * 0.007813
            float tx = (round(alphaRaw * 255.009995) - 32.0) * (1.0 / 128.0);
            base *= TINT_SAMPLE(vec2(tx, tintPaletteWeaponRow()));
            // CodeWalker forces alpha=1 after applying weapon tint.
            alphaRaw = 1.0;
        } else if (uTintMode == 1) {
            float idx = clamp(vTintIndex, 0.0, 255.0);
            vec2 tuv = vec2((idx + 0.5) / 256.0, tintY);
            tintMulLate = TINT_SAMPLE(tuv);
            applyTintLate = true;
        } else if (uTintMode == 3) {
            tintMulLate = TINT_SAMPLE(vec2(clamp(vColor0.b, 0.0, 1.0), tintY));
            applyTintLate = true;
        } else if (uTintMode == 4) {
            tintMulLate = TINT_SAMPLE(vec2(clamp(vColor1.b, 0.0, 1.0), tintY));
            applyTintLate = true;
        } else {
            // unknown -> no-op
        }
        #undef TINT_SAMPLE
    }

    // Distance-map special case (CodeWalker BasicPS): c = float4(c.rgb*2, (c.r+c.g+c.b)-1)
    // This happens before discard and before AlphaScale.
    if (uIsDistMap) {
        base *= 2.0;
        // Important: alpha is derived from the *texture colour*, not any material multiplier/tint.
        vec3 dm = texRgb0 * 2.0;
        alphaRaw = (dm.r + dm.g + dm.b) - 1.0;
        hasAlpha = true;
    }

    // Dirt overlay (best-effort): darken + tint.
    if (uHasDirt) {
        float m = texture(uDirt, maybeFlipY(uv0p, uFlipDirtY)).r;
        float k = clamp(max(0.0, uDirtLevel) * m, 0.0, 1.0);
        vec3 dc = clamp(uDirtColor, 0.0, 10.0);
        base = mix(base, base * dc, k);
    }

    // Damage overlay (best-effort): apply mask then lerp towards damage texture.
    if (uHasDamage) {
        float dm = 1.0;
        if (uHasDamageMask) {
            dm = texture(uDamageMask, maybeFlipY(uv0p, uFlipDamageMaskY)).r;
        }
        vec3 d0 = texture(uDamage, maybeFlipY(uv0p, uFlipDamageY)).rgb;
        // Damage maps are usually not authored as sRGB in GTA pipelines, but we treat them as linear.
        base = mix(base, d0 * uColor, clamp(dm, 0.0, 1.0));
    }

    // AO (multiply base)
    if (uHasAO) {
        vec2 uvAO = selectUv3(uAOUvSet, uv0p, uv1p, uv2p);
        float ao = texture(uAO, maybeFlipY(uvAO, uFlipAOY)).r;
        float k = clamp(uAOStrength, 0.0, 2.0);
        base *= mix(vec3(1.0), vec3(ao), k);
    }

    // Alpha behaviour (CodeWalker BasicPS order):
    // - discard uses raw alpha (before AlphaScale)
    // - then AlphaScale is applied
    // - then non-decal variants force alpha=1 (in our pipeline: alphaMode==opaque/cutout)
    float outA = clamp(alphaRaw * max(0.0, uAlphaScale), 0.0, 1.0);
    if (uAlphaMode == 0) {
        if (hasAlpha && alphaRaw <= 0.33) discard;
        outA = 1.0;
    } else if (uAlphaMode == 1) {
        if (alphaRaw < uAlphaCutoff) discard;
        outA = 1.0;
    } else if (uAlphaMode == 2) {
        // "Hard alpha blend": treat very low alpha as cutout to avoid excessive sorting artifacts.
        if (uHardAlphaBlend > 0.5 && alphaRaw < uAlphaCutoff) discard;
    }

    // CodeWalker default tinting happens after alpha/distmap logic, and should not affect alpha.
    if (applyTintLate) {
        base *= tintMulLate;
    }

    float sh = shadowAmount(N, L);
    float k = 1.0 - (clamp(uShadowParams.z, 0.0, 1.0) * sh);
    vec3 c = base * (vec3(uAmbient) + (uLightColor * (diff * (1.0 - uAmbient) * k)));

    // Specular (CodeWalker BasicPS-style):
    // incident = normalize(CamRelPos). In our space, use camera->point vector.
    // refl = reflect(incident, norm)
    // specp = max(exp(saturate(dot(refl, LightDir))*10)-1, 0)
    // CodeWalker intensity path (BasicPS):
    // - sv.xy are squared
    // - intensity = dot(sv.xyz, specMapIntMask.xyz) * specularIntensityMult
    vec2 uvS2 = selectUv3(uSpecUvSet, uv0p, uv1p, uv2p);
    vec4 sv = uHasSpec ? texture(uSpec, maybeFlipY(uvS2, uFlipSpecY)) : vec4(0.1);
    // CodeWalker squares sv.xy before dot(spec.xyz, specMapIntMask).
    vec3 svw = vec3(sv.r * sv.r, sv.g * sv.g, sv.b);
    vec3 incident = normalize(vWorldPos - uCameraPos);
    vec3 refl = normalize(reflect(incident, N));
    float specb = clamp(dot(refl, L), 0.0, 1.0);
    float specp = max(exp(specb * 10.0) - 1.0, 0.0);
    float wet = clamp(uWetness, 0.0, 1.0);
    // Puddle mask locally increases wetness (best-effort).
    if (uHasPuddleMask) {
        float pm = texture(uPuddleMask, maybeFlipY(uv0p, uFlipPuddleMaskY)).r;
        // Use range.z as strength when available, else 1.0.
        float strength = clamp(uPuddleScaleRange.z, 0.0, 4.0);
        wet = clamp(max(wet, pm * strength), 0.0, 1.0);
    }
    float specBoost = mix(1.0, max(1.0, uWetSpecBoost), wet);
    // CodeWalker-ish spec term:
    // - squares sv.xy (we already did)
    // - intensity = dot(sv.xyz, specMapIntMask) * specularIntensityMult
    // - falloff uses sv.w and specularFalloffMult
    float intensity = dot(svw, max(uSpecMaskWeights, vec3(0.0))) * max(0.0, uSpecularIntensity);
    float falloff = clamp(sv.a * max(0.0, uSpecularFalloffMult), 0.0, 10.0);
    // CW adds: LightDirColour * 0.00006 * specp * r0.z * sv.x * specularIntensityMult
    // r0.z is ~1 in the common non-wet path; we approximate with (1.0) here.
    float spk = (0.00006 * specp) * intensity * falloff * svw.x;
    // Optional wetness boost (viewer extension).
    spk *= specBoost;
    c += uLightColor * (spk * k);

    // Opaque env reflection (best-effort) for env/parallax/wetness families.
    // (Glass family is handled above.)
    if (uShaderFamily == 3 || uShaderFamily == 4 || uShaderFamily == 5) {
        float ndv = clamp(dot(normalize(N), Vw), 0.0, 1.0);
        float fres = pow(1.0 - ndv, max(0.5, uFresnelPower));
        float reflK = clamp(fres * max(0.0, uReflectionIntensity), 0.0, 1.0);
        // Wetness increases reflectivity and darkens base a bit.
        float dark = clamp(uWetDarken, 0.0, 1.0);
        vec3 envC = uEnvColor;
        if (uHasEnvMap) {
            vec2 euv = envLatLongUv(refl);
            vec3 e0 = texture(uEnvMap, maybeFlipY(euv, uFlipEnvY)).rgb;
            envC = uDecodeEnvSrgb ? decodeSrgb(e0) : e0;
        }
        c = mix(c, envC, reflK * mix(1.0, 1.25, wet));
        c *= mix(1.0, 1.0 - 0.25 * dark, wet);
    }

    // Emissive (additive)
    if (uHasEmissive) {
        vec2 uvE = selectUv3(uEmissiveUvSet, uv0p, uv1p, uv2p);
        vec3 e0 = texture(uEmissive, maybeFlipY(uvE, uFlipEmissiveY)).rgb;
        vec3 e = uDecodeEmissiveSrgb ? decodeSrgb(e0) : e0;
        c += e * max(0.0, uEmissiveIntensity);
    }

    if (uFogEnabled) {
        float dist = length(vWorldPos - uCameraPos);
        float fogF = smoothstep(uFogStart, uFogEnd, dist);
        c = mix(c, uFogColor, fogF);
    }

    fragColor = vec4(uOutputSrgb ? encodeSrgb(c) : c, outA);
}
`;

export class InstancedModelRenderer {
    constructor(gl, modelManager, textureStreamer) {
        this.gl = gl;
        this.modelManager = modelManager;
        this.textureStreamer = textureStreamer;
        this.program = new ShaderProgram(gl);
        // Shadow depth-only program (directional shadow map).
        this._shadowProgram = new ShaderProgram(gl);
        this.tintPaletteTex = null;
        // Fallback textures to avoid "feedback loop formed between Framebuffer and active Texture"
        // when a draw item doesn't bind a map (leaving stale bindings from a previous pass, e.g. PostFX).
        this._texWhite = null;
        this._texBlack = null;
        this._texNormalFlat = null;
        this._skinBaseRows3x4 = [];
        this._skinTransforms3x4 = [];
        this._skinBoneNameToIndex = new Map();
        this._skinBoneBindTransforms = [];
        this._skinBoneBindInverseTransforms = [];
        this._skinBoneParents = [];
        this._skinBoneTransformScratch = glMatrix.mat4.create();
        this._skinBonePivots = [];
        this._skinPoseVersion = 1;
        this._lastSkinPoseKey = '';
        this._skinTextureCache = new Map();
        this._identityBoneTexture = null;
        this._skinAnimationSet = null;
        // Prefer sampled GTA YCD palettes. The procedural pose below is retained as
        // a fallback for missing animation data only.
        this.enableSampledYcdSkinning = true;
        this.characterLocomotion = null;
        this.pedHairPrimary = [0.035, 0.012, 0.004];
        this.pedHairHighlight = [0.035, 0.012, 0.004];

        // Match TerrainRenderer's model matrix transforms (data-space -> viewer-space)
        this.modelMatrix = glMatrix.mat4.create();
        glMatrix.mat4.rotateY(this.modelMatrix, this.modelMatrix, Math.PI);
        glMatrix.mat4.rotateX(this.modelMatrix, this.modelMatrix, -Math.PI / 2);
        this._gpuCullVpData = glMatrix.mat4.create();
        this._gpuCullPlanes = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
        this._gpuCullPlanesFlat = new Float32Array(24);
        this._fragmentRotationScratch = new Float32Array(9);

        this.ready = false;
        this.uniforms = null;
        this._shadowUniforms = null;

        // Directional shadow map resources (created lazily / resized on demand).
        this._shadow = {
            enabled: false,
            size: 0,
            fbo: null,
            depthTex: null,
            dummyDepthTex: null,
            lightViewProj: glMatrix.mat4.create(),
        };

        // key(hash:lod) -> { hash, lod, minDist, instanceBuffer, instanceCount, submeshes: Map<file, {file, material, mesh, vao}> }
        this.instances = new Map();

        // Cross-archetype instancing buckets:
        // key(bucketId) -> { bucketId, lod, file, material, minDist, instanceBuffer, instanceCount, mesh, vao }
        // Where bucketId is a stable key like `${lod}:${file}:${materialSig}`
        this.buckets = new Map();

        // Mesh-load throttling: prevents the browser/network stack from exploding when we
        // suddenly discover thousands of archetypes/submeshes in nearby chunks.
        this.maxMeshLoadsInFlight = 6;
        this._meshLoadsInFlight = 0;
        this._meshLoadQueue = []; // Array<{ entryKey, file, dist, seq }>
        this._meshLoadPending = new Set(); // key(entryKey:file)
        this._meshLoadSeq = 1;

        // World meshes retain the normal cache policy. The player renderer opts into a
        // fresh request after an exporter update so stale v7 bins cannot disable skinning.
        this.meshLoadOptions = {
            usePersistentCache: true,
            cacheBust: '',
            requireBlendAttributes: false,
        };

        // Debug stats (used by Perf HUD / console).
        this._occlusionStats = {
            tested: 0,
            culled: 0,
            depthCandidates: 0,
            depthDraws: 0,
            depthInstances: 0,
            depthDistanceRejected: 0,
            depthSizeRejected: 0,
        };
        this._renderStats = {
            drawCalls: 0,
            triangles: 0,
            instances: 0,
            bucketDraws: 0,
            submeshDraws: 0,
            drawItems: 0,
            // Texture diagnostics (helps answer "why are textures not showing?")
            diffuseWanted: 0,
            diffusePlaceholder: 0,
            diffuseReal: 0,
            diffuseMissingFromIndex: 0,
            drawItemsMissingUv: 0,
        };

        // Centralized texture URL resolver (handles hash-only vs hash+slug, index gating, negative-cache).
        this._texResolver = new TexturePathResolver({ textureStreamer: this.textureStreamer });

        // Frame-level texture diagnostics (helps answer: "which textures are placeholders right now?").
        // Reset each render() call.
        this._texFrame = {
            missingFromExportedSet: new Map(), // rel -> count (resolver returned null)
            placeholderUrls: new Map(),        // url -> count (resolved url but placeholder used)
        };
        this._lastPickDrawItems = [];
        this._lastPickReport = null;
        // gl.getError() after every draw is useful when isolating a corrupt drawable,
        // but it can serialize WebGL and destroy frame pacing. Keep it opt-in.
        this.debugDrawGlErrors = false;
        this._pickTmpInvVp = glMatrix.mat4.create();
        this._pickTmpInst = glMatrix.mat4.create();
        this._pickTmpLocalToViewer = glMatrix.mat4.create();
        this._pickTmpInvLocalToViewer = glMatrix.mat4.create();
        this._pickTmpNear = glMatrix.vec4.create();
        this._pickTmpFar = glMatrix.vec4.create();
        this._pickTmpRayOrigin4 = glMatrix.vec4.create();
        this._pickTmpRayDir4 = glMatrix.vec4.create();
        this._pickTmpLocalOrigin = glMatrix.vec4.create();
        this._pickTmpLocalDir = glMatrix.vec4.create();
        this._pickTmpLocalHit = glMatrix.vec4.create();
        this._pickTmpData = glMatrix.vec4.create();
        this._pickTmpWorld = glMatrix.vec4.create();
        this._pickTmpClip = glMatrix.vec4.create();

        // Avoid spamming console for unknown shader families.
        this._warnedShaderFamilies = new Set();

        // Diagnostics / safety:
        // - If a single drawable triggers a WebGL error (INVALID_OPERATION etc), some browsers effectively
        //   stop producing valid output for the rest of the frame and users see a grey screen.
        // - Track and skip offenders after the first failure so the viewer stays usable and we can identify culprits.
        this._badDrawKeys = new Set(); // key => true
        this._lastGlError = null;      // { err, key, file, shaderName, whenMs }
    }

    setSkinningSkeleton(skeleton) {
        const rows = [];
        try {
            const top = Array.isArray(skeleton?.skinTransforms3x4) ? skeleton.skinTransforms3x4 : [];
            if (top.length) {
                for (const r of top) {
                    rows.push((Array.isArray(r) && r.length >= 12) ? r.slice(0, 12).map((v) => Number(v) || 0.0) : null);
                }
            } else {
                for (const b of (Array.isArray(skeleton?.bones) ? skeleton.bones : [])) {
                    const r = b?.skinTransform3x4;
                    rows.push((Array.isArray(r) && r.length >= 12) ? r.slice(0, 12).map((v) => Number(v) || 0.0) : null);
                }
            }
        } catch {
            rows.length = 0;
        }

        this._skinBaseRows3x4 = rows.map((r) => Array.isArray(r) ? r.slice(0, 12) : null);
        this._skinTransforms3x4 = this._skinBaseRows3x4.map((r) => Array.isArray(r) ? r.slice(0, 12) : null);
        this._skinBoneNameToIndex = new Map();
        this._skinBoneBindTransforms = [];
        this._skinBoneBindInverseTransforms = [];
        this._skinBoneParents = [];
        this._skinBonePivots = [];
        try {
            const bones = Array.isArray(skeleton?.bones) ? skeleton.bones : [];
            for (let i = 0; i < bones.length; i++) {
                const b = bones[i] || {};
                const name = String(b.name || '').trim();
                if (name) this._skinBoneNameToIndex.set(name, i);
                const parentIndex = Number(b.parentIndex);
                this._skinBoneParents[i] = Number.isInteger(parentIndex) && parentIndex >= 0 && parentIndex < bones.length
                    ? parentIndex
                    : -1;
                const bindInv = Array.isArray(b.bindTransformInv) ? b.bindTransformInv : null;
                if (bindInv?.length >= 16) {
                    // GTA serializes TransformationsInverted in its native row-vector
                    // layout. Copying that scalar layout into glMatrix gives the
                    // equivalent column-vector matrix used by the browser renderer.
                    const inverse = glMatrix.mat4.create();
                    for (let j = 0; j < 16; j++) inverse[j] = Number(bindInv[j]) || 0.0;
                    inverse[15] = 1.0;
                    const bind = glMatrix.mat4.create();
                    if (glMatrix.mat4.invert(bind, inverse)) {
                        this._skinBoneBindTransforms[i] = bind;
                        this._skinBoneBindInverseTransforms[i] = inverse;
                    }
                }
                const pivot = this._pivotFromBindTransformInv(b.bindTransformInv);
                this._skinBonePivots[i] = pivot;
            }
        } catch {
            this._skinBoneNameToIndex = new Map();
            this._skinBoneBindTransforms = [];
            this._skinBoneBindInverseTransforms = [];
            this._skinBoneParents = [];
            this._skinBonePivots = [];
        }
        this._skinPoseVersion++;
        this._lastSkinPoseKey = '';
        this._clearSkinTextureCache();
    }

    setSkinningAnimationSet(animationSet) {
        const clipsIn = (animationSet && typeof animationSet === 'object') ? (animationSet.clips || {}) : {};
        const boneCount = Math.max(
            0,
            Number(animationSet?.boneCount) | 0,
            Array.isArray(this._skinBaseRows3x4) ? this._skinBaseRows3x4.length : 0
        );
        const clips = {};
        for (const [nameRaw, clipRaw] of Object.entries(clipsIn || {})) {
            const name = String(nameRaw || '').trim().toLowerCase();
            // `mergeSkinningAnimationSet` may feed already-normalized clips
            // back through this loader. Preserve their Float32Array frames as
            // well as raw JSON `frames3x4`, otherwise adding combat clips
            // silently drops the normal locomotion set.
            const framesRaw = Array.isArray(clipRaw?.frames3x4)
                ? clipRaw.frames3x4
                : (Array.isArray(clipRaw?.frames) ? clipRaw.frames : []);
            const expected = boneCount * 12;
            if (!name || boneCount <= 0 || expected <= 0 || framesRaw.length < 2) continue;
            const frames = [];
            for (const frame of framesRaw) {
                if ((!Array.isArray(frame) && !ArrayBuffer.isView(frame)) || frame.length < expected) continue;
                const data = new Float32Array(expected);
                for (let i = 0; i < expected; i++) data[i] = Number(frame[i]) || 0.0;
                frames.push(data);
            }
            if (frames.length < 2) continue;
            const fps = Math.max(1.0, Number(clipRaw?.fps) || 30.0);
            const duration = Math.max(1.0 / fps, Number(clipRaw?.duration) || (frames.length / fps));
            clips[name] = {
                name,
                sourceYcd: String(clipRaw?.sourceYcd || ''),
                sourceClip: String(clipRaw?.sourceClip || name),
                composite: clipRaw?.composite === true,
                weaponLayer: clipRaw?.weaponLayer === true,
                requiresProceduralRecoil: clipRaw?.requiresProceduralRecoil === true,
                fullBody: clipRaw?.fullBody === true,
                duration,
                frameCount: frames.length,
                boneCount,
                frames,
            };
        }
        this._skinAnimationSet = Object.keys(clips).length ? {
            schema: String(animationSet?.schema || ''),
            boneCount,
            clips,
        } : null;
        this._skinPoseVersion++;
        this._lastSkinPoseKey = '';
    }

    mergeSkinningAnimationSet(animationSet) {
        const incoming = (animationSet && typeof animationSet === 'object') ? animationSet : null;
        const incomingClips = incoming?.clips;
        if (!incomingClips || typeof incomingClips !== 'object' || !Object.keys(incomingClips).length) return false;
        const current = this._skinAnimationSet || {};
        this.setSkinningAnimationSet({
            schema: String(incoming.schema || current.schema || ''),
            boneCount: Math.max(Number(current.boneCount) || 0, Number(incoming.boneCount) || 0),
            clips: { ...(current.clips || {}), ...incomingClips },
        });
        return !!this._skinAnimationSet?.clips;
    }

    _clearSkinTextureCache() {
        const gl = this.gl;
        try {
            for (const rec of this._skinTextureCache?.values?.() || []) {
                if (rec?.tex) gl.deleteTexture(rec.tex);
            }
        } catch { /* ignore */ }
        try { this._skinTextureCache?.clear?.(); } catch { /* ignore */ }
    }

    _pivotFromBindTransformInv(bindTransformInv) {
        const src = Array.isArray(bindTransformInv) ? bindTransformInv : null;
        if (!src || src.length < 16) return null;
        try {
            const row = new Float32Array(16);
            for (let i = 0; i < 16; i++) row[i] = Number(src[i]) || 0.0;
            row[15] = 1.0;
            const col = glMatrix.mat4.create();
            for (let r = 0; r < 4; r++) {
                for (let c = 0; c < 4; c++) col[c * 4 + r] = row[r * 4 + c];
            }
            const inv = glMatrix.mat4.create();
            if (!glMatrix.mat4.invert(inv, col)) return null;
            const out = new Float32Array(16);
            for (let r = 0; r < 4; r++) {
                for (let c = 0; c < 4; c++) out[r * 4 + c] = inv[c * 4 + r];
            }
            return [out[12], out[13], out[14]];
        } catch {
            return null;
        }
    }

    _identityRowMatrix() {
        return [
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0,
        ];
    }

    _mulRowMatrix(a, b) {
        const out = new Array(16).fill(0.0);
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
                out[r * 4 + c] =
                    a[r * 4 + 0] * b[0 * 4 + c] +
                    a[r * 4 + 1] * b[1 * 4 + c] +
                    a[r * 4 + 2] * b[2 * 4 + c] +
                    a[r * 4 + 3] * b[3 * 4 + c];
            }
        }
        return out;
    }

    _rotationAroundPivotRow(axis, angle, pivot) {
        const p = Array.isArray(pivot) ? pivot : null;
        if (!p || !Number.isFinite(angle) || Math.abs(angle) < 1e-8) return this._identityRowMatrix();
        const px = Number(p[0]) || 0.0;
        const py = Number(p[1]) || 0.0;
        const pz = Number(p[2]) || 0.0;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        if (axis === 'z') {
            return [
                c, -s, 0.0, 0.0,
                s, c, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                px - c * px - s * py,
                py + s * px - c * py,
                0.0,
                1.0,
            ];
        }
        if (axis === 'y') {
            return [
                c, 0.0, s, 0.0,
                0.0, 1.0, 0.0, 0.0,
                -s, 0.0, c, 0.0,
                px - c * px + s * pz,
                0.0,
                pz - s * px - c * pz,
                1.0,
            ];
        }
        return [
            1.0, 0.0, 0.0, 0.0,
            0.0, c, s, 0.0,
            0.0, -s, c, 0.0,
            0.0,
            py - c * py + s * pz,
            pz - s * py - c * pz,
            1.0,
        ];
    }

    _rows3x4FromRowMatrix(m) {
        return [
            m[0], m[4], m[8], m[12],
            m[1], m[5], m[9], m[13],
            m[2], m[6], m[10], m[14],
        ];
    }

    _rowMatrixFromRows3x4(rows) {
        if (!rows || rows.length < 12) return null;
        return [
            rows[0], rows[4], rows[8], 0.0,
            rows[1], rows[5], rows[9], 0.0,
            rows[2], rows[6], rows[10], 0.0,
            rows[3], rows[7], rows[11], 1.0,
        ];
    }

    _applySkinBoneMatrix(rows, boneName, matrix) {
        const idx = this._skinBoneNameToIndex.get(String(boneName || ''));
        if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) return false;
        rows[idx] = this._rows3x4FromRowMatrix(matrix);
        return true;
    }

    _applyCombatUpperBodyPose(rows, combat) {
        const blend = Math.max(0.0, Math.min(1.0, Number(combat?.blend) || 0.0));
        if ((!combat?.armed && !combat?.melee) || blend <= 0.001 || !Array.isArray(rows)) return false;
        const aiming = !!combat.aiming;
        const reloading = !!combat.reloading;
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() * 0.001 : 0.0;
        const reloadOffset = reloading ? Math.sin(now * 9.0) * 0.18 : 0.0;
        const apply = (boneName, axis, angle) => {
            const idx = this._skinBoneNameToIndex.get(boneName);
            const pivot = this._skinBonePivots[idx];
            const current = this._rowMatrixFromRows3x4(rows[idx]);
            if (!Number.isInteger(idx) || !pivot || !current) return;
            const delta = this._rotationAroundPivotRow(axis, angle * blend, pivot);
            rows[idx] = this._rows3x4FromRowMatrix(this._mulRowMatrix(current, delta));
        };

        if (combat?.melee) {
            const progress = Math.max(0.0, Math.min(1.0, Number(combat.progress) || 0.0));
            const strike = Math.sin(progress * Math.PI);
            const recover = Math.sin(Math.min(1.0, progress * 1.6) * Math.PI);
            const type = String(combat.attackType || '');
            if (combat.guarding) {
                apply('SKEL_R_UpperArm', 'x', -0.72);
                apply('SKEL_R_Forearm', 'x', -0.62);
                apply('SKEL_L_UpperArm', 'x', -0.72);
                apply('SKEL_L_Forearm', 'x', -0.62);
                apply('SKEL_Spine2', 'x', 0.10);
                return true;
            }
            if (combat.hurt) {
                apply('SKEL_Spine1', 'x', 0.28);
                apply('SKEL_Spine2', 'z', 0.20);
                apply('SKEL_R_UpperArm', 'x', -0.28);
                apply('SKEL_L_UpperArm', 'x', -0.28);
                return true;
            }
            apply('SKEL_Spine2', 'z', (type === 'left_punch' ? -0.24 : 0.24) * recover);
            apply('SKEL_Spine1', 'x', 0.12 * strike);
            if (type === 'left_punch') {
                apply('SKEL_L_Clavicle', 'z', -0.16 * strike);
                apply('SKEL_L_UpperArm', 'x', -1.18 * strike);
                apply('SKEL_L_Forearm', 'x', -0.38 * strike);
                apply('SKEL_R_UpperArm', 'x', -0.34 * recover);
            } else if (type === 'front_kick') {
                apply('SKEL_R_Thigh', 'x', -1.05 * strike);
                apply('SKEL_R_Calf', 'x', 0.62 * strike);
                apply('SKEL_R_Foot', 'x', -0.22 * strike);
                apply('SKEL_R_UpperArm', 'x', -0.44 * recover);
                apply('SKEL_L_UpperArm', 'x', -0.44 * recover);
            } else {
                apply('SKEL_R_Clavicle', 'z', 0.16 * strike);
                apply('SKEL_R_UpperArm', 'x', -1.18 * strike);
                apply('SKEL_R_Forearm', 'x', -0.38 * strike);
                apply('SKEL_L_UpperArm', 'x', -0.34 * recover);
            }
            return true;
        }

        const rightRaise = -0.46 - (aiming ? 0.58 : 0.0);
        const rightForearm = -0.30 - (aiming ? 0.54 : 0.0);
        const leftRaise = -0.18 - (aiming ? 0.78 : 0.0) + reloadOffset;
        const leftForearm = -0.12 - (aiming ? 0.64 : 0.0) - reloadOffset * 0.6;
        apply('SKEL_R_Clavicle', 'z', -0.10 - (aiming ? 0.08 : 0.0));
        apply('SKEL_R_UpperArm', 'x', rightRaise);
        apply('SKEL_R_Forearm', 'x', rightForearm);
        apply('SKEL_R_Hand', 'y', aiming ? 0.10 : 0.04);
        apply('SKEL_L_Clavicle', 'z', 0.10 + (aiming ? 0.10 : 0.0));
        apply('SKEL_L_UpperArm', 'x', leftRaise);
        apply('SKEL_L_Forearm', 'x', leftForearm);
        apply('SKEL_L_Hand', 'y', aiming ? -0.12 : -0.04);
        apply('SKEL_Spine2', 'z', aiming ? 0.07 : 0.035);
        return true;
    }

    _selectSkinningAnimationClip(characterLocomotion, { ignoreCombat = false } = {}) {
        const clips = this._skinAnimationSet?.clips || null;
        if (!clips) return null;
        const gesture = characterLocomotion?.gesture || null;
        if (gesture?.active) {
            const gestureClip = clips[String(gesture.clip || '')];
            if (gestureClip) return gestureClip;
        }
        const move01 = Math.max(0.0, Math.min(1.0, Number(characterLocomotion?.move01) || 0.0));
        const enabled = !!characterLocomotion?.enabled && move01 > 0.005;
        const gait = String(characterLocomotion?.gait || '').trim().toLowerCase();
        const combat = characterLocomotion?.combat || null;
        if (!ignoreCombat && combat?.melee) {
            const clip = clips[String(combat.clip || '').trim().toLowerCase()];
            if (clip?.fullBody) return clip;
        }
        if (!ignoreCombat && combat?.armed) {
            // Weapon YCD dictionaries contain a masked BothArms layer. Only
            // select combat clips marked composite by the exporter: those have
            // already been evaluated over the matching full-body locomotion
            // clip, so every joint has a valid skin transform.
            const composite = (name) => clips[name]?.composite ? clips[name] : null;
            const movement = !enabled ? 'idle' : (gait === 'walk' ? 'walk' : 'run');
            if (combat.phase === 'drawing') {
                const clip = composite('draw');
                if (clip) return clip;
            }
            if (combat.phase === 'holstering') {
                const clip = composite('holster');
                if (clip) return clip;
            }
            if (combat.reloading) {
                const clip = composite(`reload_${movement}`) || composite('reload_idle');
                if (clip) return clip;
            }
            if (combat.aimTransition === 'enter') {
                const clip = composite(`aim_enter_${movement}`) || composite('aim_enter_idle');
                if (clip) return clip;
            }
            if (combat.firing) {
                const clip = composite(`fire_${movement}`) || composite('fire_idle');
                if (clip) return clip;
            }
            if (combat.aiming) {
                const clip = composite(`aim_${movement}`) || composite('aim_idle');
                if (clip) return clip;
            }
            const carry = composite(`armed_${movement}`) || composite('armed_idle');
            if (carry) return carry;
        }
        if (!enabled && clips.idle) return clips.idle;
        if (gait && clips[gait]) return clips[gait];
        if (move01 >= 0.82 && clips.sprint) return clips.sprint;
        if (move01 >= 0.42 && clips.run) return clips.run;
        if (clips.walk) return clips.walk;
        return clips.run || clips.sprint || clips.idle || null;
    }

    _isExactCombatClip(clip, combat) {
        if (!combat?.armed || !clip) return false;
        const name = String(clip.name || '').toLowerCase();
        return name === 'draw'
            || name === 'holster'
            || name === 'reload'
            || name === 'armed_idle'
            || name === 'armed_walk'
            || name === 'armed_run'
            || name === 'aim'
            || name === 'fire';
    }

    _sampleSkinningAnimationRows(clip, timeSeconds) {
        if (!clip?.frames?.length || !clip.boneCount) return null;
        const frameCount = clip.frames.length;
        const duration = Math.max(0.0001, Number(clip.duration) || 1.0);
        const t0 = Number.isFinite(Number(timeSeconds)) ? Number(timeSeconds) : 0.0;
        const localT = ((t0 % duration) + duration) % duration;
        const framePos = (localT / duration) * frameCount;
        const i0 = Math.floor(framePos) % frameCount;
        const i1 = (i0 + 1) % frameCount;
        const alpha = Math.max(0.0, Math.min(1.0, framePos - Math.floor(framePos)));
        const a = clip.frames[i0];
        const b = clip.frames[i1];
        if (!a || !b) return null;

        const boneCount = Math.max(0, Number(clip.boneCount) | 0);
        const rows = new Array(boneCount);
        for (let bone = 0; bone < boneCount; bone++) {
            const off = bone * 12;
            const r = new Array(12);
            for (let j = 0; j < 12; j++) {
                const av = a[off + j] || 0.0;
                r[j] = av + ((b[off + j] || 0.0) - av) * alpha;
            }
            rows[bone] = r;
        }
        return {
            rows,
            key: `ycd:${clip.name}:${i0}:${i1}:${Math.round(alpha * 1000)}`,
        };
    }

    _isBothArmsFilterBone(name) {
        const bone = String(name || '');
        if (!bone) return false;
        // `BothArms_filter` from the server weaponanimations.meta is an
        // upper-limb layer, not a replacement for the pelvis/spine/leg pose.
        return bone.startsWith('SKEL_L_Clavicle')
            || bone.startsWith('SKEL_R_Clavicle')
            || bone.startsWith('SKEL_L_UpperArm')
            || bone.startsWith('SKEL_R_UpperArm')
            || bone.startsWith('SKEL_L_Forearm')
            || bone.startsWith('SKEL_R_Forearm')
            || bone.startsWith('SKEL_L_Hand')
            || bone.startsWith('SKEL_R_Hand')
            || bone.startsWith('SKEL_L_Finger')
            || bone.startsWith('SKEL_R_Finger')
            || bone.startsWith('SKEL_L_Thumb')
            || bone.startsWith('SKEL_R_Thumb')
            || bone === 'IK_L_Hand'
            || bone === 'IK_R_Hand'
            || bone === 'PH_L_Hand'
            || bone === 'PH_R_Hand';
    }

    _hasWeaponOverlayTrack(rows) {
        if (!Array.isArray(rows) || rows.length < 12) return false;
        const identity = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        for (let i = 0; i < 12; i++) {
            if (Math.abs((Number(rows[i]) || 0.0) - identity[i]) > 0.001) return true;
        }
        return false;
    }

    _applyWeaponArmsOverlayRows(baseRows, overlayRows) {
        if (!Array.isArray(baseRows) || !Array.isArray(overlayRows)) return false;
        const count = Math.min(baseRows.length, overlayRows.length, this._skinBoneBindTransforms.length);
        if (!count) return false;

        // YCD palettes are final skin matrices. A weapon clip's identity row means
        // "leave the base pose alone", not "put this joint in its bind/T pose".
        // Rebuild keyed joints in local-bone space so their current base parent
        // (spine, gait, and root) stays intact.
        const baseWorlds = new Array(count);
        const overlayWorlds = new Array(count);
        const finalWorlds = new Array(count);
        for (let i = 0; i < count; i++) {
            const bind = this._skinBoneBindTransforms[i];
            const base = this._rowMatrixFromRows3x4(baseRows[i]);
            const overlay = this._rowMatrixFromRows3x4(overlayRows[i]);
            if (!bind || !base || !overlay) continue;
            const baseWorld = glMatrix.mat4.create();
            const overlayWorld = glMatrix.mat4.create();
            glMatrix.mat4.multiply(baseWorld, base, bind);
            glMatrix.mat4.multiply(overlayWorld, overlay, bind);
            baseWorlds[i] = baseWorld;
            overlayWorlds[i] = overlayWorld;
            finalWorlds[i] = baseWorld;
        }

        const selected = [];
        for (const [name, index] of this._skinBoneNameToIndex) {
            if (index >= 0 && index < count && this._isBothArmsFilterBone(name)) selected.push(index);
        }
        selected.sort((a, b) => a - b);
        let applied = false;
        for (const index of selected) {
            const sourceRows = overlayRows[index];
            const sourceWorld = overlayWorlds[index];
            const bindInverse = this._skinBoneBindInverseTransforms[index];
            if (!this._hasWeaponOverlayTrack(sourceRows) || !sourceWorld || !bindInverse) continue;

            const parent = this._skinBoneParents[index];
            const sourceParent = parent >= 0 ? overlayWorlds[parent] : null;
            const finalParent = parent >= 0 ? finalWorlds[parent] : null;
            const local = glMatrix.mat4.create();
            if (sourceParent) {
                const sourceParentInverse = glMatrix.mat4.create();
                if (!glMatrix.mat4.invert(sourceParentInverse, sourceParent)) continue;
                glMatrix.mat4.multiply(local, sourceParentInverse, sourceWorld);
            } else {
                glMatrix.mat4.copy(local, sourceWorld);
            }

            const finalWorld = glMatrix.mat4.create();
            if (finalParent) glMatrix.mat4.multiply(finalWorld, finalParent, local);
            else glMatrix.mat4.copy(finalWorld, local);
            const finalSkin = glMatrix.mat4.create();
            glMatrix.mat4.multiply(finalSkin, finalWorld, bindInverse);
            baseRows[index] = this._rows3x4FromRowMatrix(finalSkin);
            finalWorlds[index] = finalWorld;
            applied = true;
        }
        return applied;
    }

    _blendWeaponArmRows(fromRows, toRows, weight) {
        if (!Array.isArray(fromRows) || !Array.isArray(toRows)) return null;
        const count = Math.min(fromRows.length, toRows.length, this._skinBoneBindTransforms.length);
        if (!count) return null;
        const amount = Math.max(0.0, Math.min(1.0, Number(weight) || 0.0));
        const out = fromRows.map((row) => Array.isArray(row) ? row.slice(0, 12) : row);
        const fromWorlds = new Array(count);
        const toWorlds = new Array(count);
        const blendedWorlds = new Array(count);
        for (let i = 0; i < count; i++) {
            const bind = this._skinBoneBindTransforms[i];
            const from = this._rowMatrixFromRows3x4(fromRows[i]);
            const to = this._rowMatrixFromRows3x4(toRows[i]);
            if (!bind || !from || !to) continue;
            const fromWorld = glMatrix.mat4.create();
            const toWorld = glMatrix.mat4.create();
            glMatrix.mat4.multiply(fromWorld, from, bind);
            glMatrix.mat4.multiply(toWorld, to, bind);
            fromWorlds[i] = fromWorld;
            toWorlds[i] = toWorld;
            blendedWorlds[i] = fromWorld;
        }

        const depthByIndex = new Map();
        const depth = (index) => {
            if (depthByIndex.has(index)) return depthByIndex.get(index);
            const parent = this._skinBoneParents[index];
            const value = parent >= 0 && parent < count ? depth(parent) + 1 : 0;
            depthByIndex.set(index, value);
            return value;
        };
        const selected = [];
        for (const [name, index] of this._skinBoneNameToIndex) {
            if (this._isBothArmsFilterBone(name) && index >= 0 && index < count) selected.push(index);
        }
        selected.sort((a, b) => depth(a) - depth(b));

        // Skin matrices cannot be blended element-by-element: that introduces
        // shear and collapses joints at the ADS transition. Blend arm locals as
        // translation + rotation, then rebuild the final skin palette.
        for (const index of selected) {
            const fromWorld = fromWorlds[index];
            const toWorld = toWorlds[index];
            const bindInverse = this._skinBoneBindInverseTransforms[index];
            if (!fromWorld || !toWorld || !bindInverse) continue;
            const parent = this._skinBoneParents[index];
            const fromParent = parent >= 0 ? fromWorlds[parent] : null;
            const toParent = parent >= 0 ? toWorlds[parent] : null;
            const blendedParent = parent >= 0 ? blendedWorlds[parent] : null;
            const fromLocal = glMatrix.mat4.create();
            const toLocal = glMatrix.mat4.create();
            if (fromParent && toParent) {
                const fromParentInverse = glMatrix.mat4.create();
                const toParentInverse = glMatrix.mat4.create();
                if (!glMatrix.mat4.invert(fromParentInverse, fromParent) || !glMatrix.mat4.invert(toParentInverse, toParent)) continue;
                glMatrix.mat4.multiply(fromLocal, fromParentInverse, fromWorld);
                glMatrix.mat4.multiply(toLocal, toParentInverse, toWorld);
            } else {
                glMatrix.mat4.copy(fromLocal, fromWorld);
                glMatrix.mat4.copy(toLocal, toWorld);
            }
            const fromTranslation = glMatrix.vec3.create();
            const toTranslation = glMatrix.vec3.create();
            const translation = glMatrix.vec3.create();
            const fromRotation = glMatrix.quat.create();
            const toRotation = glMatrix.quat.create();
            const rotation = glMatrix.quat.create();
            glMatrix.mat4.getTranslation(fromTranslation, fromLocal);
            glMatrix.mat4.getTranslation(toTranslation, toLocal);
            glMatrix.vec3.lerp(translation, fromTranslation, toTranslation, amount);
            glMatrix.mat4.getRotation(fromRotation, fromLocal);
            glMatrix.mat4.getRotation(toRotation, toLocal);
            glMatrix.quat.slerp(rotation, fromRotation, toRotation, amount);
            const blendedLocal = glMatrix.mat4.create();
            glMatrix.mat4.fromRotationTranslation(blendedLocal, rotation, translation);
            const blendedWorld = glMatrix.mat4.create();
            if (blendedParent) glMatrix.mat4.multiply(blendedWorld, blendedParent, blendedLocal);
            else glMatrix.mat4.copy(blendedWorld, blendedLocal);
            const blendedSkin = glMatrix.mat4.create();
            glMatrix.mat4.multiply(blendedSkin, blendedWorld, bindInverse);
            out[index] = this._rows3x4FromRowMatrix(blendedSkin);
            blendedWorlds[index] = blendedWorld;
        }
        return out;
    }

    _applyWeaponFireRecoilPose(rows, combat) {
        if (!combat?.armed || !combat?.firing || !Array.isArray(rows)) return false;
        const progress = Math.max(0.0, Math.min(1.0, Number(combat.fireProgress) || 0.0));
        // `w_fire` does not expose skeletal recoil keys through CodeWalker.
        // Keep the correct GTA ADS palette intact and modify local bones, then
        // rebuild the hierarchy. Rotating independent skin matrices would tear
        // the arm chain and is the cause of the previous broken shooting pose.
        const attack = Math.max(0.0, Math.min(1.0, progress / 0.10));
        const release = Math.max(0.0, Math.min(1.0, (progress - 0.14) / 0.86));
        const recoil = attack * (1.0 - (release * release * (3.0 - 2.0 * release)));
        if (recoil <= 0.001) return false;

        const count = Math.min(rows.length, this._skinBoneBindTransforms.length, this._skinBoneBindInverseTransforms.length);
        if (!count) return false;
        const worlds = new Array(count);
        const locals = new Array(count);
        for (let index = 0; index < count; index++) {
            const skin = this._rowMatrixFromRows3x4(rows[index]);
            const bind = this._skinBoneBindTransforms[index];
            if (!skin || !bind) continue;
            const world = glMatrix.mat4.create();
            glMatrix.mat4.multiply(world, skin, bind);
            worlds[index] = world;
        }
        for (let index = 0; index < count; index++) {
            const world = worlds[index];
            if (!world) continue;
            const parent = this._skinBoneParents[index];
            const parentWorld = parent >= 0 && parent < count ? worlds[parent] : null;
            const local = glMatrix.mat4.create();
            if (parentWorld) {
                const inverseParent = glMatrix.mat4.create();
                if (!glMatrix.mat4.invert(inverseParent, parentWorld)) continue;
                glMatrix.mat4.multiply(local, inverseParent, world);
            } else {
                glMatrix.mat4.copy(local, world);
            }
            locals[index] = local;
        }
        const applyLocal = (boneName, axis, angle) => {
            const index = this._skinBoneNameToIndex.get(boneName);
            const local = Number.isInteger(index) ? locals[index] : null;
            if (!local) return;
            const amount = angle * recoil;
            if (axis === 'x') glMatrix.mat4.rotateX(local, local, amount);
            else if (axis === 'y') glMatrix.mat4.rotateY(local, local, amount);
            else glMatrix.mat4.rotateZ(local, local, amount);
        };

        applyLocal('SKEL_Spine2', 'x', -0.018);
        applyLocal('SKEL_R_Clavicle', 'z', -0.014);
        applyLocal('SKEL_R_UpperArm', 'x', -0.040);
        applyLocal('SKEL_R_Forearm', 'x', 0.030);
        applyLocal('SKEL_L_Clavicle', 'z', 0.010);
        applyLocal('SKEL_L_UpperArm', 'x', -0.024);
        applyLocal('SKEL_L_Forearm', 'x', 0.018);

        const depthByIndex = new Map();
        const depth = (index) => {
            if (depthByIndex.has(index)) return depthByIndex.get(index);
            const parent = this._skinBoneParents[index];
            const value = parent >= 0 && parent < count ? depth(parent) + 1 : 0;
            depthByIndex.set(index, value);
            return value;
        };
        const order = Array.from({ length: count }, (_, index) => index).sort((a, b) => depth(a) - depth(b));
        for (const index of order) {
            const local = locals[index];
            if (!local) continue;
            const parent = this._skinBoneParents[index];
            const parentWorld = parent >= 0 && parent < count ? worlds[parent] : null;
            const world = glMatrix.mat4.create();
            if (parentWorld) glMatrix.mat4.multiply(world, parentWorld, local);
            else glMatrix.mat4.copy(world, local);
            worlds[index] = world;
            const bindInverse = this._skinBoneBindInverseTransforms[index];
            if (!bindInverse) continue;
            const skin = glMatrix.mat4.create();
            glMatrix.mat4.multiply(skin, world, bindInverse);
            rows[index] = this._rows3x4FromRowMatrix(skin);
        }
        return true;
    }

    _selectWeaponArmsOverlays({ combat, enabled, gait }) {
        const clips = this._skinAnimationSet?.clips || null;
        if (!combat?.armed || !clips) return [];
        const layer = (name) => clips[name]?.weaponLayer ? clips[name] : null;
        const movement = !enabled ? 'idle' : (gait === 'walk' ? 'walk' : 'run');
        // The sampled `aim_med_static` palette is exported in a different root
        // reference space from `idle_2_aim_fwd_med`: using it after the ADS
        // transition moves the hands by roughly a metre. `aim_med_loop` has the
        // same terminal hand palette as the transition and is static across its
        // arm tracks, so it is the stable ADS hold pose at every movement speed.
        const aimHoldLayer = movement === 'idle'
            ? (layer('aim_walk') || layer('aim_run'))
            : (layer(`aim_${movement}`) || layer('aim_walk') || layer('aim_run'));
        let clip = null;
        let mode = 'idle';
        if (combat.phase === 'drawing') {
            clip = layer('draw');
            mode = 'oneShot';
        } else if (combat.phase === 'holstering') {
            clip = layer('holster');
            mode = 'oneShot';
        } else if (combat.reloading) {
            clip = layer(`reload_${movement}`) || layer('reload_idle');
            mode = 'oneShot';
        } else if (combat.aimTransition === 'enter') {
            clip = layer(`aim_enter_${movement}`) || layer('aim_enter_idle');
            mode = 'aimEnter';
        } else if (combat.firing) {
            clip = layer(`fire_${movement}`) || layer('fire_idle');
            mode = 'fire';
        } else if (combat.aiming) {
            clip = aimHoldLayer;
            mode = movement === 'idle' ? 'idle' : 'cycle';
        } else {
            clip = layer(`armed_${movement}`) || layer('armed_idle');
            mode = movement === 'idle' ? 'idle' : 'cycle';
        }
        if (!clip) return [];
        if (mode === 'aimEnter') {
            const holdClip = aimHoldLayer;
            const progress = Math.max(0.0, Math.min(1.0, Number(combat.aimProgress) || 0.0));
            // Blend the last part of the transition into its matching loop pose
            // so the hand attachment has no one-frame step at ADS completion.
            const blendToHold = Math.max(0.0, Math.min(1.0, (progress - 0.72) / 0.28));
            return [{
                clip,
                mode,
                crossfadeTo: holdClip ? {
                    clip: holdClip,
                    mode: movement === 'idle' ? 'idle' : 'cycle',
                    blend: blendToHold,
                } : null,
            }];
        }
        return [{ clip, mode }];
    }

    _updateSkinningPose(characterLocomotion) {
        if (!Array.isArray(this._skinBaseRows3x4) || !this._skinBaseRows3x4.length) return;
        const move01 = Math.max(0.0, Math.min(1.0, Number(characterLocomotion?.move01) || 0.0));
        const phase = Number.isFinite(Number(characterLocomotion?.phase)) ? Number(characterLocomotion.phase) : 0.0;
        const stride = Math.max(0.35, Math.min(1.35, Number(characterLocomotion?.stride) || 1.0));
        const enabled = !!characterLocomotion?.enabled && move01 > 0.005;
        const gait = String(characterLocomotion?.gait || '').trim().toLowerCase();
        const combat = characterLocomotion?.combat || null;
        const gesture = characterLocomotion?.gesture || null;
        const gestureKey = gesture?.active ? `gesture:${String(gesture.clip || '')}` : 'gesture:none';
        const combatKey = combat?.melee
            ? `melee:${String(combat.phase || '')}:${String(combat.attackType || '')}:${String(combat.clip || '')}:${Math.round((Number(combat.clipProgress) || 0.0) * 1000)}:${combat.guarding ? 1 : 0}:${combat.hurt ? 1 : 0}`
            : (combat?.armed
            ? `${Math.round((Number(combat.blend) || 0.0) * 1000)}:${combat.aiming ? 1 : 0}:${combat.firing ? 1 : 0}:${combat.reloading ? 1 : 0}:${String(combat.phase || '')}:${String(combat.aimTransition || '')}:${Math.round((Number(combat.aimProgress) || 0.0) * 1000)}`
            : 'none');
        this.characterLocomotion = { enabled, move01, phase, stride, gait, combat, gesture };

        const weaponArmsOverlays = this._selectWeaponArmsOverlays({ combat, enabled, gait }) || [];
        const meleeFullBodyClip = this.enableSampledYcdSkinning && combat?.melee
            ? this._selectSkinningAnimationClip(this.characterLocomotion, { ignoreCombat: false })
            : null;
        const ycdClip = meleeFullBodyClip || (this.enableSampledYcdSkinning
            ? this._selectSkinningAnimationClip(this.characterLocomotion, { ignoreCombat: false })
            : null);
        if (ycdClip) {
            const cycle01 = ((phase / (Math.PI * 2.0)) % 1.0 + 1.0) % 1.0;
            const idleTime = (typeof performance !== 'undefined' && performance.now)
                ? performance.now() * 0.001
                : 0.0;
            const clipProgress = Math.max(0.0, Math.min(1.0, Number(combat?.clipProgress) || 0.0));
            const aimProgress = Math.max(0.0, Math.min(1.0, Number(combat?.aimProgress) || 0.0));
            const fireProgress = Math.max(0.0, Math.min(1.0, Number(combat?.fireProgress) || 0.0));
            const compositeWeaponPose = !!combat?.armed && ycdClip.composite === true;
            let sampleTime = enabled ? (cycle01 * ycdClip.duration) : idleTime;
            if (meleeFullBodyClip) {
                sampleTime = clipProgress * meleeFullBodyClip.duration;
            } else if (compositeWeaponPose) {
                // Composite weapon clips were sampled as GTA's locomotion base
                // followed by its BothArms_filter layer. One-shot clips must
                // advance on their own controller timeline, not walk-cycle time.
                if (combat.phase === 'drawing' || combat.phase === 'holstering' || combat.reloading) {
                    sampleTime = clipProgress * ycdClip.duration;
                } else if (combat.aimTransition === 'enter') {
                    sampleTime = aimProgress * ycdClip.duration;
                } else if (combat.firing) {
                    sampleTime = fireProgress * ycdClip.duration;
                }
            }
            const sampled = this._sampleSkinningAnimationRows(ycdClip, sampleTime);
            const sampleWeaponOverlay = (overlay) => {
                let overlayTime = 0.0;
                if (overlay.mode === 'oneShot') overlayTime = clipProgress * overlay.clip.duration;
                else if (overlay.mode === 'aimEnter') overlayTime = aimProgress * overlay.clip.duration;
                else if (overlay.mode === 'fire') overlayTime = Math.max(0.0, Math.min(1.0, Number(combat?.fireProgress) || 0.0)) * overlay.clip.duration;
                else if (overlay.mode === 'cycle') overlayTime = cycle01 * overlay.clip.duration;
                else if (overlay.mode === 'idle') overlayTime = idleTime;
                const sample = this._sampleSkinningAnimationRows(overlay.clip, overlayTime);
                return sample?.rows?.length ? { ...sample, overlay } : null;
            };
            const weaponArmsSamples = weaponArmsOverlays
                .map(sampleWeaponOverlay)
                .filter((sample) => !!sample?.rows?.length);
            let rows = sampled?.rows || null;
            let appliedWeaponOverlay = false;
            if (rows?.length && weaponArmsSamples.length) {
                rows = rows.map((row) => Array.isArray(row) ? row.slice(0, 12) : row);
                const primary = weaponArmsSamples[0];
                const crossfade = primary?.overlay?.crossfadeTo;
                if (crossfade?.clip) {
                    const fromRows = rows.map((row) => Array.isArray(row) ? row.slice(0, 12) : row);
                    const appliedFrom = this._applyWeaponArmsOverlayRows(fromRows, primary.rows);
                    const targetSample = sampleWeaponOverlay(crossfade);
                    if (appliedFrom && targetSample?.rows?.length) {
                        const targetRows = rows.map((row) => Array.isArray(row) ? row.slice(0, 12) : row);
                        const appliedTarget = this._applyWeaponArmsOverlayRows(targetRows, targetSample.rows);
                        if (appliedTarget) {
                            rows = this._blendWeaponArmRows(fromRows, targetRows, crossfade.blend) || fromRows;
                            appliedWeaponOverlay = true;
                        } else {
                            rows = fromRows;
                            appliedWeaponOverlay = true;
                        }
                    } else if (appliedFrom) {
                        rows = fromRows;
                        appliedWeaponOverlay = true;
                    }
                } else {
                    for (const weaponArmsSample of weaponArmsSamples) {
                        appliedWeaponOverlay = this._applyWeaponArmsOverlayRows(rows, weaponArmsSample.rows) || appliedWeaponOverlay;
                    }
                }
            }
            if (rows?.length && !appliedWeaponOverlay && !meleeFullBodyClip && !compositeWeaponPose) {
                this._applyCombatUpperBodyPose(rows, combat);
            }
            const proceduralRecoilFallback = !compositeWeaponPose || ycdClip.requiresProceduralRecoil === true;
            if (rows?.length && proceduralRecoilFallback) this._applyWeaponFireRecoilPose(rows, combat);
            const armsKey = weaponArmsSamples.map((sample) => sample.key).join('|') || 'off';
            const key = `${sampled?.key || `ycd:${ycdClip.name}:invalid`}:arms:${armsKey}:combat:${combatKey}:${gestureKey}`;
            if (rows?.length && key !== this._lastSkinPoseKey) {
                this._skinTransforms3x4 = rows;
                this._skinPoseVersion++;
                this._lastSkinPoseKey = key;
            }
            this._weaponAnimationDiagnostics = {
                active: !!combat?.armed,
                selectedClip: ycdClip.name,
                selectedComposite: compositeWeaponPose,
                phase: String(combat?.phase || ''),
                aimTransition: String(combat?.aimTransition || ''),
                aiming: !!combat?.aiming,
                firing: !!combat?.firing,
                reloading: !!combat?.reloading,
                sampleTime: Number(sampleTime.toFixed(5)),
                clipDuration: Number(ycdClip.duration || 0),
                weaponOverlayCount: weaponArmsSamples.length,
                appliedWeaponOverlay,
                proceduralUpperBodyFallback: !!rows?.length && !appliedWeaponOverlay && !meleeFullBodyClip && !compositeWeaponPose,
                proceduralRecoilFallback: !!rows?.length && proceduralRecoilFallback && !!combat?.firing,
            };
            return;
        }

        const locomotionKey = enabled
            ? `walk:${Math.round(phase * 1000)}:${Math.round(move01 * 1000)}:${Math.round(stride * 1000)}`
            : 'rest';
        const key = `${locomotionKey}:combat:${combatKey}:${gestureKey}`;
        if (key === this._lastSkinPoseKey) return;

        const rows = this._skinBaseRows3x4.map((r) => Array.isArray(r) ? r.slice(0, 12) : null);
        if (enabled) {
            const legAmp = 0.34 * move01 * stride;
            const kneeAmp = 0.25 * move01;
            const ankleAmp = 0.12 * move01;

            const applyChain = (names, transforms) => {
                let m = this._identityRowMatrix();
                for (let i = 0; i < names.length; i++) {
                    const name = names[i];
                    const pivot = this._skinBonePivots[this._skinBoneNameToIndex.get(name)];
                    const spec = transforms[i] || transforms[transforms.length - 1] || null;
                    if (spec && pivot) {
                        m = this._mulRowMatrix(m, this._rotationAroundPivotRow(spec.axis || 'x', spec.angle || 0.0, pivot));
                    }
                    this._applySkinBoneMatrix(rows, name, m);
                }
            };

            const leftPhase = phase;
            const rightPhase = phase + Math.PI;
            const leftSwing = Math.sin(leftPhase);
            const rightSwing = Math.sin(rightPhase);
            const leftKnee = Math.max(0.0, Math.sin(leftPhase + 0.55)) * kneeAmp;
            const rightKnee = Math.max(0.0, Math.sin(rightPhase + 0.55)) * kneeAmp;

            applyChain(['SKEL_L_Thigh', 'SKEL_L_Calf', 'SKEL_L_Foot', 'SKEL_L_Toe0'], [
                { axis: 'x', angle: leftSwing * legAmp },
                { axis: 'x', angle: -leftKnee },
                { axis: 'x', angle: (leftKnee * 0.55) - (leftSwing * ankleAmp) },
                { axis: 'x', angle: 0.0 },
            ]);
            applyChain(['SKEL_R_Thigh', 'SKEL_R_Calf', 'SKEL_R_Foot', 'SKEL_R_Toe0'], [
                { axis: 'x', angle: rightSwing * legAmp },
                { axis: 'x', angle: -rightKnee },
                { axis: 'x', angle: (rightKnee * 0.55) - (rightSwing * ankleAmp) },
                { axis: 'x', angle: 0.0 },
            ]);
            applyChain(['RB_L_ThighRoll', 'MH_L_Knee', 'MH_L_CalfBack', 'MH_L_ThighBack'], [
                { axis: 'x', angle: leftSwing * legAmp },
            ]);
            applyChain(['RB_R_ThighRoll', 'MH_R_Knee', 'MH_R_CalfBack', 'MH_R_ThighBack'], [
                { axis: 'x', angle: rightSwing * legAmp },
            ]);
        }
        this._applyCombatUpperBodyPose(rows, combat);
        this._applyWeaponFireRecoilPose(rows, combat);

        this._skinTransforms3x4 = rows;
        this._skinPoseVersion++;
        this._lastSkinPoseKey = key;
        this._weaponAnimationDiagnostics = {
            active: !!combat?.armed,
            selectedClip: null,
            selectedComposite: false,
            phase: String(combat?.phase || ''),
            aimTransition: String(combat?.aimTransition || ''),
            aiming: !!combat?.aiming,
            firing: !!combat?.firing,
            reloading: !!combat?.reloading,
            sampleTime: null,
            clipDuration: null,
            weaponOverlayCount: 0,
            appliedWeaponOverlay: false,
            proceduralUpperBodyFallback: !!combat?.armed,
            proceduralRecoilFallback: !!combat?.firing,
        };
    }

    clearScene() {
        const gl = this.gl;
        for (const entry of this.instances.values()) {
            try { if (entry?.instanceBuffer) gl.deleteBuffer(entry.instanceBuffer); } catch { /* ignore */ }
            try {
                for (const sm of entry?.submeshes?.values?.() || []) {
                    if (sm?.vao) gl.deleteVertexArray(sm.vao);
                }
            } catch { /* ignore */ }
        }
        for (const bucket of this.buckets.values()) {
            try { if (bucket?.instanceBuffer) gl.deleteBuffer(bucket.instanceBuffer); } catch { /* ignore */ }
            try { if (bucket?.vao) gl.deleteVertexArray(bucket.vao); } catch { /* ignore */ }
        }
        this.instances.clear();
        this.buckets.clear();
        this._meshLoadQueue.length = 0;
        this._meshLoadPending.clear();
        this._renderStats.drawCalls = 0;
        this._renderStats.triangles = 0;
        this._renderStats.instances = 0;
        this._renderStats.bucketDraws = 0;
        this._renderStats.submeshDraws = 0;
        this._renderStats.drawItems = 0;
    }

    _packBoneTextureRows(rows3x4) {
        const rows = Array.isArray(rows3x4) ? rows3x4 : [];
        const boneCount = Math.max(1, rows.length);
        const data = new Float32Array(boneCount * 12);
        const ident = [
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
        ];
        for (let i = 0; i < boneCount; i++) {
            const r = (Array.isArray(rows[i]) && rows[i].length >= 12) ? rows[i] : ident;
            for (let j = 0; j < 12; j++) data[i * 12 + j] = Number.isFinite(Number(r[j])) ? Number(r[j]) : ident[j];
        }
        return { data, boneCount };
    }

    _createBoneTextureFromRows(rows3x4) {
        const gl = this.gl;
        const packed = this._packBoneTextureRows(rows3x4);
        let prevActive = null;
        try {
            try {
                prevActive = gl.getParameter(gl.ACTIVE_TEXTURE);
                gl.activeTexture(gl.TEXTURE0 + 16);
            } catch { /* ignore */ }
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, packed.boneCount * 3, 0, gl.RGBA, gl.FLOAT, packed.data);
            gl.bindTexture(gl.TEXTURE_2D, null);
            try { if (prevActive !== null) gl.activeTexture(prevActive); } catch { /* ignore */ }
            return t;
        } catch {
            try { gl.bindTexture(gl.TEXTURE_2D, null); } catch { /* ignore */ }
            try { if (prevActive !== null) gl.activeTexture(prevActive); } catch { /* ignore */ }
            return null;
        }
    }

    _updateBoneTextureFromRows(tex, rows3x4) {
        if (!tex) return false;
        const gl = this.gl;
        const packed = this._packBoneTextureRows(rows3x4);
        let prevActive = null;
        try {
            if (this._fastTextureUnitRestore) {
                gl.activeTexture(gl.TEXTURE0 + 16);
            } else {
                try {
                    prevActive = gl.getParameter(gl.ACTIVE_TEXTURE);
                    gl.activeTexture(gl.TEXTURE0 + 16);
                } catch { /* ignore */ }
            }
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, packed.boneCount * 3, gl.RGBA, gl.FLOAT, packed.data);
            try {
                if (this._fastTextureUnitRestore) gl.activeTexture(gl.TEXTURE0);
                else if (prevActive !== null) gl.activeTexture(prevActive);
            } catch { /* ignore */ }
            return true;
        } catch {
            try { gl.bindTexture(gl.TEXTURE_2D, null); } catch { /* ignore */ }
            try {
                if (this._fastTextureUnitRestore) gl.activeTexture(gl.TEXTURE0);
                else if (prevActive !== null) gl.activeTexture(prevActive);
            } catch { /* ignore */ }
            return false;
        }
    }

    _getBonePaletteTexture(boneIds) {
        const ids = (Array.isArray(boneIds) ? boneIds : [])
            .map((v) => Number(v) | 0)
            .filter((v) => v >= 0);
        if (!ids.length || !Array.isArray(this._skinTransforms3x4) || !this._skinTransforms3x4.length) {
            return this._identityBoneTexture;
        }
        const key = ids.join(',');
        const cached = this._skinTextureCache.get(key);
        const rows = ids.map((id) => this._skinTransforms3x4[id] || null);
        if (cached?.tex) {
            if (cached.version === this._skinPoseVersion) return cached.tex;
            if (cached.count === ids.length && this._updateBoneTextureFromRows(cached.tex, rows)) {
                cached.version = this._skinPoseVersion;
                return cached.tex;
            }
            try { this.gl.deleteTexture(cached.tex); } catch { /* ignore */ }
            this._skinTextureCache.delete(key);
        }
        const tex = this._createBoneTextureFromRows(rows);
        if (tex) this._skinTextureCache.set(key, { tex, count: ids.length, version: this._skinPoseVersion });
        return tex || this._identityBoneTexture;
    }

    hasSkinningSkeleton() {
        return Array.isArray(this._skinTransforms3x4) && this._skinTransforms3x4.length > 0;
    }

    hasSkinningAnimations() {
        return !!(this._skinAnimationSet?.clips && Object.keys(this._skinAnimationSet.clips).length);
    }

    /**
     * Return the current model-local transform for a named skinned bone.
     * This is the same sampled palette used by the vertex shader, expanded from
     * skin space back into the ped's bind space so external props can stay pinned
     * to a joint instead of following an approximate world-space location.
     */
    getSkinningBoneTransform(name, out = null) {
        const index = this._skinBoneNameToIndex?.get?.(String(name || ''));
        if (!Number.isInteger(index) || index < 0) return null;
        const skinRows = this._skinTransforms3x4?.[index];
        const bind = this._skinBoneBindTransforms?.[index];
        if (!Array.isArray(skinRows) || skinRows.length < 12 || !bind) return null;

        const skin = this._skinBoneTransformScratch;
        skin[0] = Number(skinRows[0]) || 0.0;
        skin[4] = Number(skinRows[1]) || 0.0;
        skin[8] = Number(skinRows[2]) || 0.0;
        skin[12] = Number(skinRows[3]) || 0.0;
        skin[1] = Number(skinRows[4]) || 0.0;
        skin[5] = Number(skinRows[5]) || 0.0;
        skin[9] = Number(skinRows[6]) || 0.0;
        skin[13] = Number(skinRows[7]) || 0.0;
        skin[2] = Number(skinRows[8]) || 0.0;
        skin[6] = Number(skinRows[9]) || 0.0;
        skin[10] = Number(skinRows[10]) || 0.0;
        skin[14] = Number(skinRows[11]) || 0.0;
        skin[3] = 0.0;
        skin[7] = 0.0;
        skin[11] = 0.0;
        skin[15] = 1.0;

        const target = out || glMatrix.mat4.create();
        glMatrix.mat4.multiply(target, skin, bind);
        return target;
    }

    getSkinningAnimationStatus() {
        const clips = this._skinAnimationSet?.clips || {};
        return {
            ready: this.hasSkinningAnimations(),
            clips: Object.keys(clips),
            boneCount: Number(this._skinAnimationSet?.boneCount) || 0,
        };
    }

    getWeaponAnimationDiagnostics() {
        return {
            ...(this._weaponAnimationDiagnostics || {}),
            availableCompositeClips: Object.values(this._skinAnimationSet?.clips || {})
                .filter((clip) => clip?.composite)
                .map((clip) => clip.name),
        };
    }

    _create1x1TextureRGBA8(rgba = [255, 255, 255, 255]) {
        const gl = this.gl;
        try {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            const r = rgba?.[0] ?? 255, g = rgba?.[1] ?? 255, b = rgba?.[2] ?? 255, a = rgba?.[3] ?? 255;
            const data = new Uint8Array([r & 255, g & 255, b & 255, a & 255]);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
            gl.bindTexture(gl.TEXTURE_2D, null);
            return t;
        } catch {
            try { this.gl.bindTexture(this.gl.TEXTURE_2D, null); } catch { /* ignore */ }
            return null;
        }
    }

    /**
     * Resolve an exported asset-relative path (e.g. "models_textures/123.png" or "assets/models_textures/123.png")
     * into a URL that works whether the viewer is hosted at:
     * - / (Vite dev / root hosting)
     * - /some/subdir/ (static hosting under a subpath)
     */
    _resolveAssetUrl(rel) {
        // Keep this method for non-model-texture callers; delegate to the shared resolver.
        return this._texResolver?.resolveAssetUrl?.(rel) ?? null;
    }

    /**
     * Choose the best URL for a given exported texture path.
     * - Prefer hash-only filenames for model textures (e.g. "models_textures/123.png")
     *   because many export pipelines only emit hash-only files even when the manifest
     *   references "123_slug.png".
     * - Fall back to the original path when hash-only is missing.
     * - Skip URLs we already know 404 via TextureStreamer negative cache.
     */
    _chooseTextureUrl(rel, options) {
        return this._texResolver?.chooseTextureUrl?.(rel, options) ?? null;
    }

    getRenderStats() {
        const out = { ...(this._renderStats || {}) };
        try {
            const miss = Array.from((this._texFrame?.missingFromExportedSet || new Map()).entries())
                .map(([rel, count]) => {
                    const r = String(rel || '');
                    const m = r.match(/models_textures(?:_ktx2)?\/(\d+)/i);
                    return { rel: r, hash: m ? m[1] : '', count: Number(count) | 0 };
                })
                .sort((a, b) => (b.count - a.count) || a.rel.localeCompare(b.rel))
                .slice(0, 8);
            out.diffuseMissingFromIndexTop = miss;
        } catch {
            out.diffuseMissingFromIndexTop = [];
        }
        return out;
    }

    /**
     * Frame-level texture diagnostic report.
     * Returns what the renderer actually tried to use during the last render() call.
     */
    getTextureFrameReport(limit = 50) {
        const lim = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Math.floor(Number(limit)))) : 50;
        try {
            const miss = Array.from((this._texFrame?.missingFromExportedSet || new Map()).entries())
                .map(([rel, count]) => ({ rel: String(rel || ''), count: Number(count) | 0 }))
                .sort((a, b) => (b.count - a.count) || a.rel.localeCompare(b.rel))
                .slice(0, lim);
            const ph = Array.from((this._texFrame?.placeholderUrls || new Map()).entries())
                .map(([url, count]) => ({ url: String(url || ''), count: Number(count) | 0 }))
                .sort((a, b) => (b.count - a.count) || a.url.localeCompare(b.url))
                .slice(0, lim);
            return {
                schema: 'webglgta-texture-frame-report-v1',
                limit: lim,
                missingFromExportedSet: miss,
                placeholderUrls: ph,
            };
        } catch {
            return { schema: 'webglgta-texture-frame-report-v1', limit: lim, missingFromExportedSet: [], placeholderUrls: [] };
        }
    }

    pickAssetAtScreen({ x, y, viewportWidth, viewportHeight, viewProjectionMatrix, maxPixelDistance = 28, nearbyLimit = 8 } = {}) {
        const sx = Number(x);
        const sy = Number(y);
        const vw = Number(viewportWidth);
        const vh = Number(viewportHeight);
        if (!Number.isFinite(sx) || !Number.isFinite(sy) || !(vw > 0) || !(vh > 0)) return null;
        if (!viewProjectionMatrix || viewProjectionMatrix.length < 16) return null;

        const maxPx = Number.isFinite(Number(maxPixelDistance)) ? Math.max(2, Math.min(96, Number(maxPixelDistance))) : 28;
        const ray = this._makePickRay(sx, sy, vw, vh, viewProjectionMatrix);
        const hits = [];
        const items = Array.isArray(this._lastPickDrawItems) ? this._lastPickDrawItems : [];
        for (const item of items) {
            if (!item || !item.mesh) continue;
            const data = item.instanceData;
            const stride = Math.max(16, Math.floor(Number(item.instanceStrideFloats) || 16));
            const count = Math.min(
                Math.max(0, Math.floor(Number(item.instanceCount) || 0)),
                data && data.length ? Math.floor(data.length / stride) : 0,
            );
            if (!data || count <= 0) continue;
            for (let idx = 0; idx < count; idx++) {
                const off = idx * stride;
                const rayHit = ray ? this._rayIntersectInstanceBounds(item, data, off, ray) : null;
                if (!rayHit) continue;
                const meshHit = this._rayIntersectInstanceMesh(item, data, off, ray);
                const hit = meshHit || rayHit;
                const proj = this._projectInstanceScreenBounds(item, data, off, viewProjectionMatrix, vw, vh);
                if (!proj) continue;
                hits.push({
                    item,
                    instanceIndex: idx,
                    instanceOffset: off,
                    distPx: 0,
                    score: hit.tViewer,
                    projection: proj,
                    rayHit: hit,
                    pickMethod: meshHit ? 'rayMesh' : 'rayAabb',
                });
            }
        }

        // Fallback for malformed/missing bounds only. Do not let huge projected
        // ground/curb rectangles steal clicks from smaller assets.
        if (hits.length === 0) {
            const viewportArea = Math.max(1, vw * vh);
            for (const item of items) {
                if (!item || !item.mesh) continue;
                const data = item.instanceData;
                const stride = Math.max(16, Math.floor(Number(item.instanceStrideFloats) || 16));
                const count = Math.min(
                    Math.max(0, Math.floor(Number(item.instanceCount) || 0)),
                    data && data.length ? Math.floor(data.length / stride) : 0,
                );
                if (!data || count <= 0) continue;
                for (let idx = 0; idx < count; idx++) {
                    const off = idx * stride;
                    const proj = this._projectInstanceScreenBounds(item, data, off, viewProjectionMatrix, vw, vh);
                    if (!proj) continue;
                    const distPx = this._distanceToRect(sx, sy, proj.rect);
                    if (distPx > maxPx) continue;
                    const rw = Math.max(0, Math.min(vw, proj.rect.maxX) - Math.max(0, proj.rect.minX));
                    const rh = Math.max(0, Math.min(vh, proj.rect.maxY) - Math.max(0, proj.rect.minY));
                    const coverage = (rw * rh) / viewportArea;
                    if (coverage > 0.45 && distPx <= 1.0) continue;
                    const score = distPx + Math.max(0, proj.depth01 || 0) * 0.001 + coverage * 12.0;
                    hits.push({
                        item,
                        instanceIndex: idx,
                        instanceOffset: off,
                        distPx,
                        score,
                        projection: proj,
                        rayHit: null,
                        pickMethod: 'screenRectFallback',
                        screenCoverage: coverage,
                    });
                }
            }
        }

        hits.sort((a, b) => {
            const methodRank = (method) => {
                if (method === 'rayMesh') return 0;
                if (method === 'rayAabb') return 1;
                return 2;
            };
            const am = methodRank(a.pickMethod);
            const bm = methodRank(b.pickMethod);
            if (am !== bm) return am - bm;
            if (am <= 1 && bm <= 1) {
                const at = Number(a.rayHit?.tViewer);
                const bt = Number(b.rayHit?.tViewer);
                if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
            }
            if (a.distPx !== b.distPx) return a.distPx - b.distPx;
            const ac = Number(a.screenCoverage);
            const bc = Number(b.screenCoverage);
            if (Number.isFinite(ac) && Number.isFinite(bc) && ac !== bc) return ac - bc;
            const ad = Number(a.projection?.depth01);
            const bd = Number(b.projection?.depth01);
            if (Number.isFinite(ad) && Number.isFinite(bd) && ad !== bd) return ad - bd;
            return (a.item?.seq ?? 0) - (b.item?.seq ?? 0);
        });

        const lim = Number.isFinite(Number(nearbyLimit)) ? Math.max(1, Math.min(24, Math.floor(Number(nearbyLimit)))) : 8;
        const selectedHit = hits[0] || null;
        const report = {
            schema: 'webglgta-demo-asset-pick-v1',
            timeIso: (() => { try { return new Date().toISOString(); } catch { return null; } })(),
            click: {
                x: sx,
                y: sy,
                viewportWidth: vw,
                viewportHeight: vh,
                maxPixelDistance: maxPx,
                ray: ray ? {
                    originViewer: this._jsonSafe(ray.origin),
                    dirViewer: this._jsonSafe(ray.dir),
                } : null,
            },
            selected: selectedHit ? this._buildPickRecord(selectedHit, { full: true }) : null,
            nearby: hits.slice(0, lim).map((h) => this._buildPickRecord(h, { full: false })),
            rendererStats: (() => { try { return this.getRenderStats(); } catch { return null; } })(),
            textureFrame: (() => { try { return this.getTextureFrameReport(25); } catch { return null; } })(),
        };
        this._lastPickReport = report;
        return report;
    }

    getLastPickReport() {
        return this._lastPickReport || null;
    }

    _makePickRay(x, y, viewportWidth, viewportHeight, viewProjectionMatrix) {
        const invVp = this._pickTmpInvVp;
        if (!glMatrix.mat4.invert(invVp, viewProjectionMatrix)) return null;
        const ndcX = (Number(x) / Number(viewportWidth)) * 2.0 - 1.0;
        const ndcY = 1.0 - (Number(y) / Number(viewportHeight)) * 2.0;
        const near = this._pickTmpNear;
        const far = this._pickTmpFar;
        near[0] = ndcX; near[1] = ndcY; near[2] = -1.0; near[3] = 1.0;
        far[0] = ndcX; far[1] = ndcY; far[2] = 1.0; far[3] = 1.0;
        glMatrix.vec4.transformMat4(near, near, invVp);
        glMatrix.vec4.transformMat4(far, far, invVp);
        if (Math.abs(near[3]) < 1e-8 || Math.abs(far[3]) < 1e-8) return null;
        near[0] /= near[3]; near[1] /= near[3]; near[2] /= near[3]; near[3] = 1.0;
        far[0] /= far[3]; far[1] /= far[3]; far[2] /= far[3]; far[3] = 1.0;
        const dx = far[0] - near[0];
        const dy = far[1] - near[1];
        const dz = far[2] - near[2];
        const len = Math.hypot(dx, dy, dz);
        if (!Number.isFinite(len) || len < 1e-8) return null;
        return {
            origin: [near[0], near[1], near[2]],
            dir: [dx / len, dy / len, dz / len],
            ndc: [ndcX, ndcY],
        };
    }

    _instanceMatrixFromData(data, off, out) {
        if (!data || !out) return null;
        for (let i = 0; i < 16; i++) out[i] = Number(data[off + i]) || 0.0;
        return out;
    }

    _rayIntersectInstanceBounds(item, data, off, ray) {
        const meshBounds = item?.mesh?.bounds || null;
        const min0 = Array.isArray(meshBounds?.min) ? meshBounds.min : null;
        const max0 = Array.isArray(meshBounds?.max) ? meshBounds.max : null;
        if (!min0 || !max0 || min0.length < 3 || max0.length < 3) return null;

        const inst = this._instanceMatrixFromData(data, off, this._pickTmpInst);
        if (!inst) return null;
        const localToViewer = this._pickTmpLocalToViewer;
        glMatrix.mat4.multiply(localToViewer, this.modelMatrix, inst);
        const invLocalToViewer = this._pickTmpInvLocalToViewer;
        if (!glMatrix.mat4.invert(invLocalToViewer, localToViewer)) return null;

        const ro4 = this._pickTmpRayOrigin4;
        ro4[0] = ray.origin[0]; ro4[1] = ray.origin[1]; ro4[2] = ray.origin[2]; ro4[3] = 1.0;
        const rd4 = this._pickTmpRayDir4;
        rd4[0] = ray.dir[0]; rd4[1] = ray.dir[1]; rd4[2] = ray.dir[2]; rd4[3] = 0.0;
        const localOrigin = this._pickTmpLocalOrigin;
        const localDir = this._pickTmpLocalDir;
        glMatrix.vec4.transformMat4(localOrigin, ro4, invLocalToViewer);
        glMatrix.vec4.transformMat4(localDir, rd4, invLocalToViewer);
        const tLocal = this._rayIntersectLocalAabb(localOrigin, localDir, min0, max0);
        if (tLocal === null) return null;

        const localHit = this._pickTmpLocalHit;
        localHit[0] = localOrigin[0] + localDir[0] * tLocal;
        localHit[1] = localOrigin[1] + localDir[1] * tLocal;
        localHit[2] = localOrigin[2] + localDir[2] * tLocal;
        localHit[3] = 1.0;
        glMatrix.vec4.transformMat4(this._pickTmpWorld, localHit, localToViewer);
        const vx = this._pickTmpWorld[0];
        const vy = this._pickTmpWorld[1];
        const vz = this._pickTmpWorld[2];
        const tViewer =
            (vx - ray.origin[0]) * ray.dir[0] +
            (vy - ray.origin[1]) * ray.dir[1] +
            (vz - ray.origin[2]) * ray.dir[2];
        if (!Number.isFinite(tViewer) || tViewer < 0) return null;

        return {
            tLocal,
            tViewer,
            localHit: [localHit[0], localHit[1], localHit[2]],
            dataHit: this._transformInstanceLocalToData(data, off, localHit),
            viewerHit: [vx, vy, vz],
            bounds: {
                min: [Number(min0[0]) || 0, Number(min0[1]) || 0, Number(min0[2]) || 0],
                max: [Number(max0[0]) || 0, Number(max0[1]) || 0, Number(max0[2]) || 0],
            },
        };
    }

    _rayIntersectInstanceMesh(item, data, off, ray) {
        const mesh = item?.mesh || null;
        const positions = mesh?.pickPositions || null;
        const indices = mesh?.pickIndices || null;
        if (!positions || !indices || positions.length < 9 || indices.length < 3) return null;

        const inst = this._instanceMatrixFromData(data, off, this._pickTmpInst);
        if (!inst) return null;
        const localToViewer = this._pickTmpLocalToViewer;
        glMatrix.mat4.multiply(localToViewer, this.modelMatrix, inst);
        const invLocalToViewer = this._pickTmpInvLocalToViewer;
        if (!glMatrix.mat4.invert(invLocalToViewer, localToViewer)) return null;

        const ro4 = this._pickTmpRayOrigin4;
        ro4[0] = ray.origin[0]; ro4[1] = ray.origin[1]; ro4[2] = ray.origin[2]; ro4[3] = 1.0;
        const rd4 = this._pickTmpRayDir4;
        rd4[0] = ray.dir[0]; rd4[1] = ray.dir[1]; rd4[2] = ray.dir[2]; rd4[3] = 0.0;
        const localOrigin = this._pickTmpLocalOrigin;
        const localDir = this._pickTmpLocalDir;
        glMatrix.vec4.transformMat4(localOrigin, ro4, invLocalToViewer);
        glMatrix.vec4.transformMat4(localDir, rd4, invLocalToViewer);

        let bestT = Number.POSITIVE_INFINITY;
        let bestTri = -1;
        let bestU = 0;
        let bestV = 0;
        const triCount = Math.min(Math.floor(indices.length / 3), 100000);
        const eps = 1e-8;
        const ox = Number(localOrigin[0]);
        const oy = Number(localOrigin[1]);
        const oz = Number(localOrigin[2]);
        const dx = Number(localDir[0]);
        const dy = Number(localDir[1]);
        const dz = Number(localDir[2]);
        if (![ox, oy, oz, dx, dy, dz].every(Number.isFinite)) return null;

        for (let tri = 0; tri < triCount; tri++) {
            const ii = tri * 3;
            const i0 = Math.floor(Number(indices[ii + 0]) || 0) * 3;
            const i1 = Math.floor(Number(indices[ii + 1]) || 0) * 3;
            const i2 = Math.floor(Number(indices[ii + 2]) || 0) * 3;
            if (i0 < 0 || i1 < 0 || i2 < 0 || i0 + 2 >= positions.length || i1 + 2 >= positions.length || i2 + 2 >= positions.length) continue;

            const v0x = positions[i0 + 0], v0y = positions[i0 + 1], v0z = positions[i0 + 2];
            const e1x = positions[i1 + 0] - v0x;
            const e1y = positions[i1 + 1] - v0y;
            const e1z = positions[i1 + 2] - v0z;
            const e2x = positions[i2 + 0] - v0x;
            const e2y = positions[i2 + 1] - v0y;
            const e2z = positions[i2 + 2] - v0z;

            const px = dy * e2z - dz * e2y;
            const py = dz * e2x - dx * e2z;
            const pz = dx * e2y - dy * e2x;
            const det = e1x * px + e1y * py + e1z * pz;
            if (Math.abs(det) < eps) continue;
            const invDet = 1.0 / det;

            const tx = ox - v0x;
            const ty = oy - v0y;
            const tz = oz - v0z;
            const u = (tx * px + ty * py + tz * pz) * invDet;
            if (u < -1e-5 || u > 1.00001) continue;

            const qx = ty * e1z - tz * e1y;
            const qy = tz * e1x - tx * e1z;
            const qz = tx * e1y - ty * e1x;
            const v = (dx * qx + dy * qy + dz * qz) * invDet;
            if (v < -1e-5 || (u + v) > 1.00001) continue;

            const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
            if (t < 0 || t >= bestT) continue;
            bestT = t;
            bestTri = tri;
            bestU = u;
            bestV = v;
        }

        if (!Number.isFinite(bestT) || bestTri < 0) return null;
        const localHit = this._pickTmpLocalHit;
        localHit[0] = ox + dx * bestT;
        localHit[1] = oy + dy * bestT;
        localHit[2] = oz + dz * bestT;
        localHit[3] = 1.0;
        glMatrix.vec4.transformMat4(this._pickTmpWorld, localHit, localToViewer);
        const vx = this._pickTmpWorld[0];
        const vy = this._pickTmpWorld[1];
        const vz = this._pickTmpWorld[2];
        const tViewer =
            (vx - ray.origin[0]) * ray.dir[0] +
            (vy - ray.origin[1]) * ray.dir[1] +
            (vz - ray.origin[2]) * ray.dir[2];
        if (!Number.isFinite(tViewer) || tViewer < 0) return null;

        return {
            tLocal: bestT,
            tViewer,
            localHit: [localHit[0], localHit[1], localHit[2]],
            dataHit: this._transformInstanceLocalToData(data, off, localHit),
            viewerHit: [vx, vy, vz],
            triangleIndex: bestTri,
            barycentric: [1.0 - bestU - bestV, bestU, bestV],
        };
    }

    _rayIntersectLocalAabb(origin4, dir4, min0, max0) {
        let tMin = Number.NEGATIVE_INFINITY;
        let tMax = Number.POSITIVE_INFINITY;
        for (let axis = 0; axis < 3; axis++) {
            const o = Number(origin4[axis]);
            const d = Number(dir4[axis]);
            const rawMin = Number(min0[axis]);
            const rawMax = Number(max0[axis]);
            if (!Number.isFinite(o) || !Number.isFinite(d) || !Number.isFinite(rawMin) || !Number.isFinite(rawMax)) return null;
            const mn = Math.min(rawMin, rawMax) - 0.02;
            const mx = Math.max(rawMin, rawMax) + 0.02;
            if (Math.abs(d) < 1e-9) {
                if (o < mn || o > mx) return null;
                continue;
            }
            let t1 = (mn - o) / d;
            let t2 = (mx - o) / d;
            if (t1 > t2) {
                const tmp = t1;
                t1 = t2;
                t2 = tmp;
            }
            if (t1 > tMin) tMin = t1;
            if (t2 < tMax) tMax = t2;
            if (tMin > tMax) return null;
        }
        if (tMax < 0) return null;
        const t = tMin >= 0 ? tMin : tMax;
        return Number.isFinite(t) ? t : null;
    }

    _projectInstanceScreenBounds(item, data, off, viewProjectionMatrix, viewportWidth, viewportHeight) {
        const meshBounds = item?.mesh?.bounds || null;
        const min = Array.isArray(meshBounds?.min) ? meshBounds.min : null;
        const max = Array.isArray(meshBounds?.max) ? meshBounds.max : null;
        const center = Array.isArray(meshBounds?.center) ? meshBounds.center : [0, 0, 0];
        const radius = Number(item?.mesh?.radius ?? item?.gpuCullRadius ?? 1.0);
        const corners = [];
        if (min && max && min.length >= 3 && max.length >= 3) {
            for (let ix = 0; ix < 2; ix++) {
                for (let iy = 0; iy < 2; iy++) {
                    for (let iz = 0; iz < 2; iz++) {
                        corners.push([
                            ix ? Number(max[0]) : Number(min[0]),
                            iy ? Number(max[1]) : Number(min[1]),
                            iz ? Number(max[2]) : Number(min[2]),
                        ]);
                    }
                }
            }
        } else {
            const c = center || [0, 0, 0];
            const r = Number.isFinite(radius) ? Math.max(0.5, radius) : 1.0;
            corners.push(
                [c[0] - r, c[1], c[2]],
                [c[0] + r, c[1], c[2]],
                [c[0], c[1] - r, c[2]],
                [c[0], c[1] + r, c[2]],
                [c[0], c[1], c[2] - r],
                [c[0], c[1], c[2] + r],
            );
        }

        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        let minDepth = Number.POSITIVE_INFINITY;
        let projected = 0;
        for (const p of corners) {
            const s = this._projectInstanceLocalPoint(data, off, p, viewProjectionMatrix, viewportWidth, viewportHeight);
            if (!s) continue;
            projected++;
            minX = Math.min(minX, s.x);
            minY = Math.min(minY, s.y);
            maxX = Math.max(maxX, s.x);
            maxY = Math.max(maxY, s.y);
            minDepth = Math.min(minDepth, s.depth01);
        }

        const centerScreen = this._projectInstanceLocalPoint(data, off, center, viewProjectionMatrix, viewportWidth, viewportHeight);
        if (!centerScreen && projected <= 0) return null;
        if (projected <= 0 && centerScreen) {
            const r = Math.max(8, Math.min(48, Number(radius) || 8));
            minX = centerScreen.x - r;
            maxX = centerScreen.x + r;
            minY = centerScreen.y - r;
            maxY = centerScreen.y + r;
            minDepth = centerScreen.depth01;
        }
        if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;

        const pad = 4.0;
        return {
            rect: {
                minX: Math.max(-viewportWidth, minX - pad),
                minY: Math.max(-viewportHeight, minY - pad),
                maxX: Math.min(viewportWidth * 2, maxX + pad),
                maxY: Math.min(viewportHeight * 2, maxY + pad),
            },
            centerScreen: centerScreen ? { x: centerScreen.x, y: centerScreen.y, depth01: centerScreen.depth01 } : null,
            centerData: this._transformInstanceLocalToData(data, off, center),
            centerViewer: centerScreen?.viewer || null,
            depth01: Number.isFinite(minDepth) ? minDepth : (centerScreen?.depth01 ?? 1.0),
        };
    }
    _transformInstanceLocalToData(data, off, local) {
        const x = Number(local?.[0]) || 0.0;
        const y = Number(local?.[1]) || 0.0;
        const z = Number(local?.[2]) || 0.0;
        return [
            (Number(data[off + 0]) || 0) * x + (Number(data[off + 4]) || 0) * y + (Number(data[off + 8]) || 0) * z + (Number(data[off + 12]) || 0),
            (Number(data[off + 1]) || 0) * x + (Number(data[off + 5]) || 0) * y + (Number(data[off + 9]) || 0) * z + (Number(data[off + 13]) || 0),
            (Number(data[off + 2]) || 0) * x + (Number(data[off + 6]) || 0) * y + (Number(data[off + 10]) || 0) * z + (Number(data[off + 14]) || 0),
        ];
    }

    _projectInstanceLocalPoint(data, off, local, viewProjectionMatrix, viewportWidth, viewportHeight) {
        const dataPos = this._transformInstanceLocalToData(data, off, local);
        const dataV = this._pickTmpData;
        dataV[0] = dataPos[0];
        dataV[1] = dataPos[1];
        dataV[2] = dataPos[2];
        dataV[3] = 1.0;
        glMatrix.vec4.transformMat4(this._pickTmpWorld, dataV, this.modelMatrix);
        glMatrix.vec4.transformMat4(this._pickTmpClip, this._pickTmpWorld, viewProjectionMatrix);
        const w = Number(this._pickTmpClip[3]);
        if (!Number.isFinite(w) || Math.abs(w) < 1e-6) return null;
        const ndcX = this._pickTmpClip[0] / w;
        const ndcY = this._pickTmpClip[1] / w;
        const ndcZ = this._pickTmpClip[2] / w;
        if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY) || !Number.isFinite(ndcZ)) return null;
        if (ndcZ < -1.25 || ndcZ > 1.25) return null;
        return {
            x: (ndcX * 0.5 + 0.5) * viewportWidth,
            y: (1.0 - (ndcY * 0.5 + 0.5)) * viewportHeight,
            depth01: ndcZ * 0.5 + 0.5,
            data: dataPos,
            viewer: [this._pickTmpWorld[0], this._pickTmpWorld[1], this._pickTmpWorld[2]],
        };
    }

    _distanceToRect(x, y, rect) {
        if (!rect) return Number.POSITIVE_INFINITY;
        const dx = x < rect.minX ? (rect.minX - x) : (x > rect.maxX ? (x - rect.maxX) : 0);
        const dy = y < rect.minY ? (rect.minY - y) : (y > rect.maxY ? (y - rect.maxY) : 0);
        return Math.sqrt(dx * dx + dy * dy);
    }

    _buildPickRecord(hit, { full = false } = {}) {
        const item = hit?.item || {};
        const data = item.instanceData;
        const off = Math.max(0, Math.floor(Number(hit?.instanceOffset) || 0));
        const stride = Math.max(16, Math.floor(Number(item.instanceStrideFloats) || 16));
        const dataPosition = data ? [
            this._roundDebugNumber(data[off + 12]),
            this._roundDebugNumber(data[off + 13]),
            this._roundDebugNumber(data[off + 14]),
        ] : null;
        const maxScale = data ? this._roundDebugNumber(this._instanceMaxScaleFromData(data, off)) : null;
        const textureDistance = Number.isFinite(Number(item.dist)) ? Number(item.dist) : 0;
        const textures = {
            diffuse: this._textureDebugInfo(item.diffuseRel, item.diffuseKind || 'diffuse', textureDistance),
            diffuse2: this._textureDebugInfo(item.diffuse2Rel, 'diffuse2', textureDistance),
            normal: this._textureDebugInfo(item.normalRel, 'normal', textureDistance),
            spec: this._textureDebugInfo(item.specRel, (item.shaderFamilyInt === 6) ? 'diffuse' : 'spec', textureDistance),
            detail: this._textureDebugInfo(item.detailRel, 'detail', textureDistance),
            tintPalette: this._textureDebugInfo(item.tintPaletteRel, 'tintPalette', textureDistance),
            alphaMask: this._textureDebugInfo(item.alphaMaskRel, 'alphaMask', textureDistance),
            env: this._textureDebugInfo(item.envRel, (item.shaderFamilyInt === 6) ? 'diffuse' : 'env', textureDistance),
            dirt: this._textureDebugInfo(item.dirtRel, 'dirt', textureDistance),
            damage: this._textureDebugInfo(item.damageRel, 'damage', textureDistance),
            damageMask: this._textureDebugInfo(item.damageMaskRel, 'damageMask', textureDistance),
            puddleMask: this._textureDebugInfo(item.puddleMaskRel, 'puddleMask', textureDistance),
            emissive: this._textureDebugInfo(item.emissiveRel, 'emissive', textureDistance),
            ao: this._textureDebugInfo(item.aoRel, 'ao', textureDistance),
            height: this._textureDebugInfo(item.heightRel, 'height', textureDistance),
        };
        const manifestEntry = item.hash ? (this.modelManager?.manifest?.meshes?.[String(item.hash)] || null) : null;
        const projection = hit?.projection || null;
        const rayHit = hit?.rayHit || null;
        const base = {
            pick: {
                method: hit?.pickMethod || null,
                distancePx: this._roundDebugNumber(hit?.distPx),
                score: this._roundDebugNumber(hit?.score),
                screenCoverage: this._roundDebugNumber(hit?.screenCoverage),
                screenRect: this._jsonSafe(projection?.rect),
                centerScreen: this._jsonSafe(projection?.centerScreen),
                depth01: this._roundDebugNumber(projection?.depth01),
                rayTViewer: this._roundDebugNumber(rayHit?.tViewer),
                rayTLocal: this._roundDebugNumber(rayHit?.tLocal),
                rayLocalHit: this._jsonSafe(rayHit?.localHit),
                rayDataHit: this._jsonSafe(rayHit?.dataHit),
                rayViewerHit: this._jsonSafe(rayHit?.viewerHit),
                triangleIndex: Number.isFinite(Number(rayHit?.triangleIndex)) ? Math.floor(Number(rayHit.triangleIndex)) : null,
                barycentric: this._jsonSafe(rayHit?.barycentric),
            },
            identity: {
                kind: item.kind || null,
                hash: item.hash || null,
                lod: item.lod || null,
                file: item.file || item.meshKey || null,
                bucketId: item.bucketId || null,
                materialSig: item.materialSig || null,
                seq: Number.isFinite(Number(item.seq)) ? Number(item.seq) : null,
            },
            instance: {
                index: Number.isFinite(Number(hit?.instanceIndex)) ? Math.floor(Number(hit.instanceIndex)) : null,
                count: Number.isFinite(Number(item.instanceCount)) ? Math.floor(Number(item.instanceCount)) : null,
                strideFloats: stride,
                dataPosition,
                centerData: this._jsonSafe(projection?.centerData),
                centerViewer: this._jsonSafe(projection?.centerViewer),
                maxScale,
                tintIndex: stride >= 17 && data ? this._roundDebugNumber(data[off + 16]) : null,
                guid: stride >= 21 && data ? (Number(data[off + 17]) >>> 0) : null,
                mloParentGuid: stride >= 21 && data ? (Number(data[off + 18]) >>> 0) : null,
                mloEntitySetHash: stride >= 21 && data ? (Number(data[off + 19]) >>> 0) : null,
                mloFlags: stride >= 21 && data ? (Number(data[off + 20]) >>> 0) : null,
                ymapHash: stride >= 22 && data ? (Number(data[off + 21]) >>> 0) : null,
            },
            mesh: {
                key: item.meshKey || item.file || null,
                vertexCount: Number.isFinite(Number(item.mesh?.vertexCount)) ? Math.floor(Number(item.mesh.vertexCount)) : null,
                indexCount: Number.isFinite(Number(item.mesh?.indexCount)) ? Math.floor(Number(item.mesh.indexCount)) : null,
                radius: this._roundDebugNumber(item.mesh?.radius),
                bounds: this._jsonSafe(item.mesh?.bounds),
                hasUv0: !!item.mesh?.uvBuffer,
                hasUv1: !!item.meshHasUv1,
                hasColor0: !!item.meshHasColor0,
                hasTangents: !!item.meshHasTangents,
                skinned: !!item.skinned,
            },
            material: {
                shaderName: item.shaderName || null,
                shaderFamily: item.shaderFamily || null,
                renderBucket: Number.isFinite(Number(item.renderBucket)) ? Number(item.renderBucket) : null,
                alphaModeInt: Number.isFinite(Number(item.alphaModeInt)) ? Number(item.alphaModeInt) : null,
                doubleSided: !!item.doubleSided,
                doubleSidedLighting: !!item.doubleSidedLighting,
                alphaToCoverage: !!item.alphaToCoverage,
                baseColor: this._jsonSafe(item.baseColor),
                vertexColorMode: Number.isFinite(Number(item.vertexColorMode)) ? Number(item.vertexColorMode) : 0,
                tintMode: Number.isFinite(Number(item.tintMode)) ? Number(item.tintMode) : null,
                uv0ScaleOffset: this._jsonSafe(item.uvso),
                uv1ScaleOffset: this._jsonSafe(item.uvso1),
                uv2ScaleOffset: this._jsonSafe(item.uvso2),
            },
            textures,
            culling: {
                dist: this._roundDebugNumber(item.dist),
                sortDist: this._roundDebugNumber(item.sortDist),
                instBounds: this._jsonSafe(item.instBounds),
                gpuCullRadius: this._roundDebugNumber(item.gpuCullRadius),
            },
        };
        if (full) {
            base.archetype = {
                lodDistances: this._jsonSafe(manifestEntry?.lodDistances),
                bounds: this._jsonSafe(manifestEntry?.bounds),
                radius: this._roundDebugNumber(manifestEntry?.radius),
                material: this._jsonSafe(manifestEntry?.material),
            };
            base.material.raw = {
                entry: this._jsonSafe(item.entryMaterial),
                submesh: this._jsonSafe(item.submeshMaterial),
                effective: this._jsonSafe(item.effectiveMaterial),
            };
            base.renderItem = {
                diffuseUvSet: Number.isFinite(Number(item.diffuseUvSet)) ? Number(item.diffuseUvSet) : null,
                normalUvSet: Number.isFinite(Number(item.normalUvSet)) ? Number(item.normalUvSet) : null,
                specUvSet: Number.isFinite(Number(item.specUvSet)) ? Number(item.specUvSet) : null,
                detailUvSet: Number.isFinite(Number(item.detailUvSet)) ? Number(item.detailUvSet) : null,
                aoUvSet: Number.isFinite(Number(item.aoUvSet)) ? Number(item.aoUvSet) : null,
                vertexColorMode: Number.isFinite(Number(item.vertexColorMode)) ? Number(item.vertexColorMode) : 0,
                alphaCutoff: this._roundDebugNumber(item.alphaCutoff),
                alphaScale: this._roundDebugNumber(item.alphaScale),
                doubleSidedLighting: !!item.doubleSidedLighting,
                bumpiness: this._roundDebugNumber(item.bumpiness),
                specIntensity: this._roundDebugNumber(item.specIntensity),
                specPower: this._roundDebugNumber(item.specPower),
                specFalloffMult: this._roundDebugNumber(item.specFalloffMult),
                wetness: this._roundDebugNumber(item.wetness),
                decalTint: this._jsonSafe(item.decalTint),
                dirtColor: this._jsonSafe(item.dirtColor),
                ambientDecalMask: this._jsonSafe(item.ambientDecalMask),
                dirtDecalMask: this._jsonSafe(item.dirtDecalMask),
                specMaskWeights: this._jsonSafe(item.specMaskWeights),
                detailSettings: this._jsonSafe(item.detailSettings),
            };
        }
        return base;
    }

    _textureDebugInfo(rel, kind = 'diffuse', distance = 0) {
        const rawRel = (typeof rel === 'string' && rel) ? rel : null;
        if (!rawRel) return { rel: null, kind, state: 'none' };
        const url = this._chooseTextureUrl(rawRel);
        const out = {
            rel: rawRel,
            kind,
            resolvedUrl: url || null,
            state: url ? 'notResident' : 'indexMissingOrPending',
            missingFromIndex: !url,
            missing404: false,
            rejected: false,
            desiredTier: null,
            residentTier: null,
            loadingTier: null,
            tiers: [],
        };
        const ts = this.textureStreamer;
        if (!url || !ts) return out;
        try {
            out.missing404 = !!ts.isMissing?.(url);
            if (out.missing404) out.state = 'missing404';
            out.rejected = !!ts.isRejected?.(url);
            if (out.rejected) out.state = 'rejected';
            const desired = (typeof ts._clampTierToAllowed === 'function' && typeof ts._tierForDistance === 'function')
                ? ts._clampTierToAllowed(ts._tierForDistance(distance, kind))
                : String(ts.quality || 'high');
            out.desiredTier = desired;
            const order = desired === 'high' ? ['high', 'medium', 'low'] : (desired === 'medium' ? ['medium', 'low'] : ['low']);
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            for (const tier of order) {
                const key = (typeof ts._cacheKey === 'function') ? ts._cacheKey(url, tier, kind) : `${tier}|${url}`;
                const e = ts.cache?.get?.(key);
                const row = {
                    tier,
                    cacheKey: key,
                    state: e?.tex ? 'resident' : (e?.loading ? 'loading' : 'absent'),
                    bytes: Number.isFinite(Number(e?.bytes)) ? Math.floor(Number(e.bytes)) : 0,
                    uploadedAsSrgb: !!e?.uploadedAsSrgb,
                    needsUvFlipY: !!e?.needsUvFlipY,
                    lastUseAgeMs: Number.isFinite(Number(e?.lastUse)) ? Math.max(0, Math.floor(now - Number(e.lastUse))) : null,
                };
                if (row.state === 'resident' && !out.residentTier) out.residentTier = tier;
                if (row.state === 'loading' && !out.loadingTier) out.loadingTier = tier;
                out.tiers.push(row);
            }
            if (out.residentTier) out.state = 'resident';
            else if (out.loadingTier && !out.missing404) out.state = 'loading';
        } catch {
            out.state = out.state || 'unknown';
        }
        return out;
    }

    _instanceMaxScaleFromData(data, off) {
        const sx = Math.hypot(Number(data[off + 0]) || 0, Number(data[off + 1]) || 0, Number(data[off + 2]) || 0);
        const sy = Math.hypot(Number(data[off + 4]) || 0, Number(data[off + 5]) || 0, Number(data[off + 6]) || 0);
        const sz = Math.hypot(Number(data[off + 8]) || 0, Number(data[off + 9]) || 0, Number(data[off + 10]) || 0);
        const s = Math.max(sx, sy, sz);
        return Number.isFinite(s) && s > 0 ? s : 1.0;
    }

    _roundDebugNumber(v) {
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        return Math.round(n * 100000) / 100000;
    }

    _jsonSafe(value, depth = 0, seen = null) {
        if (value === null || value === undefined) return null;
        const t = typeof value;
        if (t === 'string' || t === 'boolean') return value;
        if (t === 'number') return Number.isFinite(value) ? this._roundDebugNumber(value) : null;
        if (t !== 'object') return String(value);
        const localSeen = seen || new WeakSet();
        if (localSeen.has(value)) return '[Circular]';
        if (depth >= 7) return '[MaxDepth]';
        if (ArrayBuffer.isView(value)) {
            return Array.from(value.slice ? value.slice(0, 64) : Array.prototype.slice.call(value, 0, 64))
                .map((x) => this._jsonSafe(x, depth + 1, localSeen));
        }
        if (Array.isArray(value)) {
            return value.slice(0, 64).map((x) => this._jsonSafe(x, depth + 1, localSeen));
        }
        localSeen.add(value);
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (k === 'tex' || k === 'vao' || k === 'mesh' || k === 'instanceBuffer') continue;
            if (typeof v === 'function') continue;
            out[k] = this._jsonSafe(v, depth + 1, localSeen);
        }
        localSeen.delete(value);
        return out;
    }

    _computeInstanceBoundsFromMatrices(matricesFloat32) {
        try {
            const a = matricesFloat32;
            if (!a || a.length < 16) return null;
            const stride =
                ((a.length % 22) === 0) ? 22 :
                (((a.length % 21) === 0) ? 21 :
                (((a.length % 17) === 0) ? 17 : 16));
            const minT = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
            const maxT = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
            let maxScale = 1.0;
            for (let i = 0; i + 15 < a.length; i += stride) {
                const tx = a[i + 12];
                const ty = a[i + 13];
                const tz = a[i + 14];
                if (tx < minT[0]) minT[0] = tx;
                if (ty < minT[1]) minT[1] = ty;
                if (tz < minT[2]) minT[2] = tz;
                if (tx > maxT[0]) maxT[0] = tx;
                if (ty > maxT[1]) maxT[1] = ty;
                if (tz > maxT[2]) maxT[2] = tz;

                // Max basis column length (approx scale).
                const sx = Math.hypot(a[i + 0], a[i + 1], a[i + 2]);
                const sy = Math.hypot(a[i + 4], a[i + 5], a[i + 6]);
                const sz = Math.hypot(a[i + 8], a[i + 9], a[i + 10]);
                const s = Math.max(sx || 0, sy || 0, sz || 0);
                if (Number.isFinite(s) && s > maxScale) maxScale = s;
            }
            if (!Number.isFinite(minT[0])) return null;
            return { minT, maxT, maxScale };
        } catch {
            return null;
        }
    }

    _createDefaultTintPaletteTexture() {
        // 256x1 RGBA palette. Index 0 = white/no tint.
        const gl = this.gl;
        try {
            const w = 256;
            const h = 1;
            const data = new Uint8Array(w * h * 4);
            const set = (i, r, g, b, a = 255) => {
                const o = i * 4;
                data[o + 0] = r;
                data[o + 1] = g;
                data[o + 2] = b;
                data[o + 3] = a;
            };
            set(0, 255, 255, 255, 255);

            const hsvToRgb = (hh, ss, vv) => {
                const h6 = (((hh % 1) + 1) % 1) * 6;
                const c = vv * ss;
                const x = c * (1 - Math.abs((h6 % 2) - 1));
                const m = vv - c;
                let r = 0, g = 0, b = 0;
                if (h6 < 1) { r = c; g = x; b = 0; }
                else if (h6 < 2) { r = x; g = c; b = 0; }
                else if (h6 < 3) { r = 0; g = c; b = x; }
                else if (h6 < 4) { r = 0; g = x; b = c; }
                else if (h6 < 5) { r = x; g = 0; b = c; }
                else { r = c; g = 0; b = x; }
                return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
            };
            for (let i = 1; i < 256; i++) {
                const [r, g, b] = hsvToRgb(i / 255, 0.65, 1.0);
                set(i, r, g, b, 255);
            }

            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
            gl.bindTexture(gl.TEXTURE_2D, null);
            return tex;
        } catch {
            return null;
        }
    }

    async init() {
        const ok = await this.program.createProgram(vsSource, fsSource);
        if (!ok || !this.program?.program) {
            // If the program didn't link, any gl.getUniformLocation calls will spam:
            // "WebGL: INVALID_OPERATION: getUniformLocation: program not linked"
            // The real error is logged by ShaderProgram.createProgram() with the shader info log.
            console.error('InstancedModelRenderer: shader program failed to link. See earlier "Failed to create shader program" log for GLSL compile/link details.');
            this.ready = false;
            return false;
        }

        // Shadow depth-only shader (uses the same vertex layout / instancing attributes).
        const shadowVs = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=2) in vec2 aTexcoord;
layout(location=9) in vec2 aTexcoord1;
layout(location=10) in vec2 aTexcoord2;
// mat4 instance transform at locations 4..7 (same as main VS)
layout(location=4) in vec4 aI0;
layout(location=5) in vec4 aI1;
layout(location=6) in vec4 aI2;
layout(location=7) in vec4 aI3;
uniform mat4 uModelMatrix;
uniform mat4 uLightViewProj;
uniform vec4 uShadowUv0ScaleOffset;
uniform vec4 uShadowUv1ScaleOffset;
uniform vec4 uShadowUv2ScaleOffset;
uniform vec3 uShadowGlobalAnimUV0;
uniform vec3 uShadowGlobalAnimUV1;
uniform int uShadowDiffuseUvSet;
out vec2 vShadowDiffuseUv;
vec2 selectUv3(int uvSet, vec2 uv0, vec2 uv1, vec2 uv2) {
    if (uvSet == 2) return uv2;
    if (uvSet == 1) return uv1;
    return uv0;
}
void main() {
    mat4 inst = mat4(aI0, aI1, aI2, aI3);
    vec4 worldPos = uModelMatrix * (inst * vec4(aPosition, 1.0));
    vec3 uvw = vec3(aTexcoord, 1.0);
    vec2 uv0 = vec2(dot(uShadowGlobalAnimUV0, uvw), dot(uShadowGlobalAnimUV1, uvw));
    uv0 = uv0 * uShadowUv0ScaleOffset.xy + uShadowUv0ScaleOffset.zw;
    vec2 uv1 = aTexcoord1 * uShadowUv1ScaleOffset.xy + uShadowUv1ScaleOffset.zw;
    vec2 uv2 = aTexcoord2 * uShadowUv2ScaleOffset.xy + uShadowUv2ScaleOffset.zw;
    vShadowDiffuseUv = selectUv3(uShadowDiffuseUvSet, uv0, uv1, uv2);
    gl_Position = uLightViewProj * worldPos;
}`;
        const shadowFs = `#version 300 es
precision mediump float;
in vec2 vShadowDiffuseUv;
uniform bool uShadowAlphaTest;
uniform sampler2D uShadowDiffuse;
uniform float uShadowAlphaCutoff;
uniform bool uShadowFlipDiffuseY;
vec2 maybeFlipY(vec2 uv, bool flipY) {
    return flipY ? vec2(uv.x, 1.0 - uv.y) : uv;
}
void main() {
    if (uShadowAlphaTest) {
        float a = texture(uShadowDiffuse, maybeFlipY(vShadowDiffuseUv, uShadowFlipDiffuseY)).a;
        if (a < uShadowAlphaCutoff) discard;
    }
}`;
        const okShadow = await this._shadowProgram.createProgram(shadowVs, shadowFs);
        if (!okShadow || !this._shadowProgram?.program) {
            console.warn('InstancedModelRenderer: shadow program failed to link (shadows disabled).');
        }

        this.uniforms = {
            uViewProjectionMatrix: this.gl.getUniformLocation(this.program.program, 'uViewProjectionMatrix'),
            uModelMatrix: this.gl.getUniformLocation(this.program.program, 'uModelMatrix'),
            uGpuFrustumCulling: this.gl.getUniformLocation(this.program.program, 'uGpuFrustumCulling'),
            uGpuFrustumPlanes: this.gl.getUniformLocation(this.program.program, 'uGpuFrustumPlanes[0]'),
            uGpuCullRadius: this.gl.getUniformLocation(this.program.program, 'uGpuCullRadius'),
            uLightViewProj: this.gl.getUniformLocation(this.program.program, 'uLightViewProj'),
            uUv0ScaleOffset: this.gl.getUniformLocation(this.program.program, 'uUv0ScaleOffset'),
            uUv1ScaleOffset: this.gl.getUniformLocation(this.program.program, 'uUv1ScaleOffset'),
            uUv2ScaleOffset: this.gl.getUniformLocation(this.program.program, 'uUv2ScaleOffset'),
            uGlobalAnimUV0: this.gl.getUniformLocation(this.program.program, 'uGlobalAnimUV0'),
            uGlobalAnimUV1: this.gl.getUniformLocation(this.program.program, 'uGlobalAnimUV1'),
            uCharacterLocomotion: this.gl.getUniformLocation(this.program.program, 'uCharacterLocomotion'),
            uFragmentTransformEnabled: this.gl.getUniformLocation(this.program.program, 'uFragmentTransformEnabled'),
            uFragmentPivot: this.gl.getUniformLocation(this.program.program, 'uFragmentPivot'),
            uFragmentRotation: this.gl.getUniformLocation(this.program.program, 'uFragmentRotation'),
            uSkinningEnabled: this.gl.getUniformLocation(this.program.program, 'uSkinningEnabled'),
            uBoneTexture: this.gl.getUniformLocation(this.program.program, 'uBoneTexture'),
            uColor: this.gl.getUniformLocation(this.program.program, 'uColor'),
            uVertexColorMode: this.gl.getUniformLocation(this.program.program, 'uVertexColorMode'),
            uDoubleSidedLighting: this.gl.getUniformLocation(this.program.program, 'uDoubleSidedLighting'),
            uLightDir: this.gl.getUniformLocation(this.program.program, 'uLightDir'),
            uLightColor: this.gl.getUniformLocation(this.program.program, 'uLightColor'),
            uAmbient: this.gl.getUniformLocation(this.program.program, 'uAmbient'),
            uShadowEnabled: this.gl.getUniformLocation(this.program.program, 'uShadowEnabled'),
            uShadowMap: this.gl.getUniformLocation(this.program.program, 'uShadowMap'),
            uShadowParams: this.gl.getUniformLocation(this.program.program, 'uShadowParams'),
            uShadowTexel: this.gl.getUniformLocation(this.program.program, 'uShadowTexel'),
            uHasDiffuse: this.gl.getUniformLocation(this.program.program, 'uHasDiffuse'),
            uDiffuse: this.gl.getUniformLocation(this.program.program, 'uDiffuse'),
            uDiffuseUvSet: this.gl.getUniformLocation(this.program.program, 'uDiffuseUvSet'),
            uHasDiffuse2: this.gl.getUniformLocation(this.program.program, 'uHasDiffuse2'),
            uDiffuse2: this.gl.getUniformLocation(this.program.program, 'uDiffuse2'),
            uDiffuse2UseUv1: this.gl.getUniformLocation(this.program.program, 'uDiffuse2UseUv1'),

            uHasNormal: this.gl.getUniformLocation(this.program.program, 'uHasNormal'),
            uNormal: this.gl.getUniformLocation(this.program.program, 'uNormal'),
            uNormalScale: this.gl.getUniformLocation(this.program.program, 'uNormalScale'),
            uNormalUvSet: this.gl.getUniformLocation(this.program.program, 'uNormalUvSet'),
            uHasDetail: this.gl.getUniformLocation(this.program.program, 'uHasDetail'),
            uDetail: this.gl.getUniformLocation(this.program.program, 'uDetail'),
            uDetailSettings: this.gl.getUniformLocation(this.program.program, 'uDetailSettings'),
            uDetailUvSet: this.gl.getUniformLocation(this.program.program, 'uDetailUvSet'),
            uMeshHasUv1: this.gl.getUniformLocation(this.program.program, 'uMeshHasUv1'),

            uHasSpec: this.gl.getUniformLocation(this.program.program, 'uHasSpec'),
            uSpec: this.gl.getUniformLocation(this.program.program, 'uSpec'),
            uSpecularIntensity: this.gl.getUniformLocation(this.program.program, 'uSpecularIntensity'),
            uSpecularPower: this.gl.getUniformLocation(this.program.program, 'uSpecularPower'),
            uSpecularFalloffMult: this.gl.getUniformLocation(this.program.program, 'uSpecularFalloffMult'),
            uSpecMaskWeights: this.gl.getUniformLocation(this.program.program, 'uSpecMaskWeights'),
            uSpecularFresnel: this.gl.getUniformLocation(this.program.program, 'uSpecularFresnel'),
            uSpecUvSet: this.gl.getUniformLocation(this.program.program, 'uSpecUvSet'),

            uHasEmissive: this.gl.getUniformLocation(this.program.program, 'uHasEmissive'),
            uEmissive: this.gl.getUniformLocation(this.program.program, 'uEmissive'),
            uEmissiveIntensity: this.gl.getUniformLocation(this.program.program, 'uEmissiveIntensity'),
            uEmissiveUvSet: this.gl.getUniformLocation(this.program.program, 'uEmissiveUvSet'),

            uHasAO: this.gl.getUniformLocation(this.program.program, 'uHasAO'),
            uAO: this.gl.getUniformLocation(this.program.program, 'uAO'),
            uAOStrength: this.gl.getUniformLocation(this.program.program, 'uAOStrength'),
            uAOUvSet: this.gl.getUniformLocation(this.program.program, 'uAOUvSet'),

            uEnableTintPalette: this.gl.getUniformLocation(this.program.program, 'uEnableTintPalette'),
            uTintPalette: this.gl.getUniformLocation(this.program.program, 'uTintPalette'),
            uTintMode: this.gl.getUniformLocation(this.program.program, 'uTintMode'),
            uPedHairTint: this.gl.getUniformLocation(this.program.program, 'uPedHairTint'),
            uPedHairPrimary: this.gl.getUniformLocation(this.program.program, 'uPedHairPrimary'),
            uPedHairHighlight: this.gl.getUniformLocation(this.program.program, 'uPedHairHighlight'),

            uDecodeDiffuseSrgb: this.gl.getUniformLocation(this.program.program, 'uDecodeDiffuseSrgb'),
            uDecodeDiffuse2Srgb: this.gl.getUniformLocation(this.program.program, 'uDecodeDiffuse2Srgb'),
            uDecodeEmissiveSrgb: this.gl.getUniformLocation(this.program.program, 'uDecodeEmissiveSrgb'),
            uDecodeTintPaletteSrgb: this.gl.getUniformLocation(this.program.program, 'uDecodeTintPaletteSrgb'),
            uFlipDiffuseY: this.gl.getUniformLocation(this.program.program, 'uFlipDiffuseY'),
            uFlipDiffuse2Y: this.gl.getUniformLocation(this.program.program, 'uFlipDiffuse2Y'),
            uFlipNormalY: this.gl.getUniformLocation(this.program.program, 'uFlipNormalY'),
            uFlipDetailY: this.gl.getUniformLocation(this.program.program, 'uFlipDetailY'),
            uFlipSpecY: this.gl.getUniformLocation(this.program.program, 'uFlipSpecY'),
            uFlipEmissiveY: this.gl.getUniformLocation(this.program.program, 'uFlipEmissiveY'),
            uFlipAOY: this.gl.getUniformLocation(this.program.program, 'uFlipAOY'),
            uFlipAlphaMaskY: this.gl.getUniformLocation(this.program.program, 'uFlipAlphaMaskY'),
            uFlipHeightY: this.gl.getUniformLocation(this.program.program, 'uFlipHeightY'),
            uOutputSrgb: this.gl.getUniformLocation(this.program.program, 'uOutputSrgb'),
            uNormalEncoding: this.gl.getUniformLocation(this.program.program, 'uNormalEncoding'),
            uNormalReconstructZ: this.gl.getUniformLocation(this.program.program, 'uNormalReconstructZ'),

            uShaderFamily: this.gl.getUniformLocation(this.program.program, 'uShaderFamily'),
            uTerrainMaskMode: this.gl.getUniformLocation(this.program.program, 'uTerrainMaskMode'),
            uHasAlphaMask: this.gl.getUniformLocation(this.program.program, 'uHasAlphaMask'),
            uAlphaMask: this.gl.getUniformLocation(this.program.program, 'uAlphaMask'),
            uDecalMode: this.gl.getUniformLocation(this.program.program, 'uDecalMode'),
            uHasDecalAlphaMaskVec: this.gl.getUniformLocation(this.program.program, 'uHasDecalAlphaMaskVec'),
            uDecalAlphaMaskVec: this.gl.getUniformLocation(this.program.program, 'uDecalAlphaMaskVec'),
            uReflectionIntensity: this.gl.getUniformLocation(this.program.program, 'uReflectionIntensity'),
            uFresnelPower: this.gl.getUniformLocation(this.program.program, 'uFresnelPower'),
            uEnvColor: this.gl.getUniformLocation(this.program.program, 'uEnvColor'),
            uHasEnvMap: this.gl.getUniformLocation(this.program.program, 'uHasEnvMap'),
            uEnvMap: this.gl.getUniformLocation(this.program.program, 'uEnvMap'),
            uDecodeEnvSrgb: this.gl.getUniformLocation(this.program.program, 'uDecodeEnvSrgb'),
            uFlipEnvY: this.gl.getUniformLocation(this.program.program, 'uFlipEnvY'),

            uHasDirt: this.gl.getUniformLocation(this.program.program, 'uHasDirt'),
            uDirt: this.gl.getUniformLocation(this.program.program, 'uDirt'),
            uDirtLevel: this.gl.getUniformLocation(this.program.program, 'uDirtLevel'),
            uDirtColor: this.gl.getUniformLocation(this.program.program, 'uDirtColor'),
            uFlipDirtY: this.gl.getUniformLocation(this.program.program, 'uFlipDirtY'),

            uHasDamage: this.gl.getUniformLocation(this.program.program, 'uHasDamage'),
            uDamage: this.gl.getUniformLocation(this.program.program, 'uDamage'),
            uHasDamageMask: this.gl.getUniformLocation(this.program.program, 'uHasDamageMask'),
            uDamageMask: this.gl.getUniformLocation(this.program.program, 'uDamageMask'),
            uFlipDamageY: this.gl.getUniformLocation(this.program.program, 'uFlipDamageY'),
            uFlipDamageMaskY: this.gl.getUniformLocation(this.program.program, 'uFlipDamageMaskY'),

            uHasPuddleMask: this.gl.getUniformLocation(this.program.program, 'uHasPuddleMask'),
            uPuddleMask: this.gl.getUniformLocation(this.program.program, 'uPuddleMask'),
            uFlipPuddleMaskY: this.gl.getUniformLocation(this.program.program, 'uFlipPuddleMaskY'),
            uPuddleParams: this.gl.getUniformLocation(this.program.program, 'uPuddleParams'),
            uPuddleScaleRange: this.gl.getUniformLocation(this.program.program, 'uPuddleScaleRange'),

            uDecalTint: this.gl.getUniformLocation(this.program.program, 'uDecalTint'),

            uHasHeight: this.gl.getUniformLocation(this.program.program, 'uHasHeight'),
            uHeight: this.gl.getUniformLocation(this.program.program, 'uHeight'),
            uParallaxScaleBias: this.gl.getUniformLocation(this.program.program, 'uParallaxScaleBias'),

            uWetness: this.gl.getUniformLocation(this.program.program, 'uWetness'),
            uWetDarken: this.gl.getUniformLocation(this.program.program, 'uWetDarken'),
            uWetSpecBoost: this.gl.getUniformLocation(this.program.program, 'uWetSpecBoost'),

            uAlphaMode: this.gl.getUniformLocation(this.program.program, 'uAlphaMode'),
            uAlphaCutoff: this.gl.getUniformLocation(this.program.program, 'uAlphaCutoff'),
            uAlphaScale: this.gl.getUniformLocation(this.program.program, 'uAlphaScale'),
            uHardAlphaBlend: this.gl.getUniformLocation(this.program.program, 'uHardAlphaBlend'),
            uIsDistMap: this.gl.getUniformLocation(this.program.program, 'uIsDistMap'),

            // Water (best-effort)
            uTime: this.gl.getUniformLocation(this.program.program, 'uTime'),
            uWaterMode: this.gl.getUniformLocation(this.program.program, 'uWaterMode'),
            uRippleSpeed: this.gl.getUniformLocation(this.program.program, 'uRippleSpeed'),
            uRippleScale: this.gl.getUniformLocation(this.program.program, 'uRippleScale'),
            uRippleBumpiness: this.gl.getUniformLocation(this.program.program, 'uRippleBumpiness'),
            uWaterEnableTexture: this.gl.getUniformLocation(this.program.program, 'uWaterEnableTexture'),
            uWaterEnableBumpMap: this.gl.getUniformLocation(this.program.program, 'uWaterEnableBumpMap'),
            uWaterEnableFoamMap: this.gl.getUniformLocation(this.program.program, 'uWaterEnableFoamMap'),
            uWaterEnableFlow: this.gl.getUniformLocation(this.program.program, 'uWaterEnableFlow'),
            uWaterEnableFogtex: this.gl.getUniformLocation(this.program.program, 'uWaterEnableFogtex'),
            uWaterFlowParams: this.gl.getUniformLocation(this.program.program, 'uWaterFlowParams'),
            uWaterFogParams: this.gl.getUniformLocation(this.program.program, 'uWaterFogParams'),

            uCameraPos: this.gl.getUniformLocation(this.program.program, 'uCameraPos'),
            uFogEnabled: this.gl.getUniformLocation(this.program.program, 'uFogEnabled'),
            uFogColor: this.gl.getUniformLocation(this.program.program, 'uFogColor'),
            uFogStart: this.gl.getUniformLocation(this.program.program, 'uFogStart'),
            uFogEnd: this.gl.getUniformLocation(this.program.program, 'uFogEnd'),
            uWireframe: this.gl.getUniformLocation(this.program.program, 'uWireframe'),
            uWireframeColor: this.gl.getUniformLocation(this.program.program, 'uWireframeColor'),
        };

        // Shadow program uniforms.
        try {
            if (this._shadowProgram?.program) {
                this._shadowUniforms = {
                    uModelMatrix: this.gl.getUniformLocation(this._shadowProgram.program, 'uModelMatrix'),
                    uLightViewProj: this.gl.getUniformLocation(this._shadowProgram.program, 'uLightViewProj'),
                    uShadowUv0ScaleOffset: this.gl.getUniformLocation(this._shadowProgram.program, 'uShadowUv0ScaleOffset'),
                    uShadowUv1ScaleOffset: this.gl.getUniformLocation(this._shadowProgram.program, 'uShadowUv1ScaleOffset'),
                    uShadowUv2ScaleOffset: this.gl.getUniformLocation(this._shadowProgram.program, 'uShadowUv2ScaleOffset'),
                    uShadowGlobalAnimUV0: this.gl.getUniformLocation(this._shadowProgram.program, 'uShadowGlobalAnimUV0'),
                    uShadowGlobalAnimUV1: this.gl.getUniformLocation(this._shadowProgram.program, 'uShadowGlobalAnimUV1'),
                    uShadowDiffuseUvSet: this.gl.getUniformLocation(this._shadowProgram.program, 'uShadowDiffuseUvSet'),
                    uShadowAlphaTest: this.gl.getUniformLocation(this._shadowProgram.program, 'uShadowAlphaTest'),
                    uShadowDiffuse: this.gl.getUniformLocation(this._shadowProgram.program, 'uShadowDiffuse'),
                    uShadowAlphaCutoff: this.gl.getUniformLocation(this._shadowProgram.program, 'uShadowAlphaCutoff'),
                    uShadowFlipDiffuseY: this.gl.getUniformLocation(this._shadowProgram.program, 'uShadowFlipDiffuseY'),
                };
            }
        } catch {
            this._shadowUniforms = null;
        }

        this.tintPaletteTex = this._createDefaultTintPaletteTexture();
        // Default textures: keep these simple and always-valid.
        // - white: for diffuse/emissive/alphaMask/AO where "no texture" should not darken/cutout
        // - black: for spec/env/height/dirt/damage where "no texture" should contribute nothing
        // - normalFlat: for normal/detail where "no texture" should be flat
        this._texWhite = this._create1x1TextureRGBA8([255, 255, 255, 255]);
        this._texBlack = this._create1x1TextureRGBA8([0, 0, 0, 255]);
        this._texNormalFlat = this._create1x1TextureRGBA8([128, 128, 255, 255]);
        this._identityBoneTexture = this._createBoneTextureFromRows([[
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
        ]]);

        // Dummy depth texture for shadow sampler binding when shadows are disabled.
        this._shadow.dummyDepthTex = this._create1x1DepthTexture();
        this.ready = true;
    }

    _create1x1DepthTexture() {
        const gl = this.gl;
        try {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            // IMPORTANT: manual compare in shader (sampler2D), so disable hardware compare.
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.NONE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT16, 1, 1, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, null);
            gl.bindTexture(gl.TEXTURE_2D, null);
            return t;
        } catch {
            try { this.gl.bindTexture(this.gl.TEXTURE_2D, null); } catch { /* ignore */ }
            return null;
        }
    }

    _ensureShadowMap(size) {
        const gl = this.gl;
        const S = Math.max(256, Math.min(8192, (Number(size) | 0) || 2048));
        if (this._shadow.fbo && this._shadow.depthTex && this._shadow.size === S) return true;
        // Delete old
        try { if (this._shadow.depthTex) gl.deleteTexture(this._shadow.depthTex); } catch { /* ignore */ }
        try { if (this._shadow.fbo) gl.deleteFramebuffer(this._shadow.fbo); } catch { /* ignore */ }
        this._shadow.fbo = null;
        this._shadow.depthTex = null;
        this._shadow.size = S;

        try {
            const depthTex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, depthTex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            // IMPORTANT: manual compare in shader (sampler2D), so disable hardware compare.
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.NONE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, S, S, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);

            const fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
            // No color targets.
            gl.drawBuffers([gl.NONE]);
            gl.readBuffer(gl.NONE);

            const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.bindTexture(gl.TEXTURE_2D, null);

            if (status !== gl.FRAMEBUFFER_COMPLETE) {
                try { gl.deleteFramebuffer(fbo); } catch { /* ignore */ }
                try { gl.deleteTexture(depthTex); } catch { /* ignore */ }
                this._shadow.fbo = null;
                this._shadow.depthTex = null;
                return false;
            }

            this._shadow.fbo = fbo;
            this._shadow.depthTex = depthTex;
            return true;
        } catch {
            try { gl.bindFramebuffer(gl.FRAMEBUFFER, null); } catch { /* ignore */ }
            try { gl.bindTexture(gl.TEXTURE_2D, null); } catch { /* ignore */ }
            this._shadow.fbo = null;
            this._shadow.depthTex = null;
            return false;
        }
    }

    _computeDirectionalLightViewProj(lightDir, cameraPos, opts = {}) {
        // Build a simple orthographic light frustum centered around the camera.
        // This is "real" shadow mapping, but still a single cascade (no CSM yet).
        const ld = Array.isArray(lightDir) && lightDir.length >= 3
            ? glMatrix.vec3.fromValues(Number(lightDir[0]) || 0, Number(lightDir[1]) || 0, Number(lightDir[2]) || 0)
            : glMatrix.vec3.fromValues(0.4, 0.85, 0.2);
        if (glMatrix.vec3.length(ld) < 1e-6) glMatrix.vec3.set(ld, 0.4, 0.85, 0.2);
        glMatrix.vec3.normalize(ld, ld);

        const cp = Array.isArray(cameraPos) && cameraPos.length >= 3
            ? glMatrix.vec3.fromValues(Number(cameraPos[0]) || 0, Number(cameraPos[1]) || 0, Number(cameraPos[2]) || 0)
            : glMatrix.vec3.fromValues(0, 0, 0);

        const orthoHalf = Number.isFinite(Number(opts.orthoHalfSize)) ? Math.max(10.0, Number(opts.orthoHalfSize)) : 1200.0;
        const distBack = Number.isFinite(Number(opts.lightDistance)) ? Math.max(10.0, Number(opts.lightDistance)) : (orthoHalf * 2.0);
        const near = 0.1;
        const far = Number.isFinite(Number(opts.far)) ? Math.max(near + 1.0, Number(opts.far)) : (orthoHalf * 6.0);

        // light position behind the center along light direction
        const eye = glMatrix.vec3.create();
        glMatrix.vec3.scaleAndAdd(eye, cp, ld, -distBack);

        // Choose a stable up vector
        const up = glMatrix.vec3.fromValues(0, 1, 0);
        if (Math.abs(glMatrix.vec3.dot(up, ld)) > 0.98) glMatrix.vec3.set(up, 1, 0, 0);

        const view = glMatrix.mat4.create();
        glMatrix.mat4.lookAt(view, eye, cp, up);

        const proj = glMatrix.mat4.create();
        glMatrix.mat4.ortho(proj, -orthoHalf, orthoHalf, -orthoHalf, orthoHalf, near, far);

        const vp = glMatrix.mat4.create();
        glMatrix.mat4.multiply(vp, proj, view);
        return vp;
    }

    renderOccluderDepth(viewProjectionMatrix, { maxDistance = 180, maxDrawItems = 96, minRadius = 3.0 } = {}) {
        // The old occlusion prepass only contained terrain and a legacy building OBJ.
        // Streamed GTA buildings therefore never blocked the drawables behind them.
        // Reuse the depth-only shadow shader for opaque world mesh instances.
        const gl = this.gl;
        const stats = this._occlusionStats;
        stats.depthCandidates = 0;
        stats.depthDraws = 0;
        stats.depthInstances = 0;
        stats.depthDistanceRejected = 0;
        stats.depthSizeRejected = 0;
        if (!this.ready || !this._shadowProgram?.program || !this._shadowUniforms) return false;
        if (!viewProjectionMatrix || viewProjectionMatrix.length < 16) return false;

        const maxD = Number.isFinite(Number(maxDistance)) ? Math.max(1.0, Number(maxDistance)) : 180.0;
        const maxItems = Number.isFinite(Number(maxDrawItems)) ? Math.max(1, Math.floor(Number(maxDrawItems))) : 96;
        const minR = Number.isFinite(Number(minRadius)) ? Math.max(0.0, Number(minRadius)) : 3.0;
        const candidates = [];
        const isOpaqueOccluder = (material) => {
            const mat = material && typeof material === 'object' ? material : {};
            const family = String(mat.shaderFamily || '').toLowerCase();
            const name = String(mat.shaderName || '').toLowerCase();
            const alpha = String(mat.alphaMode || 'opaque').toLowerCase();
            // Do not let leaves, glass, decals, or water falsely become solid walls.
            if (family === 'decal' || family === 'glass' || family === 'water') return false;
            if (name.includes('decal') || name.includes('glass') || name.includes('water') || name.includes('additive')) return false;
            return alpha !== 'blend' && alpha !== 'cutout';
        };
        const addCandidate = (item, material, distance) => {
            if (!item?.mesh || !(Number(item.instanceCount) > 0)) return;
            if (this.modelManager?.isMeshDisposed?.(item.mesh)) return;
            if (!isOpaqueOccluder(material)) return;
            const radius = Number(item.mesh.radius) || 0.0;
            if (radius < minR) {
                stats.depthSizeRejected++;
                return;
            }
            const d = Number(distance);
            if (Number.isFinite(d) && d > maxD) {
                stats.depthDistanceRejected++;
                return;
            }
            const safeDistance = Number.isFinite(d) ? Math.max(0.0, d) : 0.0;
            candidates.push({ ...item, distance: safeDistance, screenScore: radius / Math.max(1.0, safeDistance) });
        };

        for (const bucket of this.buckets.values()) {
            if (!bucket || bucket.file === '__placeholder__') continue;
            addCandidate({
                mesh: bucket.mesh,
                vao: bucket.vao,
                instanceBuffer: bucket.instanceBuffer,
                instanceCount: bucket.instanceCount,
                instanceStrideFloats: bucket.instanceStrideFloats,
                doubleSided: !!bucket.material?.doubleSided,
            }, bucket.material, bucket.minDist);
        }
        for (const entry of this.instances.values()) {
            if (!entry || !(Number(entry.instanceCount) > 0)) continue;
            const h = this.modelManager?.normalizeId?.(entry.hash) ?? String(entry.hash || '');
            const entryMat = this.modelManager?.manifest?.meshes?.[h]?.material ?? null;
            for (const submesh of entry.submeshes?.values?.() || []) {
                if (!submesh || submesh.file === '__placeholder__') continue;
                const material = { ...(entryMat || {}), ...(submesh.material || {}) };
                addCandidate({
                    mesh: submesh.mesh,
                    vao: submesh.vao,
                    instanceBuffer: entry.instanceBuffer,
                    instanceCount: entry.instanceCount,
                    instanceStrideFloats: entry.instanceStrideFloats,
                    doubleSided: !!material.doubleSided,
                }, material, entry.minDist);
            }
        }

        // Start with the meshes that cover the largest portion of the screen. This
        // favors building facades over small props and keeps the prepass bounded.
        candidates.sort((a, b) => b.screenScore - a.screenScore || a.distance - b.distance);
        stats.depthCandidates = candidates.length;
        if (!candidates.length) return false;

        let previousProgram = null;
        let previousVao = null;
        try { previousProgram = gl.getParameter(gl.CURRENT_PROGRAM); } catch { /* ignore */ }
        try { previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING); } catch { /* ignore */ }
        try {
            gl.useProgram(this._shadowProgram.program);
            gl.uniformMatrix4fv(this._shadowUniforms.uModelMatrix, false, this.modelMatrix);
            gl.uniformMatrix4fv(this._shadowUniforms.uLightViewProj, false, viewProjectionMatrix);

            for (let i = 0; i < candidates.length && i < maxItems; i++) {
                const item = candidates[i];
                const mesh = item.mesh;
                if (!mesh?.vao || !(Number(mesh.indexCount) > 0)) continue;
                if (item.doubleSided) gl.disable(gl.CULL_FACE);
                else {
                    gl.enable(gl.CULL_FACE);
                    gl.cullFace(gl.BACK);
                }
                if (item.vao) {
                    gl.bindVertexArray(item.vao);
                } else {
                    gl.bindVertexArray(mesh.vao);
                    gl.bindBuffer(gl.ARRAY_BUFFER, item.instanceBuffer);
                    const strideFloats = Math.max(16, Number(item.instanceStrideFloats) || 16);
                    const strideBytes = strideFloats * 4;
                    for (let column = 0; column < 4; column++) {
                        const location = 4 + column;
                        gl.enableVertexAttribArray(location);
                        gl.vertexAttribPointer(location, 4, gl.FLOAT, false, strideBytes, column * 16);
                        gl.vertexAttribDivisor(location, 1);
                    }
                }
                gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0, item.instanceCount);
                stats.depthDraws++;
                stats.depthInstances += Number(item.instanceCount) || 0;
            }
            return stats.depthDraws > 0;
        } finally {
            try { gl.bindVertexArray(previousVao); } catch { /* ignore */ }
            try { gl.useProgram(previousProgram); } catch { /* ignore */ }
        }
    }

    _renderShadowMap(drawItems, lightViewProjMat4) {
        const gl = this.gl;
        if (!this._shadowProgram?.program || !this._shadowUniforms) return false;
        if (!this._shadow?.fbo || !this._shadow?.depthTex || !(this._shadow.size > 0)) return false;

        // Save current state (framebuffer + viewport + masks) so we don't break the caller's render targets.
        let prevFbo = null;
        let prevVp = null;
        let prevColorMask = null;
        let prevCull = null;
        let prevBlend = null;
        let prevDepthMask = null;
        let prevDepthTest = null;
        let prevDepthFunc = null;
        try { prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING); } catch { prevFbo = null; }
        try { prevVp = gl.getParameter(gl.VIEWPORT); } catch { prevVp = null; }
        try { prevColorMask = gl.getParameter(gl.COLOR_WRITEMASK); } catch { prevColorMask = [true, true, true, true]; }
        try { prevCull = gl.isEnabled(gl.CULL_FACE); } catch { prevCull = null; }
        try { prevBlend = gl.isEnabled(gl.BLEND); } catch { prevBlend = null; }
        try { prevDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK); } catch { prevDepthMask = null; }
        try { prevDepthTest = gl.isEnabled(gl.DEPTH_TEST); } catch { prevDepthTest = null; }
        try { prevDepthFunc = gl.getParameter(gl.DEPTH_FUNC); } catch { prevDepthFunc = null; }

        try {
            // Render to shadow depth texture.
            gl.bindFramebuffer(gl.FRAMEBUFFER, this._shadow.fbo);
            gl.viewport(0, 0, this._shadow.size, this._shadow.size);
            gl.colorMask(false, false, false, false);
            if (prevBlend) gl.disable(gl.BLEND);
            gl.enable(gl.DEPTH_TEST);
            gl.depthMask(true);
            gl.clearDepth(1.0);
            gl.clear(gl.DEPTH_BUFFER_BIT);

            gl.useProgram(this._shadowProgram.program);
            gl.uniformMatrix4fv(this._shadowUniforms.uModelMatrix, false, this.modelMatrix);
            gl.uniformMatrix4fv(this._shadowUniforms.uLightViewProj, false, lightViewProjMat4);
            try { gl.uniform1i(this._shadowUniforms.uShadowDiffuse, 0); } catch { /* ignore */ }

            const setShadowVec4 = (loc, v, fallback = [1.0, 1.0, 0.0, 0.0]) => {
                const a = Array.isArray(v) && v.length >= 4 ? v : fallback;
                gl.uniform4fv(loc, [
                    Number.isFinite(Number(a[0])) ? Number(a[0]) : fallback[0],
                    Number.isFinite(Number(a[1])) ? Number(a[1]) : fallback[1],
                    Number.isFinite(Number(a[2])) ? Number(a[2]) : fallback[2],
                    Number.isFinite(Number(a[3])) ? Number(a[3]) : fallback[3],
                ]);
            };
            const setShadowVec3 = (loc, v, fallback = [1.0, 0.0, 0.0]) => {
                const a = Array.isArray(v) && v.length >= 3 ? v : fallback;
                gl.uniform3fv(loc, [
                    Number.isFinite(Number(a[0])) ? Number(a[0]) : fallback[0],
                    Number.isFinite(Number(a[1])) ? Number(a[1]) : fallback[1],
                    Number.isFinite(Number(a[2])) ? Number(a[2]) : fallback[2],
                ]);
            };

            // Draw shadow casters: opaque + cutout only (no glass/decals/water blending).
            for (const it of drawItems) {
                if (!it || !it.mesh) continue;
                const rb = Number(it.renderBucket);
                if (!(rb === 0 || rb === 1)) continue; // OPAQUE or CUTOUT only

                const needsAlphaTest = rb === 1 || Number(it.alphaModeInt) === 1;
                if (needsAlphaTest) {
                    const rel = String(it.diffuseRel || '');
                    const url = rel ? this._chooseTextureUrl(rel, { allowIndexMiss: false }) : null;
                    const kind = String(it.diffuseKind || 'diffuse');
                    const info = (url && this.textureStreamer)
                        ? this.textureStreamer.getWithInfo(url, { distance: it.dist, kind })
                        : null;
                    if (!info || info.isPlaceholder || !info.tex) {
                        // A solid depth silhouette is worse than no foliage shadow: it projects the
                        // whole leaf card/canopy as a dull blob over the visible cutout tree.
                        continue;
                    }
                    gl.activeTexture(gl.TEXTURE0);
                    gl.bindTexture(gl.TEXTURE_2D, info.tex);
                    gl.uniform1i(this._shadowUniforms.uShadowAlphaTest, 1);
                    gl.uniform1f(
                        this._shadowUniforms.uShadowAlphaCutoff,
                        Number.isFinite(Number(it.alphaCutoff)) ? Number(it.alphaCutoff) : 0.33
                    );
                    gl.uniform1i(this._shadowUniforms.uShadowFlipDiffuseY, info.needsUvFlipY ? 1 : 0);
                } else {
                    gl.uniform1i(this._shadowUniforms.uShadowAlphaTest, 0);
                    gl.uniform1i(this._shadowUniforms.uShadowFlipDiffuseY, 0);
                }

                setShadowVec4(this._shadowUniforms.uShadowUv0ScaleOffset, it.uvso);
                setShadowVec4(this._shadowUniforms.uShadowUv1ScaleOffset, it.uvso1);
                setShadowVec4(this._shadowUniforms.uShadowUv2ScaleOffset, it.uvso2);
                setShadowVec3(this._shadowUniforms.uShadowGlobalAnimUV0, it.globalAnimUV0, [1.0, 0.0, 0.0]);
                setShadowVec3(this._shadowUniforms.uShadowGlobalAnimUV1, it.globalAnimUV1, [0.0, 1.0, 0.0]);
                gl.uniform1i(this._shadowUniforms.uShadowDiffuseUvSet, Number.isFinite(Number(it.diffuseUvSet)) ? (Number(it.diffuseUvSet) | 0) : 0);

                // Cull setting
                const ds = !!it.doubleSided;
                if (ds) {
                    gl.disable(gl.CULL_FACE);
                } else {
                    gl.enable(gl.CULL_FACE);
                    gl.cullFace(gl.BACK);
                }

                // Bind VAO
                if (it.vao) {
                    gl.bindVertexArray(it.vao);
                } else {
                    // Slow path: mesh VAO exists but does not include instancing attributes.
                    // Bind instance buffer attrib pointers the same way the main render slow path does.
                    gl.bindVertexArray(it.mesh.vao);
                    gl.bindBuffer(gl.ARRAY_BUFFER, it.instanceBuffer);
                    const strideFloats = Number(it.instanceStrideFloats ?? 16);
                    const bytesPerMat = Math.max(16, strideFloats) * 4;
                    const bytesPerVec4 = 4 * 4;
                    for (let i = 0; i < 4; i++) {
                        const loc = 4 + i;
                        gl.enableVertexAttribArray(loc);
                        gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, bytesPerMat, i * bytesPerVec4);
                        gl.vertexAttribDivisor(loc, 1);
                    }
                    // Optional tint index at location 12 (not used by shadow shader, but keep VAO state stable).
                    if (strideFloats >= 17) {
                        gl.enableVertexAttribArray(12);
                        gl.vertexAttribPointer(12, 1, gl.FLOAT, false, bytesPerMat, 16 * 4);
                        gl.vertexAttribDivisor(12, 1);
                    } else {
                        try {
                            gl.disableVertexAttribArray(12);
                            gl.vertexAttrib1f(12, 0.0);
                        } catch { /* ignore */ }
                    }
                }

                gl.drawElementsInstanced(gl.TRIANGLES, it.mesh.indexCount, gl.UNSIGNED_INT, 0, it.instanceCount);
            }
            return true;
        } finally {
            // Restore even if something throws mid-pass (prevents state from "poisoning" the rest of the frame).
            try { gl.bindVertexArray(null); } catch { /* ignore */ }
            try {
                const cm = (prevColorMask && prevColorMask.length >= 4) ? prevColorMask : [true, true, true, true];
                gl.colorMask(!!cm[0], !!cm[1], !!cm[2], !!cm[3]);
            } catch { /* ignore */ }
            try {
                if (prevCull === false) gl.disable(gl.CULL_FACE);
                else if (prevCull === true) gl.enable(gl.CULL_FACE);
            } catch { /* ignore */ }
            try {
                if (prevBlend) gl.enable(gl.BLEND);
                else if (prevBlend === false) gl.disable(gl.BLEND);
            } catch { /* ignore */ }
            try { if (prevDepthFunc !== null) gl.depthFunc(prevDepthFunc); } catch { /* ignore */ }
            try {
                if (prevDepthTest === false) gl.disable(gl.DEPTH_TEST);
                else if (prevDepthTest === true) gl.enable(gl.DEPTH_TEST);
            } catch { /* ignore */ }
            try { if (prevDepthMask !== null) gl.depthMask(!!prevDepthMask); } catch { /* ignore */ }
            try { gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo); } catch { /* ignore */ }
            try { if (prevVp && prevVp.length >= 4) gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]); } catch { /* ignore */ }
            // Return to main program for subsequent work.
            try { gl.useProgram(this.program.program); } catch { /* ignore */ }
        }
    }

    _updateInstanceData(entry, matricesFloat32) {
        if (entry.instanceData instanceof Float32Array && entry.instanceData.length === matricesFloat32.length) {
            let changed = false;
            for (let i = 0; i < matricesFloat32.length; i++) {
                const value = matricesFloat32[i];
                if (entry.instanceData[i] === value) continue;
                entry.instanceData[i] = value;
                changed = true;
            }
            return changed;
        }
        entry.instanceData = new Float32Array(matricesFloat32);
        return true;
    }

    _uploadInstanceBuffer(entry, matricesFloat32) {
        const gl = this.gl;
        const nextBytes = matricesFloat32.byteLength || (matricesFloat32.length * 4);
        gl.bindBuffer(gl.ARRAY_BUFFER, entry.instanceBuffer);
        if (Number(entry.instanceBufferBytes) === Number(nextBytes)) {
            try {
                gl.bufferSubData(gl.ARRAY_BUFFER, 0, matricesFloat32);
                return;
            } catch { /* reallocate below */ }
        }
        gl.bufferData(gl.ARRAY_BUFFER, matricesFloat32, gl.DYNAMIC_DRAW);
        entry.instanceBufferBytes = nextBytes;
    }

    async setInstancesForArchetype(hash, lod, matricesFloat32, minDist = null, opts = {}) {
        const h = String(hash);
        const l = String(lod || 'high').toLowerCase();
        if (!this.ready) return;
        if (!matricesFloat32 || matricesFloat32.length === 0) {
            const key = `${h}:${l}`;
            const old = this.instances.get(key);
            if (old) {
                try { this.gl.deleteBuffer(old.instanceBuffer); } catch { /* ignore */ }
                try {
                    for (const sm of old.submeshes?.values?.() || []) {
                        if (sm?.vao) this.gl.deleteVertexArray(sm.vao);
                    }
                } catch { /* ignore */ }
            }
            this.instances.delete(key);
            return;
        }

        const gl = this.gl;
        const key = `${h}:${l}`;
        let entry = this.instances.get(key);
        if (!entry) {
            entry = {
                hash: h,
                lod: l,
                minDist: null,
                instanceBuffer: gl.createBuffer(),
                instanceBufferBytes: 0,
                instanceCount: 0,
                submeshes: new Map(), // file -> {file, material, mesh, vao}
                loadPriority: 0,
            };
            this.instances.set(key, entry);
        }
        const loadPriority = Number(opts?.loadPriority);
        entry.loadPriority = Number.isFinite(loadPriority) ? loadPriority : (Number(entry.loadPriority) || 0);

        {
            const d = Number(minDist);
            if (Number.isFinite(d)) entry.minDist = d;
        }

        // Layouts:
        // - 16: mat4
        // - 17: mat4 + tintIndex
        // - 21: mat4 + tintIndex + (guid, mloParentGuid, mloEntitySetHash, mloFlags)
        // - 22: mat4 + tintIndex + (guid, mloParentGuid, mloEntitySetHash, mloFlags, ymapHash)
        const stride =
            ((matricesFloat32.length % 22) === 0) ? 22 :
            (((matricesFloat32.length % 21) === 0) ? 21 :
            (((matricesFloat32.length % 17) === 0) ? 17 : 16));
        // Quick sanity check: catch NaNs/Infs early (prevents shader NaN poisoning / grey screen).
        try {
            const lim = Math.min(matricesFloat32.length, Math.min(512, stride * 8));
            for (let i = 0; i < lim; i++) {
                const v = matricesFloat32[i];
                if (!Number.isFinite(v)) {
                    console.warn(`InstancedModelRenderer: non-finite instance data for ${key} (dropping upload)`);
                    return;
                }
            }
        } catch { /* ignore */ }
        // If stride changed (e.g. tint enabled/disabled), drop VAOs so they rebuild with correct attrib pointers.
        if (entry.instanceStrideFloats && entry.instanceStrideFloats !== stride) {
            try {
                for (const sm of entry.submeshes?.values?.() || []) {
                    if (sm?.vao) gl.deleteVertexArray(sm.vao);
                    if (sm) sm.vao = null;
                }
            } catch { /* ignore */ }
        }
        entry.instanceStrideFloats = stride;
        entry.instanceCount = Math.floor(matricesFloat32.length / stride);
        const instanceDataChanged = this._updateInstanceData(entry, matricesFloat32);
        if (instanceDataChanged) this._uploadInstanceBuffer(entry, matricesFloat32);

        // Cache conservative instance translation bounds + max scale (data space) for occlusion.
        if (instanceDataChanged || !entry._instBounds) {
            entry._instBounds = this._computeInstanceBoundsFromMatrices(matricesFloat32);
        }

        // Update submesh list from manifest (v4) or fallback (v3).
        const subs = this.modelManager?.getLodSubmeshes?.(h, l) || [];
        const wanted = new Set();

        // If an archetype isn't in the manifest, `subs` is empty.
        // In that case we can optionally render a placeholder cube to make "missing exports" obvious.
        const allowPlaceholderMesh = opts?.allowPlaceholderMesh !== false;
        if ((!subs || subs.length === 0)
            && allowPlaceholderMesh
            && (this.modelManager?.enablePlaceholderMeshes ?? false)) {
            const phKey = '__placeholder__';
            wanted.add(phKey);
            // Ensure ONLY the placeholder submesh remains.
            for (const file of Array.from(entry.submeshes.keys())) {
                if (file !== phKey) {
                    const sm = entry.submeshes.get(file);
                    try { if (sm?.vao) gl.deleteVertexArray(sm.vao); } catch { /* ignore */ }
                    entry.submeshes.delete(file);
                }
            }
            if (!entry.submeshes.has(phKey)) {
                entry.submeshes.set(phKey, { file: phKey, material: null, mesh: this.modelManager?._placeholderMesh ?? null, vao: null });
            } else {
                const sm = entry.submeshes.get(phKey);
                if (sm) sm.mesh = this.modelManager?._placeholderMesh ?? sm.mesh;
            }
            // No mesh loads needed for placeholder.
        } else {
            for (const sm of subs) {
                const file = String(sm?.file || '');
                if (!file) continue;
                wanted.add(file);
                if (!entry.submeshes.has(file)) {
                    entry.submeshes.set(file, {
                        file,
                        material: sm?.material ?? null,
                        pedComponent: sm?.pedComponent ?? null,
                        mesh: null,
                        vao: null,
                        skinned: !!sm?.skinned,
                        boneIds: Array.isArray(sm?.boneIds) ? sm.boneIds.slice(0) : [],
                        hasBlendWeights: !!sm?.hasBlendWeights,
                        hasBlendIndices: !!sm?.hasBlendIndices,
                        fragmentBoneTag: Number.isFinite(Number(sm?.fragmentBoneTag)) ? Number(sm.fragmentBoneTag) : null,
                    });
                } else {
                    // keep material up to date if manifest changed
                    const e = entry.submeshes.get(file);
                    if (e) {
                        e.material = sm?.material ?? e.material;
                        e.pedComponent = sm?.pedComponent ?? e.pedComponent ?? null;
                        e.skinned = !!sm?.skinned;
                        e.boneIds = Array.isArray(sm?.boneIds) ? sm.boneIds.slice(0) : [];
                        e.hasBlendWeights = !!sm?.hasBlendWeights;
                        e.hasBlendIndices = !!sm?.hasBlendIndices;
                        e.fragmentBoneTag = Number.isFinite(Number(sm?.fragmentBoneTag)) ? Number(sm.fragmentBoneTag) : null;
                    }
                }
            }

            // Drop stale submeshes
            for (const file of Array.from(entry.submeshes.keys())) {
                if (!wanted.has(file)) {
                    const sm = entry.submeshes.get(file);
                    try { if (sm?.vao) gl.deleteVertexArray(sm.vao); } catch { /* ignore */ }
                    entry.submeshes.delete(file);
                }
            }

            // Ensure submesh meshes will be loaded (throttled).
            for (const file of wanted) this._enqueueMeshLoad(key, file, { priority: entry.loadPriority || 0 });
        }
    }

    /**
     * Fast-path update for an existing archetype+lod instance buffer.
     * This avoids re-walking the manifest + submesh list every frame.
     *
     * Returns true if the instance buffer was updated, false if the entry doesn't exist yet.
     */
    updateInstanceMatricesForArchetype(hash, lod, matricesFloat32, minDist = null) {
        const h = String(hash);
        const l = String(lod || 'high').toLowerCase();
        if (!this.ready) return false;
        if (!matricesFloat32 || matricesFloat32.length === 0) return false;

        const key = `${h}:${l}`;
        const entry = this.instances.get(key);
        if (!entry) return false;

        {
            const d = Number(minDist);
            if (Number.isFinite(d)) entry.minDist = d;
        }

        const gl = this.gl;
        // Layouts:
        // - 16: mat4
        // - 17: mat4 + tintIndex
        // - 21: mat4 + tintIndex + (guid, mloParentGuid, mloEntitySetHash, mloFlags)
        // - 22: mat4 + tintIndex + (guid, mloParentGuid, mloEntitySetHash, mloFlags, ymapHash)
        //
        // IMPORTANT:
        // This fast-path must match `setInstanceMatricesForArchetype()`'s stride detection.
        // If we step the instance buffer with the wrong stride, every instance after the first reads a junk matrix,
        // which manifests as “drawables splattered across the whole screen”.
        const stride =
            ((matricesFloat32.length % 22) === 0) ? 22 :
            (((matricesFloat32.length % 21) === 0) ? 21 :
            (((matricesFloat32.length % 17) === 0) ? 17 : 16));
        if (entry.instanceStrideFloats && entry.instanceStrideFloats !== stride) {
            // Force VAO rebuilds (stride affects instanced attrib layout).
            try {
                for (const sm of entry.submeshes?.values?.() || []) {
                    if (sm?.vao) gl.deleteVertexArray(sm.vao);
                    if (sm) sm.vao = null;
                }
            } catch { /* ignore */ }
        }
        entry.instanceStrideFloats = stride;
        entry.instanceCount = Math.floor(matricesFloat32.length / stride);
        const instanceDataChanged = this._updateInstanceData(entry, matricesFloat32);
        if (instanceDataChanged) this._uploadInstanceBuffer(entry, matricesFloat32);

        if (instanceDataChanged || !entry._instBounds) {
            entry._instBounds = this._computeInstanceBoundsFromMatrices(matricesFloat32);
        }
        return true;
    }

    async setInstancesForBucket(bucketId, lod, file, material, matricesFloat32, minDist = null) {
        const id = String(bucketId || '');
        const l = String(lod || 'high').toLowerCase();
        const f = String(file || '').trim();
        if (!this.ready) return;

        if (!id || !f) return;

        if (!matricesFloat32 || matricesFloat32.length === 0) {
            const old = this.buckets.get(id);
            if (old) {
                try { this.gl.deleteBuffer(old.instanceBuffer); } catch { /* ignore */ }
                try { if (old?.vao) this.gl.deleteVertexArray(old.vao); } catch { /* ignore */ }
            }
            this.buckets.delete(id);
            return;
        }

        const gl = this.gl;
        let entry = this.buckets.get(id);
        if (!entry) {
            entry = {
                bucketId: id,
                lod: l,
                file: f,
                material: material ?? null,
                minDist: null,
                instanceBuffer: gl.createBuffer(),
                instanceBufferBytes: 0,
                instanceCount: 0,
                mesh: null,
                vao: null,
            };
            this.buckets.set(id, entry);
        } else {
            entry.lod = l;
            entry.file = f;
            entry.material = material ?? entry.material;
        }

        {
            const d = Number(minDist);
            if (Number.isFinite(d)) entry.minDist = d;
        }

        // See `setInstanceMatricesForArchetype()` for layout details.
        // Buckets can also receive v4 (22-float) instance buffers from the worker.
        const stride =
            ((matricesFloat32.length % 22) === 0) ? 22 :
            (((matricesFloat32.length % 21) === 0) ? 21 :
            (((matricesFloat32.length % 17) === 0) ? 17 : 16));
        if (entry.instanceStrideFloats && entry.instanceStrideFloats !== stride) {
            try { if (entry.vao) gl.deleteVertexArray(entry.vao); } catch { /* ignore */ }
            entry.vao = null;
        }
        entry.instanceStrideFloats = stride;
        entry.instanceCount = Math.floor(matricesFloat32.length / stride);
        const instanceDataChanged = this._updateInstanceData(entry, matricesFloat32);
        if (instanceDataChanged) this._uploadInstanceBuffer(entry, matricesFloat32);

        // Cache conservative instance translation bounds + max scale (data space) for occlusion.
        if (instanceDataChanged || !entry._instBounds) {
            entry._instBounds = this._computeInstanceBoundsFromMatrices(matricesFloat32);
        }

        // Ensure mesh will be loaded (throttled).
        this._enqueueMeshLoad(id, f);
    }

    _enqueueMeshLoad(entryKey, file, opts = {}) {
        const ek = String(entryKey || '');
        const f = String(file || '');
        if (!ek || !f) return;
        const pendKey = `${ek}:${f}`;

        // Archetype instance path
        const entry = this.instances.get(ek);
        if (entry) {
            const sm = entry.submeshes?.get?.(f);
            if (!sm) return;
            if (sm.mesh && !this.modelManager?.isMeshDisposed?.(sm.mesh)) return;
        } else {
            // Bucket path
            const b = this.buckets.get(ek);
            if (!b) return;
            if (b.mesh && !this.modelManager?.isMeshDisposed?.(b.mesh)) return;
        }

        if (this._meshLoadPending.has(pendKey)) return;
        this._meshLoadPending.add(pendKey);
        // Prefer nearer meshes first so the area around the camera fills in ASAP.
        let dist = Number.POSITIVE_INFINITY;
        try {
            const e = this.instances.get(ek);
            if (e && Number.isFinite(Number(e.minDist))) dist = Number(e.minDist);
            const b = this.buckets.get(ek);
            if (b && Number.isFinite(Number(b.minDist))) dist = Math.min(dist, Number(b.minDist));
        } catch { /* ignore */ }
        const seq = (this._meshLoadSeq++ >>> 0);
        const priority = Number(opts?.priority);
        this._meshLoadQueue.push({
            entryKey: ek,
            file: f,
            dist,
            seq,
            priority: Number.isFinite(priority) ? priority : 0,
        });
    }

    _pumpMeshLoads() {
        if (!this.modelManager) return;
        while (this._meshLoadsInFlight < this.maxMeshLoadsInFlight && this._meshLoadQueue.length > 0) {
            // Pick the closest job first (stable by seq).
            let bestIdx = 0;
            let best = this._meshLoadQueue[0];
            for (let i = 1; i < this._meshLoadQueue.length; i++) {
                const j = this._meshLoadQueue[i];
                if (!j) continue;
                const jd = Number(j.dist);
                const bd = Number(best?.dist);
                const dOk = Number.isFinite(jd);
                const bOk = Number.isFinite(bd);
                const jp = Number(j?.priority) || 0;
                const bp = Number(best?.priority) || 0;
                if (
                    jp > bp ||
                    (jp === bp && (
                        (dOk && !bOk) ||
                        (dOk && bOk && jd < bd) ||
                        (jd === bd && (Number(j.seq) < Number(best?.seq)))
                    ))
                ) {
                    bestIdx = i;
                    best = j;
                }
            }
            const job = this._meshLoadQueue.splice(bestIdx, 1)[0];
            if (!job) break;
            const { entryKey, file } = job;
            const pendKey = `${entryKey}:${file}`;
            const entry = this.instances.get(entryKey);
            const sm = entry?.submeshes?.get?.(file);
            const bucket = this.buckets.get(entryKey);
            if (entry) {
                if (!sm || (sm.mesh && !this.modelManager?.isMeshDisposed?.(sm.mesh))) {
                    this._meshLoadPending.delete(pendKey);
                    continue;
                }
            } else {
                if (!bucket || (bucket.mesh && !this.modelManager?.isMeshDisposed?.(bucket.mesh))) {
                    this._meshLoadPending.delete(pendKey);
                    continue;
                }
            }

            this._meshLoadsInFlight++;
            (async () => {
                try {
                    const requiresBlendAttributes = !!(
                        this.meshLoadOptions?.requireBlendAttributes && sm?.skinned
                    );
                    const mesh = await this.modelManager.loadMeshFile(file, {
                        usePersistentCache: this.meshLoadOptions?.usePersistentCache !== false,
                        cacheBust: this.meshLoadOptions?.cacheBust || '',
                        requireBlendAttributes: requiresBlendAttributes,
                    });
                    if (!mesh) return;

                    // Assign mesh + build VAO for whichever kind of entry is present.
                    const e = this.instances.get(entryKey);
                    const sm2 = e?.submeshes?.get?.(file);
                    const b = this.buckets.get(entryKey);

                    if (e && sm2) {
                        sm2.mesh = mesh;
                        // Build a per-submesh VAO that includes instancing attributes.
                        try {
                            const gl = this.gl;
                            const vao = gl.createVertexArray();
                            gl.bindVertexArray(vao);

                            gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posBuffer);
                            gl.enableVertexAttribArray(0);
                            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

                            if (mesh.nrmBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.nrmBuffer);
                                gl.enableVertexAttribArray(1);
                                gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
                            }

                            if (mesh.uvBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvBuffer);
                                gl.enableVertexAttribArray(2);
                                gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
                            }
                            // aTexcoord1: location 9 (fallback to uv0 if absent)
                            if (mesh.uv1Buffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uv1Buffer);
                                gl.enableVertexAttribArray(9);
                                gl.vertexAttribPointer(9, 2, gl.FLOAT, false, 0, 0);
                            } else if (mesh.uvBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvBuffer);
                                gl.enableVertexAttribArray(9);
                                gl.vertexAttribPointer(9, 2, gl.FLOAT, false, 0, 0);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(9);
                                    gl.vertexAttrib2f(9, 0.0, 0.0);
                                } catch { /* ignore */ }
                            }
                            // aTexcoord2: location 10 (fallback to uv0 if uv2 absent)
                            if (mesh.uv2Buffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uv2Buffer);
                                gl.enableVertexAttribArray(10);
                                gl.vertexAttribPointer(10, 2, gl.FLOAT, false, 0, 0);
                            } else if (mesh.uvBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvBuffer);
                                gl.enableVertexAttribArray(10);
                                gl.vertexAttribPointer(10, 2, gl.FLOAT, false, 0, 0);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(10);
                                    gl.vertexAttrib2f(10, 0.0, 0.0);
                                } catch { /* ignore */ }
                            }

                            if (mesh.tanBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.tanBuffer);
                                gl.enableVertexAttribArray(3);
                                gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 0, 0);
                            } else {
                                // CodeWalker-style: when the vertex format has no tangent, shaders use a constant fallback.
                                // Our viewer uses a single shader that always declares aTangent, so provide a constant
                                // attribute value (and disable array sourcing) to avoid stale bindings.
                                try {
                                    gl.disableVertexAttribArray(3);
                                    // CW often uses `float3 btang = 0.5;` (i.e. vec3(0.5)), w is handedness (1).
                                    gl.vertexAttrib4f(3, 0.5, 0.5, 0.5, 1.0);
                                } catch { /* ignore */ }
                            }

                            if (mesh.col0Buffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.col0Buffer);
                                gl.enableVertexAttribArray(8);
                                gl.vertexAttribPointer(8, 4, gl.UNSIGNED_BYTE, true, 0, 0);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(8);
                                    gl.vertexAttrib4f(8, 1.0, 1.0, 1.0, 1.0);
                                } catch { /* ignore */ }
                            }

                            // aColor1: location 11 (optional; required for terrain_cb_* blending + some tint modes)
                            if (mesh.col1Buffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.col1Buffer);
                                gl.enableVertexAttribArray(11);
                                gl.vertexAttribPointer(11, 4, gl.UNSIGNED_BYTE, true, 0, 0);
                            } else {
                                // Provide a stable default so shaders don't read stale state.
                                // Note: default vertex attrib is (0,0,0,1) when disabled; set explicitly anyway.
                                try {
                                    gl.disableVertexAttribArray(11);
                                    gl.vertexAttrib4f(11, 0.0, 0.0, 0.0, 1.0);
                                } catch { /* ignore */ }
                            }

                            if (mesh.blendWeightsBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.blendWeightsBuffer);
                                gl.enableVertexAttribArray(13);
                                gl.vertexAttribPointer(13, 4, gl.UNSIGNED_BYTE, true, 0, 0);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(13);
                                    gl.vertexAttrib4f(13, 1.0, 0.0, 0.0, 0.0);
                                } catch { /* ignore */ }
                            }

                            if (mesh.blendIndicesBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.blendIndicesBuffer);
                                gl.enableVertexAttribArray(14);
                                gl.vertexAttribPointer(14, 4, gl.UNSIGNED_BYTE, false, 0, 0);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(14);
                                    gl.vertexAttrib4f(14, 0.0, 0.0, 0.0, 0.0);
                                } catch { /* ignore */ }
                            }

                            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.idxBuffer);

                            gl.bindBuffer(gl.ARRAY_BUFFER, e.instanceBuffer);
                            const strideFloats = Number(e.instanceStrideFloats ?? 16);
                            const bytesPerMat = Math.max(16, strideFloats) * 4;
                            const bytesPerVec4 = 4 * 4;
                            for (let i = 0; i < 4; i++) {
                                const loc = 4 + i;
                                gl.enableVertexAttribArray(loc);
                                gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, bytesPerMat, i * bytesPerVec4);
                                gl.vertexAttribDivisor(loc, 1);
                            }
                            // Optional tint index at location 12.
                            if (strideFloats >= 17) {
                                gl.enableVertexAttribArray(12);
                                gl.vertexAttribPointer(12, 1, gl.FLOAT, false, bytesPerMat, 16 * 4);
                                gl.vertexAttribDivisor(12, 1);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(12);
                                    gl.vertexAttrib1f(12, 0.0);
                                } catch { /* ignore */ }
                            }

                            gl.bindVertexArray(null);
                            sm2.vao = vao;
                        } catch {
                            sm2.vao = null;
                        }
                    } else if (b) {
                        b.mesh = mesh;
                        try {
                            const gl = this.gl;
                            const vao = gl.createVertexArray();
                            gl.bindVertexArray(vao);

                            gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posBuffer);
                            gl.enableVertexAttribArray(0);
                            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

                            if (mesh.nrmBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.nrmBuffer);
                                gl.enableVertexAttribArray(1);
                                gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
                            }

                            if (mesh.uvBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvBuffer);
                                gl.enableVertexAttribArray(2);
                                gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
                            }
                            // aTexcoord1: location 9 (fallback to uv0 if absent)
                            if (mesh.uv1Buffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uv1Buffer);
                                gl.enableVertexAttribArray(9);
                                gl.vertexAttribPointer(9, 2, gl.FLOAT, false, 0, 0);
                            } else if (mesh.uvBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvBuffer);
                                gl.enableVertexAttribArray(9);
                                gl.vertexAttribPointer(9, 2, gl.FLOAT, false, 0, 0);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(9);
                                    gl.vertexAttrib2f(9, 0.0, 0.0);
                                } catch { /* ignore */ }
                            }
                            // aTexcoord2: location 10 (fallback to uv0 if uv2 absent)
                            if (mesh.uv2Buffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uv2Buffer);
                                gl.enableVertexAttribArray(10);
                                gl.vertexAttribPointer(10, 2, gl.FLOAT, false, 0, 0);
                            } else if (mesh.uvBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvBuffer);
                                gl.enableVertexAttribArray(10);
                                gl.vertexAttribPointer(10, 2, gl.FLOAT, false, 0, 0);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(10);
                                    gl.vertexAttrib2f(10, 0.0, 0.0);
                                } catch { /* ignore */ }
                            }

                            if (mesh.tanBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.tanBuffer);
                                gl.enableVertexAttribArray(3);
                                gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 0, 0);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(3);
                                    gl.vertexAttrib4f(3, 0.5, 0.5, 0.5, 1.0);
                                } catch { /* ignore */ }
                            }

                            if (mesh.col0Buffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.col0Buffer);
                                gl.enableVertexAttribArray(8);
                                gl.vertexAttribPointer(8, 4, gl.UNSIGNED_BYTE, true, 0, 0);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(8);
                                    gl.vertexAttrib4f(8, 1.0, 1.0, 1.0, 1.0);
                                } catch { /* ignore */ }
                            }

                            // aColor1: location 11 (optional; required for terrain_cb_* blending + some tint modes)
                            if (mesh.col1Buffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.col1Buffer);
                                gl.enableVertexAttribArray(11);
                                gl.vertexAttribPointer(11, 4, gl.UNSIGNED_BYTE, true, 0, 0);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(11);
                                    gl.vertexAttrib4f(11, 0.0, 0.0, 0.0, 1.0);
                                } catch { /* ignore */ }
                            }

                            if (mesh.blendWeightsBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.blendWeightsBuffer);
                                gl.enableVertexAttribArray(13);
                                gl.vertexAttribPointer(13, 4, gl.UNSIGNED_BYTE, true, 0, 0);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(13);
                                    gl.vertexAttrib4f(13, 1.0, 0.0, 0.0, 0.0);
                                } catch { /* ignore */ }
                            }

                            if (mesh.blendIndicesBuffer) {
                                gl.bindBuffer(gl.ARRAY_BUFFER, mesh.blendIndicesBuffer);
                                gl.enableVertexAttribArray(14);
                                gl.vertexAttribPointer(14, 4, gl.UNSIGNED_BYTE, false, 0, 0);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(14);
                                    gl.vertexAttrib4f(14, 0.0, 0.0, 0.0, 0.0);
                                } catch { /* ignore */ }
                            }

                            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.idxBuffer);

                            gl.bindBuffer(gl.ARRAY_BUFFER, b.instanceBuffer);
                            const strideFloats = Number(b.instanceStrideFloats ?? 16);
                            const bytesPerMat = Math.max(16, strideFloats) * 4;
                            const bytesPerVec4 = 4 * 4;
                            for (let i = 0; i < 4; i++) {
                                const loc = 4 + i;
                                gl.enableVertexAttribArray(loc);
                                gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, bytesPerMat, i * bytesPerVec4);
                                gl.vertexAttribDivisor(loc, 1);
                            }
                            if (strideFloats >= 17) {
                                gl.enableVertexAttribArray(12);
                                gl.vertexAttribPointer(12, 1, gl.FLOAT, false, bytesPerMat, 16 * 4);
                                gl.vertexAttribDivisor(12, 1);
                            } else {
                                try {
                                    gl.disableVertexAttribArray(12);
                                    gl.vertexAttrib1f(12, 0.0);
                                } catch { /* ignore */ }
                            }

                            gl.bindVertexArray(null);
                            b.vao = vao;
                        } catch {
                            b.vao = null;
                        }
                    }
                } finally {
                    this._meshLoadsInFlight--;
                    this._meshLoadPending.delete(pendKey);
                }
            })();
        }
    }

    /**
     * Let App drive mesh loading during a non-rendering loading phase.
     * (Render() also calls this, but we want to warm the cache before first frame.)
     */
    pumpMeshLoadsOnce() {
        this._pumpMeshLoads();
    }

    getMeshLoadStats() {
        return {
            inFlight: this._meshLoadsInFlight,
            queued: this._meshLoadQueue.length,
            pending: this._meshLoadPending.size,
            maxInFlight: this.maxMeshLoadsInFlight,
        };
    }

    /**
     * Best-effort: scan currently-instanced submeshes and prefetch diffuse textures.
     * This is capped to avoid doing huge work on boot.
     */
    prefetchDiffuseTextures(limit = 256, { allowIndexMiss = false, includeSecondary = false } = {}) {
        if (!this.textureStreamer) return 0;
        const cap = Number.isFinite(limit) ? Math.max(0, Math.min(4096, Math.floor(limit))) : 256;
        if (cap <= 0) return 0;
        let n = 0;
        const toUrl = (rel) => this._chooseTextureUrl(rel, { allowIndexMiss });
        const seen = new Set();
        const diffuseKindForMat = (mat) => {
            const s = String(mat?.shaderName || '').toLowerCase();
            const fam = String(mat?.shaderFamily || '').toLowerCase();
            const am = String(mat?.alphaMode || '').toLowerCase();
            if (fam === 'basic' && (am === 'cutout' || s.includes('cutout')) && (
                s.includes('trees_') || s.includes('branches') || s.includes('leaf') || s.includes('leaves') || s.includes('foliage')
            )) return 'foliageDiffuse';
            return 'diffuse';
        };
        const touchTexture = (rel, distance, kind = 'diffuse') => {
            const url = toUrl(rel);
            // Index-gated misses are not fetchable. Do not let them consume the
            // warmup budget and delay textures that actually exist.
            if (!url) return false;
            const key = `${String(kind || 'diffuse').toLowerCase()}|${String(url)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            this.textureStreamer.touch(url, {
                distance,
                kind,
                priority: distance <= this.textureStreamer.highDist ? 'high' : 'low',
            });
            n++;
            return n >= cap;
        };
        const touchMaterialTextures = (mat, distance) => {
            if (!mat) return false;
            if (mat.diffuse && touchTexture(mat.diffuse, distance, diffuseKindForMat(mat))) return true;
            if (!includeSecondary) return false;
            const slots = [
                ['diffuse2', 'diffuse2'],
                ['tintPalette', 'tintPalette'],
                ['alphaMask', 'alphaMask'],
                ['normal', 'normal'],
                ['detail', 'detail'],
                ['spec', 'spec'],
                ['emissive', 'emissive'],
                ['ao', 'ao'],
                ['height', 'height'],
                ['env', 'env'],
                ['dirt', 'dirt'],
                ['damage', 'damage'],
                ['damageMask', 'damageMask'],
                ['puddleMask', 'puddleMask'],
            ];
            for (const [slot, kind] of slots) {
                const rel = mat?.[slot];
                if (rel && touchTexture(rel, distance, kind)) return true;
            }
            return false;
        };

        // IMPORTANT:
        // - When cross-archetype instancing is enabled, most geometry is rendered via `buckets`.
        // - When it's disabled, geometry is rendered via per-archetype `instances`.
        // Prefetch must scan BOTH, otherwise you can see lots of meshes but 0 texture requests.

        // 1) Buckets (cross-archetype instancing path)
        const buckets = Array.from(this.buckets.values())
            .filter((b) => !!b)
            .sort((a, b) => Number(a.minDist ?? Infinity) - Number(b.minDist ?? Infinity));
        for (const b of buckets) {
            if (!b) continue;
            const mat = b.material || null;
            const distance = Number.isFinite(Number(b.minDist)) ? Number(b.minDist) : 1e30;
            if (touchMaterialTextures(mat, distance)) return n;
        }

        // 2) Instances (per-archetype path)
        // Per-archetype instances are the default path. Map insertion order is
        // unrelated to distance, so prefetching it directly made nearby materials
        // wait behind arbitrary distant archetypes.
        const instances = Array.from(this.instances.values())
            .filter((entry) => !!entry && entry.instanceCount > 0)
            .sort((a, b) => Number(a.minDist ?? Infinity) - Number(b.minDist ?? Infinity));
        for (const entry of instances) {
            if (!entry || entry.instanceCount <= 0) continue;
            for (const sm of entry.submeshes?.values?.() || []) {
                if (!sm) continue;
                const mat = sm.material || null;
                const distance = Number.isFinite(Number(entry.minDist)) ? Number(entry.minDist) : 1e30;
                if (touchMaterialTextures(mat, distance)) return n;
            }
        }
        return n;
    }

    render(viewProjectionMatrix, enabled = true, cameraPos = [0, 0, 0], fog = { enabled: false, color: [0.6, 0.7, 0.8], start: 1500, end: 9000 }) {
        if (!enabled || !this.ready) return;
        const gl = this.gl;
        const wireframe = !!fog?.wireframe;
        const fastStateRestore = !!fog?.fastStateRestore;
        this._fastTextureUnitRestore = fastStateRestore;
        const alphaToCoverageEnabled = fog?.alphaToCoverageEnabled !== false;
        // IMPORTANT (stability):
        // A single bad drawable (or a GL error that forces an early exit) must NOT leak state into the rest of
        // the frame. State leaks (colorMask/depthMask/blend/etc) are a classic cause of "the whole screen greys out"
        // or "stale frames" once models start drawing.
        let _restoreState = null;
        try {
            if (fastStateRestore) {
                const restoreFbo = ('restoreFramebuffer' in Object(fog || {})) ? fog.restoreFramebuffer : null;
                const restoreW = Math.max(1, Math.floor(Number(fog?.restoreViewportWidth ?? fog?.viewportWidth ?? gl.canvas?.width) || 1));
                const restoreH = Math.max(1, Math.floor(Number(fog?.restoreViewportHeight ?? fog?.viewportHeight ?? gl.canvas?.height) || 1));
                _restoreState = () => {
                    try { gl.bindVertexArray(null); } catch { /* ignore */ }
                    try { gl.bindFramebuffer(gl.FRAMEBUFFER, restoreFbo || null); } catch { /* ignore */ }
                    try { gl.viewport(0, 0, restoreW, restoreH); } catch { /* ignore */ }
                    try { gl.colorMask(true, true, true, true); } catch { /* ignore */ }
                    try { gl.depthMask(true); } catch { /* ignore */ }
                    try { gl.enable(gl.DEPTH_TEST); } catch { /* ignore */ }
                    try { gl.depthFunc(gl.LEQUAL); } catch { /* ignore */ }
                    try { gl.disable(gl.CULL_FACE); } catch { /* ignore */ }
                    try { gl.disable(gl.SCISSOR_TEST); } catch { /* ignore */ }
                    try { gl.disable(gl.STENCIL_TEST); } catch { /* ignore */ }
                    try { gl.disable(gl.BLEND); } catch { /* ignore */ }
                    try { gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE); } catch { /* ignore */ }
                    try { gl.disable(gl.POLYGON_OFFSET_FILL); } catch { /* ignore */ }
                    try { gl.useProgram(null); } catch { /* ignore */ }
                };
            } else {
                const prev = {
                    program: null,
                    vao: null,
                    fbo: null,
                    viewport: null,
                    colorMask: null,
                    depthMask: null,
                    depthTest: null,
                    depthFunc: null,
                    blend: null,
                    blendSrcRGB: null,
                    blendDstRGB: null,
                    blendSrcA: null,
                    blendDstA: null,
                    blendEqRGB: null,
                    blendEqA: null,
                    blendColor: null,
                    cull: null,
                    scissor: null,
                    stencil: null,
                    a2c: null,
                    polyOffset: null,
                };
                try { prev.program = gl.getParameter(gl.CURRENT_PROGRAM); } catch { prev.program = null; }
                try { prev.vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING); } catch { prev.vao = null; }
                try { prev.fbo = gl.getParameter(gl.FRAMEBUFFER_BINDING); } catch { prev.fbo = null; }
                try { prev.viewport = gl.getParameter(gl.VIEWPORT); } catch { prev.viewport = null; }
                try { prev.colorMask = gl.getParameter(gl.COLOR_WRITEMASK); } catch { prev.colorMask = null; }
                try { prev.depthMask = gl.getParameter(gl.DEPTH_WRITEMASK); } catch { prev.depthMask = null; }
                try { prev.depthTest = gl.isEnabled(gl.DEPTH_TEST); } catch { prev.depthTest = null; }
                try { prev.depthFunc = gl.getParameter(gl.DEPTH_FUNC); } catch { prev.depthFunc = null; }
                try { prev.blend = gl.isEnabled(gl.BLEND); } catch { prev.blend = null; }
                try { prev.blendSrcRGB = gl.getParameter(gl.BLEND_SRC_RGB); } catch { prev.blendSrcRGB = null; }
                try { prev.blendDstRGB = gl.getParameter(gl.BLEND_DST_RGB); } catch { prev.blendDstRGB = null; }
                try { prev.blendSrcA = gl.getParameter(gl.BLEND_SRC_ALPHA); } catch { prev.blendSrcA = null; }
                try { prev.blendDstA = gl.getParameter(gl.BLEND_DST_ALPHA); } catch { prev.blendDstA = null; }
                try { prev.blendEqRGB = gl.getParameter(gl.BLEND_EQUATION_RGB); } catch { prev.blendEqRGB = null; }
                try { prev.blendEqA = gl.getParameter(gl.BLEND_EQUATION_ALPHA); } catch { prev.blendEqA = null; }
                try { prev.blendColor = gl.getParameter(gl.BLEND_COLOR); } catch { prev.blendColor = null; }
                try { prev.cull = gl.isEnabled(gl.CULL_FACE); } catch { prev.cull = null; }
                try { prev.scissor = gl.isEnabled(gl.SCISSOR_TEST); } catch { prev.scissor = null; }
                try { prev.stencil = gl.isEnabled(gl.STENCIL_TEST); } catch { prev.stencil = null; }
                try { prev.a2c = gl.isEnabled(gl.SAMPLE_ALPHA_TO_COVERAGE); } catch { prev.a2c = null; }
                try { prev.polyOffset = gl.isEnabled(gl.POLYGON_OFFSET_FILL); } catch { prev.polyOffset = null; }

                _restoreState = () => {
                // Try to restore the caller's state; if unavailable, fall back to a safe baseline.
                try { gl.bindVertexArray(null); } catch { /* ignore */ }
                try {
                    const cm = (prev.colorMask && prev.colorMask.length >= 4) ? prev.colorMask : [true, true, true, true];
                    gl.colorMask(!!cm[0], !!cm[1], !!cm[2], !!cm[3]);
                } catch { /* ignore */ }
                try { gl.depthMask(prev.depthMask !== null ? !!prev.depthMask : true); } catch { /* ignore */ }
                try {
                    if (prev.depthTest === false) gl.disable(gl.DEPTH_TEST);
                    else if (prev.depthTest === true) gl.enable(gl.DEPTH_TEST);
                    else gl.enable(gl.DEPTH_TEST);
                } catch { /* ignore */ }
                try { if (prev.depthFunc !== null) gl.depthFunc(prev.depthFunc); } catch { /* ignore */ }
                try {
                    if (prev.blend === true) gl.enable(gl.BLEND);
                    else if (prev.blend === false) gl.disable(gl.BLEND);
                    else gl.disable(gl.BLEND);
                } catch { /* ignore */ }
                // Restore blend funcs/equations (important if we bailed out mid-draw after setting special modes).
                try {
                    if (
                        prev.blendEqRGB !== null && prev.blendEqA !== null &&
                        prev.blendSrcRGB !== null && prev.blendDstRGB !== null &&
                        prev.blendSrcA !== null && prev.blendDstA !== null
                    ) {
                        gl.blendEquationSeparate(prev.blendEqRGB, prev.blendEqA);
                        gl.blendFuncSeparate(prev.blendSrcRGB, prev.blendDstRGB, prev.blendSrcA, prev.blendDstA);
                    }
                } catch { /* ignore */ }
                try {
                    const bc = prev.blendColor;
                    if (bc && bc.length >= 4) gl.blendColor(Number(bc[0]) || 0, Number(bc[1]) || 0, Number(bc[2]) || 0, Number(bc[3]) || 0);
                } catch { /* ignore */ }
                try {
                    if (prev.cull === true) gl.enable(gl.CULL_FACE);
                    else if (prev.cull === false) gl.disable(gl.CULL_FACE);
                } catch { /* ignore */ }
                try {
                    if (prev.scissor === true) gl.enable(gl.SCISSOR_TEST);
                    else if (prev.scissor === false) gl.disable(gl.SCISSOR_TEST);
                } catch { /* ignore */ }
                try {
                    if (prev.stencil === true) gl.enable(gl.STENCIL_TEST);
                    else if (prev.stencil === false) gl.disable(gl.STENCIL_TEST);
                } catch { /* ignore */ }
                try {
                    if (prev.a2c === true) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
                    else if (prev.a2c === false) gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
                    else gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
                } catch { /* ignore */ }
                try {
                    if (prev.polyOffset === true) gl.enable(gl.POLYGON_OFFSET_FILL);
                    else if (prev.polyOffset === false) gl.disable(gl.POLYGON_OFFSET_FILL);
                    else gl.disable(gl.POLYGON_OFFSET_FILL);
                } catch { /* ignore */ }
                try { gl.bindFramebuffer(gl.FRAMEBUFFER, prev.fbo); } catch { /* ignore */ }
                try {
                    if (prev.viewport && prev.viewport.length >= 4) gl.viewport(prev.viewport[0], prev.viewport[1], prev.viewport[2], prev.viewport[3]);
                } catch { /* ignore */ }
                try { gl.useProgram(prev.program); } catch { /* ignore */ }
                try { if (prev.vao) gl.bindVertexArray(prev.vao); } catch { /* ignore */ }
                };
            }
        } catch {
            _restoreState = null;
        }

        try {
            gl.useProgram(this.program.program);
            try {
                gl.enable(gl.DEPTH_TEST);
                gl.depthFunc(gl.LEQUAL);
                gl.disable(gl.SCISSOR_TEST);
                gl.disable(gl.STENCIL_TEST);
            } catch { /* ignore */ }

            // Keep mesh loads flowing but bounded.
            this._pumpMeshLoads();

            const occlusion = fog?.occlusion || null;
            const viewportWidth = Number(fog?.viewportWidth ?? 0);
            const viewportHeight = Number(fog?.viewportHeight ?? 0);
            this._occlusionStats.tested = 0;
            this._occlusionStats.culled = 0;

        const shouldDrawByOcclusion = (instBounds, radiusSafe, occlusionKey = null) => {
            if (!occlusion || typeof occlusion.isVisibleSphere !== 'function') return true;
            if (!instBounds) return true;
            if (!(viewportWidth > 2 && viewportHeight > 2)) return true;
            const r0 = Number(radiusSafe);
            if (!Number.isFinite(r0) || r0 <= 0) return true;

            const minT = instBounds.minT;
            const maxT = instBounds.maxT;
            const cx = (minT[0] + maxT[0]) * 0.5;
            const cy = (minT[1] + maxT[1]) * 0.5;
            const cz = (minT[2] + maxT[2]) * 0.5;
            const ex = (maxT[0] - minT[0]) * 0.5;
            const ey = (maxT[1] - minT[1]) * 0.5;
            const ez = (maxT[2] - minT[2]) * 0.5;

            // Spread radius from the translation AABB (covers all instances).
            const spread = Math.sqrt(ex * ex + ey * ey + ez * ez);
            const r = spread + r0 * (Number(instBounds.maxScale ?? 1) || 1);

            // Data -> viewer space (modelMatrix is rotation only).
            const v4 = glMatrix.vec4.fromValues(cx, cy, cz, 1.0);
            const out = glMatrix.vec4.create();
            glMatrix.vec4.transformMat4(out, v4, this.modelMatrix);

            this._occlusionStats.tested++;
            const vis = occlusion.isVisibleSphere({
                center: [out[0], out[1], out[2]],
                radius: r,
                viewProjectionMatrix,
                viewportWidth,
                viewportHeight,
                key: occlusionKey,
            });
            if (!vis) this._occlusionStats.culled++;
            return !!vis;
        };

            gl.uniformMatrix4fv(this.uniforms.uViewProjectionMatrix, false, viewProjectionMatrix);
            gl.uniformMatrix4fv(this.uniforms.uModelMatrix, false, this.modelMatrix);
            const gpuFrustumCulling = !!(fog && fog.gpuFrustumCulling && viewProjectionMatrix);
            if (gpuFrustumCulling) {
                try {
                    glMatrix.mat4.multiply(this._gpuCullVpData, viewProjectionMatrix, this.modelMatrix);
                    const planes = extractFrustumPlanes(this._gpuCullVpData, this._gpuCullPlanes);
                    const flat = this._gpuCullPlanesFlat;
                    for (let i = 0; i < 6; i++) {
                        const p = planes[i];
                        flat[i * 4 + 0] = Number(p?.[0]) || 0;
                        flat[i * 4 + 1] = Number(p?.[1]) || 0;
                        flat[i * 4 + 2] = Number(p?.[2]) || 0;
                        flat[i * 4 + 3] = Number(p?.[3]) || 0;
                    }
                    gl.uniform1i(this.uniforms.uGpuFrustumCulling, 1);
                    gl.uniform4fv(this.uniforms.uGpuFrustumPlanes, flat);
                } catch {
                    gl.uniform1i(this.uniforms.uGpuFrustumCulling, 0);
                }
            } else {
                gl.uniform1i(this.uniforms.uGpuFrustumCulling, 0);
            }
            gl.uniform1f(this.uniforms.uGpuCullRadius, 0.0);
        // CodeWalker BasicPS uses the sampled diffuse (and tint paths) directly; it does NOT apply a global
        // constant "base color" multiply. Using a non-white default here washes the whole scene.
        gl.uniform3fv(this.uniforms.uColor, [1.0, 1.0, 1.0]);
        try { gl.uniform1i(this.uniforms.uVertexColorMode, 0); } catch { /* ignore */ }
        try { gl.uniform1i(this.uniforms.uDoubleSidedLighting, 0); } catch { /* ignore */ }
        // Lighting inputs: allow App to pass HDR-ish sunlight settings via fog.lightDir/lightColor/ambientIntensity.
        // Defaults remain stable for older callers.
        const ld = (fog && Array.isArray(fog.lightDir) && fog.lightDir.length >= 3)
            ? [Number(fog.lightDir[0]) || 0, Number(fog.lightDir[1]) || 0, Number(fog.lightDir[2]) || 0]
            : [0.4, 0.85, 0.2];
        const wantsLinearOut = (fog && fog.outputSrgb === false);
        const lcHdr = (fog && Array.isArray(fog.lightColor) && fog.lightColor.length >= 3)
            ? [Number(fog.lightColor[0]) || 1, Number(fog.lightColor[1]) || 1, Number(fog.lightColor[2]) || 1]
            : [1.0, 1.0, 1.0];
        // IMPORTANT:
        // - When outputSrgb=true (no PostFX), our shader encodes to sRGB and the canvas clamps to [0..1].
        //   Feeding HDR lightColor (>1) makes the frame look "blown out/broken" as soon as models render.
        // - When outputSrgb=false (PostFX), the scene is linear/HDR and tonemapped later, so lightColor can be HDR.
        const lc = wantsLinearOut ? lcHdr : [1.0, 1.0, 1.0];
        const amb = (fog && Number.isFinite(Number(fog.ambientIntensity)))
            ? Math.max(0.0, Math.min(10.0, Number(fog.ambientIntensity)))
            : 0.6;
        gl.uniform3fv(this.uniforms.uLightDir, ld);
        try { gl.uniform3fv(this.uniforms.uLightColor, lc); } catch { /* ignore */ }
        gl.uniform1f(this.uniforms.uAmbient, amb);

        // --- Directional shadow map (optional) ---
        const shadowEnabled = !!(fog && fog.shadowEnabled);
        const shadowSize = Number(fog?.shadowMapSize ?? 2048);
        const shadowBias = Number(fog?.shadowBias ?? 0.0015);
        const shadowNormalBias = Number(fog?.shadowNormalBias ?? 0.0035);
        const shadowDarkness = Number(fog?.shadowDarkness ?? 1.0);
        const shadowPcf = Number(fog?.shadowPcfRadius ?? 1.0);
        const shadowOrthoHalf = Number(fog?.shadowOrthoHalfSize ?? 1200.0);
        const shadowLightDist = Number(fog?.shadowLightDistance ?? (shadowOrthoHalf * 2.0));
        const shadowFar = Number(fog?.shadowFar ?? (shadowOrthoHalf * 6.0));

        let shadowOk = false;
        let lightVP = glMatrix.mat4.create();
        if (shadowEnabled && this._shadowProgram?.program) {
            if (this._ensureShadowMap(shadowSize)) {
                lightVP = this._computeDirectionalLightViewProj(ld, cameraPos, { orthoHalfSize: shadowOrthoHalf, lightDistance: shadowLightDist, far: shadowFar });
                glMatrix.mat4.copy(this._shadow.lightViewProj, lightVP);
                shadowOk = true;
            }
        }
        // Always set (VS needs it for vLightSpacePos, but shadow sampling is gated by uShadowEnabled).
        try { gl.uniformMatrix4fv(this.uniforms.uLightViewProj, false, shadowOk ? lightVP : glMatrix.mat4.create()); } catch { /* ignore */ }
        try { gl.uniform1i(this.uniforms.uShadowEnabled, shadowOk ? 1 : 0); } catch { /* ignore */ }
        try { gl.uniform4fv(this.uniforms.uShadowParams, [shadowBias, shadowNormalBias, shadowDarkness, shadowPcf]); } catch { /* ignore */ }
        {
            const s = shadowOk ? this._shadow.size : 1;
            try { gl.uniform2fv(this.uniforms.uShadowTexel, [1.0 / Math.max(1, s), 1.0 / Math.max(1, s)]); } catch { /* ignore */ }
        }
        // Default UV scale/offset if not present in manifest.
        gl.uniform4fv(this.uniforms.uUv0ScaleOffset, [1.0, 1.0, 0.0, 0.0]);
        gl.uniform4fv(this.uniforms.uUv1ScaleOffset, [1.0, 1.0, 0.0, 0.0]);
        gl.uniform4fv(this.uniforms.uUv2ScaleOffset, [1.0, 1.0, 0.0, 0.0]);
        // Default: assume UV1 absent until set per-draw item (prevents bogus mask sampling).
        if (this.uniforms.uMeshHasUv1) gl.uniform1i(this.uniforms.uMeshHasUv1, 0);
        // Default CodeWalker GlobalUVAnim (identity).
        gl.uniform3fv(this.uniforms.uGlobalAnimUV0, [1.0, 0.0, 0.0]);
        gl.uniform3fv(this.uniforms.uGlobalAnimUV1, [0.0, 1.0, 0.0]);
        const characterLocomotion = fog?.characterLocomotion || null;
        const characterMove01 = Math.max(0.0, Math.min(1.0, Number(characterLocomotion?.move01) || 0.0));
        const characterPhase = Number.isFinite(Number(characterLocomotion?.phase)) ? Number(characterLocomotion.phase) : 0.0;
        const characterStride = Math.max(0.35, Math.min(1.35, Number(characterLocomotion?.stride) || 1.0));
        const characterEnabled = !!characterLocomotion?.enabled && characterMove01 > 0.005;
        this._updateSkinningPose({
            enabled: characterEnabled,
            move01: characterMove01,
            phase: characterPhase,
            stride: characterStride,
            gait: String(characterLocomotion?.gait || ''),
            combat: characterLocomotion?.combat || null,
            gesture: characterLocomotion?.gesture || null,
        });
        try {
            gl.uniform4fv(this.uniforms.uCharacterLocomotion, [characterEnabled ? 1.0 : 0.0, characterMove01, characterPhase, characterStride]);
        } catch { /* ignore */ }
        try { gl.uniform1i(this.uniforms.uSkinningEnabled, 0); } catch { /* ignore */ }

        // Defaults for optional maps.
        gl.uniform1i(this.uniforms.uHasNormal, 0);
        gl.uniform1f(this.uniforms.uNormalScale, 1.0);
        gl.uniform1i(this.uniforms.uNormalUvSet, 0);
        gl.uniform1i(this.uniforms.uDiffuseUvSet, 0);
        gl.uniform1i(this.uniforms.uHasSpec, 0);
        gl.uniform1f(this.uniforms.uSpecularIntensity, 0.25);
        gl.uniform1f(this.uniforms.uSpecularPower, 24.0);
        gl.uniform1f(this.uniforms.uSpecularFalloffMult, 1.0);
        gl.uniform3fv(this.uniforms.uSpecMaskWeights, [1.0, 0.0, 0.0]);
        gl.uniform1f(this.uniforms.uSpecularFresnel, 0.0);
        gl.uniform1i(this.uniforms.uSpecUvSet, 0);
        gl.uniform1i(this.uniforms.uHasEmissive, 0);
        gl.uniform1f(this.uniforms.uEmissiveIntensity, 1.0);
        gl.uniform1i(this.uniforms.uEmissiveUvSet, 0);
        gl.uniform1i(this.uniforms.uAlphaMode, 0);
        gl.uniform1f(this.uniforms.uAlphaCutoff, 0.33);
        gl.uniform1f(this.uniforms.uAlphaScale, 1.0);
        gl.uniform1f(this.uniforms.uHardAlphaBlend, 0.0);
        try { gl.uniform1i(this.uniforms.uIsDistMap, 0); } catch { /* ignore */ }
        try { gl.uniform1f(this.uniforms.uTime, 0.0); } catch { /* ignore */ }
        try { gl.uniform1i(this.uniforms.uWaterMode, 0); } catch { /* ignore */ }
        try { gl.uniform1f(this.uniforms.uRippleSpeed, 0.0); } catch { /* ignore */ }
        try { gl.uniform1f(this.uniforms.uRippleScale, 1.0); } catch { /* ignore */ }
        try { gl.uniform1f(this.uniforms.uRippleBumpiness, 0.5); } catch { /* ignore */ }
        // Water (CodeWalker parity inputs): safe defaults so shaders don't see undefined uniforms.
        try { gl.uniform1i(this.uniforms.uWaterEnableTexture, 1); } catch { /* ignore */ }
        try { gl.uniform1i(this.uniforms.uWaterEnableBumpMap, 1); } catch { /* ignore */ }
        try { gl.uniform1i(this.uniforms.uWaterEnableFoamMap, 0); } catch { /* ignore */ }
        try { gl.uniform1i(this.uniforms.uWaterEnableFlow, 1); } catch { /* ignore */ }
        try { gl.uniform1i(this.uniforms.uWaterEnableFogtex, 0); } catch { /* ignore */ }
        try { gl.uniform4fv(this.uniforms.uWaterFlowParams, [1.0, 1.0, 1.0, 1.0]); } catch { /* ignore */ }
        try { gl.uniform4fv(this.uniforms.uWaterFogParams, [0.0, 0.0, 0.0, 0.0]); } catch { /* ignore */ }
        gl.uniform1i(this.uniforms.uHasDiffuse2, 0);
        gl.uniform1i(this.uniforms.uHasDetail, 0);
        gl.uniform4fv(this.uniforms.uDetailSettings, [0.0, 0.0, 1.0, 1.0]);
        gl.uniform1i(this.uniforms.uDetailUvSet, 0);
        gl.uniform1i(this.uniforms.uHasAO, 0);
        gl.uniform1f(this.uniforms.uAOStrength, 1.0);
        gl.uniform1i(this.uniforms.uAOUvSet, 0);
        // Defaults; updated per-frame/per-draw as needed.
        gl.uniform1i(this.uniforms.uDecodeDiffuseSrgb, 0);
        gl.uniform1i(this.uniforms.uDecodeDiffuse2Srgb, 0);
        gl.uniform1i(this.uniforms.uDecodeEmissiveSrgb, 0);
        gl.uniform1i(this.uniforms.uOutputSrgb, 1);
        gl.uniform1i(this.uniforms.uNormalEncoding, 0);
        gl.uniform1i(this.uniforms.uNormalReconstructZ, 1);
        gl.uniform1i(this.uniforms.uShaderFamily, 0);
        try { gl.uniform1i(this.uniforms.uTerrainMaskMode, 0); } catch { /* ignore */ }
        gl.uniform1i(this.uniforms.uHasAlphaMask, 0);
        try { gl.uniform1i(this.uniforms.uDecalMode, 1); } catch { /* ignore */ }
        try { gl.uniform1i(this.uniforms.uHasDecalAlphaMaskVec, 0); } catch { /* ignore */ }
        try { gl.uniform4fv(this.uniforms.uDecalAlphaMaskVec, [0.0, 0.0, 0.0, 0.0]); } catch { /* ignore */ }
        gl.uniform1f(this.uniforms.uReflectionIntensity, 0.6);
        gl.uniform1f(this.uniforms.uFresnelPower, 5.0);
        gl.uniform3fv(this.uniforms.uEnvColor, fog?.color || [0.6, 0.7, 0.8]);
        gl.uniform1i(this.uniforms.uHasEnvMap, 0);
        gl.uniform1i(this.uniforms.uDecodeEnvSrgb, 0);
        gl.uniform1i(this.uniforms.uFlipEnvY, 0);

        // Tint/dirt/damage/puddles defaults
        gl.uniform1i(this.uniforms.uEnableTintPalette, 0);
        try { gl.uniform1i(this.uniforms.uTintMode, 0); } catch { /* ignore */ }
        gl.uniform3fv(this.uniforms.uDecalTint, [1.0, 1.0, 1.0]);
        gl.uniform1i(this.uniforms.uHasDirt, 0);
        gl.uniform1f(this.uniforms.uDirtLevel, 0.0);
        gl.uniform3fv(this.uniforms.uDirtColor, [0.65, 0.62, 0.6]);
        gl.uniform1i(this.uniforms.uFlipDirtY, 0);
        gl.uniform1i(this.uniforms.uHasDamage, 0);
        gl.uniform1i(this.uniforms.uHasDamageMask, 0);
        gl.uniform1i(this.uniforms.uFlipDamageY, 0);
        gl.uniform1i(this.uniforms.uFlipDamageMaskY, 0);
        gl.uniform1i(this.uniforms.uHasPuddleMask, 0);
        gl.uniform1i(this.uniforms.uFlipPuddleMaskY, 0);
        gl.uniform4fv(this.uniforms.uPuddleParams, [0.0, 0.0, 0.0, 0.0]);
        gl.uniform4fv(this.uniforms.uPuddleScaleRange, [1.0, 1.0, 1.0, 1.0]);

        gl.uniform1i(this.uniforms.uHasHeight, 0);
        gl.uniform2fv(this.uniforms.uParallaxScaleBias, [0.0, 0.0]);
        gl.uniform1f(this.uniforms.uWetness, 0.0);
        gl.uniform1f(this.uniforms.uWetDarken, 0.0);
        gl.uniform1f(this.uniforms.uWetSpecBoost, 1.0);

        gl.uniform3fv(this.uniforms.uCameraPos, cameraPos);
        gl.uniform1i(this.uniforms.uFogEnabled, fog?.enabled ? 1 : 0);
        gl.uniform3fv(this.uniforms.uFogColor, fog?.color || [0.6, 0.7, 0.8]);
        gl.uniform1f(this.uniforms.uFogStart, Number(fog?.start ?? 1500));
        gl.uniform1f(this.uniforms.uFogEnd, Number(fog?.end ?? 9000));
        gl.uniform1i(this.uniforms.uWireframe, wireframe ? 1 : 0);
        gl.uniform3fv(this.uniforms.uWireframeColor, fog?.wireframeColor || [0.82, 0.92, 1.0]);
        // Time (seconds) for animated shader paths (water ripples, etc).
        try { gl.uniform1f(this.uniforms.uTime, (performance?.now?.() ?? Date.now()) * 0.001); } catch { /* ignore */ }

            gl.enable(gl.DEPTH_TEST);

        // ---- RenderBucket + distance sorting (CodeWalker-ish layering) ----
        // We render in multiple passes so decals/glass/alpha blend correctly:
        //   OPAQUE -> CUTOUT -> DECAL -> ALPHA (back-to-front) -> ADDITIVE
        const BUCKET = {
            OPAQUE: 0,
            CUTOUT: 1,
            DECAL: 2,
            ALPHA: 3,
            ADDITIVE: 4,
        };

        const classifyBucket = (shaderName, alphaModeInt, shaderFamily = null) => {
            const s = String(shaderName || '').toLowerCase();
            const fam = String(shaderFamily || '').toLowerCase();
            if (fam === 'decal') return BUCKET.DECAL;
            if (fam === 'glass') return BUCKET.ALPHA;
            if (s.includes('decal')) return BUCKET.DECAL;
            if (s.includes('glass')) return BUCKET.ALPHA;
            if (s.includes('additive') || s.includes('emissiveadd') || s.includes('add_') || s.includes('_add')) return BUCKET.ADDITIVE;
            if (alphaModeInt === 2) return BUCKET.ALPHA;
            if (alphaModeInt === 1) return BUCKET.CUTOUT;
            return BUCKET.OPAQUE;
        };

        const computeSortDist = (instBounds) => {
            if (!instBounds || !instBounds.minT || !instBounds.maxT) return null;
            try {
                const minT = instBounds.minT;
                const maxT = instBounds.maxT;
                const cx = (minT[0] + maxT[0]) * 0.5;
                const cy = (minT[1] + maxT[1]) * 0.5;
                const cz = (minT[2] + maxT[2]) * 0.5;
                // Data -> viewer space (modelMatrix is rotation only).
                const v4 = glMatrix.vec4.fromValues(cx, cy, cz, 1.0);
                const out = glMatrix.vec4.create();
                glMatrix.vec4.transformMat4(out, v4, this.modelMatrix);
                const dx = out[0] - (cameraPos?.[0] ?? 0);
                const dy = out[1] - (cameraPos?.[1] ?? 0);
                const dz = out[2] - (cameraPos?.[2] ?? 0);
                return Math.sqrt(dx * dx + dy * dy + dz * dz);
            } catch {
                return null;
            }
        };

        // ---- A5: Render-pass state sorting + binding cache ----
        /** @type {Array<any>} */
        const drawItems = [];
        let seq = 0;

        const shaderFamilyToInt = (fam) => {
            const f = String(fam || '').toLowerCase();
            if (!f || f === 'basic') return 0;
            if (f === 'decal') return 1;
            if (f === 'glass') return 2;
            if (f === 'env') return 3;
            if (f === 'parallax') return 4;
            if (f === 'wetness') return 5;
            if (f === 'terrain') return 6;
            if (f === 'water') return 7;
            return 0;
        };
        const warnUnknownFamilyOnce = (fam) => {
            const f = String(fam || '').trim().toLowerCase();
            if (!f || f === 'basic') return;
            if (shaderFamilyToInt(f) !== 0) return;
            if (this._warnedShaderFamilies?.has?.(f)) return;
            try {
                this._warnedShaderFamilies.add(f);
                console.warn(`InstancedModelRenderer: unsupported shaderFamily "${f}" (rendering as basic).`);
            } catch { /* ignore */ }
        };
        const skipsColorPassShader = (shaderName) => {
            const s = String(shaderName || '').toLowerCase();
            return s.includes('cpv_only')
                || s.includes('decal_shadow_only')
                || s.includes('trees_shadow_proxy');
        };
        const vertexColorModeFor = (shaderName, mat) => {
            const explicit = Number(mat?.vertexColorMode ?? mat?.vertexColourMode);
            if (Number.isFinite(explicit)) {
                const n = Math.floor(explicit);
                return (n === 1 || n === 2) ? n : 0;
            }
            const s = String(shaderName || mat?.shaderName || '').toLowerCase();
            if (
                s.includes('cpv_only') ||
                s.includes('colour_only') ||
                s.includes('color_only') ||
                s.includes('vertexcolour') ||
                s.includes('vertexcolor') ||
                s.includes('vertex_colour') ||
                s.includes('vertex_color')
            ) {
                return 1;
            }
            return 0;
        };

        const makeUvso = (uvso) => {
            if (uvso && Array.isArray(uvso) && uvso.length >= 4) {
                const sx = Number(uvso[0]), sy = Number(uvso[1]), ox = Number(uvso[2]), oy = Number(uvso[3]);
                if (Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(ox) && Number.isFinite(oy)) return [sx, sy, ox, oy];
            }
            return [1.0, 1.0, 0.0, 0.0];
        };

        // UV selector parser:
        // - Accepts: 0/1/2, "uv0"/"uv1"/"uv2", "0"/"1"/"2", null/undefined -> defaultSet
        // - Returns: 0/1/2
        const parseUvSet = (v, defaultSet = 0) => {
            const def = (defaultSet === 1) ? 1 : ((defaultSet === 2) ? 2 : 0);
            if (v === null || v === undefined) return def;
            if (typeof v === 'number' && Number.isFinite(v)) {
                const n = Math.floor(v);
                return (n === 1) ? 1 : ((n === 2) ? 2 : 0);
            }
            const s = String(v).trim().toLowerCase();
            if (s === '2' || s === 'uv2') return 2;
            if (s === '1' || s === 'uv1') return 1;
            if (s === '0' || s === 'uv0') return 0;
            return def;
        };

        const materialSigFor = (entryMat, subMat) => {
            try {
                if (this.modelManager?.getEffectiveMaterialAndSignature) {
                    return this.modelManager.getEffectiveMaterialAndSignature(entryMat ?? null, subMat ?? null).sig;
                }
            } catch { /* ignore */ }
            // Fallback: best-effort stable-ish key.
            const eff = { ...(entryMat || {}), ...(subMat || {}) };
            return JSON.stringify({
                diffuse: eff.diffuse ?? null,
                normal: eff.normal ?? null,
                spec: eff.spec ?? null,
                uv0ScaleOffset: eff.uv0ScaleOffset ?? null,
                uv1ScaleOffset: eff.uv1ScaleOffset ?? null,
                uv2ScaleOffset: eff.uv2ScaleOffset ?? null,
                bumpiness: eff.bumpiness ?? null,
                specularIntensity: eff.specularIntensity ?? null,
                specularPower: eff.specularPower ?? null,
                specularFalloffMult: eff.specularFalloffMult ?? null,
                normalUvSet: eff.normalUvSet ?? eff.normalUv ?? null,
                specUvSet: eff.specUvSet ?? eff.specUv ?? null,
                detailUvSet: eff.detailUvSet ?? eff.detailUv ?? null,
                aoUvSet: eff.aoUvSet ?? eff.aoUv ?? null,
                emissiveUvSet: eff.emissiveUvSet ?? eff.emissiveUv ?? null,
            });
        };
        const effectiveMaterialFor = (entryMat, subMat) => {
            try {
                if (this.modelManager?.getEffectiveMaterialAndSignature) {
                    return this.modelManager.getEffectiveMaterialAndSignature(entryMat ?? null, subMat ?? null).material || {};
                }
            } catch { /* ignore */ }
            return { ...(entryMat || {}), ...(subMat || {}) };
        };

        // Prefer KTX2 variants when present; fall back to PNG paths.
        // Viewer can always load PNG; KTX2 support is best-effort.
        const preferKtx2 = true;
        const pickTex = (mat, keyBase) => {
            const m = (mat && typeof mat === 'object') ? mat : {};
            const k2 = `${keyBase}Ktx2`;
            const v2 = preferKtx2 ? (m[k2] ?? null) : null;
            const v1 = m[keyBase] ?? null;
            return (typeof v2 === 'string' && v2) ? v2 : ((typeof v1 === 'string' && v1) ? v1 : null);
        };
        const isPedSkinMask = (mat) => !!(mat && typeof mat === 'object' && mat.pedSkinMask === true);
        const makeBaseColor = (mat) => {
            const v = mat?.baseColor;
            if (Array.isArray(v) && v.length >= 3) {
                const r = Number(v[0]), g = Number(v[1]), b = Number(v[2]);
                if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return [r, g, b];
            }
            return [1.0, 1.0, 1.0];
        };
        const pickDiffuseTex = (mat) => isPedSkinMask(mat) ? null : pickTex(mat, 'diffuse');
        const diffuseKindFor = (shaderName, alphaModeInt, shaderFamily = '') => {
            const s = String(shaderName || '').toLowerCase();
            const fam = String(shaderFamily || '').toLowerCase();
            if ((Number(alphaModeInt) | 0) !== 1 || fam !== 'basic') return 'diffuse';
            if (s.includes('trees_') || s.includes('cutout') || s.includes('branches')) return 'foliageDiffuse';
            return 'diffuse';
        };
        const doubleSidedLightingFor = (shaderName, alphaModeInt, shaderFamily, doubleSided, diffuseKind = 'diffuse') => {
            if (!doubleSided) return false;
            if (String(shaderFamily || '').toLowerCase() !== 'basic') return false;
            if ((Number(alphaModeInt) | 0) !== 1) return false;
            const kind = String(diffuseKind || '').toLowerCase();
            if (kind === 'foliagediffuse') return true;
            const s = String(shaderName || '').toLowerCase();
            return s.includes('trees_') || s.includes('branches') || s.includes('cutout');
        };

        const computeRadiusSafe = (mesh) => {
            const c = mesh?.bounds?.center;
            const off = (c && c.length >= 3) ? Math.sqrt((c[0] || 0) ** 2 + (c[1] || 0) ** 2 + (c[2] || 0) ** 2) : 0;
            return (Number(mesh?.radius ?? 0) || 0) + off;
        };

        // Gather bucket draw items.
        for (const [_id, b] of this.buckets.entries()) {
            if (!b || b.instanceCount <= 0 || !b.mesh) continue;
            const dist = Number.isFinite(Number(b.minDist)) ? Number(b.minDist) : 0;

            if (this.modelManager?.isMeshDisposed?.(b.mesh)) {
                try { if (b.vao) gl.deleteVertexArray(b.vao); } catch { /* ignore */ }
                b.vao = null;
                b.mesh = null;
                this._enqueueMeshLoad(b.bucketId, b.file);
                continue;
            }
            this.modelManager?.touchMesh?.(b.mesh);

            const radiusSafe = computeRadiusSafe(b.mesh);
            if (!shouldDrawByOcclusion(b._instBounds, radiusSafe, `bucket:${b.bucketId || b.file || seq}`)) continue;

            const mat = b.material || null;
            if (mat?.skipColorPass || skipsColorPassShader(mat?.shaderName)) continue;
            const shaderFamily = String(mat?.shaderFamily || '').toLowerCase();
            const alphaModeStr = String(mat?.alphaMode || 'opaque').toLowerCase();
            let alphaModeInt = (alphaModeStr === 'cutout') ? 1 : ((alphaModeStr === 'blend') ? 2 : 0);
            // Family overrides: decals/glass are effectively blended in our current pipeline.
            if (shaderFamily === 'decal' || shaderFamily === 'glass') alphaModeInt = 2;
            const shaderName = String(mat?.shaderName || '');
            const shaderFamilyInt = shaderFamilyToInt(shaderFamily);
            const diffuseKind = diffuseKindFor(shaderName, alphaModeInt, shaderFamily);
            const doubleSided = !!mat?.doubleSided;
            if (shaderFamilyInt === 0) warnUnknownFamilyOnce(shaderFamily);
            drawItems.push({
                kind: 'bucket',
                bucketId: String(b.bucketId || ''),
                hash: null,
                lod: String(b.lod || ''),
                file: String(b.file || ''),
                seq: seq++,
                materialSig: materialSigFor(null, mat),
                meshKey: String(b.file || ''),
                meshHasTangents: !!(b.mesh?.tanBuffer),
                meshHasColor0: !!(b.mesh?.col0Buffer),
                meshHasUv1: !!(b.mesh?.uv1Buffer),
                skinned: false,
                hasBlendWeights: false,
                hasBlendIndices: false,
                boneIds: [],
                dist,
                instanceStrideFloats: Number(b.instanceStrideFloats ?? 16),
                sortDist: computeSortDist(b._instBounds),
                shaderName,
                shaderFamily,
                shaderFamilyInt,
                renderBucket: classifyBucket(shaderName, alphaModeInt, shaderFamily),
                instBounds: b._instBounds || null,
                gpuCullRadius: radiusSafe,
                uvso: makeUvso(mat?.uv0ScaleOffset),
                uvso1: makeUvso(mat?.uv1ScaleOffset),
                uvso2: makeUvso(mat?.uv2ScaleOffset),
                globalAnimUV0: (Array.isArray(mat?.globalAnimUV0) && mat.globalAnimUV0.length >= 3) ? mat.globalAnimUV0 : [1.0, 0.0, 0.0],
                globalAnimUV1: (Array.isArray(mat?.globalAnimUV1) && mat.globalAnimUV1.length >= 3) ? mat.globalAnimUV1 : [0.0, 1.0, 0.0],
                baseColor: makeBaseColor(mat),
                pedHairTint: mat?.pedHairTint === true,
                vertexColorMode: vertexColorModeFor(shaderName, mat),
                diffuseRel: pickDiffuseTex(mat),
                diffuseKind,
                diffuseUvSet: parseUvSet(mat?.diffuseUvSet ?? mat?.diffuseUv ?? null, 0),
                diffuse2Rel: pickTex(mat, 'diffuse2'),
                diffuse2Uv: mat?.diffuse2Uv ?? null,
                isDistMap: !!mat?.isDistMap,
                normalRel: pickTex(mat, 'normal'),
                normalEncoding: (String(mat?.normalSwizzle || 'rg').toLowerCase() === 'ag') ? 1 : 0,
                normalReconstructZ: (mat?.normalReconstructZ === undefined || mat?.normalReconstructZ === null) ? 1 : Number(mat?.normalReconstructZ),
                detailRel: pickTex(mat, 'detail'),
                specRel: pickTex(mat, 'spec'),
                emissiveRel: pickTex(mat, 'emissive'),
                aoRel: pickTex(mat, 'ao'),
                heightRel: pickTex(mat, 'height'),
                // Extra workflow textures (best-effort parity with CodeWalker param universe)
                tintPaletteRel: pickTex(mat, 'tintPalette'),
                tintPaletteSelector: Array.isArray(mat?.tintPaletteSelector) ? mat.tintPaletteSelector : null,
                tintMode: Number.isFinite(Number(mat?.tintMode)) ? (Number(mat?.tintMode) | 0) : 0,
                ambientDecalMask: Array.isArray(mat?.ambientDecalMask) ? mat.ambientDecalMask : null,
                dirtDecalMask: Array.isArray(mat?.dirtDecalMask) ? mat.dirtDecalMask : null,
                envRel: pickTex(mat, 'env'),
                dirtRel: pickTex(mat, 'dirt'),
                damageRel: pickTex(mat, 'damage'),
                damageMaskRel: pickTex(mat, 'damageMask'),
                puddleMaskRel: pickTex(mat, 'puddleMask'),
                normalUvSet: parseUvSet(mat?.normalUvSet ?? mat?.normalUv ?? null, 0),
                specUvSet: parseUvSet(mat?.specUvSet ?? mat?.specUv ?? null, 0),
                detailUvSet: parseUvSet(mat?.detailUvSet ?? mat?.detailUv ?? null, 0),
                aoUvSet: parseUvSet(mat?.aoUvSet ?? mat?.aoUv ?? null, 0),
                emissiveUvSet: parseUvSet(mat?.emissiveUvSet ?? mat?.emissiveUv ?? null, 0),
                aoStrength: Number(mat?.aoStrength ?? 1.0),
                alphaMaskRel: pickTex(mat, 'alphaMask'),
                decalDepthBias: Number(mat?.decalDepthBias ?? 1.0),
                decalSlopeScale: Number(mat?.decalSlopeScale ?? 1.0),
                reflectionIntensity: Number(mat?.reflectionIntensity ?? 0.6),
                fresnelPower: Number(mat?.fresnelPower ?? 5.0),
                hardAlphaBlend: Number(mat?.hardAlphaBlend ?? 0.0),
                alphaModeInt,
                alphaCutoff: Number(mat?.alphaCutoff ?? 0.33),
                alphaScale: Number(mat?.alphaScale ?? 1.0),
                alphaToCoverage: !!mat?.alphaToCoverage,
                doubleSided,
                doubleSidedLighting: doubleSidedLightingFor(shaderName, alphaModeInt, shaderFamily, doubleSided, diffuseKind),
                specMaskWeights: Array.isArray(mat?.specMaskWeights) ? mat.specMaskWeights : null,
                detailSettings: Array.isArray(mat?.detailSettings) ? mat.detailSettings : null,
                bumpiness: Number((mat?.bumpiness) ?? 1.0),
                specIntensity: Number((mat?.specularIntensity) ?? 0.25),
                specPower: Number((mat?.specularPower) ?? 24.0),
                specFalloffMult: Number((mat?.specularFalloffMult) ?? 1.0),
                specFresnel: Number((mat?.specularFresnel) ?? 0.0),
                emissiveIntensity: Number((mat?.emissiveIntensity) ?? 1.0),
                parallaxScaleBias: Array.isArray(mat?.parallaxScaleBias) ? mat.parallaxScaleBias : null,
                wetness: Number(mat?.wetness ?? 0.0),
                wetDarken: Number(mat?.wetDarken ?? 0.0),
                wetSpecBoost: Number(mat?.wetSpecBoost ?? 1.75),
                // Water (best-effort)
                waterMode: Number.isFinite(Number(mat?.waterMode)) ? (Number(mat.waterMode) | 0) : 0,
                rippleSpeed: Number(mat?.rippleSpeed ?? 0.0),
                rippleScale: Number(mat?.rippleScale ?? 1.0),
                rippleBumpiness: Number(mat?.rippleBumpiness ?? 0.5),
                // Water (CodeWalker parity flags/params)
                waterEnableTexture: (mat?.waterEnableTexture === undefined || mat?.waterEnableTexture === null)
                    ? (!String(shaderName || '').toLowerCase().includes('foam'))
                    : !!mat.waterEnableTexture,
                waterEnableBumpMap: (mat?.waterEnableBumpMap === undefined || mat?.waterEnableBumpMap === null)
                    ? true
                    : !!mat.waterEnableBumpMap,
                waterEnableFoamMap: (mat?.waterEnableFoamMap === undefined || mat?.waterEnableFoamMap === null)
                    ? String(shaderName || '').toLowerCase().includes('foam')
                    : !!mat.waterEnableFoamMap,
                // EnableFlow controls whether we sample the flow texture; when false, Flow.zw defaults to (0.02,0.03)
                waterEnableFlow: (mat?.enableWaterFlow === undefined || mat?.enableWaterFlow === null)
                    ? true
                    : !!mat.enableWaterFlow,
                waterEnableFogtex: (mat?.waterEnableFogtex === undefined || mat?.waterEnableFogtex === null)
                    ? (!!(mat?.env) && Array.isArray(mat?.waterFogParams) && mat.waterFogParams.length >= 4)
                    : !!mat.waterEnableFogtex,
                waterFlowParams: (Array.isArray(mat?.gFlowParams) && mat.gFlowParams.length >= 4)
                    ? mat.gFlowParams
                    : (Array.isArray(fog?.waterFlowParams) && fog.waterFlowParams.length >= 4 ? fog.waterFlowParams : null),
                waterFogParams: (Array.isArray(mat?.waterFogParams) && mat.waterFogParams.length >= 4)
                    ? mat.waterFogParams
                    : (Array.isArray(fog?.waterFogParams) && fog.waterFogParams.length >= 4 ? fog.waterFogParams : null),
                dirtLevel: Number(mat?.dirtLevel ?? 0.0),
                dirtColor: Array.isArray(mat?.dirtColor) ? mat.dirtColor : null,
                decalTint: Array.isArray(mat?.decalTint) ? mat.decalTint : null,
                puddleParams: Array.isArray(mat?.puddleParams) ? mat.puddleParams : null,
                puddleScaleRange: Array.isArray(mat?.puddleScaleRange) ? mat.puddleScaleRange : null,
                entryMaterial: null,
                submeshMaterial: null,
                effectiveMaterial: mat,
                vao: b.vao || null,
                mesh: b.mesh,
                instanceBuffer: b.instanceBuffer,
                instanceData: b.instanceData || null,
                instanceCount: b.instanceCount,
                entryInstanceBuffer: null,
            });
        }

        // Gather archetype-submesh draw items.
        for (const [_hash, entry] of this.instances.entries()) {
            if (!entry || entry.instanceCount <= 0) continue;
            const dist = Number.isFinite(Number(entry.minDist)) ? Number(entry.minDist) : 0;
            const entrySortDist = computeSortDist(entry._instBounds);

            let fallbackMat = null;
            try {
                const h0 = this.modelManager?.normalizeId?.(entry.hash) ?? String(entry.hash || '');
                fallbackMat = this.modelManager?.manifest?.meshes?.[h0]?.material ?? null;
            } catch {
                fallbackMat = null;
            }

            let maxRadiusSafe = 0.0;
            for (const sm0 of entry.submeshes?.values?.() || []) {
                const m0 = sm0?.mesh;
                if (!m0) continue;
                const r0 = computeRadiusSafe(m0);
                if (r0 > maxRadiusSafe) maxRadiusSafe = r0;
            }
            if (maxRadiusSafe > 0 && !shouldDrawByOcclusion(entry._instBounds, maxRadiusSafe, `arch:${entry.hash}:${entry.lod}`)) continue;

            for (const sm of entry.submeshes?.values?.() || []) {
                if (!sm || !sm.mesh) continue;
                if (this.modelManager?.isMeshDisposed?.(sm.mesh)) {
                    try { if (sm.vao) gl.deleteVertexArray(sm.vao); } catch { /* ignore */ }
                    sm.vao = null;
                    sm.mesh = null;
                    this._enqueueMeshLoad(`${entry.hash}:${entry.lod}`, sm.file, { priority: entry.loadPriority || 0 });
                    continue;
                }
                this.modelManager?.touchMesh?.(sm.mesh);

                const radiusSafe = computeRadiusSafe(sm.mesh);
                const subMat = sm.material || null;
                let materialCache = sm._renderMaterialCache;
                if (!materialCache || materialCache.entry !== fallbackMat || materialCache.sub !== subMat) {
                    materialCache = {
                        entry: fallbackMat,
                        sub: subMat,
                        effective: effectiveMaterialFor(fallbackMat, subMat),
                        signature: materialSigFor(fallbackMat, subMat),
                    };
                    sm._renderMaterialCache = materialCache;
                }
                const eff = materialCache.effective;
                if (eff.skipColorPass || skipsColorPassShader(eff?.shaderName)) continue;
                const shaderFamily = String(eff?.shaderFamily || '').toLowerCase();
                const alphaModeStr = String(eff?.alphaMode || 'opaque').toLowerCase();
                let alphaModeInt = (alphaModeStr === 'cutout') ? 1 : ((alphaModeStr === 'blend') ? 2 : 0);
                if (shaderFamily === 'decal' || shaderFamily === 'glass') alphaModeInt = 2;
                const shaderName = String(eff?.shaderName || '');

                const shaderFamilyInt = shaderFamilyToInt(shaderFamily);
                const diffuseKind = diffuseKindFor(shaderName, alphaModeInt, shaderFamily);
                const fragmentBoneTag = Number.isFinite(Number(sm.fragmentBoneTag)) ? Number(sm.fragmentBoneTag) : null;
                const doubleSided = !!eff?.doubleSided || fragmentBoneTag !== null;
                if (shaderFamilyInt === 0) warnUnknownFamilyOnce(shaderFamily);
                drawItems.push({
                    kind: 'submesh',
                    hash: String(entry.hash || ''),
                    lod: String(entry.lod || ''),
                    file: String(sm.file || ''),
                    bucketId: null,
                    seq: seq++,
                    materialSig: materialCache.signature,
                    meshKey: String(sm.file || ''),
                    meshHasTangents: !!(sm.mesh?.tanBuffer),
                    meshHasColor0: !!(sm.mesh?.col0Buffer),
                    meshHasUv1: !!(sm.mesh?.uv1Buffer),
                    skinned: !!sm.skinned,
                    hasBlendWeights: !!sm.hasBlendWeights,
                    hasBlendIndices: !!sm.hasBlendIndices,
                    boneIds: Array.isArray(sm.boneIds) ? sm.boneIds : [],
                    fragmentBoneTag,
                    dist,
                    instanceStrideFloats: Number(entry.instanceStrideFloats ?? 16),
                    sortDist: entrySortDist,
                    shaderName,
                    shaderFamily,
                    shaderFamilyInt,
                    renderBucket: classifyBucket(shaderName, alphaModeInt, shaderFamily),
                    instBounds: entry._instBounds || null,
                    gpuCullRadius: radiusSafe,
                    uvso: makeUvso(eff?.uv0ScaleOffset),
                    uvso1: makeUvso(eff?.uv1ScaleOffset),
                    uvso2: makeUvso(eff?.uv2ScaleOffset),
                    globalAnimUV0: (Array.isArray(eff?.globalAnimUV0) && eff.globalAnimUV0.length >= 3) ? eff.globalAnimUV0 : [1.0, 0.0, 0.0],
                    globalAnimUV1: (Array.isArray(eff?.globalAnimUV1) && eff.globalAnimUV1.length >= 3) ? eff.globalAnimUV1 : [0.0, 1.0, 0.0],
                    baseColor: makeBaseColor(eff),
                    pedHairTint: eff?.pedHairTint === true,
                    vertexColorMode: vertexColorModeFor(shaderName, eff),
                    diffuseRel: pickDiffuseTex(eff),
                    diffuseKind,
                    diffuseUvSet: parseUvSet(eff?.diffuseUvSet ?? eff?.diffuseUv ?? null, 0),
                    diffuse2Rel: pickTex(eff, 'diffuse2'),
                    diffuse2Uv: eff?.diffuse2Uv ?? null,
                    isDistMap: !!eff?.isDistMap,
                    normalRel: pickTex(eff, 'normal'),
                    normalEncoding: (String(eff?.normalSwizzle || 'rg').toLowerCase() === 'ag') ? 1 : 0,
                    normalReconstructZ: (eff?.normalReconstructZ === undefined || eff?.normalReconstructZ === null) ? 1 : Number(eff?.normalReconstructZ),
                    detailRel: pickTex(eff, 'detail'),
                    specRel: pickTex(eff, 'spec'),
                    emissiveRel: pickTex(eff, 'emissive'),
                    aoRel: pickTex(eff, 'ao'),
                    heightRel: pickTex(eff, 'height'),
                    tintPaletteRel: pickTex(eff, 'tintPalette'),
                    tintPaletteSelector: Array.isArray(eff?.tintPaletteSelector) ? eff.tintPaletteSelector : null,
                    tintMode: Number.isFinite(Number(eff?.tintMode)) ? (Number(eff.tintMode) | 0) : 0,
                    ambientDecalMask: Array.isArray(eff?.ambientDecalMask) ? eff.ambientDecalMask : null,
                    dirtDecalMask: Array.isArray(eff?.dirtDecalMask) ? eff.dirtDecalMask : null,
                    envRel: pickTex(eff, 'env'),
                    dirtRel: pickTex(eff, 'dirt'),
                    damageRel: pickTex(eff, 'damage'),
                    damageMaskRel: pickTex(eff, 'damageMask'),
                    puddleMaskRel: pickTex(eff, 'puddleMask'),
                    normalUvSet: parseUvSet(eff?.normalUvSet ?? eff?.normalUv ?? null, 0),
                    specUvSet: parseUvSet(eff?.specUvSet ?? eff?.specUv ?? null, 0),
                    detailUvSet: parseUvSet(eff?.detailUvSet ?? eff?.detailUv ?? null, 0),
                    aoUvSet: parseUvSet(eff?.aoUvSet ?? eff?.aoUv ?? null, 0),
                    emissiveUvSet: parseUvSet(eff?.emissiveUvSet ?? eff?.emissiveUv ?? null, 0),
                    aoStrength: Number(eff?.aoStrength ?? 1.0),
                    alphaMaskRel: pickTex(eff, 'alphaMask'),
                    decalDepthBias: Number(eff?.decalDepthBias ?? 1.0),
                    decalSlopeScale: Number(eff?.decalSlopeScale ?? 1.0),
                    reflectionIntensity: Number(eff?.reflectionIntensity ?? 0.6),
                    fresnelPower: Number(eff?.fresnelPower ?? 5.0),
                    hardAlphaBlend: Number(eff?.hardAlphaBlend ?? 0.0),
                    alphaModeInt,
                    alphaCutoff: Number(eff?.alphaCutoff ?? 0.33),
                    alphaScale: Number(eff?.alphaScale ?? 1.0),
                    alphaToCoverage: !!eff?.alphaToCoverage,
                    doubleSided,
                    doubleSidedLighting: doubleSidedLightingFor(shaderName, alphaModeInt, shaderFamily, doubleSided, diffuseKind),
                    specMaskWeights: Array.isArray(eff?.specMaskWeights) ? eff.specMaskWeights : null,
                    detailSettings: Array.isArray(eff?.detailSettings) ? eff.detailSettings : null,
                    bumpiness: Number(eff?.bumpiness ?? 1.0),
                    specIntensity: Number(eff?.specularIntensity ?? 0.25),
                    specPower: Number(eff?.specularPower ?? 24.0),
                    specFalloffMult: Number(eff?.specularFalloffMult ?? 1.0),
                    specFresnel: Number(eff?.specularFresnel ?? 0.0),
                    emissiveIntensity: Number(eff?.emissiveIntensity ?? 1.0),
                    parallaxScaleBias: Array.isArray(eff?.parallaxScaleBias) ? eff.parallaxScaleBias : null,
                    wetness: Number(eff?.wetness ?? 0.0),
                    wetDarken: Number(eff?.wetDarken ?? 0.0),
                    wetSpecBoost: Number(eff?.wetSpecBoost ?? 1.75),
                    // Water (best-effort)
                    waterMode: Number.isFinite(Number(eff?.waterMode)) ? (Number(eff.waterMode) | 0) : 0,
                    rippleSpeed: Number(eff?.rippleSpeed ?? 0.0),
                    rippleScale: Number(eff?.rippleScale ?? 1.0),
                    rippleBumpiness: Number(eff?.rippleBumpiness ?? 0.5),
                    // Water (CodeWalker parity flags/params)
                    waterEnableTexture: (eff?.waterEnableTexture === undefined || eff?.waterEnableTexture === null)
                        ? (!String(shaderName || '').toLowerCase().includes('foam'))
                        : !!eff.waterEnableTexture,
                    waterEnableBumpMap: (eff?.waterEnableBumpMap === undefined || eff?.waterEnableBumpMap === null)
                        ? true
                        : !!eff.waterEnableBumpMap,
                    waterEnableFoamMap: (eff?.waterEnableFoamMap === undefined || eff?.waterEnableFoamMap === null)
                        ? String(shaderName || '').toLowerCase().includes('foam')
                        : !!eff.waterEnableFoamMap,
                    waterEnableFlow: (eff?.enableWaterFlow === undefined || eff?.enableWaterFlow === null)
                        ? true
                        : !!eff.enableWaterFlow,
                    waterEnableFogtex: (eff?.waterEnableFogtex === undefined || eff?.waterEnableFogtex === null)
                        ? (!!(eff?.env) && Array.isArray(eff?.waterFogParams) && eff.waterFogParams.length >= 4)
                        : !!eff.waterEnableFogtex,
                    waterFlowParams: (Array.isArray(eff?.gFlowParams) && eff.gFlowParams.length >= 4)
                        ? eff.gFlowParams
                        : (Array.isArray(fog?.waterFlowParams) && fog.waterFlowParams.length >= 4 ? fog.waterFlowParams : null),
                    waterFogParams: (Array.isArray(eff?.waterFogParams) && eff.waterFogParams.length >= 4)
                        ? eff.waterFogParams
                        : (Array.isArray(fog?.waterFogParams) && fog.waterFogParams.length >= 4 ? fog.waterFogParams : null),
                    dirtLevel: Number(eff?.dirtLevel ?? 0.0),
                    dirtColor: Array.isArray(eff?.dirtColor) ? eff.dirtColor : null,
                    decalTint: Array.isArray(eff?.decalTint) ? eff.decalTint : null,
                    puddleParams: Array.isArray(eff?.puddleParams) ? eff.puddleParams : null,
                    puddleScaleRange: Array.isArray(eff?.puddleScaleRange) ? eff.puddleScaleRange : null,
                    entryMaterial: fallbackMat,
                    submeshMaterial: subMat,
                    effectiveMaterial: eff,
                    vao: sm.vao || null,
                    mesh: sm.mesh,
                    instanceBuffer: entry.instanceBuffer,
                    instanceData: entry.instanceData || null,
                    instanceCount: entry.instanceCount,
                });
            }
        }

        // Draw opaque geometry front-to-back so early depth rejection skips work behind
        // nearby building faces. Transparent passes remain back-to-front.
        drawItems.sort((a, b) => {
            if (a.renderBucket !== b.renderBucket) return a.renderBucket - b.renderBucket;
            const aDist = Number.isFinite(a.sortDist) ? a.sortDist : Number.POSITIVE_INFINITY;
            const bDist = Number.isFinite(b.sortDist) ? b.sortDist : Number.POSITIVE_INFINITY;
            if (a.renderBucket === BUCKET.OPAQUE || a.renderBucket === BUCKET.CUTOUT) {
                if (aDist !== bDist) return aDist - bDist;
            } else if (a.renderBucket === BUCKET.ALPHA || a.renderBucket === BUCKET.ADDITIVE) {
                if (aDist !== bDist) return bDist - aDist;
            }
            if (a.materialSig !== b.materialSig) return (a.materialSig < b.materialSig) ? -1 : 1;
            const ta = a.meshHasTangents ? 1 : 0;
            const tb = b.meshHasTangents ? 1 : 0;
            if (ta !== tb) return ta - tb;
            if (a.meshKey !== b.meshKey) return (a.meshKey < b.meshKey) ? -1 : 1;
            return a.seq - b.seq;
        });
        this._lastPickDrawItems = drawItems;

        // Render stats for Perf HUD (lightweight counters).
        this._renderStats.drawCalls = 0;
        this._renderStats.triangles = 0;
        this._renderStats.instances = 0;
        this._renderStats.bucketDraws = 0;
        this._renderStats.submeshDraws = 0;
        this._renderStats.drawItems = drawItems.length;
        this._renderStats.diffuseWanted = 0;
        this._renderStats.diffusePlaceholder = 0;
        this._renderStats.diffuseReal = 0;
        this._renderStats.diffuseMissingFromIndex = 0;
        this._renderStats.drawItemsMissingUv = 0;

        // Reset per-frame texture diagnostics.
        try {
            this._texFrame?.missingFromExportedSet?.clear?.();
            this._texFrame?.placeholderUrls?.clear?.();
        } catch { /* ignore */ }

        // Bind cache to reduce redundant GL calls.
        const state = {
            vao: null,
            uvso: null,
            uvso1: null,
            uvso2: null,
            uvAnim0: null,
            uvAnim1: null,
            terrainMaskMode: null,
            hasDiffuse: null,
            hasDiffuse2: null,
            diffuse2UseUv1: null,
            hasNormal: null,
            hasDetail: null,
            hasSpec: null,
            hasEmissive: null,
            normalUvSet: null,
            specUvSet: null,
            detailUvSet: null,
            aoUvSet: null,
            emissiveUvSet: null,
            shaderFamily: null,
            hasAlphaMask: null,
            alphaMode: null,
            alphaCutoff: null,
            alphaScale: null,
            hardAlphaBlend: null,
            blendEnabled: null,
            depthMask: null,
            alphaToCoverage: null,
            decodeDiffuseSrgb: null,
            decodeDiffuse2Srgb: null,
            decodeEmissiveSrgb: null,
            flipDiffuseY: null,
            flipDiffuse2Y: null,
            flipNormalY: null,
            flipDetailY: null,
            flipSpecY: null,
            flipEmissiveY: null,
            flipAOY: null,
            flipAlphaMaskY: null,
            flipHeightY: null,
            normalEncoding: null,
            normalReconstructZ: null,
            fragmentTransform: null,
            specMaskWeights: null,
            doubleSided: null,
            normalScale: null,
            detailSettings: null,
            specIntensity: null,
            specPower: null,
            specFalloffMult: null,
            emissiveIntensity: null,
            reflectionIntensity: null,
            fresnelPower: null,
            envColor: null,
            hasEnvMap: null,
            decodeEnvSrgb: null,
            flipEnvY: null,
            hasDirt: null,
            dirtLevel: null,
            dirtColor: null,
            flipDirtY: null,
            hasDamage: null,
            hasDamageMask: null,
            flipDamageY: null,
            flipDamageMaskY: null,
            hasPuddleMask: null,
            flipPuddleMaskY: null,
            puddleParams: null,
            puddleScaleRange: null,
            decalTint: null,
            tintPaletteSel: null,
            hasHeight: null,
            parallaxScaleBias: null,
            wetness: null,
            wetDarken: null,
            wetSpecBoost: null,
            // Water (CodeWalker parity uniforms)
            waterEnableTexture: null,
            waterEnableBumpMap: null,
            waterEnableFoamMap: null,
            waterEnableFlow: null,
            waterEnableFogtex: null,
            waterFlowParams: null,
            waterFogParams: null,
            gpuCullRadius: null,
            baseColor: null,
            vertexColorMode: null,
            // IMPORTANT: initialize to `undefined` (not `null`) so the first bind always happens.
            // If we initialize to null and the first material's texture is also null (placeholder/loading),
            // bindTexCached() would early-return and leave a stale texture bound (e.g. PostFX scene RT),
            // which can trigger a framebuffer-texture feedback loop and "grey screen" failures.
            tex0: undefined,
            tex0b: undefined,
            tex1: undefined,
            tex2: undefined,
            tex3: undefined,
            texDetail: undefined,
            texAO: undefined,
            texAlphaMask: undefined,
            texHeight: undefined,
            texEnv: undefined,
            texDirt: undefined,
            texDamage: undefined,
            texDamageMask: undefined,
            texPuddleMask: undefined,
            texTintPalette: undefined,
            texBone: undefined,
            texShadow: undefined,
            activeUnit: -1,
            polyOffset: null,
            skinEnabled: null,
        };

        const setUvsoCached = (uvso4) => {
            const v = uvso4 || [1.0, 1.0, 0.0, 0.0];
            const p = state.uvso;
            if (p && p[0] === v[0] && p[1] === v[1] && p[2] === v[2] && p[3] === v[3]) return;
            gl.uniform4fv(this.uniforms.uUv0ScaleOffset, v);
            state.uvso = [v[0], v[1], v[2], v[3]];
        };
        const setUvso1Cached = (uvso4) => {
            const v = uvso4 || [1.0, 1.0, 0.0, 0.0];
            const p = state.uvso1;
            if (p && p[0] === v[0] && p[1] === v[1] && p[2] === v[2] && p[3] === v[3]) return;
            gl.uniform4fv(this.uniforms.uUv1ScaleOffset, v);
            state.uvso1 = [v[0], v[1], v[2], v[3]];
        };
        const setUvso2Cached = (uvso4) => {
            const v = uvso4 || [1.0, 1.0, 0.0, 0.0];
            const p = state.uvso2;
            if (p && p[0] === v[0] && p[1] === v[1] && p[2] === v[2] && p[3] === v[3]) return;
            gl.uniform4fv(this.uniforms.uUv2ScaleOffset, v);
            state.uvso2 = [v[0], v[1], v[2], v[3]];
        };
        const setUvAnimCached = (a0, a1) => {
            // Each is vec3 (ax, ay, a1) used as dot(a, vec3(uv,1)).
            const v0 = Array.isArray(a0) && a0.length >= 3 ? a0 : [1.0, 0.0, 0.0];
            const v1 = Array.isArray(a1) && a1.length >= 3 ? a1 : [0.0, 1.0, 0.0];
            const p0 = state.uvAnim0;
            const p1 = state.uvAnim1;
            if (
                p0 && p1 &&
                p0[0] === v0[0] && p0[1] === v0[1] && p0[2] === v0[2] &&
                p1[0] === v1[0] && p1[1] === v1[1] && p1[2] === v1[2]
            ) return;
            gl.uniform3fv(this.uniforms.uGlobalAnimUV0, [Number(v0[0]) || 0, Number(v0[1]) || 0, Number(v0[2]) || 0]);
            gl.uniform3fv(this.uniforms.uGlobalAnimUV1, [Number(v1[0]) || 0, Number(v1[1]) || 0, Number(v1[2]) || 0]);
            state.uvAnim0 = [v0[0], v0[1], v0[2]];
            state.uvAnim1 = [v1[0], v1[1], v1[2]];
        };

        const toAssetUrl = (rel) => this._chooseTextureUrl(rel, {
            allowIndexMiss: !!fog?.allowTextureIndexMiss,
        });

        const set1iCached = (loc, next, key) => {
            if (state[key] === next) return;
            gl.uniform1i(loc, next);
            state[key] = next;
        };
        const set1fCached = (loc, next, key, fallback) => {
            const v = Number.isFinite(Number(next)) ? Number(next) : fallback;
            if (state[key] === v) return;
            gl.uniform1f(loc, v);
            state[key] = v;
        };
        const set3fCached = (loc, arr3, key, fallbackArr) => {
            const a = Array.isArray(arr3) && arr3.length >= 3 ? arr3 : fallbackArr;
            const v0 = Number(a[0]), v1 = Number(a[1]), v2 = Number(a[2]);
            const f0 = Number.isFinite(v0) ? v0 : fallbackArr[0];
            const f1 = Number.isFinite(v1) ? v1 : fallbackArr[1];
            const f2 = Number.isFinite(v2) ? v2 : fallbackArr[2];
            const prev = state[key];
            if (prev && prev[0] === f0 && prev[1] === f1 && prev[2] === f2) return;
            gl.uniform3fv(loc, [f0, f1, f2]);
            state[key] = [f0, f1, f2];
        };
        const set4fCached = (loc, arr4, key, fallbackArr) => {
            const a = Array.isArray(arr4) && arr4.length >= 4 ? arr4 : fallbackArr;
            const v0 = Number(a[0]), v1 = Number(a[1]), v2 = Number(a[2]), v3 = Number(a[3]);
            const f0 = Number.isFinite(v0) ? v0 : fallbackArr[0];
            const f1 = Number.isFinite(v1) ? v1 : fallbackArr[1];
            const f2 = Number.isFinite(v2) ? v2 : fallbackArr[2];
            const f3 = Number.isFinite(v3) ? v3 : fallbackArr[3];
            const prev = state[key];
            if (prev && prev[0] === f0 && prev[1] === f1 && prev[2] === f2 && prev[3] === f3) return;
            gl.uniform4fv(loc, [f0, f1, f2, f3]);
            state[key] = [f0, f1, f2, f3];
        };
        const set2fCached = (loc, arr2, key, fallbackArr) => {
            const a = Array.isArray(arr2) && arr2.length >= 2 ? arr2 : fallbackArr;
            const v0 = Number(a[0]), v1 = Number(a[1]);
            const p = state[key];
            if (p && p[0] === v0 && p[1] === v1) return;
            gl.uniform2fv(loc, [Number.isFinite(v0) ? v0 : fallbackArr[0], Number.isFinite(v1) ? v1 : fallbackArr[1]]);
            state[key] = [Number.isFinite(v0) ? v0 : fallbackArr[0], Number.isFinite(v1) ? v1 : fallbackArr[1]];
        };
        const setAlphaModeCached = (modeInt, cutoff, scale) => {
            const m = Number.isFinite(Number(modeInt)) ? Number(modeInt) : 0;
            if (state.alphaMode !== m) {
                gl.uniform1i(this.uniforms.uAlphaMode, m);
                state.alphaMode = m;
            }
            set1fCached(this.uniforms.uAlphaCutoff, cutoff, 'alphaCutoff', 0.33);
            set1fCached(this.uniforms.uAlphaScale, scale, 'alphaScale', 1.0);
        };
        const setCullCached = (doubleSided) => {
            const ds = !!doubleSided;
            if (state.doubleSided === ds) return;
            state.doubleSided = ds;
            if (ds) {
                gl.disable(gl.CULL_FACE);
            } else {
                gl.enable(gl.CULL_FACE);
                gl.cullFace(gl.BACK);
            }
        };

        const setDecodeSrgbCached = (which, decodeSrgb) => {
            const v = !!decodeSrgb;
            if (state[which] === v) return;
            const loc =
                (which === 'decodeDiffuseSrgb') ? this.uniforms.uDecodeDiffuseSrgb
                    : (which === 'decodeDiffuse2Srgb') ? this.uniforms.uDecodeDiffuse2Srgb
                        : this.uniforms.uDecodeEmissiveSrgb;
            gl.uniform1i(loc, v ? 1 : 0);
            state[which] = v;
        };

        const setNormalDecodeCached = (encodingInt, reconstructZ) => {
            const e = Number.isFinite(Number(encodingInt)) ? Number(encodingInt) : 0;
            const rz = (Number.isFinite(Number(reconstructZ)) ? Number(reconstructZ) : 1) > 0.5;
            if (state.normalEncoding !== e) {
                gl.uniform1i(this.uniforms.uNormalEncoding, e);
                state.normalEncoding = e;
            }
            if (state.normalReconstructZ !== rz) {
                gl.uniform1i(this.uniforms.uNormalReconstructZ, rz ? 1 : 0);
                state.normalReconstructZ = rz;
            }
        };
        const setAlphaToCoverage = (on) => {
            const v = !!on;
            if (state.alphaToCoverage === v) return;
            state.alphaToCoverage = v;
            try {
                if (v) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
                else gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
            } catch { /* ignore */ }
        };

        const setBlendForAlphaMode = (modeInt, hardAlphaBlend, alphaToCoverage = false) => {
            const m = Number.isFinite(Number(modeInt)) ? Number(modeInt) : 0;
            const hab = Number.isFinite(Number(hardAlphaBlend)) ? Number(hardAlphaBlend) : 0.0;
            const habOn = hab > 0.5;

            // For blend mode, enable blending.
            // For opaque/cutout, disable blending + enable depth writes.
            if (m === 2) {
                setAlphaToCoverage(false);
                if (!state.blendEnabled) {
                    gl.enable(gl.BLEND);
                    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                    state.blendEnabled = true;
                }
                // Hard alpha blend keeps depth writes enabled to reduce sorting artifacts.
                if (state.depthMask !== habOn) {
                    gl.depthMask(habOn);
                    state.depthMask = habOn;
                }
            } else {
                if (state.blendEnabled !== false) {
                    gl.disable(gl.BLEND);
                    state.blendEnabled = false;
                }
                if (state.depthMask !== true) {
                    gl.depthMask(true);
                    state.depthMask = true;
                }
                // Cutout A2C can shimmer on dense foliage while the camera moves.
                setAlphaToCoverage(alphaToCoverageEnabled && m === 1 && !!alphaToCoverage);
            }
        };

        const bindTexCached = (unit, tex, stateKey) => {
            if (state[stateKey] === tex) return;
            if (state.activeUnit !== unit) {
                gl.activeTexture(gl.TEXTURE0 + unit);
                state.activeUnit = unit;
            }
            gl.bindTexture(gl.TEXTURE_2D, tex);
            state[stateKey] = tex;
        };

        // Sampler uniforms are constant.
        gl.uniform1i(this.uniforms.uDiffuse, 0);
        gl.uniform1i(this.uniforms.uDiffuse2, 4);
        gl.uniform1i(this.uniforms.uNormal, 1);
        gl.uniform1i(this.uniforms.uDetail, 5);
        gl.uniform1i(this.uniforms.uSpec, 2);
        gl.uniform1i(this.uniforms.uEmissive, 3);
        gl.uniform1i(this.uniforms.uAO, 6);
        gl.uniform1i(this.uniforms.uAlphaMask, 7);
        gl.uniform1i(this.uniforms.uTintPalette, 8);
        gl.uniform1i(this.uniforms.uHeight, 9);
        gl.uniform1i(this.uniforms.uEnvMap, 10);
        gl.uniform1i(this.uniforms.uDirt, 11);
        gl.uniform1i(this.uniforms.uDamage, 12);
        gl.uniform1i(this.uniforms.uDamageMask, 13);
        gl.uniform1i(this.uniforms.uPuddleMask, 14);
        try { gl.uniform1i(this.uniforms.uBoneTexture, 16); } catch { /* ignore */ }
        // Shadow map (depth) is always on unit 15 to keep the rest stable.
        try { gl.uniform1i(this.uniforms.uShadowMap, 15); } catch { /* ignore */ }
        gl.uniform1i(this.uniforms.uDecodeDiffuseSrgb, 0);
        gl.uniform1i(this.uniforms.uDecodeDiffuse2Srgb, 0);
        gl.uniform1i(this.uniforms.uDecodeEmissiveSrgb, 0);
        gl.uniform1i(this.uniforms.uDecodeTintPaletteSrgb, 0);
        gl.uniform1i(this.uniforms.uDecodeEnvSrgb, 0);
        try {
            // If outputSrgb is false, we output linear so a final post-process pass can tonemap+encode once.
            gl.uniform1i(this.uniforms.uOutputSrgb, (fog && fog.outputSrgb === false) ? 0 : 1);
        } catch { /* ignore */ }
        gl.uniform1i(this.uniforms.uNormalEncoding, 0);
        gl.uniform1i(this.uniforms.uNormalReconstructZ, 1);

        // Build shadow map NOW that we have the per-frame draw list (uses the same VAOs).
        if (shadowOk) {
            try {
                this._renderShadowMap(drawItems, this._shadow.lightViewProj);
            } catch { /* ignore */ }
        }

        // Bind shadow depth texture (even if disabled, bind a dummy depth texture so sampler state is valid).
        {
            const shTex = (shadowOk && this._shadow.depthTex) ? this._shadow.depthTex : (this._shadow.dummyDepthTex || null);
            if (shTex) bindTexCached(15, shTex, 'texShadow');
        }

            for (const it of drawItems) {
            const mesh = it.mesh;
            if (!mesh) continue;

            // Quick isolation switch: if the user disabled water in the UI, skip model-water materials too.
            // This helps identify whether WaterPS (shaderFamily==7) is the culprit for frame-wide corruption.
            try {
                const showWater = (fog && fog.showWater !== undefined) ? !!fog.showWater : true;
                if (!showWater && (it.shaderFamilyInt === 7)) continue;
            } catch { /* ignore */ }
            const useSecondaryMaps = !wireframe;

            this._renderStats.drawCalls++;
            const inst = Number(it.instanceCount) || 0;
            this._renderStats.instances += inst;
            const idx = Number(mesh.indexCount) || 0;
            this._renderStats.triangles += Math.floor((idx / 3) * inst);
            if (it.kind === 'bucket') this._renderStats.bucketDraws++;
            else this._renderStats.submeshDraws++;

            setUvsoCached(it.uvso);
            setUvso1Cached(it.uvso1);
            setUvso2Cached(it.uvso2);
            setUvAnimCached(it.globalAnimUV0, it.globalAnimUV1);
            set1fCached(this.uniforms.uGpuCullRadius, it.gpuCullRadius, 'gpuCullRadius', 0.0);

            // Color pipeline: decide per-texture whether we need shader-side sRGB decode.
            // (sRGB support may exist, but a given texture might still be uploaded as RGBA.)
            let decodeDiffuseSrgb = false;
            let decodeDiffuse2Srgb = false;
            let decodeEmissiveSrgb = false;
            let decodeTintPaletteSrgb = false;

            // Normal decode defaults to reconstruct Z; override via material if present.
            setNormalDecodeCached(it.normalEncoding ?? 0, it.normalReconstructZ ?? 1);

            // Cull + alpha mode render state.
            setCullCached(!!it.doubleSided);
            set1iCached(this.uniforms.uDoubleSidedLighting, it.doubleSidedLighting ? 1 : 0, 'doubleSidedLighting');

            const wheelTag = Number(it.fragmentBoneTag);
            const wheelPivot = VEHICLE_WHEEL_PIVOTS[wheelTag] || null;
            const wheelState = fog?.vehicleWheels || null;
            if (wheelPivot && wheelState) {
                const spin = Number(wheelState.spinRad) || 0.0;
                const steer = (wheelTag === 27922 || wheelTag === 26418)
                    ? (Number(wheelState.steeringRad) || 0.0)
                    : 0.0;
                const cx = Math.cos(spin); const sx = Math.sin(spin);
                const cz = Math.cos(steer); const sz = Math.sin(steer);
                const rotation = this._fragmentRotationScratch;
                rotation[0] = cz; rotation[1] = sz; rotation[2] = 0.0;
                rotation[3] = -sz * cx; rotation[4] = cz * cx; rotation[5] = sx;
                rotation[6] = sz * sx; rotation[7] = -cz * sx; rotation[8] = cx;
                const transformKey = `${wheelTag}:${spin.toFixed(5)}:${steer.toFixed(5)}`;
                if (state.fragmentTransform !== transformKey) {
                    gl.uniform1i(this.uniforms.uFragmentTransformEnabled, 1);
                    gl.uniform3fv(this.uniforms.uFragmentPivot, wheelPivot);
                    gl.uniformMatrix3fv(this.uniforms.uFragmentRotation, false, rotation);
                    state.fragmentTransform = transformKey;
                }
            } else if (state.fragmentTransform !== 'off') {
                gl.uniform1i(this.uniforms.uFragmentTransformEnabled, 0);
                state.fragmentTransform = 'off';
            }

            // Per-draw tint palette. Palette X is selected by the material's shader family;
            // the texture row always comes from the per-entity GTA TintPaletteIndex.
            const strideFloats = Number(it.instanceStrideFloats ?? 16);
            const wantsTintIndex = (strideFloats >= 17);
            // Material palettes must be exact. While one is missing/rejected, disable
            // tint instead of briefly recoloring the prop with the built-in debug palette.
            let tintTex = null;
            let tintReady = false;
            if (!wireframe && it.tintPaletteRel && this.textureStreamer) {
                const url = toAssetUrl(it.tintPaletteRel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'tintPalette' });
                const info = url ? this.textureStreamer.getWithInfo(url, { distance: it.dist, kind: 'tintPalette' }) : { tex: null, isPlaceholder: true, uploadedAsSrgb: false, needsUvFlipY: false };
                if (!info.isPlaceholder && info.tex) {
                    tintTex = info.tex;
                    tintReady = true;
                }
                // Decode palette in shader only if it couldn't be uploaded as sRGB.
                decodeTintPaletteSrgb = !!(info && info.tex && !info.uploadedAsSrgb);
            } else if (!it.tintPaletteRel && this.tintPaletteTex) {
                tintTex = this.tintPaletteTex;
                tintReady = true;
            }
            bindTexCached(8, tintTex || this.tintPaletteTex, 'texTintPalette');
            const tintMode = (it.tintMode | 0);
            const canEnableTint = !!tintReady && (tintMode !== 1 || wantsTintIndex);
            set1iCached(this.uniforms.uEnableTintPalette, canEnableTint ? 1 : 0, 'enableTintPalette');
            set1iCached(this.uniforms.uTintMode, canEnableTint ? tintMode : 0, 'tintMode');
            set1iCached(this.uniforms.uDecodeTintPaletteSrgb, (canEnableTint && decodeTintPaletteSrgb) ? 1 : 0, 'decodeTintPaletteSrgb', 0);

            // Decal tint (shader uses it for decal family; safe to set always).
            set3fCached(this.uniforms.uDecalTint, it.decalTint, 'decalTint', [1.0, 1.0, 1.0]);

            // CodeWalker decal modes (best-effort): support decal_dirt vector alpha mask.
            const sn = String(it.shaderName || '').toLowerCase();
            const decalMode = (sn.includes('decal_dirt')) ? 2
                : ((sn.includes('decal_normal_only') || sn.includes('mirror_decal') || sn.includes('reflect_decal')) ? 3
                    : ((sn.includes('decal_spec_only') || sn.includes('spec_decal')) ? 4 : 1));
            set1iCached(this.uniforms.uDecalMode, decalMode, 'decalMode', 1);
            const mask4 = (decalMode === 2)
                ? (Array.isArray(it.dirtDecalMask) ? it.dirtDecalMask : (Array.isArray(it.ambientDecalMask) ? it.ambientDecalMask : null))
                : null;
            const hasMask4 = !!(Array.isArray(mask4) && mask4.length >= 4);
            set1iCached(this.uniforms.uHasDecalAlphaMaskVec, hasMask4 ? 1 : 0, 'hasDecalAlphaMaskVec', 0);
            set4fCached(this.uniforms.uDecalAlphaMaskVec, hasMask4 ? mask4 : null, 'decalAlphaMaskVec', [0.0, 0.0, 0.0, 0.0]);

            // Distance-map flag (CodeWalker distanceMapSampler).
            set1iCached(this.uniforms.uIsDistMap, it.isDistMap ? 1 : 0, 'isDistMap', 0);

            // Specular fresnel (CodeWalker specularFresnel).
            set1fCached(this.uniforms.uSpecularFresnel, it.specFresnel, 'specFresnel', 0.0);
            // Decal: enable polygon offset + treat as blended. Glass: treat as blended.
            if (it.shaderFamilyInt === 1) {
                const slope = Number(it.decalSlopeScale ?? 1.0);
                const bias = Number(it.decalDepthBias ?? 1.0);
                const p = [Number.isFinite(slope) ? slope : 1.0, Number.isFinite(bias) ? bias : 1.0];
                if (!state.polyOffset || state.polyOffset[0] !== p[0] || state.polyOffset[1] !== p[1]) {
                    gl.enable(gl.POLYGON_OFFSET_FILL);
                    gl.polygonOffset(p[0], p[1]);
                    state.polyOffset = p;
                }
                // Blend ON, depthMask OFF for decals.
                if (state.blendEnabled !== true) {
                    gl.enable(gl.BLEND);
                    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                    state.blendEnabled = true;
                }
                if (state.depthMask !== false) {
                    gl.depthMask(false);
                    state.depthMask = false;
                }
                // Decals should never use alpha-to-coverage.
                try { if (state.alphaToCoverage) gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE); } catch { /* ignore */ }
                state.alphaToCoverage = false;
            } else {
                if (state.polyOffset !== null) {
                    gl.disable(gl.POLYGON_OFFSET_FILL);
                    state.polyOffset = null;
                }
                // For glass/alpha blend we still use existing alpha handling.
                setBlendForAlphaMode(it.alphaModeInt, it.hardAlphaBlend, it.alphaToCoverage);
            }
            // CodeWalker BasicShader: for distance maps (distanceMapSampler), AlphaScale is forced to 1.0.
            // Match that here so IsDistMap alpha math stays consistent even if the material exports AlphaScale.
            const alphaScale = it.isDistMap ? 1.0 : it.alphaScale;
            setAlphaModeCached(it.alphaModeInt, it.alphaCutoff, alphaScale);
            set1fCached(this.uniforms.uHardAlphaBlend, it.hardAlphaBlend, 'hardAlphaBlend', 0.0);

            // Shader family switch + family-specific uniforms.
            if (state.shaderFamily !== it.shaderFamilyInt) {
                gl.uniform1i(this.uniforms.uShaderFamily, it.shaderFamilyInt | 0);
                state.shaderFamily = it.shaderFamilyInt | 0;
            }
            // Terrain mask-mode (parity with CodeWalker TerrainPS variants).
            // *_cm* variants use vc1 = colourmask (no vc0.a blend); others use the blended mask rule.
            try {
                const sn = String(it.shaderName || '').toLowerCase();
                let terrainMaskMode = 0;
                if (it.shaderFamilyInt === 6) {
                    // TerrainPS.hlsl parity:
                    // - *_cm* variants use vc1 = colourmask.
                    // - terrain_cb_w_4lyr_lod uses vc1 directly (ignores colourmask).
                    if (sn.includes('_cm')) terrainMaskMode = 1;
                    else if (sn.includes('_4lyr_lod') && !sn.includes('2tex')) terrainMaskMode = 2;
                }
                if (state.terrainMaskMode !== terrainMaskMode) {
                    gl.uniform1i(this.uniforms.uTerrainMaskMode, terrainMaskMode);
                    state.terrainMaskMode = terrainMaskMode;
                }
            } catch { /* ignore */ }
            // Water family uniforms (best-effort).
            if (it.shaderFamilyInt === 7) {
                set1iCached(this.uniforms.uWaterMode, it.waterMode, 'waterMode', 0);
                set1fCached(this.uniforms.uRippleSpeed, it.rippleSpeed, 'rippleSpeed', 0.0);
                set1fCached(this.uniforms.uRippleScale, it.rippleScale, 'rippleScale', 1.0);
                set1fCached(this.uniforms.uRippleBumpiness, it.rippleBumpiness, 'rippleBumpiness', 0.5);
                set1iCached(this.uniforms.uWaterEnableTexture, it.waterEnableTexture ? 1 : 0, 'waterEnableTexture', 1);
                set1iCached(this.uniforms.uWaterEnableBumpMap, it.waterEnableBumpMap ? 1 : 0, 'waterEnableBumpMap', 1);
                set1iCached(this.uniforms.uWaterEnableFoamMap, it.waterEnableFoamMap ? 1 : 0, 'waterEnableFoamMap', 0);
                set1iCached(this.uniforms.uWaterEnableFlow, it.waterEnableFlow ? 1 : 0, 'waterEnableFlow', 1);
                set1iCached(this.uniforms.uWaterEnableFogtex, it.waterEnableFogtex ? 1 : 0, 'waterEnableFogtex', 0);
                set4fCached(this.uniforms.uWaterFlowParams, it.waterFlowParams, 'waterFlowParams', [1.0, 1.0, 1.0, 1.0]);
                set4fCached(this.uniforms.uWaterFogParams, it.waterFogParams, 'waterFogParams', [0.0, 0.0, 0.0, 0.0]);
            } else {
                set1iCached(this.uniforms.uWaterMode, 0, 'waterMode', 0);
                set1fCached(this.uniforms.uRippleSpeed, 0.0, 'rippleSpeed', 0.0);
                set1fCached(this.uniforms.uRippleScale, 1.0, 'rippleScale', 1.0);
                set1fCached(this.uniforms.uRippleBumpiness, 0.5, 'rippleBumpiness', 0.5);
                set1iCached(this.uniforms.uWaterEnableTexture, 1, 'waterEnableTexture', 1);
                set1iCached(this.uniforms.uWaterEnableBumpMap, 1, 'waterEnableBumpMap', 1);
                set1iCached(this.uniforms.uWaterEnableFoamMap, 0, 'waterEnableFoamMap', 0);
                set1iCached(this.uniforms.uWaterEnableFlow, 1, 'waterEnableFlow', 1);
                set1iCached(this.uniforms.uWaterEnableFogtex, 0, 'waterEnableFogtex', 0);
                set4fCached(this.uniforms.uWaterFlowParams, null, 'waterFlowParams', [1.0, 1.0, 1.0, 1.0]);
                set4fCached(this.uniforms.uWaterFogParams, null, 'waterFogParams', [0.0, 0.0, 0.0, 0.0]);
            }
            // Env color defaults to fog color (no probes yet).
            const env = fog?.color || [0.6, 0.7, 0.8];
            if (!state.envColor || state.envColor[0] !== env[0] || state.envColor[1] !== env[1] || state.envColor[2] !== env[2]) {
                gl.uniform3fv(this.uniforms.uEnvColor, env);
                state.envColor = [env[0], env[1], env[2]];
            }
            if (state.reflectionIntensity !== it.reflectionIntensity) {
                gl.uniform1f(this.uniforms.uReflectionIntensity, Number.isFinite(it.reflectionIntensity) ? it.reflectionIntensity : 0.6);
                state.reflectionIntensity = it.reflectionIntensity;
            }
            if (state.fresnelPower !== it.fresnelPower) {
                gl.uniform1f(this.uniforms.uFresnelPower, Number.isFinite(it.fresnelPower) ? it.fresnelPower : 5.0);
                state.fresnelPower = it.fresnelPower;
            }

            // Env map (best-effort): optional lat-long texture.
            //
            // IMPORTANT (CodeWalker parity):
            // In the "terrain" shader family (TerrainPS*), the samplers commonly named/spec'd like "env/spec"
            // are often repurposed as additional *color* layers (Colourmap3/4). Those should be treated as sRGB
            // color textures (hardware decode), not as linear data textures.
            let decodeEnvSrgb = false;
            if (useSecondaryMaps && it.envRel && this.textureStreamer) {
                const url = toAssetUrl(it.envRel);
                const envKind = (it.shaderFamilyInt === 6) ? 'diffuse' : 'env';
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: envKind });
                const info = url ? this.textureStreamer.getWithInfo(url, { distance: it.dist, kind: envKind }) : { tex: null, isPlaceholder: true, uploadedAsSrgb: false, needsUvFlipY: false };
                bindTexCached(10, info.tex, 'texEnv');
                const hasEnv = (!info.isPlaceholder) && !!info.tex;
                set1iCached(this.uniforms.uHasEnvMap, hasEnv ? 1 : 0, 'hasEnvMap');
                set1iCached(this.uniforms.uFlipEnvY, (hasEnv && info.needsUvFlipY) ? 1 : 0, 'flipEnvY');
                decodeEnvSrgb = hasEnv && (!info.uploadedAsSrgb);
            } else {
                set1iCached(this.uniforms.uHasEnvMap, 0, 'hasEnvMap');
                set1iCached(this.uniforms.uFlipEnvY, 0, 'flipEnvY');
                bindTexCached(10, this._texBlack, 'texEnv');
            }
            set1iCached(this.uniforms.uDecodeEnvSrgb, decodeEnvSrgb ? 1 : 0, 'decodeEnvSrgb');

            // Wetness/parallax knobs
            set1fCached(this.uniforms.uWetness, it.wetness, 'wetness', 0.0);
            set1fCached(this.uniforms.uWetDarken, it.wetDarken, 'wetDarken', 0.0);
            set1fCached(this.uniforms.uWetSpecBoost, it.wetSpecBoost, 'wetSpecBoost', 1.0);
            set3fCached(this.uniforms.uColor, it.baseColor, 'baseColor', [1.0, 1.0, 1.0]);
            set1iCached(this.uniforms.uPedHairTint, it.pedHairTint ? 1 : 0, 'pedHairTint', 0);
            set3fCached(this.uniforms.uPedHairPrimary, this.pedHairPrimary, 'pedHairPrimary', [0.035, 0.012, 0.004]);
            set3fCached(this.uniforms.uPedHairHighlight, this.pedHairHighlight, 'pedHairHighlight', [0.035, 0.012, 0.004]);
            set1iCached(this.uniforms.uVertexColorMode, Number.isFinite(Number(it.vertexColorMode)) ? (Number(it.vertexColorMode) | 0) : 0, 'vertexColorMode');
            // Parallax scale/bias: stored as vec4 in exporter/name-map, use xy.
            {
                const psb = Array.isArray(it.parallaxScaleBias) && it.parallaxScaleBias.length >= 2 ? it.parallaxScaleBias : null;
                const v = psb ? [Number(psb[0]) || 0.0, Number(psb[1]) || 0.0] : [0.0, 0.0];
                const prev = state.parallaxScaleBias;
                if (!(prev && prev[0] === v[0] && prev[1] === v[1])) {
                    gl.uniform2fv(this.uniforms.uParallaxScaleBias, v);
                    state.parallaxScaleBias = v;
                }
            }

            // If a mesh has no UVs, diffuse will sample a constant texel (often looks "untextured").
            if (!mesh.uvBuffer) this._renderStats.drawItemsMissingUv++;

            // Diffuse
            if (!wireframe && it.diffuseRel && this.textureStreamer) {
                const url = toAssetUrl(it.diffuseRel);
                const diffuseKind = String(it.diffuseKind || 'diffuse');
                const missingFromIndex = !url;
                if (!url) {
                    // Resolver returned null => index says this hash is not in the exported set.
                    try {
                        const rel = String(it.diffuseRel || '');
                        const m = this._texFrame?.missingFromExportedSet;
                        if (m) m.set(rel, (m.get(rel) || 0) + 1);
                    } catch { /* ignore */ }
                    this._renderStats.diffuseMissingFromIndex++;
                }
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: diffuseKind });
                const info = url ? this.textureStreamer.getWithInfo(url, { distance: it.dist, kind: diffuseKind }) : { tex: null, isPlaceholder: true, uploadedAsSrgb: false, needsUvFlipY: false };
                const tex = info.tex;
                const hasDiffuse = (!info.isPlaceholder) && !!tex;
                decodeDiffuseSrgb = hasDiffuse && (!info.uploadedAsSrgb);
                set1iCached(this.uniforms.uFlipDiffuseY, (hasDiffuse && info.needsUvFlipY) ? 1 : 0, 'flipDiffuseY');
                bindTexCached(0, tex, 'tex0');
                set1iCached(this.uniforms.uHasDiffuse, hasDiffuse ? 1 : 0, 'hasDiffuse');
                this._renderStats.diffuseWanted++;
                if (hasDiffuse) this._renderStats.diffuseReal++;
                else if (!missingFromIndex) this._renderStats.diffusePlaceholder++;
                if (url && !hasDiffuse) {
                    try {
                        const u = String(url || '');
                        const m2 = this._texFrame?.placeholderUrls;
                        if (m2) m2.set(u, (m2.get(u) || 0) + 1);
                    } catch { /* ignore */ }
                }
                // Cutout meshes derive their silhouette from diffuse alpha. Drawing
                // them with an opaque streaming placeholder exposes their source
                // cards as large blocks (most visibly on ped hair and foliage).
                if (!hasDiffuse && (Number(it.alphaModeInt) | 0) === 1) continue;
            } else {
                set1iCached(this.uniforms.uHasDiffuse, 0, 'hasDiffuse');
                set1iCached(this.uniforms.uFlipDiffuseY, 0, 'flipDiffuseY');
                // IMPORTANT: always bind a safe texture, otherwise stale bindings (eg PostFX scene RT)
                // can trigger a framebuffer-texture feedback loop when rendering into that RT.
                bindTexCached(0, this._texWhite, 'tex0');
            }

            // Alpha mask (decal)
            if (!wireframe && it.alphaMaskRel && this.textureStreamer) {
                const url = toAssetUrl(it.alphaMaskRel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'alphaMask' });
                const info = url ? this.textureStreamer.getWithInfo(url, { distance: it.dist, kind: 'alphaMask' }) : { tex: null, isPlaceholder: true, uploadedAsSrgb: false, needsUvFlipY: false };
                bindTexCached(7, info.tex, 'texAlphaMask');
                const hasAlphaMask = (!info.isPlaceholder) && !!info.tex;
                set1iCached(this.uniforms.uHasAlphaMask, hasAlphaMask ? 1 : 0, 'hasAlphaMask');
                set1iCached(this.uniforms.uFlipAlphaMaskY, (hasAlphaMask && info.needsUvFlipY) ? 1 : 0, 'flipAlphaMaskY');
            } else {
                set1iCached(this.uniforms.uHasAlphaMask, 0, 'hasAlphaMask');
                set1iCached(this.uniforms.uFlipAlphaMaskY, 0, 'flipAlphaMaskY');
                bindTexCached(7, this._texWhite, 'texAlphaMask');
            }

            // Diffuse2
            if (!wireframe && it.diffuse2Rel && this.textureStreamer) {
                const url = toAssetUrl(it.diffuse2Rel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'diffuse2' });
                const info = url ? this.textureStreamer.getWithInfo(url, { distance: it.dist, kind: 'diffuse2' }) : { tex: null, isPlaceholder: true, uploadedAsSrgb: false, needsUvFlipY: false };
                const tex = info.tex;
                const hasDiffuse2 = (!info.isPlaceholder) && !!tex;
                decodeDiffuse2Srgb = hasDiffuse2 && (!info.uploadedAsSrgb);
                set1iCached(this.uniforms.uFlipDiffuse2Y, (hasDiffuse2 && info.needsUvFlipY) ? 1 : 0, 'flipDiffuse2Y');
                bindTexCached(4, tex, 'tex0b');
                set1iCached(this.uniforms.uHasDiffuse2, hasDiffuse2 ? 1 : 0, 'hasDiffuse2');
                // CodeWalker BasicPS always samples Colourmap2 on Texcoord1.
                // In the viewer, only select UV1 if the mesh actually has UV1 (otherwise fall back to UV0).
                const useUv1Requested = (String(it.diffuse2Uv || 'uv1').toLowerCase() !== 'uv0');
                const useUv1 = !!(useUv1Requested && it.meshHasUv1);
                if (state.diffuse2UseUv1 !== useUv1) {
                    gl.uniform1i(this.uniforms.uDiffuse2UseUv1, useUv1 ? 1 : 0);
                    state.diffuse2UseUv1 = useUv1;
                }
            } else {
                set1iCached(this.uniforms.uHasDiffuse2, 0, 'hasDiffuse2');
                set1iCached(this.uniforms.uFlipDiffuse2Y, 0, 'flipDiffuse2Y');
                bindTexCached(4, this._texWhite, 'tex0b');
                if (state.diffuse2UseUv1 !== true) {
                    gl.uniform1i(this.uniforms.uDiffuse2UseUv1, 1);
                    state.diffuse2UseUv1 = true;
                }
            }

            // Dirt (best-effort)
            if (useSecondaryMaps && it.dirtRel && this.textureStreamer) {
                const url = toAssetUrl(it.dirtRel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'dirt' });
                const info = url ? this.textureStreamer.getWithInfo(url, { distance: it.dist, kind: 'dirt' }) : { tex: null, isPlaceholder: true, uploadedAsSrgb: false, needsUvFlipY: false };
                bindTexCached(11, info.tex, 'texDirt');
                const hasDirt = (!info.isPlaceholder) && !!info.tex;
                set1iCached(this.uniforms.uHasDirt, hasDirt ? 1 : 0, 'hasDirt');
                set1iCached(this.uniforms.uFlipDirtY, (hasDirt && info.needsUvFlipY) ? 1 : 0, 'flipDirtY');
            } else {
                set1iCached(this.uniforms.uHasDirt, 0, 'hasDirt');
                set1iCached(this.uniforms.uFlipDirtY, 0, 'flipDirtY');
                bindTexCached(11, this._texBlack, 'texDirt');
            }
            set1fCached(this.uniforms.uDirtLevel, it.dirtLevel, 'dirtLevel', 0.0);
            set3fCached(this.uniforms.uDirtColor, it.dirtColor, 'dirtColor', [0.65, 0.62, 0.6]);

            // Damage + mask (best-effort)
            if (useSecondaryMaps && it.damageRel && this.textureStreamer) {
                const url = toAssetUrl(it.damageRel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'damage' });
                const info = url ? this.textureStreamer.getWithInfo(url, { distance: it.dist, kind: 'damage' }) : { tex: null, isPlaceholder: true, uploadedAsSrgb: false, needsUvFlipY: false };
                bindTexCached(12, info.tex, 'texDamage');
                const hasDamage = (!info.isPlaceholder) && !!info.tex;
                set1iCached(this.uniforms.uHasDamage, hasDamage ? 1 : 0, 'hasDamage');
                set1iCached(this.uniforms.uFlipDamageY, (hasDamage && info.needsUvFlipY) ? 1 : 0, 'flipDamageY');
            } else {
                set1iCached(this.uniforms.uHasDamage, 0, 'hasDamage');
                set1iCached(this.uniforms.uFlipDamageY, 0, 'flipDamageY');
                bindTexCached(12, this._texBlack, 'texDamage');
            }
            if (useSecondaryMaps && it.damageMaskRel && this.textureStreamer) {
                const url = toAssetUrl(it.damageMaskRel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'damageMask' });
                const info = url ? this.textureStreamer.getWithInfo(url, { distance: it.dist, kind: 'damageMask' }) : { tex: null, isPlaceholder: true, uploadedAsSrgb: false, needsUvFlipY: false };
                bindTexCached(13, info.tex, 'texDamageMask');
                const hasDamageMask = (!info.isPlaceholder) && !!info.tex;
                set1iCached(this.uniforms.uHasDamageMask, hasDamageMask ? 1 : 0, 'hasDamageMask');
                set1iCached(this.uniforms.uFlipDamageMaskY, (hasDamageMask && info.needsUvFlipY) ? 1 : 0, 'flipDamageMaskY');
            } else {
                set1iCached(this.uniforms.uHasDamageMask, 0, 'hasDamageMask');
                set1iCached(this.uniforms.uFlipDamageMaskY, 0, 'flipDamageMaskY');
                bindTexCached(13, this._texBlack, 'texDamageMask');
            }

            // Puddle mask (best-effort)
            if (useSecondaryMaps && it.puddleMaskRel && this.textureStreamer) {
                const url = toAssetUrl(it.puddleMaskRel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'puddleMask' });
                const info = url ? this.textureStreamer.getWithInfo(url, { distance: it.dist, kind: 'puddleMask' }) : { tex: null, isPlaceholder: true, uploadedAsSrgb: false, needsUvFlipY: false };
                bindTexCached(14, info.tex, 'texPuddleMask');
                const hasPuddleMask = (!info.isPlaceholder) && !!info.tex;
                set1iCached(this.uniforms.uHasPuddleMask, hasPuddleMask ? 1 : 0, 'hasPuddleMask');
                set1iCached(this.uniforms.uFlipPuddleMaskY, (hasPuddleMask && info.needsUvFlipY) ? 1 : 0, 'flipPuddleMaskY');
            } else {
                set1iCached(this.uniforms.uHasPuddleMask, 0, 'hasPuddleMask');
                set1iCached(this.uniforms.uFlipPuddleMaskY, 0, 'flipPuddleMaskY');
                bindTexCached(14, this._texBlack, 'texPuddleMask');
            }
            set4fCached(this.uniforms.uPuddleParams, it.puddleParams, 'puddleParams', [0.0, 0.0, 0.0, 0.0]);
            set4fCached(this.uniforms.uPuddleScaleRange, it.puddleScaleRange, 'puddleScaleRange', [1.0, 1.0, 1.0, 1.0]);

            // Normal/spec require tangents on the mesh to shade correctly.
            const hasTangents = !!it.meshHasTangents;
            // CodeWalker TerrainPS uses Texcoord1 for Colourmask; only enable mask sampling when UV1 exists.
            set1iCached(this.uniforms.uMeshHasUv1, (it.meshHasUv1 ? 1 : 0), 'meshHasUv1', 0);

            // Per-map UV selectors (0=UV0, 1=UV1, 2=UV2). Defaults are UV0 for all maps.
            set1iCached(this.uniforms.uDiffuseUvSet, (it.diffuseUvSet | 0), 'diffuseUvSet', 0);
            set1iCached(this.uniforms.uNormalUvSet, (it.normalUvSet | 0), 'normalUvSet');
            set1iCached(this.uniforms.uSpecUvSet, (it.specUvSet | 0), 'specUvSet');
            set1iCached(this.uniforms.uDetailUvSet, (it.detailUvSet | 0), 'detailUvSet');
            set1iCached(this.uniforms.uAOUvSet, (it.aoUvSet | 0), 'aoUvSet');
            set1iCached(this.uniforms.uEmissiveUvSet, (it.emissiveUvSet | 0), 'emissiveUvSet');

            if (useSecondaryMaps && hasTangents && it.normalRel && this.textureStreamer) {
                const url = toAssetUrl(it.normalRel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'normal' });
                const info = url ? this.textureStreamer.getWithInfo(url, { distance: it.dist, kind: 'normal' }) : { tex: null, isPlaceholder: true, uploadedAsSrgb: false, needsUvFlipY: false };
                bindTexCached(1, info.tex, 'tex1');
                const hasNormal = (!info.isPlaceholder) && !!info.tex;
                set1iCached(this.uniforms.uHasNormal, hasNormal ? 1 : 0, 'hasNormal');
                set1fCached(this.uniforms.uNormalScale, it.bumpiness, 'normalScale', 1.0);
                set1iCached(this.uniforms.uFlipNormalY, (hasNormal && info.needsUvFlipY) ? 1 : 0, 'flipNormalY');
            } else {
                set1iCached(this.uniforms.uHasNormal, 0, 'hasNormal');
                set1fCached(this.uniforms.uNormalScale, 1.0, 'normalScale', 1.0);
                set1iCached(this.uniforms.uFlipNormalY, 0, 'flipNormalY');
                bindTexCached(1, this._texNormalFlat, 'tex1');
            }

            // Detail (only meaningful if we have tangents + normal path)
            if (useSecondaryMaps && hasTangents && it.detailRel && this.textureStreamer) {
                const url = toAssetUrl(it.detailRel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'detail' });
                const info = url ? this.textureStreamer.getWithInfo(url, { distance: it.dist, kind: 'detail' }) : { tex: null, isPlaceholder: true, uploadedAsSrgb: false, needsUvFlipY: false };
                bindTexCached(5, info.tex, 'texDetail');
                const hasDetail = (!info.isPlaceholder) && !!info.tex;
                set1iCached(this.uniforms.uHasDetail, hasDetail ? 1 : 0, 'hasDetail');
                set1iCached(this.uniforms.uFlipDetailY, (hasDetail && info.needsUvFlipY) ? 1 : 0, 'flipDetailY');
                // detailSettings: [x,y,z,w]
                const ds = Array.isArray(it.detailSettings) && it.detailSettings.length >= 4 ? it.detailSettings : [0.0, 0.0, 1.0, 1.0];
                const prev = state.detailSettings;
                const a0 = Number(ds[0]), a1 = Number(ds[1]), a2 = Number(ds[2]), a3 = Number(ds[3]);
                const v = [
                    Number.isFinite(a0) ? a0 : 0.0,
                    Number.isFinite(a1) ? a1 : 0.0,
                    Number.isFinite(a2) ? a2 : 1.0,
                    Number.isFinite(a3) ? a3 : 1.0,
                ];
                if (!(prev && prev[0] === v[0] && prev[1] === v[1] && prev[2] === v[2] && prev[3] === v[3])) {
                    gl.uniform4fv(this.uniforms.uDetailSettings, v);
                    state.detailSettings = v;
                }
            } else {
                set1iCached(this.uniforms.uHasDetail, 0, 'hasDetail');
                set1iCached(this.uniforms.uFlipDetailY, 0, 'flipDetailY');
                bindTexCached(5, this._texNormalFlat, 'texDetail');
                if (!state.detailSettings || state.detailSettings[0] !== 0.0 || state.detailSettings[1] !== 0.0 || state.detailSettings[2] !== 1.0 || state.detailSettings[3] !== 1.0) {
                    gl.uniform4fv(this.uniforms.uDetailSettings, [0.0, 0.0, 1.0, 1.0]);
                    state.detailSettings = [0.0, 0.0, 1.0, 1.0];
                }
            }

            if (useSecondaryMaps && hasTangents && it.specRel && this.textureStreamer) {
                const url = toAssetUrl(it.specRel);
                const specKind = (it.shaderFamilyInt === 6) ? 'diffuse' : 'spec';
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: specKind });
                const info = url ? this.textureStreamer.getWithInfo(url, { distance: it.dist, kind: specKind }) : { tex: null, isPlaceholder: true, uploadedAsSrgb: false, needsUvFlipY: false };
                bindTexCached(2, info.tex, 'tex2');
                const hasSpec = (!info.isPlaceholder) && !!info.tex;
                set1iCached(this.uniforms.uHasSpec, hasSpec ? 1 : 0, 'hasSpec');
                set1iCached(this.uniforms.uFlipSpecY, (hasSpec && info.needsUvFlipY) ? 1 : 0, 'flipSpecY');
            } else {
                set1iCached(this.uniforms.uHasSpec, 0, 'hasSpec');
                set1iCached(this.uniforms.uFlipSpecY, 0, 'flipSpecY');
                bindTexCached(2, this._texBlack, 'tex2');
            }
            set1fCached(this.uniforms.uSpecularIntensity, it.specIntensity, 'specIntensity', 0.25);
            set1fCached(this.uniforms.uSpecularPower, it.specPower, 'specPower', 24.0);
            set1fCached(this.uniforms.uSpecularFalloffMult, it.specFalloffMult, 'specFalloffMult', 1.0);
            set3fCached(this.uniforms.uSpecMaskWeights, it.specMaskWeights, 'specMaskWeights', [1.0, 0.0, 0.0]);

            // Emissive (doesn't require tangents)
            if (!wireframe && it.emissiveRel && this.textureStreamer) {
                const url = toAssetUrl(it.emissiveRel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'emissive' });
                const info = url ? this.textureStreamer.getWithInfo(url, { distance: it.dist, kind: 'emissive' }) : { tex: null, isPlaceholder: true, uploadedAsSrgb: false, needsUvFlipY: false };
                const tex = info.tex;
                const hasEmissive = (!info.isPlaceholder) && !!tex;
                decodeEmissiveSrgb = hasEmissive && (!info.uploadedAsSrgb);
                set1iCached(this.uniforms.uFlipEmissiveY, (hasEmissive && info.needsUvFlipY) ? 1 : 0, 'flipEmissiveY');
                bindTexCached(3, tex, 'tex3');
                set1iCached(this.uniforms.uHasEmissive, hasEmissive ? 1 : 0, 'hasEmissive');
                set1fCached(this.uniforms.uEmissiveIntensity, it.emissiveIntensity, 'emissiveIntensity', 1.0);
            } else {
                set1iCached(this.uniforms.uHasEmissive, 0, 'hasEmissive');
                set1fCached(this.uniforms.uEmissiveIntensity, 1.0, 'emissiveIntensity', 1.0);
                set1iCached(this.uniforms.uFlipEmissiveY, 0, 'flipEmissiveY');
                bindTexCached(3, this._texBlack, 'tex3');
            }

            // Apply per-sampler decode toggles (must happen after we know whether we bound placeholders).
            setDecodeSrgbCached('decodeDiffuseSrgb', decodeDiffuseSrgb);
            setDecodeSrgbCached('decodeDiffuse2Srgb', decodeDiffuse2Srgb);
            setDecodeSrgbCached('decodeEmissiveSrgb', decodeEmissiveSrgb);

            // AO / occlusion
            if (useSecondaryMaps && it.aoRel && this.textureStreamer) {
                const url = toAssetUrl(it.aoRel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'ao' });
                const info = url ? this.textureStreamer.getWithInfo(url, { distance: it.dist, kind: 'ao' }) : { tex: null, isPlaceholder: true, uploadedAsSrgb: false, needsUvFlipY: false };
                bindTexCached(6, info.tex, 'texAO');
                const hasAO = (!info.isPlaceholder) && !!info.tex;
                set1iCached(this.uniforms.uHasAO, hasAO ? 1 : 0, 'hasAO');
                set1fCached(this.uniforms.uAOStrength, it.aoStrength, 'aoStrength', 1.0);
                set1iCached(this.uniforms.uFlipAOY, (hasAO && info.needsUvFlipY) ? 1 : 0, 'flipAOY');
            } else {
                set1iCached(this.uniforms.uHasAO, 0, 'hasAO');
                set1fCached(this.uniforms.uAOStrength, 1.0, 'aoStrength', 1.0);
                set1iCached(this.uniforms.uFlipAOY, 0, 'flipAOY');
                bindTexCached(6, this._texWhite, 'texAO');
            }

            // Height / parallax map (optional). Only used when shaderFamily is parallax (4), but can be provided for others.
            if (useSecondaryMaps && it.heightRel && this.textureStreamer) {
                const url = toAssetUrl(it.heightRel);
                if (url) this.textureStreamer.touch(url, { distance: it.dist, kind: 'height' });
                const info = url ? this.textureStreamer.getWithInfo(url, { distance: it.dist, kind: 'height' }) : { tex: null, isPlaceholder: true, uploadedAsSrgb: false, needsUvFlipY: false };
                bindTexCached(9, info.tex, 'texHeight');
                const hasHeight = (!info.isPlaceholder) && !!info.tex;
                set1iCached(this.uniforms.uHasHeight, hasHeight ? 1 : 0, 'hasHeight');
                set1iCached(this.uniforms.uFlipHeightY, (hasHeight && info.needsUvFlipY) ? 1 : 0, 'flipHeightY');
            } else {
                set1iCached(this.uniforms.uHasHeight, 0, 'hasHeight');
                set1iCached(this.uniforms.uFlipHeightY, 0, 'flipHeightY');
                bindTexCached(9, this._texBlack, 'texHeight');
            }

            const wantsSkinning = !!(
                it.skinned &&
                it.hasBlendWeights &&
                it.hasBlendIndices &&
                Array.isArray(it.boneIds) &&
                it.boneIds.length &&
                this.hasSkinningSkeleton()
            );
            const boneTex = wantsSkinning ? this._getBonePaletteTexture(it.boneIds) : this._identityBoneTexture;
            if (boneTex) bindTexCached(16, boneTex, 'texBone');
            set1iCached(this.uniforms.uSkinningEnabled, (wantsSkinning && boneTex) ? 1 : 0, 'skinEnabled');

            // VAO bind + slow-path instancing attr binding.
            if (it.vao) {
                if (state.vao !== it.vao) {
                    gl.bindVertexArray(it.vao);
                    state.vao = it.vao;
                }
            } else {
                // Slow path: bind mesh VAO and instance attrs (mutates VAO state; used only when per-entry VAO wasn't built yet).
                if (state.vao !== mesh.vao) {
                    gl.bindVertexArray(mesh.vao);
                    state.vao = mesh.vao;
                }
                gl.bindBuffer(gl.ARRAY_BUFFER, it.instanceBuffer);
                const strideFloats = Number(it.instanceStrideFloats ?? 16);
                const bytesPerMat = Math.max(16, strideFloats) * 4;
                const bytesPerVec4 = 4 * 4;
                for (let i = 0; i < 4; i++) {
                    const loc = 4 + i;
                    gl.enableVertexAttribArray(loc);
                    gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, bytesPerMat, i * bytesPerVec4);
                    gl.vertexAttribDivisor(loc, 1);
                }
                // Optional tint index at location 12.
                if (strideFloats >= 17) {
                    gl.enableVertexAttribArray(12);
                    gl.vertexAttribPointer(12, 1, gl.FLOAT, false, bytesPerMat, 16 * 4);
                    gl.vertexAttribDivisor(12, 1);
                } else {
                    try {
                        gl.disableVertexAttribArray(12);
                        gl.vertexAttrib1f(12, 0.0);
                    } catch { /* ignore */ }
                }
            }

            // If this drawable has previously triggered a GL error, skip it to keep the frame usable.
            // (Also helps identify which specific drawable is "the one".)
            try {
                const key = String(it?.file ?? it?.bucketId ?? it?.hash ?? '');
                if (key && this._badDrawKeys.has(key)) continue;
            } catch { /* ignore */ }

            const drawWireframe = wireframe && !!mesh.lineIdxBuffer && Number(mesh.lineIndexCount) > 0;
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, drawWireframe ? mesh.lineIdxBuffer : mesh.idxBuffer);
            gl.drawElementsInstanced(
                drawWireframe ? gl.LINES : gl.TRIANGLES,
                drawWireframe ? mesh.lineIndexCount : mesh.indexCount,
                drawWireframe ? (mesh.lineIndexType || gl.UNSIGNED_INT) : gl.UNSIGNED_INT,
                0,
                it.instanceCount
            );

            // One-shot GL error trap. Disabled by default because gl.getError() can
            // serialize WebGL after every draw and dominate frame time.
            if (this.debugDrawGlErrors) {
                try {
                    const err = gl.getError();
                    if (err && err !== gl.NO_ERROR) {
                        const key = String(it?.file ?? it?.bucketId ?? it?.hash ?? '');
                        if (key) this._badDrawKeys.add(key);
                        this._lastGlError = {
                            err,
                            key,
                            file: String(it?.file ?? ''),
                            shaderName: String(it?.shaderName ?? ''),
                            whenMs: (performance?.now?.() ?? Date.now()),
                        };
                        console.error('InstancedModelRenderer: GL error during drawable draw (will skip this key next frames):', this._lastGlError);
                        // Abort remaining draws this frame to avoid cascaded state issues.
                        break;
                    }
                } catch { /* ignore */ }
            }
        }

            // Leave GL in a predictable state.
            try { gl.disable(gl.POLYGON_OFFSET_FILL); } catch { /* ignore */ }
            gl.bindVertexArray(null);
        } finally {
            // Always restore state, even if a bad drawable triggers an early exit.
            try { _restoreState?.(); } catch { /* ignore */ }
            this._fastTextureUnitRestore = false;
        }
    }
}


