export class SpawnSystem {
    constructor() {
        this.manifest = null;
        this.lastError = null;
    }

    async load({ timeoutMs = 900, refresh = false } = {}) {
        this.lastError = null;
        const urls = refresh
            ? [`/__gameplay/manifest?refresh=1&t=${Date.now()}`, 'assets/runtime_gameplay_manifest.json']
            : ['assets/runtime_gameplay_manifest.json', '/__gameplay/manifest'];

        for (const url of urls) {
            try {
                const data = await this._fetchJson(url, timeoutMs);
                if (data?.ok && typeof data === 'object') {
                    this.manifest = data;
                    return data;
                }
            } catch (e) {
                this.lastError = String(e?.message || e || 'manifest load failed');
            }
        }
        return null;
    }

    setManifest(manifest) {
        this.manifest = manifest && typeof manifest === 'object' ? manifest : null;
    }

    getPrimarySpawn() {
        const cur = this.manifest?.spawn?.current || null;
        if (this._isVector(cur)) return cur;
        const first = this.getSpawnCandidates()[0] || null;
        return this._isVector(first) ? first : null;
    }

    getSpawnCandidates() {
        const raw = this.manifest?.spawn?.candidates;
        return Array.isArray(raw) ? raw.filter((v) => this._isVector(v)) : [];
    }

    summarize() {
        const m = this.manifest || {};
        return {
            mode: String(m.mode || 'none'),
            generatedAt: String(m.generatedAt || ''),
            jobs: Array.isArray(m.jobs) ? m.jobs.length : 0,
            items: Array.isArray(m.inventory?.items) ? m.inventory.items.length : 0,
            shops: Array.isArray(m.shops) ? m.shops.length : 0,
            garages: Array.isArray(m.garages) ? m.garages.length : 0,
            vehicleShops: Array.isArray(m.vehicleShops) ? m.vehicleShops.length : 0,
            vehicles: Array.isArray(m.vehicles) ? m.vehicles.length : 0,
            interactions: Array.isArray(m.interactions) ? m.interactions.length : 0,
        };
    }

    async _fetchJson(url, timeoutMs) {
        const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const ms = Math.max(250, Number(timeoutMs) || 900);
        const timer = ac ? window.setTimeout(() => ac.abort(), ms) : null;
        try {
            const resp = await fetch(url, { cache: 'no-store', signal: ac?.signal });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return await resp.json();
        } finally {
            if (timer !== null) window.clearTimeout(timer);
        }
    }

    _isVector(v) {
        return !!v &&
            Number.isFinite(Number(v.x)) &&
            Number.isFinite(Number(v.y)) &&
            Number.isFinite(Number(v.z));
    }
}
