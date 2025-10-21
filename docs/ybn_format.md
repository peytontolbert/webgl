# YBN Format Documentation

## Overview
YBN (Bound) files in GTA5 contain collision and boundary data for models, including physics boundaries, collision meshes, and other physical properties. This document details the format and the extraction process for WebGL rendering.

## File Structure

### 1. Header (C# Implementation)
```csharp
public struct YbnHeader
{
    public uint Magic;        // "YBN" (0x4E4259)
    public uint Version;      // Usually 1
    public uint Flags;        // Various flags
    public uint NumBounds;    // Number of bounds
    public uint DataSize;     // Size of bound data
}
```

### 2. Bound Structure (C# Implementation)
```csharp
public struct Bound
{
    public uint Hash;           // Hash of bound name
    public uint Flags;          // Bound flags
    public uint Type;          // Bound type (box, sphere, capsule, etc.)
    public uint NumVertices;    // Number of vertices
    public uint NumIndices;     // Number of indices
    public uint DataOffset;     // Offset to bound data
    public uint DataSize;       // Size of bound data
}
```

## Python Extraction Implementation

### 1. Bound Extractor
```python
class BoundExtractor:
    def __init__(self, dll_manager):
        self.dll = dll_manager
        self.bounds = {}
        
    def extract_bound(self, ybn_path: str) -> Dict:
        """Extract bound data from YBN file"""
        try:
            # Load YBN file through DLL
            ybn_handle = self.dll.load_ybn(ybn_path)
            if not ybn_handle:
                raise ValueError(f"Failed to load YBN file: {ybn_path}")
                
            # Get header
            header = self.dll.get_ybn_header(ybn_handle)
            
            # Extract bounds
            bounds = []
            for i in range(header.NumBounds):
                bound = self.dll.get_ybn_bound(ybn_handle, i)
                if bound:
                    # Extract collision mesh
                    mesh = self._extract_collision_mesh(ybn_handle, bound)
                    
                    # Extract physics properties
                    physics = self._extract_physics_properties(ybn_handle, bound)
                    
                    bounds.append({
                        'hash': bound.Hash,
                        'type': bound.Type,
                        'mesh': mesh,
                        'physics': physics
                    })
            
            # Clean up
            self.dll.unload_ybn(ybn_handle)
            
            return {
                'header': header,
                'bounds': bounds
            }
            
        except Exception as e:
            logger.error(f"Error extracting bound from {ybn_path}: {e}")
            return None
            
    def _extract_collision_mesh(self, ybn_handle, bound) -> Dict:
        """Extract collision mesh data for a bound"""
        try:
            # Get vertex data
            vertices = self.dll.get_bound_vertices(ybn_handle, bound.Hash)
            
            # Get index data
            indices = self.dll.get_bound_indices(ybn_handle, bound.Hash)
            
            # Get material data
            materials = self.dll.get_bound_materials(ybn_handle, bound.Hash)
            
            return {
                'vertices': vertices,
                'indices': indices,
                'materials': materials
            }
            
        except Exception as e:
            logger.error(f"Error extracting collision mesh: {e}")
            return None
            
    def _extract_physics_properties(self, ybn_handle, bound) -> Dict:
        """Extract physics properties for a bound"""
        try:
            # Get physics data
            physics = self.dll.get_bound_physics(ybn_handle, bound.Hash)
            
            return {
                'mass': physics.Mass,
                'friction': physics.Friction,
                'restitution': physics.Restitution,
                'linear_damping': physics.LinearDamping,
                'angular_damping': physics.AngularDamping
            }
            
        except Exception as e:
            logger.error(f"Error extracting physics properties: {e}")
            return None
```

### 2. WebGL Data Preparation
```python
class BoundDataPreparator:
    def __init__(self):
        self.mesh_manager = MeshManager()
        
    def prepare_bound_data(self, bound_data: Dict) -> Dict:
        """Prepare bound data for WebGL rendering"""
        try:
            # Prepare collision meshes
            meshes = self._prepare_meshes(bound_data['bounds'])
            
            # Prepare physics data
            physics = self._prepare_physics(bound_data['bounds'])
            
            return {
                'meshes': meshes,
                'physics': physics
            }
            
        except Exception as e:
            logger.error(f"Error preparing bound data: {e}")
            return None
            
    def _prepare_meshes(self, bounds: List[Dict]) -> List[Dict]:
        """Prepare collision meshes for WebGL"""
        prepared = []
        for bound in bounds:
            mesh = bound['mesh']
            if not mesh:
                continue
                
            # Convert vertex data to Float32Array
            vertices = np.array(mesh['vertices'], dtype=np.float32)
            
            # Convert index data to Uint16Array
            indices = np.array(mesh['indices'], dtype=np.uint16)
            
            # Prepare materials
            materials = self._prepare_materials(mesh['materials'])
            
            prepared.append({
                'type': bound['type'],
                'vertices': vertices,
                'indices': indices,
                'materials': materials
            })
        return prepared
        
    def _prepare_physics(self, bounds: List[Dict]) -> List[Dict]:
        """Prepare physics data for WebGL"""
        prepared = []
        for bound in bounds:
            physics = bound['physics']
            if not physics:
                continue
                
            prepared.append({
                'type': bound['type'],
                'mass': physics['mass'],
                'friction': physics['friction'],
                'restitution': physics['restitution'],
                'linear_damping': physics['linear_damping'],
                'angular_damping': physics['angular_damping']
            })
        return prepared
```

## Usage Example

```python
# Initialize extractors
dll_manager = DllManager(game_path)
bound_extractor = BoundExtractor(dll_manager)
data_preparator = BoundDataPreparator()

# Extract bound data
ybn_path = "levels/gta5/vehicles.ybn"
bound_data = bound_extractor.extract_bound(ybn_path)

if bound_data:
    # Prepare data for WebGL
    webgl_data = data_preparator.prepare_bound_data(bound_data)
    
    # Export to JSON for WebGL viewer
    output_path = "assets/bounds/vehicles.json"
    with open(output_path, 'w') as f:
        json.dump(webgl_data, f)
```

## WebGL Integration Notes

1. Collision Mesh Rendering:
- Use wireframe rendering for collision meshes
- Support different bound types (box, sphere, capsule)
- Implement collision visualization modes
- Support material-based coloring

2. Vertex Data Format:
- Position: 3 floats (x, y, z)
- Normal: 3 floats (nx, ny, nz)
- Material index: 1 uint

3. Shader Requirements:
- Support wireframe rendering
- Material-based coloring
- Normal visualization
- Collision detection visualization

4. Performance Considerations:
- Use vertex buffer objects (VBOs)
- Implement collision mesh culling
- Use instancing for repeated bounds
- Implement LOD system for complex meshes
- Use compressed vertex data where possible