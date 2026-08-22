import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

const SOCKET_PATH = '/__multiplayer';
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_ROOM_PLAYERS = 32;
const HEARTBEAT_MS = 5_000;
const MIN_STATE_INTERVAL_MS = 30;
const WORLD_SIMULATION_INTERVAL_MS = 50;
const WORLD_SNAPSHOT_INTERVAL_MS = 50;
const NETWORK_SCOPE_RADIUS = 350;
const NETWORK_GRID_CELL_SIZE = 350;
const DEMO_ROOM = 'demo';
const PROFILE_FILE = process.env.WEBGLGTA_PROFILE_FILE || path.resolve('data', 'multiplayer_profiles.json');
const CHARACTER_FILE = process.env.WEBGLGTA_CHARACTER_FILE || path.resolve('data', 'multiplayer_characters.json');
const MAX_CHARACTER_SLOTS = 4;
const PLAYER_RESPAWN_MS = 5_000;
const PISTOL_DAMAGE = 38;
const MELEE_DAMAGE = 20;
const MAX_POLICE_NPCS = 12;
const POLICE_RETIRE_MS = 5_000;
const SHOT_HISTORY_MS = 300;
const SHOT_ORIGIN_TOLERANCE = 2.5;
const SHOT_NPC_GROUND_TOLERANCE = 8.0;
const SHOT_MIN_TARGET_DISTANCE = 0.25;
const DEMO_CENTER = Object.freeze({ x: 186.94, y: -850.84 });
// The hosted district descriptor is 4,000 x 4,000 m around Legion Square.
// Keep server-side movement validation in the same world bounds as the client;
// the previous 250 m legacy radius silently corrected legitimate positions.
const DEMO_HALF_SIZE = 2000;
const DEMO_SPAWN = Object.freeze({ x: 186.94, y: -850.84, feetZ: 31.17 });
const DEMO_DESTINATION_TELEPORTS = Object.freeze({
  legion: Object.freeze({ label: 'Legion Square', district: 'demo', x: 186.94, y: -850.84, z: 31.17, halfSize: 0, returnToLegion: true }),
  recording: Object.freeze({ label: 'Recording Studio', district: 'recording', x: 203.4, y: -18.7, z: 74.1, halfSize: 150 }),
  walmart: Object.freeze({ label: 'Walmart', district: 'walmart', x: 69.274155, y: -1776.3516, z: 28.290794, halfSize: 150 }),
  pfmall: Object.freeze({ label: 'PFMall', district: 'pfmall', x: -310.64, y: -2008.15, z: 30.2, halfSize: 150 }),
  mall: Object.freeze({ label: 'PFMall', district: 'pfmall', x: -310.64, y: -2008.15, z: 30.2, halfSize: 150 }),
});
// Generated derived-road package bounds with a small contact margin. This is
// an explicit second playable region, not an unrestricted full-map allowance.
const NURBURGRING_TRACK_BOUNDS = Object.freeze({ minX: 4850, minY: -5650, maxX: 11040, maxY: -770 });
// Verified against the Touristenfahrten entry spline and authored TRM-NRM
// physics mesh. This is the connected public-access lane on the circuit.
const NURBURGRING_TRACK_SPAWN = Object.freeze({
  x: 8269.7124023125, y: -1815.599121046875, feetZ: -26.386101501526504,
  heading: 2.6144141472165385,
});
// Every non-city playable area is declared as a bounded expansion. Adding a
// future expansion is data work here plus its client renderer, not another
// special-case coordinate teleport that leaves city systems enabled.
const WORLD_EXPANSIONS = Object.freeze({
  nordschleife: Object.freeze({
    id: 'nordschleife', label: 'Nürburgring',
    bounds: NURBURGRING_TRACK_BOUNDS,
    spawn: NURBURGRING_TRACK_SPAWN,
    isolateCityWorld: true,
  }),
});
const DEMO_DISTRICTS = Object.freeze({
  demo: Object.freeze({ id: 'demo', center: DEMO_CENTER, halfSize: DEMO_HALF_SIZE, spawn: DEMO_SPAWN }),
  weed_shop: Object.freeze({
    id: 'weed_shop', center: Object.freeze({ x: -8.281454, y: -1076.245728 }), halfSize: 150,
    // The root is an exterior MLO anchor. This is the center of its authored
    // front room, not the anchor transform beside the building.
    spawn: Object.freeze({ x: -33.01, y: -1038.05, feetZ: 29.17 }),
  }),
  recording: Object.freeze({ id: 'recording', center: Object.freeze({ x: 197.1212, y: -21.09571 }), halfSize: 150, spawn: Object.freeze({ x: 203.4, y: -18.7, feetZ: 74.1 }) }),
  walmart: Object.freeze({ id: 'walmart', center: Object.freeze({ x: 69.274155, y: -1776.3516 }), halfSize: 150, spawn: Object.freeze({ x: 69.274155, y: -1776.3516, feetZ: 28.290794 }) }),
  pfmall: Object.freeze({ id: 'pfmall', center: Object.freeze({ x: -325, y: -1965 }), halfSize: 150, spawn: Object.freeze({ x: -310.64, y: -2008.15, feetZ: 30.2 }) }),
});
const BANK_MAX_SHARED_ACCOUNTS = 2;
const BANK_MAX_BALANCE = 10_000_000;
const BANK_MAX_TRANSACTION = 1_000_000;
const BANK_STATEMENT_LIMIT = 80;
const LOCOMOTION_TRANSITION_CLIPS = new Set([
  'locomotion_start_run_left', 'locomotion_start_run_right',
  'locomotion_stop_run_left', 'locomotion_stop_run_right',
  'locomotion_turn_run_180_left', 'locomotion_turn_run_180_right',
  'locomotion_start_walk_left', 'locomotion_start_walk_right',
  'locomotion_stop_walk_left', 'locomotion_stop_walk_right',
  'locomotion_turn_walk_180_left', 'locomotion_turn_walk_180_right',
  'locomotion_turn_sprint_left', 'locomotion_turn_sprint_right',
]);
// The hosted Nexus demo includes its admin workflow by default. A process
// restart must not silently remove those controls because its environment was
// reconstructed without an affirmative flag. Set WEBGLGTA_ADMIN_COMMANDS=0
// only when an operator intentionally wants to disable them.
const ADMIN_COMMANDS_ENABLED = process.env.WEBGLGTA_ADMIN_COMMANDS !== '0';
const ADMIN_MAX_MONEY_GRANT = 1_000_000;
const BANK_BRANCHES = Object.freeze([
  { x: 149.05, y: -1041.30, z: 29.37 },
  { x: 313.32, y: -280.03, z: 54.17 },
  { x: -351.94, y: -50.72, z: 49.04 },
  { x: -1212.68, y: -331.83, z: 37.78 },
  { x: -2961.67, y: 482.31, z: 15.70 },
  { x: 1175.64, y: 2707.71, z: 38.09 },
  { x: 247.65, y: 223.87, z: 106.29 },
  { x: -111.98, y: 6470.56, z: 31.63 },
]);
const DEMO_ATMS = Object.freeze([
  { x: 147.47305, y: -1036.21753, z: 28.36778 }, { x: 145.83922, y: -1035.62537, z: 28.36778 },
  { x: 24.59330, y: -945.54303, z: 28.33305 }, { x: 5.68604, y: -919.95508, z: 28.48088 },
  { x: 296.17563, y: -896.23181, z: 28.29015 }, { x: 296.87750, y: -894.31958, z: 28.26148 },
  { x: 118.64156, y: -883.56946, z: 30.13945 }, { x: 112.47614, y: -819.80804, z: 30.33955 },
  { x: 114.54742, y: -775.97211, z: 30.41736 }, { x: 111.38856, y: -774.84015, z: 30.43766 },
  { x: -27.89034, y: -724.10895, z: 43.22287 }, { x: -30.09957, y: -723.28632, z: 43.22287 },
]);
const RUNTIME_ASSET_ROOTS = Object.freeze([
  process.env.WEBGLGTA_ASSET_ROOT ? path.resolve(process.env.WEBGLGTA_ASSET_ROOT) : null,
  path.resolve('dist-thin', 'assets'),
  path.resolve('dist', 'assets'),
  path.resolve('assets'),
].filter(Boolean));
const demoDoors = (() => {
  try {
    const candidates = RUNTIME_ASSET_ROOTS.map((root) => path.join(root, 'demo', 'interactables.json'));
    const file = candidates.find((candidate) => fs.existsSync(candidate));
    if (!file) return { list: [], byId: new Map() };
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = (Array.isArray(payload?.doors) ? payload.doors : []).map((door) => ({
      id: boundedText(door?.id, '', 72),
      x: finite(door?.coords?.x),
      y: finite(door?.coords?.y),
      z: finite(door?.coords?.z),
      radius: finite(door?.radius, 2.35, 0.8, 8.0),
      automatic: door?.automatic !== false,
      locked: door?.locked === true,
      autoCloseMs: finite(door?.autoCloseMs, 1300, 500, 10_000),
    })).filter((door) => door.id);
    return { list, byId: new Map(list.map((door) => [door.id, door])) };
  } catch (error) {
    console.warn('Demo doors unavailable:', error.message);
    return { list: [], byId: new Map() };
  }
})();
const AMBIENT_PED_MODEL_HASHES = Object.freeze(['3250873975', '3014915558', '826475330', '1068876755', '1446741360']);
const POLICE_PED_MODEL_HASH = '1581098148';
const navigation = (() => {
  try {
    const candidates = RUNTIME_ASSET_ROOTS.map((root) => path.join(root, 'navigation', 'demo_navmesh.json'));
    const file = candidates.find((candidate) => fs.existsSync(candidate));
    if (!file) throw new Error('demo_navmesh.json was not found in dist/assets or assets');
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    return { ready: nodes.length > 0, nodes, byId: new Map(nodes.map((node) => [String(node.id), node])) };
  } catch (error) {
    console.warn('Pedestrian navigation unavailable; using direct NPC targets:', error.message);
    return { ready: false, nodes: [], byId: new Map() };
  }
})();

function navDistance(a, b) {
  return Math.hypot(Number(a?.[0]) - Number(b?.[0]), Number(a?.[1]) - Number(b?.[1]));
}

function nearestNavNode(x, y, z, maxDistance = 35) {
  let best = null;
  let bestScore = maxDistance * maxDistance;
  for (const node of navigation.nodes) {
    const dx = Number(node.center?.[0]) - x;
    const dy = Number(node.center?.[1]) - y;
    const dz = Math.abs(Number(node.center?.[2]) - z);
    const score = dx * dx + dy * dy + dz * dz * 2;
    if (dz <= 5 && score < bestScore) { best = node; bestScore = score; }
  }
  return best;
}

function chooseNpcRoute(npc) {
  if (!navigation.ready) return [];
  const start = nearestNavNode(npc.x, npc.y, npc.feetZ);
  if (!start) return [];
  const candidates = navigation.nodes.filter((node) => {
    const distance = navDistance(node.center, start.center);
    return distance >= 8 && distance <= 32 && Math.abs(Number(node.center?.[2]) - npc.feetZ) <= 3.5;
  });
  if (!candidates.length) return [];
  const goal = candidates[Math.floor(Math.random() * candidates.length)];
  const open = [{ id: String(start.id), score: navDistance(start.center, goal.center) }];
  const cameFrom = new Map();
  const cost = new Map([[String(start.id), 0]]);
  const closed = new Set();
  for (let visited = 0; open.length && visited < 5000; visited++) {
    let bestIndex = 0;
    for (let i = 1; i < open.length; i++) if (open[i].score < open[bestIndex].score) bestIndex = i;
    const currentId = open.splice(bestIndex, 1)[0].id;
    if (closed.has(currentId)) continue;
    if (currentId === String(goal.id)) {
      const route = [];
      for (let cursor = currentId; cursor;) {
        const node = navigation.byId.get(cursor);
        if (node) route.push(node.center);
        cursor = cameFrom.get(cursor) || '';
      }
      return route.reverse();
    }
    closed.add(currentId);
    const current = navigation.byId.get(currentId);
    for (const rawLink of current?.links || []) {
      const link = String(rawLink);
      const next = navigation.byId.get(link);
      if (!next || closed.has(link)) continue;
      const nextCost = (cost.get(currentId) || 0) + navDistance(current.center, next.center);
      if (nextCost >= (cost.get(link) ?? Number.POSITIVE_INFINITY)) continue;
      cost.set(link, nextCost);
      cameFrom.set(link, currentId);
      open.push({ id: link, score: nextCost + navDistance(next.center, goal.center) });
    }
  }
  return [];
}

function boundedText(value, fallback, maxLength) {
  const clean = String(value || '').trim().replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, maxLength);
  return clean || fallback;
}

function sanitizeChatText(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function finite(value, fallback = 0, min = -100_000, max = 100_000) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function boundedArray(input, max = 64) {
  return Array.isArray(input) ? input.slice(0, max).map((value) => String(value || '').replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 96)).filter(Boolean) : [];
}

function sanitizeAppearance(input) {
  const value = input && typeof input === 'object' ? input : {};
  return {
    modelName: boundedText(value.modelName, 'mp_m_freemode_01', 48),
    hashes: boundedArray(value.hashes, 32),
    components: boundedArray(value.components, 32),
  };
}

function bankAccountNumber(seed) {
  let hash = 2166136261;
  for (const char of String(seed || 'webglgta')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `NX${(hash >>> 0).toString().padStart(10, '0')}`;
}

function bankAmount(value) {
  const amount = Math.floor(Number(value));
  return Number.isSafeInteger(amount) && amount > 0 && amount <= BANK_MAX_TRANSACTION ? amount : 0;
}

function bankAccountName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!/^[a-zA-Z0-9 _-]{2,48}$/.test(name) || name.toLowerCase() === 'checking') return '';
  return name;
}

function bankReason(value, fallback) {
  return boundedText(value, fallback, 50);
}

function sanitizeStatement(value, accountName) {
  const source = value && typeof value === 'object' ? value : {};
  const type = source.type === 'deposit' ? 'deposit' : 'withdraw';
  return {
    id: boundedText(source.id, randomUUID(), 72),
    accountName,
    amount: finite(source.amount, 0, 0, BANK_MAX_TRANSACTION) | 0,
    reason: bankReason(source.reason, type === 'deposit' ? 'Bank Deposit' : 'Bank Withdrawal'),
    type,
    date: typeof source.date === 'string' && source.date.length <= 64 ? source.date : new Date().toISOString(),
  };
}

function sanitizeBanking(input, seed = '') {
  const source = input && typeof input === 'object' ? input : {};
  const accountNumber = /^[A-Z0-9]{8,16}$/.test(String(source.accountNumber || '').toUpperCase())
    ? String(source.accountNumber).toUpperCase()
    : bankAccountNumber(seed);
  const names = new Set(['checking']);
  const sharedAccounts = [];
  for (const raw of Array.isArray(source.sharedAccounts) ? source.sharedAccounts.slice(0, BANK_MAX_SHARED_ACCOUNTS) : []) {
    const name = bankAccountName(raw?.name);
    if (!name || names.has(name.toLowerCase())) continue;
    names.add(name.toLowerCase());
    const users = Array.from(new Set((Array.isArray(raw?.users) ? raw.users : [])
      .map((item) => String(item || '').toUpperCase()).filter((item) => /^[A-Z0-9]{8,16}$/.test(item) && item !== accountNumber))).slice(0, 24);
    sharedAccounts.push({
      name,
      balance: finite(raw?.balance, 0, 0, BANK_MAX_BALANCE) | 0,
      users,
    });
  }
  const statements = {};
  for (const [rawName, rawStatements] of Object.entries(source.statements && typeof source.statements === 'object' ? source.statements : {})) {
    const name = String(rawName || '');
    if (name !== 'checking' && !sharedAccounts.some((account) => account.name === name)) continue;
    statements[name] = (Array.isArray(rawStatements) ? rawStatements : []).slice(0, BANK_STATEMENT_LIMIT)
      .map((statement) => sanitizeStatement(statement, name));
  }
  if (!statements.checking) statements.checking = [];
  for (const account of sharedAccounts) if (!statements[account.name]) statements[account.name] = [];
  return {
    accountNumber,
    checking: finite(source.checking, 5_000, 0, BANK_MAX_BALANCE) | 0,
    card: {
      active: source.card?.active !== false,
      pin: /^\d{4}$/.test(String(source.card?.pin || '')) ? String(source.card.pin) : '1234',
    },
    sharedAccounts,
    statements,
  };
}

function defaultProfile(sessionId = '') {
  return {
    sessionId,
    actorId: randomUUID(),
    health: 100,
    armor: 0,
    money: 2500,
    banking: sanitizeBanking(null, sessionId),
    inventory: { weapon_glock17: 1, pistol_ammo: 68, glockswitch: 1, coca_leaves: 0, laptop: 0 },
    appearance: sanitizeAppearance(null),
    ownedVehicles: [{ id: 'starter_sultan', model: 'sultan', label: 'Karin Sultan', damage: 0 }],
    position: null,
    updatedAt: new Date().toISOString(),
  };
}

function sanitizeProfile(input, sessionId = '') {
  const source = input && typeof input === 'object' ? input : {};
  const base = defaultProfile(sessionId);
  return {
    ...base,
    actorId: /^[a-f0-9-]{32,64}$/i.test(String(source.actorId || '')) ? String(source.actorId) : base.actorId,
    health: finite(source.health, 100, 0, 100),
    armor: finite(source.armor, 0, 0, 100),
    money: finite(source.money, 2500, 0, 10_000_000) | 0,
    banking: sanitizeBanking(source.banking, sessionId),
    inventory: {
      weapon_glock17: finite(source.inventory?.weapon_glock17, 1, 0, 1) | 0,
      pistol_ammo: finite(source.inventory?.pistol_ammo, 68, 0, 5000) | 0,
      glockswitch: finite(source.inventory?.glockswitch, 1, 0, 20) | 0,
      coca_leaves: finite(source.inventory?.coca_leaves, 0, 0, 5000) | 0,
      laptop: finite(source.inventory?.laptop, 0, 0, 100) | 0,
    },
    appearance: sanitizeAppearance(source.appearance),
    ownedVehicles: Array.isArray(source.ownedVehicles) ? source.ownedVehicles.slice(0, 24).map((vehicle, index) => ({
      id: boundedText(vehicle?.id, `vehicle_${index}`, 48),
      model: boundedText(vehicle?.model, 'sultan', 48),
      label: boundedText(vehicle?.label, vehicle?.model || 'Vehicle', 64),
      damage: finite(vehicle?.damage, 0, 0, 1000),
    })) : base.ownedVehicles,
    position: Array.isArray(source.position) && source.position.length >= 3
      ? source.position.slice(0, 3).map((value) => finite(value)) : null,
    updatedAt: new Date().toISOString(),
  };
}

function sanitizeLocomotionTransition(input) {
  const transition = input && typeof input === 'object' ? input : null;
  const clip = String(transition?.clip || '').trim().toLowerCase();
  if (!transition?.active || !LOCOMOTION_TRANSITION_CLIPS.has(clip)) return null;
  return {
    active: true,
    clip,
    progress: finite(transition.progress, 0, 0, 1),
  };
}

const PHONE_ANIMATION_CLIPS = new Set([
  'phone_text_in', 'phone_text_idle', 'phone_text_out',
  'phone_call_in', 'phone_call_idle', 'phone_call_out',
  'phone_text_to_call', 'phone_call_to_text',
  'phone_photo_enter', 'phone_photo_idle', 'phone_photo_exit',
  'phone_selfie_enter', 'phone_selfie_idle', 'phone_selfie_exit',
]);

function sanitizePhoneState(input) {
  const phone = input && typeof input === 'object' ? input : null;
  const clip = String(phone?.clip || '').trim().toLowerCase();
  if (!phone?.active || !PHONE_ANIMATION_CLIPS.has(clip)) return null;
  const mode = ['text', 'call', 'photo', 'selfie'].includes(phone?.mode) ? phone.mode : 'text';
  return { active: true, clip, mode };
}

function sanitizeState(input, profile = null) {
  const state = input && typeof input === 'object' ? input : {};
    const gait = ['idle', 'walk', 'run', 'sprint'].includes(state.gait) ? state.gait : 'idle';
    return {
    x: finite(state.x),
    y: finite(state.y),
    feetZ: finite(state.feetZ),
    heading: finite(state.heading, 0, -Math.PI * 4, Math.PI * 4),
    phase: finite(state.phase, 0, -1_000_000, 1_000_000),
    move01: finite(state.move01, 0, 0, 1),
    gait,
    locomotionTransition: sanitizeLocomotionTransition(state.locomotionTransition),
    phone: sanitizePhoneState(state.phone),
    health: profile ? profile.health : finite(state.health, 100, 0, 100),
    armor: profile ? profile.armor : finite(state.armor, 0, 0, 100),
    dead: profile ? profile.health <= 0 : !!state.dead,
    inVehicle: !!state.inVehicle,
    vehicle: state.inVehicle && state.vehicle ? {
      x: finite(state.vehicle.x),
      y: finite(state.vehicle.y),
      z: finite(state.vehicle.z),
      heading: finite(state.vehicle.heading, 0, -Math.PI * 4, Math.PI * 4),
      model: boundedText(state.vehicle.model, 'sultan', 48),
      speed: finite(state.vehicle.speed, 0, -80, 80),
      damage: finite(state.vehicle.damage, 0, 0, 1000),
    } : null,
    voiceEnabled: !!state.voiceEnabled,
    voiceTalking: !!state.voiceTalking,
    voiceRange: finite(state.voiceRange, 7, 1, 30),
    voiceMode: finite(state.voiceMode, 1, 0, 2) | 0,
    weaponAction: boundedText(state.weaponAction, '', 24),
    weaponActionSerial: finite(state.weaponActionSerial, 0, 0, Number.MAX_SAFE_INTEGER),
    weaponPhase: boundedText(state.weaponPhase, 'holstered', 24),
    weaponFiring: !!state.weaponFiring,
    meleeAction: boundedText(state.meleeAction, '', 24),
    meleeActionSerial: finite(state.meleeActionSerial, 0, 0, Number.MAX_SAFE_INTEGER),
    meleeAttacking: !!state.meleeAttacking,
    meleeProgress: finite(state.meleeProgress, 0, 0, 1),
    appearance: sanitizeAppearance(state.appearance),
  };
}

function demoDistrict(id = 'demo') {
  return DEMO_DISTRICTS[String(id || '')] || DEMO_DISTRICTS.demo;
}

function isInDemoDistrict(state, districtId = 'demo') {
    const district = demoDistrict(districtId);
    const x = Number(state?.x);
    const y = Number(state?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const inDistrict = x >= district.center.x - district.halfSize
        && x <= district.center.x + district.halfSize
        && y >= district.center.y - district.halfSize
        && y <= district.center.y + district.halfSize;
    if (inDistrict || district.id !== 'demo') return inDistrict;
    return Object.values(WORLD_EXPANSIONS).some((expansion) => (
      x >= expansion.bounds.minX && x <= expansion.bounds.maxX
      && y >= expansion.bounds.minY && y <= expansion.bounds.maxY
    ));
}

function resetStateToDemoSpawn(state, districtId = 'demo') {
  const spawn = demoDistrict(districtId).spawn;
  state.x = spawn.x;
  state.y = spawn.y;
  state.feetZ = spawn.feetZ;
  return state;
}

function sanitizeVoiceSignal(input) {
  const signal = input && typeof input === 'object' ? input : null;
  if (!signal) return null;
  const description = signal.description;
  if (description && ['offer', 'answer'].includes(description.type) && typeof description.sdp === 'string') {
    const sdp = description.sdp.slice(0, 12_000);
    return sdp ? { description: { type: description.type, sdp } } : null;
  }
  const candidate = signal.candidate;
  if (candidate && typeof candidate.candidate === 'string') {
    return {
      candidate: {
        candidate: candidate.candidate.slice(0, 2_048),
        sdpMid: typeof candidate.sdpMid === 'string' ? candidate.sdpMid.slice(0, 64) : null,
        sdpMLineIndex: finite(candidate.sdpMLineIndex, 0, 0, 64) | 0,
        usernameFragment: typeof candidate.usernameFragment === 'string' ? candidate.usernameFragment.slice(0, 128) : null,
      },
    };
  }
  return null;
}

export function createMultiplayerHub() {
  const rooms = new Map();
  const sessions = new Map();
  const activeProfiles = new Map();
  let profileData = {};
  let characterData = {};
  let saveTimer = null;
  let characterSaveTimer = null;
  try { profileData = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')) || {}; } catch { profileData = {}; }
  try { characterData = JSON.parse(fs.readFileSync(CHARACTER_FILE, 'utf8')) || {}; } catch { characterData = {}; }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(PROFILE_FILE), { recursive: true });
        const temporary = `${PROFILE_FILE}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(profileData, null, 2), 'utf8');
        fs.renameSync(temporary, PROFILE_FILE);
      } catch (error) {
        console.warn('Multiplayer profile save failed:', error?.message || error);
      }
    }, 250);
    saveTimer.unref?.();
  }

  function scheduleCharacterSave() {
    clearTimeout(characterSaveTimer);
    characterSaveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(CHARACTER_FILE), { recursive: true });
        const temporary = `${CHARACTER_FILE}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(characterData, null, 2), 'utf8');
        fs.renameSync(temporary, CHARACTER_FILE);
      } catch (error) {
        console.warn('Multiplayer character save failed:', error?.message || error);
      }
    }, 250);
    characterSaveTimer.unref?.();
  }

  function profileFor(sessionId) {
    const profile = sanitizeProfile(profileData[sessionId], sessionId);
    profileData[sessionId] = profile;
    return profile;
  }

  function storedProfiles() {
    return Object.values(profileData).filter((profile) => profile?.banking?.accountNumber);
  }

  function publicProfile(profile) {
    const banking = profile?.banking || sanitizeBanking(null, profile?.sessionId || '');
    const accountNumber = banking.accountNumber;
    const sharedAccounts = [];
    const statements = { checking: Array.isArray(banking.statements?.checking) ? banking.statements.checking.slice(0, BANK_STATEMENT_LIMIT) : [] };
    for (const owner of storedProfiles()) {
      for (const account of owner.banking?.sharedAccounts || []) {
        const isOwner = owner === profile;
        const hasAccess = isOwner || account.users?.includes(accountNumber);
        if (!hasAccess) continue;
        sharedAccounts.push({
          name: account.name,
          balance: account.balance,
          users: isOwner ? [...account.users] : [],
          owner: isOwner,
        });
        statements[account.name] = Array.isArray(owner.banking?.statements?.[account.name])
          ? owner.banking.statements[account.name].slice(0, BANK_STATEMENT_LIMIT) : [];
      }
    }
    return {
      ...profile,
      banking: {
        accountNumber,
        checking: banking.checking,
        card: { active: banking.card?.active !== false },
        sharedAccounts,
        statements,
      },
    };
  }

  function markProfilesChanged(profiles) {
    const now = new Date().toISOString();
    for (const profile of new Set(profiles.filter(Boolean))) {
      profile.updatedAt = now;
      for (const [token, value] of Object.entries(profileData)) {
        if (value === profile) profileData[token] = profile;
      }
    }
  }

  function appendBankStatement(profile, accountName, amount, reason, type) {
    const banking = profile?.banking;
    if (!banking) return;
    const statements = banking.statements || (banking.statements = {});
    const list = Array.isArray(statements[accountName]) ? statements[accountName] : (statements[accountName] = []);
    list.unshift({
      id: randomUUID(), accountName, amount, reason: bankReason(reason, type === 'deposit' ? 'Bank Deposit' : 'Bank Withdrawal'),
      type: type === 'deposit' ? 'deposit' : 'withdraw', date: new Date().toISOString(),
    });
    if (list.length > BANK_STATEMENT_LIMIT) list.length = BANK_STATEMENT_LIMIT;
  }

  function bankAccountEntry(profile, name) {
    const accountName = String(name || '');
    if (accountName.toLowerCase() === 'checking') return { type: 'checking', ownerProfile: profile, account: profile?.banking, name: 'checking' };
    const accountNumber = profile?.banking?.accountNumber;
    for (const owner of storedProfiles()) {
      const account = owner.banking?.sharedAccounts?.find((entry) => entry.name === accountName);
      if (!account) continue;
      if (owner === profile || account.users?.includes(accountNumber)) return { type: 'shared', ownerProfile: owner, account, name: account.name };
    }
    return null;
  }

  function bankBalance(entry) {
    return entry?.type === 'checking' ? Number(entry.ownerProfile?.banking?.checking) || 0 : Number(entry?.account?.balance) || 0;
  }

  function setBankBalance(entry, amount) {
    const balance = Math.max(0, Math.min(BANK_MAX_BALANCE, Math.floor(Number(amount) || 0)));
    if (entry?.type === 'checking') entry.ownerProfile.banking.checking = balance;
    else if (entry?.account) entry.account.balance = balance;
  }

  function bankingLocationNearby(state, locations, radius = 4.0) {
    const x = Number(state?.x);
    const y = Number(state?.y);
    const z = Number(state?.feetZ);
    if (![x, y, z].every(Number.isFinite)) return false;
    return locations.some((location) => Math.hypot(location.x - x, location.y - y) <= radius && Math.abs(location.z - z) <= 5.0);
  }

  function bankBranchNearby(state) {
    return bankingLocationNearby(state, BANK_BRANCHES);
  }

  function atmNearby(state) {
    return bankingLocationNearby(state, DEMO_ATMS, 2.0);
  }

  function bankResult(success, message) {
    return { success: !!success, message: String(message || (success ? 'Transaction complete' : 'Banking request failed')) };
  }

  function uniqueBankAccountName(name) {
    const normalized = bankAccountName(name);
    if (!normalized) return '';
    return storedProfiles().some((profile) => profile.banking?.sharedAccounts?.some((account) => account.name.toLowerCase() === normalized.toLowerCase())) ? '' : normalized;
  }

  function handleBankAction(room, peer, action) {
    const kind = String(action.kind || '');
    const atmRequest = action.channel === 'atm';
    if (atmRequest ? !atmNearby(peer.state) : !bankBranchNearby(peer.state)) {
      return bankResult(false, atmRequest ? 'Stand near a Nexus ATM to use your debit card' : 'Visit a Nexus Bank branch to use banking');
    }
    const profile = peer.profile;
    const banking = profile?.banking;
    if (!banking) return bankResult(false, 'Banking profile unavailable');
    if (atmRequest) {
      if (banking.card?.active === false || String(action.pin || '') !== String(banking.card?.pin || '')) {
        return bankResult(false, 'Debit card PIN was not accepted');
      }
      if (kind !== 'bank_withdraw') return bankResult(false, 'ATM access supports withdrawals only');
      if (action.verifyOnly === true) return bankResult(true, 'Debit card verified');
    }

    if (kind === 'bank_set_card_pin') {
      const pin = String(action.pin || '');
      if (!/^\d{4}$/.test(pin)) return bankResult(false, 'Enter a four-digit card PIN');
      banking.card.active = true;
      banking.card.pin = pin;
      markProfilesChanged([profile]);
      return bankResult(true, 'Debit card updated');
    }

    if (kind === 'bank_open_account') {
      const name = uniqueBankAccountName(action.accountName);
      const amount = bankAmount(action.amount);
      if (!name || !amount) return bankResult(false, 'Enter a unique account name and initial deposit');
      if (banking.sharedAccounts.length >= BANK_MAX_SHARED_ACCOUNTS) return bankResult(false, 'Shared account limit reached');
      if (banking.checking < amount) return bankResult(false, 'Insufficient checking balance');
      banking.checking -= amount;
      banking.sharedAccounts.push({ name, balance: amount, users: [] });
      banking.statements[name] = [];
      appendBankStatement(profile, 'checking', amount, `Initial deposit for ${name}`, 'withdraw');
      appendBankStatement(profile, name, amount, 'Initial deposit', 'deposit');
      markProfilesChanged([profile]);
      return bankResult(true, 'Shared account opened');
    }

    if (kind === 'bank_rename_account' || kind === 'bank_delete_account' || kind === 'bank_add_user' || kind === 'bank_remove_user') {
      const entry = bankAccountEntry(profile, action.accountName);
      if (!entry || entry.type !== 'shared' || entry.ownerProfile !== profile) return bankResult(false, 'You do not own this shared account');
      const account = entry.account;
      if (kind === 'bank_rename_account') {
        const name = uniqueBankAccountName(action.newName);
        if (!name) return bankResult(false, 'Enter a unique account name');
        const oldName = account.name;
        account.name = name;
        banking.statements[name] = banking.statements[oldName] || [];
        delete banking.statements[oldName];
        for (const statement of banking.statements[name]) statement.accountName = name;
        markProfilesChanged([profile]);
        return bankResult(true, 'Shared account renamed');
      }
      if (kind === 'bank_delete_account') {
        if (account.balance > 0) return bankResult(false, 'Transfer the remaining account balance before deleting');
        banking.sharedAccounts = banking.sharedAccounts.filter((candidate) => candidate !== account);
        delete banking.statements[account.name];
        markProfilesChanged([profile]);
        return bankResult(true, 'Shared account deleted');
      }
      const userNumber = String(action.userAccountNumber || '').toUpperCase();
      const userProfile = storedProfiles().find((candidate) => candidate.banking?.accountNumber === userNumber) || null;
      if (!userProfile || userProfile === profile) return bankResult(false, 'Account number was not found');
      if (kind === 'bank_add_user') {
        if (account.users.includes(userNumber)) return bankResult(false, 'User already has access');
        account.users.push(userNumber);
        markProfilesChanged([profile]);
        return bankResult(true, 'User added to shared account');
      }
      if (!account.users.includes(userNumber)) return bankResult(false, 'User does not have access');
      account.users = account.users.filter((number) => number !== userNumber);
      markProfilesChanged([profile]);
      return bankResult(true, 'User removed from shared account');
    }

    if (kind === 'bank_deposit' || kind === 'bank_withdraw') {
      const entry = bankAccountEntry(profile, action.accountName);
      const amount = bankAmount(action.amount);
      const reason = bankReason(action.reason, kind === 'bank_deposit' ? 'Bank Deposit' : 'Bank Withdrawal');
      if (!entry || !amount) return bankResult(false, 'Choose an account and valid amount');
      if (kind === 'bank_deposit') {
        if (profile.money < amount) return bankResult(false, 'Insufficient cash balance');
        if (bankBalance(entry) + amount > BANK_MAX_BALANCE) return bankResult(false, 'Account balance limit reached');
        profile.money -= amount;
        setBankBalance(entry, bankBalance(entry) + amount);
        appendBankStatement(entry.ownerProfile, entry.name, amount, reason, 'deposit');
      } else {
        if (bankBalance(entry) < amount) return bankResult(false, 'Insufficient account balance');
        setBankBalance(entry, bankBalance(entry) - amount);
        profile.money = Math.min(BANK_MAX_BALANCE, profile.money + amount);
        appendBankStatement(entry.ownerProfile, entry.name, amount, reason, 'withdraw');
      }
      markProfilesChanged([profile, entry.ownerProfile]);
      return bankResult(true, kind === 'bank_deposit' ? 'Deposit complete' : 'Withdrawal complete');
    }

    if (kind === 'bank_internal_transfer') {
      const from = bankAccountEntry(profile, action.fromAccountName);
      const to = bankAccountEntry(profile, action.toAccountName);
      const amount = bankAmount(action.amount);
      const reason = bankReason(action.reason, 'Internal transfer');
      if (!from || !to || !amount || from === to || action.fromAccountName === action.toAccountName) return bankResult(false, 'Choose two accounts and a valid amount');
      if (bankBalance(from) < amount) return bankResult(false, 'Insufficient account balance');
      if (bankBalance(to) + amount > BANK_MAX_BALANCE) return bankResult(false, 'Account balance limit reached');
      setBankBalance(from, bankBalance(from) - amount);
      setBankBalance(to, bankBalance(to) + amount);
      appendBankStatement(from.ownerProfile, from.name, amount, reason, 'withdraw');
      appendBankStatement(to.ownerProfile, to.name, amount, reason, 'deposit');
      markProfilesChanged([from.ownerProfile, to.ownerProfile]);
      return bankResult(true, 'Transfer complete');
    }

    if (kind === 'bank_external_transfer') {
      const from = bankAccountEntry(profile, action.fromAccountName);
      const amount = bankAmount(action.amount);
      const reason = bankReason(action.reason, 'External transfer');
      const recipientNumber = String(action.toAccountNumber || '').toUpperCase();
      const recipient = Array.from(room.values()).find((candidate) => candidate !== peer && candidate.profile?.banking?.accountNumber === recipientNumber) || null;
      if (!from || !amount || !recipient) return bankResult(false, 'Recipient must be online with a valid account number');
      if (bankBalance(from) < amount) return bankResult(false, 'Insufficient account balance');
      if (recipient.profile.banking.checking + amount > BANK_MAX_BALANCE) return bankResult(false, 'Recipient account balance limit reached');
      setBankBalance(from, bankBalance(from) - amount);
      recipient.profile.banking.checking += amount;
      appendBankStatement(from.ownerProfile, from.name, amount, reason, 'withdraw');
      appendBankStatement(recipient.profile, 'checking', amount, reason, 'deposit');
      markProfilesChanged([from.ownerProfile, recipient.profile]);
      return bankResult(true, 'Transfer complete');
    }

    return bankResult(false, 'Unsupported banking action');
  }

  function createWorld(district = DEMO_DISTRICTS.demo) {
    const offsets = [[14, 8], [-15, 6], [23, -15], [-20, -18], [8, 28], [-27, 19]];
    const spawn = district.spawn;
    const isLegion = district.id === 'demo';
    return {
      district,
      sequence: 0,
      lastSnapshotAt: 0,
      wanted: new Map(),
      policeSerial: 0,
      doors: new Map((isLegion ? demoDoors.list : []).map((door) => [door.id, { id: door.id, open: false, closeAt: 0, updatedAt: 0 }])),
      pickups: isLegion ? [
        { id: 'pickup_armor_1', type: 'armor', x: 193.5, y: -846.5, feetZ: 31.17, amount: 50, availableAt: 0 },
        { id: 'pickup_ammo_1', type: 'ammo', x: 180.5, y: -845.0, feetZ: 31.17, amount: 24, availableAt: 0 },
        { id: 'pickup_cash_1', type: 'cash', x: 187.0, y: -860.0, feetZ: 31.17, amount: 500, availableAt: 0 },
        // nx-mod-coke normally places this prop in rural fields. The source field is
        // outside /demo, so this representative crop is kept in the district to make
        // the actual FiveM harvest loop playable and testable here.
        {
          id: 'pickup_coca_plant_1', type: 'coca_leaves', visual: 'coca_plant', modelHash: '2611685511',
          x: 174.0, y: -857.0, feetZ: 31.17, heading: 0, amount: 1, availableAt: 0,
          minAmount: 1, maxAmount: 3, respawnMs: 20 * 60 * 1000,
        },
      ] : [],
      npcs: offsets.map(([dx, dy], index) => ({
        id: `ambient_${index + 1}`, x: spawn.x + dx, y: spawn.y + dy, feetZ: spawn.feetZ,
        homeX: spawn.x + dx, homeY: spawn.y + dy, targetX: spawn.x - dx * 0.5, targetY: spawn.y - dy * 0.5,
        heading: 0, speed: 1.1 + (index % 3) * 0.12, health: 100, state: 'wander', role: 'civilian',
        modelHash: AMBIENT_PED_MODEL_HASHES[index % AMBIENT_PED_MODEL_HASHES.length], navPath: [], navPathIndex: 0,
        hostileTo: '', fleeFrom: '', deadUntil: 0, retargetAt: Date.now() + 2000 + index * 400,
      })),
    };
  }

  function isWithinNetworkScope(state, center) {
    if (!center) return true;
    return Math.hypot(Number(state?.x) - Number(center?.x), Number(state?.y) - Number(center?.y)) <= NETWORK_SCOPE_RADIUS;
  }

  function worldSnapshot(room, center = null) {
    return room.world?.npcs?.filter((npc) => isWithinNetworkScope(npc, center)).map((npc) => ({
      id: npc.id, x: npc.x, y: npc.y, feetZ: npc.feetZ, heading: npc.heading,
      health: npc.health, maxHealth: 100, state: npc.state, role: npc.role,
      modelHash: npc.modelHash,
      hostile: !!npc.hostileTo, weapon: npc.role === 'police' && npc.hostileTo ? 'pistol' : '',
    })) || [];
  }

  function pickupSnapshot(room, center = null) {
    const now = Date.now();
    return room.world?.pickups?.filter((pickup) => isWithinNetworkScope(pickup, center)).map((pickup) => ({
      id: pickup.id, type: pickup.type, visual: pickup.visual || '', modelHash: pickup.modelHash || '',
      x: pickup.x, y: pickup.y, feetZ: pickup.feetZ, heading: pickup.heading || 0,
      amount: pickup.amount, available: now >= pickup.availableAt,
    })) || [];
  }

  function doorSnapshot(room) {
    return Array.from(room.world?.doors?.values?.() || []).map((door) => ({
      id: door.id,
      open: door.open === true,
      updatedAt: Number(door.updatedAt) || 0,
    }));
  }

  function send(socket, payload) {
    if (socket.readyState === WebSocket.OPEN) socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  function refreshBankProfiles(room) {
    for (const peer of room.values()) {
      send(peer.socket, { type: 'bank_profile', profile: publicProfile(peer.profile) });
    }
  }

  function broadcast(room, payload, except = null) {
    const encoded = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const peer of room.values()) {
      if (peer.socket !== except) send(peer.socket, encoded);
    }
  }

  function gridCellFor(state) {
    return `${Math.floor(Number(state?.x || 0) / NETWORK_GRID_CELL_SIZE)},${Math.floor(Number(state?.y || 0) / NETWORK_GRID_CELL_SIZE)}`;
  }

  function addToSpatialGrid(room, peer) {
    if (!room.spatialGrid) room.spatialGrid = new Map();
    const cell = gridCellFor(peer.state);
    if (peer.spatialCell === cell && room.spatialGrid.get(cell)?.has(peer.id)) return;
    if (peer.spatialCell) {
      const previous = room.spatialGrid.get(peer.spatialCell);
      previous?.delete(peer.id);
      if (previous && !previous.size) room.spatialGrid.delete(peer.spatialCell);
    }
    const members = room.spatialGrid.get(cell) || new Set();
    members.add(peer.id);
    room.spatialGrid.set(cell, members);
    peer.spatialCell = cell;
  }

  function removeFromSpatialGrid(room, peer) {
    if (!peer.spatialCell) return;
    const members = room.spatialGrid?.get(peer.spatialCell);
    members?.delete(peer.id);
    if (members && !members.size) room.spatialGrid.delete(peer.spatialCell);
    peer.spatialCell = '';
  }

  function scopedPeers(room, peer) {
    if (!room.spatialGrid || !peer.state) return [];
    const cellX = Math.floor(Number(peer.state.x || 0) / NETWORK_GRID_CELL_SIZE);
    const cellY = Math.floor(Number(peer.state.y || 0) / NETWORK_GRID_CELL_SIZE);
    const nearby = [];
    for (let x = cellX - 1; x <= cellX + 1; x++) {
      for (let y = cellY - 1; y <= cellY + 1; y++) {
        for (const id of room.spatialGrid.get(`${x},${y}`) || []) {
          const other = room.get(id);
          if (other && other !== peer && isWithinNetworkScope(other.state, peer.state)) nearby.push(other);
        }
      }
    }
    return nearby;
  }

  function reconcilePeerScope(room, peer) {
    const nextPeers = scopedPeers(room, peer);
    const nextIds = new Set(nextPeers.map((other) => other.id));
    for (const other of nextPeers) {
      if (peer.scopedPeerIds.has(other.id)) continue;
      peer.scopedPeerIds.add(other.id);
      other.scopedPeerIds.add(peer.id);
      send(peer.socket, { type: 'peer_joined', id: other.id, name: other.name, state: other.state });
      send(other.socket, { type: 'peer_joined', id: peer.id, name: peer.name, state: peer.state });
    }
    for (const id of Array.from(peer.scopedPeerIds)) {
      if (nextIds.has(id)) continue;
      peer.scopedPeerIds.delete(id);
      const other = room.get(id);
      other?.scopedPeerIds.delete(peer.id);
      send(peer.socket, { type: 'peer_left', id });
      if (other) send(other.socket, { type: 'peer_left', id: peer.id });
    }
    return nextPeers;
  }

  function broadcastScoped(room, source, payload, except = null) {
    const encoded = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const id of source.scopedPeerIds) {
      const peer = room.get(id);
      if (peer?.socket !== except) send(peer.socket, encoded);
    }
  }

  function characterAccountId(value) {
    const accountId = String(value || '').trim();
    return /^[a-zA-Z0-9-]{16,72}$/.test(accountId) ? accountId : '';
  }

  function characterSlots(accountId) {
    const seen = new Set();
    const slots = (Array.isArray(characterData[accountId]) ? characterData[accountId] : []).map((entry) => ({
      token: String(entry?.token || '').trim(),
      name: boundedText(entry?.name, 'Character', 24),
      lastPlayedAt: typeof entry?.lastPlayedAt === 'string' ? entry.lastPlayedAt.slice(0, 64) : '',
    })).filter((entry) => /^[a-f0-9-]{32,64}$/i.test(entry.token) && !seen.has(entry.token) && seen.add(entry.token)).slice(0, MAX_CHARACTER_SLOTS);
    characterData[accountId] = slots;
    return slots;
  }

  function sendCharacterSlots(peer, error = '') {
    const slots = peer.characterAccount ? characterSlots(peer.characterAccount) : [];
    send(peer.socket, { type: 'character_slots', slots, error: String(error || '') });
  }

  function handleCharacterMessage(peer, message) {
    const type = String(message?.type || '');
    if (type === 'character_bootstrap') {
      const accountId = characterAccountId(message.accountId);
      if (!accountId) {
        send(peer.socket, { type: 'character_slots', slots: [], error: 'Invalid character account' });
        return;
      }
      peer.characterAccount = accountId;
      sendCharacterSlots(peer);
      return;
    }
    if (!peer.characterAccount || peer.roomId) return;
    const slots = characterSlots(peer.characterAccount);
    if (type === 'character_create') {
      if (slots.length >= MAX_CHARACTER_SLOTS) {
        sendCharacterSlots(peer, `Character slot limit is ${MAX_CHARACTER_SLOTS}`);
        return;
      }
      const name = boundedText(message.name, '', 24);
      if (!name || name.length < 2) {
        sendCharacterSlots(peer, 'Character name must contain at least two characters');
        return;
      }
      const token = randomUUID();
      const slot = { token, name, lastPlayedAt: '' };
      slots.push(slot);
      characterData[peer.characterAccount] = slots;
      profileFor(token);
      scheduleSave();
      scheduleCharacterSave();
      sendCharacterSlots(peer);
      return;
    }
    const token = String(message.token || '').trim();
    const slot = slots.find((entry) => entry.token === token);
    if (!slot) {
      sendCharacterSlots(peer, 'Character was not found for this account');
      return;
    }
    if (type === 'character_delete') {
      const suppliedAccount = characterAccountId(message.accountId);
      if (suppliedAccount && suppliedAccount !== peer.characterAccount) {
        sendCharacterSlots(peer, 'Character account mismatch');
        return;
      }
      characterData[peer.characterAccount] = slots.filter((entry) => entry.token !== token);
      delete profileData[token];
      scheduleSave();
      scheduleCharacterSave();
      sendCharacterSlots(peer);
      return;
    }
    if (type === 'character_activate') {
      slot.lastPlayedAt = new Date().toISOString();
      characterData[peer.characterAccount] = slots;
      scheduleCharacterSave();
      join(peer, {
        name: slot.name,
        sessionId: message.sessionId,
        resumeToken: slot.token,
        state: message.state,
      });
    }
  }

  function leave(peer) {
    if (!peer.roomId) return;
    const roomId = peer.roomId;
    const room = rooms.get(roomId);
    peer.roomId = '';
    if (peer.sessionId && sessions.get(peer.sessionId) === peer) sessions.delete(peer.sessionId);
    if (peer.resumeToken && activeProfiles.get(peer.resumeToken) === peer) activeProfiles.delete(peer.resumeToken);
    if (!room || !room.has(peer.id)) return;
    if (peer.profile && peer.state) {
      peer.profile.position = [peer.state.x, peer.state.y, peer.state.feetZ];
      peer.profile.updatedAt = new Date().toISOString();
      profileData[peer.resumeToken] = peer.profile;
      scheduleSave();
    }
    for (const id of peer.scopedPeerIds) {
      const other = room.get(id);
      other?.scopedPeerIds.delete(peer.id);
      if (other) send(other.socket, { type: 'peer_left', id: peer.id });
    }
    peer.scopedPeerIds.clear();
    removeFromSpatialGrid(room, peer);
    room.delete(peer.id);
    if (!room.size) rooms.delete(roomId);
  }

  function join(peer, message) {
    leave(peer);
    const district = demoDistrict(message?.district);
    const roomId = district.id;
    const room = rooms.get(roomId) || new Map();
    if (!room.world) room.world = createWorld(district);
    peer.sessionId = boundedText(message.sessionId, peer.id, 64).replace(/ /g, '-');
    const suppliedToken = String(message.resumeToken || '').trim();
    peer.resumeToken = /^[a-f0-9-]{32,64}$/i.test(suppliedToken) ? suppliedToken : randomUUID();
    // A profile is a single controllable character. Prevent cloned tabs or a
    // reconnect race from leaving two sockets able to mutate the same inventory.
    const replaced = sessions.get(peer.sessionId) || activeProfiles.get(peer.resumeToken);
    if (replaced && replaced !== peer) {
      // A different browser page has tried to join with an already-active
      // character token. Keep the owner online and let the new client create a
      // tab-scoped demo character. Replacing the owner here caused two tabs to
      // continually evict each other and made multiplayer appear offline.
      if (replaced.resumeToken === peer.resumeToken && replaced.sessionId !== peer.sessionId) {
        send(peer.socket, { type: 'profile_in_use', code: 'profile_in_use' });
        return;
      }
      const replacedId = replaced.id;
      send(replaced.socket, { type: 'session_replaced' });
      leave(replaced);
      peer.id = replacedId;
      try { replaced.socket.close(4005, 'session replaced'); } catch { /* ignore */ }
    }
    if (!replaced && room.size >= MAX_ROOM_PLAYERS) {
      send(peer.socket, { type: 'error', code: 'room_full' });
      peer.socket.close(4004, 'room full');
      return;
    }
    rooms.set(roomId, room);
    peer.roomId = roomId;
    peer.district = district.id;
    peer.name = boundedText(message.name, `Player ${peer.id.slice(0, 4)}`, 24);
    peer.profile = profileFor(peer.resumeToken);
    // Keep the public entity identity stable across a normal reconnect so
    // other clients update the existing remote ped instead of treating it as
    // a separate player that left and rejoined.
    peer.id = peer.profile.actorId;
    // A persisted dead profile has no active respawn timer after reconnecting.
    // Joining the room is a fresh spawn, so repair stale death state before
    // sanitizeState derives health/dead for the new peer session.
    if (peer.profile.health <= 0) {
      peer.profile.health = 100;
      peer.profile.armor = 0;
      peer.profile.updatedAt = new Date().toISOString();
      profileData[peer.resumeToken] = peer.profile;
      scheduleSave();
    }
    peer.respawnAt = 0;
    const joinedAt = Date.now();
    peer.state = sanitizeState(message.state, peer.profile);
    const persistedPosition = peer.profile.position;
    if (persistedPosition && isInDemoDistrict({ x: persistedPosition[0], y: persistedPosition[1] }, peer.district)) {
      [peer.state.x, peer.state.y, peer.state.feetZ] = peer.profile.position;
      const persistedInCity = Number(persistedPosition[0]) >= DEMO_CENTER.x - DEMO_HALF_SIZE
        && Number(persistedPosition[0]) <= DEMO_CENTER.x + DEMO_HALF_SIZE
        && Number(persistedPosition[1]) >= DEMO_CENTER.y - DEMO_HALF_SIZE
        && Number(persistedPosition[1]) <= DEMO_CENTER.y + DEMO_HALF_SIZE;
      if (!persistedInCity) {
        // A client restoring an expansion position may need to move it to a
        // verified road contact before its first state packet. Permit only
        // that initial bounded-world discontinuity.
        peer.allowTeleportUntil = joinedAt + 3_000;
        peer.lastAcceptedAt = joinedAt;
      }
    } else if (!isInDemoDistrict(peer.state, peer.district)) {
      resetStateToDemoSpawn(peer.state, peer.district);
      peer.profile.position = [peer.state.x, peer.state.y, peer.state.feetZ];
      profileData[peer.resumeToken] = peer.profile;
      scheduleSave();
    }
    peer.stateHistory = [{ at: joinedAt, state: { ...peer.state } }];
    room.set(peer.id, peer);
    addToSpatialGrid(room, peer);
    const nearby = scopedPeers(room, peer);
    const existing = nearby.map((other) => ({ id: other.id, name: other.name, state: other.state }));
    for (const other of nearby) {
      peer.scopedPeerIds.add(other.id);
      other.scopedPeerIds.add(peer.id);
    }
    sessions.set(peer.sessionId, peer);
    activeProfiles.set(peer.resumeToken, peer);
    send(peer.socket, { type: 'welcome', id: peer.id, room: roomId, peers: existing, profile: publicProfile(peer.profile), resumeToken: peer.resumeToken, state: peer.state, world: worldSnapshot(room, peer.state), pickups: pickupSnapshot(room, peer.state), doors: doorSnapshot(room), networkScopeRadius: NETWORK_SCOPE_RADIUS, adminCommands: ADMIN_COMMANDS_ENABLED });
    for (const other of nearby) send(other.socket, { type: 'peer_joined', id: peer.id, name: peer.name, state: peer.state });
  }

  function applyDamage(target, damage, source, eventId) {
    if (!target?.profile || target.profile.health <= 0) return null;
    let amount = Math.max(1, Math.min(100, Number(damage) || 1));
    const armorDamage = Math.min(target.profile.armor, amount);
    target.profile.armor -= armorDamage;
    amount -= armorDamage;
    target.profile.health = Math.max(0, target.profile.health - amount);
    target.state.health = target.profile.health;
    target.state.armor = target.profile.armor;
    target.state.dead = target.profile.health <= 0;
    if (target.state.dead) target.respawnAt = Date.now() + PLAYER_RESPAWN_MS;
    target.profile.updatedAt = new Date().toISOString();
      profileData[target.resumeToken] = target.profile;
    scheduleSave();
    send(target.socket, {
      type: 'player_state',
      profile: publicProfile(target.profile),
      state: target.state,
      damage: { amount: damage, armorDamage, source, eventId, dead: target.state.dead },
    });
    return { targetId: target.id, damage, armorDamage, health: target.profile.health, armor: target.profile.armor, dead: target.state.dead };
  }

  function sanitizeShotRay(attacker, action) {
    const expectedOrigin = [attacker.state.x, attacker.state.y, attacker.state.feetZ + 1.2];
    const suppliedOrigin = Array.isArray(action.origin) ? action.origin.slice(0, 3).map(Number) : [];
    const originValid = suppliedOrigin.length === 3
      && suppliedOrigin.every(Number.isFinite)
      && Math.hypot(...suppliedOrigin.map((value, index) => value - expectedOrigin[index])) <= SHOT_ORIGIN_TOLERANCE;
    const origin = originValid ? suppliedOrigin : expectedOrigin;
    const raw = Array.isArray(action.direction) ? action.direction : [];
    const length = Math.hypot(Number(raw[0]) || 0, Number(raw[1]) || 0, Number(raw[2]) || 0);
    if (length < 0.5) return null;
    return {
      origin,
      direction: raw.slice(0, 3).map((value) => (Number(value) || 0) / length),
      maxDistance: finite(action.maxDistance, 90, 0.1, 90),
    };
  }

  function rayTarget(room, attacker, ray, now) {
    const { origin, direction: dir, maxDistance } = ray;
    let winner = null;
    let winnerDistance = maxDistance;
    for (const candidate of room.values()) {
      if (candidate === attacker || !candidate.state || candidate.state.dead) continue;
      const states = [candidate.state, ...(candidate.stateHistory || [])
        .filter((entry) => now - entry.at <= SHOT_HISTORY_MS)
        .map((entry) => entry.state)];
      for (const state of states) {
        const center = [state.x, state.y, state.feetZ + 1.0];
        const to = center.map((value, index) => value - origin[index]);
        const along = to[0] * dir[0] + to[1] * dir[1] + to[2] * dir[2];
        if (along <= SHOT_MIN_TARGET_DISTANCE || along >= winnerDistance) continue;
        const closestSq = to.reduce((sum, value) => sum + value * value, 0) - along * along;
        if (closestSq <= 0.82 * 0.82) { winner = candidate; winnerDistance = along; }
      }
    }
    return winner ? { target: winner, distance: winnerDistance } : null;
  }

  function rayNpc(room, ray, now = Date.now()) {
    const { origin, direction: dir, maxDistance } = ray;
    let winner = null;
    let winnerDistance = maxDistance;
    let winnerZone = 'torso';
    for (const npc of room.world?.npcs || []) {
      if (npc.state === 'dead') continue;
      const positions = [npc, ...(npc.positionHistory || []).filter((entry) => now - entry.at <= SHOT_HISTORY_MS)];
      for (const position of positions) {
        const zones = [
          { name: 'head', z: 1.56, radius: 0.28 },
          { name: 'torso', z: 1.10, radius: 0.52 },
          { name: 'torso', z: 0.68, radius: 0.42 },
        ];
        for (const zone of zones) {
          const to = [position.x - origin[0], position.y - origin[1], position.feetZ + zone.z - origin[2]];
          const along = to[0] * dir[0] + to[1] * dir[1] + to[2] * dir[2];
          if (along <= SHOT_MIN_TARGET_DISTANCE || along >= winnerDistance) continue;
          const closestSq = to.reduce((sum, value) => sum + value * value, 0) - along * along;
          if (closestSq <= zone.radius * zone.radius) {
            winner = npc;
            winnerDistance = along;
            winnerZone = zone.name;
          }
        }
      }
    }
    return winner ? { npc: winner, distance: winnerDistance, zone: winnerZone } : null;
  }

  function validatedClaimedNpc(room, ray, action, now = Date.now()) {
    const npcId = boundedText(action.npcId, '', 72);
    const rawPoint = Array.isArray(action.impactPoint) ? action.impactPoint.slice(0, 3).map(Number) : [];
    if (!npcId || rawPoint.length !== 3 || !rawPoint.every(Number.isFinite)) return null;
    const npc = room.world?.npcs?.find((candidate) => candidate.id === npcId && candidate.state !== 'dead');
    if (!npc) return null;

    const zone = action.zone === 'head' ? 'head' : 'torso';
    const zoneHeight = zone === 'head' ? 1.56 : 1.10;
    const zoneRadius = zone === 'head' ? 0.28 : 0.52;
    const toPoint = rawPoint.map((value, index) => value - ray.origin[index]);
    const along = toPoint[0] * ray.direction[0] + toPoint[1] * ray.direction[1] + toPoint[2] * ray.direction[2];
    const pointDistanceSq = toPoint.reduce((sum, value) => sum + value * value, 0);
    const offRaySq = Math.max(0, pointDistanceSq - along * along);
    if (along <= 0 || along > ray.maxDistance + 0.1 || offRaySq > 0.12 * 0.12) return null;

    const positions = [npc, ...(npc.positionHistory || []).filter((entry) => now - entry.at <= SHOT_HISTORY_MS)];
    const position = positions.find((candidate) => (
      Math.hypot(rawPoint[0] - candidate.x, rawPoint[1] - candidate.y) <= zoneRadius + 0.18
      && Math.abs((rawPoint[2] - zoneHeight) - candidate.feetZ) <= SHOT_NPC_GROUND_TOLERANCE
    ));
    return position ? { npc, distance: along, zone, groundReconciled: true } : null;
  }

  function reportWorldCrime(room, peer, severity) {
    const world = room.world;
    const level = Math.max(Number(world.wanted.get(peer.id)?.level) || 0, severity);
    world.wanted.set(peer.id, { level: Math.min(5, level), expiresAt: Date.now() + 30_000 + level * 8_000 });
    for (const npc of world.npcs) {
      if (npc.role !== 'civilian' || npc.state === 'dead') continue;
      if (Math.hypot(npc.x - peer.state.x, npc.y - peer.state.y) <= (severity >= 2 ? 38 : 18)) {
        npc.state = 'flee'; npc.fleeFrom = peer.id; npc.hostileTo = '';
      }
    }
  }

  function retirePoliceFor(world, playerId, now) {
    for (const npc of world.npcs) {
      if (npc.role !== 'police' || npc.hostileTo !== playerId || npc.state === 'dead') continue;
      npc.hostileTo = '';
      npc.state = 'retiring';
      npc.retireAt = now + POLICE_RETIRE_MS;
    }
  }

  function applyNpcDamage(room, npc, damage, peer, eventId) {
    npc.health = Math.max(0, npc.health - Math.max(1, Math.min(100, Number(damage) || 1)));
    npc.state = npc.health <= 0 ? 'dead' : (npc.role === 'police' ? 'combat' : 'flee');
    npc.deadUntil = npc.health <= 0 ? Date.now() + 15_000 : 0;
    npc.fleeFrom = npc.role === 'police' ? '' : peer.id;
    if (npc.role === 'police' && npc.health > 0) npc.hostileTo = peer.id;
    reportWorldCrime(room, peer, damage >= 38 ? 2 : 1);
    return { npcId: npc.id, damage, health: npc.health, dead: npc.health <= 0, eventId };
  }

  function handleAction(peer, message) {
    const room = rooms.get(peer.roomId);
    if (!room || !peer.profile) return;
    const action = message.action && typeof message.action === 'object' ? message.action : {};
    const kind = String(action.kind || '');
    // Recovery travel must remain available when a persisted/runtime death
    // state would otherwise reject every gameplay action without feedback.
    if (peer.profile.health <= 0 && kind !== 'destination_teleport') return;
    const eventId = boundedText(action.eventId, randomUUID(), 72);
    if (peer.eventIds.has(eventId)) return;
    peer.eventIds.add(eventId);
    if (peer.eventIds.size > 128) peer.eventIds.delete(peer.eventIds.values().next().value);
    const now = Date.now();
    let result = null;
    const isBankAction = kind.startsWith('bank_');
    if (isBankAction) {
      result = handleBankAction(room, peer, action);
    } else if (kind === 'destination_teleport') {
      const destination = DEMO_DESTINATION_TELEPORTS[String(action.destination || '').trim().toLowerCase()];
      if (!destination || !isInDemoDistrict(destination, destination.district)) return;
      peer.district = destination.district;
      peer.state.x = destination.x; peer.state.y = destination.y; peer.state.feetZ = destination.z;
      peer.profile.health = 100;
      peer.state.health = 100;
      peer.state.dead = false;
      peer.respawnAt = 0;
      peer.profile.position = [destination.x, destination.y, destination.z];
      peer.allowTeleportUntil = now + 3_000;
      peer.lastAcceptedAt = now;
      peer.stateHistory = [{ at: now, state: { ...peer.state } }];
      addToSpatialGrid(room, peer);
      reconcilePeerScope(room, peer);
      result = {
        success: true,
        destination: String(action.destination).trim().toLowerCase(),
        district: destination.district,
        label: destination.label,
        x: destination.x,
        y: destination.y,
        z: destination.z,
        halfSize: destination.halfSize,
        returnToLegion: destination.returnToLegion === true,
      };
    } else if (kind === 'shoot') {
      if (now - peer.lastShotAt < 80) {
        result = { success: false, reason: 'rate_limited', ammo: peer.profile.inventory.pistol_ammo };
      } else if (peer.profile.inventory.pistol_ammo <= 0) {
        result = { success: false, reason: 'no_ammo', ammo: 0 };
      } else {
        const ray = sanitizeShotRay(peer, action);
        if (!ray) {
          result = { success: false, reason: 'invalid_ray', ammo: peer.profile.inventory.pistol_ammo };
        } else {
          peer.lastShotAt = now;
          peer.profile.inventory.pistol_ammo--;
          const target = rayTarget(room, peer, ray, now);
          const directNpcTarget = rayNpc(room, ray, now);
          const npcTarget = directNpcTarget || validatedClaimedNpc(room, ray, action, now);
          const npcWins = !!npcTarget && (!target || npcTarget.distance < target.distance);
          const damage = npcTarget?.zone === 'head' ? 100 : PISTOL_DAMAGE;
          const impact = npcWins
            ? applyNpcDamage(room, npcTarget.npc, damage, peer, eventId)
            : target ? applyDamage(target.target, PISTOL_DAMAGE, peer.id, eventId) : null;
          result = {
            success: true,
            hit: !!impact,
            zone: npcWins ? npcTarget.zone : null,
            groundReconciled: npcWins && npcTarget.groundReconciled === true,
            ammo: peer.profile.inventory.pistol_ammo,
            ...(impact || {}),
          };
          reportWorldCrime(room, peer, 2);
          peer.state.weaponAction = 'fire';
          peer.state.weaponActionSerial++;
          peer.state.weaponFiring = true;
        }
      }
    } else if (kind === 'melee') {
      if (now - peer.lastMeleeAt < 300) return;
      peer.lastMeleeAt = now;
      const targetEntry = Array.from(room.values()).filter((candidate) => candidate !== peer && !candidate.state?.dead)
        .map((candidate) => ({ candidate, distance: Math.hypot(candidate.state.x - peer.state.x, candidate.state.y - peer.state.y) }))
        .filter((entry) => entry.distance <= 2.4).sort((a, b) => a.distance - b.distance)[0] || null;
      const npcEntry = (room.world?.npcs || []).filter((npc) => npc.state !== 'dead')
        .map((npc) => ({ npc, distance: Math.hypot(npc.x - peer.state.x, npc.y - peer.state.y) }))
        .filter((entry) => entry.distance <= 2.4).sort((a, b) => a.distance - b.distance)[0] || null;
      const meleeDamage = action.attackType === 'front_kick' ? 32 : MELEE_DAMAGE;
      result = targetEntry && (!npcEntry || targetEntry.distance <= npcEntry.distance)
        ? applyDamage(targetEntry.candidate, meleeDamage, peer.id, eventId)
        : npcEntry ? applyNpcDamage(room, npcEntry.npc, meleeDamage, peer, eventId) : null;
      peer.state.meleeAction = boundedText(action.attackType, 'punch', 24);
      peer.state.meleeActionSerial++;
    } else if (kind === 'appearance') {
      peer.profile.appearance = sanitizeAppearance(action.appearance);
      peer.state.appearance = peer.profile.appearance;
    } else if (kind === 'vehicle_damage') {
      const vehicle = peer.profile.ownedVehicles.find((entry) => entry.id === action.vehicleId) || peer.profile.ownedVehicles[0];
      if (vehicle) vehicle.damage = finite(vehicle.damage + finite(action.amount, 0, 0, 150), vehicle.damage, 0, 1000);
    } else if (kind === 'collect_pickup') {
      const pickup = room.world?.pickups?.find((entry) => entry.id === String(action.pickupId || ''));
      if (!pickup || now < pickup.availableAt || Math.hypot(pickup.x - peer.state.x, pickup.y - peer.state.y, pickup.feetZ - peer.state.feetZ) > 2.5) return;
      if (pickup.type === 'armor') peer.profile.armor = Math.min(100, peer.profile.armor + pickup.amount);
      else if (pickup.type === 'ammo') peer.profile.inventory.pistol_ammo = Math.min(5000, peer.profile.inventory.pistol_ammo + pickup.amount);
      else if (pickup.type === 'cash') peer.profile.money = Math.min(10_000_000, peer.profile.money + pickup.amount);
      else if (pickup.type === 'coca_leaves') {
        const minAmount = Math.max(1, Math.floor(Number(pickup.minAmount) || 1));
        const maxAmount = Math.max(minAmount, Math.floor(Number(pickup.maxAmount) || minAmount));
        pickup.amount = minAmount + Math.floor(Math.random() * (maxAmount - minAmount + 1));
        peer.profile.inventory.coca_leaves = Math.min(5000, (peer.profile.inventory.coca_leaves || 0) + pickup.amount);
      }
      else return;
      peer.state.armor = peer.profile.armor;
      pickup.availableAt = now + Math.max(1_000, Number(pickup.respawnMs) || 30_000);
      result = { pickupId: pickup.id, type: pickup.type, amount: pickup.amount };
    } else if (kind === 'door_toggle') {
      const definition = demoDoors.byId.get(String(action.doorId || ''));
      const door = definition ? room.world?.doors?.get(definition.id) : null;
      if (!definition || !door || definition.locked) return;
      const distance = Math.hypot(
        finite(peer.state?.x) - definition.x,
        finite(peer.state?.y) - definition.y,
        finite(peer.state?.feetZ) - definition.z,
      );
      if (distance > definition.radius + 1.25) return;
      const open = action.open === true;
      if (action.automatic === true && !open) return;
      const changed = door.open !== open;
      door.open = open;
      door.updatedAt = now;
      door.closeAt = open && definition.automatic ? now + Math.max(900, definition.autoCloseMs) : 0;
      result = { doorId: door.id, id: door.id, open: door.open, updatedAt: door.updatedAt };
      if (changed) broadcast(room, { type: 'door_state', ...result });
    } else {
      return;
    }
    peer.profile.updatedAt = new Date().toISOString();
    profileData[peer.resumeToken] = peer.profile;
    scheduleSave();
    const payload = { type: 'gameplay_event', id: peer.id, eventId, kind, result, state: peer.state };
    if (isBankAction) {
      if (result?.success) refreshBankProfiles(room);
    } else {
      broadcastScoped(room, peer, payload, peer.socket);
    }
    send(peer.socket, { ...payload, profile: publicProfile(peer.profile) });
  }

  function handleAdminCommand(peer, message) {
    if (!ADMIN_COMMANDS_ENABLED || !peer.roomId || !peer.profile || !peer.state) {
      send(peer.socket, { type: 'admin_result', command: String(message?.command || ''), result: { success: false, message: 'Admin commands are disabled' } });
      return;
    }
    const command = String(message.command || '').trim().toLowerCase();
    const args = message.args && typeof message.args === 'object' ? message.args : {};
    let result = { success: false, message: `Unknown admin command: ${command}` };
    if (command === 'teleport') {
      const x = Number(args.x); const y = Number(args.y); const z = Number(args.z);
      const district = demoDistrict(peer.district);
      const withinDistrict = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
        && x >= district.center.x - district.halfSize && x <= district.center.x + district.halfSize
        && y >= district.center.y - district.halfSize && y <= district.center.y + district.halfSize
        && z >= -100 && z <= 1000;
      if (withinDistrict) {
        peer.state.x = x; peer.state.y = y; peer.state.feetZ = z;
        peer.profile.position = [x, y, z];
        peer.allowTeleportUntil = Date.now() + 3_000;
        result = { success: true, message: `Teleported to ${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}` };
      } else result = { success: false, message: 'Teleport coordinates must be inside the demo district' };
    } else if (command === 'noclip') {
      peer.adminNoclip = args.enabled === true;
      peer.allowTeleportUntil = Date.now() + 3_000;
      result = { success: true, enabled: peer.adminNoclip, message: `Noclip ${peer.adminNoclip ? 'enabled' : 'disabled'}` };
    } else if (command === 'money') {
      const amount = Math.floor(Number(args.amount));
      if (Number.isSafeInteger(amount) && amount > 0 && amount <= ADMIN_MAX_MONEY_GRANT) {
        peer.profile.money = Math.min(10_000_000, peer.profile.money + amount);
        result = { success: true, amount, message: `Added $${amount.toLocaleString()}` };
      } else result = { success: false, message: `Money amount must be between 1 and ${ADMIN_MAX_MONEY_GRANT.toLocaleString()}` };
    } else if (command === 'heal') {
      peer.profile.health = 100; peer.state.health = 100; peer.state.dead = false; peer.respawnAt = 0;
      result = { success: true, message: 'Health restored' };
    } else if (command === 'armor') {
      const amount = Math.floor(Number(args.amount ?? 100));
      if (Number.isSafeInteger(amount) && amount >= 1 && amount <= 100) {
        peer.profile.armor = amount; peer.state.armor = amount;
        result = { success: true, amount, message: `Armor set to ${amount}` };
      } else result = { success: false, message: 'Armor must be between 1 and 100' };
    } else if (command === 'spawn') {
      const aliases = {
        ammo: 'pistol_ammo', pistol_ammo: 'pistol_ammo',
        pistol: 'weapon_glock17', glock: 'weapon_glock17', weapon_glock17: 'weapon_glock17',
        switch: 'glockswitch', glockswitch: 'glockswitch',
        armor: 'armor', armour: 'armor', cash: 'cash', money: 'cash', laptop: 'laptop',
      };
      const item = aliases[String(args.item || '').trim().toLowerCase()] || '';
      const amount = Math.floor(Number(args.amount ?? 1));
      if (!item || !Number.isSafeInteger(amount) || amount <= 0 || amount > 5000) {
        result = { success: false, message: 'Items: pistol, ammo, glockswitch, armor, cash, laptop' };
      } else if (item === 'weapon_glock17') {
        peer.profile.inventory.weapon_glock17 = 1;
        result = { success: true, item, amount: 1, message: 'Glock-17 added' };
      } else if (item === 'pistol_ammo') {
        peer.profile.inventory.pistol_ammo = Math.min(5000, peer.profile.inventory.pistol_ammo + amount);
        result = { success: true, item, amount, message: `Added ${amount} pistol ammo` };
      } else if (item === 'glockswitch') {
        peer.profile.inventory.glockswitch = Math.min(20, peer.profile.inventory.glockswitch + amount);
        result = { success: true, item, amount, message: `Added ${amount} Glock switch${amount === 1 ? '' : 'es'}` };
      } else if (item === 'armor') {
        peer.profile.armor = Math.min(100, peer.profile.armor + amount); peer.state.armor = peer.profile.armor;
        result = { success: true, item, amount, message: `Added ${amount} armor` };
      } else if (item === 'cash') {
        const grant = Math.min(amount, ADMIN_MAX_MONEY_GRANT);
        peer.profile.money = Math.min(10_000_000, peer.profile.money + grant);
        result = { success: true, item, amount: grant, message: `Added $${grant.toLocaleString()}` };
      } else if (item === 'laptop') {
        peer.profile.inventory.laptop = Math.min(100, peer.profile.inventory.laptop + amount);
        result = { success: true, item, amount, message: `Added ${amount} laptop${amount === 1 ? '' : 's'}` };
      }
    }
    if (result.success) {
      peer.profile.position = [peer.state.x, peer.state.y, peer.state.feetZ];
      peer.profile.updatedAt = new Date().toISOString();
      profileData[peer.resumeToken] = peer.profile;
      scheduleSave();
    }
    send(peer.socket, { type: 'admin_result', command, result, profile: publicProfile(peer.profile), state: peer.state });
  }

  function handleTrackTeleport(peer, expansionId = 'nordschleife') {
    if (!peer.roomId || !peer.profile || !peer.state) {
      send(peer.socket, { type: 'track_teleport_result', result: { success: false, message: 'Track teleport is unavailable before joining the demo' } });
      return;
    }
    const room = rooms.get(peer.roomId);
    if (!room) {
      send(peer.socket, { type: 'track_teleport_result', result: { success: false, message: 'Demo room is unavailable' } });
      return;
    }
    const expansion = WORLD_EXPANSIONS[String(expansionId || '').trim().toLowerCase()];
    if (!expansion) {
      send(peer.socket, { type: 'track_teleport_result', result: { success: false, message: 'Requested expansion is unavailable' } });
      return;
    }
    const now = Date.now();
    peer.state.x = expansion.spawn.x;
    peer.state.y = expansion.spawn.y;
    peer.state.feetZ = expansion.spawn.feetZ;
    peer.state.heading = Number(expansion.spawn.heading) || 0;
    if (peer.state.inVehicle && peer.state.vehicle) {
      peer.state.vehicle.x = peer.state.x;
      peer.state.vehicle.y = peer.state.y;
      peer.state.vehicle.z = peer.state.feetZ;
      peer.state.vehicle.heading = peer.state.heading;
      peer.state.vehicle.speed = 0;
    }
    peer.profile.position = [peer.state.x, peer.state.y, peer.state.feetZ];
    // The next client state can arrive before the client has rendered the
    // authoritative response. Allow that one discontinuity, then normal speed
    // and region checks resume on the track.
    peer.allowTeleportUntil = now + 3_000;
    peer.lastAcceptedAt = now;
    peer.stateHistory = [{ at: now, state: { ...peer.state } }];
    addToSpatialGrid(room, peer);
    reconcilePeerScope(room, peer);
    peer.profile.updatedAt = new Date(now).toISOString();
    profileData[peer.resumeToken] = peer.profile;
    scheduleSave();
    send(peer.socket, {
      type: 'track_teleport_result',
      result: {
        success: true, message: 'Teleported to the Nurburgring road',
        expansion: {
          id: expansion.id, label: expansion.label, bounds: expansion.bounds,
          isolateCityWorld: expansion.isolateCityWorld,
        },
      },
      state: peer.state,
    });
    broadcastScoped(room, peer, { type: 'peer_state', id: peer.id, state: peer.state }, peer.socket);
  }

  function onConnection(socket) {
    const peer = { id: randomUUID(), sessionId: '', resumeToken: '', characterAccount: '', name: '', roomId: '', state: null, stateHistory: [], profile: null, socket, lastStateAt: 0, lastChatAt: 0, lastAcceptedAt: Date.now(), lastShotAt: 0, lastMeleeAt: 0, respawnAt: 0, allowTeleportUntil: 0, adminNoclip: false, eventIds: new Set(), scopedPeerIds: new Set(), spatialCell: '' };
    socket.on('message', (data) => {
      if (data.length > MAX_MESSAGE_BYTES) {
        socket.close(1009, 'message too large');
        return;
      }
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (String(message?.type || '').startsWith('character_')) {
        handleCharacterMessage(peer, message);
        return;
      }
      if (message?.type === 'join') {
        join(peer, message);
        return;
      }
      if (message?.type === 'voice_signal' && peer.roomId) {
        const targetId = String(message.target || '');
        const room = rooms.get(peer.roomId);
        const target = room?.get(targetId);
        const signal = sanitizeVoiceSignal(message.signal);
        if (target && target !== peer && peer.scopedPeerIds.has(target.id) && signal) {
          send(target.socket, { type: 'voice_signal', from: peer.id, signal });
        }
        return;
      }
      if (message?.type === 'chat' && peer.roomId) {
        const now = Date.now();
        const text = sanitizeChatText(message.text);
        if (!text || now - peer.lastChatAt < 700) return;
        peer.lastChatAt = now;
        const room = rooms.get(peer.roomId);
        if (room) broadcast(room, { type: 'chat', id: peer.id, name: peer.name, text, time: now });
        return;
      }
      if (message?.type === 'action' && peer.roomId) {
        handleAction(peer, message);
        return;
      }
      if (message?.type === 'track_teleport' && peer.roomId) {
        handleTrackTeleport(peer, message.expansionId);
        return;
      }
      if (message?.type === 'admin_command' && peer.roomId) {
        handleAdminCommand(peer, message);
        return;
      }
      if (message?.type !== 'state' || !peer.roomId) return;
      const now = Date.now();
      if (now - peer.lastStateAt < MIN_STATE_INTERVAL_MS) return;
      peer.lastStateAt = now;
      const room = rooms.get(peer.roomId);
      if (!room) return;
      const next = sanitizeState(message.state, peer.profile);
      const elapsed = Math.max(0.03, Math.min(2, (now - peer.lastAcceptedAt) / 1000 || 0.066));
      const maxSpeed = next.inVehicle ? 65 : (next.gait === 'sprint' ? 10 : 6);
      const distance = Math.hypot(next.x - peer.state.x, next.y - peer.state.y, next.feetZ - peer.state.feetZ);
      const outsideDemo = !isInDemoDistrict(next, peer.district);
      if (outsideDemo && !peer.adminNoclip) {
        // Never echo an invalid transform back to a client that has already
        // escaped its bounded demo region. Recover to a known playable spawn
        // and explicitly dismount, so the authoritative correction cannot
        // leave a ped or vehicle parked on a boundary edge.
        resetStateToDemoSpawn(next, peer.district);
        next.inVehicle = false;
        next.vehicle = null;
        peer.allowTeleportUntil = now + 3_000;
        send(peer.socket, { type: 'state_correction', state: next, reason: 'demo_bounds_recovery' });
      } else if (distance > maxSpeed * elapsed + 2.5 && now > peer.allowTeleportUntil && !peer.adminNoclip) {
        next.x = peer.state.x; next.y = peer.state.y; next.feetZ = peer.state.feetZ;
        send(peer.socket, { type: 'state_correction', state: next });
      }
      peer.lastAcceptedAt = now;
      peer.state = next;
      addToSpatialGrid(room, peer);
      const nearby = reconcilePeerScope(room, peer);
      peer.stateHistory.push({ at: now, state: next });
      peer.stateHistory = peer.stateHistory.filter((entry) => now - entry.at <= SHOT_HISTORY_MS);
      peer.profile.position = [next.x, next.y, next.feetZ];
      const outboundState = { ...peer.state };
      delete outboundState.appearance;
      const encodedState = JSON.stringify({ type: 'peer_state', id: peer.id, state: outboundState });
      for (const other of nearby) send(other.socket, encodedState);
    });
    socket.on('close', () => leave(peer));
    socket.on('error', () => leave(peer));
  }

  let previousSimulationAt = Date.now();
  const simulation = setInterval(() => {
    const now = Date.now();
    const simulationStep = Math.max(0.01, Math.min(0.1, (now - previousSimulationAt) / 1000));
    previousSimulationAt = now;
    for (const room of rooms.values()) {
      const world = room.world;
      for (const door of world.doors?.values?.() || []) {
        if (!door.open || !door.closeAt || now < door.closeAt) continue;
        door.open = false;
        door.closeAt = 0;
        door.updatedAt = now;
        broadcast(room, { type: 'door_state', id: door.id, doorId: door.id, open: false, updatedAt: now });
      }
      if (world) {
        for (const [playerId, wanted] of world.wanted) {
          const target = room.get(playerId);
          if (!target || target.state?.dead || now >= wanted.expiresAt) {
            world.wanted.delete(playerId);
            retirePoliceFor(world, playerId, now);
            continue;
          }
          const police = world.npcs.filter((npc) => npc.role === 'police' && npc.state !== 'dead' && npc.hostileTo === playerId);
          const totalPolice = world.npcs.filter((npc) => npc.role === 'police').length;
          if (police.length < Math.min(6, wanted.level * 2) && totalPolice < MAX_POLICE_NPCS) {
            const angle = ((world.policeSerial++ * 2.399) % (Math.PI * 2));
            const distance = 34;
            world.npcs.push({
              id: `police_${world.policeSerial}`, x: target.state.x + Math.cos(angle) * distance,
              y: target.state.y + Math.sin(angle) * distance, feetZ: target.state.feetZ,
              homeX: target.state.x, homeY: target.state.y, targetX: target.state.x, targetY: target.state.y,
              heading: angle + Math.PI, speed: 2.7, health: 100, state: 'hostile', role: 'police',
              modelHash: POLICE_PED_MODEL_HASH,
              hostileTo: playerId, fleeFrom: '', deadUntil: 0, retargetAt: 0, lastAttackAt: now + 900,
              retireAt: 0,
            });
          }
        }
        for (const npc of world.npcs) {
          if (npc.role !== 'police' || npc.state === 'dead' || !npc.hostileTo) continue;
          const target = room.get(npc.hostileTo);
          if (!world.wanted.has(npc.hostileTo) || !target || target.state?.dead) {
            retirePoliceFor(world, npc.hostileTo, now);
          }
        }
        for (let index = world.npcs.length - 1; index >= 0; index--) {
          const npc = world.npcs[index];
          if (npc.role === 'police' && npc.state === 'retiring') {
            if (now >= (npc.retireAt || 0)) world.npcs.splice(index, 1);
            continue;
          }
          if (npc.state === 'dead') {
            if (now < npc.deadUntil) continue;
            if (npc.role === 'police') { world.npcs.splice(index, 1); continue; }
            npc.health = 100; npc.state = 'wander'; npc.x = npc.homeX; npc.y = npc.homeY; npc.fleeFrom = '';
          }
          if (!Array.isArray(npc.positionHistory)) npc.positionHistory = [];
          npc.positionHistory.push({ at: now, x: npc.x, y: npc.y, feetZ: npc.feetZ });
          npc.positionHistory = npc.positionHistory.filter((entry) => now - entry.at <= SHOT_HISTORY_MS);
          let tx = npc.targetX;
          let ty = npc.targetY;
          let tz = npc.feetZ;
          let moveSpeed = npc.speed;
          if (npc.state === 'flee') {
            const threat = room.get(npc.fleeFrom);
            if (!threat || now - (npc.fleeStartedAt || (npc.fleeStartedAt = now)) > 14_000) {
              npc.state = 'wander'; npc.fleeFrom = ''; npc.fleeStartedAt = 0;
            } else {
              tx = npc.x + (npc.x - threat.state.x) * 2; ty = npc.y + (npc.y - threat.state.y) * 2; moveSpeed = 3.2;
            }
          } else if (npc.hostileTo) {
            const target = room.get(npc.hostileTo);
            if (!target || target.state.dead) {
              npc.hostileTo = '';
              npc.state = npc.role === 'police' ? 'retiring' : 'wander';
              if (npc.role === 'police') npc.retireAt = now + POLICE_RETIRE_MS;
            }
            else {
              tx = target.state.x; ty = target.state.y; moveSpeed = npc.role === 'police' ? 2.7 : 1.9;
              const distance = Math.hypot(tx - npc.x, ty - npc.y);
              if (npc.role === 'police' && distance < 17 && distance > 3 && now >= (npc.lastAttackAt || 0)) {
                npc.lastAttackAt = now + 900 + Math.random() * 500;
                applyDamage(target, 12, npc.id, `npc:${npc.id}:${now}`);
              }
            }
          } else if (!npc.navPath?.length && (now >= npc.retargetAt || Math.hypot(tx - npc.x, ty - npc.y) < 1)) {
            npc.retargetAt = now + 12000 + Math.random() * 8000;
            npc.navPath = chooseNpcRoute(npc);
            npc.navPathIndex = npc.navPath.length > 1 ? 1 : 0;
            const destination = npc.navPath[npc.navPathIndex];
            npc.targetX = destination ? Number(destination[0]) : npc.homeX + (Math.random() - 0.5) * 34;
            npc.targetY = destination ? Number(destination[1]) : npc.homeY + (Math.random() - 0.5) * 34;
            tx = npc.targetX; ty = npc.targetY;
          }
          if (!npc.hostileTo && npc.state !== 'flee' && npc.navPath?.length) {
            const waypoint = npc.navPath[npc.navPathIndex];
            if (waypoint && Math.hypot(Number(waypoint[0]) - npc.x, Number(waypoint[1]) - npc.y) < 0.75) {
              npc.navPathIndex++;
            }
            const nextWaypoint = npc.navPath[npc.navPathIndex];
            if (nextWaypoint) {
              tx = Number(nextWaypoint[0]); ty = Number(nextWaypoint[1]); tz = Number(nextWaypoint[2]);
              npc.targetX = tx; npc.targetY = ty;
            } else {
              npc.navPath = []; npc.retargetAt = 0;
            }
          }
          const dx = tx - npc.x; const dy = ty - npc.y; const distance = Math.hypot(dx, dy);
          if (distance > 0.05) {
            const district = world.district || DEMO_DISTRICTS.demo;
            npc.heading = Math.atan2(dy, dx);
            npc.x = Math.max(district.center.x - district.halfSize, Math.min(district.center.x + district.halfSize, npc.x + (dx / distance) * moveSpeed * simulationStep));
            npc.y = Math.max(district.center.y - district.halfSize, Math.min(district.center.y + district.halfSize, npc.y + (dy / distance) * moveSpeed * simulationStep));
            npc.feetZ += (tz - npc.feetZ) * Math.min(1, (moveSpeed * simulationStep) / distance);
          }
        }
        if (now - world.lastSnapshotAt >= WORLD_SNAPSHOT_INTERVAL_MS) {
          world.lastSnapshotAt = now;
          world.sequence++;
          for (const peer of room.values()) {
            send(peer.socket, {
              type: 'world_state',
              sequence: world.sequence,
              serverTime: now,
              npcs: worldSnapshot(room, peer.state),
              pickups: pickupSnapshot(room, peer.state),
              wanted: world.wanted.has(peer.id) ? [{ id: peer.id, level: world.wanted.get(peer.id).level }] : [],
              networkScopeRadius: NETWORK_SCOPE_RADIUS,
            });
          }
        }
      }
      for (const peer of room.values()) {
      if (!peer.respawnAt || now < peer.respawnAt) continue;
      peer.respawnAt = 0;
      peer.allowTeleportUntil = now + 2_000;
      peer.profile.health = 100;
      peer.profile.armor = 0;
      peer.state.health = 100;
      peer.state.armor = 0;
      peer.state.dead = false;
      if (peer.profile.position) [peer.state.x, peer.state.y, peer.state.feetZ] = peer.profile.position;
      send(peer.socket, { type: 'player_state', profile: publicProfile(peer.profile), state: peer.state, respawn: true });
      broadcastScoped(room, peer, { type: 'peer_state', id: peer.id, state: peer.state }, peer.socket);
      scheduleSave();
      }
    }
  }, WORLD_SIMULATION_INTERVAL_MS);
  simulation.unref?.();

  return { rooms, sessions, onConnection, close: () => { clearInterval(simulation); clearTimeout(saveTimer); clearTimeout(characterSaveTimer); } };
}

export function installMultiplayerServer(httpServer) {
  if (!httpServer || httpServer.__webglGtaMultiplayer) return httpServer?.__webglGtaMultiplayer || null;
  const hub = createMultiplayerHub();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  httpServer.__webglGtaMultiplayer = { hub, sockets };
  httpServer.on('upgrade', (request, socket, head) => {
    let pathname = '';
    try { pathname = new URL(request.url || '/', 'http://localhost').pathname; } catch { return; }
    if (pathname !== SOCKET_PATH) return;
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      sockets.emit('connection', webSocket, request);
    });
  });
  sockets.on('connection', hub.onConnection);
  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      const peerAlive = socket.isAlive !== false;
      if (!peerAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.once('pong', () => { socket.isAlive = true; });
      socket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  httpServer.once('close', () => {
    clearInterval(heartbeat);
    hub.close?.();
    sockets.close();
  });
  return httpServer.__webglGtaMultiplayer;
}
