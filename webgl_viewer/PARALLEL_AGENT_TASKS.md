# WebGL Viewer — Parallel Engineering Tasks Backlog

This document is designed for **concurrent parallel AI coding agents**. Each task is intentionally scoped to minimize overlap.  
When you pick a task, **claim it** (add your name + date), then implement it end-to-end with tests/verification notes.

## Ground rules (to avoid agent collisions)

- **One agent per task ID** at a time.
- Prefer **additive changes** (new modules/classes) over large refactors.
- If a task needs touching the same hot files (`js/main.js`, `js/drawable_streamer.js`, `js/instanced_model_renderer.js`), coordinate by:
  - keeping changes minimal,
  - landing smaller PRs,
  - or creating a new module and wiring it in with a small patch.
- Each task must include:
  - **Acceptance criteria** satisfied
  - **How to verify** (steps / console output / perf numbers)
  - **Notes on risks**

---

## Task A1 — Off-main-thread chunk parsing + matrix building (Worker)

- **Status**: complete
- **Claimed by**: GPT-5.2 (Cursor) — 2025-12-31
- **Goal**: Reduce hitching when streaming large radii by moving NDJSON parsing and instance-matrix building off the main thread.

### Current behavior
- `js/asset_fetcher.js` provides `fetchNDJSON(...)` that parses on the main thread.
- `js/drawable_streamer.js` parses chunk data and builds instance matrices on the main thread.

### Proposed approach
- Add a new worker module, e.g. `js/chunk_worker.js`, that:
  - accepts an ArrayBuffer or text chunk,
  - parses records (JSONL/NDJSON),
  - builds:
    - `Map<hash, Float32Array>` (or transferable `Float32Array` slices packed into one buffer)
    - per-hash min-dist stats if needed.
- Main thread streams bytes → posts to worker → receives **transferable** buffers.
- Keep back-compat fallback to main-thread parsing if Worker fails (CSP / older environments).

### Files to touch
- `webgl/webgl_viewer/js/drawable_streamer.js`
- `webgl/webgl_viewer/js/asset_fetcher.js` (optional helper for streaming bytes)
- Add: `webgl/webgl_viewer/js/chunk_worker.js`

### Acceptance criteria
- **Functional parity**: streamed models/entities appear identical to baseline.
- **Perf**: visibly fewer long frames during chunk bursts (subjective OK, ideally measurable via perf HUD task).
- **No memory leak**: worker messages use transferables; no unbounded retention.

### Verify
- Stream city/extreme presets; rotate camera rapidly.
- DevTools Performance: confirm reduced main-thread time in JSON parsing / matrix building.
- In DevTools console, confirm there are no repeated errors like `chunk worker failed` / `chunk worker crashed` and that streamed geometry still appears.

### Notes / risks
- Worker is **best-effort**: if module Workers are blocked (CSP / `file://` / older browsers), it falls back to the previous main-thread parsing path.
- ENT1 binary tiles are also parsed/built in the worker when available; for safety the main thread keeps a copy so it can fall back if the worker fails.

---

## Task A2 — Texture streaming by visibility + distance (mip/quality) + LRU eviction

- **Status**: completed
- **Claimed by**: GPT-5.2 (Cursor) — 2025-12-31
- **Goal**: Reduce VRAM spikes and “black texture churn” by requesting textures based on per-frame visible set and distance, and evicting via LRU.

### Current behavior
- `js/texture_streamer.js` exists and supports some notion of `maxTextures/maxBytes` (needs audit).
- Renderers call `prefetch(url)` + `get(url)` opportunistically.

### Proposed approach
- Add an API to `TextureStreamer`:
  - `beginFrame()`, `touch(url, { priority, distance })`, `endFrame()`
- Visible render paths call `touch(...)` instead of raw `prefetch(...)`.
- Implement:
  - **distance → quality/mip target** (even if coarse: high/med/low tiers)
  - **LRU eviction** by last-touched + byte size estimate
- Keep a “debug mode” that logs evictions and current VRAM budget usage.

### Files to touch
- `webgl/webgl_viewer/js/texture_streamer.js`
- `webgl/webgl_viewer/js/instanced_model_renderer.js`
- possibly `js/terrain_renderer.js`, `js/building_renderer.js`

### Acceptance criteria
- **No regression**: textures still appear correctly in typical play.
- **Stability**: long sessions don’t balloon texture count/bytes beyond configured budget.
- **Less churn**: fewer cases where close-range surfaces repeatedly re-upload textures.

### Verify
- In DevTools console, inspect:
  - `__viewerApp.textureStreamer.getStats()` → `{ textures, bytes, maxBytes, evictions, lastFrameRequests, ... }`
  - Optionally enable logs: `__viewerApp.textureStreamer.setDebug({ enabled: true, logEvictions: true })`
- Fly/drive around for a few minutes; confirm:
  - `bytes` stays bounded under `maxBytes` (evictions will rise in heavy areas)
  - close-range textures tend toward higher tiers; far-range tends toward lower tiers
  - fewer cases where nearby surfaces flip back to placeholder/gray repeatedly (“black texture churn”)

---

## Task A3 — Mesh cache LRU eviction with approximate byte budget

- **Status**: completed
- **Claimed by**: GPT-5.2 (Cursor) — 2025-12-31
- **Goal**: Prevent `ModelManager.meshCache` from growing without bound by evicting least-recently-used meshes to fit a budget.

### Current behavior
- `js/model_manager.js` caches meshes in `meshCache` and never evicts.

### Proposed approach
- Track per-mesh metadata:
  - `lastUsedFrame` or `lastUsedMs`
  - `approxBytes` (based on buffer sizes: pos/nrm/uv/tan/index)
- Add budget config:
  - e.g. `maxMeshCacheBytes` (default: something conservative)
- Add API:
  - `touchMesh(key)` called from render path when mesh is drawn
  - periodic eviction when budget exceeded
- Ensure GL resources are deleted on eviction:
  - `deleteBuffer`, `deleteVertexArray`

### Files to touch
- `webgl/webgl_viewer/js/model_manager.js`
- `webgl/webgl_viewer/js/instanced_model_renderer.js` (call `touchMesh`)

### Acceptance criteria
- Mesh cache stabilizes under budget.
- No WebGL errors / missing geometry beyond expected “reload later” behavior.

### Verify
- In DevTools console, inspect:
  - `modelManager.getMeshCacheStats()` → `{ count, approxBytes, maxBytes, evictions }`
  - Optionally enable logs: `modelManager.meshCacheDebug = true`
- Fly around for a few minutes; confirm `approxBytes` stays ≤ `maxBytes` and `evictions` increases over time in heavy areas.
- If you see missing geometry, it should recover as meshes reload (renderer drops evicted meshes and enqueues reload).

---

## Task A4 — Simple occlusion proxy (depth prepass + conservative cull)

- **Status**: complete
- **Claimed by**: GPT-5.2 (Cursor) — 2025-12-31
- **Goal**: Cut draw load in dense cities by adding a simple occlusion signal beyond frustum culling.

### Constraints / notes
- WebGL2 has no compute, but you can:
  - render a cheap depth prepass (terrain/buildings),
  - then do conservative screen-space tests for instance groups,
  - or use hierarchical depth manually at low resolution (engineering heavy).

### Proposed minimal v1
- Render depth-only pass for terrain + buildings into a small depth texture/FBO.
- For each instance bucket (or archetype):
  - project its AABB to screen
  - sample a few depth points (very low sample count)
  - if all samples are behind existing depth by margin → skip drawing that bucket this frame.

### Files to touch
- `webgl/webgl_viewer/index.html` (toggle checkbox)
- `webgl/webgl_viewer/js/main.js` (depth prepass wiring)
- `webgl/webgl_viewer/js/instanced_model_renderer.js` (conservative cull gates)
- `webgl/webgl_viewer/js/model_manager.js` (mesh bounds/radius metadata)
- Add: `webgl/webgl_viewer/js/occlusion.js`

### Acceptance criteria
- Can be toggled on/off (debug checkbox).
- In dense scenes, reduces drawn bucket count / draw calls without obvious popping.

### Verify
- Enable **Occlusion culling (experimental)** in the Scene controls.
- Move/rotate the camera in a dense area with **Show Models** enabled.
- In DevTools console:
  - `__viewerApp.occlusionCuller?.getStats?.()` → confirms depth readbacks are happening (and shows timing).
  - `__viewerApp.instancedModelRenderer?._occlusionStats` → shows `tested` and `culled` counts per frame.

---

## Task A5 — Render-pass state sorting + binding cache (materials/textures)

- **Status**: complete
- **Claimed by**: GPT-5.2 (Cursor) — 2025-12-31
- **Goal**: Reduce redundant state changes by sorting draws by material signature and caching last-bound textures/uniforms.

### Current behavior
- `InstancedModelRenderer.render` binds textures/uniforms per submesh/bucket in iteration order.

### Proposed approach
- In `InstancedModelRenderer`:
  - gather draw items into an array each frame (bucket entries + archetype submeshes)
  - compute a sort key:
    - `materialSig` (already available), plus `meshHasTangents`, etc.
  - sort stable and draw
- Add a small state cache:
  - last diffuse/normal/spec URL bound
  - last UV scale/offset
  - last spec params
  - skip redundant `uniform*` and `bindTexture` calls

### Files to touch
- `webgl/webgl_viewer/js/instanced_model_renderer.js`

### Acceptance criteria
- Same visual output.
- Lower CPU time in render loop (fewer GL calls), measurable via perf HUD.

### Verify
- Open a dense scene (models on) and rotate/move camera.
- In DevTools Performance, confirm reduced time in WebGL binding calls (look for fewer `bindTexture`, `uniform*`, `bindVertexArray`).
- Quick regression check: toggle **Cross-archetype instancing** on/off; visuals should match baseline (just different batching).

---

## Task A6 — Diagnostics + Perf HUD (draw calls, buckets, triangles, GPU time)

- **Status**: completed
- **Claimed by**: GPT-5.2 (Cursor) — 2025-12-31
- **Goal**: Make performance measurable inside the viewer with a small on-screen panel.

### Proposed metrics (v1)
- **CPU-side**:
  - frame time (ms), FPS (avg)
  - number of model draw calls (instanced draws)
  - number of active instance buckets
  - approximate triangles rendered (indexCount/3 * instanceCount)
  - mesh cache size/bytes (Task A3 provides)
  - texture cache size/bytes (Task A2 provides)
- **GPU-side** (optional):
  - `EXT_disjoint_timer_query_webgl2` GPU time per frame (if available)

### UI
- A small fixed overlay (`div`) with monospace text, toggle checkbox in controls.

### Files to touch
- `webgl/webgl_viewer/index.html`
- `webgl/webgl_viewer/js/main.js`
- `webgl/webgl_viewer/js/instanced_model_renderer.js` (expose stats)
- `webgl/webgl_viewer/js/model_manager.js` / `js/texture_streamer.js` (expose cache stats)

### Acceptance criteria
- HUD can be toggled.
- Shows stable, non-spammy stats.
- Does not materially change performance when off.

### Verify
- In the Scene controls, enable **Perf HUD (diagnostics)**.
- Confirm an on-screen overlay appears (top-right) and updates ~5x/second.
- In DevTools console, inspect:
  - `__viewerApp.instancedModelRenderer.getRenderStats()` → `{ drawCalls, triangles, instances, ... }`
  - `__viewerApp.modelManager.getMeshCacheStats()` → `{ count, approxBytes, maxBytes, evictions }`
  - `__viewerApp.textureStreamer.getStats()` → `{ textures, bytes, maxBytes, evictions, ... }`
- If supported, GPU time will appear as `GPU: XX.XX ms` (uses `EXT_disjoint_timer_query_webgl2`).

---

## Suggested parallelization plan

- Agent 1: **A1 Worker parsing**
- Agent 2: **A6 Perf HUD** (enables measurement for all other tasks)
- Agent 3: **A3 Mesh LRU**
- Agent 4: **A2 Texture LRU + distance-based quality**
- Agent 5 (optional): **A5 State sorting**
- Later: **A4 Occlusion proxy** (highest risk / most integration)


