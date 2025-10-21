# GTA 5 Heightmap File Format

## Overview

GTA 5 uses a custom binary format for storing terrain heightmap data. This document details the structure of this format based on the CodeWalker implementation.

## File Location

Heightmap files in GTA 5 are typically located at:
- `common.rpf/data/levels/gta5/heightmap.dat` (Main map)
- `update/update.rpf/common/data/levels/gta5/heightmap.dat` (Updated main map)
- `update/update.rpf/common/data/levels/gta5/heightmapheistisland.dat` (Cayo Perico island)

## File Structure

The heightmap file format consists of a header followed by compressed height data.

### Header Structure

| Offset | Size | Type | Description |
|--------|------|------|-------------|
| 0x00 | 4 | uint32 | Magic ('HMAP') |
| 0x04 | 1 | uint8 | Version Major |
| 0x05 | 1 | uint8 | Version Minor |
| 0x06 | 2 | uint16 | Padding |
| 0x08 | 4 | uint32 | Compressed Flag (1 = compressed, 0 = uncompressed) |
| 0x0C | 2 | uint16 | Width |
| 0x0E | 2 | uint16 | Height |
| 0x10 | 12 | float[3] | Bounding Box Minimum (X, Y, Z) |
| 0x1C | 12 | float[3] | Bounding Box Maximum (X, Y, Z) |
| 0x28 | 4 | uint32 | Data Length |

### Compression Headers

If the Compressed Flag is set to 1, the header is followed by an array of compression headers, one for each row in the heightmap. Each compression header has the following structure:

| Offset | Size | Type | Description |
|--------|------|------|-------------|
| 0x00 | 2 | uint16 | Start Index |
| 0x02 | 2 | uint16 | Count |
| 0x04 | 4 | uint32 | Data Offset |

The compression headers are used to optimize storage by only storing non-zero height values. For each row:
- Start Index: The index of the first non-zero value in the row
- Count: The number of consecutive non-zero values
- Data Offset: The offset into the compressed data array

### Height Data

The height data consists of two sets of values:
1. Maximum Heights: The maximum height values for each point in the terrain
2. Minimum Heights: The minimum height values for each point in the terrain

For compressed data, these two sets are stored consecutively in the data section. The compression headers are used to determine which values are stored and where they are located in the data section.

For uncompressed data (rare), the height values are stored as a simple array of bytes, with one byte per height value.

## Coordinate System

The heightmap uses a grid-based coordinate system:
- The grid size is defined by the Width and Height values in the header
- Each point in the grid has X, Y coordinates (grid coordinates)
- Each point has two height values: a maximum height and a minimum height
- The actual world coordinates are calculated using the bounding box values

The conversion from grid coordinates to world coordinates is as follows:
```
world_x = bb_min_x + (grid_x / (width - 1)) * (bb_max_x - bb_min_x)
world_y = bb_min_y + (grid_y / (height - 1)) * (bb_max_y - bb_min_y)
world_z = bb_min_z + (height_value / 255) * (bb_max_z - bb_min_z)
```

## Reading the Heightmap

The process for reading a heightmap file is as follows:

1. Read and validate the header
2. Determine if the data is compressed
3. If compressed:
   a. Read the compression headers
   b. Allocate arrays for maximum and minimum heights
   c. Use the compression headers to extract the height values
4. If uncompressed:
   a. Read the height values directly

## Example Code (Based on CodeWalker)

```csharp
// Read header
Magic = reader.ReadUInt32();
VersionMajor = reader.ReadByte();
VersionMinor = reader.ReadByte();
Pad = reader.ReadUInt16();
Compressed = reader.ReadUInt32();
Width = reader.ReadUInt16();
Height = reader.ReadUInt16();
BBMin = reader.ReadVector3();
BBMax = reader.ReadVector3();
Length = reader.ReadUInt32();

// Read compression headers if compressed
if (Compressed > 0)
{
    CompHeaders = new CompHeader[Height];
    for (int i = 0; i < Height; i++)
    {
        CompHeaders[i].Read(reader);
    }
}

// Read data
byte[] data = reader.ReadBytes((int)Length - (Compressed > 0 ? Height * 8 : 0));

// Process data
if (Compressed > 0)
{
    MaxHeights = new byte[Width * Height];
    MinHeights = new byte[Width * Height];
    int halfDataLen = data.Length / 2;
    
    for (int y = 0; y < Height; y++)
    {
        var header = CompHeaders[y];
        for (int i = 0; i < header.Count; i++)
        {
            int x = header.Start + i;
            int offset = header.DataOffset + i;
            MaxHeights[y * Width + x] = data[offset];
            MinHeights[y * Width + x] = data[offset + halfDataLen];
        }
    }
}
else
{
    // Uncompressed data (rare case)
    MaxHeights = data;
    MinHeights = data;
}
```

## Visualization

To visualize the heightmap data, the height values need to be converted to 3D coordinates:

```csharp
// Create coordinate grids
for (int y = 0; y < Height; y++)
{
    for (int x = 0; x < Width; x++)
    {
        float worldX = BBMin.X + (x / (float)(Width - 1)) * (BBMax.X - BBMin.X);
        float worldY = BBMin.Y + (y / (float)(Height - 1)) * (BBMax.Y - BBMin.Y);
        float worldZ = BBMin.Z + (MaxHeights[y * Width + x] / 255.0f) * (BBMax.Z - BBMin.Z);
        
        // Use these coordinates to create a 3D mesh
        // ...
    }
}
```

## Conclusion

The GTA 5 heightmap format is a compact binary format designed for efficient storage and retrieval of terrain elevation data. By understanding this format, we can extract and visualize the terrain geometry of the GTA 5 map. 