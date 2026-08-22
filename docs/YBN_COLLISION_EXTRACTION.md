# Browser YBN collision extraction

## Regression fixed on 2026-08-16

The browser tile exporter previously accepted only polygons whose `VertexIndices`
array had exactly three entries. That preserved `BoundPolygonTriangle`, but silently
dropped GTA-authored collision represented by:

- `BoundPolygonBox`
- `BoundPolygonCapsule`
- `BoundPolygonCylinder`
- `BoundPolygonSphere`

For the 520 m demo tile, the corrected exporter retains all 214,596 previous authored
triangles and adds 920,514 tessellated primitive faces. The resulting manifest records
source polygon counts, emitted triangle counts, skipped YBNs, and unsupported shapes.
Do not remove those fields: `test_collision_world.mjs` uses them to fail a triangle-only
regression.

The packed grid uses 8 m cells. Original GTA triangles remain in the ground index for
behavioral compatibility. Newly generated steep primitive faces are indexed only as
walls, which avoids multiplying every ground query by the complete wall set.

## Required verification

Run these checks after changing the exporter or collision runtime:

```powershell
python webgl_viewer/tools/test_ybn_collision_export.py
node webgl_viewer/tools/test_collision_world.mjs
python webgl_viewer/tools/audit_ybn_collision_tile.py webgl_viewer/assets/collision/ybn_spawn.json
node webgl_viewer/tools/benchmark_collision_tile.mjs webgl_viewer/assets/collision/ybn_spawn.json
```

When replacing an existing tile, also pass the old metadata with `--baseline`. A valid
base-GTA rebuild must report `baselineMissingInCandidate: 0`.

## FiveM resource rule

FiveM YBN files replace base assets by case-insensitive JOAAT filename hash and can also
depend on YMAP entity placement. Do not merge an enabled server YBN into the base demo
tile unless the matching FiveM YMAP/YDR/YTYP visual assets are imported and rendered.
Collision-only replacement creates invisible walls or removes roads that are still
visible. Use `audit_ybn_collision_sources.py --names-only` to inspect replacement hashes
before enabling a resource directory.
