import { fetchJSON } from './asset_fetcher.js';

// Bump after offline texture exports are repaired. Texture bytes are cacheable
// independently from their index, so this prevents a browser from pairing a
// fresh index with an older PNG stored under the same URL.
const MODEL_TEXTURE_ASSET_REVISION = 'v10';

// Visual substitutes for known exported ground-material gaps. These keep /demo
// from falling back to untextured shader color on roads/sidewalks while the
// exact source textures are absent from the local export.
const MODEL_TEXTURE_REL_ALIASES = Object.freeze({
  'models_textures/2929879111_im_road_damage_03.png': 'models_textures/214235649_im_road_damage_03_lod.png',
  'models_textures/3601109728_im_sidewalk009.png': 'models_textures/3905304355_im_sidewalk008.png',
  // The downtown `im_sidewalk020` color raster is absent from the installed
  // GTA dictionaries. Use the nearest exported colored sidewalk LOD instead
  // of falling back to flat material color or its grayscale specular map.
  'models_textures/1900857890_im_sidewalk020.png': 'models_textures/1243748460_im_sidewalk019_lod.png',
  'models_textures/524380690_im_road_damage_001im_road_damage_001_a.png': 'models_textures/2812727009_im_road_damage_001_lodim_road_damage_001_a_lod.png',
  'models_textures/552092152_freeway_ubderbelly_new_01_lod.png': 'models_textures/3550326802_im_freeway_barrier001_lod.png',
  'models_textures/566413555_nxg_rbm_kerb1.png': 'models_textures/1076115283_im_kerbs03.png',
  // `prop_bin_05a` is a model-local alias, not a standalone texture in GTA's
  // YTDs. Its owning `prop_bin_05.ytd` exposes the base `prop_bin_05` raster.
  'models_textures/1329570871_prop_bin_05a.png': 'models_textures/2927588251_prop_bin_05.png',
});

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
    this._modelsTexturesSlugFallback = null; // slug -> best existing base texture file
    this._modelsTexturesSlugFallbackSource = null;
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

  _isSlugFallbackEnabled() {
    try {
      return !!globalThis.__WEBGLGTA_TEXTURE_SLUG_FALLBACK;
    } catch {
      return false;
    }
  }

  _buildModelsTexturesSlugFallbackIndex(idx) {
    const out = new Map();
    if (!idx || typeof idx !== 'object') return out;

    const extRank = (file) => {
      const f = String(file || '').toLowerCase();
      if (f.endsWith('.png')) return 0;
      if (f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.webp')) return 1;
      if (f.endsWith('.dds')) return 2;
      return 10;
    };
    const add = (slug, file, scoreBase = 0) => {
      const s = String(slug || '').trim().toLowerCase();
      const f = String(file || '').trim();
      if (!s || !f) return;
      const score = scoreBase + extRank(f);
      const prev = out.get(s);
      if (!prev || score < prev.score || (score === prev.score && f.localeCompare(prev.file) < 0)) {
        out.set(s, { file: f, score });
      }
    };

    for (const ent of Object.values(idx)) {
      const files = Array.isArray(ent?.files) ? ent.files : [];
      for (const rawFile of files) {
        const file = String(rawFile || '').trim();
        const m = file.match(/^\d+_([^/]+)\.(png|dds|jpg|jpeg|webp)$/i);
        if (!m) continue;
        const slug = String(m[1] || '').toLowerCase();
        add(slug, file, 0);
        // Many exported road/intersection materials only have *_lod texture exports.
        // Use those as explicit last-resort diffuse substitutes, but do not strip
        // normal/spec suffixes into diffuse candidates.
        if (slug.endsWith('_lod') && !slug.endsWith('_n_lod') && !slug.endsWith('_s_lod')) {
          add(slug.slice(0, -4), file, 20);
        }
      }
    }
    return out;
  }

  _getModelsTexturesSlugFallbackIndex() {
    const idx = this._modelsTexturesIndex;
    if (!idx || typeof idx !== 'object') return null;
    if (this._modelsTexturesSlugFallback && this._modelsTexturesSlugFallbackSource === idx) {
      return this._modelsTexturesSlugFallback;
    }
    this._modelsTexturesSlugFallback = this._buildModelsTexturesSlugFallbackIndex(idx);
    this._modelsTexturesSlugFallbackSource = idx;
    return this._modelsTexturesSlugFallback;
  }

  _chooseSlugFallbackRel(hash, slug, ext) {
    if (!this._isSlugFallbackEnabled()) return null;
    if (String(ext || '').toLowerCase() === '.ktx2') return null;
    const h = String(hash || '').trim();
    const s = String(slug || '').trim().toLowerCase();
    if (!h || !s) return null;
    const idx = this._getModelsTexturesSlugFallbackIndex();
    const ent = idx?.get?.(s) || null;
    const file = String(ent?.file || '').trim();
    if (!file) return null;
    // Never map a missing hash back to itself; normal hash resolution handles that path.
    if (file.toLowerCase().startsWith(`${h.toLowerCase()}_`) || file.toLowerCase() === `${h.toLowerCase()}.png`) {
      return null;
    }
    return `models_textures/${file}`;
  }

  _chooseExplicitAliasRel(rel, idx) {
    const r = String(rel || '')
      .trim()
      .replace(/^\/+/, '')
      .replace(/^assets\//i, '')
      .replace(/^(model_texture|model_textures|models_texture)\//i, 'models_textures/')
      .toLowerCase();
    const alias = MODEL_TEXTURE_REL_ALIASES[r] || null;
    if (!alias) return null;

    if (idx && typeof idx === 'object') {
      const m = String(alias).match(/^models_textures\/(\d+)(?:_[^/]+)?\.(png|dds|jpg|jpeg|webp)$/i);
      const hash = m ? String(m[1] || '') : '';
      const file = String(alias.split('/').pop() || '');
      const ent = hash ? idx[hash] : null;
      if (!ent) return null;
      if (!this._indexEntryHasFile(ent, file)) return null;
    }
    return alias;
  }

  _indexEntryHasFile(ent, file) {
    const f = String(file || '').trim().toLowerCase();
    if (!f || !ent || typeof ent !== 'object') return false;
    const files = Array.isArray(ent.files) ? ent.files : [];
    for (const raw of files) {
      if (String(raw || '').trim().toLowerCase() === f) return true;
    }
    return false;
  }

  _warnMissingTextureOnce(hash, { rel = null } = {}) {
    try {
      const h = String(hash || '');
      if (!h) return;
      if (this._warnedMissingHashes.has(h)) return;
      this._warnedMissingHashes.add(h);
      const warnEnabled = (globalThis.__WEBGLGTA_TEXTURE_INDEX_WARN_MISSING !== undefined)
        ? !!globalThis.__WEBGLGTA_TEXTURE_INDEX_WARN_MISSING
        // The index already gates these paths before a request is made. Emitting
        // one warning per missing hash can flood DevTools during district load
        // and make profiling/streaming look worse than the actual renderer.
        // Asset-export investigations can opt back in through the documented
        // global below.
        : false;
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
        // This index is regenerated whenever texture exports are repaired. Do not
        // read it from Cache Storage: a stale index would gate newly-written PNGs
        // before the streamer ever gets a chance to request them.
        const data = await fetchJSON('assets/models_textures/index.json', { usePersistentCache: false, priority: 'low' });
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
        const data = await fetchJSON('assets/models_textures_ktx2/index.json', { usePersistentCache: false, priority: 'low' });
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
        const data = await fetchJSON(url, { usePersistentCache: false, priority: 'low' });
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
        const data = await fetchJSON(url, { usePersistentCache: false, priority: 'low' });
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
    const url = `assets/${r}`;
    // Model textures are generated offline and can be replaced in place. Give
    // them an explicit content revision so native HTTP caches cannot keep the
    // old raster after the texture index itself has refreshed.
    if (/(?:^|\/)models_textures(?:_ktx2)?\//i.test(r)) {
      return `${url}?rev=${MODEL_TEXTURE_ASSET_REVISION}`;
    }
    return url;
  }

  /**
   * Choose best texture URL for a given exported texture reference.
   *
   * Returns:
   * - `string` url (typically `assets/models_textures/...`)
   * - `null` if we can prove the hash is not present in the exported texture set (index says so)
   */
  chooseTextureUrl(rel, { allowIndexMiss = false } = {}) {
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
      const idx = this._modelsTexturesIndex;
      const gate = (globalThis.__WEBGLGTA_TEXTURE_INDEX_GATING !== undefined)
        ? !!globalThis.__WEBGLGTA_TEXTURE_INDEX_GATING
        : true;

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
            // - if the pack index contains the exact slugged filename, trust that first
            // - if pack index says hash-only PNG doesn't exist, try preferredFile (often a DDS fallback)
            // - then try pack hash-only
            // - then try the same slugged filename inside the pack as a final probe
            const preferredFile = (ent && typeof ent === 'object') ? String(ent.preferredFile || '') : '';
            const hasHashOnly = (ent && typeof ent === 'object' && ent.hashOnly !== undefined) ? !!ent.hashOnly : null;
            const exactFile = String(r.split('/').pop() || '');
            const exactRel = `${pref}${r}`;
            const hasExactFile = this._indexEntryHasFile(ent, exactFile);
            if (hasExactFile) candidates.push(exactRel);
            if (preferredFile && hasHashOnly === false) {
              const preferredRel = `${pref}models_textures/${preferredFile}`;
              if (preferredRel) candidates.push(preferredRel);
            }
            candidates.push(`${pref}${hashOnlyRel}`);
            if (!hasExactFile) candidates.push(exactRel);
          }
          // Only consider the first matching pack (highest priority).
          break;
        }
      }

      // Base/pack index gating:
      // Default behavior: gate missing-by-index textures (avoid guaranteed 404 spam).
      // Override by setting:
      //   window.__WEBGLGTA_TEXTURE_INDEX_GATING = false  // probe network anyway (debugging exports)
      if (!allowIndexMiss && gate && (!idx || typeof idx !== 'object') && this._modelsTexturesIndexPromise) {
        return null;
      }
      if (!allowIndexMiss && idx && typeof idx === 'object' && idx[hash] === undefined) {
        const aliasFallbackRel = !foundInLoadedPackIndex ? this._chooseExplicitAliasRel(r, idx) : null;
        const slugFallbackRel = (!aliasFallbackRel && !foundInLoadedPackIndex) ? this._chooseSlugFallbackRel(hash, m[2], ext) : null;
        if (aliasFallbackRel) candidates.push(aliasFallbackRel);
        if (slugFallbackRel) candidates.push(slugFallbackRel);
        // If packs are enabled, defer warning until we can actually conclude the hash is absent
        // from all loaded indices. This avoids confusing "missing" warnings for textures that
        // live in DLC packs (base index won't contain them by design), and avoids early-frame
        // warnings while pack indices are still loading.
        const packsConfigured = Array.isArray(packs) && packs.length;
        if (aliasFallbackRel || slugFallbackRel) {
          // /demo can opt into same-slug LOD substitutes. They are visible fallbacks, not export gaps.
        } else if (!packsConfigured) {
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
          if (aliasFallbackRel || slugFallbackRel) {
            // Keep the fallback candidate and avoid probing known-missing exact names.
          } else if (Array.isArray(packs) && packs.length) {
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
        // Hash+slug input: exact indexed filename first, then hash-only, then input probe.
        const ent = (idx && typeof idx === 'object') ? idx[hash] : null;
        const preferredFile = (ent && typeof ent === 'object') ? String(ent.preferredFile || '') : '';
        const hasHashOnly = (ent && typeof ent === 'object' && ent.hashOnly !== undefined) ? !!ent.hashOnly : null;
        const exactFile = String(r.split('/').pop() || '');
        const hasExactFile = this._indexEntryHasFile(ent, exactFile);
        if (hasExactFile) candidates.push(r);
        // If we know hash-only PNG doesn't exist, prefer the index's preferred file first (often DDS fallback).
        if (preferredFile && hasHashOnly === false) {
          candidates.push(`models_textures/${preferredFile}`);
        }
        candidates.push(hashOnlyRel);
        if (!hasExactFile) candidates.push(r);
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
            // Hash+slug input: exact indexed filename first, then hash-only, then input probe.
            const exactFile = String(r.split('/').pop() || '');
            const exactRel = `${pref}${r}`;
            const hasExactFile = this._indexEntryHasFile(ent, exactFile);
            if (hasExactFile) candidates.push(exactRel);
            if (preferredFile && hasHashOnly === false) {
              candidates.push(`${pref}models_textures_ktx2/${preferredFile}`);
            }
            candidates.push(`${pref}${hashOnlyRel}`);
            if (!hasExactFile) candidates.push(exactRel);
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
        const exactFile = String(r.split('/').pop() || '');
        const hasExactFile = this._indexEntryHasFile(ent, exactFile);
        if (hasExactFile) candidates.push(r);
        if (preferredFile && hasHashOnly === false) {
          candidates.push(`models_textures_ktx2/${preferredFile}`);
        }
        candidates.push(hashOnlyRel);
        if (!hasExactFile) candidates.push(r);
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


