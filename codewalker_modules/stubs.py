"""
CodeWalker Stubs Module
----------------------
Creates minimal stub implementations needed for GTA5 terrain extraction.
"""

import os
import logging

logger = logging.getLogger(__name__)

def create_stub_files(temp_dir: str):
    """Create minimal stub files needed for terrain extraction"""
    stubs = {
        "Utils/Logging.cs": """
using System;
namespace CodeWalker.Utils {
    public static class Log {
        public static void Info(string message) => Console.WriteLine($"[INFO] {message}");
        public static void Warning(string message) => Console.WriteLine($"[WARN] {message}");
        public static void Error(string message) => Console.WriteLine($"[ERROR] {message}");
    }
}""",
        "Utils/Types.cs": """
using System;
using SharpDX;

namespace CodeWalker.Utils {
    public struct BoundingBox {
        public Vector3 Min;
        public Vector3 Max;
        
        public BoundingBox(Vector3 min, Vector3 max) {
            Min = min;
            Max = max;
        }
    }

    public class BasePathData {
        public Vector3 Position { get; set; }
        public Vector3 Orientation { get; set; }
    }

    public class EditorVertex {
        public Vector3 Position;
        public Vector3 Normal;
        public Vector2 TexCoord;
        public Vector4 Color;
        
        public EditorVertex() {
            Position = Vector3.Zero;
            Normal = Vector3.Up;
            TexCoord = Vector2.Zero;
            Color = Vector4.One;
        }
    }

    public class MetaXmlBase {
        public string Name { get; set; }
        public string Type { get; set; }
    }
}""",
        "Utils/Data.cs": """
using System;
using System.IO;

namespace CodeWalker.Utils {
    public enum Endianess {
        Little,
        Big
    }
    
    public class DataReader : BinaryReader {
        public Endianess Endianess { get; set; }
        
        public DataReader(Stream stream, Endianess endianess = Endianess.Little) 
            : base(stream) {
            Endianess = endianess;
        }
        
        public override uint ReadUInt32() {
            var value = base.ReadUInt32();
            return Endianess == Endianess.Big ? 
                ((value << 24) | ((value & 0xFF00) << 8) | 
                ((value & 0xFF0000) >> 8) | (value >> 24)) : value;
        }
    }

    public class DataWriter : BinaryWriter {
        public Endianess Endianess { get; set; }
        
        public DataWriter(Stream stream, Endianess endianess = Endianess.Little)
            : base(stream) {
            Endianess = endianess;
        }
        
        public override void Write(uint value) {
            if (Endianess == Endianess.Big) {
                value = ((value << 24) | ((value & 0xFF00) << 8) |
                        ((value & 0xFF0000) >> 8) | (value >> 24));
            }
            base.Write(value);
        }
    }
}""",
        "GameFiles/Utils/GTAKeys.cs": """
using System;
using System.IO;
using System.Security.Cryptography;

namespace CodeWalker.GameFiles {
    public static class GTA5Keys {
        public static byte[] PC_AES_KEY = new byte[32];
        public static byte[][] PC_NG_KEYS = new byte[101][];
        public static uint[][][] PC_NG_DECRYPT_TABLES = new uint[17][][];
        public static byte[] PC_LUT = new byte[256];
        
        public static void LoadFromPath(string path = "./Keys", bool gen9 = false, string key = null) {
            // Initialize with default values for testing
            for (int i = 0; i < PC_AES_KEY.Length; i++) {
                PC_AES_KEY[i] = (byte)i;
            }
            
            for (int i = 0; i < PC_NG_KEYS.Length; i++) {
                PC_NG_KEYS[i] = new byte[32];
                for (int j = 0; j < 32; j++) {
                    PC_NG_KEYS[i][j] = (byte)((i + j) % 256);
                }
            }
            
            for (int i = 0; i < 256; i++) {
                PC_LUT[i] = (byte)i;
            }
        }
    }

    public class GTA5NGLUT {
        public byte[][] LUT0;
        public byte[][] LUT1;
        public byte[] Indices;
        
        public GTA5NGLUT() {
            LUT0 = new byte[16][];
            LUT1 = new byte[16][];
            Indices = new byte[16];
            
            for (int i = 0; i < 16; i++) {
                LUT0[i] = new byte[16];
                LUT1[i] = new byte[16];
            }
        }
        
        public byte LookUp(uint value) {
            return 0; // Simplified implementation
        }
    }
}""",
        "GameFiles/Utils/JenkHash.cs": """
using System;

namespace CodeWalker.GameFiles {
    public struct JenkHash {
        public uint Hash { get; set; }
        
        public JenkHash(uint hash) {
            Hash = hash;
        }
        
        public static uint Generate(string str) {
            if (string.IsNullOrEmpty(str)) return 0;
            
            uint hash = 0;
            for (int i = 0; i < str.Length; i++) {
                hash += str[i];
                hash += (hash << 10);
                hash ^= (hash >> 6);
            }
            hash += (hash << 3);
            hash ^= (hash >> 11);
            hash += (hash << 15);
            return hash;
        }
        
        public static implicit operator uint(JenkHash hash) => hash.Hash;
        public static implicit operator JenkHash(uint hash) => new JenkHash(hash);
    }

    public class MetaHash {
        public uint Hash { get; set; }
        
        public MetaHash(uint hash) {
            Hash = hash;
        }
        
        public static implicit operator uint(MetaHash hash) => hash.Hash;
        public static implicit operator MetaHash(uint hash) => new MetaHash(hash);
    }
}"""
    }
    
    for path, content in stubs.items():
        full_path = os.path.join(temp_dir, path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, 'w') as f:
            f.write(content.strip())
        logger.info(f"Created stub file: {full_path}") 