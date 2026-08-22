const app = () => window.__viewerApp;
const client = () => app()?.multiplayer;
const hasLaptop = () => Number(client()?.profile?.inventory?.laptop || 0) > 0;

const root = document.createElement('section');
root.id = 'nxLaptop';
root.hidden = true;
document.body.append(root);

document.head.insertAdjacentHTML('beforeend', `<style>
#nxLaptop{position:fixed;inset:0;z-index:1750;display:grid;place-items:center;background:#05090caa;color:#e8eef3;font:13px Arial}
#nxLaptop[hidden]{display:none}.nxl-shell{width:min(1120px,calc(100vw - 34px));height:min(720px,calc(100vh - 34px));display:grid;grid-template-columns:225px 1fr;overflow:hidden;border:10px solid #121820;border-radius:14px;background:#10161d;box-shadow:0 28px 90px #000c}
.nxl-side{display:flex;flex-direction:column;padding:18px 12px;background:#18212b;border-right:1px solid #354352}.nxl-brand{padding:5px 10px 22px;font-size:16px;font-weight:700}.nxl-brand small{display:block;margin-top:4px;color:#97a7b8;font-size:10px}
.nxl-app{display:flex;align-items:center;gap:9px;width:100%;border:0;border-radius:5px;background:transparent;color:#dbe6ee;padding:10px;text-align:left;cursor:pointer;font:inherit}.nxl-app:hover,.nxl-app.active{background:#2c4960;color:#fff}.nxl-app b{display:grid;place-items:center;width:25px;height:25px;border-radius:4px;background:#506d84;color:#fff;font-size:10px}.nxl-side footer{margin-top:auto;padding:10px;color:#8b9cab;font-size:10px}
.nxl-main{min-width:0;display:grid;grid-template-rows:58px 1fr;background:#eef2f5;color:#19242c}.nxl-bar{display:flex;align-items:center;gap:11px;padding:0 18px;background:#f8fafc;border-bottom:1px solid #d4dce2}.nxl-bar strong{font-size:14px}.nxl-bar span{color:#657685;font-size:11px}.nxl-close{margin-left:auto;border:0;border-radius:4px;background:#dae2e8;color:#263641;padding:7px 10px;cursor:pointer}.nxl-content{overflow:auto;padding:24px}
.nxl-home{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.nxl-card{min-height:125px;padding:15px;border:1px solid #d6dfe6;border-radius:7px;background:#fff;box-shadow:0 4px 12px #1f3d5012}.nxl-card h2{margin:0 0 7px;font-size:15px}.nxl-card p{margin:0;color:#61717e;font-size:12px;line-height:1.45}.nxl-action{margin-top:14px;border:0;border-radius:4px;background:#2874a6;color:#fff;padding:8px 10px;cursor:pointer}.nxl-frame{width:100%;height:100%;min-height:520px;border:0;border-radius:5px;background:#fff}.nxl-empty{display:grid;min-height:320px;place-items:center;border:1px dashed #9dacb8;border-radius:7px;background:#fff;color:#536675;text-align:center;padding:24px}.nxl-empty h2{margin:0 0 8px;color:#243745;font-size:18px}.nxl-empty p{max-width:460px;margin:0;line-height:1.5}
@media(max-width:700px){.nxl-shell{grid-template-columns:1fr;height:calc(100vh - 20px);width:calc(100vw - 20px);border-width:6px}.nxl-side{display:none}.nxl-home{grid-template-columns:1fr 1fr}.nxl-content{padding:14px}}
</style>`);

const apps = new Map([
  ['home', { label: 'Desktop', icon: 'NX' }],
  ['city', { label: 'City Status', icon: 'CT' }],
  ['rsps', {
    label: 'RSPS Launcher', icon: 'RS',
    launchUrl: 'http://192.168.0.85:8888/rs2.cgi',
    healthUrl: 'http://192.168.0.85:8888/engine-status',
  }],
  ['guardian', { label: 'Halo 3: Guardian', icon: 'H3' }],
]);

let active = 'home';
const send = (operation) => client()?.sendGameplayAction?.({ kind: 'laptop_action', operation, eventId: `laptop:${operation}:${Date.now()}` });
const escape = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function renderHome(content) {
  const profile = client()?.profile || {};
  content.innerHTML = `<div class="nxl-home"><article class="nxl-card"><h2>City Status</h2><p>Connected as ${escape(profile.phone?.number || 'Citizen')}. Cash and services are available while online.</p><button class="nxl-action" data-open="city">Open status</button></article><article class="nxl-card"><h2>RSPS Launcher</h2><p>Connects to the Nexus RSPS game engine through the demo host.</p><button class="nxl-action" data-open="rsps">Launch</button></article><article class="nxl-card"><h2>Halo 3: Guardian</h2><p>Single-player Guardian sandbox with collision, combat targets, shields, and respawn.</p><button class="nxl-action" data-open="guardian">Open game</button></article></div>`;
}

function renderCity(content) {
  const profile = client()?.profile || {};
  content.innerHTML = `<article class="nxl-card"><h2>Nexus City Network</h2><p>Cash: $${Number(profile.money || 0).toLocaleString()}<br>Bank: $${Number(profile.banking?.checking || 0).toLocaleString()}<br>Job: ${escape(profile.job?.name || 'civilian')}<br>Gang: ${escape(profile.gang?.name || 'none')}</p></article>`;
}

async function renderRsps(content, config) {
  content.innerHTML = '<div class="nxl-empty"><div><h2>Checking RSPS installation</h2><p>Loading the deployment-local game client.</p></div></div>';
  try {
    const response = await fetch(config.healthUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error('not installed');
    content.innerHTML = '<div class="nxl-empty"><div><h2>RSPS is online</h2><p>Launch the private player client in a separate browser tab.</p><button class="nxl-action" data-launch-rsps>Launch RSPS</button></div></div>';
    content.querySelector('[data-launch-rsps]').onclick = () => {
      const launched = window.open(config.launchUrl, '_blank', 'noopener');
      if (!launched) window.__nxSmallToast?.('Allow pop-ups to launch RSPS.');
    };
  } catch {
    content.innerHTML = '<div class="nxl-empty"><div><h2>RSPS engine unavailable</h2><p>The local RSPS web engine is not responding. Start the server web client, then launch it again.</p></div></div>';
  }
}

function renderGuardian(content) {
  content.innerHTML = '<div class="nxl-empty"><div><h2>Halo 3: Guardian</h2><p>Single-player sandbox with exported Guardian geometry, solid collision, combat targets, shields, and respawn.</p><button class="nxl-action" data-start-guardian>Start Game</button></div></div>';
  content.querySelector('[data-start-guardian]').onclick = () => {
    const launch = { kind: 'guardian_singleplayer_start', map: 'guardian', url: '/guardian/index.html', physics: 'single-player-sandbox' };
    window.dispatchEvent(new CustomEvent('nexus:guardian-start', { detail: launch }));
    client()?.sendGameplayAction?.({ kind: 'laptop_action', operation: 'guardian_start', eventId: `laptop:guardian_start:${Date.now()}`, guardian: launch });
    const frame = document.createElement('iframe');
    frame.className = 'nxl-frame'; frame.title = 'Halo 3: Guardian single-player sandbox';
    frame.sandbox = 'allow-same-origin allow-scripts allow-pointer-lock'; frame.src = launch.url;
    content.replaceChildren(frame);
  };
}

async function render() {
  const config = apps.get(active) || apps.get('home');
  root.replaceChildren();
  const shell = document.createElement('div'); shell.className = 'nxl-shell';
  const side = document.createElement('aside'); side.className = 'nxl-side';
  side.innerHTML = '<div class="nxl-brand">NEXUSBOOK<small>Secure portable terminal</small></div>';
  for (const [id, item] of apps) {
    const button = document.createElement('button'); button.className = `nxl-app${id === active ? ' active' : ''}`;
    button.innerHTML = `<b>${escape(item.icon)}</b><span>${escape(item.label)}</span>`;
    button.onclick = () => { active = id; void render(); }; side.append(button);
  }
  side.insertAdjacentHTML('beforeend', '<footer>L close laptop</footer>');
  const main = document.createElement('main'); main.className = 'nxl-main';
  const bar = document.createElement('header'); bar.className = 'nxl-bar';
  bar.innerHTML = `<strong>${escape(config.label)}</strong><span>NexusAI portable OS</span><button class="nxl-close">Close</button>`;
  bar.querySelector('button').onclick = close;
  const content = document.createElement('section'); content.className = 'nxl-content'; main.append(bar, content); shell.append(side, main); root.append(shell);
  if (active === 'home') {
    renderHome(content);
    content.querySelectorAll('[data-open]').forEach((button) => { button.onclick = () => { active = String(button.dataset.open || 'home'); void render(); }; });
  } else if (active === 'city') renderCity(content);
  else if (active === 'guardian') renderGuardian(content);
  else if (config.launchUrl) await renderRsps(content, config);
}

function open() {
  if (!hasLaptop()) { window.__nxSmallToast?.('A laptop is required.'); return false; }
  root.hidden = false;
  try { document.exitPointerLock?.(); } catch { /* ignored */ }
  send('open'); void render(); return true;
}
function close() { root.hidden = true; try { document.body.requestPointerLock?.(); } catch { /* ignored */ } }

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.key.toLowerCase() === 'l') { event.preventDefault(); root.hidden ? open() : close(); }
  if (event.key === 'Escape' && !root.hidden) { event.preventDefault(); close(); }
}, true);

const register = () => window.__nxRadialMenu?.addOption({ id: 'laptop', title: 'Laptop', canOpen: hasLaptop, action: open }, 'laptop');
const registerTimer = setInterval(() => { if (!window.__nxRadialMenu) return; register(); clearInterval(registerTimer); }, 180);
window.__nxLaptop = { open, close, registerApp: (id, config) => apps.set(String(id), { label: String(config?.label || id), icon: String(config?.icon || 'APP').slice(0, 3), url: String(config?.url || '') }) };
