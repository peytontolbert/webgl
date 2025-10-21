// Import gl-matrix
import * as glMatrix from 'gl-matrix';
import { Camera } from './camera.js';
import { TerrainRenderer } from './terrain_renderer.js';

export class App {
    constructor(canvas) {
        this.canvas = canvas;
        
        // Get WebGL context with error checking
        this.gl = canvas.getContext('webgl2');
        if (!this.gl) {
            console.error('WebGL 2 not supported, falling back to WebGL 1');
            this.gl = canvas.getContext('webgl');
            if (!this.gl) {
                console.error('Failed to get WebGL context');
                return;
            }
        }
        console.log('WebGL context created successfully');
        
        // Initialize camera first
        this.camera = new Camera();
        console.log('Camera initialized');
        
        // Initialize terrain renderer
        this.terrainRenderer = new TerrainRenderer(this.gl);
        console.log('Terrain renderer initialized');
        
        // Load terrain mesh and textures
        this.initializeTerrain();
        
        // Set initial canvas size after camera is initialized
        this.resize();
        
        // Setup event listeners
        this.setupEventListeners();
        
        // Start animation loop
        this.animate();
    }
    
    async initializeTerrain() {
        try {
            // Load terrain mesh first
            await this.terrainRenderer.loadTerrainMesh();
            
            // Then load textures
            await this.loadTextures();
        } catch (error) {
            console.error('Failed to initialize terrain:', error);
        }
    }
    
    async loadTextures() {
        try {
            console.log('Loading terrain textures...');
            
            // Load terrain info first to get texture information
            const infoResponse = await fetch('assets/terrain_info.json');
            if (!infoResponse.ok) throw new Error('Failed to load terrain info');
            
            const info = await infoResponse.json();
            
            if (!info.texture_info) {
                throw new Error('No texture information found in terrain info');
            }
            
            // Find the main terrain texture (usually grass or ground)
            const mainTexture = Object.entries(info.texture_info).find(([name, tex]) => 
                name.includes('grass') || name.includes('ground') || name.includes('dirt')
            );
            
            if (mainTexture) {
                const [name, tex] = mainTexture;
                // Load diffuse texture
                await this.terrainRenderer.loadTexture('diffuse', `assets/textures/${name}_diffuse.png`);
                // Load normal map if available
                if (tex.has_normal) {
                    await this.terrainRenderer.loadTexture('normal', `assets/textures/${name}_normal.png`);
                }
            }
            
            // Load additional layers if available
            if (info.texture_info.layers) {
                for (let i = 0; i < Math.min(4, info.texture_info.layers.length); i++) {
                    const layer = info.texture_info.layers[i];
                    await this.terrainRenderer.loadTexture(`layer${i + 1}`, `assets/textures/${layer.name}_diffuse.png`);
                    if (layer.has_normal) {
                        await this.terrainRenderer.loadTexture(`normal${i + 1}`, `assets/textures/${layer.name}_normal.png`);
                    }
                }
            }
            
            // Load blend mask
            if (info.texture_info.blend_mask) {
                await this.terrainRenderer.loadTexture('blendMask', `assets/textures/terrain_blend_mask.png`);
            }
            
        } catch (error) {
            console.error('Failed to load textures:', error);
            console.error('Error stack:', error.stack);
        }
    }
    
    setupEventListeners() {
        // Window resize
        window.addEventListener('resize', () => {
            this.resize();
        });
        
        // Mouse movement
        let isDragging = false;
        let lastX = 0;
        let lastY = 0;
        
        this.canvas.addEventListener('mousedown', (e) => {
            isDragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
        });
        
        this.canvas.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            
            const deltaX = e.clientX - lastX;
            const deltaY = e.clientY - lastY;
            
            this.camera.rotate(deltaX, deltaY);
            
            lastX = e.clientX;
            lastY = e.clientY;
        });
        
        this.canvas.addEventListener('mouseup', () => {
            isDragging = false;
        });
        
        // Mouse wheel
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.camera.zoom(e.deltaY * 0.001);
        });
        
        // Keyboard controls
        const keyState = {};
        
        window.addEventListener('keydown', (e) => {
            keyState[e.key.toLowerCase()] = true;
        });
        
        window.addEventListener('keyup', (e) => {
            keyState[e.key.toLowerCase()] = false;
        });
        
        // Update movement in animation loop
        this.keyState = keyState;
        
        // UI controls
        document.getElementById('wireframe').addEventListener('change', (e) => {
            this.terrainRenderer.setWireframeMode(e.target.checked);
        });
    }
    
    resize() {
        // Update canvas size
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        
        // Update camera
        this.camera.resize(this.canvas.width, this.canvas.height);
        
        // Update viewport
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        
        console.log(`Canvas resized to ${this.canvas.width}x${this.canvas.height}`);
    }
    
    update() {
        // Handle keyboard input
        const moveSpeed = 0.1;
        const moveDir = glMatrix.vec3.create();
        
        if (this.keyState['w']) moveDir[2] -= moveSpeed;
        if (this.keyState['s']) moveDir[2] += moveSpeed;
        if (this.keyState['a']) moveDir[0] -= moveSpeed;
        if (this.keyState['d']) moveDir[0] += moveSpeed;
        if (this.keyState['q']) moveDir[1] += moveSpeed;
        if (this.keyState['e']) moveDir[1] -= moveSpeed;
        
        if (glMatrix.vec3.length(moveDir) > 0) {
            glMatrix.vec3.normalize(moveDir, moveDir);
            this.camera.move(moveDir);
        }
    }
    
    render() {
        // Clear canvas with a dark gray color to make it easier to see if rendering is working
        this.gl.clearColor(0.2, 0.2, 0.2, 1.0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
        
        // Enable depth testing
        this.gl.enable(this.gl.DEPTH_TEST);
        
        // Check for WebGL errors
        const error = this.gl.getError();
        if (error !== this.gl.NO_ERROR) {
            console.error('WebGL error before render:', error);
        }
        
        // Render terrain
        this.terrainRenderer.render(this.camera.viewProjectionMatrix);
        
        // Check for WebGL errors after render
        const errorAfter = this.gl.getError();
        if (errorAfter !== this.gl.NO_ERROR) {
            console.error('WebGL error after render:', errorAfter);
        }
    }
    
    animate() {
        this.update();
        this.render();
        requestAnimationFrame(() => this.animate());
    }
}

// Start application when page loads
window.addEventListener('load', () => {
    const canvas = document.getElementById('glCanvas');
    new App(canvas);
}); 