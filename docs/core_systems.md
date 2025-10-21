# CodeWalker Core Systems Documentation

## Overview
This document provides a comprehensive reference of CodeWalker's core systems and their Python implementations.

## Table of Contents
1. [YMAP System](#ymap-system)
2. [Map Selection System](#map-selection-system)
3. [RPF System](#rpf-system)
4. [Entity System](#entity-system)
5. [Instance Systems](#instance-systems)
6. [Light Systems](#light-systems)
7. [Occluder Systems](#occluder-systems)

## YMAP System
The YMAP system is responsible for handling GTA5's map files.

### YmapFile Class
```csharp
// C# Implementation
public class YmapFile : GameFile, PackedFile {
    public Meta Meta { get; set; }
    public CMapData CMapData { get; set; }
    public YmapFile Parent { get; set; }
    public YmapFile[] ChildYmaps { get; set; }
    public YmapEntityDef[] AllEntities { get; set; }
    public YmapEntityDef[] RootEntities { get; set; }
    public YmapEntityDef[] MloEntities { get; set; }
}
```

```python
# Python Implementation
@dataclass
class YmapFile:
    meta: Optional[Meta] = None
    map_data: Optional[CMapData] = None
    parent: Optional['YmapFile'] = None
    child_ymaps: List['YmapFile'] = field(default_factory=list)
    all_entities: List['YmapEntityDef'] = field(default_factory=list)
    root_entities: List['YmapEntityDef'] = field(default_factory=list)
    mlo_entities: List['YmapEntityDef'] = field(default_factory=list)
```

### Key Methods
- `Load(byte[] data)`: Loads raw YMAP data
- `EnsureEntities()`: Initializes entity structures
- `ConnectToParent()`: Links YMAP hierarchies
- `CalcFlags()/CalcExtents()`: Updates YMAP metadata

## Map Selection System

### MapSelectionMode Enum
```csharp
// C# Implementation
public enum MapSelectionMode {
    None = 0,
    Entity = 1,
    EntityExtension = 2,
    ArchetypeExtension = 3,
    TimeCycleModifier = 4,
    CarGenerator = 5,
    // ... more modes
}
```

```python
# Python Implementation
class MapSelectionMode(Enum):
    NONE = 0
    ENTITY = 1
    ENTITY_EXTENSION = 2
    ARCHETYPE_EXTENSION = 3
    TIME_CYCLE_MODIFIER = 4
    CAR_GENERATOR = 5
    # ... more modes
```

### MapSelection Structure
```csharp
// C# Implementation
public struct MapSelection {
    public WorldForm WorldForm { get; set; }
    public YmapEntityDef EntityDef { get; set; }
    public Archetype Archetype { get; set; }
    public DrawableBase Drawable { get; set; }
    // ... more properties
}
```

```python
# Python Implementation
@dataclass
class MapSelection:
    world_form: Optional['WorldForm'] = None
    entity_def: Optional['YmapEntityDef'] = None
    archetype: Optional['Archetype'] = None
    drawable: Optional['DrawableBase'] = None
    # ... more properties
```

## Entity System

### YmapEntityDef Class
```csharp
// C# Implementation
public class YmapEntityDef {
    public Archetype Archetype { get; set; }
    public Vector3 Position { get; set; }
    public Quaternion Orientation { get; set; }
    public Vector3 Scale { get; set; }
    public Vector3 BBMin { get; set; }
    public Vector3 BBMax { get; set; }
}
```

```python
# Python Implementation
@dataclass
class YmapEntityDef:
    archetype: Optional['Archetype'] = None
    position: np.ndarray = field(default_factory=lambda: np.zeros(3))
    orientation: np.ndarray = field(default_factory=lambda: np.array([0, 0, 0, 1]))
    scale: np.ndarray = field(default_factory=lambda: np.ones(3))
    bb_min: np.ndarray = field(default_factory=lambda: np.zeros(3))
    bb_max: np.ndarray = field(default_factory=lambda: np.zeros(3))
```

## Instance Systems

### GrassInstanceBatch Class
```csharp
// C# Implementation
public class YmapGrassInstanceBatch {
    public Archetype Archetype { get; set; }
    public Vector3 Position { get; set; }
    public float Radius { get; set; }
    public Vector3 AABBMin { get; set; }
    public Vector3 AABBMax { get; set; }
}
```

```python
# Python Implementation
@dataclass
class YmapGrassInstanceBatch:
    archetype: Optional['Archetype'] = None
    position: np.ndarray = field(default_factory=lambda: np.zeros(3))
    radius: float = 0.0
    aabb_min: np.ndarray = field(default_factory=lambda: np.zeros(3))
    aabb_max: np.ndarray = field(default_factory=lambda: np.zeros(3))
```

## Light Systems

### LODLights Class
```csharp
// C# Implementation
public class YmapLODLights {
    public CLODLight[] LodLights { get; set; }
    public YmapDistantLODLights DistantLODLights { get; set; }
    public YmapFile Parent { get; set; }
}
```

```python
# Python Implementation
@dataclass
class YmapLODLights:
    lod_lights: List['CLODLight'] = field(default_factory=list)
    distant_lod_lights: Optional['YmapDistantLODLights'] = None
    parent: Optional['YmapFile'] = None
```

## Occluder Systems

### BoxOccluder Class
```csharp
// C# Implementation
public class YmapBoxOccluder {
    public Vector3 Position { get; set; }
    public Vector3 Size { get; set; }
    public Vector3 BBMin { get; set; }
    public Vector3 BBMax { get; set; }
    public Quaternion Orientation { get; set; }
}
```

```python
# Python Implementation
@dataclass
class YmapBoxOccluder:
    position: np.ndarray = field(default_factory=lambda: np.zeros(3))
    size: np.ndarray = field(default_factory=lambda: np.ones(3))
    bb_min: np.ndarray = field(default_factory=lambda: np.zeros(3))
    bb_max: np.ndarray = field(default_factory=lambda: np.zeros(3))
    orientation: np.ndarray = field(default_factory=lambda: np.array([0, 0, 0, 1]))
``` 