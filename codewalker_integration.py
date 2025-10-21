import os
import logging
import clr
import System
from pathlib import Path
import dotenv

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Load environment variables
dotenv.load_dotenv()

class CodeWalkerIntegration:
    """Class for integrating with CodeWalker using Python.NET"""
    
    def __init__(self, game_path):
        """Initialize CodeWalker integration"""
        self.game_path = Path(game_path)
        self.rpf_manager = None
        self.heightmap_file_class = None
        
        # Initialize CodeWalker integration
        self.initialize()
    
    def initialize(self):
        """Initialize CodeWalker integration using compiled DLL"""
        # First try to use the compiled DLL
        if self.initialize_compiled_codewalker():
            return True
        
        # If that fails, try the standard approach
        return self.initialize_standard_codewalker()
    
    def initialize_compiled_codewalker(self):
        """Initialize CodeWalker integration using the compiled DLL"""
        try:
            # Check if Python.NET is available
            import clr
            logger.info("Python.NET is available, attempting to initialize compiled CodeWalker")
            
            # Get compiled DLL path
            dll_path = os.getenv('codewalker_dll')
            if not dll_path:
                # Try to find it in the default location
                default_path = Path("./compiled_cw/CodeWalker.Minimal.dll")
                if default_path.exists():
                    dll_path = str(default_path)
                else:
                    logger.warning("Compiled CodeWalker DLL not found")
                    return False
            
            # Convert to absolute path if it's not already
            dll_path = Path(dll_path)
            if not dll_path.is_absolute():
                dll_path = Path.cwd() / dll_path
            
            # Check if the DLL exists
            if not dll_path.exists():
                logger.warning(f"DLL not found at path: {dll_path}")
                
                # Try to compile it
                try:
                    import compile_codewalker
                    codewalker_path = os.getenv('codewalker_map')
                    if codewalker_path:
                        codewalker_path = codewalker_path.strip('"\'')
                        new_dll_path = compile_codewalker.compile_codewalker_files(codewalker_path)
                        if new_dll_path:
                            dll_path = Path(new_dll_path)
                        else:
                            logger.warning("Failed to compile CodeWalker DLL")
                            return False
                    else:
                        logger.warning("CodeWalker path not found in .env file")
                        return False
                except Exception as e:
                    logger.warning(f"Error compiling CodeWalker DLL: {e}")
                    return False
            
            # Add reference to the compiled DLL
            logger.info(f"Loading DLL from: {dll_path}")
            clr.AddReference(str(dll_path))
            
            # Import CodeWalker namespaces
            from CodeWalker.GameFiles import RpfManager, HeightmapFile
            
            # Initialize RpfManager
            rpf_manager = RpfManager()
            rpf_manager.Init(str(self.game_path))
            
            # Store the integration objects
            self.rpf_manager = rpf_manager
            self.heightmap_file_class = HeightmapFile
            
            logger.info("Compiled CodeWalker integration initialized successfully")
            return True
        except ImportError:
            logger.warning("Python.NET not available, cannot use compiled CodeWalker")
            return False
        except Exception as e:
            logger.error(f"Error initializing compiled CodeWalker: {e}")
            import traceback
            logger.debug(traceback.format_exc())
            return False
    
    def initialize_standard_codewalker(self):
        """Initialize CodeWalker integration using standard approach"""
        try:
            # Check if Python.NET is available
            import clr
            logger.info("Python.NET is available, attempting to initialize standard CodeWalker integration")
            
            # Get CodeWalker path
            codewalker_path = os.getenv('codewalker_map')
            if not codewalker_path:
                logger.warning("CodeWalker path not found in .env file")
                return False
            
            codewalker_path = Path(codewalker_path.strip('"\''))
            if not codewalker_path.exists():
                logger.warning(f"CodeWalker path does not exist: {codewalker_path}")
                return False
            
            # Try to find CodeWalker DLLs
            core_dll = None
            gamefiles_dll = None
            
            for dll_path in codewalker_path.glob("**/*.dll"):
                if dll_path.name == "CodeWalker.Core.dll":
                    core_dll = dll_path
                elif dll_path.name == "CodeWalker.GameFiles.dll":
                    gamefiles_dll = dll_path
            
            if not core_dll or not gamefiles_dll:
                logger.warning("CodeWalker DLLs not found")
                return False
            
            # Add references to CodeWalker assemblies
            clr.AddReference(str(core_dll))
            clr.AddReference(str(gamefiles_dll))
            
            # Import CodeWalker namespaces
            from CodeWalker.GameFiles import RpfManager, HeightmapFile
            
            # Initialize RpfManager
            rpf_manager = RpfManager()
            rpf_manager.Init(str(self.game_path))
            
            # Store the integration objects
            self.rpf_manager = rpf_manager
            self.heightmap_file_class = HeightmapFile
            
            logger.info("Standard CodeWalker integration initialized successfully")
            return True
        except ImportError:
            logger.warning("Python.NET not available, cannot use CodeWalker assemblies directly")
            return False
        except Exception as e:
            logger.error(f"Error initializing standard CodeWalker integration: {e}")
            import traceback
            logger.debug(traceback.format_exc())
            return False
    
    def get_heightmap_file(self, path):
        """Get a heightmap file from the RPF archives"""
        if not self.rpf_manager or not self.heightmap_file_class:
            logger.error("CodeWalker integration not initialized")
            return None
        
        try:
            # Use the generic GetFile method with the HeightmapFile type
            heightmap_file = self.rpf_manager.GetFile[self.heightmap_file_class](path)
            if heightmap_file:
                logger.info(f"Found heightmap file: {path}")
                return heightmap_file
            else:
                logger.warning(f"Heightmap file not found: {path}")
                return None
        except Exception as e:
            logger.error(f"Error getting heightmap file {path}: {e}")
            import traceback
            logger.debug(traceback.format_exc())
            return None
    
    def find_heightmap_files(self):
        """Find heightmap files in the GTA 5 directory"""
        if not self.rpf_manager or not self.heightmap_file_class:
            logger.error("CodeWalker integration not initialized")
            return []
        
        heightmap_paths = [
            "common.rpf/data/levels/gta5/heightmap.dat",
            "update/update.rpf/common/data/levels/gta5/heightmap.dat",
            "update/update.rpf/common/data/levels/gta5/heightmapheistisland.dat"
        ]
        
        heightmap_files = []
        
        for path in heightmap_paths:
            try:
                # Get heightmap file from RpfManager
                heightmap_file = self.get_heightmap_file(path)
                if heightmap_file:
                    heightmap_files.append(heightmap_file)
            except Exception as e:
                logger.warning(f"Failed to get heightmap file {path}: {e}")
        
        return heightmap_files 