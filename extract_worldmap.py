import os
import sys
import logging
import dotenv
from pathlib import Path
from PIL import Image
import numpy as np
from gta5_modules.rpf_reader import RpfReader

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Load environment variables
dotenv.load_dotenv()

def extract_worldmap():
    # Get game path from environment variable
    game_path = os.getenv('gta5_path')
    if not game_path:
        # Try to find GTA5 in common locations
        common_paths = [
            r"C:\Program Files\Epic Games\GTAV",
            r"C:\Program Files (x86)\Steam\steamapps\common\Grand Theft Auto V",
            r"D:\Program Files\Epic Games\GTAV",
            r"D:\Program Files (x86)\Steam\steamapps\common\Grand Theft Auto V"
        ]
        
        for path in common_paths:
            if Path(path).exists():
                game_path = path
                break
        
        if not game_path:
            logger.error("GTA5 installation directory not found")
            logger.info("Please set gta5_path in .env file or specify the path")
            return False
    
    game_path = Path(game_path)
    if not game_path.exists():
        logger.error(f"Game path does not exist: {game_path}")
        return False
    
    logger.info(f"Using game path: {game_path}")
    
    # Initialize RPF reader
    reader = RpfReader(str(game_path))
    
    # Path to world map texture in GTA5
    worldmap_paths = [
        ("common.rpf", "data\\levels\\gta5\\worldmap.png"),
        ("update.rpf", "common\\data\\levels\\gta5\\worldmap.png"),
        ("common.rpf", "data\\levels\\gta5\\worldmap_heist.png")  # Cayo Perico
    ]
    
    try:
        # Try each path until we find the world map
        for rpf_path, file_path in worldmap_paths:
            try:
                # Read the world map texture using GetFileData
                data = reader.rpf_manager.GetFileData(f"{rpf_path}\\{file_path}")
                if data is None:
                    logger.warning(f"Failed to read world map from {rpf_path}/{file_path}")
                    continue
                
                # Convert to image
                img = Image.open(data)
                
                # Save to output directory
                output_dir = "output"
                if not os.path.exists(output_dir):
                    os.makedirs(output_dir)
                    
                img.save(os.path.join(output_dir, "worldmap.png"))
                logger.info(f"World map texture extracted successfully from {rpf_path}/{file_path}")
                return True
                
            except Exception as e:
                logger.warning(f"Failed to read world map from {rpf_path}/{file_path}: {e}")
                continue
        
        logger.error("Failed to find world map texture in any location")
        return False
        
    except Exception as e:
        logger.error(f"Failed to extract world map texture: {e}")
        return False

if __name__ == "__main__":
    extract_worldmap() 