import { fetchArrayBufferPreferredCompressed, fetchJSONPreferredCompressed } from '../asset_fetcher.js';
import { decodeFloat16PaletteClip } from '../skinning_animation_codec.js';

const MAX_RESIDENT_EMOTES = 6;

function normalizeCommand(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export class EmotePaletteController {
    constructor(app) {
        this.app = app;
        this.manifest = null;
        this._manifestPromise = null;
        this._resident = new Map();
        this.activeCommand = '';
    }

    get active() {
        return !!this.activeCommand;
    }

    async loadManifest() {
        if (this.manifest) return this.manifest;
        if (this._manifestPromise) return this._manifestPromise;
        this._manifestPromise = (async () => {
            const manifest = await fetchJSONPreferredCompressed('assets/emotes/rpemotes_manifest.json', {
                // Palette files were regenerated in place. Avoid Cache Storage
                // returning an older matrix payload from the same URL, which
                // deforms a ped even though the current manifest is valid.
                usePersistentCache: false,
                useMemoryCache: false,
                priority: 'high',
            });
            const emotes = manifest?.emotes;
            if (!emotes || typeof emotes !== 'object') throw new Error('Emote manifest has no entries');
            this.manifest = {
                ...manifest,
                boneCount: Number(manifest.boneCount) || 0,
                emotes,
            };
            return this.manifest;
        })();
        try {
            return await this._manifestPromise;
        } finally {
            this._manifestPromise = null;
        }
    }

    async list() {
        const manifest = await this.loadManifest();
        return Object.values(manifest.emotes)
            .filter((entry) => entry && entry.command && entry.file)
            .sort((a, b) => String(a.label || a.command).localeCompare(String(b.label || b.command)));
    }

    async play(command) {
        const key = normalizeCommand(command);
        if (!key) return { ok: false, message: 'Choose an emote' };
        if (!this.app?.player?.enabled) return { ok: false, message: 'Spawn a character before using emotes' };
        const manifest = await this.loadManifest();
        const entry = manifest.emotes[key];
        if (!entry) return { ok: false, message: 'Unknown emote: ' + key };
        const rendererReady = await this.app?._ensurePlayerModelRenderer?.();
        if (!rendererReady || !this.app?.playerModelRenderer?.ready) return { ok: false, message: 'Player renderer is not ready' };

        try { this.app.weaponController?.holsterImmediate?.(); } catch { /* ignore */ }
        try { this.app.meleeController?.clearInput?.(); } catch { /* ignore */ }
        const clip = await this._loadClip(entry, manifest.boneCount);
        this.app.playerModelRenderer.mergeSkinningAnimationSet?.({
            schema: 'webglgta-compressed-ycd-palettes-v1',
            boneCount: clip.boneCount,
            clips: { [clip.name]: clip },
        });
        this._resident.delete(clip.name);
        this._resident.set(clip.name, clip);
        this.activeCommand = clip.name;
        this.app.player.emote = { active: true, clip: clip.name };
        this.app.player.animPhase = 0.0;
        this._trimResident();
        return { ok: true, entry, message: 'Playing ' + (entry.label || entry.command) };
    }

    stop(reason = '') {
        if (!this.activeCommand) return false;
        this.activeCommand = '';
        if (this.app?.player) this.app.player.emote = null;
        if (reason === 'movement') this.app?.chatMenu?.addMessage?.({ system: true, text: 'Emote cancelled by movement' });
        return true;
    }

    update(dt, moving = false) {
        if (!this.active) return false;
        if (moving) return this.stop('movement');
        if (this.app?.weaponController?.isVisible?.() || this.app?.meleeController?.getStatus?.()?.attacking) return this.stop('combat');
        if (this.app?.player) this.app.player.animPhase = (Number(this.app.player.animPhase) || 0.0) + Math.max(0.0, Number(dt) || 0.0);
        return true;
    }

    getActiveGesture() {
        if (!this.active || !this.app?.player?.emote?.active) return null;
        return { active: true, clip: this.activeCommand };
    }

    async _loadClip(entry, expectedBoneCount) {
        const key = normalizeCommand(entry.command);
        const cached = this._resident.get(key);
        if (cached) return cached;
        const file = String(entry.file || '').replace(/^\/+/, '');
        if (!file || file.includes('..')) throw new Error('Invalid emote palette path');
        const buffer = await fetchArrayBufferPreferredCompressed('assets/emotes/' + file, {
            usePersistentCache: false,
            priority: 'high',
        });
        const clip = decodeFloat16PaletteClip(buffer, entry);
        if (expectedBoneCount > 0 && clip.boneCount !== expectedBoneCount) throw new Error('Palette bone count does not match the emote skeleton');
        return clip;
    }

    _trimResident() {
        while (this._resident.size > MAX_RESIDENT_EMOTES) {
            const stale = this._resident.keys().next().value;
            if (!stale || stale === this.activeCommand) break;
            this._resident.delete(stale);
            this.app?.playerModelRenderer?.removeSkinningAnimationClips?.([stale]);
        }
    }
}
