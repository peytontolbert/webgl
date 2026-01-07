# Generated docs

This folder contains auto-generated reports.

## Movement asset index

Generate:

```bash
python3 scripts/generate_movement_asset_index.py --gta5-path /data/webglgta/webgl-gta/gtav
```

Output:
- `docs/generated/movement-asset-index.md`

## Ped control mapping (movement/strafe clipsets, anim dict, task datasets)

Generate:

```bash
python3 scripts/generate_ped_control_mapping.py --gta5-path /data/webglgta/webgl-gta/gtav
```

Output:
- `docs/generated/ped-control-mapping.md`
- `docs/generated/ped-control-mapping.json`

## AI control bundle (player ped locomotion + candidate assets to export)

Generate:

```bash
python3 scripts/generate_ai_control_bundle.py --gta5-path /data/webglgta/webgl-gta/gtav
```

Output:
- `output/ai/control_bundle.json`


