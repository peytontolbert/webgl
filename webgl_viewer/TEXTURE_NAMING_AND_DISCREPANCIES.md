# Texture naming: hash-only vs hash+slug (canonical contract)

This viewer supports two common model-texture filename conventions:

- **Hash-only**: `assets/models_textures/<hash>.png`
- **Hash+slug**: `assets/models_textures/<hash>_<slug>.png`

Where:

- `<hash>` is the **JOAAT** (GTA-style) 32-bit hash of the original texture name (unsigned decimal).
- `<slug>` is a **human-readable** filename suffix for debugging (lowercased + non-alnum -> `_`).

## Why discrepancies happen

There are *two different* ways a material can end up with a texture reference:

### 1) Manifest-provided paths (explicit)

`assets/models/manifest.json` often contains paths like:

- `models_textures/2610349460_nxg_prop_tree_cedar_trunk_dm.png`

This is already a complete relative path. In this repo, the manifest is effectively **100% hash+slug**.

### 2) ShaderParam-derived paths (computed)

Some exporters/materials only populate CodeWalker-style shader parameters:

- `shaderParams.texturesByHash` contains a texture *name* (e.g. `"Prop_LOD"`)

At runtime, the viewer converts that name into a file path by hashing it:

- `joaat("Prop_LOD") -> <hash>`
- then emits `models_textures/<hash>_<slug>.png` (preferred) or `models_textures/<hash>.png`

If the computed naming convention doesn’t match what exists on disk, you get "silent" texture misses
(placeholders, and often suppressed console noise due to 404 negative caching).

## Canonical contract (what we enforce)

### Manifests/materials should prefer **hash+slug**

- Better debugging (you can grep/find what a texture is).
- Compatible with exporters that avoid overwrites/collisions by including the original name.

### Runtime must be robust to both layouts

The runtime URL resolver should:

- When given `models_textures/<hash>_<slug>.png`, try:
  - `models_textures/<hash>.png` first (if present)
  - then the original `models_textures/<hash>_<slug>.png`
- When given `models_textures/<hash>.png`, and that file is missing, it should be able to find
  a slug-variant if one exists.

## The “full fix”: a texture index

To remove ambiguity and avoid repeated 404 probing, we generate an optional index file:

- `assets/models_textures/index.json`

Schema (v1):

```json
{
  "schema": "webglgta-models-textures-index-v1",
  "byHash": {
    "2610349460": {
      "hash": "2610349460",
      "hashOnly": false,
      "preferredFile": "2610349460_nxg_prop_tree_cedar_trunk_dm.png",
      "files": [
        "2610349460_nxg_prop_tree_cedar_trunk_dm.png"
      ]
    }
  }
}
```

Runtime behavior using the index:

- If a caller asks for `models_textures/<hash>.png` but only slug files exist, we immediately pick the
  indexed `preferredFile` and avoid the 404.

## Implementation summary

- **Asset generation** (`setup_assets.py`):
  - copies textures into `assets/models_textures/`
  - generates `assets/models_textures/index.json`

- **Runtime** (`js/texture_path_resolver.js`):
  - lazily loads `assets/models_textures/index.json` (best-effort)
  - centralizes naming normalization + candidate ordering + “skip guaranteed-404” behavior
  - used by renderers (e.g. `js/instanced_model_renderer.js`) so we don’t accumulate one-off patches

- **ShaderParam name→path** (`js/model_manager.js`):
  - when shaderParams provide a texture name, emit `models_textures/<hash>_<slug>.png` so the renderer
    can use its normal fallback logic (hash-only first, then slug).

## Audit / verification (offline)

To prove you’ve eliminated *real* missing-texture cases (and to generate a concrete “export these hashes” list),
run the probe tool which now understands the same candidate/fallback rules as the viewer (including `index.json`):

```bash
python webgl-gta/webgl_viewer/tools/probe_model_textures_like_viewer.py --root webgl-gta/webgl_viewer
```

Key outputs:

- **`MISSING in assets/`**: even after candidate fallback (hash-only vs slugged), nothing was found on disk
- **`MISSING FROM EXPORTED SET (hash not in models_textures/index.json)`**: the definitive “not exported” set


