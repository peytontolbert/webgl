# Extraction Pipeline Checklist (GTA V → WebGL/Server Assets)

This document is a **parallelizable checklist** for extracting *all* required GTA V map data and producing a consistent, rebuildable output dataset.

## Scope / “Done” definition

The pipeline is considered **complete** when:

- **All required inputs** are discoverable in the GTA install (`common.rpf`, `update/update.rpf`, DLC patch RPFS).
- **All required outputs** are produced under `output/` in a stable, reproducible layout.
- Every step has a **verification command** and a clear expected result.

> Note: “All of them” is large. The pipeline should be implemented **incrementally**, but each item below is independently verifiable so multiple people can work in parallel.

## Environment & conventions

- **GTA root**: set in `env.local` (preferred on this repo) or `.env`:
  - `gta_location="/data/webglgta/webgl-gta/gtav"`
  - `gta5_path="/data/webglgta/webgl-gta/gtav"` (alias)
- **Output root**: `output/`
- **Viewer assets**: `webgl_viewer_old/assets/` (populated via `python3 webgl_viewer_old/setup_assets.py`)

## Output directory layout (target)

Create/maintain the following folders:

- `output/_extracted/` (temporary/raw extracted files pulled from RPFS)
- `output/heightmap/` (heightmap products)
- `output/ymap/raw/` (raw `.ymap`)
- `output/ymap/entities/` (JSON entity lists)
- `output/ytyp/raw/` and `output/ytyp/archetypes/`
- `output/models/raw/` (ydr/ydd/yft)
- `output/collision/raw/` (ybn)
- `output/textures/raw/` (ytd) and `output/textures/png/` (decoded)
- `output/meta/` (indexes, manifests, provenance, logs)

## 0) RPF access & extraction (foundation)

### Checklist

- [ ] **RPF extractor CLI builds on Linux**
  - **Owner**:
  - **Status**:
  - **Command**: `dotnet build CodeWalker.Cli/CodeWalker.Cli.csproj -c Release`
  - **Expect**: build succeeds, produces `CodeWalker.Cli/bin/Release/net8.0/CodeWalker.Cli.dll`

- [ ] **RPF extractor can pull a known file (heightmap.dat)**
  - **Owner**:
  - **Command**:
    - `dotnet CodeWalker.Cli/bin/Release/net8.0/CodeWalker.Cli.dll extract --game <GTA_ROOT> --rpf <GTA_ROOT>/common.rpf --file data/levels/gta5/heightmap.dat --output output/_extracted/heightmap.dat`
  - **Expect**: file exists and size > 0

- [ ] **Implement CLI “find/list” for bulk extraction** *(future)*
  - **Owner**:
  - **Goal**: `find --rpf update/update.rpf --glob "*.ymap"` outputs paths
  - **Expect**: stable, scriptable output

### Acceptance criteria

- Extraction is deterministic (same inputs → same bytes written).
- CLI returns non-zero on failure.

## 1) Heightmap / terrain surface

### Checklist

- [x] **Extract heightmap.dat from RPFS on Linux**
  - **Owner**:
  - **Command**:
    - `python3 extract_heightmap_linux.py --game-path <GTA_ROOT> --output-dir output --size 256`
  - **Expect**:
    - `output/_extracted/heightmap.dat`
    - `output/heightmap.png`
    - `output/terrain_info.json`

- [ ] **Export terrain mesh at multiple resolutions** *(future)*
  - **Owner**:
  - **Expect**: `output/heightmap/terrain_{lod}.obj` or `.glb`

### Verification

- [ ] **Validate PNG format**
  - `file output/heightmap.png`
  - Expect: `PNG image data, 256 x 256, 8-bit grayscale`

- [ ] **Validate bounds look sane**
  - Inspect `output/terrain_info.json` bounds (min/max within GTA’s world scale)

## 2) YMAPs (world placements / entities)

### What this provides

YMAPs describe **entity placements** (archetypes), LODs, MLO instances, timecycle modifiers, occluders, etc.

### Checklist

- [ ] **Bulk extract all `.ymap` files**
  - **Owner**:
  - **Inputs**: `common.rpf`, `update/update.rpf`, DLC patch RPFS in `update/x64/dlcpacks/...`
  - **Outputs**: `output/ymap/raw/**/*.ymap`
  - **Verify**: count > 0 and stable between runs
  - **Command**:
    - `python3 extract_ymaps.py --game-path <GTA_ROOT> --output-dir output --no-entities`

- [ ] **Parse YMAP → entities JSON**
  - **Owner**:
  - **Outputs**:
    - `output/ymap/entities/<ymap_name>.json`
  - **Fields to include** (minimum):
    - `ymap`: name/path
    - `entities[]`: `{ archetypeName/hash, position(x,y,z), rotation(quat), scale, flags, lodDist, parentIndex }`
    - `mloInstances[]`, `carGens[]`, `occluders[]` (as available)
  - **Verify**:
    - JSON loads
    - entity count matches CodeWalker’s `YmapFile.CEntityDefs.Length` (when applicable)
  - **Command**:
    - `python3 extract_ymaps.py --game-path <GTA_ROOT> --output-dir output --no-raw`
    - (or both together) `python3 extract_ymaps.py --game-path <GTA_ROOT> --output-dir output`
  - **Notes**:
    - The extractor also writes `output/ymap/ymap_index.json` with per-YMAP counts to make repeatability checks easier.

- [ ] **Tile/partition YMAP entities** *(future)*
  - **Owner**:
  - **Goal**: produce spatial tiles (grid/quadtree) for fast streaming and map rebuild.

## 3) YTYP (archetypes / definitions)

### What this provides

YTYP files define **archetypes** (what an entity “is”), including bounding boxes, drawables, and metadata needed to resolve YMAP entity placements into renderable models/collisions.
Without this step you can parse placements, but you can’t reliably resolve which model/texture to load for each placed entity.

### Checklist

- [ ] **Bulk extract all `.ytyp` files**
  - **Owner**:
  - **Outputs**: `output/ytyp/raw/**/*.ytyp`
  - **Verify**: count > 0

- [ ] **Parse YTYP → archetypes JSON**
  - **Owner**:
  - **Outputs**: `output/ytyp/archetypes/<ytyp_name>.json`
  - **Fields** (minimum):
    - archetype name/hash
    - drawable dict name/hash
    - bounds (bbMin/bbMax)
    - flags (if present)
  - **Verify**: sample archetype referenced by a YMAP entity resolves to a YTYP entry.

- [ ] **Resolve YMAP entity archetypes using YTYP exports**
  - **Owner**:
  - **Inputs**:
    - `output/ymap/entities/**/*.json`
    - `output/ytyp/archetypes/**/*.json`
  - **Outputs**:
    - `output/world/archetype_index.json`
    - `output/world/archetype_missing.json`
  - **Command**:
    - `python3 scripts/resolve_ymap_archetypes.py --ymap-entities output/ymap/entities --ytyp-archetypes output/ytyp/archetypes --outdir output/world`
  - **Expect**:
    - `archetype_index.json` has many resolved entries
    - `archetype_missing.json` highlights what still needs additional YTYP coverage

### Implementation (Linux, reproducible)

- **Command**:
  - `python3 extract_ytyp_linux.py --game-path <GTA_ROOT> --output-dir output`
- **Expect**:
  - extracted YTYPs under `output/ytyp/raw/<rpf_name>/**/*.ytyp`
  - JSON exports under `output/ytyp/archetypes/<rpf_name>/**/*.json`

### Verification

- **Count**:
  - `find output/ytyp/raw -type f -name "*.ytyp" | wc -l`
  - Expect: > 0
- **Spot check** (JSON is readable):
  - `python3 -c 'import json,glob; p=sorted(glob.glob("output/ytyp/archetypes/**/*.json", recursive=True))[0]; print(p); j=json.load(open(p)); print(len(j.get("archetypes",[])))'`
  - Expect: prints a file path and a non-negative archetype count

## 4) Models (YDR/YDD/YFT) and drawables

### What this provides

- `YDR`: drawable (static model)
- `YDD`: drawable dictionary (collections)
- `YFT`: fragments (vehicles, breakables)

### Checklist

- [ ] **Bulk extract all `.ydr`, `.ydd`, `.yft` files**
  - **Owner**:
  - **Outputs**: `output/models/raw/**/*.{ydr,ydd,yft}`
  - **Verify**:
    - count > 0 for each type
    - spot-check a few files (first 4 bytes / magic) look sane (`YDR`, `YDD`, `YFT` depending on type)

- [ ] **Build a “referenced models” set from placements (YMAP → YTYP → drawable)**
  - **Owner**:
  - **Inputs**:
    - `output/ymap/entities/**/*.json`
    - `output/ytyp/archetypes/**/*.json`
  - **Outputs**:
    - `output/models/references/models_referenced.json` containing (minimum):
      - `archetypeName/hash → { drawableName/hash?, drawableDictName/hash? }`
      - de-duplicated lists: `ydr[]`, `ydd[]`, `yft[]` (names/hashes as available)
  - **Verify**:
    - sample a few YMAP entities and confirm their archetype resolves to a drawable/drawableDict entry

- [ ] **Generate a raw file index (for deterministic lookup)**
  - **Owner**:
  - **Goal**: deterministic mapping from `{type,name/hash}` → `output/models/raw/...` path(s)
  - **Outputs**:
    - `output/models/index.json` (or `output/models/index.ndjson`) with, per entry:
      - `type` (`ydr|ydd|yft`)
      - `name` (if known) and/or `hash` (Jenkins)
      - `source_rpf` (optional but useful)
      - `raw_path`
      - `byte_size`
  - **Verify**:
    - lookups for a handful of referenced drawables succeed (no “not found”)
    - index is stable between runs

- [ ] **Parse YDR/YDD/YFT → lightweight metadata (bounds, LODs, materials, texture refs)**
  - **Owner**:
  - **Outputs**:
    - `output/models/meta/**/*.json` (one per model), minimum fields:
      - `type`, `name/hash`, `bounds`
      - `lods[]` (if present): `level`, `distance`, `vertexCount`, `indexCount`
      - `materials[]`: `materialName/hash`, `shaderHash`, `params` (as available)
      - `textures[]`: referenced texture name/hash (do *not* inline large binary payloads)
  - **Verify**:
    - metadata JSON loads and has expected counts (`num_meshes`, `num_materials`)
    - for a sample model, reported bounds roughly match CodeWalker’s UI bounds (when available)

- [ ] **Resolve texture dependencies (model → YTD/GTXD → decoded PNGs)**
  - **Owner**:
  - **Inputs**:
    - `output/models/meta/**/*.json`
    - `output/textures/raw/**/*.{ytd,gtxd}`
    - `output/textures/png/**/*.png` (once decoding exists)
  - **Outputs**:
    - `output/models/references/textures_referenced.json` (unique list)
    - `output/models/references/missing_textures.json` (expected empty / shrinking over time)
  - **Verify**:
    - for a small random sample of models, all referenced textures are present and loadable as images

- [ ] **(Optional) Convert models to glTF/GLB** *(future, but needed for “render everything” completeness)*
  - **Owner**:
  - **Outputs**: `output/models/glb/**/*.glb`
  - **Must support (minimum)**:
    - multiple meshes + materials per drawable
    - LOD export strategy (separate GLBs per LOD, or a naming convention like `<name>_lod{n}.glb`)
    - consistent coordinate system + winding order (documented)
    - external texture references (prefer) or embedded textures (optional)
  - **Verify**:
    - glTF validates (gltf-validator)
    - renders in a standalone viewer (and/or our WebGL viewer) with correct basic UVs/material assignment

- [ ] **Decide/record scope for skinned drawables and fragments**
  - **Owner**:
  - **Goal**: avoid silently “half-supporting” content
  - **Outputs**:
    - `output/models/reports/skinned_drawables.json` (models with bones/weights)
    - `output/models/reports/fragments_yft.json` (YFTs encountered + whether used in world)
  - **Verify**:
    - either skinned support exists end-to-end, or these are explicitly excluded with a clear report

### Acceptance criteria (models)

- A random sample of YMAP entities can be resolved end-to-end:
  - `ymap entity → archetype (ytyp) → drawable/drawableDict → raw model bytes → parsed meta → textures`
- “Missing model” rate for sampled placements is low and trending downward as extraction coverage expands.

## 5) Collision (YBN)

### What this provides

YBN files contain collision bounds/meshes used for physics and (optionally) occlusion / navigation.

### Checklist

- [ ] **Bulk extract all `.ybn`**
  - **Owner**:
  - **Status**: supported per-RPF via `CodeWalker.Cli` `--glob` (bulk *across all RPFS* still requires looping over RPFS)
  - **Command** (single RPF):
    - `dotnet CodeWalker.Cli/bin/Release/net8.0/CodeWalker.Cli.dll extract --game <GTA_ROOT> --rpf <GTA_ROOT>/common.rpf --glob "*.ybn" --outdir output/collision/raw --preserve-paths true`
  - **Command** (all RPFS, slower but complete):
    - `find <GTA_ROOT> -type f -name "*.rpf" -print0 | xargs -0 -I{} dotnet CodeWalker.Cli/bin/Release/net8.0/CodeWalker.Cli.dll extract --game <GTA_ROOT> --rpf "{}" --glob "*.ybn" --outdir output/collision/raw --preserve-paths true`
  - **Outputs**: `output/collision/raw/**/*.ybn`
  - **Verify**:
    - `find output/collision/raw -type f -name "*.ybn" | wc -l` is **> 0**
    - spot-check a few files are non-empty: `find output/collision/raw -type f -name "*.ybn" -size +0c | head`

- [ ] **Parse YBN → collision JSON/mesh** *(future)*
  - **Owner**:
  - **Outputs**: `output/collision/parsed/**/*.(json|obj|glb)`
  - **Note**: the viewer currently **does not render collisions**; parsing is for future physics/debug visualization.

## 6) Textures (YTD / GTXD)

### What this provides

- `YTD`: texture dictionaries (DDS-like)
- `GTXD`: texture parent dictionaries / streaming variants

### Checklist

- [ ] **Bulk extract all `.ytd` and `.gtxd`**
  - **Owner**:
  - **Outputs**: `output/textures/raw/**/*.{ytd,gtxd}`
  - **Notes**:
    - Raw extraction can be done via a “list+extract” CLI pass (recommended) or CodeWalker UI bulk export.
    - The viewer currently consumes **decoded PNGs**; it does not read `.ytd/.gtxd` directly.

- [ ] **Decode textures to PNG (diffuse/normal/etc.)** *(future)*
  - **Owner**:
  - **Outputs**: `output/textures/png/**/*.png`
  - **Naming convention (viewer-friendly)**:
    - Prefer `"<base>_diffuse.png"`, `"<base>_normal.png"` (and keep any extra suffixes like `_height_diffuse.png` as-is).
    - Viewer fetches files by name under `webgl_viewer_old/assets/textures/` (see `webgl_viewer_old/js/main.js` + `webgl_viewer_old/js/terrain_renderer.js`).
  - **Implementation hook that already exists**:
    - `gta5_modules/rpf_reader.py` has `RpfReader.get_texture()` which uses CodeWalker `DDSIO.GetPixels(...)` to decode a YTD entry to pixels.
  - **Implemented (Linux)**:
    - `python3 extract_textures_png_linux.py --game-path <GTA_ROOT> --output-dir output`
    - Optional filters for iteration:
      - `--filter "<substring>"`
      - `--max-files 50`
      - `--include-gtxd`
  - **Verify**:
    - pick 1–3 textures referenced by the viewer (e.g. one `*_diffuse.png` + one `*_normal.png`) and confirm they render (no 404s in devtools).
    - confirm normals are interpreted as normal maps (visually: lighting changes with view/light direction).

## 7) Worldmap/minimap (optional but useful)

- [ ] **Extract worldmap textures**
  - **Owner**:
  - **Script**: `python3 extract_worldmap.py --game-path <gta_root>`
  - **Outputs**: `output/worldmap/*.png` (ex: `worldmap.png`, `worldmap_heist.png` if present)
  - **Notes**:
    - Implemented using the bundled `CodeWalker.Cli` to extract PNGs directly from RPF on Linux.
  - **Verify**:
    - `file output/worldmap/worldmap.png` reports PNG and image opens
    - run `python3 webgl_viewer_old/setup_assets.py` and confirm `webgl_viewer_old/assets/worldmap/` contains the copied PNG(s)

- [ ] **Extract minimap/radar tiles** *(future)*
  - **Owner**:
  - **Goal**: get the in-game radar/minimap imagery as a stitched image or tile pyramid for the viewer overlay.
  - **Outputs (suggested)**:
    - `output/minimap/tiles/z{z}/x{x}_y{y}.png` (tile pyramid) **or**
    - `output/minimap/minimap_full.png` (stitched debug image)
  - **Verify**:
    - basic stitch/tile set matches expected coastline + city layout when compared to `worldmap.png`

## 8) Indexes / provenance / reproducibility

### Checklist

- [ ] **Write a manifest of inputs**
  - **Owner**:
  - **Outputs**: `output/meta/inputs.json` including:
    - GTA root path
    - list of RPFS scanned + file sizes + mtimes/hashes
    - tool versions (dotnet, python)

- [ ] **Write a manifest of outputs**
  - **Owner**:
  - **Outputs**: `output/meta/outputs.json` including:
    - counts per type (`ymap_count`, `ytyp_count`, etc.)
    - total bytes per folder

## 9) Viewer validation (sanity)

- [ ] **Sync assets into viewer**
  - `python3 webgl_viewer_old/setup_assets.py`

- [ ] **Run viewer on Linux**
  - `cd webgl_viewer_old && rm -rf node_modules package-lock.json && npm install && npm run dev -- --host 0.0.0.0 --port 5173 --strictPort`

- [ ] **Open from Windows DOM**
  - `http://<linux_server_ip>:5173`

## Ownership suggestions (parallelization)

- **RPF/CLI team**: list/find/batch extraction + performance
- **Terrain team**: heightmap correctness + mesh LODs
- **Placement team**: YMAP entity extraction + tiling
- **Archetype team**: YTYP parsing + resolution
- **Model team**: YDR/YDD/YFT extraction + conversion
- **Texture team**: YTD/GTXD decode + material mapping
- **Data engineering**: manifests, caching, reproducibility, CI checks


