# Remote Walmart MLO import

The isolated importer is deployed at:

`/data/NexusAI/webglgta-demo/importer`

It does not write to the live demo unless an agent explicitly chooses the live
asset directory. Use a staging output directory first.

## Installed inputs

- FiveM resource: `/data/NexusAI/fivem_server/resources/[gamemodes]/[maps]/Walmart/stream`
- Python importer: `webgl_viewer/tools/import_fivem_mlo_demo.py`
- Preflight: `webgl_viewer/tools/preflight_fivem_mlo_import.py`
- Python GTA readers: `gta5_modules/`
- CodeWalker Python assemblies: `compiled_cw/`
- Portable metadata exporter: `CodeWalker.Cli/bin/Release/net8.0/CodeWalker.Cli.dll`
- Isolated Python packages: `python-packages/`
- Generated metadata: `work/walmart-mlo-metadata.json`

The metadata export currently resolves one root at `(69.274155, -1776.3516,
28.290794)`, 236 children, two rooms, and one portal. Five child archetypes are
not packaged by the Walmart resource and must be resolved from base GTA:
`754220966`, `1914837387`, `2583440873`, `2634576006`, and `3640564381`.

## Remaining host prerequisite

Mount or copy a legally installed GTA V data directory to a stable remote path,
for example `/data/NexusAI/gta5`. It must contain at least `GTA5.exe`,
`common.rpf`, `update/update.rpf`, and the normal `x64*.rpf` archives. The
existing `/data/qwenvl/gta` directory is video data and is not a GTA install.

## Commands

Set these variables in the agent shell:

```bash
export IMPORTER=/data/NexusAI/webglgta-demo/importer
export RESOURCE='/data/NexusAI/fivem_server/resources/[gamemodes]/[maps]/Walmart/stream'
export GTA5_PATH=/data/NexusAI/gta5
export PYTHONPATH="$IMPORTER/python-packages"
export PYTHONNET_RUNTIME=coreclr
```

Run preflight before importing:

```bash
python3 "$IMPORTER/webgl_viewer/tools/preflight_fivem_mlo_import.py" \
  --resource-dir "$RESOURCE" \
  --game-path "$GTA5_PATH" \
  --output-dir "$IMPORTER/work/walmart"
```

Regenerate room, portal, and child-transform metadata when the resource changes:

```bash
dotnet "$IMPORTER/CodeWalker.Cli/bin/Release/net8.0/CodeWalker.Cli.dll" \
  export-mlo-metadata \
  --resource-dir "$RESOURCE" \
  --ymap "$RESOURCE/MilosWalmart_milo.ymap" \
  --output "$IMPORTER/work/walmart-mlo-metadata.json"
```

Import into a copy of the browser assets, not the live deployment:

```bash
python3 "$IMPORTER/webgl_viewer/tools/import_fivem_mlo_demo.py" \
  --game-path "$GTA5_PATH" \
  --resource-dir "$RESOURCE" \
  --metadata "$IMPORTER/work/walmart-mlo-metadata.json" \
  --assets-dir "$IMPORTER/work/walmart/assets" \
  --root-position 69.274155,-1776.3516
```

The staging asset directory must first contain the base demo descriptor,
instance file, and model manifest selected for the target district. Pass
`--base-descriptor`, `--base-instance-file`, and `--base-manifest-file` when
those are not the defaults. Validate the staged result before deploying or
merging it into `dist-thin`.
