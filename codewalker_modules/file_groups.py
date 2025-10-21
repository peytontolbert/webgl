"""
CodeWalker File Groups Configuration
----------------------------------
Defines the groups of files needed for minimal CodeWalker compilation.
Each group represents a logical component and its dependencies.
"""

from typing import Dict, List, NamedTuple

class FileGroup(NamedTuple):
    """Represents a group of related source files"""
    name: str
    files: List[str]
    dependencies: List[str]

# Properties and resources
PROPERTIES = FileGroup(
    name="Properties",
    files=[
        "Resources.resx",
        "Resources.Designer.cs"
    ],
    dependencies=[]
)

# Core utilities needed for basic functionality
CORE_UTILS = FileGroup(
    name="Utils",
    files=[
        "Vectors.cs",      # Contains Vector2, Vector3, Vector4
        "Matrices.cs",
        "Quaternions.cs",
        "BoundingBoxes.cs",
        "Cache.cs",
        "Utils.cs",
        "Xml.cs",          # For XML serialization
        "TriangleBVH.cs",  # For spatial indexing
        "FbxConverter.cs", # For mesh conversion
        "Fbx.cs"          # For FBX file handling
    ],
    dependencies=["Properties"]
)

# Game file handling
GAME_FILES = FileGroup(
    name="GameFiles",
    files=[
        "GameFile.cs",
        "GameFileCache.cs",
        "RpfFile.cs",           # Contains RpfFileEntry, RpfDirectoryEntry, etc.
        "RpfManager.cs"
    ],
    dependencies=["Utils"]
)

# Encryption and hashing
CRYPTO = FileGroup(
    name="GameFiles/Utils",
    files=[
        "GTAKeys.cs",
        "GTACrypto.cs",
        "Jenk.cs",
        "Data.cs",
        "DDSIO.cs"  # Required for texture handling
    ],
    dependencies=["Utils", "Properties"]
)

# Resource base types and handling
RESOURCES = FileGroup(
    name="GameFiles/Resources",
    files=[
        "ResourceFile.cs",
        "ResourceData.cs",
        "ResourceBuilder.cs",
        "ResourceBaseTypes.cs",
        "ResourceAnalyzer.cs",
        "VertexType.cs",     # For mesh data
        "Texture.cs",        # For texture data
        "ShaderParams.cs",   # For material data
        "Bounds.cs",         # For bounding volumes
        "Node.cs",          # For scene hierarchy
        "Drawable.cs",      # For drawable objects
        "Frag.cs",          # For fragment data
        "Clip.cs",          # For animation clips
        "Filter.cs",        # For resource filtering
        "Expression.cs",    # For expressions
        "Particle.cs",      # For particle systems
        "Nav.cs",          # For navigation data
        "WaypointRecord.cs", # For waypoint data
        "VehicleRecord.cs",  # For vehicle data
        "Clothes.cs"        # For clothing data
    ],
    dependencies=["Utils", "GameFiles", "Crypto"]
)

# File type definitions
FILE_TYPES = FileGroup(
    name="GameFiles/FileTypes",
    files=[
        "HeightmapFile.cs",    # Main file for heightmap data
        "YbnFile.cs",          # For collision data
        "YtdFile.cs",          # For texture data
        "YmapFile.cs",         # For map data
        "YdrFile.cs",          # For drawable data
        "YtypFile.cs",         # For archetype data
        "WatermapFile.cs",     # For water height data
        "YnvFile.cs",          # For navigation data
        "YndFile.cs",          # For navigation data
        "YmtFile.cs",          # For material data
        "YmfFile.cs",          # For material data
        "YldFile.cs",          # For light data
        "YftFile.cs",          # For fragment data
        "YfdFile.cs",          # For fragment data
        "YedFile.cs",          # For entity data
        "YddFile.cs",          # For drawable data
        "YcdFile.cs",          # For collision data
        "YwrFile.cs",          # For weather data
        "YvrFile.cs",          # For vehicle data
        "YtdFile.cs",          # For texture data
        "YptFile.cs",          # For particle data
        "YpdbFile.cs",         # For ped data
        "VehiclesFile.cs",     # For vehicle data
        "VehicleLayoutsFile.cs", # For vehicle layouts
        "Stats.cs",            # For statistics
        "RelFile.cs",          # For relationship data
        "PedsFile.cs",         # For ped data
        "PedFile.cs",          # For ped data
        "MrfFile.cs",          # For material data
        "JPsoFile.cs",         # For PSO data
        "Gxt2File.cs",         # For text data
        "GtxdFile.cs",         # For texture data
        "FxcFile.cs",          # For shader data
        "DlcSetupFile.cs",     # For DLC setup
        "DlcContentFile.cs",   # For DLC content
        "DistantLightsFile.cs", # For distant lights
        "CutFile.cs",          # For cutscene data
        "CarVariationsFile.cs", # For car variations
        "CarModColsFile.cs",   # For car mod colors
        "CarColsFile.cs",      # For car colors
        "CacheDatFile.cs",     # For cache data
        "AwcFile.cs"           # For audio data
    ],
    dependencies=["GameFiles", "Utils", "Crypto", "Resources"]
)

# Meta type system
META_TYPES = FileGroup(
    name="GameFiles/MetaTypes",
    files=[
        "MetaTypes.cs",
        "MetaBuilder.cs",
        "MetaNames.cs",
        "Meta.cs",
        "XmlMeta.cs",      # For XML serialization
        "XmlRbf.cs",       # For RBF file handling
        "XmlPso.cs",       # For PSO XML handling
        "Archetype.cs",    # For type definitions
        "PsoTypes.cs",     # For PSO types
        "PsoBuilder.cs",   # For PSO building
        "Pso.cs",          # For PSO data
        "MetaXml.cs",      # For XML meta data
        "Rbf.cs"           # For RBF data
    ],
    dependencies=["Utils", "GameFiles"]
)

# World and heightmap specific code
WORLD = FileGroup(
    name="World",
    files=[
        "Heightmaps.cs",
        "Entity.cs",       # Required for world entities
        "Space.cs",        # Required for spatial data
        "Water.cs",        # For water height data
        "Watermaps.cs",    # For water map data
        "Camera.cs",       # For view calculations
        "Weather.cs",      # For environmental data
        "Clouds.cs",       # For cloud data
        "AudioZones.cs",   # For audio zones
        "PopZones.cs",     # For population zones
        "Scenarios.cs",    # For scenario data
        "Timecycle.cs",    # For time cycle data
        "TimecycleMods.cs", # For time cycle modifications
        "Trains.cs",       # For train data
        "Vehicle.cs",      # For vehicle data
        "Weapon.cs",       # For weapon data
        "Ped.cs"          # For ped data
    ],
    dependencies=["Utils", "GameFiles", "FileTypes", "Resources"]
)

# All file groups in dependency order
FILE_GROUPS = {
    "Properties": PROPERTIES,
    "Utils": CORE_UTILS,
    "GameFiles": GAME_FILES,
    "Crypto": CRYPTO,
    "MetaTypes": META_TYPES,
    "Resources": RESOURCES,
    "FileTypes": FILE_TYPES,
    "World": WORLD
}

def get_file_groups() -> Dict[str, FileGroup]:
    """Get all file groups in the correct dependency order"""
    return FILE_GROUPS

def get_minimal_groups() -> Dict[str, FileGroup]:
    """Get only the essential groups needed for heightmap extraction"""
    return {
        "Properties": PROPERTIES,
        "Utils": CORE_UTILS,
        "GameFiles": GAME_FILES,
        "Crypto": CRYPTO,
        "Resources": RESOURCES,
        "FileTypes": FILE_TYPES,
        "MetaTypes": META_TYPES,
        "World": WORLD
    } 