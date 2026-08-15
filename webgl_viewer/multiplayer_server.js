import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

const SOCKET_PATH = '/__multiplayer';
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_ROOM_PLAYERS = 32;
const HEARTBEAT_MS = 5_000;
const MIN_STATE_INTERVAL_MS = 30;
const DEMO_ROOM = 'demo';
const PROFILE_FILE = process.env.WEBGLGTA_PROFILE_FILE || path.resolve('data', 'multiplayer_profiles.json');
const PLAYER_RESPAWN_MS = 5_000;
const PISTOL_DAMAGE = 38;
const MELEE_DAMAGE = 20;
const MAX_POLICE_NPCS = 12;
const POLICE_RETIRE_MS = 5_000;

function boundedText(value, fallback, maxLength) {
  const clean = String(value || '').trim().replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, maxLength);
  return clean || fallback;
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

function defaultProfile(sessionId = '') {
  return {
    sessionId,
    health: 100,
    armor: 0,
    money: 2500,
    inventory: { weapon_glock17: 1, pistol_ammo: 68, glockswitch: 1 },
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
    health: finite(source.health, 100, 0, 100),
    armor: finite(source.armor, 0, 0, 100),
    money: finite(source.money, 2500, 0, 10_000_000) | 0,
    inventory: {
      weapon_glock17: finite(source.inventory?.weapon_glock17, 1, 0, 1) | 0,
      pistol_ammo: finite(source.inventory?.pistol_ammo, 68, 0, 5000) | 0,
      glockswitch: finite(source.inventory?.glockswitch, 1, 0, 20) | 0,
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
  let profileData = {};
  let saveTimer = null;
  try { profileData = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')) || {}; } catch { profileData = {}; }

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

  function profileFor(sessionId) {
    const profile = sanitizeProfile(profileData[sessionId], sessionId);
    profileData[sessionId] = profile;
    return profile;
  }

  function createWorld() {
    const offsets = [[14, 8], [-15, 6], [23, -15], [-20, -18], [8, 28], [-27, 19]];
    return {
      wanted: new Map(),
      policeSerial: 0,
      pickups: [
        { id: 'pickup_armor_1', type: 'armor', x: 193.5, y: -846.5, feetZ: 31.17, amount: 50, availableAt: 0 },
        { id: 'pickup_ammo_1', type: 'ammo', x: 180.5, y: -845.0, feetZ: 31.17, amount: 24, availableAt: 0 },
        { id: 'pickup_cash_1', type: 'cash', x: 187.0, y: -860.0, feetZ: 31.17, amount: 500, availableAt: 0 },
      ],
      npcs: offsets.map(([dx, dy], index) => ({
        id: `ambient_${index + 1}`, x: 186.94 + dx, y: -850.84 + dy, feetZ: 31.17,
        homeX: 186.94 + dx, homeY: -850.84 + dy, targetX: 186.94 - dx * 0.5, targetY: -850.84 - dy * 0.5,
        heading: 0, speed: 1.1 + (index % 3) * 0.12, health: 100, state: 'wander', role: 'civilian',
        hostileTo: '', fleeFrom: '', deadUntil: 0, retargetAt: Date.now() + 2000 + index * 400,
      })),
    };
  }

  function worldSnapshot(room) {
    return room.world?.npcs?.map((npc) => ({
      id: npc.id, x: npc.x, y: npc.y, feetZ: npc.feetZ, heading: npc.heading,
      health: npc.health, maxHealth: 100, state: npc.state, role: npc.role,
      hostile: !!npc.hostileTo, weapon: npc.role === 'police' && npc.hostileTo ? 'pistol' : '',
    })) || [];
  }

  function pickupSnapshot(room) {
    const now = Date.now();
    return room.world?.pickups?.map((pickup) => ({
      id: pickup.id, type: pickup.type, x: pickup.x, y: pickup.y, feetZ: pickup.feetZ,
      amount: pickup.amount, available: now >= pickup.availableAt,
    })) || [];
  }

  function send(socket, payload) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  function broadcast(room, payload, except = null) {
    for (const peer of room.values()) {
      if (peer.socket !== except) send(peer.socket, payload);
    }
  }

  function leave(peer) {
    if (!peer.roomId) return;
    const roomId = peer.roomId;
    const room = rooms.get(roomId);
    peer.roomId = '';
    if (peer.sessionId && sessions.get(peer.sessionId) === peer) sessions.delete(peer.sessionId);
    if (!room || !room.delete(peer.id)) return;
    if (peer.profile && peer.state) {
      peer.profile.position = [peer.state.x, peer.state.y, peer.state.feetZ];
      peer.profile.updatedAt = new Date().toISOString();
      profileData[peer.resumeToken] = peer.profile;
      scheduleSave();
    }
    broadcast(room, { type: 'peer_left', id: peer.id });
    if (!room.size) rooms.delete(roomId);
  }

  function join(peer, message) {
    leave(peer);
    const roomId = DEMO_ROOM;
    const room = rooms.get(roomId) || new Map();
    if (!room.world) room.world = createWorld();
    peer.sessionId = boundedText(message.sessionId, peer.id, 64).replace(/ /g, '-');
    const suppliedToken = String(message.resumeToken || '').trim();
    peer.resumeToken = /^[a-f0-9-]{32,64}$/i.test(suppliedToken) ? suppliedToken : randomUUID();
    const replaced = sessions.get(peer.sessionId);
    if (replaced && replaced !== peer) {
      const oldRoomId = replaced.roomId;
      const oldRoom = rooms.get(oldRoomId);
      if (oldRoom?.get(replaced.id) === replaced) oldRoom.delete(replaced.id);
      if (oldRoom && !oldRoom.size) rooms.delete(oldRoomId);
      replaced.roomId = '';
      peer.id = replaced.id;
      try { replaced.socket.terminate(); } catch { /* ignore */ }
    }
    if (!replaced && room.size >= MAX_ROOM_PLAYERS) {
      send(peer.socket, { type: 'error', code: 'room_full' });
      peer.socket.close(4004, 'room full');
      return;
    }
    rooms.set(roomId, room);
    peer.roomId = roomId;
    peer.name = boundedText(message.name, `Player ${peer.id.slice(0, 4)}`, 24);
    peer.profile = profileFor(peer.resumeToken);
    peer.state = sanitizeState(message.state, peer.profile);
    if (peer.profile.position) {
      [peer.state.x, peer.state.y, peer.state.feetZ] = peer.profile.position;
    }
    const existing = Array.from(room.values()).map((other) => ({
      id: other.id, name: other.name, state: other.state,
    }));
    room.set(peer.id, peer);
    sessions.set(peer.sessionId, peer);
    send(peer.socket, { type: 'welcome', id: peer.id, room: roomId, peers: existing, profile: peer.profile, resumeToken: peer.resumeToken, state: peer.state, world: worldSnapshot(room), pickups: pickupSnapshot(room) });
    broadcast(room, { type: 'peer_joined', id: peer.id, name: peer.name, state: peer.state }, peer.socket);
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
      profile: target.profile,
      state: target.state,
      damage: { amount: damage, armorDamage, source, eventId, dead: target.state.dead },
    });
    return { targetId: target.id, damage, armorDamage, health: target.profile.health, armor: target.profile.armor, dead: target.state.dead };
  }

  function rayTarget(room, attacker, direction) {
    const origin = [attacker.state.x, attacker.state.y, attacker.state.feetZ + 1.35];
    const raw = Array.isArray(direction) ? direction : [];
    const length = Math.hypot(Number(raw[0]) || 0, Number(raw[1]) || 0, Number(raw[2]) || 0);
    if (length < 0.5) return null;
    const dir = raw.slice(0, 3).map((value) => (Number(value) || 0) / length);
    let winner = null;
    let winnerDistance = 90;
    for (const candidate of room.values()) {
      if (candidate === attacker || !candidate.state || candidate.state.dead) continue;
      const center = [candidate.state.x, candidate.state.y, candidate.state.feetZ + 1.0];
      const to = center.map((value, index) => value - origin[index]);
      const along = to[0] * dir[0] + to[1] * dir[1] + to[2] * dir[2];
      if (along <= 0 || along >= winnerDistance) continue;
      const closestSq = to.reduce((sum, value) => sum + value * value, 0) - along * along;
      if (closestSq <= 0.75 * 0.75) { winner = candidate; winnerDistance = along; }
    }
    return winner;
  }

  function rayNpc(room, attacker, direction) {
    const origin = [attacker.state.x, attacker.state.y, attacker.state.feetZ + 1.35];
    const raw = Array.isArray(direction) ? direction : [];
    const length = Math.hypot(Number(raw[0]) || 0, Number(raw[1]) || 0, Number(raw[2]) || 0);
    if (length < 0.5) return null;
    const dir = raw.slice(0, 3).map((value) => (Number(value) || 0) / length);
    let winner = null;
    let winnerDistance = 90;
    for (const npc of room.world?.npcs || []) {
      if (npc.state === 'dead') continue;
      const to = [npc.x - origin[0], npc.y - origin[1], npc.feetZ + 1 - origin[2]];
      const along = to[0] * dir[0] + to[1] * dir[1] + to[2] * dir[2];
      if (along <= 0 || along >= winnerDistance) continue;
      const closestSq = to.reduce((sum, value) => sum + value * value, 0) - along * along;
      if (closestSq <= 0.7 * 0.7) { winner = npc; winnerDistance = along; }
    }
    return winner ? { npc: winner, distance: winnerDistance } : null;
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
    npc.state = npc.health <= 0 ? 'dead' : 'flee';
    npc.deadUntil = npc.health <= 0 ? Date.now() + 15_000 : 0;
    npc.fleeFrom = peer.id;
    reportWorldCrime(room, peer, damage >= 38 ? 2 : 1);
    return { npcId: npc.id, damage, health: npc.health, dead: npc.health <= 0, eventId };
  }

  function handleAction(peer, message) {
    const room = rooms.get(peer.roomId);
    if (!room || !peer.profile || peer.profile.health <= 0) return;
    const action = message.action && typeof message.action === 'object' ? message.action : {};
    const kind = String(action.kind || '');
    const eventId = boundedText(action.eventId, randomUUID(), 72);
    if (peer.eventIds.has(eventId)) return;
    peer.eventIds.add(eventId);
    if (peer.eventIds.size > 128) peer.eventIds.delete(peer.eventIds.values().next().value);
    const now = Date.now();
    let result = null;
    if (kind === 'shoot') {
      if (now - peer.lastShotAt < 115 || peer.profile.inventory.pistol_ammo <= 0) return;
      peer.lastShotAt = now;
      peer.profile.inventory.pistol_ammo--;
      const target = rayTarget(room, peer, action.direction);
      const npcTarget = rayNpc(room, peer, action.direction);
      result = target ? applyDamage(target, PISTOL_DAMAGE, peer.id, eventId)
        : npcTarget ? applyNpcDamage(room, npcTarget.npc, PISTOL_DAMAGE, peer, eventId) : null;
      reportWorldCrime(room, peer, 2);
      peer.state.weaponAction = 'fire';
      peer.state.weaponActionSerial++;
      peer.state.weaponFiring = true;
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
      else return;
      peer.state.armor = peer.profile.armor;
      pickup.availableAt = now + 30_000;
      result = { pickupId: pickup.id, type: pickup.type, amount: pickup.amount };
    } else {
      return;
    }
    peer.profile.updatedAt = new Date().toISOString();
    profileData[peer.resumeToken] = peer.profile;
    scheduleSave();
    const payload = { type: 'gameplay_event', id: peer.id, eventId, kind, result, state: peer.state };
    broadcast(room, payload, peer.socket);
    send(peer.socket, { ...payload, profile: peer.profile });
  }

  function onConnection(socket) {
    const peer = { id: randomUUID(), sessionId: '', resumeToken: '', name: '', roomId: '', state: null, profile: null, socket, lastStateAt: 0, lastAcceptedAt: Date.now(), lastShotAt: 0, lastMeleeAt: 0, respawnAt: 0, allowTeleportUntil: 0, eventIds: new Set() };
    socket.on('message', (data) => {
      if (data.length > MAX_MESSAGE_BYTES) {
        socket.close(1009, 'message too large');
        return;
      }
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message?.type === 'join') {
        join(peer, message);
        return;
      }
      if (message?.type === 'voice_signal' && peer.roomId) {
        const targetId = String(message.target || '');
        const room = rooms.get(peer.roomId);
        const target = room?.get(targetId);
        const signal = sanitizeVoiceSignal(message.signal);
        if (target && target !== peer && signal) send(target.socket, { type: 'voice_signal', from: peer.id, signal });
        return;
      }
      if (message?.type === 'action' && peer.roomId) {
        handleAction(peer, message);
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
      if (distance > maxSpeed * elapsed + 2.5 && now > peer.allowTeleportUntil) {
        next.x = peer.state.x; next.y = peer.state.y; next.feetZ = peer.state.feetZ;
        send(peer.socket, { type: 'state_correction', state: next });
      }
      peer.lastAcceptedAt = now;
      peer.state = next;
      peer.profile.position = [next.x, next.y, next.feetZ];
      broadcast(room, { type: 'peer_state', id: peer.id, state: peer.state }, socket);
    });
    socket.on('close', () => leave(peer));
    socket.on('error', () => leave(peer));
  }

  const simulation = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      const world = room.world;
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
          let tx = npc.targetX;
          let ty = npc.targetY;
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
          } else if (now >= npc.retargetAt || Math.hypot(tx - npc.x, ty - npc.y) < 1) {
            npc.retargetAt = now + 3500 + Math.random() * 4500;
            npc.targetX = npc.homeX + (Math.random() - 0.5) * 34;
            npc.targetY = npc.homeY + (Math.random() - 0.5) * 34;
            tx = npc.targetX; ty = npc.targetY;
          }
          const dx = tx - npc.x; const dy = ty - npc.y; const distance = Math.hypot(dx, dy);
          if (distance > 0.05) {
            npc.heading = Math.atan2(dy, dx);
            npc.x = Math.max(111.94, Math.min(261.94, npc.x + (dx / distance) * moveSpeed * 0.25));
            npc.y = Math.max(-925.84, Math.min(-775.84, npc.y + (dy / distance) * moveSpeed * 0.25));
          }
        }
        broadcast(room, { type: 'world_state', npcs: worldSnapshot(room), pickups: pickupSnapshot(room), wanted: Array.from(world.wanted.entries()).map(([id, value]) => ({ id, level: value.level })) });
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
      send(peer.socket, { type: 'player_state', profile: peer.profile, state: peer.state, respawn: true });
      broadcast(room, { type: 'peer_state', id: peer.id, state: peer.state }, peer.socket);
      scheduleSave();
      }
    }
  }, 250);
  simulation.unref?.();

  return { rooms, sessions, onConnection, close: () => { clearInterval(simulation); clearTimeout(saveTimer); } };
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
