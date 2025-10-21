# Setting Up CodeWalker for Terrain Extraction

This guide explains how to set up CodeWalker for use with the GTA 5 Terrain Extractor.

## Prerequisites

- Visual Studio 2019 or newer (Community Edition is fine)
- .NET Framework 4.8 SDK
- Git (optional, for cloning the repository)

## Getting CodeWalker

You have two options for obtaining CodeWalker:

### Option 1: Download Pre-built Release (Recommended)

1. Visit the CodeWalker releases page: https://github.com/dexyfex/CodeWalker/releases
2. Download the latest release ZIP file (e.g., `CodeWalker.zip`)
3. Extract the ZIP file to a folder on your computer
4. Set the `codewalker_map` environment variable in your `.env` file to point to this folder

### Option 2: Build from Source

If you need the latest features or want to modify CodeWalker, you can build it from source:

1. Clone or download the CodeWalker repository:
   ```
   git clone https://github.com/dexyfex/CodeWalker.git
   ```
   
   Or download the ZIP file from: https://github.com/dexyfex/CodeWalker/archive/refs/heads/master.zip

2. Open the solution file (`CodeWalker.sln`) in Visual Studio

3. Restore NuGet packages:
   - Right-click on the solution in Solution Explorer
   - Select "Restore NuGet Packages"

4. Build the solution:
   - Set the build configuration to "Release"
   - Select Build > Build Solution from the menu (or press F6)

5. The compiled DLLs will be in the `bin\Release` folder of each project:
   - `CodeWalker.Core\bin\Release\CodeWalker.Core.dll`
   - `CodeWalker.GameFiles\bin\Release\CodeWalker.GameFiles.dll`

6. Set the `codewalker_map` environment variable in your `.env` file to point to the folder containing these DLLs

## Verifying the Setup

After setting up CodeWalker, you can verify that it's correctly configured by running:

```
python verify_codewalker.py
```

You should see output similar to:

```
Verifying CodeWalker integration...
--------------------------------------------------
✓ Python.NET is installed
✓ .NET Framework is installed: 4.0.30319.42000
✓ CodeWalker path exists: C:\Path\To\CodeWalker
✓ Found CodeWalker.Core.dll
✓ Found CodeWalker.GameFiles.dll
✓ Successfully loaded CodeWalker assemblies
--------------------------------------------------
✓ CodeWalker integration verified successfully
```

## Troubleshooting

### Missing DLLs

If you're seeing errors about missing DLLs:

1. Make sure you've built the solution in Release mode
2. Check that the `codewalker_map` environment variable points to the correct folder
3. Verify that the DLLs exist in the specified folder

### Python.NET Issues

If you're having issues with Python.NET:

1. Make sure you've installed the required packages:
   ```
   pip install -r requirements.txt
   ```

2. If you're on Windows, ensure you're using a version of Python that's compatible with Python.NET (Python 3.7-3.9 are known to work well)

3. If you're on Linux or macOS, note that Python.NET primarily supports Windows. You may need to use Mono or .NET Core for cross-platform support.

## Using CodeWalker Without Building

If you're having trouble building CodeWalker or just want to use the terrain extractor without CodeWalker integration, you can:

1. Set the `codewalker_map` environment variable to an empty string or remove it from your `.env` file
2. The terrain extractor will fall back to its built-in heightmap parser

Note that some advanced features may not be available without CodeWalker integration. 