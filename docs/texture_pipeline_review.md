# Texture Pipeline Review (CodeWalker → Export → WebGL Viewer)

This document reviews the **full texture pipeline** in this repo, identifies the **expected directory + filename conventions**, and lists the most common **discrepancy modes** (404s, HTML-as-image, wrong naming, stale cache).

It focuses on **model textures** (the `models_textures` pipeline) because that’s where most “missing texture” issues show up.

## Executive summary (what must match)

- **Runtime URL namespace**: the viewer loads runtime/exported assets from **`/assets/...`** (Vite dev/preview mounts this explicitly).
- **Model texture directory**: model textures are expected under **`assets/models_textures/`** (optionally legacy: `assets/models/models_textures/`).
- **Model texture filenames (two valid conventions)**:
  - **Hash-only** (fast path used when shader params contain just a texture name): ✅ `assets/models_textures/<joaat(name)>.png`
  - **Hash+slug** (commonly produced by some exporters / useful for debugging): ✅ `assets/models_textures/<joaat(name)>_<slug>.png`
  - **Important**: if your manifests/materials are relying on **shader-param name → hash** resolution, you must ensure the **hash-only** file exists (or store explicit paths in the manifest).
- **Build sync**: `npm run build` must end with copying runtime assets into `dist/assets/` (so `vite preview` behaves like production).
- **Caching**: asset fetches can be served from **CacheStorage** (`asset_fetcher.js`), so stale assets are possible after re-export unless cache is cleared / cache name is bumped.

## Pipeline overview (stages)

### Stage A — Source of truth (CodeWalker / game assets)

- CodeWalker parses game archives (`.rpf`) and resources (`.ytd`, `.ydr`, `.ydd`, etc.).
- The viewer does **not** load these directly; it relies on the repo’s **exported runtime assets**.

### Stage B — Export (repo scripts write runtime assets)

There are two common export layouts in this repo:

- **Direct-to-viewer assets (preferred for the viewer)**: exporters write directly into:
  - `webgl/webgl_viewer/assets/models/*` (mesh bins + manifest)
  - `webgl/webgl_viewer/assets/models_textures/*` (model textures)
- **Intermediate `webgl/output/...`**: some scripts write to `webgl/output/` first, then a staging step copies into the viewer’s `assets/`.

Model textures ultimately need to be exported into one of the expected intermediate directories (historically there have been multiple layouts).

Recommended debugging tool for “where did this texture go?”:
- `webgl/webgl_viewer/tools/trace_texture_pipeline.py` (it checks multiple stage dirs and detects hash-only vs hash+slug variants).

### Stage C — Viewer runtime assets (copy into `webgl/webgl_viewer/assets/...`)

`webgl/webgl_viewer/setup_assets.py` prepares the viewer’s `assets/` folder (terrain, entity chunks, manifests, etc.).

Important nuance:
- Some exporters already write **directly** into `webgl/webgl_viewer/assets/` (so there is nothing to copy).
- If your exporter wrote model textures into `webgl/output/...`, `setup_assets.py` should stage them into `webgl/webgl_viewer/assets/models_textures/` so the viewer can load them at runtime.

This is where the viewer expects to find:
- `assets/entities_index.json`
- `assets/entities_chunks/*.jsonl`
- `assets/models/*` (mesh bins + manifests)
- **`assets/models_textures/*` (model textures)**
- `assets/textures/*` (terrain textures)

### Stage D — Build artifacts (sync into `webgl/webgl_viewer/dist/assets/...`)

`npm run build` runs:

- `vite build`
- then `python sync_assets_to_dist.py`

`sync_assets_to_dist.py` copies **everything** from `webgl/webgl_viewer/assets/` into `webgl/webgl_viewer/dist/assets/`.

This is critical because:
- `vite preview` serves from `dist/` and must be able to resolve `GET /assets/...`.

### Stage E — Serving (Vite dev vs preview)

`webgl/webgl_viewer/vite.config.js` mounts runtime assets at `/assets` with “real 404” behavior:

- In **dev**, it mounts `webgl/webgl_viewer/assets` at `/assets/...` (and ensures missing assets are a real 404, not SPA fallback HTML).
- In **preview**, it prefers `webgl/webgl_viewer/dist/assets` and falls back to `assets/` if a file wasn’t synced yet.

If you see “image decode failed” and the response is actually HTML, this config is the first place to validate.

### Stage F — Runtime loading (viewer code)

#### 1) URL + caching layer

`webgl/webgl_viewer/js/asset_fetcher.js` provides:
- in-flight de-dupe,
- global concurrency limiting,
- optional **CacheStorage** persistence.

Important behavior:
- Only URLs starting with `assets/` or `/assets/` are cacheable.
- Cache name is versioned (currently `webglgta-assets-v3`); bump it if formats/layouts change.
- CacheStorage is only available in secure contexts (https/localhost). If unavailable, it falls back automatically.

#### 2) Material → texture path resolution (models)

`webgl/webgl_viewer/js/model_manager.js` resolves texture references for model materials.

There are two ways textures are resolved:

- **Explicit material paths (best)**: if the manifest already contains a relative path (e.g. `models_textures/123_slug.png`), the viewer uses it as-is.
- **Shader-param name → hash (fallback)**: if the manifest only has CodeWalker-style `shaderParams.texturesByHash` entries that are *names* (e.g. `"Prop_LOD"`), the viewer computes `joaat(name)` and maps to:
  - `models_textures/<hash>.png`

This avoids reliance on slugged filenames in the hot path, but it requires that **`<hash>.png` exists** in `assets/models_textures/`.

#### 3) Streaming / decoding / GPU upload

`webgl/webgl_viewer/js/texture_streamer.js`:
- maintains an LRU-like cache bounded by `maxTextures` and `maxBytes`,
- chooses quality tiers (high/medium/low) by distance,
- fetches textures as **blobs** and sniffs the first bytes to detect common misroutes (HTML-as-image, DDS, KTX2),
- decodes via `createImageBitmap()` when available (fallback to `<img>` for older browsers),
- clamps decode size to `gl.MAX_TEXTURE_SIZE` (prevents silent black textures),
- uploads with `UNPACK_FLIP_Y_WEBGL = true` (GTA/CodeWalker UV parity),
- uses mipmaps + REPEAT only when allowed (WebGL2 or power-of-two),
- supports **basic KTX2** parsing (limited to uncompressed RGBA8; no supercompression/Basis transcoding).

## Directory + naming conventions (must be consistent)

### Model textures

- **Directory**: `webgl/webgl_viewer/assets/models_textures/`
- **URL**: `/assets/models_textures/<file>`
- **Preferred filename**: `<hash>.png` where `hash = joaat(lowercase(textureName))`

If your export produces `<hash>_<slug>.png` only, either:
- also export the hash-only alias, or
- ensure your manifests store explicit relative paths like `models_textures/<hash>_<slug>.png` (do not store just the bare filename without the `models_textures/` directory).

### Terrain textures

- **Directory**: `webgl/webgl_viewer/assets/textures/`
- **Referenced by**: `assets/terrain_info.json` (and the terrain renderer).

## Known discrepancy modes + symptoms

### 1) **404 Not Found** for `assets/models_textures/...`

Cause(s):
- file genuinely missing from `assets/models_textures/`,
- build/preview not synced (missing from `dist/assets`),
- filename mismatch (hash-only vs hash+slug),
- wrong directory (`models/models_textures` legacy layout).

Fix:
- Use `trace_texture_pipeline.py` for a specific URL/name/hash.
- Verify `npm run build` finishes with `sync_assets_to_dist.py`.

### 2) “PNG decode failed” / “returned HTML”

Cause(s):
- server returns SPA `index.html` instead of a real 404 for missing `/assets/...`.

Fix:
- Confirm `vite.config.js` mounts `/assets` with `single: false` and a fallback 404 responder.

### 3) Textures “never update” after re-export

Cause(s):
- CacheStorage served stale copies.

Fix:
- Clear cache via the viewer UI (if enabled), call `clearAssetCacheStorage()` in DevTools, or bump the cache name in `asset_fetcher.js`.

### 4) Entity LOD traversal toggles break “everything loads”

Cause(s):
- not a texture issue directly; if models don’t instance, textures won’t be requested.
- entity traversal mode requires extra hierarchy fields in `entities_chunks/*.jsonl`.

Fix:
- Re-export entities with `ymap_entity_index`, `parent_index`, `num_children`, `lod_dist`, `child_lod_dist`.
- Viewer has a best-effort fallback, but true CodeWalker-style traversal needs the fields.

## Recommended verification checklist (end-to-end)

1) **Export stage**:
   - Confirm model textures exist in your export output (either directly in `webgl/webgl_viewer/assets/models_textures/` or in `webgl/output/...`).
   - Confirm you have **hash-only** files if the manifest depends on shader-param name resolution.

2) **Assets stage**:
   - Confirm `webgl/webgl_viewer/assets/models_textures/` contains the expected files.

3) **Build stage**:
   - Run `npm run build` and confirm it prints `Synced runtime assets to dist: ... -> .../dist/assets`.

4) **Runtime stage**:
   - In DevTools Network tab, confirm requests are to `/assets/models_textures/<hash>.png` and return `200`.

## Debug tools (built-in)

- **Trace a single missing texture across all stages**:
  - `webgl/webgl_viewer/tools/trace_texture_pipeline.py`
- **Scan a directory for bad signatures / HTML / DDS/KTX2 mismatches**:
  - `webgl/webgl_viewer/tools/scan_model_textures.py`


