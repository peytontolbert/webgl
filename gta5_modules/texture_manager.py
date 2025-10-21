"""
Texture Management for GTA5 Terrain
--------------------------------
Handles texture loading and processing for terrain rendering.
"""

import logging
import numpy as np
from pathlib import Path
from typing import Dict, Any, Optional, Tuple
from PIL import Image

logger = logging.getLogger(__name__)

class TextureManager:
    """Manages texture loading and processing for terrain rendering"""
    
    def __init__(self):
        """Initialize texture manager"""
        self.textures: Dict[str, Any] = {}
        self.texture_patterns = {
            'colourmap0': ['diffuse'],  # DiffuseSampler
            'colourmap1': ['layer0'],   # TextureSampler_layer0
            'colourmap2': ['layer1'],   # TextureSampler_layer1
            'colourmap3': ['layer2'],   # TextureSampler_layer2
            'colourmap4': ['layer3'],   # TextureSampler_layer3
            'colourmask': ['lookup'],   # lookupSampler
            'normalmap0': ['bump'],     # BumpSampler
            'normalmap1': ['bump0'],    # BumpSampler_layer0
            'normalmap2': ['bump1'],    # BumpSampler_layer1
            'normalmap3': ['bump2'],    # BumpSampler_layer2
            'normalmap4': ['bump3'],    # BumpSampler_layer3
            'tintpalette': ['tint']     # TintPaletteSampler
        }
    
    def process_texture(self, texture: Any, texture_name: str) -> Optional[Dict[str, Any]]:
        """
        Process a texture from CodeWalker
        
        Args:
            texture (Any): CodeWalker texture object
            texture_name (str): Name of the texture
            
        Returns:
            Optional[Dict[str, Any]]: Processed texture data if successful
        """
        try:
            # Extract texture name and format
            texture_name = texture_name.lower()
            texture_format = texture.Format
            
            # Try to match texture name with patterns
            matched_type = None
            for tex_type, patterns in self.texture_patterns.items():
                if any(pattern in texture_name for pattern in patterns):
                    matched_type = tex_type
                    break
            
            if matched_type:
                # Get the raw pixel data
                pixels = texture.GetPixels(0)  # Get base mip level
                if pixels:
                    # Convert pixel data based on texture format
                    if texture_format == 'DXT1':
                        # Handle DXT1 format (RGB)
                        img = Image.frombytes('RGB', (texture.Width, texture.Height), pixels)
                        img = img.convert('RGBA')
                    elif texture_format == 'DXT5':
                        # Handle DXT5 format (RGBA)
                        img = Image.frombytes('RGBA', (texture.Width, texture.Height), pixels)
                    else:
                        # Default to RGBA
                        img = Image.frombytes('RGBA', (texture.Width, texture.Height), pixels)
                    
                    # Store texture data
                    self.textures[matched_type] = {
                        'texture': texture,
                        'pixels': img.tobytes(),
                        'width': texture.Width,
                        'height': texture.Height,
                        'format': texture_format
                    }
                    logger.info(f"Processed texture: {matched_type} from {texture_name} ({texture.Width}x{texture.Height}, {texture_format})")
                    return self.textures[matched_type]
            
            return None
            
        except Exception as e:
            logger.warning(f"Failed to process texture {texture_name}: {e}")
            return None
    
    def export_textures(self, output_dir: str):
        """
        Export textures to files
        
        Args:
            output_dir (str): Directory to save the textures
        """
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        for name, texture_data in self.textures.items():
            try:
                # Get texture info
                pixels = texture_data['pixels']
                width = texture_data['width']
                height = texture_data['height']
                format = texture_data['format']
                
                # Convert pixel data to image
                if pixels:
                    # Create a new image with the correct dimensions
                    img = Image.frombytes('RGBA', (width, height), pixels)
                    
                    # Save as PNG
                    output_path = output_dir / f"{name}.png"
                    img.save(output_path)
                    logger.info(f"Exported texture: {output_path} ({width}x{height})")
                    
                    # Also save as DDS for reference
                    dds_path = output_dir / f"{name}.dds"
                    dds_data = texture_data['texture'].GetDDSFile()
                    with open(dds_path, 'wb') as f:
                        f.write(dds_data)
                    logger.info(f"Exported DDS: {dds_path}")
                    
            except Exception as e:
                logger.warning(f"Failed to export texture {name}: {e}")
    
    def get_texture(self, name: str) -> Optional[Dict[str, Any]]:
        """
        Get a texture by name
        
        Args:
            name (str): Name of the texture to get
            
        Returns:
            Optional[Dict[str, Any]]: Texture data if found
        """
        return self.textures.get(name)
    
    def get_texture_info(self) -> Dict[str, Any]:
        """
        Get information about loaded textures
        
        Returns:
            Dict[str, Any]: Dictionary containing texture information
        """
        info = {
            "num_textures": len(self.textures),
            "textures": {}
        }
        
        for name, texture_data in self.textures.items():
            info["textures"][name] = {
                "width": texture_data['width'],
                "height": texture_data['height'],
                "format": texture_data['format']
            }
        
        return info 