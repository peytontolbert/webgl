# Player spawnpoints from CodeWalker (for FiveM-style spawning)

GTA V base `.ymap` files **do not** contain a dedicated “player spawnpoint list” like FiveM’s `spawnpoint` map directive.

So the practical approach is:

- choose a **marker prop** (an entity archetype) that you will treat as “this is a spawnpoint”
- place one or more of those marker entities in **CodeWalker** at the desired location + facing
- export those entities from the YMAP JSON and convert their rotation into a FiveM heading

This repo supports that with `extract_ymaps.py --spawn-archetype ...`.

---

## Workflow

### 1) Pick a marker archetype

Pick any prop/archetype name you can easily search for later (example: `prop_box_wood03a`).

You can use multiple archetypes by repeating `--spawn-archetype`.

### 2) Place markers in CodeWalker

- Open the `.ymap` you’re editing (often a custom map YMAP you ship with your project).
- Add an entity using your marker archetype.
- Position it where the player should spawn.
- Rotate it so its **forward direction** matches the desired spawn facing.

### 3) Export spawnpoints from the YMAP entities

Run the extractor with your marker archetype:

```bash
python3 /data/webglgta/webgl-gta/extract_ymaps.py \
  --game-path /data/webglgta/webgl-gta/gtav \
  --output-dir /data/webglgta/webgl-gta/output \
  --filter "my_custom_map" \
  --spawn-archetype "prop_box_wood03a" \
  --spawn-out /data/webglgta/webgl-gta/output/ymap/player_spawnpoints.json
```

Output:

- `output/ymap/player_spawnpoints.json` contains:
  - `{x,y,z,heading}` (heading is derived from the entity quaternion)
  - references back to `{ymap, entityIndex, guid, archetypeName}` for traceability

---

## Notes / gotchas

- **Heading convention**: this exporter computes heading the way FiveM expects: \(0^\circ\) facing +Y (north), \(90^\circ\) facing +X (east).
- **Why markers?**: without markers, “player spawn” is purely a server/gameplay concept, not something the base map files define.


