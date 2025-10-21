# Terrain Extraction Guide

This guide explains how to extract and visualize the GTA 5 terrain map using our direct CodeWalker integration approach.

## Prerequisites

Before you begin, make sure you have:

1. Python 3.7 or higher installed
2. .NET Framework 4.8 or higher installed
3. CodeWalker source code downloaded (see [Direct CodeWalker Integration](../DIRECT_CODEWALKER_INTEGRATION.md))
4. Required Python packages installed:
   ```
   pip install -r requirements.txt
   ```

## Setup Environment Variables

Create or update your `.env` file with the following variables:

```
gta_location="C:\Path\To\GTA5"
codewalker_map="Path\To\CodeWalker-master"
```

Replace the paths with the actual paths on your system.

## Compile CodeWalker Files

Before extracting the terrain, you need to compile the necessary CodeWalker files:

```bash
python compile_codewalker.py
```

This will:
1. Read the necessary C# files from the CodeWalker source code
2. Compile them into a DLL using Python.NET
3. Update your `.env` file with the path to the compiled DLL

## Extract and View Terrain

Once the CodeWalker files are compiled, you can extract and view the terrain:

```bash
python gta5_terrain_extractor.py
```

Or use the provided batch/shell scripts:

```bash
# Windows
extract_terrain.bat

# Linux/macOS
./extract_terrain.sh
```

## Command Line Options

The terrain extractor supports several command line options:

```
python gta5_terrain_extractor.py [options]
```

Options:
- `--game-path PATH`: Path to GTA 5 game directory (overrides .env)
- `--output-dir DIR`: Directory to save output files (default: output)
- `--no-plot`: Disable terrain visualization
- `--export-obj`: Export terrain as OBJ file
- `--export-data FORMAT`: Export terrain data in specified format (numpy, csv, json, all)
- `--debug`: Enable debug mode
- `--quiet`: Reduce output verbosity

## Example Usage

Extract terrain and export as OBJ file:

```bash
python gta5_terrain_extractor.py --export-obj
```

Extract terrain and export data in all formats:

```bash
python gta5_terrain_extractor.py --export-data all
```

## Viewing the Terrain

After extraction, you can find the visualization in the output directory:
- Terrain maps as PNG images
- 3D models as OBJ files (if `--export-obj` was specified)
- Terrain data files (if `--export-data` was specified)

You can open the OBJ files in any 3D modeling software like Blender or MeshLab.

## Troubleshooting

If you encounter issues:

1. Check that your paths in the `.env` file are correct
2. Make sure you have the required .NET Framework installed
3. Verify that the CodeWalker source code is complete
4. Run with `--debug` flag for more detailed logs

If you see compilation errors, you may need to update the list of required files in `compile_codewalker.py`. 