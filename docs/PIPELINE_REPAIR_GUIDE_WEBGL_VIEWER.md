# WebGL Viewer Pipeline Repair Guide (GTA5 / CodeWalker parity)

This doc is the **single source of truth** for “how to get to zero placeholders” in the WebGL viewer:
- correct meshes instanced at the right LODs,
- correct rotations (YMAP parity),
- correct material params + UV transforms,
- and **no missing textures** (exported or extracted from game YTDs).

It consolidates the main lessons learned while debugging parity issues.

---

## Ground rules (what “works” means)

- **No placeholder meshes**: every streamed archetype hash maps to an exported mesh entry in `assets/models/...`.
- **No placeholder textures**: every material texture reference resolves to an existing file under `assets/models_textures/...` and uploads successfully.
- **Stable streaming**: no thrash/evictions caused by tiny cache budgets (texture + mesh cache caps are large enough for GTA-scale).
- **Parity-critical transforms**:
  - entity LOD traversal matches CodeWalker’s “visible leaves” behavior,
  - quaternion inversion rules match CodeWalker’s YMAP entity types (base entities vs MLO instances vs interior children).

---

## Directory contract (must match)

### Viewer runtime assets (served at `/assets/...`)

All runtime assets must ultimately live in:

- `webgl-gta/webgl_viewer/assets/`
  - `entities_index.json`
  - `entities_chunks/*.jsonl`
  - `models/manifest_index.json` + `models/manifest_shards/*.json`
  - `models/*.bin` (mesh buffers)
  - **`models_textures/*.png`** (model textures)

Production-like serving requires:
- `npm run build` → `dist/assets/...` populated (via asset sync step).

### Model texture naming contract

Valid filenames under `assets/models_textures/`:
- **hash-only**: `<hash>.png`
- **hash+slug**: `<hash>_<slug>.png`

Where `<hash>` is **JOAAT(textureName)** (unsigned u32 printed in decimal).

The runtime uses a centralized resolver (`js/texture_path_resolver.js`) and an optional index:
- `assets/models_textures/index.json`

Optional (recommended): **KTX2 copies** for faster GPU upload, when your pipeline exports them:
- Directory: `assets/models_textures_ktx2/`
- Filenames: `<hash>.ktx2` (and optionally `<hash>_<slug>.ktx2`)
- Index: `assets/models_textures_ktx2/index.json`

If `index.json` is **stale**, the viewer will “blacklist” textures as **missingFromExportedSet** and immediately use placeholders.

### Optional: “asset packs” (base + DLC exports overlay)

The viewer can optionally resolve model textures from multiple exported roots (e.g. base export + DLC export)
without RPFS, by using a simple overlay system:

- **Config**: `assets/asset_packs.json`
- **Per-pack indices**: `<packRootRel>/models_textures/index.json`
  - (Optional) `<packRootRel>/models_textures_ktx2/index.json` when you export KTX2 packs

Resolution order is:
- highest `priority` pack first (DLC overlays),
- then the normal base `assets/models_textures/`.

Example `assets/asset_packs.json`:

```json
{
  "schema": "webglgta-asset-packs-v1",
  "packs": [
    { "id": "patchday27ng", "rootRel": "packs/patchday27ng", "priority": 100, "enabled": true },
    { "id": "mptuner", "rootRel": "packs/mptuner", "priority": 50, "enabled": true }
  ]
}
```

Directory layout example:
- `assets/models_textures/...` (base export)
- `assets/packs/patchday27ng/models_textures/...` (DLC export)
- `assets/packs/mptuner/models_textures/...`

Notes:
- `setup_assets.py` will generate `models_textures/index.json` for base, and also for each configured pack (best-effort).
- `tools/debug_textures_near_coords.py` respects `asset_packs.json` so offline dumps match runtime resolution.

To ensure your viewer pack list covers **all DLCs CodeWalker knows about**, run:

```bash
python3 webgl-gta/webgl_viewer/tools/write_asset_packs_from_codewalker.py \
  --gta-path /data/webglgta/gta5 \
  --write
```

(This writes `assets/asset_packs.json` listing every DLC from CodeWalker’s `DlcNameList`. You still need to actually export/copy textures into `assets/packs/<dlcname>/...` for those packs to contribute at runtime.)

---

## One-time setup (Linux)

### 1) CodeWalker sources and compiled DLLs

This repo expects:
- `webgl-gta/CodeWalker-master/` (source)
- `webgl-gta/compiled_cw/` (built DLLs)

If you use CodeWalker via Python.NET:
- ensure `gta5.exe` / `\\gta5.exe` symlink workaround is present in your GTA root (handled by `gta5_modules/dll_manager.py`).

### 2) Vite file watcher limits (ENOSPC)

If you hit:
`ENOSPC: System limit for number of file watchers reached`

Fix is in:
- `webgl-gta/webgl_viewer/vite.config.js` (ignore large `assets/models/**/*.bin`).

---

## Repair playbook (do these in order)

### Step A — Verify assets are staged correctly

Run:

```bash
./webgl-gta/scripts/linux_export_and_setup_assets.sh
```

Or if you’ve already extracted into `output/` and only want to restage + verify:

```bash
./webgl-gta/scripts/linux_export_and_setup_assets.sh --no-extract
```

For a full “everything” pipeline (entities + models + textures + materials), use:

```bash
./webgl-gta/scripts/linux_full_export_models_textures_materials.sh
```

The staging script also runs the two authoritative entity checks:
- `verify_entities_index.py` (chunk file integrity)
- `verify_export_vs_codewalker.py` (**coverage vs CodeWalker**, using the repo default “all + patchday27ng union” YMAP scope)

You can also run staging alone:

```bash
python3 webgl-gta/webgl_viewer/setup_assets.py
```

This must generate/refresh:
- `assets/models/manifest_index.json` (+ shards)
- `assets/models_textures/index.json` (**critical**)

If it prints `Warning: textures directory not found`, you are not staging model textures into `assets/models_textures/` (fix exporter/staging paths).

### Step B — Identify missing textures at a coordinate (offline)

Generate a coordinate-local dump (no browser required):

```bash
python3 webgl-gta/webgl_viewer/tools/debug_textures_near_coords.py \
  --viewer 557.516 0.025 157.106 \
  --radius 250 \
  --out webgl-gta/webgl_viewer/tools/out/tex_dump_at_point.json
```

This outputs:
- nearby chunk keys
- archetypes + texture refs
- missing reasons:
  - `missing_file` → file is not present on disk
  - `missing_from_index` → index-gated miss (usually stale/missing `index.json`)
  - `index_stale` → index claims missing but file exists (regenerate index)

### Step C — Fix “missing_from_index” (index gating)

If missing is mostly `missing_from_index`:
- rerun `setup_assets.py` (or regenerate just `assets/models_textures/index.json`)
- confirm the missing hash is present in the index and that a corresponding file exists.

### Step D — Extract truly-missing textures from game YTDs (CodeWalker-backed)

When files are truly absent from `assets/models_textures/`, you have two options:
- **Export pipeline**: export those textures during offline extraction.
- **Repair via YTD extraction**: use CodeWalker’s texture→YTD lookup to dump them from RPFs.

Use:
- `webgl-gta/webgl_viewer/tools/extract_missing_textures_from_ytd_dump.py`

(Added specifically to close the “we have shader param texture names, but no exported PNG” gap.)

### Step D1 — Gen9/Enhanced textures: DDS fallback (fastest path)

If extraction “finds” a texture object but **cannot produce pixels** (common for Gen9 formats like **BC7/BC6H**):
- The repair tools will now **write a `.dds`** into `assets/models_textures/` (or pack-local `assets/packs/<id>/models_textures/`) instead of silently skipping.
- `assets/models_textures/index.json` now includes `.dds` files so the viewer can resolve them deterministically.

Viewer requirements for `.dds`:
- **WebGL2** plus compressed texture extensions:
  - **BC7/BC6H**: `EXT_texture_compression_bptc`
  - **BC4/BC5**: `EXT_texture_compression_rgtc`
  - **BC1/BC2/BC3**: `WEBGL_compressed_texture_s3tc` (+ optional `WEBGL_compressed_texture_s3tc_srgb`)

You can quickly check support at: `webgl_viewer/probe_compressed_textures.html` (served from the viewer root).

---

## CodeWalker texture resolution parity (what the repo mirrors)

This section documents the **exact CodeWalker logic** we rely on (and where the repo intentionally deviates).
Source of truth: `CodeWalker.Core/GameFiles/GameFileCache.cs`.

### What CodeWalker does

- **Texture name hashes**:
  - For any texture “name” string `T`, CodeWalker and GTA use `joaat(T)` (Jenkins one-at-a-time) as the u32 hash.
  - The viewer pipeline stores those textures as files under `assets/models_textures/`:
    - `<hash>.png` and optionally `<hash>_<slug>.png`

- **Shader param “slot hash” vs “texture hash” are different things (easy to mix up)**:
  - Each shader has a `ShaderParametersBlock` that carries two parallel arrays:
    - `Hashes[i]`: the **shader parameter name hash** (slot id, e.g. `DiffuseSampler`)
    - `Parameters[i]`: a `ShaderParameter` whose `Data` is a `TextureBase` when `DataType==0`
  - `TextureBase.NameHash` is the **texture name hash** (this is the hash that should map to a PNG).
  - In other words:
    - **slot hash** tells you which sampler slot it is (diffuse/normal/spec/etc)
    - **texture hash** tells you which texture to load

- **Gen9 parameter name mapping** (PS5/XSX-era assets):
  - For Gen9 resources, CodeWalker maps Gen9 param names to legacy hashes (via `ShadersGen9ConversionData`) so the rest of the pipeline can still key off legacy `ShaderParamNames` hashes.

- **Global texture→YTD lookup (`TryGetTextureDictForTexture`)**:
  - CodeWalker builds an in-memory map called `textureLookup` by scanning loaded YTDs:
    - `AddTextureLookups(YtdFile ytd)` iterates `ytd.TextureDict.TextureNameHashes.data_items` and records `textureLookup[texHash] = ytd.RpfFileEntry`.
  - Lookup call:
    - `TryGetTextureDictForTexture(texHash)` returns `GetYtd(entry.ShortNameHash)` if `texHash` is present in `textureLookup`.
  - **Important gotcha**: CodeWalker does *not* populate `textureLookup` for every loaded YTD by default.
    - In `GameFileCache.ProcessFileRequests(...)`, the `AddTextureLookups(req as YtdFile)` call is commented out.
    - It only explicitly seeds a couple “resident global” YTDs into the lookup (`mapdetail`, `vehshare`).
  - So a miss from `TryGetTextureDictForTexture` does **not** imply “texture missing from game”; it often just means “global lookup table wasn’t built for that session”.

- **Parent TXD/YTD chain**:
  - CodeWalker can walk a parent chain for texture dictionaries:
    - `TryGetParentYtdHash(...)` / `TryFindTextureInParent(texHash, txdHash)`
  - This is important when a drawable’s TXD inherits from another TXD.
  - Source: `InitGtxds()` builds the parent map from:
    - `gtxd.ymt` / `gtxd.meta` (and `mph4_gtxd.ymt`)
    - `vehicles.meta`

- **HD texture dict mapping**:
  - CodeWalker has an HD mapping:
    - `TryGetHDTextureHash(txdHash)` (via `hdtexturelookup`)
  - This can change which YTD should be queried for a given archetype.
  - Source: `InitManifestDicts()` parses `_manifest.ymf` files and reads `HDTxdAssetBindings` (`targetAsset` → `HDTxd`).

### What this repo mirrors today

- **Exporter shader param capture**:
  - `export_drawables_for_chunk.py` extracts compact `shaderParams.texturesByHash` + `vectorsByHash` into manifests.
  - Contract used by this repo:
    - keys of `texturesByHash`: **shader-param slot hashes** (CodeWalker `ShaderParametersBlock.Hashes[i]`)
    - values of `texturesByHash`: ideally a **manifest-relative path** like `models_textures/<textureNameHash>.png` (preferred), otherwise a raw texture name string

- **Extraction parity for TXD→YTD resolution (HD + parents)**:
  - The repo’s extraction/repair tools now apply CodeWalker’s recommended order:
    - embedded drawable texture dicts (when present)
    - **HD TXD mapping** (`TryGetHDTextureHash`) → try that YTD first
    - base TXD (`archetype.TextureDict`) → then parent TXD chain (`TryGetParentYtdHash` / `TryFindTextureInParent`)
    - optional global lookup (`TryGetTextureDictForTexture`) as a last resort (covers only a subset of “resident/shared” dicts)

- **Viewer runtime mapping**:
  - `webgl_viewer/js/model_manager.js` converts shader-param texture *names* to `models_textures/<joaat(name)>_<slug>.png`.
  - `webgl_viewer/js/texture_path_resolver.js` then chooses a URL using:
    - pack overlays (`assets/asset_packs.json`) + per-pack indices
    - base `assets/models_textures/index.json`
    - hash-only vs hash+slug candidate ordering

- **Targeted texture repair**:
  - `webgl_viewer/tools/debug_textures_near_coords.py` identifies which textures are missing near a coordinate (viewer-space or data-space).
  - `webgl_viewer/tools/extract_missing_textures_from_ytd_dump.py` attempts to extract only those missing hashes from game YTDs.
    - Primary strategy: archetype → `TextureDict` (TXD) → YTD → lookup by `texHash`
    - Then: parent TXD chain
    - Then: embedded drawable texture dictionaries (when present)
    - Optional last-resort: heuristic YTD-name token scan

### Known limitations / important caveats

- **Do not treat “TryGetTextureDictForTexture returned null” as “missing DLC”** in this repo’s Python.NET environment.
  - In practice, we’ve observed that CodeWalker’s global `textureLookup` map may not be populated through our bindings, even for hashes that are known-good.
  - Use the *export/repair workflow* (dump → extract → re-probe) as ground truth instead.

- **HD TXD mapping**:
  - If you see “model loads but textures missing” for content that should exist, HD mapping (`TryGetHDTextureHash`) is a likely missing piece in the repo’s extraction path and should be added to the resolution strategy.

### Step D2 — If extraction still leaves missing textures: run a global YTD scan (last resort)

Some texture names referenced by manifests are **not reachable via archetype TXD → parent TXDs**, and may not be
discoverable via a simple `TryGetTextureDictForTexture` lookup depending on how the game content is packaged.

If you want a **single command** that runs the full repair loop (manifest scan → targeted YTD extraction → drawable fallback → index regen), use:

```bash
python3 webgl_viewer/tools/repair_missing_model_textures.py \
  --gta-path /data/webglgta/gta5 \
  --assets-dir webgl_viewer/assets \
  --selected-dlc all \
  --also-scan-dlc patchday27ng
```

Notes:
- This writes the intermediate “missing with refs” list to `output/missing_model_textures_from_manifest_with_refs.json`.
- Some textures may still remain missing if they **do not exist** in the installed GTA data (or require DLC packs you don’t have).

If you still see missing textures after Step D, run:

```bash
python3 webgl-gta/webgl_viewer/tools/extract_missing_textures_global_scan.py \
  --gta-path /data/webglgta/gta5 \
  --selected-dlc all \
  --also-scan-dlc patchday27ng \
  --dump webgl-gta/webgl_viewer/tools/out/tex_dump_at_point_after_ytd_extract4.json \
  --out-dir webgl-gta/webgl_viewer/assets/models_textures
```

This scans *all* YTDs known to CodeWalker’s `GameFileCache.YtdDict` and extracts only the hashes referenced by the dump.
It’s slower, but it’s the most reliable way to drive a coordinate dump toward **zero placeholders**.

Pack-aware option (recommended when using `assets/asset_packs.json`):
- Use `--split-by-dlc` to write extracted textures into `assets/packs/<dlcname>/models_textures/` based on the source YTD path.

```bash
python3 webgl-gta/webgl_viewer/tools/extract_missing_textures_global_scan.py \
  --gta-path /data/webglgta/gta5 \
  --selected-dlc all \
  --also-scan-dlc patchday27ng \
  --split-by-dlc \
  --assets-dir webgl-gta/webgl_viewer/assets \
  --dump webgl-gta/webgl_viewer/tools/out/tex_dump_at_point_after_ytd_extract4.json
```

### Step D3 — If hashes still remain: extract from embedded Drawables and Particle YPT texture dictionaries

If you still have `missing_from_index` after a global YTD scan, those hashes are often **not in any YTD at all**.
Two CodeWalker-backed sources can still contain the texture bytes:

- **Embedded drawable shader texture objects** (YDR/YDD/YFT and also drawables embedded inside other resources):
  - `python3 webgl-gta/webgl_viewer/tools/extract_missing_textures_from_drawables.py ...`
- **Particle effect texture dictionaries** (`.ypt` → `ParticleEffectsList.TextureDictionary`):
  - `python3 webgl-gta/webgl_viewer/tools/extract_missing_textures_from_particles.py ...`

Example (scan both CodeWalker DLC levels, regenerate indices):

```bash
python3 webgl-gta/webgl_viewer/tools/extract_missing_textures_from_drawables.py \
  --gta-path /data/webglgta/gta5 \
  --assets-dir webgl-gta/webgl_viewer/assets \
  --selected-dlc all \
  --also-scan-dlc patchday27ng \
  --missing webgl-gta/webgl_viewer/tools/out/missing_textures_remaining.json

python3 webgl-gta/webgl_viewer/tools/extract_missing_textures_from_particles.py \
  --gta-path /data/webglgta/gta5 \
  --assets-dir webgl-gta/webgl_viewer/assets \
  --selected-dlc all \
  --also-scan-dlc patchday27ng \
  --missing webgl-gta/webgl_viewer/tools/out/missing_textures_remaining.json \
  --regen-index
```

### Step E — Re-run the dump to verify “no more placeholders”

Repeat Step B. Your goal is:
- `missingByReasonUseCount` is empty (or at least not for the textures you care about).

### Step F — If CodeWalker can’t locate the remaining texture hashes

If extraction tools can’t find a YTD for some texture hashes, you should assume one of:
- your **GTA install is missing that DLC/content** (common on trimmed installs),
- you’re using **modded assets** and need to point `--gta-path` to the modded install (or mount those RPFs),
- or the manifests reference textures that are **not actually present anywhere** (bad reference upstream).

Generate a definitive report (fast, no global scanning):

```bash
python3 webgl-gta/webgl_viewer/tools/report_unresolved_textures.py \
  --gta-path /data/webglgta/gta5 \
  --selected-dlc patchday27ng \
  --dump webgl-gta/webgl_viewer/tools/out/tex_dump_at_point_after_global_scan2.json \
  --out webgl-gta/webgl_viewer/tools/out/unresolved_textures_report.json
```

If `cwFoundYtdEntryName` is null for a texture, CodeWalker couldn’t locate it in your current install,
so **there is nothing to extract** until you provide the missing content.

---

## Browser-side debugging (fast loop)

### Useful console helpers

- `__viewerDumpTextureCoverage()`:
  - scans loaded model shards and counts referenced textures vs exported set
- `__viewerDumpTextureFrame()`:
  - frame-level missingFromExportedSet + placeholder usage
- `__viewerGetErrors()`:
  - global ring buffer (texture failures, worker issues, parse fallbacks)

### Perf HUD

Enable the Perf HUD checkbox. It reports:
- mesh cache stats
- texture cache stats
- per-frame texture wanted/real/placeholder counts

If you “can’t see stats anymore”, verify:
- the Perf HUD checkbox is enabled
- `#perfHud` exists in `index.html`

---

## Critical parity fixes (what we already changed)

### 1) Texture eviction thrash (was caused by caps being reset)

- `TextureStreamer.setQuality()` no longer changes cache caps.
- Cache caps are explicit via constructor / `setCacheCaps(...)`.

### 2) Mesh cache eviction churn (budget too small)

- Mesh cache cap is now multi-GB (adaptive, and overrideable).

### 3) Quaternion inversion parity (YMAP)

Rotation handling must match CodeWalker:
- base YMAP entities invert orientation
- MLO instances and interior-child entities have different inversion rules

### 4) UV transform parity

If `uv0ScaleOffset`/`detailSettings` are missing in manifests, derive them from:
- `shaderParams.vectorsByHash` (`gTexCoordScaleOffset0`, `detailSettings`)

---

## Common failure modes and fixes

### “Loads and fails at the same time”

Cause:
- SPA fallback HTML was cached as if it were an image.

Fixes:
- don’t cache non-OK or HTML-like responses in `asset_fetcher.js`
- evict HTML masquerading as images in `texture_streamer.js`

### `bytes: 0` in texture stats

This is a stats/telemetry limitation, not proof textures are not loaded.
Use:
- `textures` count (resident)
- `missingFromExportedSet` list

### `WebGL INVALID_ENUM readPixels`

Cause:
- unsupported depth readback format on some GPUs.

Fix:
- disable occlusion readback after first failure (avoid console spam).

---

## “Zero placeholders” is a pipeline guarantee, not a viewer trick

The viewer can only do two things:
- resolve texture refs to exported URLs
- fetch/decode/upload those URLs

So the only sustainable “no placeholders” solution is:
- **everything referenced by materials exists under `assets/models_textures/`**, or
- you add a **runtime RPF/YTD fallback** (heavy, but possible).

This guide provides the export/repair tools so the pipeline can guarantee that condition.


