import { defineConfig } from 'vite';

// IMPORTANT:
// - We keep `dist/assets/` for large runtime/exported GTA assets (terrain_info.json, textures, models, etc.)
// - We move Vite's bundled JS/CSS output out of `dist/assets/` so our postbuild sync doesn't overwrite it.
export default defineConfig({
  build: {
    assetsDir: 'bundled',
  },
});


