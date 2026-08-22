const canvas = document.querySelector('#game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;
const menu = document.querySelector('#match-menu');
const mapSelect = document.querySelector('#map-select');
const cpuSelect = document.querySelector('#cpu-select');
const winsSelect = document.querySelector('#wins-select');
const startMatch = document.querySelector('#start-match');
const mapPreviewLabel = document.querySelector('#map-preview-label');

const sources = Object.fromEntries(['duck', 'duckArms', 'pistol', 'shotgun', 'ak47', 'bazooka', 'mainBackground',
  'cityBackground', 'industrialBackground', 'natureBackground', 'officeBackground', 'spaceBackground', 'snowBackground', 'undergroundBackground',
  'caveTileset', 'cityTileset', 'cityTreeTileset', 'industrialTileset', 'natureTileset', 'nublessSnowTileset', 'officeTileset',
  'pineTreeSnowTileset', 'pineTreeTileset', 'pineTrunkTileset', 'scaffoldingTileset', 'snowIceTileset', 'snowTileset', 'spaceTileset',
  'spookyTileset', 'treeTileset', 'undergroundTileset', 'wireTileset', 'woodScaffoldingTileset',
  'crate', 'itemBox', 'itemBoxRandom', 'spring', 'spikes', 'mine', 'teleporterTop', 'teleporterBottom', 'teleporterIcon',
  'door', 'verticalDoor', 'travelPipes', 'travelPipesBlue', 'travelPipesGreen', 'window', 'streetLight', 'hangingCityLight', 'treeTop', 'rock01', 'desk']
  .concat(['pickup_banana', 'pickup_blunderbuss', 'pickup_bootsPickup', 'pickup_camping', 'pickup_chaingun', 'pickup_chestPlatePickup', 'pickup_combatShotgun', 'pickup_dartgun', 'pickup_deathcrate', 'pickup_cowboyPistol', 'pickup_extinguisher', 'pickup_flamethrower', 'pickup_flareGun', 'pickup_grenade', 'pickup_grenadecannon', 'pickup_grenadeLauncher', 'pickup_helmetPickup', 'pickup_holster', 'pickup_hugeLaser', 'pickup_jetpack', 'pickup_key', 'pickup_knightHelmetPickup', 'pickup_laserRifle', 'pickup_magnum', 'pickup_magnetGun', 'pickup_mindControlGun', 'pickup_musket', 'pickup_netGun', 'pickup_oldPistol', 'pickup_pelletGun', 'pickup_pewpewLaser', 'pickup_quadLaser', 'pickup_sledgeHammer', 'pickup_sniper', 'pickup_virtualShotgun', 'pickup_warpgun', 'pickup_present'])
  .map((name) => [name, `./assets/${name}.png`]));
const images = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([name, src]) => {
  const image = new Image(); image.src = src; await image.decode().catch(() => {}); return [name, image];
})));

const keys = new Set();
addEventListener('keydown', (event) => {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'a', 'd', 'w', 's', ' ', 'e'].includes(event.key)) event.preventDefault();
  if ((event.key === 'Escape' || event.key.toLowerCase() === 'm') && !event.repeat) menu.hidden = false;
  keys.add(event.key.toLowerCase());
  // A single press should fire immediately (and therefore reliably unlock
  // browser audio); holding Space continues firing through updateDuck().
  if ([' ', 'space', 'spacebar'].includes(event.key.toLowerCase()) && !event.repeat && menu.hidden) fire(ducks[0]);
});
addEventListener('keyup', (event) => keys.delete(event.key.toLowerCase()));
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const approach = (value, target, amount) => value < target ? Math.min(target, value + amount) : Math.max(target, value - amount);
const fallbackPlatforms = [
  { x: 0, y: 488, w: 960, h: 52 }, { x: 80, y: 385, w: 205, h: 18 },
  { x: 383, y: 315, w: 195, h: 18 }, { x: 687, y: 395, w: 190, h: 18 },
  { x: 680, y: 235, w: 170, h: 18 }, { x: 170, y: 210, w: 180, h: 18 },
];
let platforms = fallbackPlatforms;
let mapObjects = [];
let mapSpawnPoints = [];
let mapPickupSpots = [];
let mapCrateSpots = [];
let mapHazards = [];
let mapSprings = [];
let mapTeleporters = [];
let mapPipes = [];
let mapDoors = [];
let mapWater = [];
let mapSaws = [];
let mapRopes = [];
let mapLasers = [];
let mapBlocks = [];
let mapBarrelSpots = [];
let mapCatalog = [];
let activeMap = -1;
let mapName = 'TRAINING ARENA';
let mapBackground = 'cityBackground';
let playerCount = 3;
let winsToTakeMatch = 8;

// The level data stores exactly the XNA sprite-frame number for each tile.  Most
// world tiles use 16px cells; the narrow pine atlases use 8px cells instead.
const TILE_ART = {
  CaveTileset: 'caveTileset', CityTileset: 'cityTileset', CityTreeTileset: 'cityTreeTileset', IndustrialTileset: 'industrialTileset',
  NatureTileset: 'natureTileset', NublessSnowTileset: 'nublessSnowTileset', OfficeTileset: 'officeTileset',
  PineTreeSnowTileset: 'pineTreeSnowTileset', PineTreeTileset: 'pineTreeTileset', PineTrunkTileset: 'pineTrunkTileset',
  ScaffoldingTileset: 'scaffoldingTileset', SnowIceTileset: 'snowIceTileset', SnowTileset: 'snowTileset', SpaceTileset: 'spaceTileset',
  SpookyTileset: 'spookyTileset', TreeTileset: 'treeTileset', UndergroundTileset: 'undergroundTileset', WireTileset: 'wireTileset',
  WoodScaffoldingTileset: 'woodScaffoldingTileset',
};
const NARROW_TILE_ART = new Set(['pineTreeSnowTileset', 'pineTrunkTileset']);
const BACKGROUND_ART = {
  CityBackground: 'cityBackground', IndustrialBackground: 'industrialBackground', NatureBackground: 'natureBackground',
  NatureBackgroundNight: 'natureBackground', OfficeBackground: 'officeBackground', SpaceBackground: 'spaceBackground',
  SnowBackground: 'snowBackground', UndergroundBackground: 'undergroundBackground',
};
const THEME_BACKGROUND = { cityTileset: 'cityBackground', industrialTileset: 'industrialBackground', natureTileset: 'natureBackground', officeTileset: 'officeBackground', spaceTileset: 'spaceBackground', snowTileset: 'snowBackground', undergroundTileset: 'undergroundBackground' };
const levelClass = (type = '') => type.match(/DuckGame\.([^,]+)/)?.[1] || '';

function screenMapPoint(point, bounds, scale) {
  return { x: 28 + (point.x - bounds.minX) * scale, y: 28 + (point.y - bounds.minY) * scale };
}
function safeSpawn(point, index) {
  const solids = collisionSolids();
  const fallback = solids[index % solids.length] || { x: 130 + index * 205, y: 350, w: 80 };
  const candidates = point ? solids.filter((platform) => point.x >= platform.x - 10 && point.x <= platform.x + platform.w + 10 && platform.y >= point.y - 8) : [];
  const ground = candidates.sort((a, b) => a.y - b.y)[0] || fallback;
  return { x: clamp(point?.x ?? ground.x + ground.w / 2, ground.x + 12, ground.x + ground.w - 12), y: ground.y - 21 };
}
function populateMapMenu() {
  mapSelect.replaceChildren(...mapCatalog.map((entry, index) => {
    const option = document.createElement('option'); option.value = String(index); option.textContent = entry.source.replace(/^deathmatch\//, '').replace(/\.lev$/, '').replace(/([a-z])([0-9])/gi, '$1 $2').replace(/[_.-]/g, ' '); return option;
  }));
  mapSelect.value = String(Math.max(0, activeMap));
  startMatch.disabled = false;
  startMatch.textContent = 'Start deathmatch';
}
function useMap(map, entry) {
  const tiles = map.things || [];
  if (!tiles.length) return;
  const xs = tiles.map((tile) => tile.x), ys = tiles.map((tile) => tile.y);
  const bounds = { minX: Math.min(...xs) - 16, maxX: Math.max(...xs) + 32, minY: Math.min(...ys) - 16, maxY: Math.max(...ys) + 32 };
  const scale = Math.min(1.62, (canvas.width - 56) / (bounds.maxX - bounds.minX), (canvas.height - 90) / (bounds.maxY - bounds.minY));
  platforms = tiles.map((tile) => {
    const point = screenMapPoint(tile, bounds, scale);
    const tileArt = TILE_ART[levelClass(tile.type)];
    return { x: point.x, y: point.y, w: 16 * scale, h: 16 * scale, frame: tile.frame, tileset: tile.type, tileArt, flipHorizontal: tile.flipHorizontal, oneWay: tile.type.includes('Scaffolding'), ice: /Snow|Ice/.test(tile.type) };
  });
  mapObjects = (map.objects || []).map((object) => ({ ...object, ...screenMapPoint(object, bounds, scale) }));
  const background = mapObjects.find((object) => object.type.includes('Background'));
  mapBackground = BACKGROUND_ART[levelClass(background?.type)] || THEME_BACKGROUND[platforms.find((platform) => platform.tileArt)?.tileArt] || 'cityBackground';
  mapSpawnPoints = mapObjects.filter((object) => object.type.includes('FreeSpawn'));
  mapPickupSpots = mapObjects.filter((object) => object.type.includes('ItemSpawner'));
  mapCrateSpots = mapObjects.filter((object) => object.type.includes('Crate'));
  mapHazards = mapObjects.filter((object) => /Spikes|Icicles|Mine/.test(object.type));
  mapSprings = mapObjects.filter((object) => object.type.includes('Spring'));
  mapTeleporters = mapObjects.filter((object) => object.type.includes('Teleporter'));
  mapPipes = mapObjects.filter((object) => /^Pipe(?:Blue|Red|Green)$/.test(levelClass(object.type)));
  mapDoors = mapObjects.filter((object) => /^(Door|VerticalDoor|FlimsyDoor)$/.test(levelClass(object.type))).map((object) => ({ ...object, open: false, openTimer: 0 }));
  mapWater = mapObjects.filter((object) => /^(WaterFlow|StandingFluid|WaterFall|WaterFallTile)$/.test(levelClass(object.type)));
  mapSaws = mapObjects.filter((object) => /^(Saws|Chainsaw)$/.test(levelClass(object.type)));
  mapRopes = mapObjects.filter((object) => object.type.includes('Rope'));
  mapLasers = mapObjects.filter((object) => /LaserSpawner|PewPewLaser|QuadLaser|HugeLaser/.test(levelClass(object.type))).map((object) => ({ ...object, phase: Math.random() * 2 }));
  mapBlocks = mapObjects.filter((object) => /^(IceBlock|IceWedge|PurpleBlock|GreyBlock)$/.test(levelClass(object.type))).map((object) => ({ ...object, dead: false }));
  mapBarrelSpots = mapObjects.filter((object) => /(Barrel|ECrate|Explosive)/.test(levelClass(object.type)));
  mapName = entry.name.replace(/[_-]/g, ' ').toUpperCase();
  mapPreviewLabel.textContent = `Previewing: ${mapName} · ${tiles.length} tiles · ${(map.objects || []).length} placed objects`;
  document.querySelector('#status').textContent = `${mapName} · WASD / ARROWS MOVE · S CROUCH / USE · E OPEN · SPACE FIRE`;
}
async function loadMap(index) {
  if (!mapCatalog.length) return;
  activeMap = (index + mapCatalog.length) % mapCatalog.length;
  const entry = mapCatalog[activeMap];
  const response = await fetch(`./levels/${entry.path}`);
  if (!response.ok) throw new Error(`map load failed: ${response.status}`);
  useMap(await response.json(), entry);
}
async function initialiseMaps() {
  try {
    const response = await fetch('./levels/index.json');
    if (!response.ok) throw new Error(`level index unavailable: ${response.status}`);
    mapCatalog = (await response.json()).maps || [];
    // Pick a deterministic first shipped arena; later M cycles through every
    // extracted deathmatch map without a page reload.
    await loadMap(Math.max(0, mapCatalog.findIndex((entry) => entry.name.toLowerCase() === 'city01')));
    populateMapMenu();
  } catch (error) {
    console.warn('Duck Game level data unavailable; using training arena.', error);
  }
  restartMatch();
}
const colors = ['#4aa9f5', '#ed5b5b', '#63cf78', '#b779e8'];
const WEAPONS = {
  pistol: { label: 'PISTOL', ammo: 9, wait: .22, speed: 760, kick: 90, sprite: 'pistol', sound: 'pistolFire.wav' },
  shotgun: { label: 'SHOTGUN', ammo: 2, wait: .72, speed: 690, kick: 170, pellets: 6, spread: .19, sprite: 'shotgun', sound: 'shotgunFire2.wav', reload: .72 },
  ak: { label: 'AK-47', ammo: 30, wait: .085, speed: 900, kick: 95, spread: .05, sprite: 'ak47', sound: 'deepMachineGun2.wav', auto: true },
  rocket: { label: 'BAZOOKA', ammo: 1, wait: .9, speed: 420, kick: 240, sprite: 'bazooka', sound: 'missile.wav', rocket: true },
  grenade: { label: 'GRENADE', ammo: 1, wait: .7, speed: 330, kick: 90, sound: 'grenadeFire.wav', grenade: true },
  sniper: { label: 'SNIPER', ammo: 1, wait: .82, speed: 1320, kick: 150, sound: 'sniper.wav' },
  magnum: { label: 'MAGNUM', ammo: 6, wait: .34, speed: 1040, kick: 145, sound: 'magnum.wav' },
  sword: { label: 'SWORD', ammo: 99, wait: .34, speed: 0, kick: 40, sound: 'swordClash.wav', melee: true },
  net: { label: 'NET GUN', ammo: 3, wait: .55, speed: 520, kick: 70, sound: 'netGunFire.wav', net: true },
  flame: { label: 'FLAMETHROWER', ammo: 12, wait: .12, speed: 360, kick: 22, sound: 'flameExplode.wav', flame: true },
};
const weaponTypes = Object.keys(WEAPONS);
const ITEM_REGISTRY = {
  AK47: ['weapon', 'ak'], BananaCluster: ['weapon', 'grenade'], Bazooka: ['weapon', 'rocket'], Blunderbuss: ['weapon', 'shotgun'],
  Boots: ['equipment', 'boots'], CampingRifle: ['weapon', 'sniper'], Chaindart: ['weapon', 'pistol'], Chaingun: ['weapon', 'ak'],
  ChestPlate: ['equipment', 'chestPlate'], CombatShotgun: ['weapon', 'shotgun'], DartGun: ['weapon', 'sniper'], DeathCrate: ['supply', 'deathCrate'],
  DuelingPistol: ['weapon', 'magnum'], EnergyScimitar: ['weapon', 'sword'], FireExtinguisher: ['weapon', 'flame'], FlameThrower: ['weapon', 'flame'],
  FlareGun: ['weapon', 'pistol'], Grapple: ['weapon', 'net'], Grenade: ['weapon', 'grenade'], GrenadeCannon: ['weapon', 'grenade'],
  GrenadeLauncher: ['weapon', 'grenade'], Helmet: ['equipment', 'helmet'], Holster: ['equipment', 'holster'], HugeLaser: ['weapon', 'sniper'],
  Jetpack: ['equipment', 'jetpack'], Key: ['supply', 'key'], KnightHelmet: ['equipment', 'knightHelmet'], LaserRifle: ['weapon', 'sniper'],
  MagBlaster: ['weapon', 'magnum'], MagnetGun: ['weapon', 'net'], Magnum: ['weapon', 'magnum'], MindControlRay: ['weapon', 'net'],
  Mine: ['weapon', 'grenade'], Musket: ['weapon', 'sniper'], NetGun: ['weapon', 'net'], OldPistol: ['weapon', 'pistol'],
  PelletGun: ['weapon', 'shotgun'], PewPewLaser: ['weapon', 'sniper'], Phaser: ['weapon', 'pistol'], Pistol: ['weapon', 'pistol'], PlasmaBlaster: ['weapon', 'sniper'],
  Present: ['supply', 'present'], QuadLaser: ['weapon', 'sniper'], RCController: ['weapon', 'grenade'], RomanCandle: ['weapon', 'flame'],
  SMG: ['weapon', 'ak'], Sharpshot: ['weapon', 'sniper'], Shotgun: ['weapon', 'shotgun'], SledgeHammer: ['weapon', 'sword'],
  Sniper: ['weapon', 'sniper'], SnubbyPistol: ['weapon', 'pistol'], Sword: ['weapon', 'sword'], TV: ['weapon', 'net'],
  VirtualShotgun: ['weapon', 'shotgun'], Warpgun: ['weapon', 'sniper'],
};
const WEAPON_RENDER = {
  pistol: { sx: 0, sy: 0, sw: 18, sh: 10, w: 29, h: 16, frames: 4 },
  shotgun: { sx: 4, sy: 13, sw: 27, sh: 9, w: 34, h: 12 },
  ak: { sx: 0, sy: 11, sw: 32, sh: 11, w: 37, h: 13 },
  rocket: { sx: 0, sy: 0, sw: 30, sh: 13, w: 36, h: 16 },
};
// Pickups retain their authored class name, so draw that exact source sprite
// rather than a coloured inventory square. Values are the first animation cell
// in each original XNA sheet and its display size in the arena.
const PICKUP_ART = {
  AK47: ['ak47', 32, 11, 34, 13], BananaCluster: ['pickup_banana', 16, 16, 22, 22], Bazooka: ['bazooka', 30, 13, 36, 16], Blunderbuss: ['pickup_blunderbuss', 33, 11, 35, 14],
  Boots: ['pickup_bootsPickup', 16, 16, 21, 21], CampingRifle: ['pickup_camping', 23, 15, 33, 17], Chaindart: ['pickup_oldPistol', 16, 16, 24, 18], Chaingun: ['pickup_chaingun', 28, 28, 38, 25],
  ChestPlate: ['pickup_chestPlatePickup', 16, 16, 21, 21], CombatShotgun: ['pickup_combatShotgun', 16, 16, 29, 18], DartGun: ['pickup_dartgun', 16, 16, 29, 18], DeathCrate: ['pickup_deathcrate', 16, 19, 22, 25],
  DuelingPistol: ['pickup_cowboyPistol', 22, 11, 29, 15], EnergyScimitar: ['pickup_sledgeHammer', 32, 32, 31, 29], FireExtinguisher: ['pickup_extinguisher', 16, 16, 21, 21], FlameThrower: ['pickup_flamethrower', 16, 16, 29, 18],
  FlareGun: ['pickup_flareGun', 16, 16, 21, 21], Grapple: ['pickup_netGun', 16, 16, 28, 20], Grenade: ['pickup_grenade', 16, 16, 21, 21], GrenadeCannon: ['pickup_grenadecannon', 26, 18, 34, 22],
  GrenadeLauncher: ['pickup_grenadeLauncher', 16, 16, 29, 18], Helmet: ['pickup_helmetPickup', 16, 16, 21, 21], Holster: ['pickup_holster', 12, 12, 19, 19], HugeLaser: ['pickup_hugeLaser', 32, 32, 36, 25],
  Jetpack: ['pickup_jetpack', 16, 16, 25, 23], Key: ['pickup_key', 16, 16, 21, 21], KnightHelmet: ['pickup_knightHelmetPickup', 16, 16, 21, 21], LaserRifle: ['pickup_laserRifle', 16, 16, 30, 19],
  MagBlaster: ['pickup_magnum', 16, 16, 27, 18], MagnetGun: ['pickup_magnetGun', 16, 16, 29, 19], Magnum: ['pickup_magnum', 16, 16, 27, 18], MindControlRay: ['pickup_mindControlGun', 16, 16, 29, 19],
  Mine: ['mine', 18, 16, 23, 20], Musket: ['pickup_musket', 41, 11, 38, 14], NetGun: ['pickup_netGun', 16, 16, 28, 20], OldPistol: ['pickup_oldPistol', 16, 16, 24, 18],
  PelletGun: ['pickup_pelletGun', 31, 14, 33, 16], PewPewLaser: ['pickup_pewpewLaser', 16, 16, 28, 20], Phaser: ['pistol', 18, 10, 29, 16], Pistol: ['pistol', 18, 10, 29, 16],
  PlasmaBlaster: ['pickup_hugeLaser', 32, 32, 36, 25], Present: ['pickup_present', 18, 17, 24, 23], QuadLaser: ['pickup_quadLaser', 16, 16, 21, 21], RCController: ['pickup_grenade', 16, 16, 21, 21],
  RomanCandle: ['pickup_flamethrower', 16, 16, 29, 18], SMG: ['ak47', 32, 11, 34, 13], Sharpshot: ['pickup_sniper', 33, 9, 37, 13], Shotgun: ['shotgun', 27, 9, 34, 12],
  SledgeHammer: ['pickup_sledgeHammer', 32, 32, 31, 29], Sniper: ['pickup_sniper', 33, 9, 37, 13], SnubbyPistol: ['pickup_oldPistol', 16, 16, 24, 18], Sword: ['sword', 16, 16, 29, 22],
  TV: ['pickup_mindControlGun', 16, 16, 29, 19], VirtualShotgun: ['pickup_virtualShotgun', 16, 16, 29, 18], Warpgun: ['pickup_warpgun', 19, 17, 32, 20],
};
const audio = Object.fromEntries(Object.entries(WEAPONS).map(([type, weapon]) => [type, new Audio(`./assets/Audio/SFX/${weapon.sound}`)]));
const explodeAudio = new Audio('./assets/Audio/SFX/explode.wav');
const effects = Object.fromEntries(['jump.wav', 'respawn.wav', 'death.wav', 'crateDestroy.wav', 'scoreDing.wav', 'click.wav'].map((name) => [name, new Audio(`./assets/Audio/SFX/${name}`)]));
function sound(type, volume = .25) { const base = type === 'explode' ? explodeAudio : audio[type]; if (!base) return; const node = base.cloneNode(); node.volume = volume; node.play().catch(() => {}); }
function effect(name, volume = .22) { const base = effects[name]; if (!base) return; const node = base.cloneNode(); node.volume = volume; node.play().catch(() => {}); }
// The render loop starts immediately while the map catalog loads, so keep a
// valid empty game state until initialiseMaps() starts the first round.
let ducks = [], bullets = [], pickups = [], worldCrates = [], worldBarrels = [], particles = [], roundWinner = null, matchOver = false, roundIntro = 0, introTick = -1, score = [0, 0, 0, 0], lastTime = 0, spawnClock = 0, nextPickup = 0;

function weaponFromContent(content) {
  const key = String(content || '').match(/DuckGame\.([^,]+)/)?.[1];
  const entry = ITEM_REGISTRY[key];
  return entry ? { source: key, kind: entry[0], value: entry[1] } : { source: key || 'Random', kind: 'random', value: weaponTypes[Math.floor(Math.random() * weaponTypes.length)] };
}
function pickupFor(x, y, content) {
  const item = typeof content === 'string' && WEAPONS[content] ? { source: content, kind: 'weapon', value: content } : weaponFromContent(content);
  return { x, y, type: item.kind === 'weapon' || item.kind === 'random' ? item.value : null, item, age: 0 };
}

function freshDuck(index, player = false) {
  const spawn = mapSpawnPoints.length ? mapSpawnPoints[index % mapSpawnPoints.length] : undefined;
  const position = safeSpawn(spawn, index);
  return { index, player, x: position.x, y: position.y, vx: 0, vy: 0, dir: index % 2 ? -1 : 1, grounded: true, coyote: .12, jumpHeld: false, airJump: false, crouching: false, inWater: false, onRope: false, pipeCooldown: 0, equipment: {}, armor: 0, jetFuel: 1, stunned: 0, teleporterCooldown: 0, spawnTime: .6, deathTime: 0, alive: true, cooldown: 0, invulnerable: 1.2, aim: 0, weapon: index === 0 ? 'pistol' : null, ammo: index === 0 ? WEAPONS.pistol.ammo : 0, reload: 0, firePose: 0, animTime: 0 };
}
function resetRound() { ducks = Array.from({ length: playerCount }, (_, index) => freshDuck(index, index === 0)); bullets = []; pickups = []; worldCrates = mapCrateSpots.map((crate) => ({ ...crate, hp: 1 })); worldBarrels = mapBarrelSpots.map((barrel) => ({ ...barrel, hp: levelClass(barrel.type) === 'ExplosiveBarrel' ? 1 : 2, dead: false })); mapHazards.forEach((hazard) => { hazard.dead = false; }); mapBlocks.forEach((block) => { block.dead = false; }); mapDoors.forEach((door) => { door.open = false; door.openTimer = 0; }); particles = []; roundWinner = null; roundIntro = 4; introTick = -1; spawnClock = 0; nextPickup = .85; effect('respawn.wav', .16); }
function restartMatch() { score = Array(playerCount).fill(0); matchOver = false; resetRound(); }
document.querySelector('#restart').onclick = restartMatch;
document.querySelector('#open-menu').onclick = () => { menu.hidden = false; };
startMatch.onclick = async () => {
  playerCount = Number(cpuSelect.value) + 1;
  winsToTakeMatch = Number(winsSelect.value);
  await loadMap(Number(mapSelect.value));
  document.querySelector('#match-note').textContent = `Deathmatch · first duck to ${winsToTakeMatch} wins.`;
  menu.hidden = true;
  restartMatch();
};
mapSelect.onchange = async () => {
  await loadMap(Number(mapSelect.value));
  restartMatch();
};
initialiseMaps();

function fire(duck) {
  const weapon = WEAPONS[duck.weapon];
  if (roundIntro > 0 || !duck.alive || !weapon || duck.cooldown > 0 || duck.reload > 0) return;
  if (duck.ammo <= 0) { if (weapon.reload) duck.reload = weapon.reload; return; }
  duck.ammo--; duck.cooldown = weapon.wait; duck.vx -= duck.dir * weapon.kick; duck.firePose = weapon.rocket ? .16 : .09; sound(duck.weapon);
  if (weapon.melee) {
    for (const target of ducks) if (target.alive && target.index !== duck.index && Math.abs(target.x - duck.x) < 54 && Math.abs(target.y - duck.y) < 34) defeatDuck(target);
    return;
  }
  if (weapon.rocket) bullets.push({ kind: 'rocket', x: duck.x + duck.dir * 22, y: duck.y - 6, vx: duck.dir * weapon.speed, vy: 0, owner: duck.index, life: 2.2 });
  else if (weapon.grenade) bullets.push({ kind: 'grenade', x: duck.x + duck.dir * 18, y: duck.y - 12, vx: duck.dir * weapon.speed, vy: -190, owner: duck.index, life: .9 });
  else if (weapon.net) bullets.push({ kind: 'net', x: duck.x + duck.dir * 18, y: duck.y - 7, vx: duck.dir * weapon.speed, vy: 0, owner: duck.index, life: .8 });
  else if (weapon.flame) bullets.push({ kind: 'flame', x: duck.x + duck.dir * 18, y: duck.y - 7, vx: duck.dir * weapon.speed, vy: (Math.random() - .5) * 130, owner: duck.index, life: .18 });
  else for (let pellet = 0; pellet < (weapon.pellets || 1); pellet++) bullets.push({ kind: 'bullet', x: duck.x + duck.dir * 19, y: duck.y - 5, vx: duck.dir * weapon.speed, vy: (duck.aim + (Math.random() - .5) * (weapon.spread || .02)) * weapon.speed, owner: duck.index, life: 1.1 });
}
function giveWeapon(duck, type) { if (!WEAPONS[type]) return; duck.weapon = type; duck.ammo = WEAPONS[type].ammo; duck.reload = 0; }
function applyPickup(duck, pickup) {
  const item = pickup.item || { kind: 'weapon', value: pickup.type };
  if (item.kind === 'weapon' || item.kind === 'random') giveWeapon(duck, item.value);
  else if (item.kind === 'equipment') { duck.equipment[item.value] = true; if (item.value === 'chestPlate') duck.armor += 2; if (item.value === 'helmet' || item.value === 'knightHelmet') duck.armor += 1; if (item.value === 'holster' && duck.weapon === 'pistol') duck.ammo += 6; if (item.value === 'jetpack') duck.jetFuel = 1; }
  else if (item.value === 'present' || item.value === 'deathCrate') giveWeapon(duck, weaponTypes[Math.floor(Math.random() * weaponTypes.length)]);
  effect('scoreDing.wav', .14);
}
function breakCrate(crate) { if (crate.dead) return; crate.dead = true; effect('crateDestroy.wav', .22); pickups.push(pickupFor(crate.x, crate.y - 14, weaponTypes[Math.floor(Math.random() * weaponTypes.length)])); }
function defeatDuck(target) {
  if (target.armor > 0) { target.armor--; target.invulnerable = .35; target.vx *= .35; return; }
  if (!target.alive) return;
  target.alive = false; target.deathTime = .65; effect('death.wav', .28);
  for (let index = 0; index < 10; index++) particles.push({ x: target.x, y: target.y - 8, vx: (Math.random() - .5) * 220, vy: -40 - Math.random() * 180, life: .35 + Math.random() * .35, color: colors[target.index] });
}
function explode(x, y, owner) { sound('explode', .35); for (let index = 0; index < 22; index++) particles.push({ x, y, vx: (Math.random() - .5) * 360, vy: (Math.random() - .5) * 360, life: .35 + Math.random() * .35, color: index % 2 ? '#ffe36a' : '#ff704f' }); for (const crate of worldCrates) if (!crate.dead && Math.hypot(crate.x - x, crate.y - y) < 72) breakCrate(crate); for (const target of ducks) if (target.alive && target.index !== owner && Math.hypot(target.x - x, target.y - y) < 84) defeatDuck(target); }
const duckTop = (duck) => duck.y - (duck.crouching ? 11 : 20);
const duckBottom = (duck) => duck.y + 20;
function collisionSolids() {
  const blocks = mapBlocks.filter((block) => !block.dead).map((block) => ({ x: block.x - 11, y: block.y - 11, w: 22, h: 22, ice: levelClass(block.type).includes('Ice'), oneWay: false, object: block }));
  const doors = mapDoors.filter((door) => !door.open).map((door) => {
    const vertical = levelClass(door.type) === 'VerticalDoor';
    return { x: door.x - (vertical ? 10 : 14), y: door.y - (vertical ? 24 : 14), w: vertical ? 20 : 28, h: vertical ? 48 : 28, oneWay: false, object: door };
  });
  return platforms.concat(blocks, doors);
}
function pipeExit(pipe) {
  const type = levelClass(pipe.type);
  const peers = mapPipes.filter((candidate) => candidate !== pipe && levelClass(candidate.type) === type);
  return peers.length ? peers[(mapPipes.indexOf(pipe) + 1) % peers.length] : null;
}
function updateMapState(dt) {
  for (const door of mapDoors) {
    door.openTimer = Math.max(0, door.openTimer - dt);
    if (door.openTimer === 0) door.open = false;
  }
  for (const laser of mapLasers) laser.phase += dt;
}
function resolveMapObjectInteractions(duck) {
  for (const hazard of mapHazards) {
    if (hazard.dead) continue;
    const hazardClass = levelClass(hazard.type);
    const spikesDown = hazardClass.includes('Down');
    const spikesLeft = hazardClass.includes('Left'), spikesRight = hazardClass.includes('Right');
    const spikeContact = spikesLeft ? Math.abs(duck.x - 10 - hazard.x) < 10 && Math.abs(duck.y - hazard.y) < 14
      : spikesRight ? Math.abs(duck.x + 10 - hazard.x) < 10 && Math.abs(duck.y - hazard.y) < 14
        : Math.abs(duck.x - hazard.x) < 13 && Math.abs((spikesDown ? duckTop(duck) : duckBottom(duck)) - hazard.y) < 14;
    if (hazard.type.includes('Mine') && Math.hypot(duck.x - hazard.x, duck.y - hazard.y) < 20) { hazard.dead = true; explode(hazard.x, hazard.y, -1); }
    else if (!hazard.type.includes('Mine') && spikeContact) defeatDuck(duck);
  }
  for (const saw of mapSaws) if (Math.hypot(duck.x - saw.x, duck.y - saw.y) < 18) defeatDuck(duck);
  for (const laser of mapLasers) {
    const firing = Math.sin(laser.phase * 3) > .35;
    if (firing && Math.abs(duck.y - laser.y) < 9 && (laser.flipHorizontal ? duck.x < laser.x : duck.x > laser.x)) defeatDuck(duck);
  }
  for (const spring of mapSprings) {
    const springClass = levelClass(spring.type);
    if (Math.abs(duck.x - spring.x) > 16 || Math.abs(duckBottom(duck) - spring.y) > 18) continue;
    if (springClass.includes('Left')) { duck.vx = -500; duck.vy = -410; }
    else if (springClass.includes('Right')) { duck.vx = 500; duck.vy = -410; }
    else if (springClass.includes('Down')) { duck.vy = 540; }
    else { duck.y = spring.y - 20; duck.vy = -620; }
    duck.grounded = false;
  }
  const water = mapWater.find((flow) => Math.abs(duck.x - flow.x) < 26 && duck.y > flow.y - ((flow.deep || 2) * 10) && duck.y < flow.y + 28);
  duck.inWater = Boolean(water);
  if (water) { duck.vy -= 610 / 60; duck.vx += (water.flipHorizontal ? -1 : 1) * 3; duck.vx *= .93; }
  const rope = mapRopes.find((candidate) => Math.abs(duck.x - candidate.x) < 12 && duck.y > candidate.y - 8 && duck.y < candidate.y + (candidate.length || 5) * 9);
  duck.onRope = Boolean(rope);
  if (rope && duck.player && (keys.has('arrowup') || keys.has('w') || keys.has('arrowdown') || keys.has('s'))) { duck.x = rope.x; duck.vy = keys.has('arrowup') || keys.has('w') ? -140 : 140; }
  for (const pipe of mapPipes) if (duck.pipeCooldown <= 0 && Math.hypot(duck.x - pipe.x, duck.y - pipe.y) < 15) {
    const exit = pipeExit(pipe);
    if (exit) { duck.x = exit.x; duck.y = exit.y - 18; duck.vx = (exit.right ? 1 : exit.left ? -1 : 0) * 230; duck.vy = exit.up ? -360 : exit.down ? 220 : 0; duck.pipeCooldown = .55; }
    break;
  }
  for (const door of mapDoors) if (Math.abs(duck.x - door.x) < 28 && Math.abs(duck.y - door.y) < 40 && (duck.player ? keys.has('e') || keys.has('arrowdown') || keys.has('s') : true)) { door.open = true; door.openTimer = 1.4; }
  if (duck.teleporterCooldown <= 0 && mapTeleporters.length > 1) {
    const sourceIndex = mapTeleporters.findIndex((teleporter) => Math.hypot(duck.x - teleporter.x, duck.y - teleporter.y) < 18);
    if (sourceIndex >= 0) { const target = mapTeleporters[(sourceIndex + 1) % mapTeleporters.length]; const point = safeSpawn(target, duck.index); duck.x = point.x; duck.y = point.y; duck.vx = 0; duck.vy = 0; duck.teleporterCooldown = .55; }
  }
}
function resolveHorizontal(duck, previousX) {
  const top = duckTop(duck), bottom = duckBottom(duck) - 1;
  for (const platform of collisionSolids()) {
    if (platform.oneWay || bottom <= platform.y + 2 || top >= platform.y + platform.h - 2) continue;
    if (duck.vx > 0 && previousX + 10 <= platform.x && duck.x + 10 >= platform.x) { duck.x = platform.x - 10; duck.vx = 0; }
    if (duck.vx < 0 && previousX - 10 >= platform.x + platform.w && duck.x - 10 <= platform.x + platform.w) { duck.x = platform.x + platform.w + 10; duck.vx = 0; }
  }
}
function resolveVertical(duck, previousY, dt) {
  duck.grounded = false;
  const height = duck.crouching ? 11 : 20;
  const wasTop = previousY - height, wasBottom = previousY + 20;
  const top = duck.y - height, bottom = duckBottom(duck);
  let landing = null, ceiling = null;
  for (const platform of collisionSolids()) {
    const overlapsX = duck.x + 10 > platform.x + 1 && duck.x - 10 < platform.x + platform.w - 1;
    if (!overlapsX) continue;
    if (duck.vy >= 0 && wasBottom <= platform.y + 2 && bottom >= platform.y) {
      if (!landing || platform.y < landing.y) landing = platform;
    } else if (!platform.oneWay && duck.vy < 0 && wasTop >= platform.y + platform.h - 2 && top <= platform.y + platform.h) {
      if (!ceiling || platform.y + platform.h > ceiling.y + ceiling.h) ceiling = platform;
    }
  }
  if (landing) { duck.y = landing.y - 20; duck.vy = 0; duck.grounded = true; duck.surfaceIce = Boolean(landing.ice); }
  else duck.surfaceIce = false;
  if (ceiling) { duck.y = ceiling.y + ceiling.h + height; duck.vy = 0; }
  duck.coyote = duck.grounded ? .12 : Math.max(0, duck.coyote - dt);
  if (duck.grounded) duck.airJump = false;
}
function updateDuck(duck, dt) {
  if (!duck.alive) { duck.deathTime = Math.max(0, duck.deathTime - dt); return; }
  duck.cooldown = Math.max(0, duck.cooldown - dt); duck.invulnerable = Math.max(0, duck.invulnerable - dt); duck.reload = Math.max(0, duck.reload - dt); duck.stunned = Math.max(0, duck.stunned - dt); duck.teleporterCooldown = Math.max(0, duck.teleporterCooldown - dt); duck.pipeCooldown = Math.max(0, duck.pipeCooldown - dt); duck.spawnTime = Math.max(0, duck.spawnTime - dt); duck.firePose = Math.max(0, duck.firePose - dt); duck.animTime += dt;
  if (duck.reload === 0 && duck.weapon && duck.ammo === 0 && WEAPONS[duck.weapon].reload) duck.ammo = WEAPONS[duck.weapon].ammo;
  let jump = false;
  if (duck.stunned > 0) {
    duck.vx = approach(duck.vx, 0, 2100 * dt);
  } else if (duck.player) {
    const left = keys.has('arrowleft') || keys.has('a'), right = keys.has('arrowright') || keys.has('d');
    duck.crouching = (keys.has('arrowdown') || keys.has('s')) && duck.grounded;
    const targetSpeed = left ? -245 : right ? 245 : 0;
    duck.vx = approach(duck.vx, targetSpeed * (duck.crouching ? .52 : 1), (left || right ? 1850 : (duck.surfaceIce ? 380 : 2350)) * dt);
    if (left) duck.dir = -1; if (right) duck.dir = 1;
    jump = keys.has('arrowup') || keys.has('w');
    if (keys.has(' ') || keys.has('space') || keys.has('spacebar')) fire(duck);
  } else {
    const target = ducks.find((other) => other.alive && other.index !== duck.index) || duck;
    const dx = target.x - duck.x; duck.dir = Math.sign(dx) || duck.dir; duck.vx = approach(duck.vx, clamp(dx * .95, -160, 160), 1050 * dt);
    duck.crouching = false;
    jump = duck.grounded && (Math.abs(dx) > 80 || Math.random() < dt * .3);
    duck.aim = clamp((target.y - duck.y) / 210, -.75, .75);
    if (Math.abs(dx) < 410 && Math.random() < dt * .9) fire(duck);
  }
  const canBootJump = duck.equipment.boots && !duck.airJump;
  if (jump && !duck.jumpHeld && (duck.coyote > 0 || canBootJump)) { duck.vy = duck.equipment.boots ? -500 : -440; duck.airJump = duck.coyote <= 0; duck.grounded = false; duck.coyote = 0; effect('jump.wav', duck.player ? .18 : .08); }
  duck.jumpHeld = jump;
  const previousX = duck.x, previousY = duck.y;
  if (duck.equipment.jetpack && jump && !duck.grounded && duck.jetFuel > 0) { duck.vy = Math.max(-230, duck.vy - 920 * dt); duck.jetFuel = Math.max(0, duck.jetFuel - dt); } else duck.jetFuel = Math.min(1, duck.jetFuel + dt * .28);
  duck.vy = Math.min(760, duck.vy + (duck.inWater ? 320 : 1080) * dt); duck.x += duck.vx * dt; resolveHorizontal(duck, previousX);
  duck.x = clamp(duck.x, 10, canvas.width - 10); duck.y += duck.vy * dt; resolveVertical(duck, previousY, dt);
  resolveMapObjectInteractions(duck);
  if (duck.y > canvas.height + 80) { duck.alive = false; }
  for (const pickup of pickups) if (!pickup.dead && Math.hypot(duck.x - pickup.x, duck.y - pickup.y) < 26) { applyPickup(duck, pickup); pickup.dead = true; }
}
function update(dt) {
  if (roundIntro > 0) {
    const tick = Math.floor(roundIntro);
    if (tick !== introTick) { introTick = tick; effect('click.wav', .13); }
    roundIntro = Math.max(0, roundIntro - dt);
    if (roundIntro === 0) effect('scoreDing.wav', .24);
    return;
  }
  updateMapState(dt);
  for (const duck of ducks) updateDuck(duck, dt);
  for (const bullet of bullets) { if (bullet.kind === 'rocket') bullet.vy += 120 * dt; if (bullet.kind === 'grenade') bullet.vy += 830 * dt; bullet.x += bullet.vx * dt; bullet.y += bullet.vy * dt; bullet.life -= dt; }
  bullets = bullets.filter((bullet) => {
    if (bullet.life <= 0 || bullet.x < -30 || bullet.x > canvas.width + 30 || bullet.y > canvas.height + 30) { if (bullet.kind === 'grenade') explode(bullet.x, bullet.y, bullet.owner); return false; }
    for (const crate of worldCrates) if (!crate.dead && Math.abs(bullet.x - crate.x) < 15 && Math.abs(bullet.y - crate.y) < 18) { breakCrate(crate); if (bullet.kind === 'rocket' || bullet.kind === 'grenade') explode(bullet.x, bullet.y, bullet.owner); return false; }
    for (const barrel of worldBarrels) if (!barrel.dead && Math.abs(bullet.x - barrel.x) < 14 && Math.abs(bullet.y - barrel.y) < 16) { barrel.hp--; if (barrel.hp <= 0) { barrel.dead = true; if (/Explosive|Yellow/.test(levelClass(barrel.type))) explode(barrel.x, barrel.y, bullet.owner); else pickups.push(pickupFor(barrel.x, barrel.y - 12, weaponTypes[Math.floor(Math.random() * weaponTypes.length)])); } return false; }
    for (const platform of collisionSolids()) if (bullet.x > platform.x && bullet.x < platform.x + platform.w && bullet.y > platform.y && bullet.y < platform.y + platform.h) { if (platform.object?.type?.includes('Block')) platform.object.dead = true; if (bullet.kind === 'rocket') explode(bullet.x, bullet.y, bullet.owner); if (bullet.kind === 'grenade') { bullet.vy *= -.45; bullet.vx *= .68; return bullet.life > .08; } return false; }
    for (const duck of ducks) if (duck.alive && duck.index !== bullet.owner && duck.invulnerable <= 0 && Math.abs(bullet.x - duck.x) < 17 && Math.abs(bullet.y - (duck.y - 5)) < 22) { if (bullet.kind === 'rocket' || bullet.kind === 'grenade') explode(bullet.x, bullet.y, bullet.owner); else if (bullet.kind === 'net') { duck.stunned = 1.25; duck.invulnerable = .2; } else defeatDuck(duck); return false; }
    return true;
  });
  nextPickup -= dt;
  if (nextPickup <= 0) {
    const source = mapPickupSpots[Math.floor(Math.random() * mapPickupSpots.length)];
    const platform = platforms[1 + Math.floor(Math.random() * Math.max(1, platforms.length - 1))];
    pickups.push(pickupFor(source?.x ?? platform.x + 25 + Math.random() * Math.max(1, platform.w - 50), (source?.y ?? platform.y) - 14, source?.contains));
    nextPickup = 2.5 + Math.random() * 2.8;
  }
  pickups.forEach((pickup) => pickup.age += dt); pickups = pickups.filter((pickup) => !pickup.dead && pickup.age < 15);
  particles.forEach((particle) => { particle.x += particle.vx * dt; particle.y += particle.vy * dt; particle.life -= dt; }); particles = particles.filter((particle) => particle.life > 0);
  const alive = ducks.filter((duck) => duck.alive);
  if (roundWinner === null && alive.length <= 1) {
    roundWinner = alive[0]?.index ?? -1;
    if (roundWinner >= 0) { score[roundWinner] += 1; effect('scoreDing.wav', .22); }
    matchOver = roundWinner >= 0 && score[roundWinner] >= winsToTakeMatch;
    spawnClock = matchOver ? 2.6 : 1.8;
  }
  if (roundWinner !== null) { spawnClock -= dt; if (spawnClock <= 0) { if (matchOver) menu.hidden = false; else resetRound(); } }
}
function drawSprite(image, x, y, w, h, flip = false) {
  if (!image?.naturalWidth) return false;
  ctx.save(); ctx.translate(x, y); if (flip) ctx.scale(-1, 1); ctx.drawImage(image, -w / 2, -h / 2, w, h); ctx.restore(); return true;
}
function drawAtlasFrame(image, frame, cellW, cellH, x, y, w, h, flip = false) {
  if (!image?.naturalWidth) return false;
  const columns = Math.floor(image.naturalWidth / cellW), rows = Math.floor(image.naturalHeight / cellH);
  if (!columns || !rows || frame < 0 || frame >= columns * rows) return false;
  const sx = (frame % columns) * cellW, sy = Math.floor(frame / columns) * cellH;
  ctx.save();
  if (flip) { ctx.translate(x + w, y); ctx.scale(-1, 1); ctx.drawImage(image, sx, sy, cellW, cellH, 0, 0, w, h); }
  else ctx.drawImage(image, sx, sy, cellW, cellH, x, y, w, h);
  ctx.restore();
  return true;
}
function drawPickup(pickup) {
  const py = pickup.y + Math.sin(pickup.age * 5) * 3;
  const art = PICKUP_ART[pickup.item?.source];
  let drawn = false;
  if (art) {
    const [asset, cellW, cellH, width, height] = art;
    drawn = drawAtlasFrame(images[asset], 0, cellW, cellH, pickup.x - width / 2, py - height / 2, width, height);
  }
  if (!drawn) {
    const weapon = WEAPONS[pickup.type] || WEAPONS.pistol;
    const render = WEAPON_RENDER[pickup.type] || WEAPON_RENDER.pistol;
    const image = images[weapon.sprite] || images.pistol;
    drawn = image?.naturalWidth && render && drawAtlasFrame(image, 0, render.sw, render.sh, pickup.x - render.w / 2, py - render.h / 2, render.w, render.h);
  }
  // A small shadow makes the floating pickup readable without replacing its
  // sprite with the former coloured square-and-letter marker.
  if (drawn) { ctx.fillStyle = '#07101aa0'; ctx.fillRect(pickup.x - 10, py + 10, 20, 3); }
}
function drawDuck(duck) {
  const alpha = duck.alive ? Math.min(1, 1.4 - duck.spawnTime * 1.4) : Math.max(.12, duck.deathTime / .65); ctx.globalAlpha = alpha;
  // Physics stores the collision bottom at y + 20 while the 32px duck sheet
  // has its visible feet at y + 8. Offset the render anchor so a landed duck
  // visibly stands on the same tile edge used for collision and spawning.
  const crouchScale = duck.crouching ? .72 : 1;
  ctx.save(); ctx.translate(duck.x, duck.y + (duck.crouching ? 14 : 12)); const spawnScale = duck.alive ? 1 + duck.spawnTime * .35 : 1; ctx.scale(duck.dir * spawnScale, spawnScale * crouchScale);
  const moving = Math.abs(duck.vx) > 25;
  const spriteFrame = !duck.alive ? 0 : duck.firePose > 0 ? 3 : !duck.grounded ? 4 : moving ? 1 + Math.floor(duck.animTime * 10) % 3 : 0;
  if (images.duck?.naturalWidth) ctx.drawImage(images.duck, spriteFrame * 32, duck.alive ? 0 : 96, 32, 32, -16, -24, 32, 32);
  else { ctx.fillStyle = colors[duck.index]; ctx.fillRect(-13, -21, 26, 30); ctx.fillStyle = '#f6d449'; ctx.fillRect(9, -14, 12, 7); }
  if (duck.weapon) {
    const weapon = WEAPONS[duck.weapon]; const image = images[weapon.sprite]; const render = WEAPON_RENDER[duck.weapon];
    ctx.save(); ctx.translate(6 - (duck.firePose > 0 ? 4 : 0), -13); ctx.rotate(duck.aim * .34);
    if (image?.naturalWidth && render) {
      const frame = render.frames && duck.firePose > 0 ? 1 : 0;
      ctx.drawImage(image, render.sx + frame * render.sw, render.sy, render.sw, render.sh, 0, -render.h / 2, render.w, render.h);
    } else { ctx.fillStyle = duck.weapon === 'sword' ? '#d5e6ff' : '#e5e8ec'; ctx.fillRect(0, -3, duck.weapon === 'sword' ? 34 : 25, 6); }
    if (duck.firePose > 0) { const muzzle = render?.w ?? 25; ctx.fillStyle = '#fff2a1'; ctx.fillRect(muzzle - 1, -7, 10, 10); ctx.fillStyle = '#ff8c54'; ctx.fillRect(muzzle + 5, -4, 7, 4); }
    ctx.restore();
  }
  if (duck.stunned > 0) { ctx.fillStyle = '#7fe9ff'; ctx.globalAlpha = .65; ctx.fillRect(-11, -29, 22, 3); }
  ctx.restore(); ctx.globalAlpha = 1;
}
function draw() {
  const bg = images[mapBackground]?.naturalWidth ? images[mapBackground] : images.mainBackground;
  ctx.fillStyle = '#253e60'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (bg?.naturalWidth) {
    // Background sheets are authored as small pixel-art panels, so preserve a
    // uniform scale instead of stretching them to the canvas height.
    const bgScale = mapBackground === 'spaceBackground' ? 1.5 : 2;
    const bgW = bg.naturalWidth * bgScale, bgH = bg.naturalHeight * bgScale;
    ctx.globalAlpha = .58;
    for (let y = 0; y < canvas.height; y += bgH) for (let x = 0; x < canvas.width; x += bgW) ctx.drawImage(bg, x, y, bgW, bgH);
    ctx.globalAlpha = 1;
  }
  for (const p of platforms) {
    const scaffolding = p.tileset?.includes('Scaffolding');
    const cell = NARROW_TILE_ART.has(p.tileArt) ? 8 : 16;
    if (!drawAtlasFrame(images[p.tileArt], p.frame, cell, cell, p.x, p.y, p.w, p.h, p.flipHorizontal)) {
      ctx.fillStyle = scaffolding ? '#657184' : (p.frame % 3 === 0 ? '#263144' : '#33445a');
      ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.fillStyle = scaffolding ? '#b7c0ce' : '#f5d965';
      ctx.fillRect(p.x, p.y, p.w, Math.max(2, p.h * .18));
    }
  }
  for (const object of mapObjects) {
    const objectClass = levelClass(object.type);
    if (objectClass === 'PipeBlue' || objectClass === 'PipeGreen' || objectClass === 'PipeRed') {
      const pipeArt = objectClass === 'PipeBlue' ? 'travelPipesBlue' : objectClass === 'PipeGreen' ? 'travelPipesGreen' : 'travelPipes';
      drawAtlasFrame(images[pipeArt], object.pipeFrame ?? 0, 18, 18, object.x - 13, object.y - 13, 26, 26, object.flipHorizontal);
    } else if (objectClass === 'Door') { if (!mapDoors.find((door) => door.x === object.x && door.y === object.y && door.open)) drawAtlasFrame(images.door, object.locked ? 1 : 0, 32, 32, object.x - 22, object.y - 31, 44, 44, object.flipHorizontal); }
    else if (objectClass === 'VerticalDoor') { if (!mapDoors.find((door) => door.x === object.x && door.y === object.y && door.open)) drawAtlasFrame(images.verticalDoor, 0, 16, 32, object.x - 11, object.y - 24, 22, 44, object.flipHorizontal); }
    else if (objectClass === 'Window') { drawSprite(images.window, object.x, object.y + (object.windowHeight || 1) * 7, 12, Math.max(20, (object.windowHeight || 1) * 24), object.flipHorizontal); }
    else if (objectClass === 'StreetLight') { drawSprite(images.streetLight, object.x, object.y - 25, 28, 60, object.flipHorizontal); }
    else if (objectClass === 'HangingCityLight') { drawSprite(images.hangingCityLight, object.x, object.y, 24, 15, object.flipHorizontal); }
    else if (objectClass === 'TreeTop' || objectClass === 'TreeTopDead') { drawSprite(images.treeTop, object.x, object.y, 54, 54, object.flipHorizontal); }
    else if (objectClass === 'Rock') { drawSprite(images.rock01, object.x, object.y, 22, 22, object.flipHorizontal); }
    else if (objectClass === 'Desk') { drawSprite(images.desk, object.x, object.y, 76, 12, object.flipHorizontal); }
    else if (object.type.includes('ItemSpawner')) { drawAtlasFrame(images.itemBoxRandom, 0, 12, 14, object.x - 9, object.y - 12, 18, 21); }
    else if (object.type.includes('ItemBox')) { drawAtlasFrame(images.itemBox, 0, 16, 16, object.x - 11, object.y - 14, 22, 22); }
    else if (object.type.includes('MagBlaster')) { ctx.fillStyle = '#df79ff'; ctx.fillRect(object.x - 8, object.y - 4, 16, 8); }
  }
  for (const hazard of mapHazards) if (!hazard.dead) {
    if (hazard.type.includes('Mine')) drawAtlasFrame(images.mine, 0, 18, 16, hazard.x - 12, hazard.y - 10, 24, 21);
    else drawAtlasFrame(images.spikes, 0, 16, 19, hazard.x - 12, hazard.y - 14, 24, 29, hazard.type.includes('Down'));
  }
  for (const spring of mapSprings) drawAtlasFrame(images.spring, 0, 16, 15, spring.x - 12, spring.y - 11, 24, 23);
  for (const teleporter of mapTeleporters) {
    drawAtlasFrame(images.teleporterTop, 0, 16, 8, teleporter.x - 12, teleporter.y - 17, 24, 12);
    drawAtlasFrame(images.teleporterIcon, 0, 16, 16, teleporter.x - 12, teleporter.y - 5, 24, 24);
    drawAtlasFrame(images.teleporterBottom, 0, 16, 8, teleporter.x - 12, teleporter.y + 18, 24, 12);
  }
  for (const water of mapWater) { const depth = Math.max(20, (water.deep || 3) * 10); ctx.fillStyle = water.type.includes('WaterFall') ? '#78d6ff70' : '#287ed080'; ctx.fillRect(water.x - 25, water.y - depth, 50, depth); ctx.fillStyle = '#b9efff'; ctx.fillRect(water.x - 25, water.y - depth, 50, 2); }
  for (const rope of mapRopes) { ctx.strokeStyle = '#d2b37b'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(rope.x, rope.y - 5); ctx.lineTo(rope.x, rope.y + (rope.length || 5) * 9); ctx.stroke(); }
  for (const saw of mapSaws) { ctx.save(); ctx.translate(saw.x, saw.y); ctx.rotate(lastTime / 90); ctx.fillStyle = '#d9e6ee'; for (let tooth = 0; tooth < 8; tooth++) { ctx.rotate(Math.PI / 4); ctx.fillRect(0, -3, 17, 6); } ctx.fillStyle = '#46505d'; ctx.fillRect(-5, -5, 10, 10); ctx.restore(); }
  for (const laser of mapLasers) if (Math.sin(laser.phase * 3) > .35) { ctx.strokeStyle = '#ff4f75'; ctx.globalAlpha = .7; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(laser.x, laser.y); ctx.lineTo(laser.flipHorizontal ? 0 : canvas.width, laser.y); ctx.stroke(); ctx.globalAlpha = 1; }
  for (const block of mapBlocks) if (!block.dead) { ctx.fillStyle = levelClass(block.type).includes('Ice') ? '#a6e9ff' : '#9c65db'; ctx.fillRect(block.x - 11, block.y - 11, 22, 22); ctx.fillStyle = '#ffffff66'; ctx.fillRect(block.x - 8, block.y - 8, 16, 3); }
  for (const barrel of worldBarrels) if (!barrel.dead) { ctx.fillStyle = /Explosive|Yellow/.test(levelClass(barrel.type)) ? '#e9b84f' : '#5088cc'; ctx.fillRect(barrel.x - 9, barrel.y - 12, 18, 24); ctx.fillStyle = '#263448'; ctx.fillRect(barrel.x - 10, barrel.y - 8, 20, 3); ctx.fillRect(barrel.x - 10, barrel.y + 5, 20, 3); }
  for (const crate of worldCrates) if (!crate.dead) drawAtlasFrame(images.crate, 0, 16, 16, crate.x - 12, crate.y - 16, 24, 24);
  for (const pickup of pickups) drawPickup(pickup);
  for (const bullet of bullets) { ctx.fillStyle = bullet.kind === 'rocket' ? '#ff865d' : bullet.kind === 'grenade' ? '#76c86c' : bullet.kind === 'net' ? '#7fe9ff' : bullet.kind === 'flame' ? '#ffb04e' : '#fff5aa'; if (bullet.kind === 'grenade' || bullet.kind === 'net') ctx.fillRect(bullet.x - 5, bullet.y - 5, 10, 10); else ctx.fillRect(bullet.x - 5, bullet.y - 2, 10, 4); }
  for (const particle of particles) { ctx.globalAlpha = Math.min(1, particle.life * 2); ctx.fillStyle = particle.color; ctx.fillRect(particle.x - 3, particle.y - 3, 6, 6); } ctx.globalAlpha = 1;
  ducks.forEach(drawDuck);
  ctx.fillStyle = '#0c1220cc'; ctx.fillRect(10, 10, 290, 49); ctx.fillStyle = '#fff'; ctx.font = '16px monospace'; ctx.fillText(score.map((wins, index) => `${index === 0 ? 'YOU' : `CPU${index}`}:${wins}`).join('  '), 20, 31); ctx.fillStyle = '#b7c9dc'; ctx.font = '11px monospace'; ctx.fillText(`${mapName} · ${activeMap + 1}/${mapCatalog.length || 1}`, 20, 49);
  const player = ducks[0]; if (player?.weapon) { ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.font = '14px monospace'; ctx.fillText(`${WEAPONS[player.weapon].label} · ${player.reload > 0 ? 'RELOAD' : player.ammo}`, canvas.width - 18, 31); ctx.textAlign = 'left'; }
  if (roundIntro > 0) { const text = roundIntro > 3.4 ? 'GET READY!' : roundIntro > 2.4 ? '3' : roundIntro > 1.4 ? '2' : roundIntro > .45 ? '1' : 'FIGHT!'; ctx.fillStyle = '#08101ed9'; ctx.fillRect(0, 195, canvas.width, 112); ctx.fillStyle = text === 'FIGHT!' ? '#ffe36a' : '#fff'; ctx.textAlign = 'center'; ctx.font = text === 'GET READY!' || text === 'FIGHT!' ? 'bold 42px monospace' : 'bold 62px monospace'; ctx.fillText(text, canvas.width / 2, 266); ctx.textAlign = 'left'; }
  if (roundWinner !== null) { ctx.fillStyle = '#0b1223c9'; ctx.fillRect(0, 212, canvas.width, 88); ctx.fillStyle = '#ffe36a'; ctx.textAlign = 'center'; ctx.font = 'bold 28px monospace'; ctx.fillText(roundWinner < 0 ? 'DRAW!' : `${roundWinner === 0 ? 'YOU' : `CPU ${roundWinner}`}${matchOver ? ' TAKES THE MATCH!' : ' WINS!'}`, canvas.width / 2, 265); ctx.textAlign = 'start'; }
}
function frame(time) { const dt = Math.min(.033, ((time - lastTime) || 16) / 1000); lastTime = time; update(dt); draw(); requestAnimationFrame(frame); }
requestAnimationFrame(frame);
