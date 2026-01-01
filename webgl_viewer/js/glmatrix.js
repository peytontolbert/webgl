/**
 * Unified gl-matrix access that works for BOTH:
 * - Vite dev/build (bundler)
 * - Plain static servers (python http.server), where the browser cannot resolve "gl-matrix"
 *
 * We avoid top-level await for broad build-target compatibility.
 */

// Static servers can't resolve bare specifiers like "gl-matrix". Use a relative import instead.
// Vite will still bundle this into dist output, so dist does NOT depend on node_modules at runtime.
import * as glMatrixMod from '../node_modules/gl-matrix/esm/index.js';

// Prefer an explicitly-provided global if present (useful for debugging),
// otherwise use the imported module.
const glMatrix = (typeof window !== 'undefined' && window.glMatrix) ? window.glMatrix : glMatrixMod;

export { glMatrix };


