# NexusAI character appearance contract

The FiveM selector and character designer are separate resources:

- `resources/[nx]/nx-mod-multicharacter` selects or creates a character and owns the preview/spawn flow.
- `resources/[local]/illenium-appearance` owns character appearance editing and persistence.
- New characters enter the appearance flow through `nx-clothes:client:CreateFirstCharacter`.

Do not port the FiveM NUI or Lua runtime into the browser. Use its saved appearance data as the contract and render the equivalent components with browser-native code.

## Illenium component slots

| ID | Browser label | GTA drawable prefix |
|---:|---|---|
| 0 | Head | `head` |
| 1 | Mask | `berd` |
| 2 | Hair | `hair` |
| 3 | Upper body | `uppr` |
| 4 | Lower body | `lowr` |
| 5 | Bags | `hand` |
| 6 | Shoes | `feet` |
| 7 | Accessories | `teef` |
| 8 | Shirt | `accs` |
| 9 | Body armor | `task` |
| 10 | Decals | `decl` |
| 11 | Jacket | `jbib` |

Illenium prop slots are hats `0`, glasses `1`, ears `2`, watches `6`, and bracelets `7`. Props, head blend, face features, overlays, and tattoos are part of the server schema but are not rendered by the browser editor yet.

## Browser data flow

1. `assets/runtime_characters.json` contains imported NexusAI appearance profiles.
2. `tools/export_runtime_character_catalog.py` deduplicates their component signatures and invokes `export_runtime_ped_skinning.py`.
3. The exporter writes skinned mesh entries into `assets/models/manifest.json`.
4. `assets/character_component_catalog.json` exposes only drawables that exist in that manifest.
5. The editor updates the live component mesh and produces an Illenium-compatible JSON payload containing `model`, `components`, `props`, and `hair`.

Regenerate after importing new server appearance rows:

```powershell
python tools/export_runtime_character_catalog.py --game-path "K:\steam\steamapps\common\Grand Theft Auto V"
npm.cmd exec vite -- build --emptyOutDir=false
python sync_assets_to_dist.py
```

Never offer a drawable merely because it appears in the database. Clothing-pack or unresolved DLC assets may not exist in the exported manifest. The generated catalog is the browser renderer's source of truth.

## Complete base freemode catalog

The browser creator opens from **Ped > Design character**. The full base male freemode export contains:

- 192 drawable choices across component slots 0 through 11.
- 1,323 drawable/texture combinations.
- Texture-specific virtual manifest assets that reuse skinned geometry while selecting the correct GTA diffuse.

Regenerate this complete set with one bounded GTA cache pass:

```powershell
python tools/export_runtime_character_catalog.py --full-base-catalog --spins 30 --game-path "K:\steam\steamapps\common\Grand Theft Auto V"
```

The Heritage, Face, Overlays, and Props tabs maintain an Illenium-compatible appearance payload. Clothing and texture changes are rendered live. Head-blend morphs, facial morphs, overlay compositing, tattoos, and attached prop models require additional renderer paths before those values can affect the visible ped.

GTA Online DLC clothing is not the same namespace as the base PedFile table. DLC packs reuse names such as `jbib_000_u` and require pack-qualified identities and FiveM-style collection-index ordering. Do not merge those files by drawable-name hash; doing so silently replaces one pack with another.

Import the remote `clothingpack5m` and `nx-mod-chains` contracts without copying their multi-gigabyte stream directories:

```powershell
python tools/import_fivem_appearance_contracts.py --remote peyton@192.168.0.85 --fivem-root /data/NexusAI/fivem_server
```

This writes `assets/fivem_appearance_contracts.json` with the full YDD/YTD inventory and each chain item's component-7 drawable/texture mapping. Entries remain marked `requires_ydd_ytd_conversion` until their collection-qualified meshes and textures have been exported into the browser manifest; the appearance UI must not offer unresolved entries.

## Hair rendering

Freemode hair texture `0` is a shader mask, not display-ready RGB. Its red and green channels select highlight and primary dye regions. Rendering that texture with the generic diffuse path produces bright green hair.

The catalog generator marks only component `2`, texture `0` materials with `pedHairTint`. The player shader converts those channels using the Illenium `hair.color` and `hair.highlight` values. Texture alternatives `1+` are baked colors and bypass this mask conversion. All hair materials use cutout alpha, alpha-to-coverage, and double-sided cards for stable strand edges.
