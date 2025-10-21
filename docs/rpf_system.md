# CodeWalker RPF System Documentation

## Overview
The RPF system handles GTA5's RPF archive files, which contain game resources including maps, models, textures, and other assets.

## Table of Contents
1. [RPF File Structure](#rpf-file-structure)
2. [RPF Manager](#rpf-manager)
3. [RPF Reader](#rpf-reader)
4. [Entry Types](#entry-types)
5. [Encryption Handling](#encryption-handling)

## RPF File Structure

### RpfFile Class
```csharp
// C# Implementation
public class RpfFile {
    public string Name { get; set; }
    public string Path { get; set; }
    public RpfEncryption Encryption { get; set; }
    public List<RpfEntry> AllEntries { get; set; }
    public List<RpfFile> Children { get; set; }
    public RpfFile Parent { get; set; }
    public RpfDirectoryEntry Root { get; set; }
}
```

```python
# Python Implementation
@dataclass
class RpfFile:
    name: str
    path: str
    encryption: RpfEncryption
    all_entries: List['RpfEntry'] = field(default_factory=list)
    children: List['RpfFile'] = field(default_factory=list)
    parent: Optional['RpfFile'] = None
    root: Optional['RpfDirectoryEntry'] = None
```

### RpfEncryption Enum
```csharp
// C# Implementation
public enum RpfEncryption : uint {
    NONE = 0,
    OPEN = 0x4E45504F,  // "OPEN"
    AES = 0x0FFFFFF9,
    NG = 0x0FEFFFFF
}
```

```python
# Python Implementation
class RpfEncryption(Enum):
    NONE = 0
    OPEN = 0x4E45504F  # "OPEN"
    AES = 0x0FFFFFF9
    NG = 0x0FEFFFFF
```

## RPF Manager

### RpfManager Class
```csharp
// C# Implementation
public class RpfManager {
    public string Folder { get; private set; }
    public List<RpfFile> BaseRpfs { get; private set; }
    public List<RpfFile> ModRpfs { get; private set; }
    public List<RpfFile> DlcRpfs { get; private set; }
    public List<RpfFile> AllRpfs { get; private set; }
    public Dictionary<string, RpfFile> RpfDict { get; private set; }
    public Dictionary<string, RpfEntry> EntryDict { get; private set; }
}
```

```python
# Python Implementation
@dataclass
class RpfManager:
    folder: str
    base_rpfs: List['RpfFile'] = field(default_factory=list)
    mod_rpfs: List['RpfFile'] = field(default_factory=list)
    dlc_rpfs: List['RpfFile'] = field(default_factory=list)
    all_rpfs: List['RpfFile'] = field(default_factory=list)
    rpf_dict: Dict[str, 'RpfFile'] = field(default_factory=dict)
    entry_dict: Dict[str, 'RpfEntry'] = field(default_factory=dict)
```

### Key Methods
```csharp
// C# Implementation
public class RpfManager {
    public void Init(string folder, bool gen9, Action<string> updateStatus, Action<string> errorLog)
    public RpfFile FindRpfFile(string path)
    public RpfEntry GetEntry(string path)
    public byte[] GetFileData(string path)
    public T GetFile<T>(string path) where T : class, PackedFile, new()
}
```

```python
# Python Implementation
class RpfManager:
    def init(self, folder: str, gen9: bool, update_status_cb: Callable[[str], None], error_log_cb: Callable[[str], None]) -> None
    def find_rpf_file(self, path: str) -> Optional[RpfFile]
    def get_entry(self, path: str) -> Optional[RpfEntry]
    def get_file_data(self, path: str) -> Optional[bytes]
    def get_file(self, path: str, file_type: Type[T]) -> Optional[T]
```

## Entry Types

### RpfEntry Base Class
```csharp
// C# Implementation
public abstract class RpfEntry {
    public RpfFile File { get; set; }
    public RpfDirectoryEntry Parent { get; set; }
    public uint NameHash { get; set; }
    public uint NameOffset { get; set; }
    public string Name { get; set; }
    public string Path { get; set; }
}
```

```python
# Python Implementation
@dataclass
class RpfEntry:
    file: Optional['RpfFile'] = None
    parent: Optional['RpfDirectoryEntry'] = None
    name_hash: int = 0
    name_offset: int = 0
    name: str = ""
    path: str = ""
```

### RpfFileEntry Class
```csharp
// C# Implementation
public abstract class RpfFileEntry : RpfEntry {
    public uint FileOffset { get; set; }
    public uint FileSize { get; set; }
    public bool IsEncrypted { get; set; }
}
```

```python
# Python Implementation
@dataclass
class RpfFileEntry(RpfEntry):
    file_offset: int = 0
    file_size: int = 0
    is_encrypted: bool = False
```

### RpfBinaryFileEntry Class
```csharp
// C# Implementation
public class RpfBinaryFileEntry : RpfFileEntry {
    public uint FileUncompressedSize { get; set; }
    public uint EncryptionType { get; set; }
}
```

```python
# Python Implementation
@dataclass
class RpfBinaryFileEntry(RpfFileEntry):
    file_uncompressed_size: int = 0
    encryption_type: int = 0
```

## Encryption Handling

### GTACrypto Class
```csharp
// C# Implementation
public static class GTACrypto {
    public static byte[] DecryptAES(byte[] data)
    public static byte[] DecryptNG(byte[] data, string name, uint length)
    public static byte[] EncryptAES(byte[] data)
    public static byte[] EncryptNG(byte[] data, string name, uint length)
}
```

```python
# Python Implementation
class GTACrypto:
    @staticmethod
    def decrypt_aes(data: bytes) -> bytes
    @staticmethod
    def decrypt_ng(data: bytes, name: str, length: int) -> bytes
    @staticmethod
    def encrypt_aes(data: bytes) -> bytes
    @staticmethod
    def encrypt_ng(data: bytes, name: str, length: int) -> bytes
```

### Key Methods
- `DecryptAES/EncryptAES`: Handles AES encryption for RPF files
- `DecryptNG/EncryptNG`: Handles NG encryption for RPF files
- `LoadFromPath`: Loads encryption keys from game directory
- `GetCryptoKey`: Gets appropriate crypto key for file type 