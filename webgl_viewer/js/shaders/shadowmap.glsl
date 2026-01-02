// Shadow mapping functionality

// Shadow map uniforms (b1)
layout(std140) uniform ShadowmapVars {
    vec3 uLightDir;
    vec3 uLightColor;
    float uAmbientIntensity;
    mat4 uLightViewMatrix;
    mat4 uLightProjMatrix;
    vec4 uCascadeSplits;
    vec4 uCascadeScales;
    vec4 uCascadeOffsets;
    float uShadowBias;
    float uShadowStrength;
    float uShadowSoftness;
    uint uEnableShadows;
};

// Shadow map texture
uniform sampler2D uShadowMap;

// --- Shadow sampling helpers ---
// Notes:
// - This is a simplified, single-directional shadow map path (no cascades yet).
// - The uniform block still contains cascade fields for future parity, but we do not use them here.

float _shadowCompare(vec2 uv, float depth01, float bias) {
    // Depth texture stores depth in [0..1].
    float shadowDepth = texture(uShadowMap, uv).r;
    return (depth01 - bias > shadowDepth) ? 0.0 : 1.0;
}

// Calculate shadow amount for a world/view-space position, returning [0..1].
// Also outputs the raw light clip position (for debugging/visualization if desired).
float ShadowmapSceneDepth(vec3 worldPos, out vec4 lightSpacePos) {
    if (uEnableShadows == 0u) {
        lightSpacePos = vec4(0.0);
        return 1.0;
    }

    // Transform position to light clip space.
    lightSpacePos = uLightProjMatrix * uLightViewMatrix * vec4(worldPos, 1.0);

    // Project to NDC.
    vec3 ndc = lightSpacePos.xyz / max(lightSpacePos.w, 1e-6);
    vec2 uv = ndc.xy * 0.5 + 0.5;
    float depth01 = ndc.z * 0.5 + 0.5;

    // Early out if outside the shadow map.
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        return 1.0;
    }

    // Constant-ish bias. (Slope-scale would need a normal.)
    float bias = max(0.0, uShadowBias);

    // PCF softness: interpret as a radius in texels (0 = hard).
    float r = max(0.0, uShadowSoftness);
    if (r <= 0.0) {
        return _shadowCompare(uv, depth01, bias);
    }

    // 3x3 PCF kernel. We assume a square shadow map; caller should set softness accordingly.
    vec2 texel = 1.0 / vec2(textureSize(uShadowMap, 0));
    vec2 duv = texel * r;
    float sum = 0.0;
    sum += _shadowCompare(uv + vec2(-duv.x, -duv.y), depth01, bias);
    sum += _shadowCompare(uv + vec2( 0.0,   -duv.y), depth01, bias);
    sum += _shadowCompare(uv + vec2( duv.x, -duv.y), depth01, bias);
    sum += _shadowCompare(uv + vec2(-duv.x,  0.0),   depth01, bias);
    sum += _shadowCompare(uv + vec2( 0.0,    0.0),   depth01, bias);
    sum += _shadowCompare(uv + vec2( duv.x,  0.0),   depth01, bias);
    sum += _shadowCompare(uv + vec2(-duv.x,  duv.y), depth01, bias);
    sum += _shadowCompare(uv + vec2( 0.0,    duv.y), depth01, bias);
    sum += _shadowCompare(uv + vec2( duv.x,  duv.y), depth01, bias);
    return sum / 9.0;
}

// Calculate shadow amount with cascades
float ShadowAmount(vec4 shadowCoord, float unusedShadowDepth) {
    // Kept for compatibility with older shader code; treat as the same as ShadowmapSceneDepth.
    vec3 ndc = shadowCoord.xyz / max(shadowCoord.w, 1e-6);
    vec2 uv = ndc.xy * 0.5 + 0.5;
    float depth01 = ndc.z * 0.5 + 0.5;
    if (uEnableShadows == 0u) return 1.0;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
    float bias = max(0.0, uShadowBias);
    return _shadowCompare(uv, depth01, bias);
}

// Calculate shadow amount with PCF
float ShadowAmountPCF(vec4 shadowCoord, float shadowDepth) {
    if (uEnableShadows == 0u) return 1.0;
    vec3 ndc = shadowCoord.xyz / max(shadowCoord.w, 1e-6);
    vec2 uv = ndc.xy * 0.5 + 0.5;
    float depth01 = ndc.z * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
    float bias = max(0.0, uShadowBias);

    float r = max(0.0, uShadowSoftness);
    if (r <= 0.0) return _shadowCompare(uv, depth01, bias);

    vec2 texel = 1.0 / vec2(textureSize(uShadowMap, 0));
    vec2 duv = texel * r;
    float sum = 0.0;
    sum += _shadowCompare(uv + vec2(-duv.x, -duv.y), depth01, bias);
    sum += _shadowCompare(uv + vec2( 0.0,   -duv.y), depth01, bias);
    sum += _shadowCompare(uv + vec2( duv.x, -duv.y), depth01, bias);
    sum += _shadowCompare(uv + vec2(-duv.x,  0.0),   depth01, bias);
    sum += _shadowCompare(uv + vec2( 0.0,    0.0),   depth01, bias);
    sum += _shadowCompare(uv + vec2( duv.x,  0.0),   depth01, bias);
    sum += _shadowCompare(uv + vec2(-duv.x,  duv.y), depth01, bias);
    sum += _shadowCompare(uv + vec2( 0.0,    duv.y), depth01, bias);
    sum += _shadowCompare(uv + vec2( duv.x,  duv.y), depth01, bias);
    return sum / 9.0;
}

// Calculate shadow amount with PCSS
float ShadowAmountPCSS(vec4 shadowCoord, float shadowDepth) {
    // Not implemented in simplified path.
    return ShadowAmount(shadowCoord, shadowDepth);
}

// Calculate shadow amount with VSM
float ShadowAmountVSM(vec4 shadowCoord, float shadowDepth) {
    // Not supported with a single depth map.
    return ShadowAmount(shadowCoord, shadowDepth);
}

// Calculate shadow amount with ESM
float ShadowAmountESM(vec4 shadowCoord, float shadowDepth) {
    // Not supported with a single depth map.
    return ShadowAmount(shadowCoord, shadowDepth);
}

// Calculate shadow amount with MSM
float ShadowAmountMSM(vec4 shadowCoord, float shadowDepth) {
    // Not supported with a single depth map.
    return ShadowAmount(shadowCoord, shadowDepth);
} 