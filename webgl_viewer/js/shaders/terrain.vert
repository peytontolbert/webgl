#version 300 es

// Common includes
#include "common.glsl"
#include "shadowmap.glsl"

// Scene uniforms (b0)
layout(std140) uniform SceneVars {
    mat4 uViewProjectionMatrix;
    mat4 uModelMatrix;
    mat3 uNormalMatrix;
    vec3 uTerrainBounds;  // (min_x, min_y, min_z)
    vec3 uTerrainSize;    // (width, height, max_height)
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

// Vertex attributes
in vec3 aPosition;
in vec3 aNormal;
in vec2 aTexcoord;
in vec2 aTexcoord1;
in vec2 aTexcoord2;
in vec4 aColor0;
in vec4 aColor1;
in vec4 aTint;

// Outputs
out vec3 vPosition;
out vec3 vNormal;
out vec4 vColor0;
out vec4 vColor1;
out vec4 vTint;
out vec2 vTexcoord0;
out vec2 vTexcoord1;
out vec2 vTexcoord2;
out vec4 vShadows;
out vec4 vLightShadow;
out vec4 vTangent;
out vec4 vBitangent;
out vec3 vCamRelPos;

// Textures
uniform sampler2D uHeightmap;
uniform sampler2D uTintPalette;
uniform bool uHasHeightmap;

void main() {
    // Convert position to world coordinates
    vec3 worldPos;
    if (uHasHeightmap) {
        // Calculate grid position (aPosition.xy is in [0, 1] range)
        vec2 gridPos = aPosition.xy;
        
        // Calculate world position using GTA5's coordinate system
        worldPos.x = uTerrainBounds.x + (gridPos.x / (uTerrainSize.x - 1.0)) * (uTerrainBounds.x + uTerrainSize.x);
        worldPos.y = uTerrainBounds.y + (gridPos.y / (uTerrainSize.y - 1.0)) * (uTerrainBounds.y + uTerrainSize.y);
        
        // Sample height from heightmap
        vec2 heightmapCoord = vec2(gridPos.x, 1.0 - gridPos.y);
        float height = texture(uHeightmap, heightmapCoord).r;
        
        // Scale height to match the terrain bounds
        float heightScale = uTerrainSize.z / 255.0;
        worldPos.z = uTerrainBounds.z + height * heightScale;
    } else {
        worldPos = aPosition;
    }
    
    // Transform position
    vec3 tpos = (uHasTransforms == 1u) ? (uTransform * vec4(worldPos, 1.0)).xyz : worldPos;
    vec3 spos = tpos * uScale;
    vec3 bpos = mulvq(spos, uOrientation);
    vec3 finalPos = uCamRel.xyz + bpos;
    
    // Transform for rendering
    gl_Position = uViewProjectionMatrix * vec4(finalPos, 1.0);
    
    // Transform normal
    vec3 tnorm = (uHasTransforms == 1u) ? (uTransform * vec4(aNormal, 0.0)).xyz : aNormal;
    vec3 bnorm = normalize(mulvq(tnorm, uOrientation));
    
    // Calculate camera-relative position
    vCamRelPos = finalPos;
    
    // Pass data to fragment shader
    vPosition = finalPos;
    vNormal = bnorm;
    vColor0 = aColor0;
    vColor1 = aColor1;
    vTint = aTint;
    vTexcoord0 = aTexcoord;
    vTexcoord1 = aTexcoord1;
    vTexcoord2 = aTexcoord2;
    
    // Calculate shadows
    vec4 lspos;
    float sceneDepth = ShadowmapSceneDepth(vCamRelPos, lspos);
    vShadows = vec4(sceneDepth, 0.0, 0.0, 1.0);
    vLightShadow = lspos;
    
    // Calculate tangent space
    vec3 up = vec3(0.0, 1.0, 0.0);
    vec3 right = normalize(cross(up, bnorm));
    up = normalize(cross(bnorm, right));
    
    vTangent = vec4(right, 1.0);
    vBitangent = vec4(up, 1.0);
} 