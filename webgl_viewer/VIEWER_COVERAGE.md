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

- **Partial**: Occlusion/portal systems
  - Basic occlusion culling exists via a depth prepass for streamed instances
  - Missing GTA-style occlusion meshes, portal/room culling, and interior visibility gating

### Asset metadata + formats

- **Covered**: Sharded models manifest (fast startup)
  - `ModelManager` loads `assets/models/manifest_index.json` + `manifest_shards/*.json` on-demand
  - Monolithic `manifest.json` still supported; parse can run in a Worker

- **Covered**: Mesh streaming format (custom `MSH0` bins)
  - `ModelManager._parseAndUploadMesh(...)` supports mesh bin versions (pos/nrm/uv flags)

- **Partial**: Texture pipeline
  - `TextureStreamer` provides GPU memory caps + LRU eviction + quality downscale modes
  - Instanced model shading supports **diffuse/diffuse2, normal, spec, detail, emissive, AO, alpha-mask**, UV-set selection, per-material UV0 scale/offset, and optional tint palettes (when exported in the manifest)
  - Still missing full GTA material/shader parity: reflection probes/cubemaps, many shader families/variants, and timecycle-driven lighting integration

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
  - Uses exported normals/tangents/vertex colors/UV sets and binds multi-texture materials when present in the manifest

- **Partial**: Culling
  - Chunk-level frustum culling is implemented (AABB vs frustum planes)
  - No per-instance frustum culling; no occlusion culling

- **Partial**: Shadows
  - Terrain deferred path now renders a **single directional shadow map** (WebGL2) and applies it in `js/shaders/terrain.*` via `js/shaders/shadowmap.glsl`
  - Instanced drawables/buildings do **not** yet cast/receive shadows (still a parity gap)

- **Partial**: Atmosphere / fog / timecycle
  - Sky gradient pass + depth fog are implemented, with a simple time-of-day driven sun direction
  - Missing GTA-like timecycle/weather/clouds/volumetrics and proper exposure/tonemapping

- **Partial**: Post-processing / deferred pipeline
  - Terrain has an experimental **MRT G-buffer + composite** path (WebGL2) in `TerrainRenderer`
  - The rest of the viewer is still predominantly forward-shaded (no full-scene deferred lighting yet)

### “Game” systems

- **Partial (debug/minimal)**: Ped
  - `PedRenderer` draws the ped as a point marker; can be followed/controlled
  - No animation, no collision, no navmesh, no IK

- **Missing**: Vehicles/traffic

- **Missing**: Collision + physics
  - Collision assets are not streamed/rendered for gameplay physics

- **Missing**: Interiors / MLOs

- **Missing**: Lights (streetlights, emissives, light probes)
  - Note: emissive textures render, but there are no real light sources/probes/coronas yet

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

### Practical “production checks” (scripts)

Use these when your goal is **GTA-like rendering completeness** (not “debug visuals”):

- **Entity/YMAP chunk integrity** (catches missing chunk files / bad counts):
  - `python3 webgl-gta/verify_entities_index.py --assets-dir webgl-gta/webgl_viewer/assets`

- **Missing meshes (map placements that don’t resolve to exported drawables)**:
  - `python3 webgl-gta/report_missing_meshes.py --assets-dir webgl-gta/webgl_viewer/assets --top 50`

- **Missing model textures (stop 404s / placeholders from missing YTD exports)**:
  - `python3 webgl-gta/webgl_viewer/tools/repair_missing_model_textures.py --gta-path /data/webglgta/gta5 --assets-dir webgl-gta/webgl_viewer/assets --selected-dlc all`

- **One-shot world coverage summary (sampled)**:
  - `python3 webgl-gta/report_world_coverage.py --assets-dir webgl-gta/webgl_viewer/assets`
  - Add `--chunk-limit 0 --max-entities 0` for a full scan (can be slow).

### Interiors parity (what matters most vs CodeWalker)

CodeWalker’s renderer treats interiors (MLOs) as a special case:

- **MLO instances are “container entities”**: when an entity is an MLO (`ent.IsMlo`), CodeWalker adds its
  children from `ent.MloInstance.Entities` *and also* `ent.MloInstance.EntitySets` (but only when a set is
  `VisibleOrForced`).
- **Entity-set gating**: CodeWalker uses `VisibleOrForced` (visible flag OR `ForceVisible`) on each entity set.
- **Proxy filtering**: CodeWalker filters out reflection/shadow proxy entities unless `renderproxies` is enabled.

In the WebGL viewer we currently approximate interiors in `DrawableStreamer`:

- **Active-interior selection**: detect if the camera is inside any exported room AABB for an MLO instance.
- **Room gating**: BFS over portals from the current room (`interiorPortalDepth`) to decide visible rooms.
- **Entity-set gating**: optional toggles per `(parentGuid, setHash)` to hide/show entity-set children.

If interior meshes are missing from the world, it’s usually **export coverage** (missing archetypes), not
the gating logic itself: see `report_missing_meshes.py` + `export_drawables_from_list.py`.

---

## Prioritized backlog (highest ROI next steps)

1. **Wire up a simple shadow pass** (single directional shadow map, no cascades initially).
2. **Export + render GTA LOD hierarchy (ymap parent/child swaps)**
   - this is the biggest “world correctness” gap vs CodeWalker/GTA
3. **Improve atmosphere/timecycle fidelity**
   - add weather presets + better fog curves + exposure/tonemapping
4. **Move heavy chunk work off-thread**
   - Worker for JSONL parsing and/or ENT1 matrix build (and transfer `Float32Array` back).
5. **Per-instance culling for very dense archetypes**
   - start CPU-side coarse culling (per-chunk/per-archetype AABBs), then consider GPU culling later.


