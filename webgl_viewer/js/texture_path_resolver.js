import { fetchJSON } from './asset_fetcher.js';

/**
 * Centralized model-texture URL resolver.
 *
 * Goals:
 * - One place for naming normalization (hash-only vs hash+slug).
 * - Optional index-based existence gating (avoid spamming guaranteed 404s).
 * - Keep candidate ordering consistent across the app.
 */
export class TexturePathResolver {
  constructor({ textureStreamer = null } = {}) {
    this.textureStreamer = textureStreamer;
    this._modelsTexturesIndex = null; // byHash map
    this._modelsTexturesIndexPromise = null;
    this._modelsTexturesKtx2Index = null; // byHash map (models_textures_ktx2)
    this._modelsTexturesKtx2IndexPromise = null;
    this._assetPacks = null; // [{ id, rootRel, priority }]
    this._assetPacksPromise = null;
    this._warnedMissingHashes = new Set();
    /** @type {Map<string, any>} */
    this._packModelsTexturesIndex = new Map(); // packId -> byHash map
    /** @type {Map<string, Promise<void>>} */
    this._packModelsTexturesIndexPromises = new Map();
    /** @type {Map<string, any>} */
    this._packModelsTexturesKtx2Index = new Map(); // packId -> byHash map (models_textures_ktx2)
    /** @type {Map<string, Promise<void>>} */
    this._packModelsTexturesKtx2IndexPromises = new Map();
    this._kickoffModelsTexturesIndexLoad();
    this._kickoffModelsTexturesKtx2IndexLoad();
    this._kickoffAssetPacksLoad();
  }

  _warnMissingTextureOnce(hash, { rel = null } = {}) {
    try {
      const h = String(hash || '');
      if (!h) return;
      if (this._warnedMissingHashes.has(h)) return;
      this._warnedMissingHashes.add(h);
      const warnEnabled = (globalThis.__WEBGLGTA_TEXTURE_INDEX_WARN_MISSING !== undefined)
        ? !!globalThis.__WEBGLGTA_TEXTURE_INDEX_WARN_MISSING
        : true;
      if (!warnEnabled) return;
      // Default behavior: ENABLE gating (avoid guaranteed 404 spam).
      // You can override at runtime:
      // - window.__WEBGLGTA_TEXTURE_INDEX_GATING = true  => don't fetch missing-by-index textures
      // - window.__WEBGLGTA_TEXTURE_INDEX_GATING = false => still fetch to surface real 404s
      const gate = (globalThis.__WEBGLGTA_TEXTURE_INDEX_GATING !== undefined)
        ? !!globalThis.__WEBGLGTA_TEXTURE_INDEX_GATING
        : true;
      const mode = gate ? 'gated (no fetch)' : 'probe (will fetch to surface 404)';
      console.warn(
        `TexturePathResolver: texture hash missing from exported BASE texture index [${mode}]: ${h} ` +
        `(set window.__WEBGLGTA_TEXTURE_INDEX_WARN_MISSING=false to silence; ` +
        `set window.__WEBGLGTA_TEXTURE_INDEX_GATING=false to probe network/404). ` +
        `NOTE: if asset packs are enabled, the hash may still exist in a DLC pack index.`,
        rel ? { rel } : undefined
      );
    } catch {
      // ignore
    }
  }

  _kickoffModelsTexturesIndexLoad() {
    if (this._modelsTexturesIndex || this._modelsTexturesIndexPromise) return;
    this._modelsTexturesIndexPromise = (async () => {
      try {
        const data = await fetchJSON('assets/models_textures/index.json', { priority: 'low' });
        const byHash = data?.byHash;
        if (byHash && typeof byHash === 'object') this._modelsTexturesIndex = byHash;
        else if (data && typeof data === 'object') this._modelsTexturesIndex = data;
      } catch {
        // Optional file; ignore.
      } finally {
        this._modelsTexturesIndexPromise = null;
      }
    })();
  }

  _kickoffModelsTexturesKtx2IndexLoad() {
    if (this._modelsTexturesKtx2Index || this._modelsTexturesKtx2IndexPromise) return;
    this._modelsTexturesKtx2IndexPromise = (async () => {
      try {
        const data = await fetchJSON('assets/models_textures_ktx2/index.json', { priority: 'low' });
        const byHash = data?.byHash;
        if (byHash && typeof byHash === 'object') this._modelsTexturesKtx2Index = byHash;
        else if (data && typeof data === 'object') this._modelsTexturesKtx2Index = data;
      } catch {
        // Optional file; ignore.
      } finally {
        this._modelsTexturesKtx2IndexPromise = null;
      }
    })();
  }

  _kickoffAssetPacksLoad() {
    if (this._assetPacks || this._assetPacksPromise) return;
    this._assetPacksPromise = (async () => {
      try {
        const data = await fetchJSON('assets/asset_packs.json', { priority: 'low' });
        const packs0 = Array.isArray(data?.packs) ? data.packs : (Array.isArray(data) ? data : null);
        if (!packs0) {
          this._assetPacks = null;
          return;
        }
        const packs = [];
        for (const p of packs0) {
          if (!p || typeof p !== 'object') continue;
          const enabled = (p.enabled === undefined) ? true : !!p.enabled;
          if (!enabled) continue;
          const id = String(p.id || '').trim();
          if (!id) continue;
          let rootRel = String(p.rootRel || p.root || '').trim();
          // rootRel is relative to the assets mount (WITHOUT the leading "assets/").
          // Default: packs/<id>
          if (!rootRel) rootRel = `packs/${id}`;
          rootRel = rootRel.replace(/^\/+/, '').replace(/\/+$/, '');
          const priority = Number(p.priority);
          packs.push({ id, rootRel, priority: Number.isFinite(priority) ? priority : 0 });
        }
        // Higher priority first (DLC overlays before base).
        packs.sort((a, b) => (Number(b.priority) - Number(a.priority)) || String(a.id).localeCompare(String(b.id)));
        this._assetPacks = packs.length ? packs : null;
        // Kick off loading pack indices ASAP to avoid early-frame 404 spam
        // when the renderer begins resolving textures before indices are ready.
        if (this._assetPacks) {
          for (const p of this._assetPacks) {
            this._kickoffPackModelsTexturesIndexLoad(p);
            this._kickoffPackModelsTexturesKtx2IndexLoad(p);
          }
        }
      } catch {
        // Optional file; ignore.
        this._assetPacks = null;
      } finally {
        this._assetPacksPromise = null;
      }
    })();
  }

  _kickoffPackModelsTexturesIndexLoad(pack) {
    const pid = String(pack?.id || '').trim();
    if (!pid) return;
    if (this._packModelsTexturesIndex.has(pid)) return;
    if (this._packModelsTexturesIndexPromises.has(pid)) return;
    const rootRel = String(pack?.rootRel || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (!rootRel) return;
    const url = `assets/${rootRel}/models_textures/index.json`;
    const prom = (async () => {
      try {
        const data = await fetchJSON(url, { priority: 'low' });
        const byHash = data?.byHash;
        if (byHash && typeof byHash === 'object') this._packModelsTexturesIndex.set(pid, byHash);
        else if (data && typeof data === 'object') this._packModelsTexturesIndex.set(pid, data);
      } catch {
        // Optional file; ignore.
      } finally {
        this._packModelsTexturesIndexPromises.delete(pid);
      }
    })();
    this._packModelsTexturesIndexPromises.set(pid, prom);
  }

  _kickoffPackModelsTexturesKtx2IndexLoad(pack) {
    const pid = String(pack?.id || '').trim();
    if (!pid) return;
    if (this._packModelsTexturesKtx2Index.has(pid)) return;
    if (this._packModelsTexturesKtx2IndexPromises.has(pid)) return;
    const rootRel = String(pack?.rootRel || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (!rootRel) return;
    const url = `assets/${rootRel}/models_textures_ktx2/index.json`;
    const prom = (async () => {
      try {
        const data = await fetchJSON(url, { priority: 'low' });
        const byHash = data?.byHash;
        if (byHash && typeof byHash === 'object') this._packModelsTexturesKtx2Index.set(pid, byHash);
        else if (data && typeof data === 'object') this._packModelsTexturesKtx2Index.set(pid, data);
      } catch {
        // Optional file; ignore.
      } finally {
        this._packModelsTexturesKtx2IndexPromises.delete(pid);
      }
    })();
    this._packModelsTexturesKtx2IndexPromises.set(pid, prom);
  }

  /**
   * Resolve an exported asset-relative path into an `assets/...` URL.
   * (Kept here so renderer code doesn’t duplicate the same normalization rules.)
   */
  resolveAssetUrl(rel) {
    const r0 = String(rel || '').trim();
    if (!r0) return null;
    if (/^(https?:|data:|blob:)/i.test(r0)) return r0;

    let r = r0.replace(/^\/+/, '');
    r = r.replace(/^assets\//i, '');
    r = r.replace(/^(model_texture|model_textures|models_texture)\//i, 'models_textures/');
    return `assets/${r}`;
  }

  /**
   * Choose best texture URL for a given exported texture reference.
   *
   * Returns:
   * - `string` url (typically `assets/models_textures/...`)
   * - `null` if we can prove the hash is not present in the exported texture set (index says so)
   */
  chooseTextureUrl(rel) {
    const r0 = String(rel || '').trim();
    if (!r0) return null;

    // Normalize as if it were asset-relative, but keep it relative for candidate generation.
    let r = r0.replace(/^\/+/, '');
    r = r.replace(/^assets\//i, '');
    r = r.replace(/^(model_texture|model_textures|models_texture)\//i, 'models_textures/');

    /** @type {string[]} */
    const candidates = [];

    // Handle model texture naming.
    const m = r.match(/^models_textures\/(\d+)(?:_([^\/]+))?(\.(png|dds|ktx2|jpg|jpeg|webp))$/i);
    if (m) {
      const hash = String(m[1] || '');
      const hasSlugInInput = !!(m[2] && String(m[2]).length > 0);
      const ext = String(m[3] || '.png');
      const hashOnlyRel = `models_textures/${hash}${ext}`;

      // Optional asset packs (base + DLC overlays).
      // If configured, we will prefer the highest-priority pack that contains the texture hash.
      const packs = this._assetPacks;
      let foundInLoadedPackIndex = false;
      if (Array.isArray(packs) && packs.length) {
        for (const pack of packs) {
          this._kickoffPackModelsTexturesIndexLoad(pack);
          const pid = String(pack?.id || '').trim();
          const rootRel = String(pack?.rootRel || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
          const idxPack = (pid && this._packModelsTexturesIndex.has(pid)) ? this._packModelsTexturesIndex.get(pid) : null;
          if (!idxPack || typeof idxPack !== 'object') continue;
          const ent = idxPack[hash];
          if (!ent) continue; // not present in this pack
          foundInLoadedPackIndex = true;

          // Build pack-prefixed candidates.
          const pref = rootRel ? `${rootRel}/` : '';
          if (!hasSlugInInput) {
            const preferredFile = (ent && typeof ent === 'object') ? String(ent.preferredFile || '') : '';
            const hasHashOnly = (ent && typeof ent === 'object' && ent.hashOnly !== undefined) ? !!ent.hashOnly : null;
            if (preferredFile) {
              const preferredRel = `${pref}models_textures/${preferredFile}`;
              const packHashOnlyRel = `${pref}${hashOnlyRel}`;
              if (preferredRel && preferredRel !== packHashOnlyRel) {
                if (hasHashOnly === false) candidates.push(preferredRel);
              }
            }
            candidates.push(`${pref}${hashOnlyRel}`);
            if (preferredFile) {
              const preferredRel = `${pref}models_textures/${preferredFile}`;
              const packHashOnlyRel = `${pref}${hashOnlyRel}`;
              if (preferredRel && preferredRel !== packHashOnlyRel && !candidates.includes(preferredRel)) candidates.push(preferredRel);
            }
          } else {
            // Hash+slug input:
            // - if pack index says hash-only PNG doesn't exist, try preferredFile first (often a DDS fallback)
            // - then try pack hash-only
            // - then try the same slugged filename inside the pack
            // - and if hash-only doesn't exist, also try preferredFile after (dedupe-safe)
            const preferredFile = (ent && typeof ent === 'object') ? String(ent.preferredFile || '') : '';
            const hasHashOnly = (ent && typeof ent === 'object' && ent.hashOnly !== undefined) ? !!ent.hashOnly : null;
            if (preferredFile && hasHashOnly === false) {
              const preferredRel = `${pref}models_textures/${preferredFile}`;
              if (preferredRel) candidates.push(preferredRel);
            }
            candidates.push(`${pref}${hashOnlyRel}`);
            candidates.push(`${pref}${r}`);
            if (preferredFile && hasHashOnly === false) {
              const preferredRel = `${pref}models_textures/${preferredFile}`;
              if (preferredRel && !candidates.includes(preferredRel)) candidates.push(preferredRel);
            }
          }
          // Only consider the first matching pack (highest priority).
          break;
        }
      }

      // Base/pack index gating:
      // Default behavior: gate missing-by-index textures (avoid guaranteed 404 spam).
      // Override by setting:
      //   window.__WEBGLGTA_TEXTURE_INDEX_GATING = false  // probe network anyway (debugging exports)
      const idx = this._modelsTexturesIndex;
      const gate = (globalThis.__WEBGLGTA_TEXTURE_INDEX_GATING !== undefined)
        ? !!globalThis.__WEBGLGTA_TEXTURE_INDEX_GATING
        : true;
      if (idx && typeof idx === 'object' && idx[hash] === undefined) {
        // If packs are enabled, defer warning until we can actually conclude the hash is absent
        // from all loaded indices. This avoids confusing "missing" warnings for textures that
        // live in DLC packs (base index won't contain them by design), and avoids early-frame
        // warnings while pack indices are still loading.
        const packsConfigured = Array.isArray(packs) && packs.length;
        if (!packsConfigured) {
          this._warnMissingTextureOnce(hash, { rel: r });
        } else if (!foundInLoadedPackIndex) {
          let anyPackIndexLoading = false;
          let anyPackIndexHasIt = false;
          for (const pack of packs) {
            const pid = String(pack?.id || '').trim();
            if (!pid) continue;
            if (this._packModelsTexturesIndex.has(pid)) {
              const idxPack = this._packModelsTexturesIndex.get(pid);
              if (idxPack && typeof idxPack === 'object' && idxPack[hash] !== undefined) {
                anyPackIndexHasIt = true;
                break;
              }
              continue;
            }
            if (this._packModelsTexturesIndexPromises.has(pid)) {
              anyPackIndexLoading = true;
            }
          }
          // Only warn when we are not still loading pack indices and none of the loaded pack
          // indices report the hash as present.
          if (!anyPackIndexLoading && !anyPackIndexHasIt) {
            this._warnMissingTextureOnce(hash, { rel: r });
          }
        }
        if (gate) {
          if (Array.isArray(packs) && packs.length) {
            let anyPackIndexHasIt = false;
            for (const pack of packs) {
              const pid = String(pack?.id || '').trim();
              if (!pid) continue;
              if (!this._packModelsTexturesIndex.has(pid)) continue; // not loaded yet
              const idxPack = this._packModelsTexturesIndex.get(pid);
              if (idxPack && typeof idxPack === 'object' && idxPack[hash] !== undefined) {
                anyPackIndexHasIt = true;
                break;
              }
            }
            if (!anyPackIndexHasIt) return null;
          } else {
            return null;
          }
        }
      }

      if (!hasSlugInInput) {
        const ent = (idx && typeof idx === 'object') ? idx[hash] : null;
        const preferredFile = (ent && typeof ent === 'object') ? String(ent.preferredFile || '') : '';
        const hasHashOnly = (ent && typeof ent === 'object' && ent.hashOnly !== undefined) ? !!ent.hashOnly : null;

        // If we know hash-only does not exist, prefer the slug variant directly.
        if (preferredFile) {
          const preferredRel = `models_textures/${preferredFile}`;
          if (preferredRel && preferredRel !== hashOnlyRel) {
            if (hasHashOnly === false) candidates.push(preferredRel);
          }
        }

        candidates.push(hashOnlyRel);
        // Fallback: if preferred exists but hashOnly is unknown/true, try it after hashOnly.
        if (preferredFile) {
          const preferredRel = `models_textures/${preferredFile}`;
          if (preferredRel && preferredRel !== hashOnlyRel && !candidates.includes(preferredRel)) candidates.push(preferredRel);
        }
      } else {
        // Hash+slug input: try hash-only first, then input.
        const ent = (idx && typeof idx === 'object') ? idx[hash] : null;
        const preferredFile = (ent && typeof ent === 'object') ? String(ent.preferredFile || '') : '';
        const hasHashOnly = (ent && typeof ent === 'object' && ent.hashOnly !== undefined) ? !!ent.hashOnly : null;
        // If we know hash-only PNG doesn't exist, prefer the index's preferred file first (often DDS fallback).
        if (preferredFile && hasHashOnly === false) {
          candidates.push(`models_textures/${preferredFile}`);
        }
        candidates.push(hashOnlyRel);
      }
    }

    // Handle KTX2 model textures (pack-aware): models_textures_ktx2/<hash>.ktx2
    const mk = r.match(/^models_textures_ktx2\/(\d+)(?:_([^\/]+))?(\.(ktx2))$/i);
    if (mk) {
      const hash = String(mk[1] || '');
      const hasSlugInInput = !!(mk[2] && String(mk[2]).length > 0);
      const ext = String(mk[3] || '.ktx2');
      const hashOnlyRel = `models_textures_ktx2/${hash}${ext}`;

      const packs = this._assetPacks;
      let foundInLoadedPackIndex = false;
      if (Array.isArray(packs) && packs.length) {
        for (const pack of packs) {
          this._kickoffPackModelsTexturesKtx2IndexLoad(pack);
          const pid = String(pack?.id || '').trim();
          const rootRel = String(pack?.rootRel || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
          const idxPack = (pid && this._packModelsTexturesKtx2Index.has(pid)) ? this._packModelsTexturesKtx2Index.get(pid) : null;
          if (!idxPack || typeof idxPack !== 'object') continue;
          const ent = idxPack[hash];
          if (!ent) continue; // not present in this pack
          foundInLoadedPackIndex = true;

          const pref = rootRel ? `${rootRel}/` : '';
          const preferredFile = (ent && typeof ent === 'object') ? String(ent.preferredFile || '') : '';
          const hasHashOnly = (ent && typeof ent === 'object' && ent.hashOnly !== undefined) ? !!ent.hashOnly : null;

          if (!hasSlugInInput) {
            if (preferredFile) {
              const preferredRel = `${pref}models_textures_ktx2/${preferredFile}`;
              const packHashOnlyRel = `${pref}${hashOnlyRel}`;
              if (preferredRel && preferredRel !== packHashOnlyRel) {
                if (hasHashOnly === false) candidates.push(preferredRel);
              }
            }
            candidates.push(`${pref}${hashOnlyRel}`);
            if (preferredFile) {
              const preferredRel = `${pref}models_textures_ktx2/${preferredFile}`;
              const packHashOnlyRel = `${pref}${hashOnlyRel}`;
              if (preferredRel && preferredRel !== packHashOnlyRel && !candidates.includes(preferredRel)) candidates.push(preferredRel);
            }
          } else {
            // Hash+slug input: prefer hash-only, then input.
            if (preferredFile && hasHashOnly === false) {
              candidates.push(`${pref}models_textures_ktx2/${preferredFile}`);
            }
            candidates.push(`${pref}${hashOnlyRel}`);
            candidates.push(`${pref}${r}`);
          }
          break; // highest priority pack only
        }
      }

      const idx = this._modelsTexturesKtx2Index;
      const gate = (globalThis.__WEBGLGTA_TEXTURE_INDEX_GATING !== undefined)
        ? !!globalThis.__WEBGLGTA_TEXTURE_INDEX_GATING
        : true;
      if (idx && typeof idx === 'object' && idx[hash] === undefined) {
        const packsConfigured = Array.isArray(packs) && packs.length;
        if (!packsConfigured) {
          this._warnMissingTextureOnce(hash, { rel: r });
        } else if (!foundInLoadedPackIndex) {
          let anyPackIndexLoading = false;
          let anyPackIndexHasIt = false;
          for (const pack of packs) {
            const pid = String(pack?.id || '').trim();
            if (!pid) continue;
            if (this._packModelsTexturesKtx2Index.has(pid)) {
              const idxPack = this._packModelsTexturesKtx2Index.get(pid);
              if (idxPack && typeof idxPack === 'object' && idxPack[hash] !== undefined) {
                anyPackIndexHasIt = true;
                break;
              }
              continue;
            }
            if (this._packModelsTexturesKtx2IndexPromises.has(pid)) {
              anyPackIndexLoading = true;
            }
          }
          if (!anyPackIndexLoading && !anyPackIndexHasIt) {
            this._warnMissingTextureOnce(hash, { rel: r });
          }
        }
        if (gate) {
          if (Array.isArray(packs) && packs.length) {
            let anyPackIndexHasIt = false;
            for (const pack of packs) {
              const pid = String(pack?.id || '').trim();
              if (!pid) continue;
              if (!this._packModelsTexturesKtx2Index.has(pid)) continue; // not loaded yet
              const idxPack = this._packModelsTexturesKtx2Index.get(pid);
              if (idxPack && typeof idxPack === 'object' && idxPack[hash] !== undefined) {
                anyPackIndexHasIt = true;
                break;
              }
            }
            if (!anyPackIndexHasIt) return null;
          } else {
            return null;
          }
        }
      }

      if (!hasSlugInInput) {
        const ent = (idx && typeof idx === 'object') ? idx[hash] : null;
        const preferredFile = (ent && typeof ent === 'object') ? String(ent.preferredFile || '') : '';
        const hasHashOnly = (ent && typeof ent === 'object' && ent.hashOnly !== undefined) ? !!ent.hashOnly : null;
        if (preferredFile) {
          const preferredRel = `models_textures_ktx2/${preferredFile}`;
          if (preferredRel && preferredRel !== hashOnlyRel) {
            if (hasHashOnly === false) candidates.push(preferredRel);
          }
        }
        candidates.push(hashOnlyRel);
        if (preferredFile) {
          const preferredRel = `models_textures_ktx2/${preferredFile}`;
          if (preferredRel && preferredRel !== hashOnlyRel && !candidates.includes(preferredRel)) candidates.push(preferredRel);
        }
      } else {
        const ent = (idx && typeof idx === 'object') ? idx[hash] : null;
        const preferredFile = (ent && typeof ent === 'object') ? String(ent.preferredFile || '') : '';
        const hasHashOnly = (ent && typeof ent === 'object' && ent.hashOnly !== undefined) ? !!ent.hashOnly : null;
        if (preferredFile && hasHashOnly === false) {
          candidates.push(`models_textures_ktx2/${preferredFile}`);
        }
        candidates.push(hashOnlyRel);
      }
    }

    candidates.push(r);

    // De-dupe while preserving order.
    const uniq = [];
    const seen = new Set();
    for (const c of candidates) {
      const key = String(c || '');
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(key);
    }

    const ts = this.textureStreamer || null;
    for (const c of uniq) {
      const url = this.resolveAssetUrl(c);
      if (!url) continue;
      if (ts && ts.isMissing?.(url)) continue;
      return url;
    }
    return this.resolveAssetUrl(uniq[0] || r);
  }
}


