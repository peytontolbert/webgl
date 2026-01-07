### CodeWalker render pipeline parity notes (viewer-facing)

This doc is a **practical parity checklist** between:

- CodeWalker DX11 renderer (`CodeWalker/Rendering/*`)
- This project’s WebGL viewer (primarily `webgl_viewer/js/instanced_model_renderer.js` + `webgl_viewer/js/model_manager.js`)

It focuses on **pipeline structure + render states** (textures/shaders are tracked elsewhere).

### CodeWalker: high-level passes

CodeWalker’s `ShaderManager` owns the “engine” render pipeline and state objects:

- **Opaque geometry pass**
  - Uses `bsDefault` + `dsEnabled` (depth write on)
  - Draws most world geometry via `RenderBuckets`
- **Cutout/foliage**
  - Uses `bsAlpha` (**AlphaToCoverageEnable=true**) for “grass…”
  - Still generally uses depth writes
- **Decals**
  - Uses blended output + depth write off (varies by shader)
  - Uses polygon offset style depth biasing in some cases (shader-specific)
- **Transparent**
  - Uses `dsDisableWrite` (depth write off) + blending
- **Additive**
  - Uses `bsAdd` (additive blend) and often `dsDisableWrite` or `dsDisableWriteRev`

### CodeWalker: forward vs deferred

CodeWalker supports a **deferred mode** (`ShaderManager.deferred`):

- **Deferred geometry**: shaders output into G-buffers (diffuse/normals/spec/irradiance).
  - See `CodeWalker/Rendering/Shaders/DeferredScene.cs` and `*PS_Deferred.hlsl` variants.
- **Deferred lights**: additive light volumes/quads reading G-buffers.
  - Uses `bsAdd` + `dsDisableWriteRev` for certain light volume cases.
- **SSAA resolve**: optional deferred AA pass (`DeferredScene.SSAASampleCount`).

### CodeWalker: shadows

- Shadowmap rendering is handled by `CodeWalker/Rendering/Utils/Shadowmap.cs` + `ShadowShader.cs`
- Most material shaders have `EnableShadows` flags and sample the shadowmap.

### Viewer today (WebGL): what maps cleanly

The viewer is currently **forward-only**, but we emulate CodeWalker’s “bucketed” ordering:

- **Opaque → Cutout → Decal → Alpha → Additive** ordering exists in `InstancedModelRenderer.render()`
- Depth/blend variants (best-effort):
  - **Opaque/Cutout**: blend off, depth write on
  - **Blend**: blend on, depth write off (unless “hard alpha blend”)
  - **Decal**: polygon offset + blend on + depth write off
  - **Alpha-to-coverage**: enabled for cutout when `material.alphaToCoverage` is true

### Viewer gaps (planned work)

To reach CodeWalker’s pipeline parity, the remaining big items are:

- **Deferred path**:
  - G-buffer framebuffer with 3–4 attachments
  - Fullscreen + light-volume passes for local lights
  - A resolve/tonemap pass (and optional SSAA)
- **Shadowmaps**:
  - Shadowmap render pass + sampling in forward/deferred
- **“Transparency AA” beyond A2C**:
  - CodeWalker/engine has a `gUseTransparencyAA` concept; in WebGL we’ll likely approximate with:
    - MSAA + A2C for cutouts
    - optional screen-door/dither for “hard alpha blend” cases
    - (future) post-AA for transparent edges


