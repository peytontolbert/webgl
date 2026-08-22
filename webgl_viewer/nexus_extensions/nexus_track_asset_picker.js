(() => {
    'use strict';

    const rendererState = new WeakMap();
    const PATCH_VERSION = '20260822-trackpicker5';
    const GAMEPLAY_LOCATOR_NODE = /^AC_(?:START|PIT|TIME|HOTLAP_START)(?:_|$)/i;

    function isNonVisualLocatorGroup(model, group) {
        const sourceNodes = Array.isArray(group?.sourceNodes) ? group.sourceNodes.map(String).filter(Boolean) : [];
        if (sourceNodes.length && sourceNodes.every((name) => GAMEPLAY_LOCATOR_NODE.test(name))) return true;
        // Older 4b exports did not retain sourceNodes. The original KN5 audit
        // proves this material group consists exclusively of AC_* gameplay
        // timing/start/pit locator cubes; the visible 4b mesh is `barriers`.
        return String(model?.source || '').toLowerCase() === '4b.kn5'
            && String(group?.material || '').toLowerCase() === 'grail-new';
    }

    function suppressNonVisualLocatorGroups(renderer) {
        if (!renderer?.models?.length) return 0;
        let removed = 0;
        for (const model of renderer.models) {
            const groups = Array.isArray(model?.groups) ? model.groups : [];
            const rejected = groups.filter((group) => isNonVisualLocatorGroup(model, group));
            if (!rejected.length) continue;
            const rejectedPickIds = new Set(rejected.map((group) => group?.pickId).filter(Number.isFinite));
            model.groups = groups.filter((group) => !isNonVisualLocatorGroup(model, group));
            for (const pickId of rejectedPickIds) renderer._pickRecords?.delete?.(pickId);
            removed += rejected.length;
        }
        if (removed) console.warn(`[track-picker] suppressed ${removed} non-visual gameplay locator group(s)`);
        return removed;
    }

    function compile(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const message = gl.getShaderInfoLog(shader) || 'unknown shader error';
            gl.deleteShader(shader);
            throw new Error(`Track picker shader failed: ${message}`);
        }
        return shader;
    }

    function createState(renderer) {
        const gl = renderer.gl;
        const positionLocation = Math.max(0, gl.getAttribLocation(renderer.program?.program, 'aPackedPosition'));
        const uvLocation = Math.max(0, gl.getAttribLocation(renderer.program?.program, 'aUV'));
        const vertex = compile(gl, gl.VERTEX_SHADER, `#version 300 es
layout(location=${positionLocation}) in vec3 aPackedPosition;
layout(location=${uvLocation}) in vec2 aUV;
uniform mat4 uViewProjectionMatrix;
uniform mat4 uModelMatrix;
uniform vec3 uMinimum;
uniform vec3 uSpan;
uniform float uPositionIsAbsolute;
out vec2 vUV;
void main() {
    vec3 packed = uMinimum + (aPackedPosition / 65535.0) * uSpan;
    vec3 dataPosition = mix(packed, aPackedPosition, uPositionIsAbsolute);
    vUV = aUV;
    gl_Position = uViewProjectionMatrix * uModelMatrix * vec4(dataPosition, 1.0);
}`);
        const fragment = compile(gl, gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
uniform vec3 uPickColor;
uniform sampler2D uDiffuse;
uniform float uHasDiffuse;
uniform float uAlphaCutoff;
in vec2 vUV;
out vec4 fragColor;
void main() {
    if (uAlphaCutoff >= 0.0 && uHasDiffuse > 0.5
        && texture(uDiffuse, vUV).a < uAlphaCutoff) discard;
    fragColor = vec4(uPickColor, 1.0);
}`);
        const program = gl.createProgram();
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const message = gl.getProgramInfoLog(program) || 'unknown link error';
            gl.deleteProgram(program);
            throw new Error(`Track picker program failed: ${message}`);
        }

        const framebuffer = gl.createFramebuffer();
        const color = gl.createTexture();
        const depth = gl.createRenderbuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.bindTexture(gl.TEXTURE_2D, color);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
        gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, 1, 1);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            throw new Error('Track picker framebuffer is incomplete');
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return {
            program,
            framebuffer,
            pixel: new Uint8Array(4),
            pickMatrix: new Float32Array(16),
            pickViewProjection: new Float32Array(16),
            records: new Map(),
            entries: [],
            metadataGroups: [],
            sceneUrl: '',
            uniforms: {
                viewProjection: gl.getUniformLocation(program, 'uViewProjectionMatrix'),
                model: gl.getUniformLocation(program, 'uModelMatrix'),
                minimum: gl.getUniformLocation(program, 'uMinimum'),
                span: gl.getUniformLocation(program, 'uSpan'),
                absolute: gl.getUniformLocation(program, 'uPositionIsAbsolute'),
                color: gl.getUniformLocation(program, 'uPickColor'),
                diffuse: gl.getUniformLocation(program, 'uDiffuse'),
                hasDiffuse: gl.getUniformLocation(program, 'uHasDiffuse'),
                alphaCutoff: gl.getUniformLocation(program, 'uAlphaCutoff'),
            },
        };
    }

    function multiply(out, left, right) {
        for (let column = 0; column < 4; column++) {
            for (let row = 0; row < 4; row++) {
                out[column * 4 + row] = left[row] * right[column * 4]
                    + left[4 + row] * right[column * 4 + 1]
                    + left[8 + row] * right[column * 4 + 2]
                    + left[12 + row] * right[column * 4 + 3];
            }
        }
    }

    async function refreshMetadata(renderer, state) {
        const sceneUrl = String(renderer.sceneUrl || '');
        if (!sceneUrl || state.sceneUrl === sceneUrl) return;
        state.sceneUrl = sceneUrl;
        state.entries = [];
        state.metadataGroups = [];
        try {
            const response = await fetch(sceneUrl, { cache: 'no-store' });
            const metadata = response.ok ? await response.json() : null;
            const entries = Array.isArray(metadata?.models) ? metadata.models.slice() : [];
            entries.sort((left, right) => Number(String(right?.source || '').toLowerCase() === 'ks_nordschleife.kn5')
                - Number(String(left?.source || '').toLowerCase() === 'ks_nordschleife.kn5'));
            state.entries = entries.filter((entry) => String(entry?.file || '') && Array.isArray(entry?.groups) && entry.groups.length);
            state.metadataGroups = state.entries.flatMap((entry) => entry.groups.map((group, groupIndex) => ({ entry, group, groupIndex })));
        } catch (error) {
            console.warn('[track-picker] metadata unavailable:', error);
        }
    }

    function textureKey(value) {
        const text = String(value || '');
        const clean = text.split(/[?#]/, 1)[0];
        return clean.slice(clean.lastIndexOf('/') + 1).toLowerCase();
    }

    function resolveAuthoredMetadata(state, runtimeGroup) {
        const runtimeTextures = runtimeGroup?.textures || {};
        const runtimeSlots = new Map(Object.entries(runtimeTextures).map(([slot, url]) => [slot, textureKey(url)]).filter(([, key]) => key));
        if (!runtimeSlots.size || !state.metadataGroups.length) return null;
        let best = null;
        let bestScore = 0;
        for (const candidate of state.metadataGroups) {
            const authored = candidate.group || {};
            const authoredTextures = authored.textures || (authored.texture ? { diffuse: authored.texture } : {});
            let score = 0;
            for (const [slot, key] of runtimeSlots) {
                const authoredKey = textureKey(authoredTextures[slot]);
                if (authoredKey && authoredKey === key) score += slot === 'diffuse' ? 30 : 12;
            }
            if (!score) continue;
            const runtimeProperties = runtimeGroup.properties || {};
            const authoredProperties = authored.properties || {};
            for (const [name, value] of Object.entries(runtimeProperties)) {
                const other = Number(authoredProperties[name]);
                if (Number.isFinite(other) && Math.abs(other - Number(value)) < 1e-5) score += 1;
            }
            if (Number(runtimeGroup.count) === Number(authored.count)) score += 8;
            if (score > bestScore) {
                best = candidate;
                bestScore = score;
            }
        }
        return best ? { ...best, score: bestScore } : null;
    }

    function loadedStats(renderer) {
        const models = Array.isArray(renderer.models) ? renderer.models : [];
        let drawCalls = 0;
        let triangles = 0;
        for (const model of models) for (const group of model.groups || []) {
            drawCalls++;
            triangles += Math.max(0, Number(group.count) || 0) / 3;
        }
        return {
            drawCalls,
            triangles,
            instances: models.length,
            bucketDraws: drawCalls,
            submeshDraws: drawCalls,
            drawItems: drawCalls,
            coarseFrustumCulled: 0,
            projectedSizeCulled: 0,
            lodDistanceCulled: 0,
            latePassCulled: 0,
            budgetCulled: 0,
            diffuseWanted: drawCalls,
            diffusePlaceholder: 0,
            diffuseReal: drawCalls,
            diffuseMissingFromIndex: 0,
            drawItemsMissingUv: 0,
            statsScope: 'loaded-track-scene',
        };
    }

    function emptyReport(renderer, opts) {
        return {
            schema: 'webglgta-demo-asset-pick-v1',
            timeIso: new Date().toISOString(),
            click: {
                x: opts.x,
                y: opts.y,
                viewportWidth: opts.viewportWidth,
                viewportHeight: opts.viewportHeight,
                maxPixelDistance: opts.maxPixelDistance || 0,
                ray: null,
            },
            selected: null,
            nearby: [],
            rendererStats: loadedStats(renderer),
            textureFrame: { schema: 'webglgta-texture-frame-report-v1', limit: 25, missingFromExportedSet: [], placeholderUrls: [] },
        };
    }

    function pick(renderer, opts) {
        let state = rendererState.get(renderer);
        if (!state) {
            state = createState(renderer);
            rendererState.set(renderer, state);
            void refreshMetadata(renderer, state);
        } else {
            void refreshMetadata(renderer, state);
        }
        const report = emptyReport(renderer, opts);
        const gl = renderer.gl;
        const width = Math.max(1, Number(opts.viewportWidth) || 1);
        const height = Math.max(1, Number(opts.viewportHeight) || 1);
        const x = Number(opts.x);
        const y = Number(opts.y);
        const vp = opts.viewProjectionMatrix;
        if (!renderer.ready || !renderer.models?.length || !vp || !Number.isFinite(x) || !Number.isFinite(y)) return report;

        const nx = (2 * x / width) - 1;
        const ny = 1 - (2 * y / height);
        state.pickMatrix.fill(0);
        state.pickMatrix[0] = width;
        state.pickMatrix[5] = height;
        state.pickMatrix[10] = 1;
        state.pickMatrix[12] = -width * nx;
        state.pickMatrix[13] = -height * ny;
        state.pickMatrix[15] = 1;
        multiply(state.pickViewProjection, state.pickMatrix, vp);

        const oldFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        const oldViewport = gl.getParameter(gl.VIEWPORT);
        const oldBlend = gl.isEnabled(gl.BLEND);
        const oldCull = gl.isEnabled(gl.CULL_FACE);
        const oldDither = gl.isEnabled(gl.DITHER);
        const oldDepth = gl.isEnabled(gl.DEPTH_TEST);
        const oldDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
        const oldActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
        gl.activeTexture(gl.TEXTURE0);
        const oldTexture0 = gl.getParameter(gl.TEXTURE_BINDING_2D);
        state.records.clear();
        let pickId = 1;
        try {
            gl.bindFramebuffer(gl.FRAMEBUFFER, state.framebuffer);
            gl.viewport(0, 0, 1, 1);
            gl.disable(gl.BLEND);
            gl.disable(gl.CULL_FACE);
            gl.disable(gl.DITHER);
            gl.enable(gl.DEPTH_TEST);
            gl.depthMask(true);
            gl.clearColor(0, 0, 0, 0);
            gl.clearDepth(1);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.useProgram(state.program);
            gl.uniformMatrix4fv(state.uniforms.viewProjection, false, state.pickViewProjection);
            gl.uniformMatrix4fv(state.uniforms.model, false, renderer.modelMatrix);
            gl.uniform1i(state.uniforms.diffuse, 0);
            renderer.models.forEach((model, modelIndex) => {
                gl.uniform3fv(state.uniforms.minimum, model.minimum);
                gl.uniform3fv(state.uniforms.span, model.span);
                gl.uniform1f(state.uniforms.absolute, model.absolutePositions ? 1 : 0);
                gl.bindVertexArray(model.vao);
                (model.groups || []).forEach((group, groupIndex) => {
                    const id = pickId++;
                    state.records.set(id, { model, modelIndex, group, groupIndex });
                    const diffuseUrl = group.textures?.diffuse;
                    const diffuseTexture = diffuseUrl ? renderer.textureCache?.get?.(diffuseUrl)?.texture : null;
                    const alphaMode = String(group.alphaMode || 'opaque');
                    const authoredCutoff = Number(group.properties?.ksalpharef ?? group.properties?.alpharef);
                    const alphaCutoff = alphaMode === 'cutout'
                        ? Math.max(0.01, Math.min(0.99, Number.isFinite(authoredCutoff) ? authoredCutoff : 0.5))
                        : (alphaMode === 'blend' ? 0.01 : -1);
                    gl.activeTexture(gl.TEXTURE0);
                    gl.bindTexture(gl.TEXTURE_2D, diffuseTexture || null);
                    gl.uniform1f(state.uniforms.hasDiffuse, diffuseTexture ? 1 : 0);
                    gl.uniform1f(state.uniforms.alphaCutoff, alphaCutoff);
                    gl.uniform3f(state.uniforms.color, (id & 255) / 255, ((id >>> 8) & 255) / 255, ((id >>> 16) & 255) / 255);
                    gl.drawElements(gl.TRIANGLES, group.count, gl.UNSIGNED_INT, group.offset * Uint32Array.BYTES_PER_ELEMENT);
                });
            });
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, state.pixel);
        } finally {
            gl.bindVertexArray(null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, oldFramebuffer);
            gl.viewport(oldViewport[0], oldViewport[1], oldViewport[2], oldViewport[3]);
            if (oldBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
            if (oldCull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
            if (oldDither) gl.enable(gl.DITHER); else gl.disable(gl.DITHER);
            if (oldDepth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
            gl.depthMask(oldDepthMask);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, oldTexture0);
            gl.activeTexture(oldActiveTexture);
        }

        const id = state.pixel[0] | (state.pixel[1] << 8) | (state.pixel[2] << 16);
        const hit = state.records.get(id);
        if (!hit) return report;
        const group = hit.group;
        const authored = resolveAuthoredMetadata(state, group);
        const entry = authored?.entry || {};
        const authoredGroup = authored?.group || {};
        const textures = {};
        for (const [slot, url] of Object.entries(group.textures || authoredGroup.textures || {})) {
            const cached = renderer.textureCache?.get?.(url);
            textures[slot] = { rel: url, state: cached?.ready ? 'resident' : 'pending', missingFromIndex: false, missing404: false, rejected: false };
        }
        report.selected = {
            pick: { method: 'trackGpuIdBuffer', distancePx: 0, score: 0, groupId: id },
            identity: {
                hash: `track:${entry.source || entry.file || hit.modelIndex}:${authored?.groupIndex ?? hit.groupIndex}`,
                lod: renderer.sceneQuality === 'full' ? 'high' : 'medium',
                file: entry.file || null,
                source: entry.source || null,
                material: authoredGroup.material || group.material || null,
                groupIndex: authored?.groupIndex ?? null,
                runtimeGroupIndex: hit.groupIndex,
                metadataMatchScore: authored?.score ?? 0,
            },
            instance: {
                index: hit.groupIndex,
                count: 1,
                dataPosition: null,
                centerData: hit.model.boundsMin?.map((value, index) => (value + hit.model.boundsMax[index]) * 0.5) || null,
                boundsData: hit.model.boundsMin && hit.model.boundsMax ? { min: Array.from(hit.model.boundsMin), max: Array.from(hit.model.boundsMax) } : null,
            },
            mesh: { triangles: Number(group.count || 0) / 3, indexOffset: group.offset, indexCount: group.count },
            material: {
                shaderName: authoredGroup.shader || group.shader || null,
                shaderFamily: /multilayer/i.test(String(authoredGroup.shader || '')) ? 'multilayer' : 'track',
                renderBucket: authoredGroup.alphaMode || group.alphaMode || 'opaque',
                raw: authoredGroup,
            },
            textures,
            culling: { visible: true, renderer: 'TrackSceneRenderer' },
        };
        return report;
    }

    function install(app) {
        if (!app) return false;
        if (app._inspectDemoAssetAtClientPoint?.__nexusTrackPickerVersion === PATCH_VERSION) return true;
        const originalInspect = app._inspectDemoAssetAtClientPoint;
        if (typeof originalInspect !== 'function') return false;
        const inspectActiveRenderer = function inspectActiveRenderer(clientX, clientY) {
            const track = this.trackSceneRenderer;
            // The current production bundle uses _nordschleifeActive.  Newer
            // source builds use _activeWorldExpansion.  Support both instead
            // of silently routing a live track click into the empty city
            // instance renderer.
            const trackActive = (!!this._nordschleifeActive
                || this._activeWorldExpansion?.id === 'nordschleife')
                && !!track?.models?.length;
            if (!trackActive) return originalInspect.call(this, clientX, clientY);
            if (!this.assetPickerEnabled || !this.spawnDistrictDemo || !this.canvas) return;
            const rect = this.canvas.getBoundingClientRect();
            if (!(rect?.width > 0) || !(rect?.height > 0)) return;
            const x = (Number(clientX) - rect.left) * (this.canvas.width / rect.width);
            const y = (Number(clientY) - rect.top) * (this.canvas.height / rect.height);
            let report;
            try {
                report = pick(track, {
                    x,
                    y,
                    viewportWidth: this.canvas.width,
                    viewportHeight: this.canvas.height,
                    viewProjectionMatrix: this.camera?.viewProjectionMatrix,
                    maxPixelDistance: 0,
                });
            } catch (error) {
                console.warn('[track-picker] pick failed:', error);
                report = emptyReport(track, { x, y, viewportWidth: this.canvas.width, viewportHeight: this.canvas.height, maxPixelDistance: 0 });
            }
            report.app = this._buildAssetInspectorAppState?.() || {};
            report.app.activeRenderer = 'TrackSceneRenderer';
            report.app.assetPickerRuntime = {
                version: PATCH_VERSION,
                handler: 'active-track-gpu-id-buffer',
                nordschleifeActive: !!this._nordschleifeActive,
            };
            report.app.renderStats = report.rendererStats;
            report.app.trackCoverage = {
                active: true,
                descriptorLoaded: !!track.sceneUrl,
                sceneUrl: track.sceneUrl || null,
                quality: track.sceneQuality || null,
                loading: !!track.loading,
                error: track.error || null,
                ...(track.stats || {}),
                pickerRayRegistration: 'track GPU material-ID pass active',
            };
            this._showAssetInspectorReport?.(report);
        };
        inspectActiveRenderer.__nexusTrackPickerVersion = PATCH_VERSION;
        app._inspectDemoAssetAtClientPoint = inspectActiveRenderer;
        console.info(`[track-picker] active-renderer asset selection installed (${PATCH_VERSION})`);
        return true;
    }

    const timer = window.setInterval(() => {
        // Keep this as a cheap guard. Deployment extensions initialize in
        // parallel and a late patch must not be allowed to replace the active
        // renderer selector without diagnostics noticing.
        const app = window.__viewerApp;
        install(app);
        const track = app?.trackSceneRenderer;
        if (track?.ready && track?.sceneUrl && track?.models?.length) {
            suppressNonVisualLocatorGroups(track);
            let state = rendererState.get(track);
            if (!state) {
                try {
                    state = createState(track);
                    rendererState.set(track, state);
                } catch (error) {
                    console.warn('[track-picker] initialization failed:', error);
                }
            }
            if (state) void refreshMetadata(track, state);
        }
    }, 500);
    window.addEventListener('beforeunload', () => window.clearInterval(timer), { once: true });
})();
