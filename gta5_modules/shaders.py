"""
Shader Management for GTA5 Terrain
--------------------------------
Handles shader-related functionality for terrain rendering.
"""

import logging
from typing import Dict, Any, Optional
from pathlib import Path

logger = logging.getLogger(__name__)

class ShaderManager:
    """Manages shader-related functionality for terrain rendering"""
    
    def __init__(self):
        """Initialize shader manager"""
        self.shader_params = {
            'terrain': {
                'vertex_shader': """
                    #version 300 es
                    precision highp float;
                    
                    in vec3 position;
                    in vec2 texCoord;
                    
                    out vec2 vTexCoord;
                    out vec3 vPosition;
                    out vec3 vNormal;
                    
                    uniform mat4 modelViewMatrix;
                    uniform mat4 projectionMatrix;
                    uniform float worldScale;
                    uniform float terrainScale;
                    
                    void main() {
                        vTexCoord = texCoord;
                        vPosition = position;
                        vNormal = vec3(0.0, 0.0, 1.0); // Will be calculated from heightmap
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }
                """,
                'fragment_shader': """
                    #version 300 es
                    precision highp float;
                    
                    in vec2 vTexCoord;
                    in vec3 vPosition;
                    in vec3 vNormal;
                    
                    out vec4 fragColor;
                    
                    // Texture uniforms
                    uniform sampler2D u_colourmap0;
                    uniform sampler2D u_colourmap1;
                    uniform sampler2D u_colourmap2;
                    uniform sampler2D u_colourmap3;
                    uniform sampler2D u_colourmap4;
                    uniform sampler2D u_colourmask;
                    uniform sampler2D u_normalmap0;
                    uniform sampler2D u_normalmap1;
                    uniform sampler2D u_normalmap2;
                    uniform sampler2D u_normalmap3;
                    uniform sampler2D u_normalmap4;
                    uniform sampler2D u_tintpalette;
                    
                    // Lighting uniforms
                    uniform vec3 lightDirection;
                    uniform vec3 lightColor;
                    uniform float ambientIntensity;
                    
                    void main() {
                        // Sample textures
                        vec4 baseColor = texture(u_colourmap0, vTexCoord);
                        vec4 layer1 = texture(u_colourmap1, vTexCoord);
                        vec4 layer2 = texture(u_colourmap2, vTexCoord);
                        vec4 layer3 = texture(u_colourmap3, vTexCoord);
                        vec4 layer4 = texture(u_colourmap4, vTexCoord);
                        vec4 mask = texture(u_colourmask, vTexCoord);
                        
                        // Sample normal maps
                        vec3 normal0 = texture(u_normalmap0, vTexCoord).rgb * 2.0 - 1.0;
                        vec3 normal1 = texture(u_normalmap1, vTexCoord).rgb * 2.0 - 1.0;
                        vec3 normal2 = texture(u_normalmap2, vTexCoord).rgb * 2.0 - 1.0;
                        vec3 normal3 = texture(u_normalmap3, vTexCoord).rgb * 2.0 - 1.0;
                        vec3 normal4 = texture(u_normalmap4, vTexCoord).rgb * 2.0 - 1.0;
                        
                        // Blend normals based on mask
                        vec3 normal = mix(normal0, normal1, mask.r);
                        normal = mix(normal, normal2, mask.g);
                        normal = mix(normal, normal3, mask.b);
                        normal = mix(normal, normal4, mask.a);
                        
                        // Calculate lighting
                        float diffuse = max(dot(normalize(normal), normalize(lightDirection)), 0.0);
                        vec3 lighting = lightColor * (ambientIntensity + diffuse);
                        
                        // Blend colors based on mask
                        vec4 color = mix(baseColor, layer1, mask.r);
                        color = mix(color, layer2, mask.g);
                        color = mix(color, layer3, mask.b);
                        color = mix(color, layer4, mask.a);
                        
                        // Apply lighting
                        fragColor = vec4(color.rgb * lighting, color.a);
                    }
                """
            },
            'wireframe': {
                'vertex_shader': """
                    #version 300 es
                    precision highp float;
                    
                    in vec3 position;
                    
                    uniform mat4 modelViewMatrix;
                    uniform mat4 projectionMatrix;
                    
                    void main() {
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }
                """,
                'fragment_shader': """
                    #version 300 es
                    precision highp float;
                    
                    out vec4 fragColor;
                    
                    void main() {
                        fragColor = vec4(1.0, 1.0, 1.0, 1.0);
                    }
                """
            }
        }
    
    def get_shader_params(self, shader_type: str) -> Optional[Dict[str, str]]:
        """
        Get shader parameters for a specific shader type
        
        Args:
            shader_type (str): Type of shader to get parameters for
            
        Returns:
            Optional[Dict[str, str]]: Shader parameters if found
        """
        return self.shader_params.get(shader_type)
    
    def export_shaders(self, output_dir: str):
        """
        Export shader files to the specified directory
        
        Args:
            output_dir (str): Directory to save shader files
        """
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        for shader_type, params in self.shader_params.items():
            # Export vertex shader
            vs_path = output_dir / f"{shader_type}.vert"
            with open(vs_path, 'w') as f:
                f.write(params['vertex_shader'])
            logger.info(f"Exported vertex shader: {vs_path}")
            
            # Export fragment shader
            fs_path = output_dir / f"{shader_type}.frag"
            with open(fs_path, 'w') as f:
                f.write(params['fragment_shader'])
            logger.info(f"Exported fragment shader: {fs_path}") 