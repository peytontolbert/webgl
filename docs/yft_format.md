# YFT Format Documentation

## Overview
YFT (Fragment Type) files in GTA5 contain fragment data for models, including physics, animations, and other model-specific information. This document details the format and the extraction process for WebGL rendering.

## File Structure

### 1. Header (C# Implementation)
```csharp
public struct YftHeader
{
    public uint Magic;        // "YFT" (0x544659)
    public uint Version;      // Usually 1
    public uint Flags;        // Various flags
    public uint NumFragments; // Number of fragments
    public uint DataSize;     // Size of fragment data
}
```

### 2. Fragment Structure (C# Implementation)
```csharp
public struct Fragment
{
    public uint Hash;           // Hash of fragment name
    public uint Flags;          // Fragment flags
    public uint NumBones;       // Number of bones
    public uint NumVertices;    // Number of vertices
    public uint NumIndices;     // Number of indices
    public uint NumShaders;     // Number of shaders
    public uint NumTextures;    // Number of textures
    public uint DataOffset;     // Offset to fragment data
    public uint DataSize;       // Size of fragment data
}
```

## Python Extraction Implementation

### 1. Fragment Extractor
```python
class FragmentExtractor:
    def __init__(self, dll_manager):
        self.dll = dll_manager
        self.fragments = {}
        
    def extract_fragment(self, yft_path: str) -> Dict:
        """Extract fragment data from YFT file"""
        try:
            # Load YFT file through DLL
            yft_handle = self.dll.load_yft(yft_path)
            if not yft_handle:
                raise ValueError(f"Failed to load YFT file: {yft_path}")
                
            # Get header
            header = self.dll.get_yft_header(yft_handle)
            
            # Extract fragments
            fragments = []
            for i in range(header.NumFragments):
                fragment = self.dll.get_yft_fragment(yft_handle, i)
                if fragment:
                    # Extract bones
                    bones = self._extract_bones(yft_handle, fragment)
                    
                    # Extract geometries
                    geometries = self._extract_geometries(yft_handle, fragment)
                    
                    # Extract animations
                    animations = self._extract_animations(yft_handle, fragment)
                    
                    # Extract physics data
                    physics = self._extract_physics(yft_handle, fragment)
                    
                    fragments.append({
                        'hash': fragment.Hash,
                        'bones': bones,
                        'geometries': geometries,
                        'animations': animations,
                        'physics': physics
                    })
            
            # Clean up
            self.dll.unload_yft(yft_handle)
            
            return {
                'header': header,
                'fragments': fragments
            }
            
        except Exception as e:
            logger.error(f"Error extracting fragment from {yft_path}: {e}")
            return None
            
    def _extract_bones(self, yft_handle, fragment) -> List[Dict]:
        """Extract bone data for a fragment"""
        bones = []
        for i in range(fragment.NumBones):
            bone = self.dll.get_fragment_bone(yft_handle, fragment.Hash, i)
            if bone:
                # Extract bone transform
                transform = self.dll.get_bone_transform(yft_handle, bone.Hash)
                
                bones.append({
                    'hash': bone.Hash,
                    'parent_index': bone.ParentIndex,
                    'position': transform.Position,
                    'rotation': transform.Rotation,
                    'scale': transform.Scale
                })
        return bones
        
    def _extract_animations(self, yft_handle, fragment) -> List[Dict]:
        """Extract animation data for a fragment"""
        animations = []
        num_animations = self.dll.get_fragment_num_animations(yft_handle, fragment.Hash)
        
        for i in range(num_animations):
            animation = self.dll.get_fragment_animation(yft_handle, fragment.Hash, i)
            if animation:
                # Extract keyframes
                keyframes = self._extract_keyframes(yft_handle, animation.Hash)
                
                animations.append({
                    'hash': animation.Hash,
                    'duration': animation.Duration,
                    'keyframes': keyframes
                })
        return animations
        
    def _extract_keyframes(self, yft_handle, animation_hash: int) -> List[Dict]:
        """Extract keyframe data for an animation"""
        keyframes = []
        num_keyframes = self.dll.get_animation_num_keyframes(yft_handle, animation_hash)
        
        for i in range(num_keyframes):
            keyframe = self.dll.get_animation_keyframe(yft_handle, animation_hash, i)
            if keyframe:
                # Extract bone transforms for this keyframe
                transforms = self._extract_keyframe_transforms(yft_handle, keyframe.Hash)
                
                keyframes.append({
                    'time': keyframe.Time,
                    'transforms': transforms
                })
        return keyframes
```

### 2. WebGL Data Preparation
```python
class FragmentDataPreparator:
    def __init__(self):
        self.texture_manager = TextureManager()
        
    def prepare_fragment_data(self, fragment_data: Dict) -> Dict:
        """Prepare fragment data for WebGL rendering"""
        try:
            # Prepare bones
            bones = self._prepare_bones(fragment_data['bones'])
            
            # Prepare geometries
            geometries = self._prepare_geometries(fragment_data['geometries'])
            
            # Prepare animations
            animations = self._prepare_animations(fragment_data['animations'])
            
            # Prepare physics data
            physics = self._prepare_physics(fragment_data['physics'])
            
            return {
                'bones': bones,
                'geometries': geometries,
                'animations': animations,
                'physics': physics
            }
            
        except Exception as e:
            logger.error(f"Error preparing fragment data: {e}")
            return None
            
    def _prepare_bones(self, bones: List[Dict]) -> List[Dict]:
        """Prepare bone data for WebGL"""
        prepared = []
        for bone in bones:
            # Convert position to Float32Array
            position = np.array(bone['position'], dtype=np.float32)
            
            # Convert rotation to Float32Array (quaternion)
            rotation = np.array(bone['rotation'], dtype=np.float32)
            
            # Convert scale to Float32Array
            scale = np.array(bone['scale'], dtype=np.float32)
            
            prepared.append({
                'parent_index': bone['parent_index'],
                'position': position,
                'rotation': rotation,
                'scale': scale
            })
        return prepared
        
    def _prepare_animations(self, animations: List[Dict]) -> List[Dict]:
        """Prepare animation data for WebGL"""
        prepared = []
        for animation in animations:
            # Convert keyframes to Float32Array
            keyframes = []
            for keyframe in animation['keyframes']:
                transforms = []
                for transform in keyframe['transforms']:
                    transforms.extend([
                        *transform['position'],
                        *transform['rotation'],
                        *transform['scale']
                    ])
                keyframes.append({
                    'time': keyframe['time'],
                    'transforms': np.array(transforms, dtype=np.float32)
                })
            
            prepared.append({
                'duration': animation['duration'],
                'keyframes': keyframes
            })
        return prepared
```

## Usage Example

```python
# Initialize extractors
dll_manager = DllManager(game_path)
fragment_extractor = FragmentExtractor(dll_manager)
data_preparator = FragmentDataPreparator()

# Extract fragment data
yft_path = "levels/gta5/vehicles.yft"
fragment_data = fragment_extractor.extract_fragment(yft_path)

if fragment_data:
    # Prepare data for WebGL
    webgl_data = data_preparator.prepare_fragment_data(fragment_data)
    
    # Export to JSON for WebGL viewer
    output_path = "assets/fragments/vehicles.json"
    with open(output_path, 'w') as f:
        json.dump(webgl_data, f)
```

## WebGL Integration Notes

1. Bone Animation:
- Use uniform arrays for bone transforms
- Implement GPU-based skinning
- Support multiple animation tracks
- Handle animation blending

2. Vertex Data Format:
- Position: 3 floats (x, y, z)
- Normal: 3 floats (nx, ny, nz)
- UV: 2 floats (u, v)
- Bone weights: 4 floats (w1, w2, w3, w4)
- Bone indices: 4 bytes (i1, i2, i3, i4)

3. Shader Requirements:
- Vertex shader must handle skinning
- Support for normal mapping
- PBR material support
- Environment mapping

4. Performance Considerations:
- Use vertex buffer objects (VBOs)
- Implement animation culling
- Use compressed textures
- Implement LOD system
- Use instancing for repeated fragments 