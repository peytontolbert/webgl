import clr
import logging
from pathlib import Path
from System import Action

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
        from CodeWalker.GameFiles import RpfManager
        
        # Create RPF manager
        manager = RpfManager()
        
        # Get all public attributes
        attributes = [attr for attr in dir(manager) if not attr.startswith('_')]
        print("\nRPF Manager attributes:")
        for attr in sorted(attributes):
            print(f"- {attr}")
            
    except Exception as e:
        logger.error(f"Error: {e}")
        logger.debug("Stack trace:", exc_info=True)

if __name__ == "__main__":
    main() 