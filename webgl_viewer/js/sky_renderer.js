import { ShaderProgram } from './shader_program.js';

// Fullscreen sky gradient (WebGL2). Draw before enabling depth testing.
const vsSource = `#version 300 es
precision mediump float;

// Fullscreen triangle via gl_VertexID
out vec2 vNdc;

void main() {
    // 3 vertices: (-1,-1), (3,-1), (-1,3)
    vec2 p;
    if (gl_VertexID == 0) p = vec2(-1.0, -1.0);
    else if (gl_VertexID == 1) p = vec2(3.0, -1.0);
    else p = vec2(-1.0, 3.0);
    vNdc = p;
    gl_Position = vec4(p, 0.9999, 1.0);
}
`;

const fsSource = `#version 300 es
precision mediump float;

in vec2 vNdc;
out vec4 fragColor;

uniform vec3 uSkyTop;
uniform vec3 uSkyBottom;
uniform vec3 uSunDir;      // viewer-space direction (normalized), pointing *from* surface *to* sun
uniform vec3 uSunColor;
uniform float uSunIntensity;

void main() {
    // vNdc.y in [-1..3]; map to [0..1] with a clamp
    float t = clamp((vNdc.y + 1.0) * 0.5, 0.0, 1.0);
    // Bias towards horizon a bit.
    float h = smoothstep(0.0, 1.0, t);
    vec3 sky = mix(uSkyBottom, uSkyTop, h);

    // Cheap "sun disc" based on sky direction approx.
    // We don't reconstruct a true view ray here; instead we fake it by using NDC as a proxy.
    vec3 dir = normalize(vec3(vNdc.x, vNdc.y * 0.85, 1.2));
    float s = max(dot(normalize(uSunDir), dir), 0.0);
    float disc = pow(s, 250.0) * uSunIntensity;
    float glow = pow(s, 12.0) * uSunIntensity * 0.25;
    sky += uSunColor * (disc + glow);

    fragColor = vec4(sky, 1.0);
}
`;

export class SkyRenderer {
    constructor(gl) {
        this.gl = gl;
        this.program = new ShaderProgram(gl);
        this.uniforms = null;
        this.ready = false;
    }

    async init() {
        const ok = await this.program.createProgram(vsSource, fsSource);
        if (!ok) return false;
        this.uniforms = {
            uSkyTop: this.gl.getUniformLocation(this.program.program, 'uSkyTop'),
            uSkyBottom: this.gl.getUniformLocation(this.program.program, 'uSkyBottom'),
            uSunDir: this.gl.getUniformLocation(this.program.program, 'uSunDir'),
            uSunColor: this.gl.getUniformLocation(this.program.program, 'uSunColor'),
            uSunIntensity: this.gl.getUniformLocation(this.program.program, 'uSunIntensity'),
        };
        this.ready = true;
        return true;
    }

    render({
        topColor = [0.20, 0.35, 0.65],
        bottomColor = [0.60, 0.70, 0.82],
        sunDir = [0.35, 0.85, 0.20],
        sunColor = [1.0, 0.96, 0.86],
        sunIntensity = 1.0,
    } = {}) {
        if (!this.ready) return;
        const gl = this.gl;
        gl.useProgram(this.program.program);

        // No depth for sky.
        const depthWasEnabled = gl.isEnabled(gl.DEPTH_TEST);
        if (depthWasEnabled) gl.disable(gl.DEPTH_TEST);
        const prevDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
        gl.depthMask(false);

        gl.uniform3fv(this.uniforms.uSkyTop, topColor);
        gl.uniform3fv(this.uniforms.uSkyBottom, bottomColor);
        gl.uniform3fv(this.uniforms.uSunDir, sunDir);
        gl.uniform3fv(this.uniforms.uSunColor, sunColor);
        gl.uniform1f(this.uniforms.uSunIntensity, sunIntensity);

        // Fullscreen triangle: no VAO needed in WebGL2 if no attributes are sourced.
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.depthMask(prevDepthMask);
        if (depthWasEnabled) gl.enable(gl.DEPTH_TEST);
    }
}


