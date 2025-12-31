export class ModelManager {
    constructor(gl) {
        this.gl = gl;
        this.manifest = null; // supports v1+ (simple) and v4 (submeshes/LODs) manifests
        this.meshCache = new Map(); // file -> { vao, indexCount }
        this.meshKeyCount = 0;
        this.nonProxyMeshKeyCount = 0;
        this.manifestVersion = 0;
    }

    async init(manifestPath = 'assets/models/manifest.json') {
        try {
            const resp = await fetch(manifestPath);
            if (!resp.ok) throw new Error(`Failed to fetch ${manifestPath} (status=${resp.status})`);
            this.manifest = await resp.json();
            this.manifestVersion = Number(this.manifest?.version || 0) || 0;
            const keys = Object.keys(this.manifest?.meshes || {});
            this.meshKeyCount = keys.length;
            // Treat hash "0" as the proxy cube entry.
            this.nonProxyMeshKeyCount = keys.filter(k => k !== '0').length;
            return true;
        } catch (e) {
            console.warn('ModelManager: no manifest:', e);
            this.manifest = { version: 1, meshes: {} };
            this.meshKeyCount = 0;
            this.nonProxyMeshKeyCount = 0;
            this.manifestVersion = 0;
            return false;
        }
    }

    hasMesh(hash) {
        const h = String(hash ?? '').trim();
        if (!h) return false;
        const entry = this.manifest?.meshes?.[h];
        if (!entry) return false;
        const lods = entry?.lods;
        if (!lods) return false;

        // v4: entry.lods.high.submeshes[0].file
        const hi = lods?.high;
        if (hi?.submeshes && Array.isArray(hi.submeshes) && hi.submeshes.length > 0) return true;

        // v1: entry.lods.high.file
        if (hi?.file) return true;

        return false;
    }

    _getMeshFiles(hash, lod = 'high') {
        const h = String(hash ?? '').trim();
        if (!h) return [];
        const entry = this.manifest?.meshes?.[h];
        const lodKey = String(lod).toLowerCase();
        const meta = entry?.lods?.[lodKey] || entry?.lods?.high;
        if (!meta) return [];

        // Manifest v4: { submeshes: [{file,...}, ...] }
        if (Array.isArray(meta.submeshes)) {
            const out = [];
            for (const sm of meta.submeshes) {
                const f = String(sm?.file || '').trim();
                if (f) out.push(f);
            }
            return out;
        }

        // Manifest v1: { file: "..." }
        if (meta.file) return [String(meta.file)];
        return [];
    }

    async loadMeshGroup(hash, lod = 'high') {
        const files = this._getMeshFiles(hash, lod);
        if (!files.length) return null;

        const out = [];
        for (const file of files) {
            if (this.meshCache.has(file)) {
                out.push({ file, mesh: this.meshCache.get(file) });
                continue;
            }
            const path = `assets/models/${file}`;
            let buf;
            try {
                const resp = await fetch(path);
                if (!resp.ok) throw new Error(`Failed to fetch ${path} (status=${resp.status})`);
                buf = await resp.arrayBuffer();
            } catch (e) {
                console.warn('ModelManager: fetch failed', path, e);
                continue;
            }
            const mesh = this._parseAndUploadMsh0(buf);
            if (mesh) {
                this.meshCache.set(file, mesh);
                out.push({ file, mesh });
            }
        }

        return out.length ? out : null;
    }

    // Back-compat: return the first submesh if present.
    async loadMesh(hash, lod = 'high') {
        const group = await this.loadMeshGroup(hash, lod);
        if (!group || !group.length) return null;
        return group[0].mesh || null;
    }

    _parseAndUploadMsh0(arrayBuffer) {
        const gl = this.gl;
        const dv = new DataView(arrayBuffer);
        if (dv.byteLength < 20) return null;

        const magic =
            String.fromCharCode(dv.getUint8(0)) +
            String.fromCharCode(dv.getUint8(1)) +
            String.fromCharCode(dv.getUint8(2)) +
            String.fromCharCode(dv.getUint8(3));
        const version = dv.getUint32(4, true);
        const vertexCount = dv.getUint32(8, true);
        const indexCount = dv.getUint32(12, true);
        const flags = dv.getUint32(16, true);

        if (magic !== 'MSH0' || (version !== 1 && version !== 2 && version !== 3)) {
            console.warn('ModelManager: bad mesh header', { magic, version });
            return null;
        }

        const headerBytes = 20;
        const posBytes = vertexCount * 3 * 4;
        const hasNormals = version >= 2 && (flags & 1) === 1;
        const nrmBytes = hasNormals ? vertexCount * 3 * 4 : 0;
        const hasUvs = version >= 3 && (flags & 2) === 2;
        const uvBytes = hasUvs ? vertexCount * 2 * 4 : 0;
        const idxBytes = indexCount * 4;
        if (headerBytes + posBytes + nrmBytes + uvBytes + idxBytes > arrayBuffer.byteLength) {
            console.warn('ModelManager: truncated mesh');
            return null;
        }

        const positions = new Float32Array(arrayBuffer, headerBytes, vertexCount * 3);
        const normals = hasNormals ? new Float32Array(arrayBuffer, headerBytes + posBytes, vertexCount * 3) : null;
        const uvs = hasUvs ? new Float32Array(arrayBuffer, headerBytes + posBytes + nrmBytes, vertexCount * 2) : null;
        const indices = new Uint32Array(arrayBuffer, headerBytes + posBytes + nrmBytes + uvBytes, indexCount);

        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);

        const posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

        let nrmBuffer = null;
        if (normals) {
            nrmBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
        }

        let uvBuffer = null;
        if (uvs) {
            uvBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
            gl.enableVertexAttribArray(2);
            gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
        }

        const idxBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

        gl.bindVertexArray(null);

        return { vao, indexCount, posBuffer, nrmBuffer, uvBuffer, idxBuffer };
    }
}


