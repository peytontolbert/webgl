# Earth “Street-Level” Wrapper (Fully Custom) — Design Doc

This doc specifies a **fully custom** “Earth mode” wrapper for this repo’s `webgl_viewer` so we can:

- **Zoom out** to globe-scale navigation
- **Zoom in** to street level
- **Play** at character/vehicle/aircraft level using open data (Overture + OpenStreetMap + DEM)

It is intentionally written to support incremental rollout **without modifying existing functioning viewer code** (except additive, guarded hooks for the wrapper integration).

---

## Goals

- **Street-level gameplay**: a character can walk on “ground” with buildings around them.
- **Global reach**: you can move anywhere on Earth (teleport, then later continuous travel).
- **Streaming**: load/unload terrain + vector data around the player/camera.
- **Performance-first**: predictable memory, bounded network, worker offload where possible.
- **Open data**: build cities from footprints + roads + landcover (non-photoreal is OK).

## Non-goals (v1)

- Photorealistic 3D city meshes (Google Earth style photogrammetry). Those are generally **licensed**, not open.
- Full-fidelity physics engine, traffic simulation, or pathfinding.
- Perfect globe edge-case coverage on day 1 (poles/dateline). We design for them, implement later.

---

## How it fits this repo (integration contract)

We already have a minimal “dataset wrapper” in the viewer:

- `assets/datasets/manifest.json`: dataset registry
- `js/external_dataset_manager.js`: loads dataset JSON
- `js/external_dataset_renderer.js`: renders a simple overlay
- `index.html`: “External datasets” UI section
- `js/main.js`: guarded enable/disable + load-by-id logic

**The Earth wrapper should plug in via the same manifest concept**, but it will eventually become its own “mode” (because it needs terrain meshes, imagery, collision, and a different coordinate system than GTA data-space).

### Design principle

- Keep existing GTA viewer paths intact.
- Earth wrapper lives in **new modules** (example namespace `js/earth/*`) and is invoked via a **single guarded entry point**.

---

## Data sources (open / practical)

### Vector (cities)

- **Buildings**:
  - **Overture Maps** buildings footprint polygons
  - **OpenStreetMap** buildings (fallback / augmentation)
- **Roads / highways / paths**:
  - **OpenStreetMap** ways (primary)
  - Overture where available (optional)
- **Landuse/natural/water**:
  - OpenStreetMap tags (forest/water/park/etc)

### Terrain (mountains)

- **Copernicus DEM** / **SRTM** / **NASADEM** (global DEM sources)
- We generate **terrain mesh tiles** + a fast **height query** per tile.

### Imagery

Optional, and license-sensitive. For v1 gameplay we can ship:

- **Stylized ground material** driven by landcover + slope + water masks, OR
- A user-configurable imagery provider (not guaranteed open globally).

---

## Coordinate systems (the core of “custom globe”)

We use two coordinate frames:

### 1) Global frame: ECEF (Earth-Centered, Earth-Fixed)

- 3D Cartesian, meters.
- Used for:
  - global camera/orbit navigation
  - computing local tangent frames anywhere on Earth
  - robust “move anywhere” math

### 2) Local gameplay frame: ENU (East-North-Up) tangent plane + Floating Origin

At street-level we do gameplay in a local flat frame centered near the player:

- Origin = a geodetic anchor point \((lat_0, lon_0, h_0)\)
- Axes:
  - +X = East, +Y = North, +Z = Up (meters)
- **Floating origin**:
  - When player drifts too far (e.g. > 5–20 km), we shift the origin so the player stays near \((0,0,0)\).
  - This keeps rendering precision stable in WebGL float math.

### Required conversion functions

We need small, deterministic math utilities:

- `geodeticToECEF(lat, lon, h)`
- `ecefToGeodetic(x, y, z)` (may be approximate initially)
- `ecefToENU(ecef, originGeodetic)`
- `enuToECEF(enu, originGeodetic)`

Implementation note: we can start with WGS84 approximations; refine later if needed.

---

## Tiling scheme (the streaming backbone)

We need a tile pyramid that works globally and aligns vector + raster + terrain.

### Option (recommended): WebMercator XYZ (EPSG:3857)

- Tiles addressed by `(z, x, y)` like standard web tiles.
- Advantages:
  - easy to reason about
  - huge ecosystem
  - simple caching keys
- Caveat:
  - distortion near poles; we clamp practical latitude range.

### What each tile contains

For a given `(z,x,y)` tile:

- **Vector buildings**: polygon rings + height metadata
- **Vector roads**: polylines + class metadata
- **Terrain**: DEM samples (or prebuilt mesh + height query)
- Optional: imagery or landcover raster masks

### Local coordinates for a tile

Tiles are stored in a global projection (WebMercator meters) or lat/lon, but **rendered** in ENU:

- At runtime:
  - choose origin near player
  - convert feature coordinates → ENU meters
  - build meshes in local coords

---

## Rendering layers (street-level)

### Buildings (v1)

- Build meshes from footprints:
  - walls extruded from polygon edges
  - flat roof (triangulated polygon)
- Height source priority:
  - OSM `height`, `building:levels` (× ~3m)
  - Overture height fields if present
  - fallback heuristic based on building type / footprint area

### Roads (v1)

Render initially as:

- simple polylines (debug)
- then wide strips (triangulated) with per-class color

Roads are also a critical gameplay artifact:

- used to decide “ground type” (asphalt vs grass)
- used later for vehicle navigation

### Terrain (v1)

- Start with:
  - flat ground at `z=0` in local ENU (fastest to playable)
- Then:
  - heightmap tiles → mesh tiles
  - height query for collision (character stands on terrain)

### Atmosphere / sky

Existing viewer already has a sky pass; Earth wrapper can reuse the concept but should keep its implementation separate.

---

## Streaming architecture

### Runtime responsibilities

An `EarthWorldStreamer` (new module) manages:

- a **tile set** around the player/camera (ring radius in tiles)
- per-tile state machine:
  - `unloaded → loading → ready → evicting`
- bounded concurrency + request prioritization

### Caching

- Memory cache:
  - geometry buffers per tile
  - decoded vector features per tile
- Optional persistent cache:
  - browser Cache Storage / IndexedDB keyed by `z/x/y + layer + version`

### Worker offload

To stay smooth at street-level:

- decode + parse vector tiles in a Worker
- triangulate/extrude in a Worker (transfer typed arrays back)

This repo already uses Worker patterns; Earth wrapper should follow the same “best-effort + fallback” approach.

---

## Gameplay (walking/driving/flying) — minimal technical needs

### Character controller (v1)

- Capsule/point collision vs:
  - terrain height query
  - optional building AABBs (coarse)
- Gravity along local “up” (+Z in ENU).

### Vehicles (later)

Same coordinate system, but needs:

- road surface classification
- better collision meshes

### Flying (later)

Simpler: just needs camera/controls and streaming farther.

---

## Edge cases (design now, implement later)

- **Dateline**: tiles wrap in longitude; `x` wraps at each zoom.
- **Poles**: WebMercator approaches infinity; clamp latitude to ~85° and treat higher lat separately later.
- **Precision**: always render in ENU with floating origin; never render directly in ECEF.

---

## Proposed directory layout (additive)

- `webgl_viewer/js/earth/`
  - `coords_wgs84.js` (ECEF/ENU conversions)
  - `tile_math.js` (XYZ ↔ lat/lon bounds)
  - `earth_streamer.js` (tile streaming, caching)
  - `earth_buildings.js` (footprint extrusion)
  - `earth_roads.js` (polyline → strip)
  - `earth_terrain.js` (DEM → mesh + height query)
  - `earth_renderer.js` (draw passes)
- `webgl_viewer/assets/earth/`
  - `tiles/...` (local baked tiles for dev)

We can keep the existing `assets/datasets/manifest.json` as a lightweight selector, but Earth wrapper will likely use its own manifest for multi-layer tiles.

---

## Milestones (to “play” quickly)

### M0: Local “city patch” (no globe)

- Choose a city center lat/lon.
- Convert a small building dataset to local ENU.
- Render buildings + flat ground + walk controller.

### M1: Tile streaming (still local)

- Implement `(z,x,y)` tile ring around player.
- Stream building tiles + evict behind player.

### M2: Terrain tiles

- Add DEM mesh tiles + height query for walking.

### M3: Globe navigation (custom)

- Add global orbit camera in ECEF.
- On zoom-in: choose anchor and handoff to ENU gameplay.

This keeps “playable” progress visible while the globe work continues.

---

## Notes on licensing

OpenStreetMap is typically **ODbL**; Overture has its own license terms. The wrapper should:

- treat raw data as input
- generate derived “game tiles” with clear attribution metadata
- keep a `tiles_version.json` to track source + transform pipeline

---

## Open questions (need answers before implementation)

- Target runtime: browser-only, or later native?
- Visual goal: stylized ground vs imagery?
- Patch size at street-level: 2 km / 20 km / 200 km?
- Minimum gameplay for v1: walking only, or driving too?


