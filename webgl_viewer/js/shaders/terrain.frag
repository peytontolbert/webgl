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

// Helper function to sample texture with fallback
vec4 SampleTexture(sampler2D tex, vec2 uv, bool enabled) {
    if (!enabled) return vec4(0.0);
    return texture(tex, uv);
}

// Helper function to blend textures
vec4 BlendTextures(vec4 base, vec4 blend, float mask) {
    return mix(base, blend, mask);
}

void main() {
    // Initialize outputs
    vec4 diffuse = vec4(0.0);
    vec3 normal = vNormal;
    vec4 specular = vec4(0.0);
    vec4 irradiance = vec4(0.0);
    
    // Sample blend mask (match heightmap convention: v increases downward in vTexcoord0)
    vec2 maskUv = vec2(vTexcoord0.x, 1.0 - vTexcoord0.y);
    vec4 w = SampleTexture(uBlendMask, maskUv, uEnableTextureMask);
    float sumW = w.r + w.g + w.b + w.a;
    if (sumW <= 1e-5) {
        w = vec4(1.0, 0.0, 0.0, 0.0);
    } else {
        w /= sumW;
    }

    // Sample and blend tiled layer textures (use vTexcoord1 for tiling)
    vec4 tex0 = SampleTexture(uColorMap0, vTexcoord1, uEnableTexture0);
    vec4 tex1 = SampleTexture(uColorMap1, vTexcoord1, uEnableTexture1);
    vec4 tex2 = SampleTexture(uColorMap2, vTexcoord1, uEnableTexture2);
    vec4 tex3 = SampleTexture(uColorMap3, vTexcoord1, uEnableTexture3);
    vec4 tex4 = SampleTexture(uColorMap4, vTexcoord1, uEnableTexture4);

    // 4-layer blend using the mask weights. (If uColorMap4 is unused, keep uEnableTexture4=false.)
    diffuse = (tex0 * w.r) + (tex1 * w.g) + (tex2 * w.b) + (tex3 * w.a);
    // Optional extra contribution slot (disabled by default)
    if (uEnableTexture4) {
        diffuse = BlendTextures(diffuse, tex4, 0.0);
    }
    
    // Apply tint if enabled
    if (uEnableTint != 0u) {
        vec4 tint = texture(uTintPalette, vec2(vTint.x, uTintYVal));
        diffuse *= tint;
    }
    
    // Apply vertex color if enabled
    if (uEnableVertexColour) {
        diffuse *= vColor1;
    }
    
    // Sample normal maps if enabled
    if (uEnableNormalMap) {
        vec4 normal0 = SampleTexture(uNormalMap0, vTexcoord0, uEnableTexture0);
        vec4 normal1 = SampleTexture(uNormalMap1, vTexcoord1, uEnableTexture1);
        vec4 normal2 = SampleTexture(uNormalMap2, vTexcoord2, uEnableTexture2);
        vec4 normal3 = SampleTexture(uNormalMap3, vTexcoord1, uEnableTexture3);
        vec4 normal4 = SampleTexture(uNormalMap4, vTexcoord2, uEnableTexture4);
        
        // Blend normal maps
        vec4 blendedNormal = BlendTextures(normal0, normal1, vColor0.r);
        blendedNormal = BlendTextures(blendedNormal, normal2, vColor0.g);
        blendedNormal = BlendTextures(blendedNormal, normal3, vColor0.b);
        blendedNormal = BlendTextures(blendedNormal, normal4, vColor0.a);
        
        // Apply normal mapping
        normal = NormalMap(normal, vTangent.xyz, vBitangent.xyz, blendedNormal);
    }
    
    // Calculate lighting
    vec3 lightDir = normalize(uLightDir);
    float NdotL = max(dot(normal, lightDir), 0.0);
    vec3 viewDir = normalize(-vCamRelPos);
    vec3 halfDir = normalize(lightDir + viewDir);
    float NdotH = max(dot(normal, halfDir), 0.0);
    
    // Calculate specular
    float specularTerm = pow(NdotH, uSpecularPower);
    specular = vec4(uSpecularIntensity * specularTerm);
    
    // Calculate irradiance
    // uLightColor is vec3; vec4(vec3) is not a valid constructor in GLSL ES 3.00.
    irradiance = vec4(uLightColor * (NdotL + uAmbientIntensity), 1.0);
    
    // Apply shadows
    float shadow = vShadows.x;
    irradiance *= shadow;
    
    // Set outputs
    fDiffuse = diffuse;
    fNormal = vec4(normal * 0.5 + 0.5, 1.0);
    fSpecular = specular;
    fIrradiance = irradiance;
} 