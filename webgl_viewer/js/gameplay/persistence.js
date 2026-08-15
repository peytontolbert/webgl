const STORAGE_KEY = 'webglgta.gameplay.state.v1';

export class GameplayPersistence {
    constructor({ key = STORAGE_KEY, throttleMs = 1200 } = {}) {
        this.key = key;
        this.throttleMs = throttleMs;
        this._lastSaveMs = 0;
        this.lastSavedAt = '';
        this.lastError = '';
    }

    update(app, manifest) {
        const now = performance.now();
        if (now - this._lastSaveMs < this.throttleMs) return;
        this._lastSaveMs = now;
        this.save(app, manifest);
    }

    save(app, manifest) {
        this.lastError = '';
        try {
            const ped = app?.ped || null;
            const player = app?.player || null;
            const payload = {
                version: 1,
                savedAt: new Date().toISOString(),
                manifest: {
                    mode: manifest?.mode || '',
                    generatedAt: manifest?.generatedAt || '',
                    source: manifest?.source || null,
                },
                ped: ped ? {
                    posData: [
                        Number(ped.posData?.[0]) || 0,
                        Number(ped.posData?.[1]) || 0,
                        Number(ped.posData?.[2]) || 0,
                    ],
                } : null,
                player: player?.enabled ? {
                    headingRad: Number(player.headingRad) || 0.0,
                    hash: String(player.hash || ''),
                    hashes: Array.isArray(player.hashes) ? player.hashes.slice(0, 64).map((h) => String(h)) : [],
                } : null,
                vehicle: app?.vehicleController?.vehicle ? {
                    inVehicle: !!app.vehicleController.inVehicle,
                    vehicle: app.vehicleController.getRenderState?.() || app.vehicleController.vehicle,
                } : { inVehicle: false, vehicle: null },
            };
            window.localStorage.setItem(this.key, JSON.stringify(payload));
            this.lastSavedAt = payload.savedAt;
            return true;
        } catch (e) {
            this.lastError = String(e?.message || e || 'save failed');
            return false;
        }
    }

    restore(app) {
        this.lastError = '';
        try {
            const raw = window.localStorage.getItem(this.key);
            if (!raw) return false;
            const data = JSON.parse(raw);
            const pos = data?.ped?.posData;
            if (!Array.isArray(pos) || pos.length < 3) return false;
            if (!app?.spawnPedAt) return false;
            const p = [Number(pos[0]) || 0, Number(pos[1]) || 0, Number(pos[2]) || 0];
            app.spawnPedAt(p, { groundSource: 'gameplay_restore' });
            if (app.player && data?.player) {
                app.player.enabled = true;
                app.player.headingRad = Number(data.player.headingRad) || 0.0;
                app.player.hash = String(data.player.hash || app.player.hash || '');
                app.player.hashes = Array.isArray(data.player.hashes)
                    ? data.player.hashes.slice(0, 64).map((h) => String(h)).filter(Boolean)
                    : app.player.hashes;
            }
            if (data?.vehicle?.vehicle && app.vehicleController) {
                app.vehicleController.restoreState?.(data.vehicle.vehicle, !!data.vehicle.inVehicle);
            }
            return true;
        } catch (e) {
            this.lastError = String(e?.message || e || 'restore failed');
            return false;
        }
    }

    getStatusLine() {
        if (this.lastError) return `Persistence: ${this.lastError}`;
        return this.lastSavedAt ? `Persistence: saved ${this.lastSavedAt}` : 'Persistence: pending';
    }
}
