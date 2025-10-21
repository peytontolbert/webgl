"""
CodeWalker Project Configuration
------------------------------
Defines the project settings and dependencies for CodeWalker compilation.
Focused on minimal requirements for GTA5 terrain extraction.
"""

from typing import Dict, List, NamedTuple

class ProjectConfig(NamedTuple):
    """Project configuration settings"""
    target_framework: str
    output_type: str
    enable_unsafe: bool
    define_constants: List[str]
    nuget_packages: Dict[str, str]
    system_references: List[str]
    assembly_attributes: List[str] = []  # Default to empty list

# Default NuGet packages needed for terrain extraction
DEFAULT_PACKAGES = {
    # Core SharpDX packages for 3D graphics
    "SharpDX": "4.2.0",
    "SharpDX.Mathematics": "4.2.0",
    "SharpDX.Direct3D11": "4.2.0",
    
    # System packages for Windows compatibility
    "System.Drawing.Common": "6.0.0",
    "Microsoft.Win32.SystemEvents": "6.0.0",
    
    # Additional system packages for performance and compatibility
    "System.Numerics.Vectors": "4.5.0",
    "System.Runtime.CompilerServices.Unsafe": "6.0.0",
    "System.Memory": "4.5.5",
    "System.Buffers": "4.5.1"
}

# System references needed for terrain extraction
SYSTEM_REFERENCES = [
    "Microsoft.CSharp",
    "mscorlib",
    "PresentationCore",
    "PresentationFramework",
    "System",
    "System.Core",
    "System.Data",
    "System.Drawing",
    "System.IO.Compression",
    "System.Net.Http",
    "System.Numerics",
    "System.Runtime",
    "System.Runtime.Serialization",
    "System.Windows.Forms",
    "System.Xaml",
    "System.Xml",
    "System.Xml.Linq",
    "WindowsBase"
]

# Default configuration for terrain extraction
DEFAULT_CONFIG = ProjectConfig(
    target_framework="net7.0-windows",
    output_type="Library",
    enable_unsafe=True,
    define_constants=["RELEASE", "TRACE"],
    nuget_packages={
        "SharpDX": "4.2.0",
        "SharpDX.Mathematics": "4.2.0",
        "System.Memory": "4.5.5",
        "System.IO.Compression": "4.3.0",
        "System.Runtime.CompilerServices.Unsafe": "6.0.0"
    },
    system_references=[
        "System",
        "System.Core",
        "System.Data",
        "System.Drawing",
        "System.IO.Compression",
        "System.Numerics",
        "System.Runtime",
        "System.Windows.Forms",
        "System.Xml",
        "System.Xml.Linq",
        "WindowsBase"
    ],
    assembly_attributes=[
        'assembly: System.Runtime.CompilerServices.InternalsVisibleTo("CodeWalker.Tests")',
        'assembly: System.Runtime.CompilerServices.InternalsVisibleTo("CodeWalker.App")'
    ]
)

def get_minimal_config() -> ProjectConfig:
    """Get minimal project configuration for terrain extraction"""
    return ProjectConfig(
        target_framework="net7.0-windows",
        output_type="Library",
        enable_unsafe=True,
        define_constants=["WINDOWS", "RELEASE"],
        nuget_packages={
            "SharpDX": "4.2.0",
            "SharpDX.Mathematics": "4.2.0",
            "SharpDX.Direct3D11": "4.2.0",
            "SharpDX.DXGI": "4.2.0",
            "System.Drawing.Common": "6.0.0",
            "Microsoft.Win32.SystemEvents": "6.0.0",
            "System.Memory": "4.5.5",
            "System.Buffers": "4.5.1",
            "System.Runtime.CompilerServices.Unsafe": "6.0.0",
            "System.Numerics.Vectors": "4.5.0",
            "System.IO.Compression": "4.3.0"
        },
        system_references=[
            "System",
            "System.Core",
            "System.Data",
            "System.Drawing",
            "System.IO.Compression",
            "System.IO.Compression.FileSystem",
            "System.Numerics",
            "System.Runtime",
            "System.Runtime.Serialization",
            "System.Windows.Forms",
            "System.Xml",
            "System.Xml.Linq",
            "WindowsBase",
            "PresentationCore",
            "PresentationFramework"
        ],
        assembly_attributes=[
            'assembly: System.Runtime.CompilerServices.InternalsVisibleTo("CodeWalker.Core")',
            'assembly: System.Runtime.CompilerServices.InternalsVisibleTo("CodeWalker.World")',
            'assembly: System.Runtime.CompilerServices.InternalsVisibleTo("CodeWalker.GameFiles")'
        ]
    )

def generate_project_xml(config: ProjectConfig) -> str:
    """
    Generate project XML content.
    
    Args:
        config: Project configuration
        
    Returns:
        str: Project XML content
    """
    xml = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<Project Sdk="Microsoft.NET.Sdk">',
        '  <PropertyGroup>',
        f'    <TargetFramework>{config.target_framework}</TargetFramework>',
        f'    <OutputType>{config.output_type}</OutputType>',
        '    <UseWindowsForms>true</UseWindowsForms>',
        '    <UseWPF>true</UseWPF>',
        '    <GenerateRuntimeConfigurationFiles>true</GenerateRuntimeConfigurationFiles>',
        '    <CopyLocalLockFileAssemblies>true</CopyLocalLockFileAssemblies>',
        '    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>',
        '    <RootNamespace>CodeWalker.Core</RootNamespace>',
        '    <AssemblyName>CodeWalker.Core</AssemblyName>',
        '    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>',
        '    <Platforms>AnyCPU</Platforms>',
        '    <GenerateAssemblyInfo>true</GenerateAssemblyInfo>',
        '    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>',
        '    <DisableImplicitNuGetFallbackFolder>true</DisableImplicitNuGetFallbackFolder>',
        '    <RestoreProjectStyle>PackageReference</RestoreProjectStyle>',
        '    <AutoGenerateBindingRedirects>true</AutoGenerateBindingRedirects>',
        '    <GenerateBindingRedirectsOutputType>true</GenerateBindingRedirectsOutputType>',
        '    <CopyLocalSatelliteAssemblies>true</CopyLocalSatelliteAssemblies>'
    ]
    
    # Add define constants
    if config.define_constants:
        defines = ";".join(config.define_constants)
        xml.append(f'    <DefineConstants>{defines}</DefineConstants>')
        
    xml.append('  </PropertyGroup>')
    
    # Add assembly attributes
    if config.assembly_attributes:
        xml.append('  <ItemGroup>')
        xml.append('    <AssemblyAttribute Include="System.Runtime.CompilerServices.InternalsVisibleToAttribute">')
        for attr in config.assembly_attributes:
            if attr.startswith('assembly: System.Runtime.CompilerServices.InternalsVisibleTo'):
                assembly_name = attr.split('"')[1]
                xml.append(f'      <_Parameter1>{assembly_name}</_Parameter1>')
        xml.append('    </AssemblyAttribute>')
        xml.append('  </ItemGroup>')
    
    # Add package references
    if config.nuget_packages:
        xml.append('  <ItemGroup>')
        for name, version in config.nuget_packages.items():
            xml.append(f'    <PackageReference Include="{name}" Version="{version}">')
            xml.append('      <PrivateAssets>None</PrivateAssets>')
            xml.append('      <ExcludeAssets>None</ExcludeAssets>')
            xml.append('    </PackageReference>')
        xml.append('  </ItemGroup>')
        
    # Add system references
    if config.system_references:
        xml.append('  <ItemGroup>')
        for ref in config.system_references:
            xml.append(f'    <Reference Include="{ref}" />')
        xml.append('  </ItemGroup>')
        
    # Add compile items
    xml.append('  <ItemGroup>')
    xml.append('    <Compile Include="CodeWalker.Core/**/*.cs" />')
    xml.append('  </ItemGroup>')
    
    # Add embedded resources
    xml.append('  <ItemGroup>')
    xml.append('    <EmbeddedResource Include="CodeWalker.Core/Resources/**/*.resx" />')
    xml.append('    <EmbeddedResource Include="CodeWalker.Core/Resources/**/*.resources" />')
    xml.append('    <None Include="CodeWalker.Core/*.xml" />')
    xml.append('  </ItemGroup>')
    
    xml.append('</Project>')
    return "\n".join(xml) 