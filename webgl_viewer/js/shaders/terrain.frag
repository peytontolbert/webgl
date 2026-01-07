#version 300 es
precision highp float;
precision highp int;

// Common includes
#include "common.glsl"
#include "shadowmap.glsl"

// Scene uniforms (b0)
layout(std140) uniform SceneVars {
    mat4 uViewProjectionMatrix;
    mat4 uModelMatrix;
    mat3 uNormalMatrix;
    vec3 uTerrainBounds;
    vec3 uTerrainSize;
    float uTime;
};

// Entity uniforms (b2)
layout(std140) uniform EntityVars {
    vec4 uCamRel;
    vec4 uOrientation;
    uint uHasSkeleton;
    uint uHasTransforms;
    uint uTintPaletteIndex;
    uint uPad1;
    vec3 uScale;
    uint uPad2;
};

// Model uniforms (b3)
layout(std140) uniform ModelVars {
    mat4 uTransform;
};

// Geometry uniforms (b4)
layout(std140) uniform GeomVars {
    uint uEnableTint;
    float uTintYVal;
    uint uPad4;
    uint uPad5;
};

// Inputs from vertex shader
in vec3 vPosition;
in vec3 vNormal;
in vec4 vColor0;
in vec4 vColor1;
in vec4 vTint;
in vec2 vTexcoord0;
in vec2 vTexcoord1;
in vec2 vTexcoord2;
in vec4 vShadows;
in vec4 vLightShadow;
in vec4 vTangent;
in vec4 vBitangent;
in vec3 vCamRelPos;

// Outputs
layout(location = 0) out vec4 fDiffuse;
layout(location = 1) out vec4 fNormal;
layout(location = 2) out vec4 fSpecular;
layout(location = 3) out vec4 fIrradiance;

// Textures
uniform sampler2D uColorMap0;
uniform sampler2D uColorMap1;
uniform sampler2D uColorMap2;
uniform sampler2D uColorMap3;
uniform sampler2D uColorMap4;
uniform sampler2D uBlendMask;
uniform sampler2D uNormalMap0;
uniform sampler2D uNormalMap1;
uniform sampler2D uNormalMap2;
uniform sampler2D uNormalMap3;
uniform sampler2D uNormalMap4;
uniform sampler2D uTintPalette;

// Texture parameters
uniform bool uEnableTexture0;
uniform bool uEnableTexture1;
uniform bool uEnableTexture2;
uniform bool uEnableTexture3;
uniform bool uEnableTexture4;
uniform bool uEnableTextureMask;
uniform bool uEnableNormalMap;
uniform bool uEnableVertexColour;

// Lighting uniforms
uniform float uSpecularIntensity;
uniform float uSpecularPower;

// Terrain blend mode:
// - 0: RGBA splat weights from uBlendMask (viewer heightmap terrain path)
// - 1: CodeWalker-style blend (vertex colours + optional mask), matching TerrainPS_Deferred.hlsl
uniform int uTerrainBlendMode;
uniform float uBumpiness;

// Helper function to sample texture with fallback
vec4 SampleTexture(sampler2D tex, vec2 uv, bool enabled) {
    if (!enabled) return vec4(0.0);
    return texture(tex, uv);
}

// Helper function to blend textures
vec4 BlendTextures(vec4 base, vec4 blend, float mask) {
    return mix(base, blend, mask);
}

// CodeWalker-like normal mapping:
// TerrainPS.hlsl uses NormalMap(nv.xy, bumpiness, N, T, B) where nv.xy is in [0..1].
vec3 NormalMapCW(vec2 nvXY, float bumpiness, vec3 n, vec3 t, vec3 b) {
    vec2 xy = (nvXY * 2.0 - 1.0) * max(0.0, bumpiness);
    float zz = max(0.0, 1.0 - dot(xy, xy));
    float z = sqrt(zz);
    return normalize(n * z + t * xy.x + b * xy.y);
}

void main() {
    // Initialize outputs
    vec4 diffuse = vec4(0.0);
    vec3 normal = vNormal;
    vec4 specular = vec4(0.0);
    vec4 irradiance = vec4(0.0);
    
    // --- Texture sampling ---
    // We support two blend conventions:
    // - Viewer heightmap terrain: uBlendMask is RGBA weights sampled using vTexcoord0 (image-space, needs Y flip)
    // - CodeWalker terrain family: mask uses Texcoord1; layers use Texcoord0 by default (see TerrainPS*.hlsl)

    // Pre-sample all 4 layer diffuse maps. In CodeWalker naming these correspond to Colourmap1..4.
    // Our binding uses uColorMap0..3 for layer1..4.
    vec4 c1 = SampleTexture(uColorMap0, (uTerrainBlendMode == 1) ? vTexcoord0 : vTexcoord1, uEnableTexture0);
    vec4 c2 = SampleTexture(uColorMap1, (uTerrainBlendMode == 1) ? vTexcoord0 : vTexcoord1, uEnableTexture1);
    vec4 c3 = SampleTexture(uColorMap2, (uTerrainBlendMode == 1) ? vTexcoord0 : vTexcoord1, uEnableTexture2);
    vec4 c4 = SampleTexture(uColorMap3, (uTerrainBlendMode == 1) ? vTexcoord0 : vTexcoord1, uEnableTexture3);

    vec4 n1s = SampleTexture(uNormalMap0, (uTerrainBlendMode == 1) ? vTexcoord0 : vTexcoord1, uEnableTexture0);
    vec4 n2s = SampleTexture(uNormalMap1, (uTerrainBlendMode == 1) ? vTexcoord0 : vTexcoord1, uEnableTexture1);
    vec4 n3s = SampleTexture(uNormalMap2, (uTerrainBlendMode == 1) ? vTexcoord0 : vTexcoord1, uEnableTexture2);
    vec4 n4s = SampleTexture(uNormalMap3, (uTerrainBlendMode == 1) ? vTexcoord0 : vTexcoord1, uEnableTexture3);

    if (uTerrainBlendMode == 1) {
        // --- CodeWalker-style blend ---
        vec4 vc0 = vColor0;
        vec4 vc1 = vColor1;
        vec4 m = (uEnableTextureMask) ? texture(uBlendMask, vTexcoord1) : vc1;
        // TerrainPS: vc1 = m*(1 - vc0.a) + vc1*vc0.a
        vc1 = m * (1.0 - vc0.a) + vc1 * vc0.a;

        // TerrainPS: t1 = c1*(1-vc1.b) + c2*vc1.b; t2 = c3*(1-vc1.b) + c4*vc1.b; tv = t1*(1-vc1.g) + t2*vc1.g
        vec4 t1 = mix(c1, c2, vc1.b);
        vec4 t2 = mix(c3, c4, vc1.b);
        diffuse = mix(t1, t2, vc1.g);

        if (uEnableNormalMap) {
            vec4 nn1 = mix(n1s, n2s, vc1.b);
            vec4 nn2 = mix(n3s, n4s, vc1.b);
            vec4 nv = mix(nn1, nn2, vc1.g);
            // Use CodeWalker-like normal map decode: only XY is used, bumpiness scales tangent contribution.
            normal = NormalMapCW(nv.xy, uBumpiness, normal, vTangent.xyz, vBitangent.xyz);
        }
    } else {
        // --- RGBA splat weights (heightmap terrain path) ---
        // Sample blend mask (match heightmap convention: v increases downward in vTexcoord0)
        vec2 maskUv = vec2(vTexcoord0.x, 1.0 - vTexcoord0.y);
        vec4 w = SampleTexture(uBlendMask, maskUv, uEnableTextureMask);
        float sumW = w.r + w.g + w.b + w.a;
        if (sumW <= 1e-5) {
            w = vec4(1.0, 0.0, 0.0, 0.0);
        } else {
            w /= sumW;
        }
        diffuse = (c1 * w.r) + (c2 * w.g) + (c3 * w.b) + (c4 * w.a);

        if (uEnableNormalMap) {
            vec4 nv = (n1s * w.r) + (n2s * w.g) + (n3s * w.b) + (n4s * w.a);
            // Use generic normal map decode (XYZ+W) for this mode.
            normal = NormalMap(normal, vTangent.xyz, vBitangent.xyz, nv);
        }
    }
    
    // Apply tint if enabled
    if (uEnableTint != 0u) {
        vec4 tint = texture(uTintPalette, vec2(vTint.x, uTintYVal));
        diffuse *= tint;
    }
    
    // Vertex colour usage in CodeWalker TerrainPS is shader-variant dependent and not consistently applied.
    // Keep it disabled by default; if enabled, apply as a simple multiplier for debugging.
    if (uEnableVertexColour) diffuse *= vColor0;
    
    // Calculate lighting
    vec3 lightDir = normalize(uLightDir);
    float NdotL = max(dot(normal, lightDir), 0.0);
    vec3 viewDir = normalize(-vCamRelPos);
    vec3 halfDir = normalize(lightDir + viewDir);
    float NdotH = max(dot(normal, halfDir), 0.0);
    
    // Calculate specular
    float specularTerm = pow(NdotH, uSpecularPower);
    specular = vec4(uSpecularIntensity * specularTerm);
    
    // Calculate irradiance (lighting, not tonemapped):
    // IMPORTANT: don't multiply ambient by uLightColor (that blows out HDR).
    irradiance = vec4(vec3(uAmbientIntensity) + (uLightColor * NdotL), 1.0);
    
    // Apply shadows
    float shadow = vShadows.x;
    irradiance *= shadow;
    
    // Set outputs
    fDiffuse = diffuse;
    fNormal = vec4(normal * 0.5 + 0.5, 1.0);
    fSpecular = specular;
    fIrradiance = irradiance;
} 