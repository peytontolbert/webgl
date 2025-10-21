import os
import logging
import numpy as np
from pathlib import Path
import struct

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class TerrainExtractor:
    """Class for extracting terrain data from GTA 5 heightmap files"""
    
    def __init__(self, codewalker_integration=None):
        """Initialize terrain extractor"""
        self.codewalker_integration = codewalker_integration
        self.heightmaps = []
    
    def extract_terrain(self):
        """Extract terrain data from heightmap files"""
        # First try to extract terrain using CodeWalker integration
        if self.codewalker_integration and self.extract_terrain_using_codewalker():
            logger.info("Successfully extracted terrain data using CodeWalker")
            return True
        
        # If CodeWalker integration failed, fall back to manual extraction
        logger.info("Falling back to manual terrain extraction")
        
        heightmap_paths = self.find_heightmap_files()
        
        if not heightmap_paths:
            logger.error("No heightmap files found")
            return False
        
        success = False
        for path in heightmap_paths:
            try:
                logger.info(f"Processing heightmap file: {path}")
                reader = HeightmapReader(path)
                if reader.read():
                    self.heightmaps.append(reader)
                    success = True
                    logger.info(f"Successfully processed heightmap file: {path}")
                else:
                    logger.warning(f"Failed to read heightmap file: {path}")
            except Exception as e:
                logger.error(f"Error processing heightmap file {path}: {e}")
                import traceback
                logger.debug(traceback.format_exc())
        
        if not self.heightmaps:
            logger.error("Failed to extract any terrain data")
            return False
        
        logger.info(f"Successfully extracted terrain data from {len(self.heightmaps)} heightmap files")
        return True
    
    def extract_terrain_using_codewalker(self):
        """Extract terrain data using CodeWalker integration"""
        if not self.codewalker_integration:
            logger.warning("CodeWalker integration not available")
            return False
        
        try:
            # Get heightmap files using CodeWalker
            heightmap_files = self.codewalker_integration.find_heightmap_files()
            
            if not heightmap_files:
                logger.warning("No heightmap files found using CodeWalker")
                return False
            
            # Process each heightmap file
            for heightmap_file in heightmap_files:
                try:
                    # Create a wrapper for the heightmap file
                    wrapper = CodeWalkerHeightmapWrapper(heightmap_file)
                    self.heightmaps.append(wrapper)
                    logger.info(f"Successfully processed heightmap file using CodeWalker: {heightmap_file.Name}")
                except Exception as e:
                    logger.error(f"Error processing heightmap file using CodeWalker: {e}")
                    import traceback
                    logger.debug(traceback.format_exc())
            
            return len(self.heightmaps) > 0
        except Exception as e:
            logger.error(f"Error extracting terrain using CodeWalker: {e}")
            import traceback
            logger.debug(traceback.format_exc())
            return False
    
    def find_heightmap_files(self):
        """Find heightmap files in the GTA 5 directory"""
        # This is a fallback method if CodeWalker integration is not available
        # It searches for heightmap files in common locations
        
        heightmap_paths = []
        
        # Standard heightmap locations
        standard_paths = [
            "common.rpf/data/levels/gta5/heightmap.dat",
            "update/update.rpf/common/data/levels/gta5/heightmap.dat",
            "update/update.rpf/common/data/levels/gta5/heightmapheistisland.dat"
        ]
        
        # Check for FiveM specific paths
        fivem_paths = [
            "citizen/common/data/levels/gta5/heightmap.dat",
            "citizen/dlc_patchday2ng/common/data/levels/gta5/heightmap.dat"
        ]
        
        # Check for extracted paths (if someone has already extracted the files)
        extracted_paths = [
            "data/levels/gta5/heightmap.dat",
            "common/data/levels/gta5/heightmap.dat",
            "common/data/levels/gta5/heightmapheistisland.dat"
        ]
        
        # Combine all potential paths
        all_paths = standard_paths + fivem_paths + extracted_paths
        
        # Try to find the files
        game_path = os.getenv('gta_location')
        if game_path:
            game_path = Path(game_path.strip('"\''))
            
            for rel_path in all_paths:
                abs_path = game_path / Path(rel_path.replace('/', os.sep))
                if abs_path.exists():
                    heightmap_paths.append(abs_path)
                    logger.info(f"Found heightmap file: {abs_path}")
        
        return heightmap_paths
    
    def get_terrain_data(self):
        """Get the extracted terrain data"""
        return self.heightmaps


class CodeWalkerHeightmapWrapper:
    """Wrapper class for CodeWalker heightmap files"""
    
    def __init__(self, heightmap_file):
        """Initialize the wrapper with a CodeWalker heightmap file"""
        self.heightmap_file = heightmap_file
        
        # Get basic properties
        self.width = heightmap_file.Width
        self.height = heightmap_file.Height
        
        # Try to get bounding box information
        try:
            # Check if BBMin and BBMax are available
            if hasattr(heightmap_file, 'BBMin') and hasattr(heightmap_file, 'BBMax'):
                self.bb_min = (heightmap_file.BBMin.X, heightmap_file.BBMin.Y, heightmap_file.BBMin.Z)
                self.bb_max = (heightmap_file.BBMax.X, heightmap_file.BBMax.Y, heightmap_file.BBMax.Z)
            else:
                # Use default values
                self.bb_min = (-4000, -4000, -100)
                self.bb_max = (4000, 4000, 1000)
        except Exception as e:
            logger.warning(f"Error getting bounding box: {e}")
            # Use default values
            self.bb_min = (-4000, -4000, -100)
            self.bb_max = (4000, 4000, 1000)
        
        # Get file path or name
        if hasattr(heightmap_file, 'FilePath'):
            self.file_path = heightmap_file.FilePath
        elif hasattr(heightmap_file, 'Name'):
            self.file_path = heightmap_file.Name
        else:
            self.file_path = "unknown.dat"
    
    def get_terrain_mesh(self):
        """Get the terrain mesh data"""
        # Create a grid of X, Y coordinates
        x = np.linspace(self.bb_min[0], self.bb_max[0], self.width)
        y = np.linspace(self.bb_min[1], self.bb_max[1], self.height)
        X, Y = np.meshgrid(x, y)
        
        # Get the height data
        try:
            # Try to get the height data from the heightmap file
            if hasattr(self.heightmap_file, 'MaxHeights') and hasattr(self.heightmap_file, 'MinHeights'):
                # Convert max_heights and min_heights to numpy arrays
                max_heights = np.zeros((self.height, self.width), dtype=np.float32)
                min_heights = np.zeros((self.height, self.width), dtype=np.float32)
                
                # Scale height values to match the bounding box Z range
                height_scale = (self.bb_max[2] - self.bb_min[2]) / 255.0
                
                # Extract height data
                for y in range(self.height):
                    for x in range(self.width):
                        index = y * self.width + x
                        if index < len(self.heightmap_file.MaxHeights):
                            max_heights[y, x] = self.bb_min[2] + self.heightmap_file.MaxHeights[index] * height_scale
                            min_heights[y, x] = self.bb_min[2] + self.heightmap_file.MinHeights[index] * height_scale
                
                return X, Y, max_heights, min_heights
            elif hasattr(self.heightmap_file, 'Heights'):
                # If we have a Heights array, use that
                Z = np.zeros((self.height, self.width), dtype=np.float32)
                
                # Extract height data
                for y in range(self.height):
                    for x in range(self.width):
                        Z[y, x] = self.heightmap_file.Heights[x, y]
                
                return X, Y, Z, Z
            else:
                # Fallback to a simple grid
                logger.warning("No height data found in heightmap file, using default grid")
                Z = np.zeros((self.height, self.width), dtype=np.float32)
                return X, Y, Z, Z
        except Exception as e:
            logger.error(f"Error getting terrain mesh: {e}")
            import traceback
            logger.debug(traceback.format_exc())
            
            # Fallback to a simple grid
            Z = np.zeros((self.height, self.width), dtype=np.float32)
            return X, Y, Z, Z


class HeightmapReader:
    """Class to read and parse GTA 5 heightmap files as a fallback when CodeWalker is not available"""
    
    MAGIC = b'HMAP'  # Magic bytes for heightmap files
    
    def __init__(self, file_path):
        self.file_path = file_path
        self.width = 0
        self.height = 0
        self.bb_min = None  # Bounding box minimum
        self.bb_max = None  # Bounding box maximum
        self.max_heights = None
        self.min_heights = None
        self.endianness = '>'  # Default to big endian
        self.version_major = 0
        self.version_minor = 0
        self.compressed = 0
    
    def read(self):
        """Read and parse the heightmap file"""
        logger.info(f"Reading heightmap file: {self.file_path}")
        
        try:
            with open(self.file_path, 'rb') as f:
                data = f.read()
            
            if len(data) < 44:  # Minimum header size
                logger.error(f"File too small to be a valid heightmap: {self.file_path}")
                return False
            
            # Check magic bytes
            magic = data[0:4]
            if magic == self.MAGIC:
                self.endianness = '<'  # Little endian
            elif magic == bytes(reversed(self.MAGIC)):
                self.endianness = '>'  # Big endian
            else:
                logger.error(f"Invalid heightmap file (wrong magic bytes): {self.file_path}")
                return False
            
            # Parse header
            self.version_major = data[4]
            self.version_minor = data[5]
            # Skip padding at 6-7
            self.compressed = struct.unpack(f"{self.endianness}I", data[8:12])[0]
            self.width = struct.unpack(f"{self.endianness}H", data[12:14])[0]
            self.height = struct.unpack(f"{self.endianness}H", data[14:16])[0]
            
            # Validate dimensions
            if self.width == 0 or self.height == 0 or self.width > 10000 or self.height > 10000:
                logger.error(f"Invalid heightmap dimensions: {self.width}x{self.height}")
                return False
            
            # Parse bounding box
            self.bb_min = struct.unpack(f"{self.endianness}fff", data[16:28])
            self.bb_max = struct.unpack(f"{self.endianness}fff", data[28:40])
            
            length = struct.unpack(f"{self.endianness}I", data[40:44])[0]
            
            logger.info(f"Heightmap version: {self.version_major}.{self.version_minor}")
            logger.info(f"Heightmap compressed: {self.compressed > 0}")
            logger.info(f"Heightmap dimensions: {self.width}x{self.height}")
            logger.info(f"Bounding box: {self.bb_min} to {self.bb_max}")
            
            # Parse compressed data
            if self.compressed > 0:
                # Read compression headers
                comp_headers = []
                offset = 44
                
                # Ensure we have enough data for the compression headers
                if offset + (self.height * 8) > len(data):
                    logger.error(f"File too small for compression headers: {self.file_path}")
                    return False
                
                for i in range(self.height):
                    start = struct.unpack(f"{self.endianness}H", data[offset:offset+2])[0]
                    count = struct.unpack(f"{self.endianness}H", data[offset+2:offset+4])[0]
                    data_offset = struct.unpack(f"{self.endianness}I", data[offset+4:offset+8])[0]
                    comp_headers.append((start, count, data_offset))
                    offset += 8
                
                # Allocate arrays for height data
                self.max_heights = np.zeros((self.height, self.width), dtype=np.uint8)
                self.min_heights = np.zeros((self.height, self.width), dtype=np.uint8)
                
                # Calculate where the second half of the data starts
                data_start = offset
                data_size = len(data) - data_start
                half_data_len = data_size // 2
                
                # Validate data size
                if data_start + data_size > len(data):
                    logger.error(f"Invalid data size in heightmap file: {self.file_path}")
                    return False
                
                # Extract height data
                for y in range(self.height):
                    if y >= len(comp_headers):
                        logger.warning(f"Missing compression header for row {y}")
                        continue
                        
                    start, count, data_offset = comp_headers[y]
                    
                    # Validate compression header
                    if start + count > self.width:
                        logger.warning(f"Invalid compression header for row {y}: start={start}, count={count}")
                        count = min(count, self.width - start)
                    
                    for i in range(count):
                        x = start + i
                        o = data_start + data_offset + i
                        
                        # Ensure we're within bounds
                        if o < len(data) and y < self.height and x < self.width:
                            self.max_heights[y, x] = data[o]
                            
                            # Ensure we're within bounds for min heights
                            if o + half_data_len < len(data):
                                self.min_heights[y, x] = data[o + half_data_len]
                            else:
                                # If min height data is missing, use max height
                                self.min_heights[y, x] = self.max_heights[y, x]
            else:
                # Uncompressed data (rare case)
                data_start = 44
                data_len = self.width * self.height
                
                # Ensure we have enough data
                if data_start + data_len > len(data):
                    logger.error(f"File too small for uncompressed data: {self.file_path}")
                    return False
                
                self.max_heights = np.frombuffer(data[data_start:data_start+data_len], dtype=np.uint8).reshape(self.height, self.width)
                
                # If there's enough data for min heights, read them too
                if data_start + 2*data_len <= len(data):
                    self.min_heights = np.frombuffer(data[data_start+data_len:data_start+2*data_len], dtype=np.uint8).reshape(self.height, self.width)
                else:
                    # Otherwise, use max heights for min heights
                    self.min_heights = self.max_heights.copy()
            
            logger.info("Heightmap data loaded successfully")
            return True
            
        except Exception as e:
            logger.error(f"Error reading heightmap file {self.file_path}: {str(e)}")
            import traceback
            logger.debug(traceback.format_exc())
            return False

    def get_terrain_mesh(self):
        """Convert heightmap data to 3D mesh vertices"""
        if self.max_heights is None:
            raise ValueError("Heightmap data not loaded")
        
        # Create coordinate grids
        x = np.linspace(self.bb_min[0], self.bb_max[0], self.width)
        y = np.linspace(self.bb_min[1], self.bb_max[1], self.height)
        X, Y = np.meshgrid(x, y)
        
        # Scale height values to match the bounding box Z range
        height_scale = (self.bb_max[2] - self.bb_min[2]) / 255.0
        Z_max = self.bb_min[2] + self.max_heights * height_scale
        Z_min = self.bb_min[2] + self.min_heights * height_scale
        
        return X, Y, Z_max, Z_min 