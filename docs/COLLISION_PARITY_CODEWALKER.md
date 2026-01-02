## CodeWalker collision parity notes (vs GTA5 client)

This repo’s “GTA-like ground” is currently implemented by **offline baking** a heightmap using CodeWalker’s collision raycasts:

- Python: `webgl/bake_collision_heightmap.py` calls `DllManager.raycast_down(...)`
- C#: `DllManager.raycast_down` calls `CodeWalker.World.Space.RayIntersect(...)`

This is **not** full GTA5 physics, but it is the closest collision query we have access to from CodeWalker.

---

## What `Space.RayIntersect` actually tests

In `CodeWalker.Core/World/Space.cs`, `Space.RayIntersect` does:

1) **BoundsStore (YBN collision)**
   - It gathers candidate `BoundsStoreItem`s from a spatial store: `BoundsStore.GetItems(ref ray, layers)`
   - For each candidate, it loads the corresponding `YbnFile` and ray-intersects its `Bounds`:
     - `ybn.Bounds.RayIntersect(ref ray, res.HitDist)`
   - This is the closest analog to “world collision” in GTA.

2) **MapDataStore (HD ymap entity collision)**
   - It gathers candidate HD ymap nodes: `MapDataStore.GetItems(ref ray)`
   - It only tests **HD ymaps**: `(mapdata.ContentFlags & 1) != 0`
   - For each entity in the ymap, if `EntityCollisionsEnabled(ent)`:
     - It ray-tests the entity’s drawable bounds (YDR/YFT bound) in entity-local space.
     - If `ent.IsMlo`, it routes into `RayIntersectInterior` which tests the interior archetype’s YBN and then interior entities.

The result type includes:
- `HitYbn` when the hit came from YBN collision
- `HitEntity` when the hit came from entity bounds
- `Normal`, `Material`, polygon refs, etc.

---

## Layer filtering (YBN “exterior layers”)

`BoundsStore.GetItems(..., layers)` supports a `bool[] layers` filter.

In `SpaceBoundsStoreNode.GetItems`, items are skipped with:

- `if ((layers != null) && (item.Layer < 3) && (!layers[item.Layer])) continue;`

So CodeWalker expects up to **3 layer indices (0..2)** for this filter.

In our Python wrapper (`DllManager.raycast_down`) we currently pass:
- `layers = [True, False, False]`

Meaning: “prefer exterior collision layer 0 only”.

---

## How our current bake matches GTA “ground”

`DllManager.raycast_down(..., ybn_only=True)` post-filters the result:
- If the ray hit only an entity (HD ymap entity bounds) and did **not** hit YBN, we treat it as “no hit”.

This is intentional: for a “ground heightmap”, we usually want the walkable ground (terrain + roads + static collision)
and we don’t want props/bridges/roof entities to overwrite ground height.

---

## What’s still NOT GTA parity

Even with CodeWalker raycasts, the WebGL viewer does **not** have:

- Continuous physics integration (capsule, gravity, stepping)
- Character controller logic (stairs, slope limits, ledge handling)
- Real-time collision resolution; we only sample a heightfield
- Water surface queries (no water intersection in `Space.cs` ray logic)
- Gameplay navmesh rules (YNV) used for ped placement/path validity (though CodeWalker can load YNVs)

So the best parity we can reach right now is:
- “Where is the collision surface below me?” (via bake or runtime raycast)
- Not “simulate a GTA ped walking with physics.”

---

## Additional “ground-adjacent” datasets in CodeWalker (not in `Space.RayIntersect`)

### Water surface (waterheight.dat + water.xml)

CodeWalker has a separate water system:
- `World/Water.cs` loads `water.xml` quads (rects with a `z` height)
- `World/Watermaps.cs` loads `common.rpf\\data\\levels\\gta5\\waterheight.dat` (`WatermapFile`) which contains a grid of water heights (lakes/rivers/pools)

`Space.RayIntersect` does **not** intersect water, so “GTA-like ground” should be treated as:
- collision surface from YBN (and optionally HD entities), plus
- water surface if you care about swimming/boats/spawn filtering

This repo adds a water export helper:
- `webgl/bake_water_heightmap.py` → `webgl/output/water_heightmap.png` + `water_mask.png`


