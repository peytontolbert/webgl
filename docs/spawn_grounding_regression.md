# Browser Spawn Grounding Regression

## Required coordinate contract

The FiveM/NexusAI persisted player `z` is the authoritative ped root elevation at
spawn. Do not reinterpret it as an eye position or replace it with a coarse GTA
heightmap sample.

The browser keeps an eye/aim position internally:

```text
feet/root Z = ped.posData[2] - pedEyeHeightData
eye Z       = feet/root Z + pedEyeHeightData
```

`spawnPedAt()` therefore receives `root Z + pedEyeHeightData`. The camera targets
the eye position, while collision and mesh foot placement use the root position.

## August 2026 failure

At the NexusAI spawn `(186.94, -850.84)`:

```text
FiveM saved root Z       31.17
raw exported YBN floor   30.17
difference                1.00
```

The character initially spawned from the correct FiveM coordinate, but the first
movement-controller update snapped the root down to the lower YBN layer. This put
the character below the rendered road.

The fix aligns the loaded YBN tile to the known FiveM spawn surface:

```text
YBN alignment offset = saved FiveM root Z - raw YBN Z
aligned YBN Z         = raw YBN Z + alignment offset
```

The offset is derived at runtime by
`CollisionWorld.alignYbnToKnownSurface()` and is accepted only when its absolute
value is at most 5 GTA units. It is not a hardcoded vertical nudge.

## Heightmap warning

GTA `heightmap.dat` contains coarse `MinHeights` and `MaxHeights` envelopes. It is
not the street collision surface. At this spawn the observed samples were:

```text
MinHeights  26.41
MaxHeights  47.11
road/root   31.17
```

Neither envelope is suitable for placing a ped on this road. Streamed drawables
render the road, the FiveM root establishes the initial surface, and aligned YBN
triangles drive gameplay collision.

The upper-envelope export uses the cache-distinct files
`heightmap_max_u16.json` and `heightmap_max_u16.bin`. Reusing the old asset name
can make the browser cache serve the previous lower-envelope binary.

When its debug mesh is enabled, the viewer applies a visual-only Z offset that
aligns the raw envelope sample with the authoritative FiveM root at spawn. At the
known spawn this is `31.17 - 47.11 = -15.94`. This transform does not alter raw
height diagnostics, YBN collision, or gameplay coordinates. The proxy remains
coarse and should not be treated as road geometry away from its alignment anchor.

## Live diagnostic signature

The grounding HUD must show all inputs. The known-good spawn reads approximately:

```text
Z savedRoot=31.17
heightmap=47.11
YBN raw=30.17 aligned=31.17 offset=1.00
selectedFloor=31.17
finalEye=32.37
```

A regression is present if `selectedFloor` becomes raw YBN `30.17`, either
heightmap envelope is selected as the floor, or `savedRoot` changes to `30.17`.

## Files and ownership

- `webgl_viewer/js/main.js`: derives alignment before applying a runtime spawn,
  preserves the root/eye contract, and renders the diagnostic HUD.
- `webgl_viewer/js/gameplay/collision_world.js`: queries raw YBN, derives the
  bounded alignment, and applies it to gameplay collision results.
- `webgl_viewer/js/gameplay/player_controller.js`: moves against aligned collision
  and retains raw/aligned values in diagnostics.
- `webgl_viewer/tools/export_gta_heightmap.py`: exports `MaxHeights` for the
  optional coarse proxy, not ped collision.

## Regression check

1. Start the viewer and clean-reload `http://127.0.0.1:5173/`.
2. Wait for the character and nearby streamed world assets to load.
3. Confirm the HUD matches the known-good signature above.
4. Confirm the character's feet are visually on top of the rendered road.
5. Move in several directions and confirm there is no snap to raw YBN height.
6. Run syntax checks and the production build:

```powershell
node --check webgl_viewer/js/main.js
node --check webgl_viewer/js/gameplay/collision_world.js
node --check webgl_viewer/js/gameplay/player_controller.js
Set-Location webgl_viewer
npm.cmd exec vite -- build --emptyOutDir=false
```

Do not mark this issue fixed from coordinates alone. The final acceptance check is
the loaded character standing on the visible streamed road.
