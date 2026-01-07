# GTA 5 Terrain Extractor

A Python application to extract and visualize the terrain geometry of the GTA 5 map from FiveM client data, leveraging CodeWalker's capabilities.

## Features

- Extracts heightmap data from GTA 5 game files
- Visualizes the terrain in 3D using matplotlib
- Exports terrain as OBJ files for use in 3D modeling software
- Works with both standard GTA 5 and FiveM installations
- Leverages CodeWalker for efficient file parsing

## Requirements

- Python 3.7 or higher
- GTA 5 or FiveM client installation
- Required Python packages (see requirements.txt)
- .NET Framework 4.5 or higher (for CodeWalker integration)

## Installation

1. Clone this repository or download the source code
2. Install the required dependencies:

```bash
pip install -r requirements.txt
```

## Usage

Run the script with the path to your GTA 5 or FiveM installation:

```bash
python gta5_terrain_extractor.py --game-path "C:\Path\To\GTA5"
```

Or use the environment variable in the `.env` file:

```bash
python gta5_terrain_extractor.py
```

### Linux: wrappers for export + hosted viewer

This repo includes Linux-friendly wrapper scripts under `webgl-gta/scripts/`.
They default your GTA root to **`/data/webglgta/gta5`** (see `env.local`) and can be overridden via env vars.

- **Export + setup viewer assets**:

```bash
cd webgl-gta
./scripts/linux_export_and_setup_assets.sh
```

- **Full export (models + textures + materials/shader fields)**:

```bash
cd webgl-gta
./scripts/linux_full_export_models_textures_materials.sh
```

- **Build + preview viewer (hosting-friendly)**:

```bash
cd webgl-gta
WEBGL_VIEWER_HOST=0.0.0.0 WEBGL_VIEWER_PORT=4173 ./scripts/linux_viewer_build_preview.sh
```

### Command Line Arguments

- `--game-path`: Path to GTA 5 or FiveM game directory (overrides .env)
- `--output-dir`: Directory to save output files (default: "output")
- `--no-plot`: Disable terrain visualization
- `--export-obj`: Export terrain as OBJ file
- `--debug`: Enable debug mode

### Examples

Extract and visualize terrain:
```bash
python gta5_terrain_extractor.py --game-path "C:\Program Files\FiveM\FiveM.app\data"
```

Extract terrain and export as OBJ:
```bash
python gta5_terrain_extractor.py --game-path "C:\Program Files\FiveM\FiveM.app\data" --export-obj
```

## How It Works

The application leverages CodeWalker's capabilities to read and process GTA 5 files, particularly heightmap data. It follows a modular architecture with the following components:

1. **CodeWalker Integration Layer**: Interfaces with CodeWalker to access GTA 5 files
2. **Terrain Extraction Module**: Processes heightmap data to generate terrain meshes
3. **Visualization Module**: Visualizes the terrain using matplotlib
4. **Export Module**: Exports the terrain as OBJ files for use in 3D modeling software

For more details on the implementation, see the [documentation](docs/README.md).

### WebGL viewer pipeline + texture parity docs

If you're debugging “placeholder textures”, missing model texture exports, or CodeWalker parity issues, start here:

- `webgl-gta/docs/PIPELINE_REPAIR_GUIDE_WEBGL_VIEWER.md`
- `webgl-gta/docs/texture_pipeline_review.md`
- `webgl-gta/webgl_viewer/TEXTURE_NAMING_AND_DISCREPANCIES.md`

## File Locations

The application looks for heightmap files in the following locations:

### Standard GTA 5 Installation
- `common.rpf/data/levels/gta5/heightmap.dat`
- `update/update.rpf/common/data/levels/gta5/heightmap.dat`
- `update/update.rpf/common/data/levels/gta5/heightmapheistisland.dat`

### FiveM Installation
- `citizen/common/data/levels/gta5/heightmap.dat`
- `citizen/dlc_patchday2ng/common/data/levels/gta5/heightmap.dat`

## Output

The application generates the following output:
- 3D terrain visualizations as PNG images
- OBJ files containing the terrain mesh (if `--export-obj` is specified)

## Documentation

Detailed documentation is available in the [docs](docs) directory:

- [CodeWalker Capabilities](docs/codewalker_capabilities.md): Overview of CodeWalker's capabilities
- [Integration Strategy](docs/integration_strategy.md): Strategy for integrating CodeWalker with Python
- [Heightmap Format](docs/heightmap_format.md): Details of the GTA 5 heightmap file format
- [Python Implementation](docs/python_implementation.md): Implementation details
- [Next Steps](docs/next_steps.md): Roadmap for future development

## Limitations

- The application currently only extracts terrain heightmap data, not other map elements like buildings, roads, etc.
- Full YMAP parsing is not implemented, which would be needed for complete map extraction
- The terrain resolution is limited by the resolution of the heightmap files

## Future Improvements

- Implement Python.NET integration for direct access to CodeWalker functionality
- Add support for extracting other map elements (buildings, roads, etc.)
- Implement full YMAP parsing for entity placements
- Add texture mapping to the exported terrain
- Support for exporting to other 3D formats (FBX, GLTF, etc.)

## License

This project is for educational purposes only. All GTA 5 game data is the property of Rockstar Games.

## Acknowledgements

This project was inspired by the CodeWalker tool by dexyfex, which provides a comprehensive way to explore GTA 5 game files.
