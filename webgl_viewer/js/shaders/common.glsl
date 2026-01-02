// Common functions and structures for all shaders

// Quaternion multiplication
vec4 quatMul(vec4 q1, vec4 q2) {
    return vec4(
        q1.w * q2.x + q1.x * q2.w + q1.y * q2.z - q1.z * q2.y,
        q1.w * q2.y - q1.x * q2.z + q1.y * q2.w + q1.z * q2.x,
        q1.w * q2.z + q1.x * q2.y - q1.y * q2.x + q1.z * q2.w,
        q1.w * q2.w - q1.x * q2.x - q1.y * q2.y - q1.z * q2.z
    );
}

// Vector rotation by quaternion
vec3 mulvq(vec3 v, vec4 q) {
    vec4 qv = vec4(v, 0.0);
    vec4 qInv = vec4(-q.xyz, q.w);
    vec4 result = quatMul(quatMul(q, qv), qInv);
    return result.xyz;
}

// Unpack color from uint
vec4 UnpackColor(uint color) {
    return vec4(
        float((color >> 24) & 0xFFu) / 255.0,
        float((color >> 16) & 0xFFu) / 255.0,
        float((color >> 8) & 0xFFu) / 255.0,
        float(color & 0xFFu) / 255.0
    );
}

// Pack color to uint
uint PackColor(vec4 color) {
    return (uint(color.r * 255.0) << 24) |
           (uint(color.g * 255.0) << 16) |
           (uint(color.b * 255.0) << 8) |
           uint(color.a * 255.0);
}

// Depth calculation
float CalculateDepth(vec3 pos) {
    // TODO: Implement proper depth calculation based on camera parameters
    return length(pos);
}

// View direction calculation
vec3 CalculateViewDir(vec3 pos) {
    return normalize(-pos);
}

// Light direction calculation
vec3 CalculateLightDir(vec3 lightDir) {
    return normalize(lightDir);
}

// Fresnel effect calculation
float CalculateFresnel(vec3 viewDir, vec3 normal, float power) {
    return pow(1.0 - max(dot(viewDir, normal), 0.0), power);
}

// Specular highlight calculation
float CalculateSpecular(vec3 normal, vec3 lightDir, vec3 viewDir, float power) {
    vec3 halfDir = normalize(lightDir + viewDir);
    return pow(max(dot(normal, halfDir), 0.0), power);
}

// Ambient occlusion calculation
float CalculateAO(vec3 normal, vec3 pos) {
    // TODO: Implement proper AO calculation
    return 1.0;
}

// Normal mapping
vec3 NormalMap(vec3 normal, vec3 tangent, vec3 bitangent, vec4 normalMap) {
    vec3 normalTS = normalMap.xyz * 2.0 - 1.0;
    normalTS.z *= normalMap.w;
    return normalize(
        normal * normalTS.z +
        tangent * normalTS.x +
        bitangent * normalTS.y
    );
}

// Parallax mapping
vec2 CalculateParallax(vec2 texCoord, vec3 viewDir, vec3 normal, float height, float scale) {
    float heightScale = height * scale;
    vec2 offset = viewDir.xy * heightScale;
    return texCoord - offset;
}

// Shadow mapping placeholder
float CalculateShadow(vec3 pos, vec4 lightSpacePos) {
    // TODO: Implement proper shadow mapping
    return 1.0;
}

// Terrain blending
vec4 CalculateTerrainBlend(vec4 base, vec4 blend, float mask) {
    return mix(base, blend, mask);
}

// Water blending
vec4 CalculateWaterBlend(vec4 base, vec4 water, float depth) {
    return mix(base, water, depth);
}

// Fog calculation
vec4 CalculateFog(vec3 pos, vec3 fogColor, float fogStart, float fogEnd, float fogDensity) {
    float dist = length(pos);
    float fogFactor = clamp((dist - fogStart) / (fogEnd - fogStart), 0.0, 1.0);
    return vec4(fogColor, fogFactor);
}

// Color blending functions
vec4 BlendColors(vec4 base, vec4 blend, float alpha) {
    return mix(base, blend, alpha);
}

// Normal blending
vec3 BlendNormals(vec3 base, vec3 blend, float alpha) {
    return normalize(mix(base, blend, alpha));
}

// Specular blending
float BlendSpecular(float base, float blend, float alpha) {
    return mix(base, blend, alpha);
}

// Roughness blending
float BlendRoughness(float base, float blend, float alpha) {
    return mix(base, blend, alpha);
}

// Metallic blending
float BlendMetallic(float base, float blend, float alpha) {
    return mix(base, blend, alpha);
}

// Emissive blending
vec3 BlendEmissive(vec3 base, vec3 blend, float alpha) {
    return mix(base, blend, alpha);
}

// Alpha blending
float BlendAlpha(float base, float blend, float alpha) {
    return mix(base, blend, alpha);
}

// Height blending
float BlendHeight(float base, float blend, float alpha) {
    return mix(base, blend, alpha);
}

// Displacement blending
float BlendDisplacement(float base, float blend, float alpha) {
    return mix(base, blend, alpha);
}

// Occlusion blending
float BlendOcclusion(float base, float blend, float alpha) {
    return mix(base, blend, alpha);
}

// Detail blending
vec4 BlendDetail(vec4 base, vec4 blend, float alpha) {
    return mix(base, blend, alpha);
}

// Layer blending
vec4 BlendLayer(vec4 base, vec4 blend, float alpha) {
    return mix(base, blend, alpha);
}

// Mask blending
float BlendMask(float base, float blend, float alpha) {
    return mix(base, blend, alpha);
}

// Tint blending
vec4 BlendTint(vec4 base, vec4 tint, float alpha) {
    return mix(base, tint, alpha);
}

// Vertex color blending
vec4 BlendVertexColor(vec4 base, vec4 color, float alpha) {
    return mix(base, color, alpha);
}

// Texture coordinate blending
vec2 BlendTexCoord(vec2 base, vec2 blend, float alpha) {
    return mix(base, blend, alpha);
}

// Position blending
vec3 BlendPosition(vec3 base, vec3 blend, float alpha) {
    return mix(base, blend, alpha);
}

// Normal space transformation
vec3 TransformNormal(vec3 normal, mat3 transform) {
    return normalize(transform * normal);
}

// Tangent space transformation
vec3 TransformTangent(vec3 tangent, mat3 transform) {
    return normalize(transform * tangent);
}

// Bitangent space transformation
vec3 TransformBitangent(vec3 bitangent, mat3 transform) {
    return normalize(transform * bitangent);
}

// World space transformation
vec3 TransformWorld(vec3 pos, mat4 transform) {
    return (transform * vec4(pos, 1.0)).xyz;
}

// View space transformation
vec3 TransformView(vec3 pos, mat4 transform) {
    return (transform * vec4(pos, 1.0)).xyz;
}

// Projection space transformation
vec3 TransformProjection(vec3 pos, mat4 transform) {
    return (transform * vec4(pos, 1.0)).xyz;
}

// Screen space transformation
vec2 TransformScreen(vec3 pos, mat4 transform) {
    vec4 clipPos = transform * vec4(pos, 1.0);
    return clipPos.xy / clipPos.w;
}

// UV space transformation
vec2 TransformUV(vec2 uv, mat3 transform) {
    return (transform * vec3(uv, 1.0)).xy;
}

// Color space transformation
vec3 TransformColor(vec3 color, mat3 transform) {
    return transform * color;
}

// Light space transformation
vec3 TransformLight(vec3 pos, mat4 transform) {
    return (transform * vec4(pos, 1.0)).xyz;
}

// Shadow space transformation
vec3 TransformShadow(vec3 pos, mat4 transform) {
    return (transform * vec4(pos, 1.0)).xyz;
}

// Tangent space to world space transformation
mat3 TangentToWorld(vec3 normal, vec3 tangent, vec3 bitangent) {
    return mat3(tangent, bitangent, normal);
}

// World space to tangent space transformation
mat3 WorldToTangent(vec3 normal, vec3 tangent, vec3 bitangent) {
    return transpose(mat3(tangent, bitangent, normal));
}

// Tangent space to view space transformation
mat3 TangentToView(vec3 normal, vec3 tangent, vec3 bitangent, mat3 viewMatrix) {
    return viewMatrix * TangentToWorld(normal, tangent, bitangent);
}

// View space to tangent space transformation
mat3 ViewToTangent(vec3 normal, vec3 tangent, vec3 bitangent, mat3 viewMatrix) {
    return transpose(TangentToView(normal, tangent, bitangent, viewMatrix));
}

// Tangent space to light space transformation
mat3 TangentToLight(vec3 normal, vec3 tangent, vec3 bitangent, mat4 lightMatrix) {
    return mat3(lightMatrix) * TangentToWorld(normal, tangent, bitangent);
}

// Light space to tangent space transformation
mat3 LightToTangent(vec3 normal, vec3 tangent, vec3 bitangent, mat4 lightMatrix) {
    return transpose(TangentToLight(normal, tangent, bitangent, lightMatrix));
}

// Tangent space to shadow space transformation
mat3 TangentToShadow(vec3 normal, vec3 tangent, vec3 bitangent, mat4 shadowMatrix) {
    return mat3(shadowMatrix) * TangentToWorld(normal, tangent, bitangent);
}

// Shadow space to tangent space transformation
mat3 ShadowToTangent(vec3 normal, vec3 tangent, vec3 bitangent, mat4 shadowMatrix) {
    return transpose(TangentToShadow(normal, tangent, bitangent, shadowMatrix));
} 