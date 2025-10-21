"""
Meta builder for GTA5 files
Based on CodeWalker's implementation
"""

import logging
from typing import Dict, List, Any, Optional
import numpy as np
from dataclasses import dataclass
from .meta import Meta, MetaName, MetaType, MetaBlock, MetaStructureInfo, MetaEnumInfo
from .hash import jenkins_hash

logger = logging.getLogger(__name__)

@dataclass
class MetaBuilderBlock:
    """Block being built by MetaBuilder"""
    structure_name_hash: int
    items: List[bytes]
    total_size: int = 0
    index: int = 0
    
    def add_item(self, item: bytes) -> int:
        """Add an item to the block and return its index"""
        idx = len(self.items)
        self.items.append(item)
        self.total_size += len(item)
        return idx
        
    @property
    def base_pointer(self) -> int:
        """Get base pointer for this block"""
        return ((self.index + 1) & 0xFFF)
        
    def get_meta_block(self) -> Optional[MetaBlock]:
        """Convert to MetaBlock"""
        if self.total_size <= 0:
            return None
            
        # Combine all items into one data block
        data = bytearray(self.total_size)
        offset = 0
        for item in self.items:
            data[offset:offset + len(item)] = item
            offset += len(item)
            
        block = MetaBlock(data)
        block.structure_name_hash = self.structure_name_hash
        block.data_length = self.total_size
        return block

@dataclass
class MetaBuilderPointer:
    """Pointer being built by MetaBuilder"""
    block_id: int  # 1-based id
    offset: int  # byte offset
    length: int = 0  # for temp use
    
    @property
    def pointer(self) -> int:
        """Get pointer value"""
        block_idx = (self.block_id & 0xFFF)
        offset = (self.offset & 0xFFFFF) << 12
        return block_idx + offset

class MetaBuilder:
    """Builds meta data structures"""
    def __init__(self):
        self.blocks: List[MetaBuilderBlock] = []
        self.structure_infos: Dict[MetaName, MetaStructureInfo] = {}
        self.enum_infos: Dict[MetaName, MetaEnumInfo] = {}
        
    def ensure_block(self, name: MetaName) -> MetaBuilderBlock:
        """Ensure a block exists for the given name"""
        # Find existing block
        for block in self.blocks:
            if block.structure_name_hash == name:
                return block
                
        # Create new block
        block = MetaBuilderBlock(
            structure_name_hash=name,
            items=[],
            index=len(self.blocks)
        )
        self.blocks.append(block)
        return block
        
    def add_item(self, name: MetaName, data: bytes) -> MetaBuilderPointer:
        """Add an item to a block"""
        block = self.ensure_block(name)
        offset = block.total_size
        idx = block.add_item(data)
        return MetaBuilderPointer(block.index + 1, offset)
        
    def add_string(self, text: str) -> MetaBuilderPointer:
        """Add a string"""
        if not text:
            return MetaBuilderPointer(0, 0)
            
        # Add null-terminated string
        data = text.encode('utf-8') + b'\0'
        return self.add_item(MetaName.STRING, data)
        
    def add_hash(self, hash_val: int) -> MetaBuilderPointer:
        """Add a hash value"""
        data = hash_val.to_bytes(4, 'little')
        return self.add_item(MetaName.HASH, data)
        
    def add_float(self, value: float) -> MetaBuilderPointer:
        """Add a float value"""
        data = np.float32(value).tobytes()
        return self.add_item(MetaName.FLOAT, data)
        
    def add_vector3(self, vector: np.ndarray) -> MetaBuilderPointer:
        """Add a Vector3"""
        data = vector.astype(np.float32).tobytes()
        return self.add_item(MetaName.VECTOR3, data)
        
    def add_vector4(self, vector: np.ndarray) -> MetaBuilderPointer:
        """Add a Vector4"""
        data = vector.astype(np.float32).tobytes()
        return self.add_item(MetaName.VECTOR4, data)
        
    def add_array(self, items: List[Any], item_type: MetaType) -> MetaBuilderPointer:
        """Add an array of items"""
        if not items:
            return MetaBuilderPointer(0, 0)
            
        # Convert items to bytes based on type
        data = bytearray()
        for item in items:
            if item_type == MetaType.FLOAT:
                data.extend(np.float32(item).tobytes())
            elif item_type == MetaType.INT:
                data.extend(int(item).to_bytes(4, 'little'))
            elif item_type == MetaType.VECTOR3:
                data.extend(item.astype(np.float32).tobytes())
            elif item_type == MetaType.VECTOR4:
                data.extend(item.astype(np.float32).tobytes())
            else:
                raise ValueError(f"Unsupported array item type: {item_type}")
                
        return self.add_item(MetaName.ARRAY, data)
        
    def add_structure_info(self, name: MetaName):
        """Add structure info"""
        if name not in self.structure_infos:
            info = MetaStructureInfo(
                structure_name_hash=name,
                structure_key=jenkins_hash(str(name)),
                structure_size=0,  # Will be set later
                entries=[]  # Will be set later
            )
            self.structure_infos[name] = info
            
    def add_enum_info(self, name: MetaName):
        """Add enum info"""
        if name not in self.enum_infos:
            info = MetaEnumInfo(
                enum_name_hash=name,
                enum_key=jenkins_hash(str(name)),
                entries=[]  # Will be set later
            )
            self.enum_infos[name] = info
            
    def get_meta(self, name: str = "") -> Meta:
        """Get built Meta object"""
        meta = Meta(bytearray())  # Empty meta to be filled
        
        # Set basic properties
        meta.unknown_10h = 0x50524430
        meta.unknown_14h = 0x0079
        meta.root_block_index = 1  # First block is root
        
        # Add structure infos
        if self.structure_infos:
            meta.structure_infos = list(self.structure_infos.values())
            meta.structure_infos_count = len(meta.structure_infos)
            
        # Add enum infos
        if self.enum_infos:
            meta.enum_infos = list(self.enum_infos.values())
            meta.enum_infos_count = len(meta.enum_infos)
            
        # Add data blocks
        meta.blocks = []
        for block in self.blocks:
            meta_block = block.get_meta_block()
            if meta_block:
                meta.blocks.append(meta_block)
        meta.data_blocks_count = len(meta.blocks)
        
        # Set name
        meta.name = name
        
        return meta 