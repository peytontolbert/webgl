const MAX_CHAT_MESSAGES = 50;
const DEMO_DESTINATIONS = Object.freeze({
    legion: Object.freeze({ label: 'Legion Square' }),
    recording: Object.freeze({ label: 'Recording Studio' }),
    walmart: Object.freeze({ label: 'Walmart' }),
    pfmall: Object.freeze({ label: 'PFMall' }),
    mall: Object.freeze({ label: 'Mall MLO patch' }),
});

export const CHAT_COMMANDS = Object.freeze([
    { name: 'commands', aliases: ['help'], usage: '/commands', description: 'List available commands' },
    { name: 'admin', aliases: [], usage: '/admin', description: 'Open the admin menu' },
    { name: 'vehicles', aliases: ['vehicle', 'cars'], usage: '/vehicles', description: 'Open the vehicle menu' },
    { name: '350z', aliases: ['z33'], usage: '/350z', description: 'Spawn the Nissan 350Z beside you' },
    { name: 'track', aliases: ['nurburgring', 'nordschleife'], usage: '/track', description: 'Teleport to the local Nurburgring road' },
    { name: 'legion', aliases: [], usage: '/legion', description: 'Return to Legion Square' },
    { name: 'recording', aliases: [], usage: '/recording', description: 'Travel to Recording Studio' },
    { name: 'walmart', aliases: [], usage: '/walmart', description: 'Travel to Walmart' },
    { name: 'pfmall', aliases: ['mall'], usage: '/pfmall', description: 'Travel to PFMall' },
    { name: 'emotes', aliases: ['emote', 'e'], usage: '/emote [name]', description: 'Open or play an emote' },
    { name: 'stopemote', aliases: ['eoff'], usage: '/stopemote', description: 'Stop the current emote' },
    { name: 'tp', aliases: ['teleport'], usage: '/tp <x> <y> <z>', description: 'Teleport to GTA coordinates' },
    { name: 'noclip', aliases: [], usage: '/noclip [on|off]', description: 'Toggle collision-free movement' },
    { name: 'money', aliases: ['cash'], usage: '/money <amount>', description: 'Add cash' },
    { name: 'spawn', aliases: ['give'], usage: '/spawn <item> [amount]', description: 'Give an item' },
    { name: 'heal', aliases: [], usage: '/heal', description: 'Restore health' },
    { name: 'armor', aliases: ['armour'], usage: '/armor [amount]', description: 'Set armor' },
    { name: 'clear', aliases: [], usage: '/clear', description: 'Clear chat messages' },
]);

const COMMAND_BY_NAME = new Map(CHAT_COMMANDS.flatMap((command) => [command.name, ...command.aliases].map((name) => [name, command])));

export function parseCommandLine(text) {
    const tokens = String(text || '').trim().replace(/^\/+/, '').split(/\s+/).filter(Boolean);
    const enteredName = String(tokens.shift() || '').toLowerCase();
    return { command: COMMAND_BY_NAME.get(enteredName) || null, enteredName, args: tokens };
}

function isEditableTarget(target) {
    return target instanceof HTMLElement && (
        target.isContentEditable
        || target.tagName === 'INPUT'
        || target.tagName === 'SELECT'
        || target.tagName === 'TEXTAREA'
        || target.tagName === 'BUTTON'
    );
}

function displayVehicleClass(value) {
    return String(value || 'VEHICLE').replace(/^VC_/, '').replaceAll('_', ' ');
}

function displayMetadata(value) {
    const text = String(value || '').trim();
    return /^(null|undefined|n\/a)$/i.test(text) ? '' : text;
}

export class ChatMenuController {
    constructor(app) {
        this.app = app;
        this.root = document.getElementById('gameChat');
        this.messages = document.getElementById('gameChatMessages');
        this.form = document.getElementById('gameChatForm');
        this.input = document.getElementById('gameChatInput');
        this.vehicleDialog = document.getElementById('vehicleMenuDialog');
        this.vehicleSearch = document.getElementById('vehicleMenuSearch');
        this.vehicleList = document.getElementById('vehicleMenuList');
        this.vehicleCount = document.getElementById('vehicleMenuCount');
        this.adminDialog = document.getElementById('adminMenuDialog');
        this.adminStatus = document.getElementById('adminMenuStatus');
        this.emoteDialog = document.getElementById('emoteMenuDialog');
        this.emoteSearch = document.getElementById('emoteMenuSearch');
        this.emoteList = document.getElementById('emoteMenuList');
        this.emoteCount = document.getElementById('emoteMenuCount');
        this._chatOpen = false;
        this._vehicles = [];
        this._emotes = [];
        this._bindEvents();
    }

    get capturesInput() {
        return this._chatOpen || !!this.vehicleDialog?.open || !!this.adminDialog?.open || !!this.emoteDialog?.open;
    }

    _bindEvents() {
        window.addEventListener('keydown', (event) => {
            if (!this.app?.spawnDistrictDemo) return;
            if (this.adminDialog?.open) {
                if (event.key === 'Escape') this.closeAdminMenu();
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                }
                return;
            }
            if (this.emoteDialog?.open) {
                if (event.key === 'Escape') this.closeEmoteMenu();
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                }
                return;
            }
            if (this.vehicleDialog?.open) {
                if (event.key === 'Escape') this.closeVehicleMenu();
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                }
                return;
            }
            if (this._chatOpen) {
                if (event.key === 'Escape') this.closeChat();
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                }
                return;
            }
            if (isEditableTarget(event.target) || event.ctrlKey || event.altKey || event.metaKey) return;
            const key = String(event.key || '').toLowerCase();
            if ((key === 't' || key === '/') && !event.repeat && !this.app.settingsMenuOpen && !document.querySelector('dialog[open]')) {
                this.openChat(key === '/' ? '/' : '');
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        }, true);
        this.form?.addEventListener('submit', (event) => {
            event.preventDefault();
            const text = String(this.input?.value || '').trim();
            if (text) this._submit(text);
            this.closeChat();
        });
        this.vehicleDialog?.addEventListener('cancel', (event) => {
            event.preventDefault();
            this.closeVehicleMenu();
        });
        this.vehicleDialog?.addEventListener('click', (event) => {
            if (event.target === this.vehicleDialog) this.closeVehicleMenu();
        });
        document.getElementById('closeVehicleMenu')?.addEventListener('click', () => this.closeVehicleMenu());
        this.vehicleSearch?.addEventListener('input', () => this._renderVehicles());
        this.vehicleList?.addEventListener('click', (event) => {
            const button = event.target?.closest?.('[data-vehicle-model]');
            if (button?.dataset?.vehicleModel) this._spawnVehicle(button.dataset.vehicleModel);
        });
        this.adminDialog?.addEventListener('cancel', (event) => {
            event.preventDefault();
            this.closeAdminMenu();
        });
        this.adminDialog?.addEventListener('click', (event) => {
            if (event.target === this.adminDialog) this.closeAdminMenu();
        });
        document.getElementById('closeAdminMenu')?.addEventListener('click', () => this.closeAdminMenu());
        this.adminDialog?.querySelector('[data-admin-actions]')?.addEventListener('click', (event) => {
            const button = event.target?.closest?.('[data-admin-action]');
            if (button) void this._runAdminAction(button.dataset.adminAction);
        });
        this.emoteDialog?.addEventListener('cancel', (event) => {
            event.preventDefault();
            this.closeEmoteMenu();
        });
        this.emoteDialog?.addEventListener('click', (event) => {
            if (event.target === this.emoteDialog) this.closeEmoteMenu();
        });
        document.getElementById('closeEmoteMenu')?.addEventListener('click', () => this.closeEmoteMenu());
        this.emoteSearch?.addEventListener('input', () => this._renderEmotes());
        this.emoteList?.addEventListener('click', (event) => {
            const button = event.target?.closest?.('[data-emote-command]');
            if (button?.dataset?.emoteCommand) void this._playEmote(button.dataset.emoteCommand);
        });
    }

    _releaseGameplayInput() {
        for (const key of Object.keys(this.app?.keyState || {})) this.app.keyState[key] = false;
        try { this.app?.weaponController?.clearPointerState?.(); } catch { /* ignore */ }
        try { this.app?.meleeController?.clearInput?.(); } catch { /* ignore */ }
        this.app._suppressPointerUnlockMenu = true;
        try { document.exitPointerLock?.(); } catch { /* ignore */ }
    }

    openChat(initialText = '') {
        if (!this.root || !this.input) return false;
        this._releaseGameplayInput();
        this._chatOpen = true;
        this.root.classList.add('is-open');
        this.input.value = initialText;
        requestAnimationFrame(() => {
            this.input.focus();
            this.input.setSelectionRange(this.input.value.length, this.input.value.length);
        });
        return true;
    }

    closeChat({ recapturePointer = true } = {}) {
        if (!this._chatOpen) return false;
        this._chatOpen = false;
        this.root?.classList.remove('is-open');
        this.input?.blur();
        if (recapturePointer) this.app?._requestGameplayPointerLock?.();
        return true;
    }

    _submit(text) {
        if (text.startsWith('/')) {
            void this._runCommand(text);
            return;
        }
        if (!this.app?.multiplayer?.sendChat?.(text)) {
            this.addMessage({ name: this.app?.multiplayer?.name || 'Player', text });
        }
    }

    async _runCommand(text) {
        const parsed = parseCommandLine(text);
        const command = parsed.command?.name || '';
        const args = parsed.args;
        if (command === 'vehicles') {
            if (args.length) return this._usage(parsed.command);
            await this.openVehicleMenu();
            return;
        }
        if (command === '350z') {
            if (args.length) return this._usage(parsed.command);
            this._spawnVehicle('350z');
            return;
        }
        if (command === 'track') {
            if (args.length) return this._usage(parsed.command);
            if (this.app?.multiplayer?.requestTrackTeleport?.()) {
                this.addMessage({ system: true, text: 'Requesting Nurburgring teleport…' });
                return;
            }
            if (this.app?.teleportToDerivedRoad?.()) {
                this.addMessage({ system: true, text: 'Teleported to the Nurburgring road' });
            } else {
                this.addMessage({ system: true, text: 'Nurburgring road package is unavailable in this build' });
            }
            return;
        }
        if (DEMO_DESTINATIONS[command]) {
            if (args.length) return this._usage(parsed.command);
            const destination = DEMO_DESTINATIONS[command];
            if (this.app?.multiplayer?.sendGameplayAction?.({
                kind: 'destination_teleport',
                destination: command,
                eventId: `destination:${command}:${Date.now()}`,
            })) {
                this.addMessage({ system: true, text: `Requesting travel to ${destination.label}` });
            } else {
                this.addMessage({ system: true, text: 'Destination travel requires an online demo session' });
            }
            return;
        }
        if (command === 'emotes') {
            if (!args.length) {
                await this.openEmoteMenu();
                return;
            }
            const result = await this.app?.emotePalette?.play?.(args[0]);
            this.addMessage({ system: true, text: result?.message || 'Emotes are unavailable' });
            return;
        }
        if (command === 'stopemote') {
            this.addMessage({ system: true, text: this.app?.emotePalette?.stop?.() ? 'Emote stopped' : 'No emote is playing' });
            return;
        }
        if (command === 'admin') {
            this.openAdminMenu();
            return;
        }
        if (command === 'commands') {
            this.addMessage({ system: true, text: 'Available commands' });
            for (const entry of CHAT_COMMANDS) this.addMessage({ system: true, text: `${entry.usage} - ${entry.description}` });
            return;
        }
        if (command === 'tp') {
            if (args.length !== 3 || args.some((value) => !Number.isFinite(Number(value)))) return this._usage(parsed.command);
            this._sendAdminCommand('teleport', { x: Number(args[0]), y: Number(args[1]), z: Number(args[2]) });
            return;
        }
        if (command === 'noclip') {
            const mode = String(args[0] || 'toggle').toLowerCase();
            if (!['toggle', 'on', 'off'].includes(mode) || args.length > 1) return this._usage(parsed.command);
            const current = !!this.app?.adminNoclipEnabled;
            this._sendAdminCommand('noclip', { enabled: mode === 'toggle' ? !current : mode === 'on' });
            return;
        }
        if (command === 'money') {
            if (args.length !== 1 || !this._positiveInteger(args[0], 1_000_000)) return this._usage(parsed.command);
            this._sendAdminCommand('money', { amount: Number(args[0]) });
            return;
        }
        if (command === 'spawn') {
            const amount = args[1] === undefined ? 1 : Number(args[1]);
            if (!args[0] || args.length > 2 || !this._positiveInteger(amount, 5000)) return this._usage(parsed.command);
            this._sendAdminCommand('spawn', { item: args[0], amount });
            return;
        }
        if (command === 'heal') {
            if (args.length) return this._usage(parsed.command);
            this._sendAdminCommand('heal');
            return;
        }
        if (command === 'armor') {
            const amount = args[0] === undefined ? 100 : Number(args[0]);
            if (args.length > 1 || !this._positiveInteger(amount, 100)) return this._usage(parsed.command);
            this._sendAdminCommand('armor', { amount });
            return;
        }
        if (command === 'clear') {
            this.messages?.replaceChildren();
            return;
        }
        this.addMessage({ system: true, text: `Unknown command: /${parsed.enteredName || ''}. Use /commands.` });
    }

    _positiveInteger(value, maximum) {
        const number = Number(value);
        return Number.isSafeInteger(number) && number > 0 && number <= maximum;
    }

    _usage(command) {
        this.addMessage({ system: true, text: `Usage: ${command?.usage || '/commands'}` });
    }

    _sendAdminCommand(command, args = {}) {
        if (this.app?.multiplayer?.sendAdminCommand?.(command, args)) {
            this.addMessage({ system: true, text: `Admin request: ${command}` });
            return true;
        }
        this.addMessage({ system: true, text: 'Admin commands require an online demo session' });
        return false;
    }

    receiveAdminResult(message = {}) {
        const result = message.result || {};
        if (message.command === 'noclip' && result.success) this.app.adminNoclipEnabled = !!result.enabled;
        const text = String(result.message || `${message.command || 'Admin command'} ${result.success ? 'completed' : 'failed'}`);
        this.addMessage({ system: true, text });
        if (this.adminStatus) this.adminStatus.textContent = text;
    }

    openAdminMenu() {
        if (!this.adminDialog) return false;
        this._releaseGameplayInput();
        if (this.adminStatus) this.adminStatus.textContent = 'Select an action';
        if (!this.adminDialog.open) this.adminDialog.showModal();
        requestAnimationFrame(() => this.adminDialog.querySelector('[data-admin-action]')?.focus());
        return true;
    }

    closeAdminMenu({ recapturePointer = true } = {}) {
        if (!this.adminDialog?.open) return false;
        this.adminDialog.close();
        if (recapturePointer) this.app?._requestGameplayPointerLock?.();
        return true;
    }

    async _runAdminAction(action) {
        if (action === 'vehicles') {
            this.closeAdminMenu({ recapturePointer: false });
            await this.openVehicleMenu();
            return;
        }
        const actions = {
            noclip: ['noclip', { enabled: !this.app?.adminNoclipEnabled }],
            heal: ['heal', {}],
            armor: ['armor', { amount: 100 }],
            money: ['money', { amount: 10_000 }],
            ammo: ['spawn', { item: 'pistol_ammo', amount: 100 }],
            pistol: ['spawn', { item: 'weapon_glock17', amount: 1 }],
        };
        const request = actions[action];
        if (request) this._sendAdminCommand(request[0], request[1]);
    }

    addMessage(message = {}) {
        if (!this.messages) return;
        const row = document.createElement('div');
        row.className = `game-chat-message${message.system ? ' is-system' : ''}`;
        if (!message.system) {
            const name = document.createElement('span');
            name.className = 'game-chat-name';
            name.textContent = String(message.name || 'Player');
            row.appendChild(name);
        }
        const body = document.createElement('span');
        body.className = 'game-chat-text';
        body.textContent = String(message.text || '');
        row.appendChild(body);
        this.messages.appendChild(row);
        while (this.messages.childElementCount > MAX_CHAT_MESSAGES) this.messages.firstElementChild?.remove();
        this.messages.scrollTop = this.messages.scrollHeight;
        window.setTimeout(() => row.classList.add('is-aged'), 9_000);
    }

    receiveChat(message) {
        this.addMessage(message);
    }

    async openVehicleMenu() {
        if (!this.vehicleDialog || !this.vehicleList) return false;
        this._releaseGameplayInput();
        this.vehicleList.replaceChildren();
        const loading = document.createElement('div');
        loading.className = 'vehicle-menu-empty';
        loading.textContent = 'Loading vehicles';
        this.vehicleList.appendChild(loading);
        if (!this.vehicleDialog.open) this.vehicleDialog.showModal();
        const catalog = await this.app?.vehicleController?.loadCustomCatalog?.();
        this._vehicles = Array.isArray(catalog?.vehicles) ? catalog.vehicles.slice() : [];
        this._vehicles.sort((a, b) => String(a?.name || a?.model || '').localeCompare(String(b?.name || b?.model || '')));
        if (this.vehicleSearch) this.vehicleSearch.value = '';
        this._renderVehicles();
        requestAnimationFrame(() => this.vehicleSearch?.focus());
        return true;
    }

    closeVehicleMenu({ recapturePointer = true } = {}) {
        if (!this.vehicleDialog?.open) return false;
        this.vehicleDialog.close();
        if (recapturePointer) this.app?._requestGameplayPointerLock?.();
        return true;
    }

    _renderVehicles() {
        if (!this.vehicleList) return;
        const query = String(this.vehicleSearch?.value || '').trim().toLowerCase();
        const rows = query ? this._vehicles.filter((vehicle) => [
            vehicle.name, vehicle.make, vehicle.model, vehicle.resource, vehicle.vehicleClass,
        ].some((value) => String(value || '').toLowerCase().includes(query))) : this._vehicles;
        const fragment = document.createDocumentFragment();
        for (const vehicle of rows) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'vehicle-menu-row';
            button.dataset.vehicleModel = String(vehicle.model || '');
            const identity = document.createElement('span');
            identity.className = 'vehicle-menu-identity';
            const name = document.createElement('strong');
            name.textContent = String(vehicle.name || vehicle.model || 'Vehicle');
            const model = document.createElement('span');
            const make = displayMetadata(vehicle.make);
            model.textContent = `${make ? `${make}  ` : ''}${vehicle.model || ''}`.trim();
            identity.append(name, model);
            const type = document.createElement('span');
            type.className = 'vehicle-menu-class';
            type.textContent = displayVehicleClass(vehicle.vehicleClass);
            button.append(identity, type);
            fragment.appendChild(button);
        }
        if (!rows.length) {
            const empty = document.createElement('div');
            empty.className = 'vehicle-menu-empty';
            empty.textContent = this._vehicles.length ? 'No matching vehicles' : 'Vehicle catalog unavailable';
            fragment.appendChild(empty);
        }
        this.vehicleList.replaceChildren(fragment);
        if (this.vehicleCount) this.vehicleCount.textContent = `${rows.length} / ${this._vehicles.length}`;
    }

    _spawnVehicle(model) {
        const vehicle = this.app?.vehicleController?.spawnVehicleNearPlayer?.(model);
        if (!vehicle) {
            this.addMessage({ system: true, text: `Unable to spawn ${model}` });
            return;
        }
        this.addMessage({ system: true, text: `Spawned ${vehicle.name}` });
        this.closeVehicleMenu();
    }

    async openEmoteMenu() {
        if (!this.emoteDialog || !this.emoteList) return false;
        this._releaseGameplayInput();
        this.emoteList.replaceChildren();
        const loading = document.createElement('div');
        loading.className = 'vehicle-menu-empty';
        loading.textContent = 'Loading emotes';
        this.emoteList.appendChild(loading);
        if (!this.emoteDialog.open) this.emoteDialog.showModal();
        try {
            this._emotes = await this.app?.emotePalette?.list?.() || [];
            if (this.emoteSearch) this.emoteSearch.value = '';
            this._renderEmotes();
            requestAnimationFrame(() => this.emoteSearch?.focus());
        } catch (error) {
            this._emotes = [];
            this.emoteList.replaceChildren();
            const empty = document.createElement('div');
            empty.className = 'vehicle-menu-empty';
            empty.textContent = 'Emote library unavailable';
            this.emoteList.appendChild(empty);
            if (this.emoteCount) this.emoteCount.textContent = '0';
            console.warn('Emote menu failed to load', error);
        }
        return true;
    }

    closeEmoteMenu({ recapturePointer = true } = {}) {
        if (!this.emoteDialog?.open) return false;
        this.emoteDialog.close();
        if (recapturePointer) this.app?._requestGameplayPointerLock?.();
        return true;
    }

    _renderEmotes() {
        if (!this.emoteList) return;
        const query = String(this.emoteSearch?.value || '').trim().toLowerCase();
        const rows = query ? this._emotes.filter((emote) => [
            emote.command, emote.label, emote.category,
        ].some((value) => String(value || '').toLowerCase().includes(query))) : this._emotes;
        const fragment = document.createDocumentFragment();
        for (const emote of rows) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'vehicle-menu-row';
            button.dataset.emoteCommand = String(emote.command || '');
            const identity = document.createElement('span');
            identity.className = 'vehicle-menu-identity';
            const name = document.createElement('strong');
            name.textContent = String(emote.label || emote.command || 'Emote');
            const command = document.createElement('span');
            command.textContent = '/' + String(emote.command || '');
            identity.append(name, command);
            const category = document.createElement('span');
            category.className = 'vehicle-menu-class';
            category.textContent = String(emote.category || 'EMOTE').toUpperCase();
            button.append(identity, category);
            fragment.appendChild(button);
        }
        if (!rows.length) {
            const empty = document.createElement('div');
            empty.className = 'vehicle-menu-empty';
            empty.textContent = this._emotes.length ? 'No matching emotes' : 'No imported emotes';
            fragment.appendChild(empty);
        }
        this.emoteList.replaceChildren(fragment);
        if (this.emoteCount) this.emoteCount.textContent = String(rows.length) + ' / ' + String(this._emotes.length);
    }

    async _playEmote(command) {
        const result = await this.app?.emotePalette?.play?.(command);
        this.addMessage({ system: true, text: result?.message || 'Unable to play emote' });
        if (result?.ok) this.closeEmoteMenu();
    }
}
