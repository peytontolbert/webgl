# Python Implementation for GTA 5 Terrain Extraction

## Overview

This document details the implementation of our Python application for extracting and visualizing GTA 5 terrain data. The application leverages CodeWalker's capabilities to read and process GTA 5 files, particularly heightmap data.

## Architecture

The application follows a modular architecture with the following components:

1. **CodeWalker Integration Layer**: Interfaces with CodeWalker to access GTA 5 files
2. **Terrain Extraction Module**: Processes heightmap data to generate terrain meshes
3. **Visualization Module**: Visualizes the terrain using matplotlib or other libraries
4. **Export Module**: Exports the terrain as OBJ files for use in 3D modeling software

### Component Diagram

```
+---------------------+     +---------------------+     +---------------------+
|                     |     |                     |     |                     |
|  CodeWalker         |     |  Terrain            |     |  Visualization      |
|  Integration Layer  +---->+  Extraction Module  +---->+  Module            |
|                     |     |                     |     |                     |
+---------------------+     +---------------------+     +---------------------+
                                      |
                                      v
                            +---------------------+
                            |                     |
                            |  Export             |
                            |  Module             |
                            |                     |
                            +---------------------+
```

## Direct CodeWalker Integration

We've implemented a direct integration approach with CodeWalker that doesn't require building the entire CodeWalker solution. This approach:

1. Extracts only the necessary C# files from the CodeWalker source code
2. Compiles them on-the-fly using Python.NET's ability to interact with the C# compiler
3. Uses the compiled code directly in our Python application

### Implementation Details

The direct integration is implemented in two main components:

1. **compile_codewalker.py**: Compiles the necessary CodeWalker files into a DLL
2. **GTATerrainExtractor class**: Uses the compiled DLL to extract and process terrain data

#### Compilation Process

The compilation process works as follows:

```python
def compile_codewalker_files(codewalker_path, output_dir="./compiled_cw"):
    # Create compiler parameters
    compiler = CodeDomProvider.CreateProvider("CSharp")
    parameters = System.CodeDom.Compiler.CompilerParameters()
    
    # Add references
    parameters.ReferencedAssemblies.Add("System.dll")
    parameters.ReferencedAssemblies.Add("System.Core.dll")
    parameters.ReferencedAssemblies.Add("System.Xml.dll")
    parameters.ReferencedAssemblies.Add("System.Drawing.dll")
    
    # Set output assembly
    output_dll = os.path.join(output_dir, "CodeWalker.Minimal.dll")
    parameters.OutputAssembly = output_dll
    parameters.GenerateExecutable = False
    parameters.GenerateInMemory = False
    
    # Compile
    results = compiler.CompileAssemblyFromSource(parameters, combined_source)
```

#### Integration in the Terrain Extractor

The GTATerrainExtractor class initializes the CodeWalker integration as follows:

```python
def initialize_compiled_codewalker(self):
    """Initialize CodeWalker integration using the compiled DLL"""
    try:
        import clr
        
        # Get compiled DLL path
        dll_path = os.getenv('codewalker_dll')
        
        # Add reference to the compiled DLL
        clr.AddReference(dll_path)
        
        # Import CodeWalker namespaces
        from CodeWalker.GameFiles import RpfManager, HeightmapFile
        
        # Initialize RpfManager
        rpf_manager = RpfManager()
        rpf_manager.Init(str(self.game_path))
        
        # Store the integration objects
        self.codewalker_integration = {
            'rpf_manager': rpf_manager,
            'heightmap_file_class': HeightmapFile
        }
        
        return True
    except Exception as e:
        logger.error(f"Error initializing compiled CodeWalker: {e}")
        return False
```

### Advantages of Direct Integration

This direct integration approach offers several advantages:

1. **Simplified Setup**: No need to build the entire CodeWalker solution
2. **No Visual Studio Required**: Works on any platform with .NET Framework
3. **Minimal Dependencies**: Only includes the necessary CodeWalker components
4. **Easy Customization**: Can modify the CodeWalker code as needed
5. **Smaller Footprint**: Reduced memory and disk usage

### Fallback Mechanisms

If the direct CodeWalker integration fails, the application falls back to:

1. Manual extraction of heightmap files from RPF archives
2. Direct parsing of heightmap files using the HeightmapReader class

This ensures that the application can work even if the CodeWalker integration is not available.

## Implementation Details

### 1. CodeWalker Integration Layer

#### Python.NET Integration

We use Python.NET to directly call CodeWalker's .NET libraries from Python.

```python
# codewalker_integration.py

import clr
import System
import os
from pathlib import Path

class CodeWalkerIntegration:
    def __init__(self, game_path):
        self.game_path = Path(game_path)
        
        # Add references to CodeWalker assemblies
        codewalker_path = os.getenv('codewalker_map')
        if codewalker_path:
            codewalker_path = Path(codewalker_path.strip('"\''))
            
            # Add references to CodeWalker assemblies
            clr.AddReference(str(codewalker_path / 'CodeWalker.Core.dll'))
            clr.AddReference(str(codewalker_path / 'CodeWalker.GameFiles.dll'))
            
            # Import CodeWalker namespaces
            from CodeWalker.GameFiles import RpfManager, HeightmapFile
            from CodeWalker.World import Heightmaps
            
            # Initialize RpfManager
            self.rpf_manager = RpfManager()
            self.rpf_manager.Init(str(self.game_path))
        else:
            raise ValueError("CodeWalker path not found in environment variables")
    
    def get_heightmap_file(self, path):
        """Get a heightmap file from the RPF archives"""
        from CodeWalker.GameFiles import HeightmapFile
        return self.rpf_manager.GetFile[HeightmapFile](path)
    
    def get_heightmap_data(self, heightmap_file):
        """Extract data from a heightmap file"""
        width = heightmap_file.Width
        height = heightmap_file.Height
        bb_min = (heightmap_file.BBMin.X, heightmap_file.BBMin.Y, heightmap_file.BBMin.Z)
        bb_max = (heightmap_file.BBMax.X, heightmap_file.BBMax.Y, heightmap_file.BBMax.Z)
        
        # Convert max_heights and min_heights to Python lists
        max_heights = []
        min_heights = []
        
        for y in range(height):
            for x in range(width):
                index = y * width + x
                max_heights.append(heightmap_file.MaxHeights[index])
                min_heights.append(heightmap_file.MinHeights[index])
        
        return {
            'width': width,
            'height': height,
            'bb_min': bb_min,
            'bb_max': bb_max,
            'max_heights': max_heights,
            'min_heights': min_heights
        }
```

### 2. Terrain Extraction Module

This module processes the heightmap data to generate terrain meshes.

```python
# terrain_extraction.py

import numpy as np
from pathlib import Path

class TerrainExtractor:
    def __init__(self, codewalker_integration):
        self.cw = codewalker_integration
    
    def extract_terrain(self, heightmap_paths):
        """Extract terrain data from heightmap files"""
        terrain_data = []
        
        for path in heightmap_paths:
            try:
                # Get heightmap file from CodeWalker
                heightmap_file = self.cw.get_heightmap_file(path)
                
                # Extract data
                data = self.cw.get_heightmap_data(heightmap_file)
                
                # Convert to numpy arrays
                width = data['width']
                height = data['height']
                max_heights = np.array(data['max_heights']).reshape(height, width)
                min_heights = np.array(data['min_heights']).reshape(height, width)
                
                # Create coordinate grids
                x = np.linspace(data['bb_min'][0], data['bb_max'][0], width)
                y = np.linspace(data['bb_min'][1], data['bb_max'][1], height)
                X, Y = np.meshgrid(x, y)
                
                # Scale height values
                height_scale = (data['bb_max'][2] - data['bb_min'][2]) / 255.0
                Z_max = data['bb_min'][2] + max_heights * height_scale
                Z_min = data['bb_min'][2] + min_heights * height_scale
                
                terrain_data.append({
                    'path': path,
                    'X': X,
                    'Y': Y,
                    'Z_max': Z_max,
                    'Z_min': Z_min,
                    'width': width,
                    'height': height
                })
            except Exception as e:
                print(f"Failed to extract terrain from {path}: {e}")
        
        return terrain_data
```

### 3. Visualization Module

This module visualizes the terrain using matplotlib.

```python
# visualization.py

import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D
from pathlib import Path

class TerrainVisualizer:
    def __init__(self, output_dir=None):
        self.output_dir = Path(output_dir) if output_dir else Path.cwd() / "output"
        self.output_dir.mkdir(exist_ok=True)
    
    def visualize_terrain(self, terrain_data, show_plot=True, save_plot=True):
        """Visualize terrain data"""
        for i, data in enumerate(terrain_data):
            # Create 3D plot
            fig = plt.figure(figsize=(12, 10))
            ax = fig.add_subplot(111, projection='3d')
            
            # Plot the terrain surface
            surf = ax.plot_surface(
                data['X'], data['Y'], data['Z_max'],
                cmap='terrain', alpha=0.8, linewidth=0, antialiased=True
            )
            
            # Add colorbar
            fig.colorbar(surf, ax=ax, shrink=0.5, aspect=5)
            
            # Set labels and title
            ax.set_xlabel('X')
            ax.set_ylabel('Y')
            ax.set_zlabel('Z')
            ax.set_title(f'GTA 5 Terrain - {Path(data["path"]).name}')
            
            # Save the plot
            if save_plot:
                output_file = self.output_dir / f"terrain_map_{i}.png"
                plt.savefig(output_file, dpi=300, bbox_inches='tight')
                print(f"Saved terrain visualization to {output_file}")
            
            # Show the plot
            if show_plot:
                plt.show()
            else:
                plt.close(fig)
```

### 4. Export Module

This module exports the terrain as OBJ files for use in 3D modeling software.

```python
# export.py

from pathlib import Path

class TerrainExporter:
    def __init__(self, output_dir=None):
        self.output_dir = Path(output_dir) if output_dir else Path.cwd() / "output"
        self.output_dir.mkdir(exist_ok=True)
    
    def export_obj(self, terrain_data):
        """Export terrain as OBJ files"""
        for i, data in enumerate(terrain_data):
            # Prepare OBJ file
            output_file = self.output_dir / f"terrain_{i}.obj"
            
            with open(output_file, 'w') as f:
                # Write OBJ header
                f.write(f"# GTA 5 Terrain - {Path(data['path']).name}\n")
                f.write(f"# Generated by GTA5 Terrain Extractor\n")
                f.write(f"# Dimensions: {data['width']}x{data['height']}\n\n")
                
                # Write vertices
                for y in range(data['height']):
                    for x in range(data['width']):
                        f.write(f"v {data['X'][y, x]} {data['Y'][y, x]} {data['Z_max'][y, x]}\n")
                
                f.write("\n")
                
                # Write faces (triangles)
                for y in range(data['height'] - 1):
                    for x in range(data['width'] - 1):
                        # Calculate vertex indices (OBJ indices start at 1)
                        v1 = y * data['width'] + x + 1
                        v2 = y * data['width'] + (x + 1) + 1
                        v3 = (y + 1) * data['width'] + x + 1
                        v4 = (y + 1) * data['width'] + (x + 1) + 1
                        
                        # Write two triangles for each grid cell
                        f.write(f"f {v1} {v2} {v3}\n")
                        f.write(f"f {v3} {v2} {v4}\n")
            
            print(f"Exported terrain to OBJ file: {output_file}")
```

### 5. Main Application

The main application ties all the components together.

```python
# gta5_terrain_extractor.py

import os
import argparse
import logging
import time
import dotenv
from pathlib import Path

# Import modules
from codewalker_integration import CodeWalkerIntegration
from terrain_extraction import TerrainExtractor
from visualization import TerrainVisualizer
from export import TerrainExporter

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Load environment variables
dotenv.load_dotenv()

def main():
    """Main function to run the terrain extractor"""
    parser = argparse.ArgumentParser(description='Extract and visualize GTA 5 terrain data')
    parser.add_argument('--game-path', help='Path to GTA 5 or FiveM game directory (overrides .env)')
    parser.add_argument('--output-dir', default='output', help='Directory to save output files')
    parser.add_argument('--no-plot', action='store_true', help='Disable terrain visualization')
    parser.add_argument('--export-obj', action='store_true', help='Export terrain as OBJ file')
    parser.add_argument('--debug', action='store_true', help='Enable debug mode')
    
    args = parser.parse_args()
    
    # Set debug mode if requested
    if args.debug:
        os.environ['DEBUG'] = 'True'
        logging.getLogger().setLevel(logging.DEBUG)
    
    # Use game path from command line or from .env file
    game_path = args.game_path
    if not game_path:
        game_path = os.getenv('gta_location')
        if not game_path:
            logger.error("Game path not provided and not found in .env file")
            return
        else:
            # Remove quotes if present
            game_path = game_path.strip('"\'')
            logger.info(f"Using game path from .env: {game_path}")
    
    start_time = time.time()
    
    try:
        # Initialize CodeWalker integration
        cw = CodeWalkerIntegration(game_path)
        
        # Define heightmap paths to extract
        heightmap_paths = [
            "common.rpf/data/levels/gta5/heightmap.dat",
            "update/update.rpf/common/data/levels/gta5/heightmap.dat",
            "update/update.rpf/common/data/levels/gta5/heightmapheistisland.dat"
        ]
        
        # Extract terrain data
        extractor = TerrainExtractor(cw)
        terrain_data = extractor.extract_terrain(heightmap_paths)
        
        if terrain_data:
            # Visualize terrain
            if not args.no_plot:
                visualizer = TerrainVisualizer(args.output_dir)
                visualizer.visualize_terrain(terrain_data, show_plot=False)
            
            # Export terrain as OBJ
            if args.export_obj:
                exporter = TerrainExporter(args.output_dir)
                exporter.export_obj(terrain_data)
        else:
            logger.error("No terrain data extracted")
    except Exception as e:
        logger.error(f"Error: {e}")
    
    elapsed_time = time.time() - start_time
    logger.info(f"Terrain extraction completed in {elapsed_time:.2f} seconds")

if __name__ == "__main__":
    main()
```

## Conclusion

By leveraging CodeWalker's capabilities, our Python application can efficiently extract and visualize GTA 5 terrain data. The modular architecture allows for flexibility and extensibility, making it easy to add new features or adapt to changes in the GTA 5 file formats. 