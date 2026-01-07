# Shader Parity Plan: `webgl_viewer` ↔ `CodeWalker.Shaders`

Goal: achieve **visual parity** with CodeWalker by porting shader behavior from **HLSL** (`CodeWalker-master/CodeWalker.Shaders`) into the WebGL viewer’s **GLSL ES 3.00** pipeline.

Important constraints:
- CodeWalker shaders are **HLSL (DirectX)**. They cannot be “copied” into WebGL; they must be **ported** (and sometimes redesigned) into **GLSL** + WebGL2 render graph.
- The viewer currently uses a mix of:
  - **GLSL files**: `js/shaders/*` (currently: terrain + common includes)
  - **Inline shader strings** embedded in JS renderers (entities, sky, postfx, etc.)

This doc is a working checklist. Mark items as you implement and validate them.

---

## Phased plan (do this order)

### Phase 0 — Math, packing, and material decoding primitives (no lighting/shadows yet)
This phase is about matching CodeWalker’s *data interpretation*: channel packing, normal decode, alpha rules, tint rules.

Source of truth:
- `CodeWalker-master/CodeWalker.Shaders/Common.hlsli`
- `CodeWalker-master/CodeWalker.Shaders/BasicPS.hlsli`
- `CodeWalker-master/CodeWalker.Shaders/BasicPS.hlsl`
- `CodeWalker-master/CodeWalker.Shaders/TerrainPS*.hlsl`

Checklist:
- **[ ]** Port `Unpack4x8` / `Unpack4x8UNF` equivalents:
  - CodeWalker: `uint4 Unpack4x8(uint v)` + `float4 Unpack4x8UNF(uint v)` in `Common.hlsli`
  - Viewer: implement GLSL helpers (for packed vertex colors, packed normals, etc.)
- **[ ]** Port CodeWalker’s tangent-space normal reconstruction exactly:
  - CodeWalker: `float3 NormalMap(float2 nmv, float bumpinezz, float3 norm, float3 tang, float3 bita)` in `Common.hlsli`
  - Viewer: use the same math (xy in [0..1] → [-1..1], bumpiness clamp to 0.001, z = sqrt(1 - dot(xy,xy)))
- **[ ]** Establish texture color pipeline conventions (sRGB vs linear):
  - Decide per-texture type: albedo in sRGB, normals/spec/masks in linear
  - Ensure WebGL2 upload + shader decode matches CodeWalker expectations
- **[ ]** Implement CodeWalker’s alpha/discard rules used by Basic materials:
  - In `BasicPS.hlsl`: discard thresholds differ for decals vs non-decals (`c.a <= 0.33` vs `<= 0.0`)
  - Ensure `IsDecal` modes are mirrored (including the `IsDecal == 2` alpha-mask mode)
- **[ ]** Implement CodeWalker’s tint palette lookup (weapons tint path):
  - In `BasicPS.hlsl`: `tx = (round(c.a*255.009995) - 32) * 0.007813`
  - Mirror the palette sampling convention and Y-row choice used by the viewer
- **[ ]** Implement CodeWalker’s “detail normal” combine behavior for Basic materials:
  - In `BasicPS.hlsl`: detail normals sampled twice, combined, scaled by `detailSettings`, then applied using `Specmap.w` as the blend weight into the bumpmap XY
- **[ ]** Add “RenderMode” style debug outputs early (critical for parity validation):
  - normals/tangents/colors/texcoords/diffuse/normalmap/spec/direct-like views

### Phase 1 — Terrain + Objects (G-buffer outputs, still no real lighting/shadows)
This phase makes terrain + drawable materials “look right” in terms of base color/normal/spec outputs, without needing full lighting parity.

Checklist:
- **[ ]** Terrain: finish parity of blend + normal decode + output packing (match `TerrainPS.hlsl` / `TerrainPS_Deferred.hlsl`)
- **[ ]** Objects: port Basic material family into viewer (most world geometry):
  - Create GLSL equivalents of `BasicVS*.hlsl` variants needed by your vertex formats
  - Create GLSL equivalent of `BasicPS_Deferred.hlsl` to output a CodeWalker-like G-buffer layout
- **[ ]** Match output packing conventions:
  - CodeWalker writes `Normal = float4(saturate(norm*0.5+0.5), alpha)` in multiple shaders (terrain/trees/water)
  - Mirror the same packing in viewer buffers
- **[ ]** Match “second diffuse” blend behavior:
  - `BasicPS.hlsl`: `c = c2.a*c2 + (1-c2.a)*c` (diffuse2 alpha composite)

### Phase 2 — Lighting (directional + local), then shadows
Only after Phases 0–1 are stable should we chase parity in lighting/shadows. Otherwise you can’t tell if a mismatch is “materials” or “lighting”.

### Phase 3 — Post-processing, sky, water, vegetation, and misc/debug
Finish the remaining visible parity work once core materials are correct.

---

## Current state in `webgl_viewer`

### Shader sources present as files
- `webgl_viewer/js/shaders/terrain.vert` (**exists**)
- `webgl_viewer/js/shaders/terrain.frag` (**exists**)
- `webgl_viewer/js/shaders/common.glsl` (**exists**, shared functions)
- `webgl_viewer/js/shaders/shadowmap.glsl` (**exists**, shared shadow helpers + `ShadowmapVars` UBO)

### Renderers with inline shaders (entry points)
These are where most future shader ports will land (or be refactored to external GLSL files):
- `webgl_viewer/js/entity_renderer.js`
- `webgl_viewer/js/building_renderer.js`
- `webgl_viewer/js/instanced_model_renderer.js`
- `webgl_viewer/js/ped_renderer.js`
- `webgl_viewer/js/sky_renderer.js`
- `webgl_viewer/js/postfx_renderer.js`
- `webgl_viewer/js/occlusion.js`
- `webgl_viewer/js/simple_mesh_renderer.js`
- `webgl_viewer/js/geojson_line_renderer.js`
- `webgl_viewer/js/external_dataset_renderer.js`

---

## Parity checklist: `CodeWalker.Shaders/*`

Legend:
- **[ ]** not started
- **[~]** partially implemented / approximate
- **[x]** implemented + validated against CodeWalker

### 1) Common / includes (foundation)
These are the “Phase 0” blockers: without these, terrain/objects won’t match even with perfect lighting.

- **[ ]** `Common.hlsli` → GLSL equivalents in `js/shaders/common.glsl`
  - **[ ]** `Unpack4x8`, `Unpack4x8UNF` (color/packing)
  - **[ ]** `NormalMap(nmv.xy, bumpiness, N, T, B)` (normal reconstruction)
  - **[ ]** (Optional later) CodeWalker lighting helpers once we enter Phase 2
- **[ ]** `Quaternion.hlsli` → GLSL quaternion utilities (some exist already)
- **[~]** `Shadowmap.hlsli` → `js/shaders/shadowmap.glsl` (**Phase 2**, keep minimal until then)
- **[ ]** Texture/sampler conventions (sRGB vs linear, channel meanings, mask conventions)

### 2) Terrain family (Phase 1)
CodeWalker sources:
- `TerrainVS.hlsli`
- `TerrainVS_PNCCT*.hlsl`, `TerrainVS_PNCT*.hlsl` (variants for vertex formats)
- `TerrainPS.hlsli`
- `TerrainPS.hlsl`
- `TerrainPS_Deferred.hlsl`

Viewer target:
- `webgl_viewer/js/shaders/terrain.vert`
- `webgl_viewer/js/shaders/terrain.frag`
- `webgl_viewer/js/terrain_renderer.js`

Status:
- **[~]** Terrain blending parity: CodeWalker-style `vc0/vc1/mask` blending is implemented in GLSL, but validation is pending.
- **[~]** Terrain normal mapping parity: layer normals are now bound; verify tangent basis + bumpiness matches CodeWalker.
- **[ ]** Terrain material params parity: spec/rough/ao/irradiance outputs (match CodeWalker’s G-buffer conventions).
- **[ ]** Terrain deferred parity: match CodeWalker’s G-buffer layout first (**Phase 1**), then lighting/shadows later (**Phase 2**).

### 3) Basic material family (most world geometry) (Phase 1)
CodeWalker sources:
- `BasicVS*.hlsl` (many vertex format variants)
- `BasicVS.hlsli`
- `BasicPS.hlsl`
- `BasicPS_Deferred.hlsl`
- `BasicPS.hlsli`

Viewer target (likely):
- `webgl_viewer/js/entity_renderer.js` (non-instanced)
- `webgl_viewer/js/instanced_model_renderer.js` (instanced)
- `webgl_viewer/js/building_renderer.js`
- plus shared GLSL include(s)

Checklist:
- **[ ]** Create a **deferred** geometry/material pass for drawables (G-buffer outputs, no real lighting yet)
- **[ ]** Port Basic material *decode* features (Phase 0/1 critical):
  - **[ ]** diffuse2 alpha composite (`c2.a*c2 + (1-c2.a)*c`)
  - **[ ]** alpha/discard rules (decal vs non-decal vs decal==2 alpha-mask mode)
  - **[ ]** tint palette weapon path (the `round(c.a*255.009995)` indexing trick)
  - **[ ]** normal mapping + detail normal behavior (detail mixed using `Specmap.w`)
  - **[ ]** spec map channel meaning (`Specmap`, `specMapIntMask`, squaring behavior)
- **[ ]** Implement the minimal **BasicVS** variants needed for your actual vertex layouts first; expand later

### 4) Lighting passes (Phase 2)
CodeWalker sources:
- `DirLightVS.hlsl`, `DirLightPS.hlsl`, `DirLightPS_MS.hlsl`
- `LightVS.hlsl`, `LightPS.hlsl`, `LightPS_MS.hlsl`, `LightPS.hlsli`
- `DistantLightsVS.hlsl`, `DistantLightsPS.hlsl`
- `LodLightsVS.hlsl`, `LodLightsPS.hlsl`, `LodLightsPS_MS.hlsl`

Viewer target (likely new):
- `webgl_viewer/js/lighting_renderer.js` (new) or extend `postfx_renderer.js` / main render loop

Checklist:
- **[ ]** G-buffer resolve/composite pass structure (directional + point/spot)
- **[ ]** MSAA resolve strategy (CodeWalker has *_MS variants)
- **[ ]** Distant lights / LOD lights (night lighting parity)

### 5) Shadows (Phase 2)
CodeWalker sources:
- `ShadowVS.hlsl`
- `ShadowVS_Skin.hlsl`
- `ShadowPS.hlsl`
- `Shadowmap.hlsli`

Viewer target:
- `webgl_viewer/js/terrain_renderer.js` (already has a shadow depth texture path, but limited)
- likely a unified `shadow_renderer.js` to render both terrain + entities into shadow maps

Checklist:
- **[ ]** Shadow map generation for drawables (not just terrain)
- **[ ]** CSM/cascades (if CodeWalker uses them in the path you care about)
- **[ ]** PCF / filtering parity and bias tuning

### 6) Water (Phase 3)
CodeWalker sources:
- `WaterVS*.hlsl` (multiple vertex format variants)
- `WaterVS.hlsli`
- `WaterPS.hlsl`
- `WaterPS_Deferred.hlsl`
- `WaterPS.hlsli`

Viewer target (likely new):
- `webgl_viewer/js/water_renderer.js` (new)

Checklist:
- **[ ]** Identify how water geometry is sourced in viewer (YMAP water quads? heightfield? meshes?)
- **[ ]** Port water shading: normals, Fresnel, reflections/refractions, foam, depth-based color

### 7) Sky / atmosphere / clouds (Phase 3)
CodeWalker sources:
- `SkydomeVS.hlsl`, `SkydomePS.hlsl`, `Skydome.hlsli`
- `CloudsVS.hlsl`, `CloudsPS.hlsl`, `Clouds.hlsli`
- `SkySunVS.hlsl`, `SkySunPS.hlsl`
- `SkyMoonVS.hlsl`, `SkyMoonPS.hlsl`

Viewer target:
- `webgl_viewer/js/sky_renderer.js`

Checklist:
- **[ ]** Port skydome gradients + sun/moon discs
- **[ ]** Clouds parity (if desired; can be staged later)
- **[ ]** Match CodeWalker tonemap/exposure expectations

### 8) Vegetation / trees LOD (Phase 3)
CodeWalker sources:
- `TreesLodVS.hlsl`
- `TreesLodPS.hlsl`
- `TreesLodPS_Deferred.hlsl`
- `TreesLodPS.hlsli`

Viewer target (likely):
- `webgl_viewer/js/entity_renderer.js` or a dedicated vegetation path if performance requires

Checklist:
- **[ ]** Alpha-tested foliage, billboards, wind animation (if present in CodeWalker)
- **[ ]** LOD fade / dithering parity

### 9) Post-processing (Phase 3)
CodeWalker sources:
- `PPFinalPassVS.hlsl`, `PPFinalPassPS.hlsl`
- `PPCopyPixelsPS.hlsl`
- `PPSSAAPS.hlsl`
- `PPBloomFilterVCS.hlsl`, `PPBloomFilterBPHCS.hlsl`
- `PPReduceTo0DCS.hlsl`, `PPReduceTo1DCS.hlsl`
- `PPLumBlendCS.hlsl`

Viewer target:
- `webgl_viewer/js/postfx_renderer.js`

Checklist:
- **[ ]** Tonemap curve / exposure model parity
- **[ ]** Bloom parity
- **[ ]** SSA A / TAA-like parity (if desired; may be expensive in WebGL)
- **[ ]** Luminance reduce/adaptation (compute shaders in HLSL → emulate via fullscreen passes in WebGL2)

### 10) UI / debug / misc (Phase 3)
CodeWalker sources:
- `WidgetVS.hlsl`, `WidgetPS.hlsl`
- `MarkerVS.hlsl`, `MarkerPS.hlsl`
- `PathVS.hlsl`, `PathPS.hlsl`
- `PathDynVS.hlsl`
- `PathBoxVS.hlsl`, `PathBoxPS.hlsl`
- `BoundingSphereVS.hlsl`, `BoundingBoxVS.hlsl`, `BoundsPS.hlsl`

Viewer target:
- likely `simple_mesh_renderer.js`, `geojson_line_renderer.js`, plus any debug overlays

Checklist:
- **[ ]** Debug primitives parity (bounds, markers)
- **[ ]** Path rendering parity (if used)

---

## Recommended implementation order (to reach visible parity fastest)

1. **Phase 0**: math + packing + material decode primitives (`Common.hlsli`, `BasicPS*.hlsl`)
2. **Phase 1**: **Terrain + Basic objects**: correct G-buffer outputs (base color/normal/spec), alpha/tint/detail behavior
3. **Phase 2**: lighting passes, then shadows
4. **Phase 3**: post, sky, water, vegetation, debug

---

## Notes / how to use this doc

- Each “family” above should produce:
  - GLSL shader sources (prefer `webgl_viewer/js/shaders/*.vert|*.frag|*.glsl`)
  - A JS renderer module that binds uniforms/textures consistently
  - A small set of known “golden scenes” for parity checks (screenshots/videos)


