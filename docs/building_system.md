# Building System Documentation

## Overview
The building system handles extraction and processing of buildings, structures, and water data from GTA5's map files.

## Table of Contents
1. [Building System Architecture](#building-system-architecture)
2. [Building Data Structures](#building-data-structures)
3. [Building Extraction Process](#building-extraction-process)
4. [Water System](#water-system)
5. [Export Formats](#export-formats)

## Building System Architecture

### BuildingSystem Class
```python
class BuildingSystem:
    def __init__(self, game_path: str, dll_manager: DllManager):
        """Initialize building system.
        
        Args:
            game_path: Path to GTA5 installation
            dll_manager: DllManager instance for CodeWalker resources
        """
        self.game_path = Path(game_path)
        self.dll_manager = dll_manager
        self.rpf_manager = dll_manager.get_rpf_manager()
        self.game_cache = dll_manager.get_game_cache()
        self.rpf_reader = RpfReader(str(game_path), dll_manager)
        self.ymap_handler = YmapHandler(self.rpf_manager)
```

### Key Components
1. **Building Extractor**
   - Extracts building data from YMAP files
   - Processes building properties (position, rotation, scale)
   - Handles LOD information

2. **Water System**
   - Extracts water data from watermap files
   - Processes water vertices and indices
   - Calculates water bounds and statistics

3. **Export System**
   - Exports data to JSON and OBJ formats
   - Provides detailed statistics about buildings and water

## Building Data Structures

### Building Data
```python
@dataclass
class BuildingData:
    """Building data extracted from YMAP files"""
    position: np.ndarray  # (x, y, z) position
    rotation: np.ndarray  # (x, y, z, w) quaternion
    scale: np.ndarray     # (x, y, z) scale
    type: str            # Building type (house, apartment, etc.)
    lod_dist: float      # LOD distance
    archetype: str       # Archetype name
    flags: int          # Building flags
```

### Water Data
```python
@dataclass
class WaterData:
    """Water data extracted from watermap files"""
    vertices: np.ndarray  # (N, 3) float32 array of positions
    indices: np.ndarray   # (M,) uint32 array of triangle indices
    bounds: Dict[str, float]  # Water bounds (min_x, min_y, min_z, max_x, max_y, max_z)
    stats: Dict[str, int]     # Water statistics (num_vertices, num_triangles)
```

## Building Extraction Process

### 1. YMAP Processing
```python
def process_ymap(self, ymap_path: str) -> List[BuildingData]:
    """Process YMAP file to extract building data.
    
    Args:
        ymap_path: Path to YMAP file
        
    Returns:
        List of BuildingData objects
    """
    try:
        # Get YMAP file through RPF manager
        ymap = self.rpf_manager.GetFile[self.dll_manager.YmapFile](ymap_path)
        if not ymap or not ymap.AllEntities:
            return []
            
        buildings = []
        for entity in ymap.AllEntities:
            # Process entity if it's a building
            if self._is_building_entity(entity):
                building = self._extract_building_data(entity)
                if building:
                    buildings.append(building)
                    
        return buildings
        
    except Exception as e:
        logger.error(f"Failed to process YMAP {ymap_path}: {e}")
        return []
```

### 2. Building Classification
```python
def _classify_building(self, archetype: str) -> str:
    """Classify building type based on archetype name.
    
    Args:
        archetype: Archetype name
        
    Returns:
        Building type (house, apartment, skyscraper, etc.)
    """
    archetype_lower = archetype.lower()
    
    if 'house' in archetype_lower:
        return 'house'
    elif 'apartment' in archetype_lower:
        return 'apartment'
    elif 'skyscraper' in archetype_lower:
        return 'skyscraper'
    elif 'commercial' in archetype_lower:
        return 'commercial'
    else:
        return 'other'
```

## Water System

### 1. Water Data Extraction
```python
def extract_water_data(self, watermap_path: str) -> Optional[WaterData]:
    """Extract water data from watermap file.
    
    Args:
        watermap_path: Path to watermap file
        
    Returns:
        WaterData object if successful, None otherwise
    """
    try:
        # Get watermap data through RPF reader
        data = self.rpf_reader.get_file_data(watermap_path)
        if not data:
            return None
            
        # Process water data
        vertices = self._process_water_vertices(data)
        indices = self._process_water_indices(data)
        bounds = self._calculate_water_bounds(vertices)
        stats = {
            'num_vertices': len(vertices),
            'num_triangles': len(indices) // 3
        }
        
        return WaterData(
            vertices=vertices,
            indices=indices,
            bounds=bounds,
            stats=stats
        )
        
    except Exception as e:
        logger.error(f"Failed to extract water data from {watermap_path}: {e}")
        return None
```

### 2. Water Bounds Calculation
```python
def _calculate_water_bounds(self, vertices: np.ndarray) -> Dict[str, float]:
    """Calculate water bounds from vertices.
    
    Args:
        vertices: (N, 3) array of vertex positions
        
    Returns:
        Dictionary of bounds (min_x, min_y, min_z, max_x, max_y, max_z)
    """
    if len(vertices) == 0:
        return {
            'min_x': 0.0, 'min_y': 0.0, 'min_z': 0.0,
            'max_x': 0.0, 'max_y': 0.0, 'max_z': 0.0
        }
        
    return {
        'min_x': float(np.min(vertices[:, 0])),
        'min_y': float(np.min(vertices[:, 1])),
        'min_z': float(np.min(vertices[:, 2])),
        'max_x': float(np.max(vertices[:, 0])),
        'max_y': float(np.max(vertices[:, 1])),
        'max_z': float(np.max(vertices[:, 2]))
    }
```

## Export Formats

### 1. JSON Export
```python
def export_building_info(self, output_dir: Path) -> bool:
    """Export building information to JSON file.
    
    Args:
        output_dir: Output directory
        
    Returns:
        True if successful
    """
    try:
        # Create output directory
        output_dir.mkdir(parents=True, exist_ok=True)
        
        # Prepare building info
        building_info = {
            'num_buildings': len(self.buildings),
            'num_structures': len(self.structures),
            'building_types': self._count_building_types(),
            'water_info': self._get_water_info() if self.water_data else None
        }
        
        # Write to JSON file
        info_path = output_dir / 'building_info.json'
        with open(info_path, 'w') as f:
            json.dump(building_info, f, indent=2)
            
        return True
        
    except Exception as e:
        logger.error(f"Error exporting building info: {e}")
        return False
```

### 2. OBJ Export
```python
def export_obj(self, output_path: str) -> bool:
    """Export building and water data to OBJ file.
    
    Args:
        output_path: Path to output OBJ file
        
    Returns:
        True if successful
    """
    try:
        with open(output_path, 'w') as f:
            # Write buildings
            for building in self.buildings:
                f.write(f"# Building: {building.type}\n")
                f.write(f"# Position: {building.position}\n")
                f.write(f"# Rotation: {building.rotation}\n")
                f.write(f"# Scale: {building.scale}\n")
                f.write(f"# LOD Distance: {building.lod_dist}\n")
                f.write(f"v {building.position[0]} {building.position[1]} {building.position[2]}\n")
                
            # Write water mesh
            if self.water_data:
                f.write("\n# Water Mesh\n")
                for vertex in self.water_data.vertices:
                    f.write(f"v {vertex[0]} {vertex[1]} {vertex[2]}\n")
                for i in range(0, len(self.water_data.indices), 3):
                    f.write(f"f {self.water_data.indices[i]+1} "
                           f"{self.water_data.indices[i+1]+1} "
                           f"{self.water_data.indices[i+2]+1}\n")
                    
        return True
        
    except Exception as e:
        logger.error(f"Error exporting OBJ file: {e}")
        return False
```

## Usage Example

```python
# Initialize building system
building_system = BuildingSystem(game_path, dll_manager)

# Extract building and water data
if building_system.extract_buildings():
    # Get building info
    building_info = building_system.get_building_info()
    
    # Log statistics
    logger.info(f"Loaded {building_info['num_buildings']} buildings")
    logger.info(f"Loaded {building_info['num_structures']} structures")
    logger.info("Building types:")
    for btype, count in building_info['building_types'].items():
        logger.info(f"  - {btype}: {count}")
        
    # Export data
    building_system.export_obj("buildings.obj")
    building_system.export_building_info(Path("output")) 