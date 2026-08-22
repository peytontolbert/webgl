import { NX_BANK_BRANCHES, NX_DEMO_ATMS } from './banking_locations.js';

function finite(n, fallback = 0.0) {
    const v = Number(n);
    return Number.isFinite(v) ? v : fallback;
}

function coordsFrom(value) {
    const c = value?.coords || value;
    if (!c || !Number.isFinite(Number(c.x)) || !Number.isFinite(Number(c.y)) || !Number.isFinite(Number(c.z))) {
        return null;
    }
    return {
        x: Number(c.x),
        y: Number(c.y),
        z: Number(c.z),
        w: Number(c.w) || 0.0,
    };
}

function distSq3(a, b) {
    const dx = a[0] - b.x;
    const dy = a[1] - b.y;
    const dz = a[2] - b.z;
    return dx * dx + dy * dy + dz * dz;
}

export class InteractionSystem {
    constructor() {
        this.manifest = null;
        this.spots = [];
        this.active = null;
        this.lastAction = null;
        this._wasUseDown = false;
    }

    setManifest(manifest) {
        this.manifest = manifest && typeof manifest === 'object' ? manifest : null;
        const spots = [];
        this._append(spots, this.manifest?.interactions, 'interaction');
        this._append(spots, this.manifest?.shops, 'shop', 'open_shop');
        this._append(spots, this.manifest?.garages, 'garage', 'open_garage');
        this._append(spots, this.manifest?.vehicleShops, 'vehicle_shop', 'open_vehicle_shop');
        this._append(spots, this.manifest?.apartments, 'apartment', 'enter_apartment');
        this._append(spots, this.manifest?.housing, 'housing', 'enter_property');
        this._append(spots, this.manifest?.doors, 'door', 'use_door');
        this._append(spots, NX_BANK_BRANCHES, 'bank', 'open_bank');
        this._append(spots, NX_DEMO_ATMS, 'atm', 'open_atm');
        this.spots = this._dedupe(spots);
    }

    update({ posData, keyState } = {}) {
        this.lastAction = null;
        if (!Array.isArray(posData) || posData.length < 3) {
            this.active = null;
            this._wasUseDown = !!keyState?.e;
            return null;
        }

        let nearest = null;
        let nearestD2 = Infinity;
        for (const spot of this.spots) {
            const d2 = distSq3(posData, spot.coords);
            const r = finite(spot.radius, 2.5);
            if (d2 <= r * r && d2 < nearestD2) {
                nearest = { ...spot, distance: Math.sqrt(d2) };
                nearestD2 = d2;
            }
        }
        this.active = nearest;

        const useDown = !!(keyState?.e || keyState?.enter);
        if (nearest && useDown && !this._wasUseDown) {
            this.lastAction = {
                type: nearest.action || 'interact',
                spot: nearest,
                at: Date.now(),
            };
        }
        this._wasUseDown = useDown;
        return this.lastAction;
    }

    getStatusLine() {
        if (!this.manifest) return 'Gameplay: manifest not loaded';
        const active = this.active
            ? `near=${this.active.label || this.active.type} action=${this.active.action || 'interact'}`
            : 'near=none';
        const counts = `spots=${this.spots.length}`;
        const action = this.lastAction
            ? ` last=${this.lastAction.type}:${this.lastAction.spot?.label || ''}`
            : '';
        return `Gameplay: ${counts} ${active}${action}`;
    }

    _append(out, raw, fallbackType, fallbackAction = '') {
        if (!Array.isArray(raw)) return;
        for (const item of raw) {
            const coords = coordsFrom(item);
            if (!coords) continue;
            const type = String(item.type || fallbackType || 'interaction');
            out.push({
                id: String(item.id || `${type}:${coords.x}:${coords.y}:${coords.z}`),
                type,
                action: String(item.action || fallbackAction || this._actionFor(type)),
                label: String(item.label || item.name || type),
                coords,
                radius: Math.max(0.5, finite(item.radius, this._radiusFor(type))),
                source: String(item.source || ''),
                locked: item.locked === true,
            });
        }
    }

    _dedupe(spots) {
        const seen = new Set();
        const out = [];
        for (const s of spots) {
            const key = [
                s.type,
                Math.round(s.coords.x * 10),
                Math.round(s.coords.y * 10),
                Math.round(s.coords.z * 10),
                s.label,
            ].join('|');
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(s);
        }
        return out;
    }

    _actionFor(type) {
        return {
            shop: 'open_shop',
            garage: 'open_garage',
            vehicle_shop: 'open_vehicle_shop',
            apartment: 'enter_apartment',
            housing: 'enter_property',
            bank: 'open_bank',
            atm: 'open_atm',
            spawn: 'set_spawn',
            door: 'use_door',
        }[type] || 'interact';
    }

    _radiusFor(type) {
        return {
            vehicle_shop: 8.0,
            garage: 6.0,
            apartment: 4.0,
            housing: 4.0,
            bank: 3.0,
            atm: 1.5,
            shop: 3.0,
            door: 1.4,
        }[type] || 2.5;
    }
}
