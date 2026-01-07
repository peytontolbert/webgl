# Open Data Sources (No API Key) — for Earth Street-Level Wrapper

This doc lists **practical, no-API-key** data sources for building a “GTA-on-Earth” experience (zoom out → zoom in → walk/drive/fly) using a **fully custom** pipeline described in `EARTH_STREETLEVEL_WRAPPER_DESIGN.md`.

The goal is: **downloadable datasets** (HTTP/S3), **self-hostable tiles**, and **clear licensing**.

---

## 0) Reality check (what “no key” implies)

- You can absolutely build **cities + roads + terrain** without any API keys.
- “No key” usually means:
  - **bigger downloads** (regional extracts, not on-demand query APIs),
  - you build your own **tile pyramid** + caching,
  - you host tiles locally or from your own server/CDN.
- Truly photoreal “Google Earth” imagery/3D meshes are typically **not open**.

---

## 1) Roads / sidewalks / paths / highways (vector)

### OpenStreetMap (OSM)

OSM is the canonical global “world graph”:

- **Roads**: `highway=*`, `lanes=*`, `maxspeed=*`, `bridge=*`, `tunnel=*`, `oneway=*`
- **Footpaths/sidewalks**: `footway=*`, `sidewalk=*`, `surface=*`, `incline=*`
- **Buildings** (also here): `building=*`, `height=*`, `building:levels=*`, roof tags

**No-key download options**

- **Geofabrik regional extracts** (recommended for starting):
  - Download `.osm.pbf` for a country/state/city region.
  - Pros: manageable size, updated regularly.
  - Use-case: your “first city” prototype.
- **In this repo**: use `tools/download_osm_extract.py` to preview size (HEAD) and download safely.
- **Sanity-check extracts**: use `tools/osm_quick_check.py` to verify file size and (if `osmium-tool` is installed) print bounding box + basic filtered counts.
- **Planet PBF** (huge; not recommended until the pipeline is proven):
  - Global `.osm.pbf` is tens of GB compressed and much larger when processed.

**We should treat OSM as**: a *source dataset* we preprocess into our own tile format (vector tiles or custom binary).

---

## 2) Buildings (footprints → 3D extrusion)

### Overture Maps — Buildings (and other layers)

Overture provides global-ish building footprints with useful metadata.

**No-key access**

- Overture releases are typically distributed via **public cloud object storage** (often AWS Open Data style).
- Download the release files (commonly GeoParquet / Parquet) and preprocess offline.

Use-case:

- Primary building layer for “full city coverage”
- Merge/augment with OSM where OSM is better locally

### Microsoft Building Footprints

Massive footprint coverage; great for “lots of buildings” quickly.

**No-key access**

- Provided as downloadable dataset packages (often hosted via Microsoft/Cloud public links).

Use-case:

- Fill-in footprints where Overture/OSM coverage is sparse.

**Important**: footprints alone aren’t “3D”. We still need:

- heights (OSM tags, Overture fields, heuristics, or LiDAR-based correction later)
- mesh generation (extrusion + roof triangulation)

---

## 3) Terrain / mountains (elevation)

### Global baseline DEM (planet-scale)

Start with a coarse global DEM for far-LOD / flight:

- **Copernicus DEM** (GLO-30 / GLO-90)
- **SRTM / NASADEM** (global-ish, older but practical)

**No-key access**

- Many of these are mirrored via **open data portals** and/or **public S3 buckets**.

### High-resolution terrain (regional / local realism)

- **USGS 3DEP** (US; 1m/3m DEM and LiDAR coverage)
- **OpenTopography** (LiDAR/DEMs for many regions)

**Caveat**

- Some portals allow direct downloads without API keys, but may require manual selection / an account for large areas.
- For v1, prefer “download tiles for a specific city region” rather than trying to ingest everything.

What we store in our pipeline:

- far LOD: low-res DEM tiles
- near LOD: higher-res DEM (and later LiDAR-derived meshes where available)

---

## 4) Landcover / biomes / “what type of ground is this?”

### ESA WorldCover (10m)

Useful for:

- ground material selection (urban/forest/water/crops)
- movement modifiers (later)

**No-key access**

- Downloadable global tiles; preprocess into our own masks.

---

## 5) Imagery (optional; licensing varies)

If we want “real-ish ground textures” without keys:

- **Sentinel-2** (10m/20m multispectral)
  - global, frequent, not super sharp at street-level
- **NAIP** (US, ~0.6m)
  - great for US-only prototypes

**No-key access**

- Both are commonly available via **open data S3** or downloadable archives.

**Recommendation for gameplay v1**

- Don’t block on imagery. Use stylized ground shading + landcover first.
  - It avoids licensing pitfalls and reduces bandwidth.

---

## 6) “Street-level” imagery (for future photogrammetry / splats)

Optional and heavy:

- **Panoramax** (open StreetView-like initiative; self-hostable)
- **KartaView** (crowdsourced street photos)

These can support:

- photogrammetry / NeRF / Gaussian splats (future)

But they are not required for:

- walkable/drivable city built from footprints + roads + DEM.

---

## 7) Recommended minimal stack for our custom wrapper (fastest to playable)

To get to “walk around buildings” with no API keys:

1) **Pick one city** (small bounding box).
2) **OSM extract** (Geofabrik) → roads + some buildings.
3) **Overture buildings** for the same region (if available) → denser footprints.
4) **DEM tiles** for the region (Copernicus/SRTM) → terrain height + mesh.
5) (Optional) **ESA WorldCover** → ground types.

Then build our own:

- vector/mesh tiles keyed by `(z,x,y)`
- local ENU conversion + floating origin
- collision from terrain height query (v1)

---

## 8) Suggested preprocessing + tile outputs (what we should generate)

### Vector tiles (roads/buildings/landuse)

Input:

- OSM `.pbf`
- Overture GeoParquet/Parquet

Output (choose one):

- **MVT (Mapbox Vector Tile) `.pbf` tiles**: standard, great tooling, compact
- **Custom binary tiles**: fastest runtime, but we must build tooling

### Terrain tiles

Input:

- DEM rasters (GeoTIFF)

Output:

- height tiles (quantized) + optional normal maps
- mesh tiles (optional) or runtime tessellation

### Buildings mesh tiles

Input:

- footprint polygons + height

Output:

- per-tile mesh buffers (positions/normals/indices) + metadata

---

## 9) Attribution & licensing (don’t skip)

We need a `tiles_version.json` (or similar) for every generated tile set:

- source(s): OSM, Overture, Copernicus, etc.
- source version/date
- processing pipeline version/hash
- required attribution text

---

## 10) Next decision to unblock implementation

For a first playable prototype:

- Choose **one target city** and a bounding box.
- Choose **flat ground vs DEM** for v1 (DEM adds complexity, but makes walking feel real).

Once decided, we can implement a deterministic “download → preprocess → tile → stream” path.


