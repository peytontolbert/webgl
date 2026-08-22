# Nordschleife track integration

## Current deliverable

The demo supports a locally generated, drivable Nordschleife road package and
a separate full-detail visual scene for **Full Detail** LOD. The circuit is
placed east of the GTA demo district; the derived road remains the authoritative
vehicle/ped contact layer.

The full-detail scene is built from every **renderable** static KN5 in the
union of the four official Nordschleife layouts: 18 visual sectors from 22
layout entries, 251 material groups and 298 deduplicated WebP maps (630
material-map references). The remaining four entries (`6.kn5`, `120.kn5`,
`19.kn5`, `25.kn5`) contain only Assetto physics/audio-helper triangles and
are deliberately excluded from visual rendering. The scene retains source
normals, UVs, diffuse/normal/detail/mask/layer maps, and all ten components of
each authored KN5 material property. The principal circuit sector retains
float positions; the other 17 sectors retain 16-bit affine positions and are
not geometry-parity output yet. The WebGL renderer maps the
Kunos multilayer road shader's base/detailed blend, per-layer UV scales,
detail-normal scale, alpha-derived specular, Fresnel, and ambient/diffuse/
specular/emissive controls. This is a high-fidelity browser adaptation, not a
claim that every Assetto Corsa render pass (weather, shadows, reflections, CSP
extensions) is reproduced.

| Property | Current package |
| --- | --- |
| Source | Local `nordschleife/ai/fast_lane.ai` + `data/surfaces.ini` |
| Spacing | 3 m, 6,900 centerline samples / 6,899 road segments (closed loop) |
| Road width | 10 m |
| Storage | 82,844-byte `road.nrb`, uint16 affine-quantized positions, implicit strip indices |
| Surface | `asph-nurb`, grip `0.98` from local `surfaces.ini` |
| Placement | East of the GTA district; package bounds are `x=4879.78..11007.97`, `y=-5621.81..-799.92` |
| Full-detail visual source | Official layout union: 18 renderable KN5 sectors of 22 entries, 7,293,680 triangles |
| Full-detail material coverage | 251 groups, 298 texture files, 630 resolved map references |
| Geometry precision | `ks_nordschleife.kn5` is TNM3 float-position; 17 supporting sectors are TNM2 uint16-affine quantized |

Use `/track` in game chat (aliases: `/nurburgring` and `/nordschleife`), or open
Settings and choose **Drive to Nurburgring**. When already seated in a vehicle
it moves that vehicle; otherwise it moves the player. The runtime also exposes
`window.__viewerNurburgring.teleport()` and `.bounds()` for diagnostics.

## Visual-parity audit: 2026-08-18

Run the read-only audit with:

```powershell
python tools/audit_nurburgring_visual_parity.py `
  --track-root "K:\steam\steamapps\common\assettocorsa\content\tracks\ks_nordschleife" `
  --scene-dir webgl_viewer\assets\tracks\nordschleife\scene_full_v2
```

It establishes that every static source with renderable triangles is present:
18 browser sectors from 22 official static entries. The four static omissions
are physics/audio only. There are remaining visual-parity gaps:

- `118.kn5` and `119.kn5` are renderable dynamic balloon models (1,388
  triangles each), omitted because Assetto randomly spawns them at runtime.
- All used source sample references are embedded and every source channel is
  packed, but the WebGL shader does not consume `txNormalDetail` or
  `txVariation` (nine used material slots each).
- The browser uses one generic material program for 17 Kunos shader families;
  it does not reproduce the engine's reflection, weather, shadow, or
  post-process passes.
- Most support sectors retain 16-bit affine position quantization. Their
  approximately 11 cm horizontal precision over the full package bounds is
  insufficient for exact painted-line and kerb geometry.

The source geometry and ordinary maps are materially covered, but this is not
one-to-one visual parity. Float-position export for every visual sector and
implementation of the two already-packed material channels are the first
quality fixes; dynamic balloons and full engine render passes are separate
features.

## Why the previous import could not work

| Failure | Evidence | Resolution now / next |
| --- | --- | --- |
| Only one model was exported | `assetto_corsa_track_export.py` defaults to the largest root KN5. | Use the selected layout list, not a largest-file heuristic. |
| Layout was ignored | Nordschleife is defined by `models_nordschleife.ini`, which references 12 static KN5 files. | Build a layout manifest stage before any visual export. |
| No usable demo collision | The old output was a SceneTool GLB; the demo uses a spatial collision world. | The road package loads a sparse collision grid from the same ribbon shown on screen. |
| Unbounded scale | The static track source is roughly 0.8 GB before OBJ/GLB expansion. | Quantized road is 82.8 KB; full scenery must be tiled/streamed. |
| Unsafe placement | The initial road origin overlapped the GTA district. | Package is translated east; the demo movement bounds are expanded as a union. |
| Physics mismatch | The prior car path did not consume tyre/suspension/torque data in the demo solver. | Derived vehicle profile and diagnostics now exist; dedicated per-wheel solver remains required for parity. |

## Regenerate locally

Use only the authorized local installation and keep the output local until its
distribution/deployment policy is reviewed:

```powershell
python tools/assetto_nurburgring_road_compiler.py `
  --ai "K:\steam\steamapps\common\assettocorsa\content\tracks\ks_nordschleife\nordschleife\ai\fast_lane.ai" `
  --surfaces "K:\steam\steamapps\common\assettocorsa\content\tracks\ks_nordschleife\nordschleife\data\surfaces.ini" `
  --out-dir webgl_viewer/assets/tracks/nordschleife `
  --place-x 7000 --place-y -850 --place-z 32

cd webgl_viewer
python sync_assets_to_dist.py --only tracks/nordschleife
```

`--only` deliberately copies only the three local package files to `dist`; it
does not trigger the project's broad asset sync.

## Collision contract

`CollisionWorld.loadDerivedRoad()` decodes the `NRB1` package, builds a sparse
16 m grid over only occupied road cells, and selects a triangle under each
wheel/ped. It returns source `track`, road material, and grip. GTA YBN remains
loaded and is queried outside the track; the two collision worlds are not
replaced or overlaid.

This first road package has correct driveable surface/elevation collision but
does not yet include physical guardrails, terrain, buildings, trees, pits, or
every kerb. Driving off its ribbon therefore falls back to normal GTA/terrain
behavior. Those are explicit next work items, not hidden parity claims.

## Full visual-track path

1. Parse the official Nordschleife layout union into every renderable static
source model record, including placement transforms. **Done for Full Detail
(18 visual sectors; 4 physics/audio-only sectors intentionally excluded).**
2. Preserve source positions, normals, UVs, material maps and every KN5
material-property component. **Done for Full Detail.**
3. Apply the Kunos multilayer material controls in the browser renderer.
**Done for the opaque/cutout/blended material adaptation.**
4. Add renderable guardrail/wall collision, pit/start triggers, and a
road-to-GTA access connector. **Still pending; the road ribbon remains the
authoritative collision surface.**
5. Add Assetto-equivalent weather, shadow, reflection, and post-process passes
only after parity captures define the desired target. **Still pending.**
