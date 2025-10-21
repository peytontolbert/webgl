import clr
import logging
from pathlib import Path

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def main():
    try:
        # Get path to compiled CodeWalker
        base_dir = Path(__file__).parent / "compiled_cw"
        logger.info(f"Using CodeWalker from: {base_dir}")
        
        # Load CodeWalker.Core.dll
        dll_path = base_dir / "CodeWalker.Core.dll"
        if not dll_path.exists():
            raise FileNotFoundError(f"CodeWalker.Core.dll not found at {dll_path}")
        
        # Add reference to the DLL
        clr.AddReference(str(dll_path))
        
        # Import CodeWalker modules
        from CodeWalker.GameFiles import GameFileCache
        
        # Create a temporary instance to inspect
        cache = GameFileCache(1024, 3600.0, "", True, "", False, "")
        
        # Get all public attributes and methods
        attrs = [attr for attr in dir(cache) if not attr.startswith('_')]
        
        # Print them in sorted order
        logger.info("GameFileCache attributes and methods:")
        for attr in sorted(attrs):
            logger.info(f"- {attr}")
            
    except Exception as e:
        logger.error(f"Error inspecting GameFileCache: {e}")
        logger.debug("Stack trace:", exc_info=True)

if __name__ == "__main__":
    main() 