# CodeWalker Integration Strategy

## Overview

This document outlines the strategy for integrating CodeWalker's capabilities with our Python application for extracting and visualizing GTA 5 terrain data. Rather than reimplementing the complex file parsing logic already present in CodeWalker, we'll leverage its existing functionality.

## Integration Approaches

We have several options for integrating CodeWalker with our Python application:

### 1. Python.NET Integration (Recommended)

**Description**: Use Python.NET to directly call CodeWalker's .NET libraries from Python.

**Advantages**:
- Direct access to all CodeWalker functionality
- No need for intermediate file formats
- Efficient data transfer between CodeWalker and Python

**Implementation Steps**:
1. Install Python.NET package (`pip install pythonnet`)
2. Reference CodeWalker assemblies in Python
3. Create Python wrapper classes for key CodeWalker functionality
4. Use these wrapper classes in our terrain extraction application

**Example Code**:
```python
import clr
import System

# Add references to CodeWalker assemblies
clr.AddReference('CodeWalker.Core')
clr.AddReference('CodeWalker.GameFiles')

# Import CodeWalker namespaces
from CodeWalker.GameFiles import RpfManager, HeightmapFile
from CodeWalker.World import Heightmaps

# Create an instance of RpfManager
rpf_manager = RpfManager()
rpf_manager.Init(game_folder_path)

# Load heightmap file
heightmap_file = rpf_manager.GetFile[HeightmapFile]("common.rpf/data/levels/gta5/heightmap.dat")

# Process heightmap data
# ...
```

### 2. Command-Line Interface

**Description**: Create a command-line interface for CodeWalker that can be called from Python.

**Advantages**:
- Simpler integration (no need for Python.NET)
- Can be used with any programming language

**Disadvantages**:
- Less efficient (requires process spawning)
- Limited to functionality exposed through the CLI

**Implementation Steps**:
1. Create a command-line interface for CodeWalker
2. Add commands for terrain extraction
3. Call the CLI from Python using `subprocess`
4. Parse the output in Python

**Example Code**:
```python
import subprocess
import json

# Call CodeWalker CLI to extract heightmap data
result = subprocess.run([
    "CodeWalker.CLI.exe",
    "extract-heightmap",
    "--game-path", game_path,
    "--output-format", "json"
], capture_output=True, text=True)

# Parse the output
heightmap_data = json.loads(result.stdout)

# Process heightmap data
# ...
```

### 3. File-Based Integration

**Description**: Have CodeWalker export data to files that can be read by Python.

**Advantages**:
- Simple integration
- No direct dependency between CodeWalker and Python

**Disadvantages**:
- Requires intermediate file storage
- Less efficient for large data sets

**Implementation Steps**:
1. Modify CodeWalker to export terrain data to a standard format (e.g., OBJ, JSON)
2. Run CodeWalker to export the data
3. Read the exported files in Python
4. Process the data as needed

**Example Code**:
```python
import json
import numpy as np
import matplotlib.pyplot as plt

# Read heightmap data exported by CodeWalker
with open("heightmap_export.json", "r") as f:
    heightmap_data = json.load(f)

# Convert to numpy arrays
width = heightmap_data["width"]
height = heightmap_data["height"]
max_heights = np.array(heightmap_data["max_heights"]).reshape(height, width)

# Visualize the terrain
plt.figure(figsize=(12, 10))
plt.imshow(max_heights, cmap='terrain')
plt.colorbar()
plt.title('GTA 5 Terrain Heightmap')
plt.savefig("terrain_map.png", dpi=300)
```

## Recommended Approach

Based on the analysis of the available options, we recommend the **Python.NET Integration** approach for the following reasons:

1. It provides direct access to all CodeWalker functionality
2. It's more efficient than the other approaches
3. It allows for a more seamless integration between CodeWalker and our Python application

However, implementing this approach requires more upfront work to set up the Python.NET integration and create the necessary wrapper classes.

## Implementation Plan

### Phase 1: Setup Python.NET Integration

1. Add Python.NET to our project dependencies
2. Create a wrapper module for CodeWalker functionality
3. Test basic integration (loading RPF files, accessing heightmap data)

### Phase 2: Implement Terrain Extraction

1. Use CodeWalker's `HeightmapFile` class to read heightmap data
2. Convert the heightmap data to a format usable by our Python application
3. Implement terrain mesh generation using the heightmap data

### Phase 3: Visualization and Export

1. Visualize the terrain using matplotlib or another 3D visualization library
2. Export the terrain as OBJ files for use in 3D modeling software
3. Add options for customizing the visualization and export

## Fallback Strategy

If the Python.NET integration proves too complex or encounters compatibility issues, we'll fall back to the File-Based Integration approach. This will involve:

1. Creating a small C# application that uses CodeWalker to export terrain data
2. Running this application from our Python code
3. Reading the exported data in our Python application

## Conclusion

By leveraging CodeWalker's existing capabilities, we can create a more robust and efficient terrain extraction application without having to reimplement complex file parsing logic. The Python.NET integration approach offers the best balance of functionality and efficiency, but we have fallback options if needed. 