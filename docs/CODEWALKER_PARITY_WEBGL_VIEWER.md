# CodeWalker ↔ WebGL Viewer Parity Report

This doc is a practical checklist of what **CodeWalker can do** (or at least has code paths for) that our `webgl/webgl_viewer` **doesn’t yet match**, with concrete code anchors on both sides.

---

## Quick summary (highest-impact parity gaps)

1. **World LOD hierarchy (YMAP parent/child swaps)**
   - CodeWalker selects “visible leaves” by traversing the YMAP entity LOD tree and choosing whether to render a parent vs children based on `lodDist` and `childLodDist`.
   - Our viewer currently selects LOD **per archetype mesh** (high/med/low/vlow) but does **not** implement the GTA-style entity LOD tree swaps.

2. **Interiors / MLOs**
   - CodeWalker can render MLO child entities and entity sets (and cull them separately).
   - Our viewer currently has no interior system (no portal/room gating, no MLO entity sets).

3. **Lighting + timecycle fidelity**
   - CodeWalker has a real timecycle/weather system and many specialized shaders/passes.
   - Our viewer has a cheap sky gradient + fog and forward shading; it lacks GTA-like timecycle/weather/clouds/exposure/tonemap and light sources/probes/coronas.

4. **Shadows**
   - CodeWalker has shadow rendering utilities/shaders.
   - Our viewer doesn’t currently render shadow maps.

5. **Water system**
   - CodeWalker has a water shader and supports the `YWR` format conceptually.
   - Our viewer’s “water” is currently heuristic (building pass second pass) and not `YWR`-driven.

---

## CodeWalker anchors (where parity features live)

### Entity LOD tree (the big one)

- **LOD traversal + leaf selection**
  - `webgl/CodeWalker/CodeWalker/Rendering/Renderer.cs`
    - `RenderWorld(...)` wires `LodManager.Update(...)` and then renders `LodManager.VisibleLeaves`.
  - `webgl/CodeWalker/CodeWalker/Rendering/Renderer.cs`
    - `class RenderLodManager`
    - `Update(...)` builds/maintains a tree of `YmapEntityDef` and fills `VisibleLeaves`.
    - `GetEntityChildren(...)` decides when to recurse into children based on `ChildLodDist`.

What CodeWalker is doing in spirit:
- Start at root entities.
- If within `LodDist`, consider it visible.
- If within `ChildLodDist` and children are available, recurse; otherwise render the parent.
- The “render set” is the set of **leaf nodes** selected by that traversal.

### Interiors / MLOs

- `webgl/CodeWalker/CodeWalker/Rendering/Renderer.cs`
  - In `RenderWorld(...)`, if an entity is an MLO and `renderinteriors` is enabled, CodeWalker calls `RenderWorldAddInteriorEntities(ent)` and includes MLO entity-set instances.

### Materials/shaders (what to export to match visual parity)

- **Shader parameter name dictionary**
  - `webgl/CodeWalker/CodeWalker.Core/GameFiles/Resources/ShaderParams.cs` (`ShaderParamNames` enum)
- **Basic shader constant buffer layout and toggles**
  - `webgl/CodeWalker/CodeWalker/Rendering/Shaders/BasicShader.cs`

---

## WebGL viewer anchors (current behavior)

### LOD selection (per archetype mesh, not the entity LOD tree)

- `webgl/webgl_viewer/js/drawable_streamer.js`
  - `_chooseLod(hash, dist)` picks `high/med/low/vlow` using `manifest.meshes[hash].lodDistances`.

This is useful and should stay, but it’s **not the same** as YMAP entity LOD swaps.

### Material support (stronger than the old docs implied)

- `webgl/webgl_viewer/js/instanced_model_renderer.js`
  - The instanced renderer already supports a BasicPS-like material stack: diffuse/diffuse2, normal/spec/detail/emissive/AO, alpha behavior, tint palettes, UV selection, and per-material UV transforms.

### Exporter already mirrors CodeWalker shader-param semantics

- `webgl/export_drawables_for_chunk.py`
  - Contains a curated subset of `ShaderParamNames` hashes and exports material metadata that the viewer understands.

---

## Concrete next steps (recommended order)

### 1) Implement entity LOD tree swaps (YMAP parity)

Goal: render the same “leaf set” as CodeWalker for a given camera position.

Work needed:
- Export, per streamed entity instance, enough metadata to reconstruct the LOD tree:
  - `parentIndex` / `numChildren` relationships (or explicit parent hash/id)
  - `lodDist` and `childLodDist` (per entity)
  - `lodLevel` (to match GTA semantics like ORPHANHD gating)
- Build a traversal similar to CodeWalker’s `RenderLodManager`:
  - Traverse from roots
  - Decide to render parent vs children
  - Output “leaf entities” as the render set
- Feed the leaf set into our existing instancing pipeline (we already have good batching + materials).

Why this is high ROI:
- It dramatically reduces “wrong objects at distance” and “missing big LODs” even if meshes/materials are perfect.

### 2) Interiors/MLO support (minimal viable)

Start simple:
- Render interior entities only when the parent MLO entity is in the leaf set.
- No portal/room system initially; just correct instance availability + basic frustum culling.

### 3) Lighting parity upgrades

Incremental improvements:
- Directional shadow map (single cascade) for a big “GTA feel” bump.
- Expand sky/time-of-day into a more timecycle-like curve (even without full GTA timecycle data).
- Add emissive-driven “fake lights” (screen-space bloom later if desired).

### 4) Water driven by data (not heuristic)

Export a water surface representation (`YWR`-adjacent) and render it in a dedicated pass/shader.

---

## Notes on collision parity

Collision in this repo is currently closest via CodeWalker raycasts (see `webgl/docs/COLLISION_PARITY_CODEWALKER.md`). That is useful for “what’s below me?” but it’s not full GTA physics/collision response.


