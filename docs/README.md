# GTA 5 Terrain Extractor Documentation

This directory contains documentation for the GTA 5 Terrain Extractor project, which leverages CodeWalker to extract and visualize terrain data from GTA 5.

## Documentation Files

- [CodeWalker Capabilities](codewalker_capabilities.md): Detailed overview of CodeWalker's capabilities for GTA 5 file handling and terrain extraction.
- [Integration Strategy](integration_strategy.md): Strategy for integrating CodeWalker with our Python application.
- [Heightmap Format](heightmap_format.md): Detailed explanation of the GTA 5 heightmap file format.
- [Python Implementation](python_implementation.md): Implementation details of our Python application.
- [Terrain Extraction Guide](terrain_extraction_guide.md): Step-by-step guide for extracting and visualizing GTA 5 terrain.
- [Example Usage](example_usage.md): Examples of how to use the terrain extractor in various scenarios.
- [Next Steps](next_steps.md): Roadmap for future enhancements to the terrain extractor.

## WebGL viewer (models + textures) docs

This repo also contains a WebGL viewer and a set of CodeWalker-backed export/repair tools. Key docs:

- [WebGL Viewer Pipeline Repair Guide](PIPELINE_REPAIR_GUIDE_WEBGL_VIEWER.md): single source of truth for getting to **zero placeholder textures** and parity-critical export steps.
- [Texture Pipeline Review](texture_pipeline_review.md): deeper review of naming/indexing, common failure modes, and runtime behavior.
- [Texture naming contract (hash-only vs hash+slug)](../webgl_viewer/TEXTURE_NAMING_AND_DISCREPANCIES.md): canonical filename/index contract enforced by the viewer.

## Quick Start

To get started with the GTA 5 Terrain Extractor, follow these steps:

1. Install the required dependencies:
   ```
   pip install -r requirements.txt
   ```

2. Set up your environment variables in a `.env` file:
   ```
   gta_location="C:\Path\To\GTA5"
   codewalker_map="Path\To\CodeWalker-master"
   ```

3. Compile the necessary CodeWalker files:
   ```
   python compile_codewalker.py
   ```

4. Run the terrain extractor:
   ```
   python gta5_terrain_extractor.py --export-obj
   ```

   Or use the batch file:
   ```
   extract_terrain.bat
   ```

For detailed instructions, see the [Terrain Extraction Guide](terrain_extraction_guide.md).

## Implementation Approach

Our implementation follows a modular architecture with the following components:

1. **CodeWalker Integration Layer**: Interfaces with CodeWalker to access GTA 5 files
2. **Terrain Extraction Module**: Processes heightmap data to generate terrain meshes
3. **Visualization Module**: Visualizes the terrain using matplotlib
4. **Export Module**: Exports the terrain as OBJ files for use in 3D modeling software

We recommend the Python.NET integration approach for the best performance and functionality, but we also provide fallback options if needed.

## Contributing

If you'd like to contribute to this project, please read the [Next Steps](next_steps.md) document for information on the implementation roadmap and technical challenges.

## License

This project is for educational purposes only. All GTA 5 game data is the property of Rockstar Games. 