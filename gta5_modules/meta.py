"""
Meta data handling for GTA5 files
Based on CodeWalker's implementation
"""

import logging
import struct
from enum import IntEnum
from typing import Optional, List, Dict, Any, TypeVar, Type
import numpy as np
from dataclasses import dataclass
from .hash import jenkins_hash

logger = logging.getLogger(__name__)

class MetaType(IntEnum):
    """Meta data types from CodeWalker"""
    NONE = 0
    STRING = 1
    HASH = 2
    FLOAT = 3
    INT = 4
    SHORT = 5
    BYTE = 6
    BOOL = 7
    VECTOR3 = 8
    VECTOR4 = 9
    MATRIX3X3 = 10
    MATRIX4X4 = 11
    ARRAY = 12
    POINTER = 13
    STRUCT = 14
    ENUM = 15

class MetaName(IntEnum):
    """Meta block names from CodeWalker"""
    CMapData = 0
    CEntityDef = 1
    CMloInstanceDef = 2
    rage__fwInstancedMapData = 3
    rage__fwGrassInstanceListDef = 4
    rage__fwGrassInstanceListDef__InstanceData = 5
    CLODLight = 6
    CDistantLODLight = 7
    BoxOccluder = 8
    OccludeModel = 9
    FloatXYZ = 10

@dataclass
class MetaStructureEntryInfo:
    """Information about a meta structure entry"""
    name_hash: int
    data_offset: int
    data_type: MetaType
    unknown_9h: int = 0
    reference_type_index: int = 0
    reference_key: int = 0

@dataclass
class MetaStructureInfo:
    """Information about a meta structure"""
    structure_name_hash: int
    structure_key: int
    structure_size: int
    entries: List[MetaStructureEntryInfo]
    unknown_8h: int = 0
    unknown_ch: int = 0

@dataclass
class MetaEnumEntryInfo:
    """Information about a meta enum entry"""
    entry_name_hash: int
    entry_value: int

@dataclass
class MetaEnumInfo:
    """Information about a meta enum"""
    enum_name_hash: int
    enum_key: int
    entries: List[MetaEnumEntryInfo]

class MetaBlock:
    """Represents a block of meta data"""
    def __init__(self, data: bytes, offset: int = 0):
        self.data = data
        self.offset = offset
        self.size = len(data)
        self.structure_name_hash: int = 0
        self.data_length: int = 0
        self.data_pointer: int = 0
        
    def read_header(self):
        """Read block header"""
        self.structure_name_hash = self.get_uint32(0)
        self.data_length = self.get_uint32(4)
        self.data_pointer = self.get_uint64(8)
        
    def get_uint32(self, offset: int) -> int:
        """Get unsigned 32-bit integer at offset"""
        return struct.unpack_from('<I', self.data, self.offset + offset)[0]
        
    def get_int32(self, offset: int) -> int:
        """Get signed 32-bit integer at offset"""
        return struct.unpack_from('<i', self.data, self.offset + offset)[0]
        
    def get_uint64(self, offset: int) -> int:
        """Get unsigned 64-bit integer at offset"""
        return struct.unpack_from('<Q', self.data, self.offset + offset)[0]
        
    def get_float(self, offset: int) -> float:
        """Get 32-bit float at offset"""
        return struct.unpack_from('<f', self.data, self.offset + offset)[0]
        
    def get_vector3(self, offset: int) -> np.ndarray:
        """Get Vector3 at offset"""
        x = self.get_float(offset)
        y = self.get_float(offset + 4)
        z = self.get_float(offset + 8)
        return np.array([x, y, z], dtype=np.float32)
        
    def get_vector4(self, offset: int) -> np.ndarray:
        """Get Vector4 at offset"""
        x = self.get_float(offset)
        y = self.get_float(offset + 4)
        z = self.get_float(offset + 8)
        w = self.get_float(offset + 12)
        return np.array([x, y, z, w], dtype=np.float32)
        
    def get_string(self, offset: int) -> str:
        """Get null-terminated string at offset"""
        end = self.data.find(b'\0', self.offset + offset)
        if end < 0:
            end = self.size
        return self.data[self.offset + offset:end].decode('utf-8')
        
    def get_hash(self, offset: int) -> int:
        """Get hash value at offset"""
        return self.get_uint32(offset)
        
    def get_enum(self, offset: int) -> int:
        """Get enum value at offset"""
        return self.get_int32(offset)

class Meta:
    """Main meta data handler"""
    def __init__(self, data: bytes):
        self.data = data
        self.blocks: List[MetaBlock] = []
        self.strings: List[str] = []
        self.structure_infos: Dict[int, MetaStructureInfo] = {}
        self.enum_infos: Dict[int, MetaEnumInfo] = {}
        self.root_block_index: int = 0
        self.has_encrypted_strings: bool = False
        self.unknown_10h: int = 0x50524430
        self.unknown_14h: int = 0x0079
        self.unknown_17h: int = 0x00
        self.unknown_18h: int = 0x00000000
        self.structure_infos_pointer: int = 0
        self.enum_infos_pointer: int = 0
        self.data_blocks_pointer: int = 0
        self.name_pointer: int = 0
        self.encrypted_strings_pointer: int = 0
        self.structure_infos_count: int = 0
        self.enum_infos_count: int = 0
        self.data_blocks_count: int = 0
        self.unknown_4eh: int = 0x0000
        self.unknown_50h: int = 0x00000000
        self.unknown_54h: int = 0x00000000
        self.unknown_58h: int = 0x00000000
        self.unknown_5ch: int = 0x00000000
        self.unknown_60h: int = 0x00000000
        self.unknown_64h: int = 0x00000000
        self.unknown_68h: int = 0x00000000
        self.unknown_6ch: int = 0x00000000
        self._parse_header()
        
    def _parse_header(self):
        """Parse meta data header"""
        try:
            # Parse magic and version
            magic = struct.unpack_from('<I', self.data, 0)[0]
            version = struct.unpack_from('<I', self.data, 4)[0]
            
            if magic != 0x4D455441:  # 'META'
                raise ValueError(f"Invalid meta magic: {magic:08X}")
                
            # Parse header fields (matching CodeWalker)
            self.unknown_10h = struct.unpack_from('<I', self.data, 0x10)[0]  # Should be 0x50524430
            self.unknown_14h = struct.unpack_from('<H', self.data, 0x14)[0]  # Should be 0x0079
            self.has_encrypted_strings = bool(struct.unpack_from('B', self.data, 0x16)[0])
            self.unknown_17h = struct.unpack_from('B', self.data, 0x17)[0]  # Should be 0x00
            self.unknown_18h = struct.unpack_from('<I', self.data, 0x18)[0]  # Should be 0x00000000
            self.root_block_index = struct.unpack_from('<I', self.data, 0x1C)[0]
            
            # Parse pointers
            self.structure_infos_pointer = struct.unpack_from('<Q', self.data, 0x20)[0]
            self.enum_infos_pointer = struct.unpack_from('<Q', self.data, 0x28)[0]
            self.data_blocks_pointer = struct.unpack_from('<Q', self.data, 0x30)[0]
            self.name_pointer = struct.unpack_from('<Q', self.data, 0x38)[0]
            self.encrypted_strings_pointer = struct.unpack_from('<Q', self.data, 0x40)[0]
            
            # Parse counts
            self.structure_infos_count = struct.unpack_from('<H', self.data, 0x48)[0]
            self.enum_infos_count = struct.unpack_from('<H', self.data, 0x4A)[0]
            self.data_blocks_count = struct.unpack_from('<H', self.data, 0x4C)[0]
            
            # Parse blocks
            offset = 0x50  # Start of blocks
            for _ in range(self.data_blocks_count):
                block = MetaBlock(self.data[offset:], offset)
                block.read_header()
                self.blocks.append(block)
                offset += block.size
                
            # Parse structure infos
            if self.structure_infos_pointer and self.structure_infos_count:
                self._parse_structure_infos()
                
            # Parse enum infos
            if self.enum_infos_pointer and self.enum_infos_count:
                self._parse_enum_infos()
                
        except Exception as e:
            logger.error(f"Error parsing meta header: {str(e)}")
            raise
            
    def _parse_structure_infos(self):
        """Parse structure info blocks"""
        try:
            offset = self.structure_infos_pointer
            for _ in range(self.structure_infos_count):
                # Parse structure info header
                name_hash = struct.unpack_from('<I', self.data, offset)[0]
                structure_key = struct.unpack_from('<I', self.data, offset + 4)[0]
                unknown_8h = struct.unpack_from('<I', self.data, offset + 8)[0]
                unknown_ch = struct.unpack_from('<I', self.data, offset + 0xC)[0]
                entries_pointer = struct.unpack_from('<Q', self.data, offset + 0x10)[0]
                structure_size = struct.unpack_from('<I', self.data, offset + 0x18)[0]
                entries_count = struct.unpack_from('<H', self.data, offset + 0x1E)[0]
                
                # Parse entries
                entries = []
                entry_offset = entries_pointer
                for _ in range(entries_count):
                    entry = MetaStructureEntryInfo(
                        name_hash=struct.unpack_from('<I', self.data, entry_offset)[0],
                        data_offset=struct.unpack_from('<I', self.data, entry_offset + 4)[0],
                        data_type=MetaType(struct.unpack_from('B', self.data, entry_offset + 8)[0]),
                        unknown_9h=struct.unpack_from('B', self.data, entry_offset + 9)[0],
                        reference_type_index=struct.unpack_from('<H', self.data, entry_offset + 0xA)[0],
                        reference_key=struct.unpack_from('<I', self.data, entry_offset + 0xC)[0]
                    )
                    entries.append(entry)
                    entry_offset += 0x10
                    
                # Create structure info
                structure_info = MetaStructureInfo(
                    structure_name_hash=name_hash,
                    structure_key=structure_key,
                    structure_size=structure_size,
                    entries=entries,
                    unknown_8h=unknown_8h,
                    unknown_ch=unknown_ch
                )
                self.structure_infos[name_hash] = structure_info
                
                offset += 0x20  # Size of structure info
                
        except Exception as e:
            logger.error(f"Error parsing structure infos: {str(e)}")
            
    def _parse_enum_infos(self):
        """Parse enum info blocks"""
        try:
            offset = self.enum_infos_pointer
            for _ in range(self.enum_infos_count):
                # Parse enum info header
                name_hash = struct.unpack_from('<I', self.data, offset)[0]
                enum_key = struct.unpack_from('<I', self.data, offset + 4)[0]
                entries_pointer = struct.unpack_from('<Q', self.data, offset + 8)[0]
                entries_count = struct.unpack_from('<I', self.data, offset + 0x10)[0]
                
                # Parse entries
                entries = []
                entry_offset = entries_pointer
                for _ in range(entries_count):
                    entry = MetaEnumEntryInfo(
                        entry_name_hash=struct.unpack_from('<I', self.data, entry_offset)[0],
                        entry_value=struct.unpack_from('<I', self.data, entry_offset + 4)[0]
                    )
                    entries.append(entry)
                    entry_offset += 8
                    
                # Create enum info
                enum_info = MetaEnumInfo(
                    enum_name_hash=name_hash,
                    enum_key=enum_key,
                    entries=entries
                )
                self.enum_infos[name_hash] = enum_info
                
                offset += 0x18  # Size of enum info
                
        except Exception as e:
            logger.error(f"Error parsing enum infos: {str(e)}")
            
    def get_root_block(self) -> Optional[MetaBlock]:
        """Get the root data block"""
        if self.root_block_index <= 0 or self.root_block_index > len(self.blocks):
            return None
        return self.blocks[self.root_block_index - 1]
        
    def get_block(self, index: int) -> Optional[MetaBlock]:
        """Get data block by index"""
        if index <= 0 or index > len(self.blocks):
            return None
        return self.blocks[index - 1]
        
    def find_block(self, name: MetaName) -> Optional[MetaBlock]:
        """Find data block by name"""
        for block in self.blocks:
            if block.structure_name_hash == name:
                return block
        return None
        
    def get_structure_info(self, name: MetaName) -> Optional[MetaStructureInfo]:
        """Get structure info by name"""
        return self.structure_infos.get(name)
        
    def get_enum_info(self, name: MetaName) -> Optional[MetaEnumInfo]:
        """Get enum info by name"""
        return self.enum_infos.get(name)

    def get_pointer_array(self, ptr: Any) -> List[Any]:
        """Get array of pointers from pointer"""
        try:
            if not ptr or not hasattr(ptr, 'Count1'):
                return []
                
            count = ptr.Count1
            if count <= 0:
                return []
                
            result = []
            offset = ptr.Offset
            
            for _ in range(count):
                block_idx = self.get_uint32(offset)
                if 0 < block_idx <= len(self.blocks):
                    result.append(self.blocks[block_idx - 1])
                offset += 4
                
            return result
            
        except Exception as e:
            logger.error(f"Error getting pointer array: {str(e)}")
            return []
            
    def get_strings(self) -> List[str]:
        """Get all strings from string block"""
        try:
            if not self.strings:
                # Find string block
                for block in self.blocks:
                    if block.get_uint32(0) == MetaType.STRING:
                        # Parse strings
                        offset = 4
                        while offset < block.size:
                            string = block.get_string(offset)
                            if not string:
                                break
                            self.strings.append(string)
                            offset += len(string) + 1
                            
            return self.strings
            
        except Exception as e:
            logger.error(f"Error getting strings: {str(e)}")
 