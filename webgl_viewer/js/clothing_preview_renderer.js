import { glMatrix } from './glmatrix.js';
import { ModelManager } from './model_manager.js';
import { ShaderProgram } from './shader_program.js';

const VERTEX_SHADER = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aTexcoord0;
uniform mat4 uMvp;
uniform mat4 uModel;
out vec3 vNormal;
out vec2 vUv;
void main() {
    gl_Position = uMvp * vec4(aPosition, 1.0);
    vNormal = mat3(uModel) * aNormal;
    vUv = aTexcoord0;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec2 vUv;
uniform sampler2D uDiffuse;
uniform bool uHasTexture;
out vec4 fragColor;
void main() {
    vec4 base = uHasTexture ? texture(uDiffuse, vUv) : vec4(0.58, 0.61, 0.64, 1.0);
    if (base.a < 0.08) discard;
    vec3 n = normalize(vNormal);
    float key = max(dot(n, normalize(vec3(0.45, -0.65, 0.62))), 0.0);
    float fill = max(dot(n, normalize(vec3(-0.55, 0.25, 0.35))), 0.0);
    float light = 0.24 + key * 0.66 + fill * 0.18;
    fragColor = vec4(base.rgb * light, base.a);
}`;

function textureUrl(relative) {
    const path = String(relative || '').replace(/^\/+/, '').replace(/^assets\//, '');
    return path ? `/assets/${path}` : '';
}

export class GarmentPreviewRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl2', { alpha: false, antialias: true });
        if (!this.gl) throw new Error('WebGL 2 is unavailable');
        this.modelManager = new ModelManager(this.gl);
        this.modelManager.setMeshCacheCaps({ maxBytes: 96 * 1024 * 1024 });
        this.program = new ShaderProgram(this.gl);
        this.drawables = [];
        this.loadGeneration = 0;
        this.textures = new Map();
        this.center = [0, 0, 0];
        this.radius = 1;
        this.yaw = -0.35;
        this.pitch = 0.06;
        this.zoom = 1;
        this.dragging = false;
        this.lastPointer = [0, 0];
        this.ready = this._init();
        this._bindControls();
    }

    async _init() {
        await this.program.createProgram(VERTEX_SHADER, FRAGMENT_SHADER);
        const gl = this.gl;
        this.uniforms = {
            mvp: gl.getUniformLocation(this.program.program, 'uMvp'),
            model: gl.getUniformLocation(this.program.program, 'uModel'),
            diffuse: gl.getUniformLocation(this.program.program, 'uDiffuse'),
            hasTexture: gl.getUniformLocation(this.program.program, 'uHasTexture'),
        };
        this._frame = requestAnimationFrame((time) => this._render(time));
    }

    _bindControls() {
        this.canvas.addEventListener('pointerdown', (event) => {
            this.dragging = true;
            this.lastPointer = [event.clientX, event.clientY];
            this.canvas.setPointerCapture(event.pointerId);
        });
        this.canvas.addEventListener('pointermove', (event) => {
            if (!this.dragging) return;
            this.yaw += (event.clientX - this.lastPointer[0]) * 0.012;
            this.pitch = Math.max(-0.65, Math.min(0.65, this.pitch + (event.clientY - this.lastPointer[1]) * 0.008));
            this.lastPointer = [event.clientX, event.clientY];
        });
        this.canvas.addEventListener('pointerup', () => { this.dragging = false; });
        this.canvas.addEventListener('wheel', (event) => {
            event.preventDefault();
            this.zoom = Math.max(0.65, Math.min(1.8, this.zoom * Math.exp(event.deltaY * 0.001)));
        }, { passive: false });
    }

    async showVariant(variant) {
        const generation = ++this.loadGeneration;
        await this.ready;
        if (!variant?.hash) throw new Error('Converted garment metadata is missing');
        const response = await fetch(`/assets/custom_clothing/clothingpack5m.json?live=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Manifest request failed (${response.status})`);
        const manifest = await response.json();
        const entry = manifest.meshes?.[String(variant.hash)];
        if (!entry) throw new Error('Converted garment mesh is unavailable');
        const lod = entry.lods?.high || entry.lods?.med || entry.lods?.low || entry.lods?.vlow;
        const rows = lod?.submeshes || [];
        const loaded = await Promise.all(rows.map(async (row) => ({
            mesh: await this.modelManager.loadMeshFile(row.file, { usePersistentCache: false, cacheBust: Date.now() }),
            texture: await this._loadTexture(row.material?.diffuse),
        })));
        if (generation !== this.loadGeneration) return false;
        this.drawables = loaded.filter((row) => row.mesh);
        if (!this.drawables.length) throw new Error('Garment contains no renderable geometry');
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (const { mesh } of this.drawables) for (let axis = 0; axis < 3; axis += 1) {
            min[axis] = Math.min(min[axis], mesh.bounds.min[axis]);
            max[axis] = Math.max(max[axis], mesh.bounds.max[axis]);
        }
        this.center = min.map((value, axis) => (value + max[axis]) * 0.5);
        this.radius = Math.max(0.05, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * 0.5);
        this.zoom = 1;
        return true;
    }

    clear() {
        this.loadGeneration += 1;
        this.drawables = [];
    }

    async _loadTexture(relative) {
        const url = textureUrl(relative);
        if (!url) return null;
        if (this.textures.has(url)) {
            const cached = this.textures.get(url);
            this.textures.delete(url);
            this.textures.set(url, cached);
            return cached;
        }
        const texture = await new Promise((resolve) => {
            const image = new Image();
            image.onload = () => {
                const gl = this.gl;
                const result = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, result);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.generateMipmap(gl.TEXTURE_2D);
                resolve(result);
            };
            image.onerror = () => resolve(null);
            image.src = url;
        });
        this.textures.set(url, texture);
        while (this.textures.size > 16) {
            const oldestUrl = this.textures.keys().next().value;
            const oldestTexture = this.textures.get(oldestUrl);
            this.textures.delete(oldestUrl);
            if (oldestTexture) this.gl.deleteTexture(oldestTexture);
        }
        return texture;
    }

    _resize() {
        const ratio = Math.min(devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
        const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
    }

    _render(time) {
        this._resize();
        const gl = this.gl;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(0.045, 0.052, 0.058, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
        if (this.drawables.length) {
            if (!this.dragging) this.yaw += 0.00018 * Math.min(40, time - (this.lastTime || time));
            const model = glMatrix.mat4.create();
            glMatrix.mat4.rotateX(model, model, this.pitch);
            glMatrix.mat4.rotateZ(model, model, this.yaw);
            glMatrix.mat4.translate(model, model, [-this.center[0], -this.center[1], -this.center[2]]);
            const projection = glMatrix.mat4.create();
            glMatrix.mat4.perspective(projection, Math.PI / 5, this.canvas.width / this.canvas.height, 0.01, 100);
            const distance = (this.radius * 3.15 + 0.25) * this.zoom;
            const view = glMatrix.mat4.create();
            glMatrix.mat4.lookAt(view, [distance, -distance, distance * 0.28], [0, 0, 0], [0, 0, 1]);
            const vp = glMatrix.mat4.multiply(glMatrix.mat4.create(), projection, view);
            const mvp = glMatrix.mat4.multiply(glMatrix.mat4.create(), vp, model);
            gl.useProgram(this.program.program);
            gl.uniformMatrix4fv(this.uniforms.mvp, false, mvp);
            gl.uniformMatrix4fv(this.uniforms.model, false, model);
            gl.uniform1i(this.uniforms.diffuse, 0);
            for (const row of this.drawables) {
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, row.texture);
                gl.uniform1i(this.uniforms.hasTexture, row.texture ? 1 : 0);
                gl.bindVertexArray(row.mesh.vao);
                gl.drawElements(gl.TRIANGLES, row.mesh.indexCount, gl.UNSIGNED_INT, 0);
            }
            gl.bindVertexArray(null);
        }
        this.lastTime = time;
        this._frame = requestAnimationFrame((next) => this._render(next));
    }
}
