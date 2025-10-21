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

// Calculate scene depth for shadow mapping
float ShadowmapSceneDepth(vec3 worldPos, out vec4 lightSpacePos) {
    if (uEnableShadows == 0u) {
        lightSpacePos = vec4(0.0);
        return 1.0;
    }
    
    // Transform position to light space
    lightSpacePos = uLightProjMatrix * uLightViewMatrix * vec4(worldPos, 1.0);
    
    // Calculate cascade index
    float depth = lightSpacePos.z / lightSpacePos.w;
    int cascadeIndex = 0;
    for (int i = 0; i < 3; i++) {
        if (depth < uCascadeSplits[i]) {
            cascadeIndex = i;
            break;
        }
    }
    
    // Transform to cascade UV coordinates
    vec2 shadowUV = lightSpacePos.xy * uCascadeScales[cascadeIndex] + uCascadeOffsets[cascadeIndex].xy;
    shadowUV = shadowUV * 0.5 + 0.5;
    
    // Sample shadow map
    float shadowDepth = texture(uShadowMap, shadowUV).r;
    
    // Apply bias and softness
    float bias = uShadowBias * (1.0 - abs(dot(normalize(worldPos), uLightDir)));
    float shadow = 1.0;
    
    if (depth - bias > shadowDepth) {
        shadow = 0.0;
    }
    
    // Apply soft shadows
    if (uShadowSoftness > 0.0) {
        float sum = 0.0;
        float samples = 9.0;
        float offset = uShadowSoftness / 1024.0;
        
        for (int x = -1; x <= 1; x++) {
            for (int y = -1; y <= 1; y++) {
                vec2 off = vec2(x, y) * offset;
                float depth = texture(uShadowMap, shadowUV + off).r;
                sum += (depth - bias > depth) ? 0.0 : 1.0;
            }
        }
        
        shadow = sum / samples;
    }
    
    return shadow;
}

// Calculate shadow amount with cascades
float ShadowAmount(vec4 shadowCoord, float shadowDepth) {
    if (uEnableShadows == 0u) {
        return 1.0;
    }
    
    // Calculate cascade index
    float depth = shadowCoord.z / shadowCoord.w;
    int cascadeIndex = 0;
    for (int i = 0; i < 3; i++) {
        if (depth < uCascadeSplits[i]) {
            cascadeIndex = i;
            break;
        }
    }
    
    // Transform to cascade UV coordinates
    vec2 shadowUV = shadowCoord.xy * uCascadeScales[cascadeIndex] + uCascadeOffsets[cascadeIndex].xy;
    shadowUV = shadowUV * 0.5 + 0.5;
    
    // Sample shadow map
    float shadowDepth = texture(uShadowMap, shadowUV).r;
    
    // Apply bias and softness
    float bias = uShadowBias * (1.0 - abs(dot(normalize(shadowCoord.xyz), uLightDir)));
    float shadow = 1.0;
    
    if (depth - bias > shadowDepth) {
        shadow = 0.0;
    }
    
    // Apply soft shadows
    if (uShadowSoftness > 0.0) {
        float sum = 0.0;
        float samples = 9.0;
        float offset = uShadowSoftness / 1024.0;
        
        for (int x = -1; x <= 1; x++) {
            for (int y = -1; y <= 1; y++) {
                vec2 off = vec2(x, y) * offset;
                float depth = texture(uShadowMap, shadowUV + off).r;
                sum += (depth - bias > depth) ? 0.0 : 1.0;
            }
        }
        
        shadow = sum / samples;
    }
    
    return shadow;
}

// Calculate shadow amount with PCF
float ShadowAmountPCF(vec4 shadowCoord, float shadowDepth) {
    if (uEnableShadows == 0u) {
        return 1.0;
    }
    
    // Calculate cascade index
    float depth = shadowCoord.z / shadowCoord.w;
    int cascadeIndex = 0;
    for (int i = 0; i < 3; i++) {
        if (depth < uCascadeSplits[i]) {
            cascadeIndex = i;
            break;
        }
    }
    
    // Transform to cascade UV coordinates
    vec2 shadowUV = shadowCoord.xy * uCascadeScales[cascadeIndex] + uCascadeOffsets[cascadeIndex].xy;
    shadowUV = shadowUV * 0.5 + 0.5;
    
    // Apply PCF
    float sum = 0.0;
    float samples = 9.0;
    float offset = 1.0 / 1024.0;
    
    for (int x = -1; x <= 1; x++) {
        for (int y = -1; y <= 1; y++) {
            vec2 off = vec2(x, y) * offset;
            float depth = texture(uShadowMap, shadowUV + off).r;
            sum += (depth - uShadowBias > depth) ? 0.0 : 1.0;
        }
    }
    
    return sum / samples;
}

// Calculate shadow amount with PCSS
float ShadowAmountPCSS(vec4 shadowCoord, float shadowDepth) {
    if (uEnableShadows == 0u) {
        return 1.0;
    }
    
    // Calculate cascade index
    float depth = shadowCoord.z / shadowCoord.w;
    int cascadeIndex = 0;
    for (int i = 0; i < 3; i++) {
        if (depth < uCascadeSplits[i]) {
            cascadeIndex = i;
            break;
        }
    }
    
    // Transform to cascade UV coordinates
    vec2 shadowUV = shadowCoord.xy * uCascadeScales[cascadeIndex] + uCascadeOffsets[cascadeIndex].xy;
    shadowUV = shadowUV * 0.5 + 0.5;
    
    // Calculate penumbra size
    float penumbra = uShadowSoftness * (1.0 - abs(dot(normalize(shadowCoord.xyz), uLightDir)));
    
    // Apply PCSS
    float sum = 0.0;
    float samples = 16.0;
    float offset = penumbra / 1024.0;
    
    for (int x = -2; x <= 2; x++) {
        for (int y = -2; y <= 2; y++) {
            vec2 off = vec2(x, y) * offset;
            float depth = texture(uShadowMap, shadowUV + off).r;
            sum += (depth - uShadowBias > depth) ? 0.0 : 1.0;
        }
    }
    
    return sum / samples;
}

// Calculate shadow amount with VSM
float ShadowAmountVSM(vec4 shadowCoord, float shadowDepth) {
    if (uEnableShadows == 0u) {
        return 1.0;
    }
    
    // Calculate cascade index
    float depth = shadowCoord.z / shadowCoord.w;
    int cascadeIndex = 0;
    for (int i = 0; i < 3; i++) {
        if (depth < uCascadeSplits[i]) {
            cascadeIndex = i;
            break;
        }
    }
    
    // Transform to cascade UV coordinates
    vec2 shadowUV = shadowCoord.xy * uCascadeScales[cascadeIndex] + uCascadeOffsets[cascadeIndex].xy;
    shadowUV = shadowUV * 0.5 + 0.5;
    
    // Sample VSM
    vec2 moments = texture(uShadowMap, shadowUV).xy;
    float mean = moments.x;
    float variance = moments.y - mean * mean;
    float delta = depth - mean;
    float p = variance / (variance + delta * delta);
    
    return p;
}

// Calculate shadow amount with ESM
float ShadowAmountESM(vec4 shadowCoord, float shadowDepth) {
    if (uEnableShadows == 0u) {
        return 1.0;
    }
    
    // Calculate cascade index
    float depth = shadowCoord.z / shadowCoord.w;
    int cascadeIndex = 0;
    for (int i = 0; i < 3; i++) {
        if (depth < uCascadeSplits[i]) {
            cascadeIndex = i;
            break;
        }
    }
    
    // Transform to cascade UV coordinates
    vec2 shadowUV = shadowCoord.xy * uCascadeScales[cascadeIndex] + uCascadeOffsets[cascadeIndex].xy;
    shadowUV = shadowUV * 0.5 + 0.5;
    
    // Sample ESM
    float moment = texture(uShadowMap, shadowUV).r;
    float p = exp(-uShadowSoftness * (depth - moment));
    
    return p;
}

// Calculate shadow amount with MSM
float ShadowAmountMSM(vec4 shadowCoord, float shadowDepth) {
    if (uEnableShadows == 0u) {
        return 1.0;
    }
    
    // Calculate cascade index
    float depth = shadowCoord.z / shadowCoord.w;
    int cascadeIndex = 0;
    for (int i = 0; i < 3; i++) {
        if (depth < uCascadeSplits[i]) {
            cascadeIndex = i;
            break;
        }
    }
    
    // Transform to cascade UV coordinates
    vec2 shadowUV = shadowCoord.xy * uCascadeScales[cascadeIndex] + uCascadeOffsets[cascadeIndex].xy;
    shadowUV = shadowUV * 0.5 + 0.5;
    
    // Sample MSM
    vec4 moments = texture(uShadowMap, shadowUV);
    float mean = moments.x;
    float variance = moments.y - mean * mean;
    float skewness = moments.z - 3.0 * mean * variance - mean * mean * mean;
    float kurtosis = moments.w - 4.0 * mean * skewness - 6.0 * mean * mean * variance - mean * mean * mean * mean;
    
    float delta = depth - mean;
    float delta2 = delta * delta;
    float delta3 = delta2 * delta;
    float delta4 = delta3 * delta;
    
    float p = variance / (variance + delta2);
    p += skewness * delta3 / (6.0 * variance * variance * variance);
    p += kurtosis * delta4 / (24.0 * variance * variance * variance * variance);
    
    return p;
} 