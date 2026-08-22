# 4000 Demo Release Pipeline

The active 4000 x 4000 world is centered at `(186.94, -850.84)` and has bounds
`(-1813.06, -2850.84)` through `(2186.94, 1149.16)`. A valid release currently
contains 369,162 instances in 288 entity chunks and 26 MLO roots.

## Required gates

1. Build and merge the world into a dedicated asset stage. Never replace the
   active `assets/demo` directory while building.
2. Compress textures with every source release passed through repeatable
   `--source-assets-dir` arguments. Inherited `demo/models_textures_v2/*`
   references must be materialized into the new stage, even when the source is
   another release root.
3. Run `audit_spawn_district_texture_compression.py`, then independently compare
   every compressed manifest path with the physical output directory. Both
   missing counts must be zero.
4. Build the spawn bootstrap pack with repeatable `--source-models-dir` and
   `--source-demo-dir` arguments so inherited loose meshes and mesh packs can be
   resolved without copying historical trees.
5. Regenerate `spawn_district_fragment_children.json` for the expanded
   destructible manifest. The 4000 world has 162 destructible parent archetypes;
   the current export produces 109 renderable profiles and 677 child meshes.
6. Refresh MLO coverage with `upgrade_mlo_runtime_metadata.py --report-only`.
7. Build the thin overlay with:

   ```powershell
   python tools\build_demo_deployment.py `
     --assets-dir .mlo_repair_20260818\assets `
     --output .deploy_4000_20260818 `
     --world-only
   ```

8. Require `deployment_manifest.json` to report `missing: []`, then run:

   ```powershell
   python tools\validate_demo_release.py `
     .deploy_4000_20260818\dist\assets `
     --world-overlay
   ```

## Remote layout

The live client entrypoint is always `dist-thin/bundled/main-live.js`. Do not
create numbered, named, or cache-revision variants of that file, and do not add
query-string revisions to its script URL. Before replacing it, keep rollback
copies outside `dist-thin` so production exposes exactly one `main-live*.js`.
JavaScript responses are served with revalidation headers so the canonical URL
does not require cache-busting names.

`build_demo_deployment.py` emits `dist/assets`, `dist/bundled`, and
`dist/index.html`. `DEMO_DIST_ROOT` points at the directory that directly owns
`assets`, `bundled`, and `index.html`. Therefore merge the contents of the
generated `dist/` directory into the release root, not the deployment wrapper:

```bash
cp -al dist-thin dist-thin-4000-YYYYMMDD
rsync -a .release_stage/dist/ dist-thin-4000-YYYYMMDD/
python3 validate_demo_release.py \
  dist-thin-4000-YYYYMMDD/assets \
  --fallback-assets-dir assets
```

Only switch `DEMO_DIST_ROOT` after remote validation exits zero. Verify the live
HTTP descriptor reports size 4000, 369,162 instances, the bootstrap manifest,
26 MLO roots, and `collision/compiled/layers.json`. Range-check at least one
entity chunk, compressed texture, collision manifest, and ped animation asset.

## Current release

- Remote root: `dist-thin-4000-20260818`
- Manifest: `demo/spawn_district_models_bootstrap_v1.json`
- Texture paths: 32,358 physical files for 32,358 manifest paths
- Runtime missing texture paths: 0
- Source-authored null texture bindings represented by diagnostics: 74
- Invalid mesh-pack ranges: 0
- Runtime loose mesh references: 0

The 74 diagnostic textures are not missing files. They represent explicit null
bindings in custom source materials and are recorded in the compression audit.
