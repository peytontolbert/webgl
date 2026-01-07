export class ShaderProgram {
    constructor(gl) {
        this.gl = gl;
        this.program = null;
        this.attributes = {};
        this.uniforms = {};
    }

    /**
     * Very small GLSL preprocessor for `#include "file.glsl"`.
     * - Only supports quoted includes.
     * - Keeps `#version` where it is; include files must not declare `#version`.
     * @param {string} source
     * @param {(name: string) => (string|Promise<string>)} includeLoader
     * @param {number} maxDepth
     * @returns {Promise<string>}
     */
    static async preprocessIncludes(source, includeLoader, maxDepth = 20) {
        /** @param {string} src @param {string[]} stack */
        const expand = async (src, stack) => {
            // IMPORTANT:
            // Do NOT share a single global RegExp across recursive expand() calls.
            // RegExp with /g uses a mutable `lastIndex`; if recursion reuses the same RegExp,
            // nested calls will clobber lastIndex and the parent loop can re-match the same
            // include line repeatedly, growing `parts` until we hit RangeError: Invalid array length.
            const includeRe = /^[ \t]*#include[ \t]+"([^"]+)"[ \t]*$/gm;

            if (stack.length > maxDepth) {
                throw new Error(`GLSL include depth exceeded (${maxDepth}): ${stack.join(' -> ')}`);
            }

            /** @type {string[]} */
            const parts = [];
            let lastIdx = 0;
            includeRe.lastIndex = 0;
            for (;;) {
                const m = includeRe.exec(src);
                if (!m) break;
                const [full, name] = m;
                const start = m.index;
                const end = start + full.length;
                parts.push(src.slice(lastIdx, start));

                const trimmed = String(name || '').trim();
                if (!trimmed) {
                    parts.push(`\n/* #include "" ignored */\n`);
                    lastIdx = end;
                    continue;
                }
                if (stack.includes(trimmed)) {
                    throw new Error(`GLSL include cycle: ${[...stack, trimmed].join(' -> ')}`);
                }

                const inc = await includeLoader(trimmed);
                if (typeof inc !== 'string') {
                    throw new Error(`GLSL include not found: "${trimmed}"`);
                }
                parts.push(`\n/* begin include: ${trimmed} */\n`);
                parts.push(await expand(inc, [...stack, trimmed]));
                parts.push(`\n/* end include: ${trimmed} */\n`);

                lastIdx = end;
            }
            parts.push(src.slice(lastIdx));
            return parts.join('');
        };

        return await expand(String(source ?? ''), []);
    }
    
    async createProgram(vsSource, fsSource) {
        const _snippetForLog = (src, infoLog) => {
            const s = String(src ?? '');
            const log = String(infoLog ?? '');
            const lines = s.split('\n');

            /** Try to parse common WebGL/ANGLE formats like:
             *  "ERROR: 0:123: ..." or "0:123(45): ..." or "ERROR: 0:123: 'foo' : ..."
             */
            const lnMatches = [];
            const reList = [
                /ERROR:\s*\d+:(\d+):/g,
                /\b\d+:(\d+)\b/g,
            ];
            for (const re of reList) {
                re.lastIndex = 0;
                for (;;) {
                    const m = re.exec(log);
                    if (!m) break;
                    const n = Number(m[1]);
                    if (Number.isFinite(n) && n > 0) lnMatches.push(n);
                    if (lnMatches.length > 8) break;
                }
                if (lnMatches.length > 0) break;
            }

            const uniq = Array.from(new Set(lnMatches)).slice(0, 4);
            const spans = uniq.length ? uniq : [1];
            const out = [];
            for (const ln of spans) {
                const start = Math.max(1, ln - 4);
                const end = Math.min(lines.length, ln + 4);
                out.push(`--- GLSL source context around line ${ln} ---`);
                for (let i = start; i <= end; i++) {
                    const prefix = (i === ln) ? '>>' : '  ';
                    out.push(`${prefix} ${String(i).padStart(4, ' ')} | ${lines[i - 1] ?? ''}`);
                }
            }
            return out.join('\n');
        };

        try {
            // If we're recompiling, avoid leaking the previous program.
            if (this.program) {
                try { this.gl.deleteProgram(this.program); } catch { /* ignore */ }
                this.program = null;
            }
            this.attributes = {};
            this.uniforms = {};

            // Create vertex shader
            const vertexShader = this.gl.createShader(this.gl.VERTEX_SHADER);
            if (!vertexShader) throw new Error('Failed to create vertex shader');
            this.gl.shaderSource(vertexShader, vsSource);
            this.gl.compileShader(vertexShader);
            
            // Check vertex shader compilation
            if (!this.gl.getShaderParameter(vertexShader, this.gl.COMPILE_STATUS)) {
                const log = this.gl.getShaderInfoLog(vertexShader);
                console.error('Vertex shader compilation failed.\n' + String(log || ''));
                console.error(_snippetForLog(vsSource, log));
                throw new Error('Vertex shader compilation failed: ' + log);
            }
            
            // Create fragment shader
            const fragmentShader = this.gl.createShader(this.gl.FRAGMENT_SHADER);
            if (!fragmentShader) throw new Error('Failed to create fragment shader');
            this.gl.shaderSource(fragmentShader, fsSource);
            this.gl.compileShader(fragmentShader);
            
            // Check fragment shader compilation
            if (!this.gl.getShaderParameter(fragmentShader, this.gl.COMPILE_STATUS)) {
                const log = this.gl.getShaderInfoLog(fragmentShader);
                console.error('Fragment shader compilation failed.\n' + String(log || ''));
                console.error(_snippetForLog(fsSource, log));
                throw new Error('Fragment shader compilation failed: ' + log);
            }
            
            // Create program and link shaders
            this.program = this.gl.createProgram();
            if (!this.program) throw new Error('Failed to create shader program');
            this.gl.attachShader(this.program, vertexShader);
            this.gl.attachShader(this.program, fragmentShader);
            
            // Bind attribute locations before linking
            this.gl.bindAttribLocation(this.program, 0, 'aPosition');
            this.gl.bindAttribLocation(this.program, 1, 'aNormal');
            this.gl.bindAttribLocation(this.program, 2, 'aTexcoord');
            
            this.gl.linkProgram(this.program);
            
            // Check program linking
            if (!this.gl.getProgramParameter(this.program, this.gl.LINK_STATUS)) {
                const progLog = this.gl.getProgramInfoLog(this.program);
                const vsLog = this.gl.getShaderInfoLog(vertexShader);
                const fsLog = this.gl.getShaderInfoLog(fragmentShader);
                console.error('Program linking failed.\n' + String(progLog || ''));
                if (vsLog) console.error('Vertex shader log:\n' + String(vsLog));
                if (fsLog) console.error('Fragment shader log:\n' + String(fsLog));
                throw new Error('Program linking failed: ' + progLog);
            }
            
            // Store attribute locations
            this.attributes = {
                aPosition: 0,
                aNormal: 1,
                aTexcoord: 2
            };
            
            // Clean up shaders
            this.gl.deleteShader(vertexShader);
            this.gl.deleteShader(fragmentShader);
            
            return true;
            
        } catch (error) {
            console.error('Failed to create shader program:', error);
            // Best-effort cleanup on failure
            try { if (this.program) this.gl.deleteProgram(this.program); } catch { /* ignore */ }
            this.program = null;
            return false;
        }
    }
    
    getAttributeLocations() {
        // Get number of active attributes
        const numAttribs = this.gl.getProgramParameter(this.program, this.gl.ACTIVE_ATTRIBUTES);
        
        // Get each attribute location
        for (let i = 0; i < numAttribs; i++) {
            const info = this.gl.getActiveAttrib(this.program, i);
            if (info) {
                this.attributes[info.name] = this.gl.getAttribLocation(this.program, info.name);
            }
        }
    }
    
    getUniformLocation(name) {
        // Cache even null results; use "in" so null doesn't trigger repeated lookups.
        if (!(name in this.uniforms)) {
            this.uniforms[name] = this.gl.getUniformLocation(this.program, name);
        }
        return this.uniforms[name];
    }
    
    setUniform(name, value) {
        const location = this.getUniformLocation(name);
        if (location === null) {
            console.warn(`Uniform ${name} not found in shader program`);
            return;
        }
        
        if (Array.isArray(value)) {
            value = new Float32Array(value);
        }

        if (value instanceof Float32Array) {
            switch (value.length) {
                case 1:
                    this.gl.uniform1f(location, value[0]);
                    break;
                case 2:
                    this.gl.uniform2f(location, value[0], value[1]);
                    break;
                case 3:
                    this.gl.uniform3f(location, value[0], value[1], value[2]);
                    break;
                case 4:
                    this.gl.uniform4f(location, value[0], value[1], value[2], value[3]);
                    break;
                case 9:
                    this.gl.uniformMatrix3fv(location, false, value);
                    break;
                case 16:
                    this.gl.uniformMatrix4fv(location, false, value);
                    break;
                default:
                    console.warn(`Unsupported uniform array length: ${value.length}`);
            }
        } else {
            // Heuristic: integers are typically samplers/bitfields; non-integers are floats.
            if (typeof value === 'number' && !Number.isInteger(value)) {
                this.gl.uniform1f(location, value);
            } else {
                this.gl.uniform1i(location, value);
            }
        }
    }
    
    use() {
        this.gl.useProgram(this.program);
    }
    
    dispose() {
        if (this.program) {
            this.gl.deleteProgram(this.program);
            this.program = null;
        }
    }
} 