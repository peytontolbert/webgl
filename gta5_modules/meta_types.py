"""
Meta types and data conversion for GTA5 files
Based on CodeWalker's implementation
"""

import logging
import struct
from enum import IntEnum
from typing import Optional, List, Dict, Any, TypeVar, Type, Generic
import numpy as np
from dataclasses import dataclass
from .meta import Meta, MetaName, MetaType, MetaBlock, MetaStructureInfo, MetaEnumInfo

logger = logging.getLogger(__name__)

class MetaStructureEntryDataType(IntEnum):
    """Meta structure entry data types from CodeWalker"""
    Boolean = 0x01
    SignedByte = 0x10
    UnsignedByte = 0x11
    SignedShort = 0x12
    UnsignedShort = 0x13
    SignedInt = 0x14
    UnsignedInt = 0x15
    Float = 0x21
    Float_XYZ = 0x33
    Float_XYZW = 0x34
    ByteEnum = 0x60
    IntEnum = 0x62
    ShortFlags = 0x64
    IntFlags1 = 0x63
    IntFlags2 = 0x65
    Hash = 0x4A
    Array = 0x52
    ArrayOfChars = 0x40
    ArrayOfBytes = 0x50
    DataBlockPointer = 0x59
    CharPointer = 0x44
    StructurePointer = 0x07
    Structure = 0x05

@dataclass
class Array_Structure:
    """Structure array"""
    Count1: int = 0
    Pointer: int = 0

@dataclass
class Array_StructurePointer:
    """Structure pointer array"""
    Count1: int = 0
    Pointer: int = 0

@dataclass
class Array_uint:
    """Unsigned int array"""
    Count1: int = 0
    Pointer: int = 0

@dataclass
class Array_ushort:
    """Unsigned short array"""
    Count1: int = 0
    Pointer: int = 0

@dataclass
class Array_byte:
    """Byte array"""
    Count1: int = 0
    Pointer: int = 0

@dataclass
class Array_float:
    """Float array"""
    Count1: int = 0
    Pointer: int = 0

@dataclass
class Array_Vector3:
    """Vector3 array"""
    Count1: int = 0
    Pointer: int = 0

T = TypeVar('T')

class MetaTypes:
    """Helper class for parsing meta data"""
    
    @staticmethod
    def get_structure_info(name: MetaName) -> Optional[MetaStructureInfo]:
        """Get structure info for a meta name"""
        # This would contain all the hardcoded structure definitions
        # from CodeWalker's implementation
        pass
        
    @staticmethod
    def get_enum_info(name: MetaName) -> Optional[MetaEnumInfo]:
        """Get enum info for a meta name"""
        # This would contain all the hardcoded enum definitions
        # from CodeWalker's implementation
        pass
        
    @staticmethod
    def convert_data(data: bytes, offset: int = 0) -> Any:
        """Convert raw bytes to appropriate data type"""
        if not data:
            return None
            
        # Use struct to unpack the data based on type
        return struct.unpack_from('<I', data, offset)[0]
        
    @staticmethod
    def convert_data_array(data: bytes, offset: int, count: int, item_size: int) -> List[Any]:
        """Convert array of raw bytes to list of items"""
        if not data:
            return []
            
        result = []
        for i in range(count):
            item_offset = offset + (i * item_size)
            item = MetaTypes.convert_data(data, item_offset)
            result.append(item)
        return result
        
    @staticmethod
    def get_typed_data(meta: Meta, name: MetaName, data_type: Type[T]) -> Optional[T]:
        """Get typed data from meta block"""
        try:
            for block in meta.blocks:
                if block.structure_name_hash == name:
                    return MetaTypes.convert_data(block.data)
            return None
        except Exception as e:
            logger.error(f"Error getting typed data for {name}: {str(e)}")
            return None
            
    @staticmethod
    def get_pointer_array(meta: Meta, array: Array_StructurePointer) -> List[Any]:
        """Get array of pointers from array structure"""
        try:
            if not array or array.Count1 <= 0:
                return []
                
            result = []
            offset = array.Pointer
            for _ in range(array.Count1):
                block_idx = meta.get_uint32(offset)
                if 0 < block_idx <= len(meta.blocks):
                    result.append(meta.blocks[block_idx - 1])
                offset += 4
                
            return result
            
        except Exception as e:
            logger.error(f"Error getting pointer array: {str(e)}")
            return []
            
    @staticmethod
    def get_array_data(meta: Meta, array: Any, item_type: MetaStructureEntryDataType) -> List[Any]:
        """Get array data based on type"""
        try:
            if not array or array.Count1 <= 0:
                return []
                
            if item_type == MetaStructureEntryDataType.Structure:
                return MetaTypes.get_structure_array(meta, array)
            elif item_type == MetaStructureEntryDataType.StructurePointer:
                return MetaTypes.get_pointer_array(meta, array)
            elif item_type == MetaStructureEntryDataType.Float:
                return MetaTypes.get_float_array(meta, array)
            elif item_type == MetaStructureEntryDataType.Float_XYZ:
                return MetaTypes.get_vector3_array(meta, array)
            elif item_type == MetaStructureEntryDataType.UnsignedInt:
                return MetaTypes.get_uint_array(meta, array)
            elif item_type == MetaStructureEntryDataType.Hash:
                return MetaTypes.get_hash_array(meta, array)
            else:
                logger.warning(f"Unsupported array item type: {item_type}")
                return []
                
        except Exception as e:
            logger.error(f"Error getting array data: {str(e)}")
            return []
            
    @staticmethod
    def get_structure_array(meta: Meta, array: Array_Structure) -> List[Any]:
        """Get array of structures"""
        try:
            if not array or array.Count1 <= 0:
                return []
                
            block = meta.get_block(array.Pointer)
            if not block:
                return []
                
            # Get structure info
            structure_info = meta.get_structure_info(block.structure_name_hash)
            if not structure_info:
                return []
                
            result = []
            offset = 0
            for _ in range(array.Count1):
                structure = {}
                for entry in structure_info.entries:
                    value = MetaTypes.get_entry_value(meta, block, offset + entry.offset, entry)
                    structure[entry.name] = value
                result.append(structure)
                offset += structure_info.size
                
            return result
            
        except Exception as e:
            logger.error(f"Error getting structure array: {str(e)}")
            return []
            
    @staticmethod
    def get_entry_value(meta: Meta, block: MetaBlock, offset: int, entry: Any) -> Any:
        """Get value for a structure entry"""
        try:
            if entry.data_type == MetaStructureEntryDataType.Boolean:
                return bool(block.get_uint32(offset))
            elif entry.data_type == MetaStructureEntryDataType.SignedByte:
                return struct.unpack_from('b', block.data, offset)[0]
            elif entry.data_type == MetaStructureEntryDataType.UnsignedByte:
                return struct.unpack_from('B', block.data, offset)[0]
            elif entry.data_type == MetaStructureEntryDataType.SignedShort:
                return struct.unpack_from('h', block.data, offset)[0]
            elif entry.data_type == MetaStructureEntryDataType.UnsignedShort:
                return struct.unpack_from('H', block.data, offset)[0]
            elif entry.data_type == MetaStructureEntryDataType.SignedInt:
                return struct.unpack_from('i', block.data, offset)[0]
            elif entry.data_type == MetaStructureEntryDataType.UnsignedInt:
                return struct.unpack_from('I', block.data, offset)[0]
            elif entry.data_type == MetaStructureEntryDataType.Float:
                return struct.unpack_from('f', block.data, offset)[0]
            elif entry.data_type == MetaStructureEntryDataType.Float_XYZ:
                return np.array([
                    struct.unpack_from('f', block.data, offset)[0],
                    struct.unpack_from('f', block.data, offset + 4)[0],
                    struct.unpack_from('f', block.data, offset + 8)[0]
                ], dtype=np.float32)
            elif entry.data_type == MetaStructureEntryDataType.Float_XYZW:
                return np.array([
                    struct.unpack_from('f', block.data, offset)[0],
                    struct.unpack_from('f', block.data, offset + 4)[0],
                    struct.unpack_from('f', block.data, offset + 8)[0],
                    struct.unpack_from('f', block.data, offset + 12)[0]
                ], dtype=np.float32)
            elif entry.data_type == MetaStructureEntryDataType.Hash:
                return block.get_hash(offset)
            elif entry.data_type == MetaStructureEntryDataType.Array:
                array_info = entry.array_info
                if not array_info:
                    return []
                return MetaTypes.get_array_data(meta, block.get_uint32(offset), array_info.item_type)
            elif entry.data_type == MetaStructureEntryDataType.Structure:
                structure_info = meta.get_structure_info(entry.reference_key)
                if not structure_info:
                    return {}
                structure = {}
                for struct_entry in structure_info.entries:
                    value = MetaTypes.get_entry_value(meta, block, offset + struct_entry.offset, struct_entry)
                    structure[struct_entry.name] = value
                return structure
            else:
                logger.warning(f"Unsupported entry data type: {entry.data_type}")
                return None
                
        except Exception as e:
            logger.error(f"Error getting entry value: {str(e)}")
            return None 