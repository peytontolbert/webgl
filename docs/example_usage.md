# Example Usage

This document provides examples of how to use the GTA 5 Terrain Extractor in various scenarios.

## Basic Usage

The simplest way to extract and visualize the GTA 5 terrain is:

```bash
python gta5_terrain_extractor.py
```

This will:
1. Load the game path from your `.env` file
2. Extract the terrain data
3. Generate a visualization
4. Save it to the output directory

## Exporting to OBJ

To export the terrain as an OBJ file for use in 3D modeling software:

```bash
python gta5_terrain_extractor.py --export-obj
```

This will create an OBJ file in the output directory that you can open in Blender, MeshLab, or other 3D modeling software.

## Exporting Data in Different Formats

You can export the terrain data in various formats for further processing:

```bash
# Export as NumPy arrays
python gta5_terrain_extractor.py --export-data numpy

# Export as CSV files
python gta5_terrain_extractor.py --export-data csv

# Export as JSON files
python gta5_terrain_extractor.py --export-data json

# Export in all formats
python gta5_terrain_extractor.py --export-data all
```

## Specifying Game Path

If your GTA 5 installation is not specified in the `.env` file, you can provide it directly:

```bash
python gta5_terrain_extractor.py --game-path "C:\Path\To\GTA5"
```

## Specifying Output Directory

To change the output directory:

```bash
python gta5_terrain_extractor.py --output-dir "my_terrain_data"
```

## Combining Options

You can combine multiple options:

```bash
python gta5_terrain_extractor.py --game-path "C:\Path\To\GTA5" --export-obj --export-data all --output-dir "my_terrain_data"
```

## Using the Compiled DLL

If you've already compiled the CodeWalker files using `compile_codewalker.py`, you can use the compiled DLL directly:

```bash
# First compile the CodeWalker files
python compile_codewalker.py

# Then run the terrain extractor
python gta5_terrain_extractor.py
```

The terrain extractor will automatically use the compiled DLL if it's available.

## Debugging

If you encounter issues, you can enable debug mode:

```bash
python gta5_terrain_extractor.py --debug
```

This will provide more detailed logging information to help diagnose the problem.

## Batch Processing

You can use the provided batch file to extract terrain with default settings:

```bash
# Windows
extract_terrain.bat

# Linux/macOS
./extract_terrain.sh
```

## Programmatic Usage

You can also use the terrain extractor in your own Python scripts:

```python
from gta5_terrain_extractor import GTATerrainExtractor

# Create a terrain extractor
extractor = GTATerrainExtractor(
    game_path="C:/Path/To/GTA5",
    output_dir="output",
    debug=True
)

# Extract terrain data
if extractor.extract_terrain():
    # Visualize the terrain
    extractor.visualize_terrain()
    
    # Export as OBJ
    extractor.export_terrain_obj()
    
    # Export data in various formats
    extractor.export_terrain_data(format='numpy')
    extractor.export_terrain_data(format='csv')
    extractor.export_terrain_data(format='json')
```

## Working with the Extracted Data

After extracting the terrain data, you can use it in various ways:

### Viewing OBJ Files

1. Open the OBJ file in Blender:
   - File > Import > Wavefront (.obj)
   - Navigate to the output directory and select the OBJ file

2. Open the OBJ file in MeshLab:
   - File > Import Mesh
   - Navigate to the output directory and select the OBJ file

### Working with NumPy Data

If you exported the data as NumPy arrays, you can load and process it in your own Python scripts:

```python
import numpy as np
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D

# Load the terrain data
data = np.load('output/terrain_data_0.npz')

# Extract the arrays
X = data['X']
Y = data['Y']
Z_max = data['Z_max']

# Create a 3D plot
fig = plt.figure(figsize=(12, 10))
ax = fig.add_subplot(111, projection='3d')

# Plot the terrain surface
surf = ax.plot_surface(X, Y, Z_max, cmap='terrain', alpha=0.8, linewidth=0, antialiased=True)

# Add colorbar
fig.colorbar(surf, ax=ax, shrink=0.5, aspect=5)

# Set labels and title
ax.set_xlabel('X')
ax.set_ylabel('Y')
ax.set_zlabel('Z')
ax.set_title('GTA 5 Terrain')

# Show the plot
plt.show()
```

### Working with CSV Data

If you exported the data as CSV files, you can load and process it in various data analysis tools:

```python
import pandas as pd
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D

# Load the terrain data
df = pd.read_csv('output/terrain_data_0.csv')

# Create a 3D plot
fig = plt.figure(figsize=(12, 10))
ax = fig.add_subplot(111, projection='3d')

# Plot the terrain surface
surf = ax.scatter(df['x'], df['y'], df['z_max'], c=df['z_max'], cmap='terrain', s=1)

# Add colorbar
fig.colorbar(surf, ax=ax, shrink=0.5, aspect=5)

# Set labels and title
ax.set_xlabel('X')
ax.set_ylabel('Y')
ax.set_zlabel('Z')
ax.set_title('GTA 5 Terrain')

# Show the plot
plt.show()
``` 