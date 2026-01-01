# WebGL Viewer Coverage Report (what’s covered vs missing)

This report summarizes what `webgl/webgl_viewer` **already implements**, what is **partially implemented**, and what is **missing** relative to a “GTA-like client” experience.

Key idea: the viewer is already a solid **streaming map viewer**. What’s missing is mostly **engine fidelity** (materials/lighting/LOD/occlusion/interiors/collision), not the basic streaming skeleton.

---

## Coverage matrix (high-level)

Legend:
- **Covered**: implemented and used by default
- **Partial**: exists but simplified / not fully GTA-like / not wired everywhere
- **Missing**: not implemented (or only reference code exists)

### World data + streaming

- **Covered**: Chunked world placement streaming (grid chunks)
  - `assets/entities_index.json` + nearby chunk loads
  - `EntityStreamer` supports **ENT0** binary chunks (positions) with JSONL fallback
  - `DrawableStreamer` supports **ENT1** binary chunks (archetype+transform) with JSONL fallback

- **Partial**: GTA-style streaming bounds + flags + dependency catalogs
  - Current chunk selection is “grid radius + optional frustum check”
  - GTA has explicit streaming extents, flags, and dependency manifests that keep sets consistent

- **Partial**: LOD selection
  - Viewer chooses per-archetype LOD using exported `lodDistances` when present
  - Missing the broader GTA LOD system: parent/child LOD links, HD↔LOD entity swaps, per-entity LOD overrides

- **Missing**: Occlusion/portal systems
  - No occlusion meshes, no portal/room culling, no interior visibility gating

### Asset metadata + formats

- **Covered**: Sharded models manifest (fast startup)
  - `ModelManager` loads `assets/models/manifest_index.json` + `manifest_shards/*.json` on-demand
  - Monolithic `manifest.json` still supported; parse can run in a Worker

- **Covered**: Mesh streaming format (custom `MSH0` bins)
  - `ModelManager._parseAndUploadMesh(...)` supports mesh bin versions (pos/nrm/uv flags)

- **Partial**: Texture pipeline
  - `TextureStreamer` provides GPU memory caps + LRU eviction + quality downscale modes
  - Only a **single optional diffuse** texture is used in instanced model shading today
  - No normal/spec/roughness/metalness/tint palettes/multi-layer materials like GTA

### Rendering (what you see)

- **Covered**: Terrain rendering from heightmap + 4-layer splat blending
  - `TerrainRenderer` reconstructs height + normals from `assets/heightmap.png`
  - Uses blend mask + 4 tiled layers (heuristic but “GTA-like enough” visually for terrain)

- **Partial**: Buildings rendering
  - `BuildingRenderer` loads a combined `assets/buildings.obj` and does basic Lambert shading
  - Water is a heuristic second pass (“vertices near data-space z=0”)
  - No materials, no per-building metadata usage, no real water shader

- **Covered (basic)**: Instanced drawable rendering
  - `InstancedModelRenderer` draws per-archetype instances using per-instance matrices (GPU instancing)
  - Uses normals if exported, and optional diffuse textures

- **Partial**: Culling
  - Chunk-level frustum culling is implemented (AABB vs frustum planes)
  - No per-instance frustum culling; no occlusion culling

- **Missing**: Shadows
  - Reference GLSL exists in `js/shaders/*`, but it’s **not wired** into the runtime pipeline

- **Missing**: Atmosphere / fog / timecycle
  - No sky/atmospheric scattering, no fog, no time-of-day grading, no weather

- **Missing**: Post-processing / deferred pipeline
  - Viewer is forward-shaded; MRT/deferred path is not implemented (reference shaders exist)

### “Game” systems

- **Partial (debug/minimal)**: Ped
  - `PedRenderer` draws the ped as a point marker; can be followed/controlled
  - No animation, no collision, no navmesh, no IK

- **Missing**: Vehicles/traffic

- **Missing**: Collision + physics
  - Collision assets are not streamed/rendered for gameplay physics

- **Missing**: Interiors / MLOs

- **Missing**: Lights (streetlights, emissives, light probes)

### Performance + UX

- **Covered**: Fast first frame strategy
  - Boot blocks only on essentials, starts rendering, then warms streaming in background

- **Covered**: Fetch de-dupe + concurrency limiting + priority lanes
  - `asset_fetcher.js` provides in-flight de-dupe and high/low priority scheduling

- **Partial**: Off-thread work
  - Manifest parsing can run in `manifest_worker.js`
  - Chunk JSONL parsing and instance matrix building still happens on the main thread (binary formats reduce pain, but it’s still a limitation)

- **Covered**: Debuggability of “missing world”
  - Sharded-meta “unknown” vs true “unexported” is tracked
  - Optional placeholder meshes help diagnose exporter coverage gaps

---

## What’s “covered” today (practical summary)

If your goal is “I can move around a streamed GTA-scale map in browser and see lots of real props”:
- **Covered**: streaming bubble, chunk formats (ENT0/ENT1), sharded manifest, instanced meshes, diffuse textures, bounded texture cache, basic terrain and building context.

---

## What’s “missed” today (what still needs coverage)

If your goal is “feel like a GTA client”, the major missing buckets are:

- **Material system fidelity**
  - multiple textures per material, normal maps, vertex colors/tints, shader variants
  - correct UV sets and sampler transforms per shader

- **Lighting fidelity**
  - shadows (at least one directional shadow map)
  - fog/atmosphere, time-of-day grading (“timecycle” feel)
  - emissive lights / streetlight sources

- **LOD + occlusion**
  - real LOD hierarchy (entity swaps, parent/child links)
  - occlusion meshes / interior gating

- **World systems**
  - interiors/MLOs, collision/physics, navmesh-driven movement, vehicles/traffic

- **Perf scaling**
  - push JSONL chunk parsing + matrix build to Web Workers (or rely on binary only)
  - per-instance culling (CPU or GPU) for very dense archetypes

---

## How to measure “coverage” in practice (numbers)

There are two different notions of coverage:

- **System coverage** (features implemented): use the matrix above.
- **Asset coverage** (how much of the GTA world you exported): the runtime exposes stats:
  - `DrawableStreamer.getCoverageStats()` aggregates:
    - `unexportedEntities / unexportedArchetypes` (known missing exports; placeholders can visualize)
    - `unknownMetaEntities / unknownMetaArchetypes` (shards not loaded yet)
    - `droppedInstances / droppedArchetypes` (capped by current streaming limits)

---

## Prioritized backlog (highest ROI next steps)

1. **Wire up a simple shadow pass** (single directional shadow map, no cascades initially).
2. **Add fog + sky gradient** (cheap depth-based fog makes the world feel much more “real”).
3. **Export and use richer material metadata**
   - at minimum: diffuse + normal map + vertex color/tint flag + UV transforms.
4. **Move heavy chunk work off-thread**
   - Worker for JSONL parsing and/or ENT1 matrix build (and transfer `Float32Array` back).
5. **Improve LOD logic**
   - ensure all archetypes have usable `lodDistances`
   - add a simple “keep lowest LOD beyond distance” rule everywhere (avoid popping back to high)
6. **Per-instance culling for very dense archetypes**
   - start CPU-side coarse culling (per-chunk/per-archetype AABBs), then consider GPU culling later.


