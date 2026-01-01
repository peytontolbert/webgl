# GTA-like Loading & Rendering Guide (WebGL Viewer)

This doc describes the **current loading/streaming/rendering pipeline** in `webgl/webgl_viewer`, what’s still “not GTA-like”, and the **highest-impact changes** to make the viewer feel closer to a real GTA client (fast first frame, continuous streaming, minimal stalls).

---

## GTA V “map” concepts (reference) — what “the map” *is* in engine terms

When we say “the map” in GTA V, it’s not a single file. It’s closer to a **graph of asset types** that the streamer resolves into a consistent “world state” near the player.

### 0) World composition / placement: map data (`.ymap`, engine naming: `.#map` / “imap”)

**Map data** answers: *which entities exist and where are they?*

- **Entities list**: placements reference an archetype name/hash, plus transform and per-entity LOD settings.
- **Streaming bounds/flags**: the map chunk contains **streaming extents** (AABB triggers) and content flags used by the streamer.
- **LOD links**: parent/child relationships let the engine swap low ↔ high as distance changes.

In our viewer, the closest analogue is:

- `assets/entities_index.json` + nearby chunk files (what exists + where).

### 0.1) Archetypes (“what an entity is”): `.ytyp` (`.#typ`)

**Archetypes** answer: *what is this placed thing?*

An archetype ties together:

- **Renderable**: which drawable(s) to stream and render
- **Physics/collision**: which collision files apply
- **Flags/metadata**: time/weather toggles, interior/MLO metadata, etc.

In our viewer, we mostly use:

- **archetype hash** (from exported entity data) → lookup into our exported model manifest.

### 0.2) Collision tiers: `.ybn` / `.ybd` (multiple “tiers” in tooling ecosystems)

GTA uses collision assets for:

- world geometry collision
- prop collision
- different fidelity tiers (tooling often labels these like “hi@” / “ma@” depending on context)

In our viewer today:

- collision is **not simulated** (we can export/inspect it offline, but we don’t currently stream/render collision meshes as gameplay physics).

### 0.3) Drawables + textures are distinct streamable objects (`.ydr/.ydd` + `.ytd`)

GTA’s streamer treats **models** and **texture dictionaries** as separate streamable units:

- a placed entity ultimately needs a drawable/model
- and it may separately require one or more texture dictionaries

In our viewer, the analogue is:

- **mesh bins** in `assets/models/*` (renderable geometry)
- streamed textures managed by `TextureStreamer`

### 0.4) Dependency glue: packfile manifests (`_manifest.ymt` / `._manifest.#mf` style)

The important idea: there is usually **explicit metadata** that ties:

- map chunks → required archetypes
- archetypes → drawables/textures/collision/interior dependencies

…so the streamer can load a *consistent set* for a given bubble.

In our viewer, we recreate a “manifest-like” linkage offline:

- `assets/models/manifest_index.json` + `assets/models/manifest_shards/*.json`:
  - maps archetype hash → available exported LOD mesh bins and material hints
  - loaded **on-demand** as we encounter archetypes nearby (see “Sharded models manifest” below)

---

## GTA-like sequential world loading loop (conceptual)

This is *conceptual* engine behavior. The real RAGE streamer is highly concurrent, but it can feel sequential because dependencies gate what becomes visible.

### Phase A — Boot + mount + build streaming catalog

Engine-level concepts:

- mount base archives / update packs (RPF hierarchy)
- initialize the streaming interface
- load/manifests/metadata so later requests like “load this map chunk” pull in consistent dependencies

Viewer analogue:

- `App` boot in `js/main.js` creates render systems and sets fetch concurrency (see “Boot + first frame” below).

### Phase B — Establish the first “streaming bubble”

Engine asks, near the camera/player:

- which map chunks intersect the bubble?
- do any have flags that gate them (time/weather/etc.)?
- what are the streaming extents and LOD relationships?

Viewer analogue:

- we treat the player/camera position as the center of a bubble and select nearby “chunks” from `assets/entities_index.json`.

### Phase C — Resolve dependencies (“make buildings/terrain/etc concrete”)

Once map chunks are selected:

- entities reference an archetype name/hash
- streamer ensures the archetypes are loaded/known
- then loads drawables + textures needed to render
- and collision/occlusion/LOD assets if applicable

Viewer analogue:

- `DrawableStreamer` groups nearby transforms by archetype hash
- it calls `modelManager.prefetchMeta(hash)` to load the needed **manifest shard**
- once metadata exists, `ModelManager` loads mesh bins and `TextureStreamer` pulls textures

### Phase D — LOD + interior gating (why it feels “sequential” while moving)

Common engine patterns:

- LOD hierarchy resolves (parent/child links, distance thresholds)
- interiors/MLOs load via linked dependencies
- time/weather toggles gate which groups become active

Viewer analogue:

- we select a LOD (“high/med/low”) based on distance and user settings, but we do **not** implement true interior/MLO systems yet.

### Phase E — Continuous streaming maintenance (map loading never ends)

Every tick/frame, the engine re-evaluates:

- what entered/leaves the bubble
- memory pressure + eviction
- priority (critical content vs opportunistic)

Viewer analogue:

- ongoing chunk selection + fetch scheduling; `asset_fetcher.js` supports **high/low priority** so bubble-critical loads don’t get starved by background loads.

---

## Current pipeline (what the viewer does today)

### Boot + first frame (`js/main.js`)

The viewer is intentionally split into:

- **Boot UI**: `index.html` provides a full-screen overlay and status hooks:
  - `window.__viewerSetLoading({ title, detail, progress, visible })`
  - `window.__viewerSetBootStatus(text)`
  - `window.__viewerSkipLoading()` (user button)
- **App initialization**: `new App(canvas)`:
  - Creates WebGL context
  - Sets global fetch concurrency (`setAssetFetchConcurrency(24)`)
  - Creates render systems:
    - `TerrainRenderer` (heightmap terrain)
    - `BuildingRenderer` (combined `buildings.obj` + water plane)
    - `EntityStreamer` + `EntityRenderer` (entity dots)
    - `DrawableStreamer` + `ModelManager` + `InstancedModelRenderer` + `TextureStreamer` (instanced real meshes)

Startup flow (high-level):

1. **Load terrain mesh** (blocking): `assets/heightmap.png`, `assets/terrain_info.json`
2. **Start background loads** (non-blocking):
   - Terrain textures (from `assets/textures/` and `assets/terrain_info.json`)
   - Buildings mesh `assets/buildings.obj`
3. **Load entities index** (blocking): `assets/entities_index.json`
4. **Spawn a ped + set camera**
5. **Warm up streaming** (bounded wait) so the first render has a bubble of chunks/meshes
6. **Start animation loop** (`requestAnimationFrame`)

### Entity streaming (dots)

- `EntityStreamer` reads `assets/entities_index.json`
- It loads nearby chunks from:
  - preferred: `assets/entities_chunks_bin/*.bin` (ENT0 positions-only)
  - fallback: `assets/entities_chunks/*.jsonl` (NDJSON positions)
- `EntityRenderer` draws points (yellow dots) from loaded chunks.

### Drawable streaming (real meshes)

`DrawableStreamer` reads the same `assets/entities_index.json` and loads nearby chunks from:

- preferred: `assets/entities_chunks_inst/*.bin` (ENT1 archetype+transform)
- fallback: `assets/entities_chunks/*.jsonl` (NDJSON full entity objects)

It then:

- groups transforms per archetype hash
- applies selection caps:
  - `maxLoadedChunks`
  - `radiusChunks`
  - `maxArchetypes`
  - `maxModelDistance`
  - optional frustum culling
- calls `InstancedModelRenderer.setInstancesForArchetype(hash, lod, mats)`

### Sharded models manifest (NEW)

The viewer now supports **sharded manifest metadata** to avoid loading/parsing a massive `assets/models/manifest.json` up front.

`setup_assets.py` generates:

- `assets/models/manifest_index.json`
- `assets/models/manifest_shards/*.json` (256 shards by default)

At runtime:

- `ModelManager.init()` tries `assets/models/manifest_index.json` first
- `DrawableStreamer` calls `modelManager.prefetchMeta(hash)` as it encounters archetypes
- when a shard loads, `ModelManager` merges shard meshes into `manifest.meshes` and calls `onManifestUpdated`
- `main.js` listens and forces `DrawableStreamer` to rebuild selection (`_dirty = true`) so real meshes appear ASAP

### Placeholder meshes (optional debugging)

The UI now has: **“Show placeholder meshes for unexported archetypes”**.

- OFF (strict): missing exports render as nothing (clean but confusing)
- ON: missing exports render as small placeholder cubes (best for diagnosing coverage)

---

## Client render shaders (what runs on the GPU)

This section documents **what shaders we currently run** in the WebGL viewer, and (importantly) what a more “client-like” pipeline looks like, based on patterns used in CodeWalker’s D3D11 renderer.

### What the viewer does today (simple forward shading)

We currently use **small, forward-rendered shaders** embedded as inline GLSL strings in the renderer classes:

- **Terrain**: `js/terrain_renderer.js`
  - vertex shader reconstructs height + normals from the heightmap
  - fragment shader does **4-layer splat blending** via `uBlendMask` + `uLayer{1..4}Map`
  - simple directional lighting + a small gamma correction step
- **Buildings + water plane**: `js/building_renderer.js`
  - basic lambert + ambient
  - 2-pass draw: opaque buildings first, then a simple translucent water tint pass
- **Instanced models (props/drawables)**: `js/instanced_model_renderer.js`
  - forward lambert + ambient
  - optional diffuse texture via `uHasDiffuse` + `uDiffuse`
  - instancing uses per-instance matrices in attributes `aI0..aI3`

All of these compile via the shared helper:

- `js/shader_program.js`: compiles vertex+fragment, binds `aPosition/aNormal/aTexcoord` to locations 0..2, links, and provides a small uniform setter.

### How textures feed shaders (viewer)

We effectively have **two texture pipelines**:

- **Terrain textures** (`TerrainRenderer`):
  - loaded via `TextureManager` inside `js/terrain_renderer.js`
  - these are “scene textures” (heightmap, blend mask, layer maps) bound as explicit uniforms
- **Model textures** (`InstancedModelRenderer`):
  - streamed through `TextureStreamer` (`js/texture_streamer.js`)
  - `TextureStreamer` is explicitly designed to be “client-like”:
    - bounded GPU memory (LRU eviction via `maxTextures`/`maxBytes`)
    - quality modes (downscale + mipmaps)
    - `UNPACK_FLIP_Y_WEBGL` to match DX-authored UV conventions for exported assets

### What’s currently *not* client-like (shader side)

Compared to a real GTA-like client (and CodeWalker), we are still missing:

- **Shader variants / feature flags**: we don’t compile permutations for “has normal map / has spec / has tint / has vertex colors / has multiple UV sets”.
- **Material parameter fidelity**: our instanced shader uses only `uColor`, `uUv0ScaleOffset`, and a single optional diffuse texture.
- **Multi-pass lighting**: we do forward lighting only; no G-buffer, no post-process, no timecycle-like grading.
- **Shadow maps**: no real shadows (only lit/unlit shading).

### CodeWalker patterns worth copying (high-signal ideas)

CodeWalker’s renderer is not “the GTA engine”, but it mirrors a lot of **client-style structure** that scales well:

- **Precompiled shader binaries**:
  - CodeWalker loads compiled `.cso` shaders (fast startup, consistent compilation).
- **Strong uniform organization (constant buffers)**:
  - Most shaders are split into “Scene / Entity / Model / Geom” buffers.
  - This lines up nicely with how streaming works: scene changes per-frame; entity/model/geom are per-drawable/per-material.
- **Shader variants per vertex layout**:
  - CodeWalker selects different vertex shaders depending on vertex declaration / available attributes (multiple `VertexType` layouts).
- **Deferred shading path**:
  - CodeWalker’s `DeferredScene` uses multiple render targets (G-buffer) and a separate lighting pass.
- **Shadow mapping**:
  - CodeWalker has a cascaded shadow map system (`Rendering/Utils/Shadowmap.cs`) and a dedicated shadow shader (with skinning variants).

### Viewer “deferred-style” GLSL (present but not wired up yet)

The folder `js/shaders/` contains more “engine-like” GLSL (for example includes + multiple outputs):

- `js/shaders/common.glsl`
- `js/shaders/shadowmap.glsl`
- `js/shaders/terrain.vert`
- `js/shaders/terrain.frag` (writes multiple outputs like `fDiffuse/fNormal/fSpecular/fIrradiance`)

**Important:** these are currently **not connected** to the runtime renderer classes. The viewer’s shader loader (`ShaderProgram`) does not implement `#include` preprocessing or build an MRT framebuffer, so these shaders are effectively “reference / future work” until we wire them in.

### Suggested next steps (shader + material roadmap)

If the goal is “GTA-like client feel”, these are the highest ROI shader-side upgrades:

1. **Add a tiny GLSL preprocessor** for `#include` so we can use `js/shaders/common.glsl` across programs (and reduce duplication).
2. **Introduce a “SceneVars” uniform block** (std140) and move common uniforms there:
   - viewProjection, camera pos/dir, time-of-day, fog params, light params.
3. **Material feature flags + variants** (start small):
   - `HAS_DIFFUSE`, `HAS_NORMAL`, `HAS_TINT`, `HAS_VERTEX_COLOR`
   - compile a small set of permutations and pick at runtime based on exported material metadata.
4. **Shadow map pass** (simple first):
   - start with one directional shadow map (no cascades), then consider cascades later.
5. **Optional deferred path**:
   - if we want the CodeWalker-style “G-buffer then light” look, we can implement MRT in WebGL2 and use the existing `js/shaders/*` as a starting point.

## Why it still doesn’t feel “GTA-like” yet

GTA-like experience has three pillars:

1. **Fast first playable frame**
2. **Continuous streaming with stable frame-time**
3. **Predictable LOD + minimal pop-in**

Current blockers:

- **Boot still does “big work” early**
  - Terrain load is blocking (fine)
  - Warmup streaming can still wait up to several seconds (can be reduced or turned into “soft warmup”)
- **No true “priority lanes” for network/CPU**
  - Background loads (buildings/textures) share the same concurrency limiter as critical chunk loads
- **CPU-heavy chunk processing**
  - JSONL parsing and matrix building still happens on the main thread in some paths
- **Selection caps can look like “missing world”**
  - Defaults (`maxArchetypes=250`, `maxModelDistance=350`) are intentionally conservative
- **Not implemented world systems**
  - interiors/MLO, lights, occlusion, decals/roads systems, collisions (you can export some, but viewer won’t render them yet)

---

## Recommended “GTA-like” loading plan (concrete)

### Phase design

Use three phases:

#### Phase A: First playable frame (block only on essentials)

Block on:

- WebGL context + minimal shader compilation
- `TerrainRenderer.loadTerrainMesh()` (heightmap + terrain_info)
- `EntityStreamer.init()` + `EntityRenderer.init()` (entities index)
- `PedRenderer.init()` + spawn ped

Then **start rendering immediately**.

Do **NOT** block on:

- buildings OBJ
- terrain textures
- drawable meshes / model manifest shards
- warmup “bubble completion”

#### Phase B: Streaming “bubble” (after first frame)

During the first few seconds, prioritize:

- entity chunks near player (dots)
- drawable chunks near player
- manifest shard metadata for those archetypes
- then mesh bins + textures

Keep the loading overlay optional:

- either fade it out after first frame
- or convert it into a small HUD (“Streaming: X/Y”)

#### Phase C: Optional heavy assets

Load in the background:

- buildings.obj
- high-quality textures / higher stream radius presets

### Priority lanes (highest ROI improvement after sharding)

Implement two-lane scheduling inside `asset_fetcher.js`:

- **HIGH priority**: entities_index, near chunks, manifest shards, mesh bins
- **LOW priority**: buildings.obj, terrain textures, distant chunks

Goal:

- high lane never starves
- low lane uses leftover capacity

Minimal implementation idea:

- Maintain two queues and an “active count” per lane
- Reserve e.g. 70% concurrency for HIGH when HIGH has work

---

## Sharded manifest format (what we generate)

### `assets/models/manifest_index.json`

Contains:

- schema marker: `webglgta-manifest-index-v1`
- `shard_bits` (default 8 → 256 shards)
- `shard_dir`: `manifest_shards`
- source mtime to detect staleness

### `assets/models/manifest_shards/<xx>.json`

Contains:

- schema marker: `webglgta-manifest-shard-v1`
- `shard_id`
- `meshes`: a subset of the original `manifest.json` `meshes` object

Sharding key:

- low `shard_bits` of the u32 hash (uniform-ish distribution)

---

## Runtime tuning knobs (what to adjust for “GTA-like”)

In the UI:

- **Streaming radius (chunks)**:
  - 6–10 feels GTA-like (depends on your machine)
- **Max loaded chunks**:
  - 250–900 for “playable city”
- **Max archetypes (instanced meshes)**:
  - 900–2500 for “city density”
- **Model stream distance**:
  - 800–2000 for fewer “pops”
- **Mesh loads in flight**:
  - 8–16 often improves throughput, but too high can hitch

If you see:

- **CappedArchetypes/CappedInstances > 0** → increase caps
- **UnknownMeta*** large → manifest shards still loading (normal right after spawn)
- **Unexported*** large (with placeholders ON) → exporter coverage gaps

---

## Recommended next engineering steps (ordered by impact)

### 1) Start rendering immediately after Phase A (reduce perceived load time)

Change `initializeTerrain()` so it starts the animation loop immediately after:

- terrain mesh
- entities index
- ped init/spawn

And run `_warmupStreaming()` in the background.

### 2) Add fetch priority lanes

So that:

- manifest shard loads + chunk loads are HIGH
- buildings/textures are LOW

This reduces “I moved but nothing loads” feeling.

### 3) Move chunk parsing + matrix building to a Web Worker

Especially for:

- JSONL fallback path
- ENT1 -> matrices building when chunk sizes are large

Return transferables (`Float32Array`) to avoid copies.

### 4) Shard (or binary-encode) the entities chunk metadata further (optional)

You already have:

- ENT0 positions bins
- ENT1 instancing bins

Next step is to keep JSONL only as debug/fallback and rely on binary by default.

### 5) Rendering improvements for “GTA feel”

- Add simple sky/atmosphere + fog (distance cues)
- Add basic directional shadow approximation OR ambient occlusion fudge (cheap)
- Add “grounding” proxy for props if terrain heightmap is coarse (optional)

---

## Quick checklist (if something looks “missing”)

1. Turn on **Entity dots**:
   - If no dots: entities index/chunks not loading (server/path issue).
2. Turn on **Show placeholder meshes**:
   - If many cubes: missing exports (not viewer).
3. Watch the debug HUD:
   - `cappedArchetypes/cappedInstances` high → tune caps.
   - `unknownMeta*` high right after spawn → wait a bit; shards are loading.
4. Confirm you’re running via `run.py` (avoid `file://`):
   - `python webgl/webgl_viewer/run.py`

---

## Commands

- Regenerate assets + manifest shards:
  - `python webgl/webgl_viewer/setup_assets.py`
- Run the viewer:
  - `python webgl/webgl_viewer/run.py`


