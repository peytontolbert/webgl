function clamp(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || 0));
}

export class GtaHud {
    constructor(app) {
        this.app = app;
        this.root = document.createElement('div');
        this.root.id = 'gtaGameplayHud';
        this.root.innerHTML = `
            <div class="gta-radar-wrap"><canvas class="gta-radar" width="190" height="190"></canvas><div class="gta-vitals"><span class="gta-health"></span><span class="gta-armor"></span></div></div>
            <div class="gta-status"><div class="gta-money"></div><div class="gta-wanted" aria-label="Wanted level"></div></div>
            <div class="gta-pickup" hidden></div>
            <div class="gta-interaction" hidden></div>
            <div class="gta-wheel" hidden><button data-weapon="unarmed">Unarmed</button><button data-weapon="pistol">Pistol</button></div>`;
        const style = document.createElement('style');
        style.textContent = `
            #gtaGameplayHud{position:fixed;inset:0;z-index:21;pointer-events:none;font-family:Arial,sans-serif;color:#fff;text-shadow:0 1px 2px #000}
            .gta-radar-wrap{position:absolute;left:20px;bottom:20px;width:190px;height:202px}.gta-radar{width:190px;height:190px;background:rgba(9,13,14,.76);border:2px solid rgba(255,255,255,.7);clip-path:polygon(0 0,100% 0,100% 88%,88% 100%,0 100%)}
            .gta-vitals{position:absolute;left:3px;right:3px;bottom:0;height:9px;display:grid;grid-template-columns:1fr 1fr;gap:3px;background:#111}.gta-vitals span{display:block;transform-origin:left}.gta-health{background:#61cf65}.gta-armor{background:#58aee8}
            .gta-status{position:absolute;right:22px;top:68px;text-align:right}.gta-money{font-size:21px;font-weight:700;color:#86d983}.gta-wanted{height:23px;font-size:21px;color:#f4d64c;letter-spacing:0}
            .gta-pickup{position:absolute;left:50%;bottom:88px;transform:translateX(-50%);padding:7px 10px;background:rgba(8,10,12,.84);border-left:3px solid #d8ef45;font-size:14px}
            .gta-interaction{position:absolute;left:50%;bottom:124px;transform:translateX(-50%);padding:7px 10px;background:rgba(8,10,12,.84);border-left:3px solid #77c8e6;font-size:14px}
            .gta-wheel{position:absolute;left:50%;top:50%;width:300px;height:300px;transform:translate(-50%,-50%);border:2px solid rgba(255,255,255,.72);border-radius:50%;background:rgba(6,8,10,.8);pointer-events:auto}
            .gta-wheel button{position:absolute;width:110px;height:54px;border:1px solid #90979e;background:#20252a;color:#fff;border-radius:5px}.gta-wheel button[data-weapon="unarmed"]{left:18px;top:123px}.gta-wheel button[data-weapon="pistol"]{right:18px;top:123px}.gta-wheel button:hover,.gta-wheel button:focus{border-color:#d8ef45;color:#d8ef45}
            @media(max-width:600px){.gta-radar-wrap{left:10px;bottom:10px;transform:scale(.78);transform-origin:left bottom}.gta-status{right:12px}}
        `;
        document.head.append(style);
        document.body.append(this.root);
        this.style = style;
        this.canvas = this.root.querySelector('canvas');
        this.context = this.canvas.getContext('2d');
        this.wheel = this.root.querySelector('.gta-wheel');
        this._onKeyDown = (event) => {
            if (event.key === 'Tab' && !event.repeat && !this.app?.settingsMenuOpen) {
                event.preventDefault(); this.setWheelOpen(true);
            }
        };
        this._onKeyUp = (event) => { if (event.key === 'Tab') { event.preventDefault(); this.setWheelOpen(false); } };
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
        this.wheel.addEventListener('click', (event) => {
            const weapon = event.target.closest('[data-weapon]')?.dataset.weapon;
            if (weapon === 'unarmed') this.app?.weaponController?.holsterImmediate?.();
            if (weapon === 'pistol' && this.app?.weaponController?.phase === 'holstered') this.app.weaponController.toggleDraw?.();
            this.setWheelOpen(false);
        });
    }

    setWheelOpen(open) {
        if (this.wheel.hidden !== !open) this.wheel.hidden = !open;
        if (this.app?.player) this.app.player.weaponWheelOpen = !!open;
    }

    update() {
        const melee = this.app?.meleeController?.getStatus?.() || {};
        const profile = this.app?.multiplayer?.profile || {};
        const health = this.root.querySelector('.gta-health');
        const armor = this.root.querySelector('.gta-armor');
        const healthTransform = `scaleX(${clamp(melee.health, 0, 100) / 100})`;
        const armorTransform = `scaleX(${clamp(melee.armor, 0, 100) / 100})`;
        if (health.style.transform !== healthTransform) health.style.transform = healthTransform;
        if (armor.style.transform !== armorTransform) armor.style.transform = armorTransform;
        const money = this.root.querySelector('.gta-money');
        const moneyText = `$${Math.max(0, Number(profile.money) || 0).toLocaleString()}`;
        if (money.textContent !== moneyText) money.textContent = moneyText;
        const wanted = clamp(this.app?.npcSystem?.wantedLevel, 0, 5) | 0;
        const wantedElement = this.root.querySelector('.gta-wanted');
        const wantedText = `${'\u2605'.repeat(wanted)}${'\u2606'.repeat(5 - wanted)}`;
        if (wantedElement.textContent !== wantedText) wantedElement.textContent = wantedText;
        const pickup = this.app?.multiplayer?.nearbyPickup;
        const pickupPrompt = this.root.querySelector('.gta-pickup');
        if (pickupPrompt.hidden !== !pickup) pickupPrompt.hidden = !pickup;
        const pickupName = pickup?.type === 'coca_leaves' ? 'Harvest coca leaves' : `Pick up ${pickup?.type || ''}`;
        const pickupText = pickup ? `E  ${pickupName} (+${pickup.amount})` : '';
        if (pickupPrompt.textContent !== pickupText) pickupPrompt.textContent = pickupText;
        const interaction = this.app?.interactionSystem?.active;
        const interactionPrompt = this.root.querySelector('.gta-interaction');
        const doorState = interaction?.type === 'door' ? this.app?.doorController?.getDoorState?.(interaction.id) : null;
        const interactionText = interaction?.type === 'bank' ? 'E  Open Nexus Bank'
            : interaction?.type === 'atm' ? 'E  Use ATM'
            : interaction?.type === 'door' ? `E  ${interaction.locked ? 'Locked' : doorState?.target >= 0.5 ? 'Close' : 'Open'} ${interaction.label || 'Door'}`
            : interaction ? `E  ${interaction.label || 'Interact'}` : '';
        if (interactionPrompt.hidden !== !interactionText) interactionPrompt.hidden = !interactionText;
        if (interactionPrompt.textContent !== interactionText) interactionPrompt.textContent = interactionText;
        this._drawRadar();
    }

    _drawRadar() {
        const ctx = this.context;
        const player = this.app?.ped?.posData;
        if (!ctx || !player) return;
        const size = this.canvas.width;
        const scale = size / 90;
        ctx.clearRect(0, 0, size, size);
        ctx.fillStyle = '#101719'; ctx.fillRect(0, 0, size, size);
        ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1;
        for (let i = 0; i <= size; i += 38) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, size); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(size, i); ctx.stroke(); }
        const point = (x, y, color, radius = 3) => {
            const px = size / 2 + (Number(x) - player[0]) * scale;
            const py = size / 2 - (Number(y) - player[1]) * scale;
            if (px < 2 || py < 2 || px > size - 2 || py > size - 2) return;
            ctx.fillStyle = color; ctx.beginPath(); ctx.arc(px, py, radius, 0, Math.PI * 2); ctx.fill();
        };
        for (const npc of this.app?.npcSystem?.npcs || []) point(npc.x, npc.y, npc.role === 'police' ? '#60a8ff' : npc.hostile ? '#f05a58' : '#e8e8e8', npc.role === 'police' ? 4 : 2.5);
        for (const remote of this.app?.multiplayer?.getRemotePlayers?.() || []) point(remote.x, remote.y, '#61d7ef', 3.5);
        for (const pickup of this.app?.multiplayer?.pickups || []) if (pickup.available) point(pickup.x, pickup.y, pickup.type === 'armor' ? '#58aee8' : pickup.type === 'ammo' ? '#f0c849' : pickup.type === 'coca_leaves' ? '#52e04c' : '#86d983', 3);
        for (const spot of this.app?.interactionSystem?.spots || []) if (spot.type === 'bank') point(spot.coords.x, spot.coords.y, '#77c8e6', 3.2);
        const vehicle = this.app?.vehicleController?.getRenderState?.(); if (vehicle) point(vehicle.position[0], vehicle.position[1], '#f0c849', 3.5);
        ctx.save(); ctx.translate(size / 2, size / 2); ctx.rotate((Number(this.app?.player?.headingRad) || 0) - Math.PI / 2); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(-7, -5); ctx.lineTo(-4, 0); ctx.lineTo(-7, 5); ctx.closePath(); ctx.fill(); ctx.restore();
    }

    destroy() {
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
        this.root.remove(); this.style.remove();
    }
}
