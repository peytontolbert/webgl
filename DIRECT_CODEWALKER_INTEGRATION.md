# Direct CodeWalker Integration

This guide explains how to directly use CodeWalker source files in our Python terrain extractor without building the entire CodeWalker solution.

## Approach Overview

Instead of building the entire CodeWalker project and using the DLLs, we can:
1. Extract only the necessary C# files from the CodeWalker source code
2. Compile them on-the-fly using Python's ability to interact with the C# compiler
3. Use the compiled code directly in our Python application

This approach is simpler and doesn't require Visual Studio or building the entire CodeWalker solution.

## Prerequisites

- Python 3.7 or higher
- .NET Framework 4.8 or higher installed on your system
- CodeWalker source code (downloaded from GitHub)

## Step 1: Download CodeWalker Source Code

1. Download the CodeWalker source code from GitHub:
   ```
   git clone https://github.com/dexyfex/CodeWalker.git
   ```
   
   Or download the ZIP file from: https://github.com/dexyfex/CodeWalker/archive/refs/heads/master.zip and extract it.

2. Set the `codewalker_map` environment variable in your `.env` file to point to the root folder of the CodeWalker source code.

## Step 2: Create a Minimal Compiler Script

Create a new file called `compile_codewalker.py` with the following content:

```python
import os
import clr
import System
from System.CodeDom.Compiler import CodeDomProvider
from System.IO import Path, Directory, File
from System.Collections.Generic import List
from System.Reflection import Assembly

def compile_codewalker_files(codewalker_path, output_dir="./compiled_cw"):
    """Compile necessary CodeWalker files into a usable assembly"""
    print(f"Compiling CodeWalker files from {codewalker_path}")
    
    # Create output directory if it doesn't exist
    os.makedirs(output_dir, exist_ok=True)
    
    # Files we need from CodeWalker.Core
    core_files = [
        "Utils/Matrices.cs",
        "Utils/Vector2.cs",
        "Utils/Vector3.cs",
        "Utils/Vector4.cs",
        "Utils/Quaternion.cs"
    ]
    
    # Files we need from CodeWalker.GameFiles
    gamefiles_files = [
        "GameFiles/FileTypes/HeightmapFile.cs",
        "GameFiles/Utils/ResourceUtil.cs",
        "GameFiles/Utils/ResourceBuilder.cs",
        "GameFiles/RpfFile.cs",
        "GameFiles/RpfEntry.cs",
        "GameFiles/RpfResourceFileEntry.cs",
        "GameFiles/RpfBinaryFileEntry.cs",
        "GameFiles/RpfResourcePage.cs",
        "GameFiles/RpfManager.cs"
    ]
    
    # Collect all source files
    source_files = []
    for file in core_files:
        full_path = os.path.join(codewalker_path, "CodeWalker.Core", file)
        if os.path.exists(full_path):
            source_files.append(full_path)
        else:
            print(f"Warning: File not found: {full_path}")
    
    for file in gamefiles_files:
        full_path = os.path.join(codewalker_path, "CodeWalker.GameFiles", file)
        if os.path.exists(full_path):
            source_files.append(full_path)
        else:
            print(f"Warning: File not found: {full_path}")
    
    # Read all source code
    sources = []
    for file in source_files:
        with open(file, 'r', encoding='utf-8') as f:
            sources.append(f.read())
    
    # Combine all source code
    combined_source = "\n".join(sources)
    
    # Create compiler parameters
    compiler = CodeDomProvider.CreateProvider("CSharp")
    parameters = System.CodeDom.Compiler.CompilerParameters()
    
    # Add references
    parameters.ReferencedAssemblies.Add("System.dll")
    parameters.ReferencedAssemblies.Add("System.Core.dll")
    parameters.ReferencedAssemblies.Add("System.Xml.dll")
    parameters.ReferencedAssemblies.Add("System.Drawing.dll")
    
    # Set output assembly
    output_dll = os.path.join(output_dir, "CodeWalker.Minimal.dll")
    parameters.OutputAssembly = output_dll
    parameters.GenerateExecutable = False
    parameters.GenerateInMemory = False
    
    # Compile
    results = compiler.CompileAssemblyFromSource(parameters, combined_source)
    
    if results.Errors.Count > 0:
        print("Compilation errors:")
        for error in results.Errors:
            print(f"  {error.Line}: {error.ErrorText}")
        return None
    
    print(f"Successfully compiled to {output_dll}")
    return output_dll

if __name__ == "__main__":
    # Get CodeWalker path from environment variable
    codewalker_path = os.getenv('codewalker_map')
    if not codewalker_path:
        print("Error: CodeWalker path not set in environment variables")
        exit(1)
    
    # Compile CodeWalker files
    dll_path = compile_codewalker_files(codewalker_path)
    if dll_path:
        print(f"You can now use the compiled DLL at: {dll_path}")
        print("Add this path to your .env file as codewalker_dll")
```

## Step 3: Run the Compiler Script

Run the compiler script to create a minimal CodeWalker assembly:

```
python compile_codewalker.py
```

This will create a `compiled_cw` directory containing `CodeWalker.Minimal.dll`.

## Step 4: Update the Terrain Extractor

Modify the `gta5_terrain_extractor.py` file to use the compiled DLL:

1. Add a new function to the `GTATerrainExtractor` class to load the compiled DLL:

```python
def initialize_compiled_codewalker(self):
    """Initialize CodeWalker integration using the compiled DLL"""
    try:
        import clr
        logger.info("Python.NET is available, attempting to initialize compiled CodeWalker")
        
        # Get compiled DLL path
        dll_path = os.getenv('codewalker_dll')
        if not dll_path:
            # Try to find it in the default location
            default_path = Path.cwd() / "compiled_cw" / "CodeWalker.Minimal.dll"
            if default_path.exists():
                dll_path = str(default_path)
            else:
                logger.warning("Compiled CodeWalker DLL not found")
                return False
        
        # Add reference to the compiled DLL
        clr.AddReference(dll_path)
        
        # Import CodeWalker namespaces
        from CodeWalker.GameFiles import RpfManager, HeightmapFile
        
        # Initialize RpfManager
        rpf_manager = RpfManager()
        rpf_manager.Init(str(self.game_path))
        
        # Store the integration objects
        self.codewalker_integration = {
            'rpf_manager': rpf_manager,
            'heightmap_file_class': HeightmapFile
        }
        
        logger.info("Compiled CodeWalker integration initialized successfully")
        return True
    except ImportError:
        logger.warning("Python.NET not available, cannot use compiled CodeWalker")
        return False
    except Exception as e:
        logger.error(f"Error initializing compiled CodeWalker: {e}")
        if self.debug:
            import traceback
            logger.debug(traceback.format_exc())
        return False
```

2. Modify the `initialize_codewalker` method to try the compiled DLL first:

```python
def initialize_codewalker(self):
    """Initialize CodeWalker integration"""
    # First try to use the compiled DLL
    if self.initialize_compiled_codewalker():
        return True
    
    # If that fails, try the standard approach
    try:
        # ... (existing code) ...
    except:
        # ... (existing code) ...
```

## Troubleshooting

### Compilation Errors

If you encounter compilation errors:

1. Check the error messages for missing files or references
2. You may need to add more source files from CodeWalker to resolve dependencies
3. Add any additional required references to the compiler parameters

### Runtime Errors

If you encounter runtime errors:

1. Make sure all necessary dependencies are included in the compiled DLL
2. Check for namespace or class name conflicts
3. Ensure the compiled DLL is compatible with your Python.NET version

## Advantages of This Approach

- No need to build the entire CodeWalker solution
- No Visual Studio required
- More control over which parts of CodeWalker are used
- Easier to modify and customize the CodeWalker code
- Smaller footprint (only the necessary files are compiled)

## Limitations

- May not include all CodeWalker functionality
- Requires manual management of dependencies
- May require updates when CodeWalker source code changes 