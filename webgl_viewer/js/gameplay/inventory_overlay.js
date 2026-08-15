const PLAYER_SLOT_COUNT = 40;
const PLAYER_MAX_WEIGHT_GRAMS = 120000;
const HOTBAR_SLOT_COUNT = 5;

const ITEM_DEFINITIONS = Object.freeze({
    weapon: Object.freeze({
        slot: 1,
        id: 'weapon_glock17',
        fallbackLabel: 'Glock-17',
        type: 'weapon',
        weight: 3000,
        image: 'assets/inventory/weapon_glock17.png',
    }),
    switch: Object.freeze({
        slot: 2,
        id: 'glockswitch',
        label: 'Glock switch',
        type: 'component',
        weight: 180,
    }),
    ammo: Object.freeze({
        slot: 3,
        id: 'pistol_ammo',
        label: 'Pistol ammo',
        type: 'ammo',
        weight: 13,
        image: 'assets/inventory/pistol_ammo.png',
    }),
});

function weightLabel(weightGrams) {
    return `${(Math.max(0, Number(weightGrams) || 0) / 1000).toFixed(2)} / ${(PLAYER_MAX_WEIGHT_GRAMS / 1000).toFixed(0)} kg`;
}

function makeText(tag, className, value = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = value;
    return element;
}

export class InventoryOverlay {
    constructor(app) {
        this.app = app;
        this.dialog = document.getElementById('weaponInventoryDialog');
        this.grid = document.getElementById('inventoryPlayerGrid');
        this.weight = document.getElementById('inventoryWeight');
        this.weightFill = document.getElementById('inventoryWeightFill');
        this.detailTitle = document.getElementById('inventoryDetailTitle');
        this.detailMeta = document.getElementById('inventoryDetailMeta');
        this.detailAction = document.getElementById('inventoryUseAction');
        this.detailStatus = document.getElementById('inventoryActionStatus');
        this.legacyWeaponName = document.getElementById('inventoryWeaponName');
        this.legacyWeaponMeta = document.getElementById('inventoryWeaponMeta');
        this.legacySwitchMeta = document.getElementById('inventorySwitchMeta');
        this.legacyApplySwitch = document.getElementById('inventoryApplySwitch');
        this.contextMenu = document.getElementById('inventoryContextMenu');
        this.hotbar = document.getElementById('inventoryHotbar');
        this.hotbarSlots = document.getElementById('inventoryHotbarSlots');
        this.selectedSlot = 0;
        this.selectedItem = null;
        this._lastStateKey = '';
        this._hotbarTimeout = null;
        this._slotButtons = new Map();
        this._buildSlots();
        this._bindEvents();
        this.sync(true);
    }

    get isOpen() {
        return !!this.dialog?.open;
    }

    _buildSlots() {
        if (!this.grid) return;
        const fragment = document.createDocumentFragment();
        for (let slot = 1; slot <= PLAYER_SLOT_COUNT; slot++) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'nx-inventory-slot';
            button.dataset.inventorySlot = String(slot);
            button.setAttribute('aria-pressed', 'false');
            button.setAttribute('aria-label', `Empty slot ${slot}`);
            const key = makeText('span', 'nx-inventory-slot-key', slot <= HOTBAR_SLOT_COUNT ? String(slot) : '');
            const body = document.createElement('span');
            body.className = 'nx-inventory-slot-body';
            const icon = document.createElement('img');
            icon.className = 'nx-inventory-slot-icon';
            icon.alt = '';
            icon.hidden = true;
            const fallback = makeText('span', 'nx-inventory-slot-fallback');
            fallback.hidden = true;
            const label = makeText('span', 'nx-inventory-slot-label');
            const amount = makeText('span', 'nx-inventory-slot-amount');
            const durability = document.createElement('span');
            durability.className = 'nx-inventory-slot-durability';
            const durabilityFill = document.createElement('span');
            durability.appendChild(durabilityFill);
            body.append(icon, fallback, label, amount, durability);
            button.append(key, body);
            fragment.appendChild(button);
            this._slotButtons.set(slot, { button, icon, fallback, label, amount, durability, durabilityFill });
        }
        this.grid.appendChild(fragment);
    }

    _bindEvents() {
        if (!this.dialog) return;
        this.dialog.addEventListener('cancel', (event) => {
            event.preventDefault();
            this.close();
        });
        this.dialog.addEventListener('click', (event) => {
            if (event.target === this.dialog || event.target?.closest?.('[data-inventory-dismiss]')) {
                this.close();
                return;
            }
            if (!event.target?.closest?.('#inventoryContextMenu')) this._hideContextMenu();
        });
        this.grid?.addEventListener('click', (event) => {
            const slot = Number(event.target?.closest?.('[data-inventory-slot]')?.dataset?.inventorySlot);
            if (slot) this.select(slot);
        });
        this.grid?.addEventListener('dblclick', (event) => {
            const slot = Number(event.target?.closest?.('[data-inventory-slot]')?.dataset?.inventorySlot);
            if (slot) this.useSlot(slot);
        });
        this.grid?.addEventListener('contextmenu', (event) => {
            const slot = Number(event.target?.closest?.('[data-inventory-slot]')?.dataset?.inventorySlot);
            const item = this._getItems().get(slot);
            if (!slot || !item) return;
            event.preventDefault();
            this.select(slot);
            this._showContextMenu(event.clientX, event.clientY, item);
        });
        this.detailAction?.addEventListener('click', () => this.useSlot(this.selectedSlot));
        this.legacyApplySwitch?.addEventListener('click', () => this.useSlot(ITEM_DEFINITIONS.switch.slot));
        document.getElementById('closeWeaponInventory')?.addEventListener('click', () => this.close());
        document.getElementById('inventoryContextUse')?.addEventListener('click', () => this.useSlot(this.selectedSlot));
    }

    _getItems() {
        const inventory = this.app.weaponController?.getInventory?.();
        const status = this.app.weaponController?.getStatus?.();
        const items = new Map();
        if (inventory?.weapon) {
            items.set(ITEM_DEFINITIONS.weapon.slot, {
                ...ITEM_DEFINITIONS.weapon,
                label: inventory.weapon.label || ITEM_DEFINITIONS.weapon.fallbackLabel,
                quantity: 1,
                durability: 100,
                equipped: !!inventory.weapon.equipped,
                automatic: !!status?.automatic,
            });
        }
        if (Number(inventory?.switch?.quantity) > 0) {
            items.set(ITEM_DEFINITIONS.switch.slot, {
                ...ITEM_DEFINITIONS.switch,
                quantity: Math.max(0, Number(inventory.switch.quantity) || 0),
                durability: 100,
                canUse: !!inventory.switch.canApply,
            });
        }
        const ammunition = Math.max(0, Number(status?.magazineAmmo) || 0) + Math.max(0, Number(status?.reserveAmmo) || 0);
        if (ammunition > 0) {
            items.set(ITEM_DEFINITIONS.ammo.slot, {
                ...ITEM_DEFINITIONS.ammo,
                quantity: ammunition,
                durability: 100,
                magazineAmmo: Math.max(0, Number(status?.magazineAmmo) || 0),
                reserveAmmo: Math.max(0, Number(status?.reserveAmmo) || 0),
                magazineCapacity: Math.max(0, Number(status?.magazineCapacity) || 0),
            });
        }
        return items;
    }

    _inventoryKey(items) {
        return Array.from(items.entries()).map(([slot, item]) => [
            slot, item.id, item.label, item.quantity, item.equipped, item.automatic,
            item.magazineAmmo, item.reserveAmmo, item.canUse,
        ].join(':')).join('|');
    }

    sync(force = false) {
        const items = this._getItems();
        const stateKey = this._inventoryKey(items);
        if (!force && stateKey === this._lastStateKey) return;
        this._lastStateKey = stateKey;
        if (this.selectedSlot && !items.has(this.selectedSlot)) {
            this.selectedSlot = 0;
            this.selectedItem = null;
        }
        let totalWeight = 0;
        for (const item of items.values()) totalWeight += item.weight * item.quantity;
        if (this.weight) this.weight.textContent = weightLabel(totalWeight);
        if (this.weightFill) this.weightFill.style.width = `${Math.min(100, (totalWeight / PLAYER_MAX_WEIGHT_GRAMS) * 100)}%`;
        for (const [slot, refs] of this._slotButtons.entries()) {
            this._renderSlot(slot, refs, items.get(slot) || null);
        }
        this._syncDetails(items.get(this.selectedSlot) || null);
        this._syncLegacyWeaponRows();
        this._renderHotbar(items);
    }

    _syncLegacyWeaponRows() {
        const inventory = this.app.weaponController?.getInventory?.();
        const status = this.app.weaponController?.getStatus?.();
        if (this.legacyWeaponName) this.legacyWeaponName.textContent = inventory?.weapon?.label || 'Glock-17';
        if (this.legacyWeaponMeta) {
            const mode = status?.automatic ? 'Automatic' : 'Semi-automatic';
            this.legacyWeaponMeta.textContent = `${status?.magazineAmmo ?? 0} / ${status?.reserveAmmo ?? 0} rounds - ${mode}`;
        }
        const installed = !!inventory?.switch?.installed;
        const quantity = Math.max(0, Number(inventory?.switch?.quantity) || 0);
        if (this.legacySwitchMeta) {
            this.legacySwitchMeta.textContent = installed ? 'Installed' : `${quantity} available`;
        }
        if (this.legacyApplySwitch) {
            this.legacyApplySwitch.disabled = !inventory?.switch?.canApply;
            this.legacyApplySwitch.textContent = installed ? 'Installed' : 'Apply';
        }
    }

    _renderSlot(slot, refs, item) {
        const selected = slot === this.selectedSlot;
        refs.button.classList.toggle('is-filled', !!item);
        refs.button.classList.toggle('is-selected', selected);
        refs.button.setAttribute('aria-pressed', String(selected));
        refs.icon.hidden = !item?.image;
        refs.fallback.hidden = !!item?.image || !item;
        refs.label.textContent = item?.label || '';
        refs.amount.textContent = item && item.quantity > 1 ? `x${item.quantity}` : '';
        refs.durability.hidden = !item;
        refs.durabilityFill.style.width = item ? `${item.durability || 100}%` : '0%';
        if (item?.image) {
            if (refs.icon.src.endsWith(item.image) === false) refs.icon.src = item.image;
            refs.icon.alt = item.label;
        } else {
            refs.icon.removeAttribute('src');
        }
        if (item && !item.image) {
            refs.fallback.textContent = item.type === 'component' ? 'AUTO' : item.type.toUpperCase();
        } else {
            refs.fallback.textContent = '';
        }
        refs.button.title = item ? item.label : `Empty slot ${slot}`;
        refs.button.setAttribute('aria-label', item ? `${item.label}, slot ${slot}` : `Empty slot ${slot}`);
    }

    _syncDetails(item) {
        this.selectedItem = item || null;
        if (!item) {
            if (this.detailTitle) this.detailTitle.textContent = 'Inventory';
            if (this.detailMeta) this.detailMeta.textContent = '';
            if (this.detailAction) {
                this.detailAction.disabled = true;
                this.detailAction.textContent = 'Use';
            }
            return;
        }
        if (this.detailTitle) this.detailTitle.textContent = item.label;
        if (this.detailMeta) {
            if (item.type === 'weapon') {
                this.detailMeta.textContent = item.equipped ? (item.automatic ? 'Equipped - automatic' : 'Equipped') : 'Holstered';
            } else if (item.type === 'ammo') {
                this.detailMeta.textContent = `${item.magazineAmmo} loaded / ${item.reserveAmmo} reserve`;
            } else {
                this.detailMeta.textContent = item.canUse ? 'Ready to install' : 'Draw Glock-17 to install';
            }
        }
        if (this.detailAction) {
            this.detailAction.disabled = item.type === 'component' && !item.canUse;
            this.detailAction.textContent = item.type === 'weapon'
                ? (item.equipped ? 'Holster' : 'Equip')
                : (item.type === 'ammo' ? 'Reload' : 'Install');
        }
    }

    select(slot) {
        const item = this._getItems().get(slot) || null;
        this.selectedSlot = item ? slot : 0;
        this.selectedItem = item;
        this.sync(true);
    }

    _showContextMenu(x, y, item) {
        if (!this.contextMenu) return;
        const action = document.getElementById('inventoryContextUse');
        if (action) action.textContent = item.type === 'weapon' ? (item.equipped ? 'Holster' : 'Equip') : (item.type === 'ammo' ? 'Reload' : 'Install');
        this.contextMenu.hidden = false;
        const maxLeft = Math.max(8, window.innerWidth - 168);
        const maxTop = Math.max(8, window.innerHeight - 54);
        this.contextMenu.style.left = `${Math.max(8, Math.min(maxLeft, x))}px`;
        this.contextMenu.style.top = `${Math.max(8, Math.min(maxTop, y))}px`;
    }

    _hideContextMenu() {
        if (this.contextMenu) this.contextMenu.hidden = true;
    }

    _setStatus(message) {
        if (this.detailStatus) this.detailStatus.textContent = message || '';
    }

    useSlot(slot) {
        const item = this._getItems().get(slot);
        if (!item) return false;
        let changed = false;
        if (item.type === 'weapon') {
            changed = !!this.app.weaponController?.toggleDraw?.();
            if (changed) this.close();
        } else if (item.type === 'ammo') {
            changed = !!this.app.weaponController?.reload?.();
            this._setStatus(changed ? 'Reloading' : 'Magazine full or weapon holstered');
        } else if (item.type === 'component') {
            changed = !!this.app.weaponController?.installSwitch?.();
            this._setStatus(changed ? 'Glock switch installed' : 'Draw Glock-17 before installing');
        }
        this._hideContextMenu();
        this.sync(true);
        return changed;
    }

    open() {
        if (!this.dialog) return false;
        try { this.app.weaponController?.clearPointerState?.(); } catch { /* ignore */ }
        try {
            if (document.pointerLockElement === this.app.canvas) {
                this.app._suppressPointerUnlockMenu = true;
                document.exitPointerLock?.();
            }
        } catch { /* ignore */ }
        this._setStatus('');
        this.sync(true);
        try { this.dialog.showModal(); } catch { this.dialog.setAttribute('open', ''); }
        return true;
    }

    close() {
        this._hideContextMenu();
        try { this.dialog?.close(); } catch { this.dialog?.removeAttribute('open'); }
        return false;
    }

    toggle(forceOpen = null) {
        const open = forceOpen === null ? !this.isOpen : !!forceOpen;
        return open ? this.open() : this.close();
    }

    showHotbar(durationMs = 2400) {
        if (!this.hotbar) return false;
        this.sync();
        this.hotbar.hidden = false;
        if (this._hotbarTimeout) clearTimeout(this._hotbarTimeout);
        this._hotbarTimeout = setTimeout(() => {
            if (this.hotbar) this.hotbar.hidden = true;
            this._hotbarTimeout = null;
        }, durationMs);
        return true;
    }

    _renderHotbar(items) {
        if (!this.hotbarSlots) return;
        const fragment = document.createDocumentFragment();
        for (let slot = 1; slot <= HOTBAR_SLOT_COUNT; slot++) {
            const item = items.get(slot);
            const cell = document.createElement('div');
            cell.className = 'nx-hotbar-slot';
            cell.dataset.filled = String(!!item);
            cell.appendChild(makeText('span', 'nx-hotbar-key', String(slot)));
            if (item?.image) {
                const image = document.createElement('img');
                image.src = item.image;
                image.alt = item.label;
                cell.appendChild(image);
            } else if (item) {
                cell.appendChild(makeText('span', 'nx-hotbar-fallback', item.type === 'component' ? 'AUTO' : item.type.toUpperCase()));
            }
            if (item?.quantity > 1) cell.appendChild(makeText('span', 'nx-hotbar-amount', `x${item.quantity}`));
            fragment.appendChild(cell);
        }
        this.hotbarSlots.replaceChildren(fragment);
    }
}
