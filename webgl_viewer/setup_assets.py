import os
import shutil
import json
from pathlib import Path

def setup_assets():
    """Set up assets for the WebGL viewer"""
    # Create assets directory if it doesn't exist
    assets_dir = Path('webgl_viewer/assets')
    assets_dir.mkdir(parents=True, exist_ok=True)
    
    # Copy terrain.obj if it exists
    terrain_obj = Path('output/terrain.obj')
    if terrain_obj.exists():
        shutil.copy2(terrain_obj, assets_dir / 'terrain.obj')
        print("Copied terrain.obj")
    else:
        print("Warning: terrain.obj not found")
    
    # Copy terrain_info.json if it exists
    terrain_info = Path('output/terrain_info.json')
    if terrain_info.exists():
        shutil.copy2(terrain_info, assets_dir / 'terrain_info.json')
        print("Copied terrain_info.json")
    else:
        print("Warning: terrain_info.json not found")
    
    # Copy heightmap.png if it exists
    heightmap = Path('output/heightmap.png')
    if heightmap.exists():
        shutil.copy2(heightmap, assets_dir / 'heightmap.png')
        print("Copied heightmap.png")
    else:
        print("Warning: heightmap.png not found")
    
    # Copy textures from output/textures directory
    textures_dir = Path('output/textures')
    if textures_dir.exists():
        # Create textures directory in assets
        assets_textures_dir = assets_dir / 'textures'
        assets_textures_dir.mkdir(exist_ok=True)
        
        # Copy all texture files
        for texture_file in textures_dir.glob('*.png'):
            shutil.copy2(texture_file, assets_textures_dir / texture_file.name)
            print(f"Copied texture: {texture_file.name}")
    else:
        print("Warning: textures directory not found")
    
    # Create a manifest file for the viewer
    manifest = {
        'version': '1.0',
        'terrain': {
            'obj_file': 'terrain.obj',
            'info_file': 'terrain_info.json',
            'heightmap_file': 'heightmap.png',
            'textures_dir': 'textures'
        }
    }
    
    with open(assets_dir / 'manifest.json', 'w') as f:
        json.dump(manifest, f, indent=2)
    
    print("\nAsset setup complete!")
    print(f"Assets directory: {assets_dir.absolute()}")

if __name__ == '__main__':
    setup_assets() 