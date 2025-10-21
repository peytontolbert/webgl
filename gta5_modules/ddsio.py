"""
DDS (DirectDraw Surface) texture loader
Based on CodeWalker's implementation
"""

import logging
import numpy as np
from typing import Optional, Tuple
from dataclasses import dataclass
from enum import IntEnum

logger = logging.getLogger(__name__)

class DDSFormat(IntEnum):
    """DDS texture formats"""
    UNKNOWN = 0
    R8G8B8 = 20
    A8R8G8B8 = 21
    X8R8G8B8 = 22
    DXT1 = 827611204  # 'DXT1' in ASCII
    DXT3 = 861165636  # 'DXT3' in ASCII
    DXT5 = 894720068  # 'DXT5' in ASCII

@dataclass
class DDSHeader:
    """DDS file header structure"""
    size: int = 0
    flags: int = 0
    height: int = 0
    width: int = 0
    pitch_or_linear_size: int = 0
    depth: int = 0
    mip_map_count: int = 0
    format: DDSFormat = DDSFormat.UNKNOWN
    caps: int = 0
    caps2: int = 0

class DDSIO:
    """DDS texture loader class"""
    
    DDS_MAGIC = 0x20534444  # "DDS " in ASCII
    
    def __init__(self):
        """Initialize DDS loader"""
        pass
    
    def load(self, data: bytes) -> Optional[np.ndarray]:
        """
        Load DDS texture from bytes
        
        Args:
            data (bytes): Raw DDS file data
            
        Returns:
            Optional[np.ndarray]: Texture data as numpy array if successful
        """
        try:
            # Check magic number
            if len(data) < 4:
                logger.error("DDS data too short")
                return None
                
            magic = int.from_bytes(data[0:4], byteorder='little')
            if magic != self.DDS_MAGIC:
                logger.error(f"Invalid DDS magic number: {magic:08X}")
                return None
            
            # Parse header
            header = self._parse_header(data[4:128])
            if not header:
                return None
            
            # Get pixel data
            pixel_data = data[128:]
            
            # Decompress/convert based on format
            if header.format == DDSFormat.DXT1:
                return self._decompress_dxt1(pixel_data, header.width, header.height)
            elif header.format == DDSFormat.DXT3:
                return self._decompress_dxt3(pixel_data, header.width, header.height)
            elif header.format == DDSFormat.DXT5:
                return self._decompress_dxt5(pixel_data, header.width, header.height)
            elif header.format == DDSFormat.A8R8G8B8:
                return self._convert_argb(pixel_data, header.width, header.height)
            elif header.format == DDSFormat.X8R8G8B8:
                return self._convert_xrgb(pixel_data, header.width, header.height)
            elif header.format == DDSFormat.R8G8B8:
                return self._convert_rgb(pixel_data, header.width, header.height)
            else:
                logger.error(f"Unsupported DDS format: {header.format}")
                return None
            
        except Exception as e:
            logger.error(f"Error loading DDS texture: {str(e)}")
            return None
    
    def _parse_header(self, data: bytes) -> Optional[DDSHeader]:
        """Parse DDS header data"""
        try:
            header = DDSHeader()
            
            # Parse basic header fields
            header.size = int.from_bytes(data[0:4], byteorder='little')
            header.flags = int.from_bytes(data[4:8], byteorder='little')
            header.height = int.from_bytes(data[8:12], byteorder='little')
            header.width = int.from_bytes(data[12:16], byteorder='little')
            header.pitch_or_linear_size = int.from_bytes(data[16:20], byteorder='little')
            header.depth = int.from_bytes(data[20:24], byteorder='little')
            header.mip_map_count = int.from_bytes(data[24:28], byteorder='little')
            
            # Parse pixel format
            pf_size = int.from_bytes(data[72:76], byteorder='little')
            pf_flags = int.from_bytes(data[76:80], byteorder='little')
            pf_fourcc = int.from_bytes(data[80:84], byteorder='little')
            pf_rgb_bit_count = int.from_bytes(data[84:88], byteorder='little')
            pf_r_bit_mask = int.from_bytes(data[88:92], byteorder='little')
            pf_g_bit_mask = int.from_bytes(data[92:96], byteorder='little')
            pf_b_bit_mask = int.from_bytes(data[96:100], byteorder='little')
            pf_a_bit_mask = int.from_bytes(data[100:104], byteorder='little')
            
            # Determine format
            if pf_flags & 0x4:  # DDPF_FOURCC
                header.format = DDSFormat(pf_fourcc)
            elif pf_flags & 0x40:  # DDPF_RGB
                if pf_rgb_bit_count == 32:
                    if pf_a_bit_mask:
                        header.format = DDSFormat.A8R8G8B8
                    else:
                        header.format = DDSFormat.X8R8G8B8
                elif pf_rgb_bit_count == 24:
                    header.format = DDSFormat.R8G8B8
            
            # Parse capabilities
            header.caps = int.from_bytes(data[104:108], byteorder='little')
            header.caps2 = int.from_bytes(data[108:112], byteorder='little')
            
            return header
            
        except Exception as e:
            logger.error(f"Error parsing DDS header: {str(e)}")
            return None
    
    def _decompress_dxt1(self, data: bytes, width: int, height: int) -> np.ndarray:
        """Decompress DXT1 format"""
        try:
            # DXT1 uses 4x4 blocks, 8 bytes per block
            block_size = 8
            blocks_wide = (width + 3) // 4
            blocks_high = (height + 3) // 4
            
            # Create output array (RGB)
            pixels = np.zeros((height, width, 3), dtype=np.uint8)
            
            # Process each block
            for by in range(blocks_high):
                for bx in range(blocks_wide):
                    # Get block data
                    block_offset = (by * blocks_wide + bx) * block_size
                    if block_offset + block_size > len(data):
                        break
                    
                    block_data = data[block_offset:block_offset + block_size]
                    
                    # Extract color info
                    c0 = int.from_bytes(block_data[0:2], byteorder='little')
                    c1 = int.from_bytes(block_data[2:4], byteorder='little')
                    
                    # Convert 565 to RGB
                    r0 = ((c0 >> 11) & 0x1F) << 3
                    g0 = ((c0 >> 5) & 0x3F) << 2
                    b0 = (c0 & 0x1F) << 3
                    r1 = ((c1 >> 11) & 0x1F) << 3
                    g1 = ((c1 >> 5) & 0x3F) << 2
                    b1 = (c1 & 0x1F) << 3
                    
                    # Create color table
                    colors = np.array([
                        [r0, g0, b0],
                        [r1, g1, b1],
                        [(2*r0 + r1)//3, (2*g0 + g1)//3, (2*b0 + b1)//3],
                        [(r0 + 2*r1)//3, (g0 + 2*g1)//3, (b0 + 2*b1)//3]
                    ], dtype=np.uint8)
                    
                    # Extract indices
                    indices = int.from_bytes(block_data[4:8], byteorder='little')
                    
                    # Write pixels
                    for py in range(4):
                        for px in range(4):
                            x = bx * 4 + px
                            y = by * 4 + py
                            if x < width and y < height:
                                idx = (indices >> (2 * (py * 4 + px))) & 0x3
                                pixels[y, x] = colors[idx]
            
            return pixels
            
        except Exception as e:
            logger.error(f"Error decompressing DXT1: {str(e)}")
            return np.array([])
    
    def _decompress_dxt3(self, data: bytes, width: int, height: int) -> np.ndarray:
        """Decompress DXT3 format"""
        try:
            # DXT3 uses 4x4 blocks, 16 bytes per block
            block_size = 16
            blocks_wide = (width + 3) // 4
            blocks_high = (height + 3) // 4
            
            # Create output array (RGBA)
            pixels = np.zeros((height, width, 4), dtype=np.uint8)
            
            # Process each block
            for by in range(blocks_high):
                for bx in range(blocks_wide):
                    # Get block data
                    block_offset = (by * blocks_wide + bx) * block_size
                    if block_offset + block_size > len(data):
                        break
                    
                    block_data = data[block_offset:block_offset + block_size]
                    
                    # Extract alpha values (4 bits per pixel)
                    alpha = int.from_bytes(block_data[0:8], byteorder='little')
                    
                    # Extract color info
                    c0 = int.from_bytes(block_data[8:10], byteorder='little')
                    c1 = int.from_bytes(block_data[10:12], byteorder='little')
                    
                    # Convert 565 to RGB
                    r0 = ((c0 >> 11) & 0x1F) << 3
                    g0 = ((c0 >> 5) & 0x3F) << 2
                    b0 = (c0 & 0x1F) << 3
                    r1 = ((c1 >> 11) & 0x1F) << 3
                    g1 = ((c1 >> 5) & 0x3F) << 2
                    b1 = (c1 & 0x1F) << 3
                    
                    # Create color table
                    colors = np.array([
                        [r0, g0, b0],
                        [r1, g1, b1],
                        [(2*r0 + r1)//3, (2*g0 + g1)//3, (2*b0 + b1)//3],
                        [(r0 + 2*r1)//3, (g0 + 2*g1)//3, (b0 + 2*b1)//3]
                    ], dtype=np.uint8)
                    
                    # Extract color indices
                    indices = int.from_bytes(block_data[12:16], byteorder='little')
                    
                    # Write pixels
                    for py in range(4):
                        for px in range(4):
                            x = bx * 4 + px
                            y = by * 4 + py
                            if x < width and y < height:
                                # Get color index
                                idx = (indices >> (2 * (py * 4 + px))) & 0x3
                                color = colors[idx]
                                
                                # Get alpha
                                a_idx = py * 4 + px
                                a = ((alpha >> (4 * a_idx)) & 0xF) << 4
                                
                                pixels[y, x] = [color[0], color[1], color[2], a]
            
            return pixels
            
        except Exception as e:
            logger.error(f"Error decompressing DXT3: {str(e)}")
            return np.array([])
    
    def _decompress_dxt5(self, data: bytes, width: int, height: int) -> np.ndarray:
        """Decompress DXT5 format"""
        try:
            # DXT5 uses 4x4 blocks, 16 bytes per block
            block_size = 16
            blocks_wide = (width + 3) // 4
            blocks_high = (height + 3) // 4
            
            # Create output array (RGBA)
            pixels = np.zeros((height, width, 4), dtype=np.uint8)
            
            # Process each block
            for by in range(blocks_high):
                for bx in range(blocks_wide):
                    # Get block data
                    block_offset = (by * blocks_wide + bx) * block_size
                    if block_offset + block_size > len(data):
                        break
                    
                    block_data = data[block_offset:block_offset + block_size]
                    
                    # Extract alpha endpoints
                    a0 = block_data[0]
                    a1 = block_data[1]
                    
                    # Create alpha table
                    alphas = np.zeros(8, dtype=np.uint8)
                    alphas[0] = a0
                    alphas[1] = a1
                    if a0 > a1:
                        # 8-alpha block
                        for i in range(6):
                            alphas[i+2] = ((6-i)*a0 + (i+1)*a1) // 7
                    else:
                        # 6-alpha block
                        for i in range(4):
                            alphas[i+2] = ((4-i)*a0 + (i+1)*a1) // 5
                        alphas[6] = 0
                        alphas[7] = 255
                    
                    # Extract alpha indices (3 bits each)
                    alpha_indices = int.from_bytes(block_data[2:8], byteorder='little')
                    
                    # Extract color info
                    c0 = int.from_bytes(block_data[8:10], byteorder='little')
                    c1 = int.from_bytes(block_data[10:12], byteorder='little')
                    
                    # Convert 565 to RGB
                    r0 = ((c0 >> 11) & 0x1F) << 3
                    g0 = ((c0 >> 5) & 0x3F) << 2
                    b0 = (c0 & 0x1F) << 3
                    r1 = ((c1 >> 11) & 0x1F) << 3
                    g1 = ((c1 >> 5) & 0x3F) << 2
                    b1 = (c1 & 0x1F) << 3
                    
                    # Create color table
                    colors = np.array([
                        [r0, g0, b0],
                        [r1, g1, b1],
                        [(2*r0 + r1)//3, (2*g0 + g1)//3, (2*b0 + b1)//3],
                        [(r0 + 2*r1)//3, (g0 + 2*g1)//3, (b0 + 2*b1)//3]
                    ], dtype=np.uint8)
                    
                    # Extract color indices
                    color_indices = int.from_bytes(block_data[12:16], byteorder='little')
                    
                    # Write pixels
                    for py in range(4):
                        for px in range(4):
                            x = bx * 4 + px
                            y = by * 4 + py
                            if x < width and y < height:
                                # Get color
                                color_idx = (color_indices >> (2 * (py * 4 + px))) & 0x3
                                color = colors[color_idx]
                                
                                # Get alpha
                                alpha_idx = ((alpha_indices >> (3 * (py * 4 + px))) & 0x7)
                                alpha = alphas[alpha_idx]
                                
                                pixels[y, x] = [color[0], color[1], color[2], alpha]
            
            return pixels
            
        except Exception as e:
            logger.error(f"Error decompressing DXT5: {str(e)}")
            return np.array([])
    
    def _convert_argb(self, data: bytes, width: int, height: int) -> np.ndarray:
        """Convert A8R8G8B8 format"""
        try:
            # Create output array (RGBA)
            pixels = np.zeros((height, width, 4), dtype=np.uint8)
            
            # Process each pixel
            for y in range(height):
                for x in range(width):
                    offset = (y * width + x) * 4
                    if offset + 4 > len(data):
                        break
                    
                    # Extract ARGB components
                    b = data[offset]
                    g = data[offset + 1]
                    r = data[offset + 2]
                    a = data[offset + 3]
                    
                    pixels[y, x] = [r, g, b, a]
            
            return pixels
            
        except Exception as e:
            logger.error(f"Error converting ARGB: {str(e)}")
            return np.array([])
    
    def _convert_xrgb(self, data: bytes, width: int, height: int) -> np.ndarray:
        """Convert X8R8G8B8 format"""
        try:
            # Create output array (RGB)
            pixels = np.zeros((height, width, 3), dtype=np.uint8)
            
            # Process each pixel
            for y in range(height):
                for x in range(width):
                    offset = (y * width + x) * 4
                    if offset + 4 > len(data):
                        break
                    
                    # Extract RGB components (ignore X)
                    b = data[offset]
                    g = data[offset + 1]
                    r = data[offset + 2]
                    
                    pixels[y, x] = [r, g, b]
            
            return pixels
            
        except Exception as e:
            logger.error(f"Error converting XRGB: {str(e)}")
            return np.array([])
    
    def _convert_rgb(self, data: bytes, width: int, height: int) -> np.ndarray:
        """Convert R8G8B8 format"""
        try:
            # Create output array (RGB)
            pixels = np.zeros((height, width, 3), dtype=np.uint8)
            
            # Process each pixel
            for y in range(height):
                for x in range(width):
                    offset = (y * width + x) * 3
                    if offset + 3 > len(data):
                        break
                    
                    # Extract RGB components
                    b = data[offset]
                    g = data[offset + 1]
                    r = data[offset + 2]
                    
                    pixels[y, x] = [r, g, b]
            
            return pixels
            
        except Exception as e:
            logger.error(f"Error converting RGB: {str(e)}")
            return np.array([]) 