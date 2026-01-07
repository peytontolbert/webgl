## DRY refactor guide (repo scripts)

Goal: reduce duplicated helper logic across Python scripts **without changing behavior**.

### Non-negotiable rules
- **Do not remove functionality**: keep every CLI flag, default, and output field stable.
- **Preserve special cases**: if a script has a “weird” branch (e.g. `patchday27ng` handling, MLO exclusions), keep it.
- **Refactor via wrappers first**: replace duplicated helpers with thin wrappers that delegate to shared utilities. Only delete the wrapper if no external callers rely on it.
- **Prefer additive changes**: add shared modules, then migrate scripts gradually.
- **Validate after each batch**:
  - run the script with a small scope (e.g. `--chunk-limit`, `--top`, `--limit`) and confirm output shape is unchanged
  - run `verify_entities_index.py` and `verify_export_vs_codewalker.py` on a real assets dir when touching entity coverage code

### Shared modules (source of truth)

#### `gta5_modules/script_paths.py`
- **`auto_assets_dir(explicit_assets_dir: str) -> Path`**
- Use this anywhere a script accepts `--assets-dir`.

#### `gta5_modules/hash_utils.py`
- **`as_u32_int(x) -> Optional[int]`**
- **`as_u32_str(x) -> Optional[str]`**
- **`try_coerce_u32(x, *, allow_hex=True) -> Optional[int]`**
- **`coerce_u32(x, *, allow_hex=True, default=0) -> int`**
- **`joaat(s: str, *, lower: bool=False) -> int`**

Important: historically some scripts lowercased before joaat and others didn’t. The `lower` flag exists to preserve behavior. Do not “fix” casing silently.

#### `gta5_modules/archetype_utils.py`
- **`normalize_archetype_to_hash_str(obj: dict) -> Optional[str]`**

This centralizes the repo’s “entity row → archetype hash” join logic.

#### `gta5_modules/entity_coverage.py`
Entity/chunk/YMAP coverage primitives:
- `load_entities_index`
- `iter_chunk_rows`
- `iter_jsonl_objects`, `iter_entity_objects`
- `norm_ymap_path_like_codewalker`
- `cw_active_ymap_count_all_plus_patchday27ng`

This module also exports `auto_assets_dir` for backwards compatibility, but new code should prefer `script_paths.auto_assets_dir`.

#### `gta5_modules/manifest_utils.py`
- **`load_or_init_models_manifest(models_dir: Path, *, min_version: int = 4) -> (Path, dict)`**

Centralizes the repo’s models `manifest.json` init/repair logic (version floor + meshes dict).

#### `gta5_modules/texture_naming.py`
Mirror viewer texture resolution logic (keep tooling and runtime in sync):
- `normalize_asset_rel(rel: str) -> str`
- `iter_texture_candidate_rels_like_viewer(rel: str, *, base_index_entry=None, pack_entries=None) -> list[str]`

#### `gta5_modules/codewalker_archetypes.py`
- **`get_archetype_best_effort(gfc, archetype_hash_u32, *, dll_manager=None, also_scan_dlc_levels=None)`**

Centralizes robust archetype resolution:
- normal `gfc.GetArchetype`
- optional DLC-level scans (eg `patchday27ng`)
- best-effort recovery from YTYP parsing skips (“ytyp file was not in meta format”)

#### `gta5_modules/cw_loaders.py`
Centralizes the common CodeWalker “pump until loaded” patterns:
- `ensure_loaded(gfc, gf, *, max_loops=...) -> bool`
- `try_get_drawable(gfc, arch, *, spins=...) -> Any`
- `try_get_ytd(gfc, txd_hash_u32, *, spins=...) -> Any`
- `try_loadfile(gfc, gf) -> None`

Migration rule: keep script-local helpers as wrappers (same name/signature), but delegate to these functions.

#### `gta5_modules/dlc_paths.py`
Centralizes DLC-pack inference from CodeWalker entry paths (avoids subtle drift across tools):
- `infer_dlc_pack_from_entry_path(path_or_name: str) -> str`
- `get_rpf_entry_path_or_namelower(entry) -> str`

### Migration playbook
- **Step 1**: Identify duplicated helper(s) in N scripts (assets dir, joaat, u32 parsing, JSONL iteration).
- **Step 2**: Add or extend a shared module with the exact same behavior (including edge cases).
- **Step 3**: Update each script to import the shared helper.
  - If the script previously had a local helper, keep its name as a wrapper that calls the shared function.
- **Step 4**: Run lints and a small “smoke run” of each modified script.

### Recommended “coverage” pipeline commands
- **Fast integrity**:

```bash
python3 webgl-gta/verify_entities_index.py --assets-dir webgl-gta/webgl_viewer/assets
python3 webgl-gta/verify_export_vs_codewalker.py --game-path /data/webglgta/gta5/ --assets-dir webgl-gta/webgl_viewer/assets
```

- **Staging script**:

```bash
GTA_PATH=/data/webglgta/gta5/ ./webgl-gta/scripts/linux_export_and_setup_assets.sh
```


