const app = () => window.__viewerApp;
const state = { active: false, startedAt: 0, timer: 0, fadeTimer: 0 };
const el = document.createElement('section');
el.id = 'nxLoading';
el.hidden = true;
el.innerHTML = '<div class="nxLoadBackdrop"></div><div class="nxLoadContent"><div class="nxLoadBrand">NEXUS<span>AI</span></div><div class="nxLoadTitle">Entering Los Santos</div><div class="nxLoadStage">Preparing your character</div><div class="nxLoadProgress"><i></i></div><div class="nxLoadFooter"><span class="nxLoadHint">TAB Inventory&nbsp;&nbsp; M Phone&nbsp;&nbsp; F1 Radial</span></div></div>';
document.body.append(el);

const stage = el.querySelector('.nxLoadStage');
const bar = el.querySelector('.nxLoadProgress i');
const style = document.createElement('style');
style.textContent = '#nxLoading{position:fixed;inset:0;z-index:2500;display:grid;place-items:center;color:#f4f7fa;font:13px Arial,sans-serif;transition:opacity .35s ease}#nxLoading[hidden]{display:none}.nxLoadBackdrop{position:absolute;inset:0;background:linear-gradient(120deg,#061019e8,#10151bdd 60%,#222b31d9);overflow:hidden}.nxLoadBackdrop:after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,#fff0 0,#fff0 5px,#ffffff08 6px);opacity:.18}.nxLoadContent{position:relative;width:min(520px,calc(100vw - 44px));padding:28px;border-left:3px solid #d61f3d;background:#091117d9;box-shadow:0 18px 70px #0008}.nxLoadBrand{font-weight:700;font-size:20px;letter-spacing:2px}.nxLoadBrand span{color:#e42e4d}.nxLoadTitle{margin-top:26px;font-size:25px;font-weight:700}.nxLoadStage{margin-top:7px;color:#b9c7ce;font-size:12px}.nxLoadProgress{height:5px;margin-top:18px;background:#31414b}.nxLoadProgress i{display:block;width:8%;height:100%;background:#e42e4d;transition:width .28s ease}.nxLoadFooter{display:flex;justify-content:space-between;align-items:center;margin-top:13px;color:#8e9da6;font-size:10px}@media(max-width:560px){.nxLoadContent{padding:22px}.nxLoadTitle{font-size:20px}.nxLoadHint{font-size:9px}}';
document.head.append(style);

const phase = (text, progress) => {
    stage.textContent = text;
    bar.style.width = `${Math.max(4, Math.min(100, progress))}%`;
};

const reset = () => {
    clearInterval(state.timer);
    clearTimeout(state.fadeTimer);
    state.timer = 0;
    state.fadeTimer = 0;
    state.active = false;
    el.hidden = true;
    el.style.opacity = '1';
};

// The server's welcome frame is the only authoritative character-ready signal.
// Current bundles publish `_worldReady` after their first playable frame.
// The currently deployed thin bundle predates that flag, but flips
// `_animationStarted` immediately before scheduling its first frame.
const connectionReady = () => {
    const client = app()?.multiplayer;
    return !!(client?.characterSelected && client.status === 'online' && client.id);
};

const worldReady = () => {
    const viewer = app();
    return !!(viewer?.spawnDistrictDemo && viewer._animationStarted);
};

const complete = () => {
    if (!state.active) return;
    phase('Welcome to Nexus AI.', 100);
    clearInterval(state.timer);
    state.timer = 0;
    state.fadeTimer = setTimeout(() => {
        if (!state.active) return;
        el.style.opacity = '0';
        state.fadeTimer = setTimeout(reset, 360);
    }, 260);
};

const poll = () => {
    if (!state.active) return;
    const elapsed = performance.now() - state.startedAt;
    if (!connectionReady()) {
        phase(elapsed > 12_000 ? 'Waiting for the character session...' : 'Loading character data', 32);
        return;
    }
    if (!worldReady()) {
        phase('Starting the city renderer', 72);
        return;
    }
    if (elapsed < 300) {
        phase('Initializing city systems', 90);
        return;
    }
    complete();
};

const start = () => {
    if (state.active) return;
    state.active = true;
    state.startedAt = performance.now();
    el.hidden = false;
    el.style.opacity = '1';
    phase('Loading character data', 12);
    state.timer = setInterval(poll, 80);
    poll();
};

window.addEventListener('nexus-character-activating', start);
window.addEventListener('nexus-character-ready', poll);
window.addEventListener('nexus-character-activation-failed', reset);
window.addEventListener('webglgta:world-ready', poll);
// Compatibility for integrations that already use this public hook. It is a
// visual start only and never manipulates the multiplayer transport.
window.addEventListener('nexus-loading-start', start);
window.__nxLoading = { start, complete, reset, get active() { return state.active; } };
