import { GarmentPreviewRenderer } from './clothing_preview_renderer.js';

const COMPONENT_DISPLAY_NAMES = Object.freeze({
    berd: 'Masks',
    uppr: 'Arms / Torso',
    accs: 'Undershirt / Accessories',
    jbib: 'Upper Body / Tops',
});
const componentDisplayName = (component) => COMPONENT_DISPLAY_NAMES[String(component || '').toLowerCase()]
    || String(component || '').toUpperCase();

const state = { items: [], filtered: [], selected: new Map(), converted: new Map(), queuedTextures: new Set(), pendingPreview: null, activeItem: null, activeTexture: 0, activePreviewId: '', sex: '', component: '', search: '' };
const byId = (id) => document.getElementById(id);
const isConverted = (item, texture = item.textures[0]?.index ?? 0) => state.converted.get(item.id)?.textures?.includes(texture) === true;

async function refreshConverted() {
    const response = await fetch(`/assets/custom_clothing/clothingpack5m.json?live=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return false;
    const converted = await response.json();
    const previousSize = state.converted.size;
    state.converted.clear();
    for (const components of Object.values(converted.models || {})) {
        for (const variants of Object.values(components || {})) {
            for (const variant of variants || []) state.converted.set(variant.itemId, variant);
        }
    }
    for (const key of state.queuedTextures) {
        const separator = key.lastIndexOf(':');
        const itemId = key.slice(0, separator);
        const texture = Number(key.slice(separator + 1));
        const item = state.items.find((entry) => entry.id === itemId);
        if (item && isConverted(item, texture)) state.queuedTextures.delete(key);
    }
    if (state.converted.size !== previousSize) render();
    return true;
}

function selectedPayload() {
    return {
        schema: 'webglgta-clothingpack5m-selection-v1',
        exportedAt: new Date().toISOString(),
        collection: 'clothingpack5m',
        items: Array.from(state.selected.values()).map(({ item, texture }) => ({
            id: item.id, sex: item.sex, collection: item.collection, component: item.component,
            componentId: item.componentId, isProp: item.isProp, drawable: item.drawable,
            texture, drawablePath: item.drawablePath,
            texturePath: item.textures.find((entry) => entry.index === texture)?.path || null,
        })),
    };
}

function itemPayload(item, textures = [item.textures[0]?.index ?? 0]) {
    return {
        schema: 'webglgta-clothingpack5m-selection-v1',
        exportedAt: new Date().toISOString(),
        collection: 'clothingpack5m',
        items: textures.map((texture) => ({
            id: item.id, sex: item.sex, collection: item.collection, component: item.component,
            componentId: item.componentId, isProp: item.isProp, drawable: item.drawable,
            texture, drawablePath: item.drawablePath,
            texturePath: item.textures.find((entry) => entry.index === texture)?.path || item.textures[0]?.path || null,
        })),
    };
}

async function queueMissingTextures(item, selectedTexture, announce = false) {
    const missing = item.textures
        .map((entry) => entry.index)
        .filter((texture) => !isConverted(item, texture) && !state.queuedTextures.has(`${item.id}:${texture}`));
    if (!missing.length) return;
    if (selectedTexture !== undefined && missing.includes(selectedTexture)) {
        missing.splice(missing.indexOf(selectedTexture), 1);
        missing.unshift(selectedTexture);
    }
    for (const texture of missing) state.queuedTextures.add(`${item.id}:${texture}`);
    const status = byId('queueStatus');
    if (announce) status.textContent = `Preparing ${item.label} textures for 3D preview`;
    try {
        const response = await fetch('/__clothing_selection', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(itemPayload(item, missing)),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || `Request failed (${response.status})`);
        if (announce) status.textContent = `Converting ${item.label} textures; the selected texture will appear automatically`;
    } catch (error) {
        for (const texture of missing) state.queuedTextures.delete(`${item.id}:${texture}`);
        if (announce) status.textContent = error.message;
    }
}

async function requestAutomaticPreview(item, texture = item.textures[0]?.index ?? 0) {
    state.pendingPreview = { item, texture };
    const status = byId('queueStatus');
    if (!isConverted(item, texture)) {
        state.previewRenderer?.clear();
        byId('livePreview').classList.remove('ready');
        status.textContent = `Converting ${item.label} texture ${texture}; it will appear automatically`;
        await queueMissingTextures(item, texture, true);
        return;
    }
    void showAutomaticPreview(item, texture);
    void queueMissingTextures(item, undefined, false);
}

async function showAutomaticPreview(item, texture = state.converted.get(item.id)?.textures?.[0] ?? 0) {
    const previewKey = `${item.id}:${texture}`;
    if (state.activePreviewId === previewKey) return;
    state.activePreviewId = previewKey;
    state.pendingPreview = null;
    localStorage.setItem('webglgta.clothingpack5m.preview.v1', JSON.stringify({ id: item.id, sex: item.sex, componentId: item.componentId, texture }));
    const preview = byId('livePreview');
    try {
        state.previewRenderer ||= new GarmentPreviewRenderer(byId('garmentPreviewCanvas'));
        const variant = state.converted.get(item.id);
        const textureHash = variant.textureAssets?.[String(texture)] || variant.hash;
        const loaded = await state.previewRenderer.showVariant({ ...variant, hash: textureHash });
        if (!loaded || state.activePreviewId !== previewKey) return;
        preview.classList.add('ready');
        byId('queueStatus').textContent = `${item.label} loaded in 3D`;
    } catch (error) {
        state.activePreviewId = '';
        byId('queueStatus').textContent = `Preview failed: ${error.message}`;
    }
}

function save() {
    localStorage.setItem('webglgta.clothingpack5m.review.v2', JSON.stringify(selectedPayload()));
}

function renderSelection() {
    const target = byId('selectedList');
    target.replaceChildren();
    byId('addedHeading').textContent = `Added to demo (${state.selected.size.toLocaleString()})`;
    if (!state.selected.size) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'Added garments will appear here and leave the review queue.';
        target.append(empty);
        return;
    }
    for (const selected of state.selected.values()) {
        const row = document.createElement('div');
        row.className = 'selected-row';
        const info = document.createElement('div');
        info.className = 'selected-row-info';
        const title = document.createElement('strong');
        title.textContent = `${selected.item.label} / ${selected.item.sex}`;
        const detail = document.createElement('span');
        detail.textContent = selected.item.collection;
        const texture = document.createElement('span');
        texture.textContent = `Texture ${selected.texture}`;
        info.append(title, detail, texture);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.title = 'Return garment to review queue';
        remove.addEventListener('click', () => {
            state.selected.delete(selected.item.id);
            save();
            render();
            renderSelection();
            if (!state.activeItem) setActiveItem(selected.item, selected.texture);
        });
        row.append(info, remove);
        target.append(row);
    }
}

function renderCurrentReview() {
    const item = state.activeItem;
    byId('reviewTitle').textContent = item?.label || 'Review garment';
    byId('reviewDetail').textContent = item ? `${item.sex} / ${item.collection}` : 'No garments in this view';
    const select = byId('reviewTexture');
    select.replaceChildren();
    select.hidden = !item || !item.textures.length;
    for (const texture of item?.textures || []) {
        const option = document.createElement('option');
        option.value = String(texture.index);
        option.textContent = `Texture ${texture.index} (${texture.token})`;
        option.selected = texture.index === state.activeTexture;
        select.append(option);
    }
    byId('addGarment').disabled = !item;
    byId('skipGarment').disabled = !item;
}

function setActiveItem(item, texture = item?.textures[0]?.index ?? 0) {
    if (!item) {
        state.activeItem = null;
        renderCurrentReview();
        render();
        return;
    }
    state.activeItem = item;
    state.activeTexture = texture;
    state.activePreviewId = '';
    renderCurrentReview();
    render();
    void requestAutomaticPreview(item, texture);
}

function advanceCurrent() {
    const index = state.filtered.findIndex((item) => item === state.activeItem);
    const next = state.filtered[index >= 0 ? index + 1 : 0] || null;
    if (next) setActiveItem(next);
    else {
        setActiveItem(null);
        byId('queueStatus').textContent = 'End of current results';
    }
}

function keepActiveInFilter() {
    if (!state.filtered.some((item) => item === state.activeItem)) setActiveItem(state.filtered[0] || null);
}

function itemCard(item) {
    const button = document.createElement('button');
    button.className = `item${state.activeItem === item ? ' current' : ''}${state.selected.has(item.id) ? ' added' : ''}`;
    const preview = document.createElement('div');
    preview.className = 'preview';
    const sex = document.createElement('span'); sex.className = 'sex'; sex.textContent = item.sex;
    const converted = state.converted.has(item.id);
    const status = document.createElement('span'); status.className = 'status'; status.title = converted ? '3D garment preview ready' : 'Requires WebGL conversion';
    if (converted) status.style.background = '#58c879';
    const garment = document.createElement('span'); garment.className = 'garment'; garment.textContent = componentDisplayName(item.component);
    preview.append(sex, status, garment);
    const meta = document.createElement('div'); meta.className = 'meta';
    const title = document.createElement('strong'); title.textContent = item.label;
    const collection = document.createElement('small'); collection.textContent = item.collection;
    const detail = document.createElement('small'); detail.textContent = converted ? '3D garment preview ready' : `${item.textures.length || 1} texture variant${item.textures.length === 1 ? '' : 's'}`;
    const variants = document.createElement('div'); variants.className = 'variants';
    for (const texture of item.textures.slice(0, 7)) {
        const swatch = document.createElement('span'); swatch.className = 'swatch'; swatch.textContent = texture.index; variants.append(swatch);
    }
    if (item.textures.length > 7) { const more = document.createElement('span'); more.className = 'swatch'; more.textContent = `+${item.textures.length - 7}`; variants.append(more); }
    meta.append(title, collection, detail, variants); button.append(preview, meta);
    button.addEventListener('click', () => setActiveItem(item));
    return button;
}

function render() {
    const query = state.search.toLowerCase();
    state.filtered = state.items.filter((item) => (!state.sex || item.sex === state.sex)
        && (!state.component || item.component === state.component)
        && (!query || `${item.label} ${item.collection} ${item.sex}`.toLowerCase().includes(query))
        && !state.selected.has(item.id));
    byId('resultCount').textContent = `${state.filtered.length.toLocaleString()} to review / ${state.selected.size.toLocaleString()} added`;
    const catalog = byId('catalog'); catalog.replaceChildren(...state.filtered.slice(0, 500).map(itemCard));
}

async function load() {
    const [response, convertedResponse] = await Promise.all([
        fetch('/assets/clothingpack5m_catalog.json', { cache: 'no-store' }),
        fetch(`/assets/custom_clothing/clothingpack5m.json?live=${Date.now()}`, { cache: 'no-store' }),
    ]);
    if (!response.ok) throw new Error(`Catalog request failed (${response.status})`);
    const data = await response.json();
    if (convertedResponse.ok) try {
        const converted = await convertedResponse.json();
        for (const components of Object.values(converted.models || {})) for (const variants of Object.values(components || {})) for (const variant of variants || []) state.converted.set(variant.itemId, variant);
    } catch { /* catalog remains usable while a manifest upload is in progress */ }
    state.items = Array.isArray(data.items) ? data.items : [];
    byId('packSummary').textContent = `${data.summary.items.toLocaleString()} drawables / ${data.summary.textures.toLocaleString()} textures`;
    const components = [...new Set(state.items.map((item) => item.component))].sort();
    for (const component of components) { const option = document.createElement('option'); option.value = component; option.textContent = componentDisplayName(component); byId('component').append(option); }
    try {
        const saved = JSON.parse(localStorage.getItem('webglgta.clothingpack5m.review.v2') || '{}');
        for (const row of saved.items || []) { const item = state.items.find((entry) => entry.id === row.id); if (item) state.selected.set(item.id, { item, texture: Number(row.texture) || 0 }); }
    } catch { /* ignore invalid prior selection */ }
    render();
    renderSelection();
    setActiveItem(state.filtered[0] || null);
}

byId('search').addEventListener('input', (event) => { state.search = event.target.value; render(); keepActiveInFilter(); });
byId('component').addEventListener('change', (event) => { state.component = event.target.value; render(); keepActiveInFilter(); });
byId('sexFilters').addEventListener('click', (event) => { const button = event.target.closest('button[data-sex]'); if (!button) return; state.sex = button.dataset.sex; for (const item of byId('sexFilters').querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === button)); render(); keepActiveInFilter(); });
byId('clearSelection').addEventListener('click', () => {
    state.selected.clear();
    save();
    render();
    renderSelection();
    keepActiveInFilter();
});
byId('reviewTexture').addEventListener('change', (event) => {
    if (!state.activeItem) return;
    state.activeTexture = Number(event.target.value);
    state.activePreviewId = '';
    void requestAutomaticPreview(state.activeItem, state.activeTexture);
});
byId('addGarment').addEventListener('click', () => {
    if (!state.activeItem) return;
    const reviewIndex = Math.max(0, state.filtered.indexOf(state.activeItem));
    state.selected.set(state.activeItem.id, { item: state.activeItem, texture: state.activeTexture });
    save();
    render();
    renderSelection();
    const next = state.filtered[Math.min(reviewIndex, Math.max(0, state.filtered.length - 1))] || null;
    setActiveItem(next);
    if (!next) byId('queueStatus').textContent = 'All garments in this view have been reviewed';
});
byId('skipGarment').addEventListener('click', advanceCurrent);
byId('exportSelection').addEventListener('click', () => { const blob = new Blob([JSON.stringify(selectedPayload(), null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'clothingpack5m-selection.json'; link.click(); URL.revokeObjectURL(link.href); });

load().catch((error) => { byId('packSummary').textContent = error.message; });
window.setInterval(async () => {
    try {
        await refreshConverted();
        if (state.pendingPreview && isConverted(state.pendingPreview.item, state.pendingPreview.texture)) {
            void showAutomaticPreview(state.pendingPreview.item, state.pendingPreview.texture);
        }
        const response = await fetch('/__clothing_preview_status', { cache: 'no-store' });
        if (!response.ok) return;
        const status = await response.json();
        if (state.pendingPreview && !['idle', 'ready'].includes(status.state)) byId('queueStatus').textContent = status.detail || status.state;
    } catch { /* worker status is optional */ }
}, 4_000);
