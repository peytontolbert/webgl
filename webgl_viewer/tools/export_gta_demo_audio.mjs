import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolDir = dirname(fileURLToPath(import.meta.url));
const viewerDir = resolve(toolDir, '..');
const workspaceDir = resolve(viewerDir, '..');
const gameArg = process.argv.indexOf('--game-path');
const gamePath = resolve(gameArg >= 0 ? process.argv[gameArg + 1] : 'K:/steam/steamapps/common/Grand Theft Auto V');
const exporterProject = resolve(toolDir, 'awc_exporter/AwcExporter.csproj');
const exporterDll = resolve(toolDir, 'awc_exporter/bin/Debug/net8.0/AwcExporter.dll');
const outputDir = resolve(viewerDir, 'assets/gta_audio');
const glockArg = process.argv.indexOf('--glock-wav');
const glockWav = glockArg >= 0 ? resolve(process.argv[glockArg + 1]) : '';

const SETTINGS = Object.freeze({ pistol: '0x0EE4A1FA', trainers: '0xC6396A50', sultan: '0x39DA2754', sultanCollision: '0x00C2FB47' });
const DEFAULT_PED_PUNCH = '0x7C28B42F';
const BANKS = Object.freeze({
    '0x3B8D650B': { archive: 'RESIDENT.rpf', bank: 'weapons.awc' },
    '0x731286CE': { archive: 'WEAPONS_PLAYER.rpf', bank: 'ptl_pistol.awc' },
    '0x974C5B2E': { archive: 'RESIDENT.rpf', bank: 'feet_materials.awc' },
    '0xA2F4BC17': { archive: 'RESIDENT.rpf', bank: 'collision.awc' },
    '0xF205B596': { archive: 'RESIDENT.rpf', bank: 'vehicles.awc' },
});
const PURPOSE_EVENTS = [
    { name: 'distant_horn', archive: 'ONESHOT_AMBIENCE.rpf', bank: 'distant_horns.awc', streams: [0, 3, 7] },
    { name: 'distant_siren', archive: 'SCRIPT.rpf', bank: 'siren_distant.awc', streams: [0, 5], limit: 12 },
    { name: 'bird_call', archive: 'STREAMED_AMBIENCE.rpf', bank: 'country_birds.awc', streams: [0, 3, 8, 11], limit: 16 },
    { name: 'pain_male', archive: 'PAIN.rpf', bank: 'pain_male_mixed_01.awc', streams: [0, 5, 12, 20, 36], limit: 49 },
    { name: 'pain_female', archive: 'PAIN.rpf', bank: 'pain_female_01.awc', streams: [0, 5, 12, 20, 25] },
    { name: 'wasted', archive: 'SCRIPT.rpf', bank: 'mp_wasted.awc', streams: [0], limit: 3 },
];

function run(command, args) {
    const result = spawnSync(command, args, { cwd: workspaceDir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${command} failed:\n${result.stderr || result.stdout || 'no output'}`);
    return result.stdout || '';
}

function streamIndex(file) {
    const match = String(file).match(/_(\d+)\.wav$/i);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function awcHash(hash) {
    return (Number.parseInt(String(hash).replace(/^0x/i, ''), 16) & 0x1fffffff).toString(16).padStart(8, '0').toUpperCase();
}

function role(setting, name) {
    const value = setting?.sounds?.find((entry) => entry.role === name)?.sound;
    if (!value) throw new Error(`Missing ${setting?.hash || 'setting'}/${name} audio role.`);
    return value;
}

function soundSetEntry(root, scriptHash) {
    const entry = root?.entries?.find((value) => value.scriptNameHash === scriptHash);
    if (!entry?.sound) throw new Error(`Missing SoundSet entry ${scriptHash}.`);
    return entry.sound;
}

function randomNode(children) {
    return { type: 'RandomizedSound', variations: children.map((sound) => ({ weight: 1, sound })) };
}

function multitrackNode(children) {
    return { type: 'MultitrackSound', children };
}

function collectSimpleSounds(node, output = new Map()) {
    if (!node || node.missing || node.cycle) return output;
    if (node.type === 'SimpleSound') output.set(`${node.containerHash}:${node.fileHash}`, node);
    if (node.primary) collectSimpleSounds(node.primary, output);
    if (node.fallback) collectSimpleSounds(node.fallback, output);
    for (const child of node.children || []) collectSimpleSounds(child, output);
    for (const variation of node.variations || []) collectSimpleSounds(variation.sound, output);
    for (const entry of node.entries || []) collectSimpleSounds(entry.sound, output);
    return output;
}

function compactGraph(node, paths) {
    if (!node || node.missing || node.cycle) return { type: 'silence' };
    const base = { type: node.type, hash: node.hash, header: node.header || undefined };
    if (node.type === 'SimpleSound') return { ...base, type: 'sample', path: paths.get(`${node.containerHash}:${node.fileHash}`), containerHash: node.containerHash, fileHash: node.fileHash };
    if (node.type === 'RandomizedSound') return { ...base, variations: (node.variations || []).map((entry) => ({ weight: entry.weight, sound: compactGraph(entry.sound, paths) })) };
    if (node.type === 'WrapperSound') return { ...base, minRepeatTime: node.minRepeatTime || 0, primary: compactGraph(node.primary, paths), fallback: compactGraph(node.fallback, paths) };
    const children = (node.children || []).map((child) => compactGraph(child, paths));
    return { ...base, envelope: node.envelope || undefined, selectionMode: node.selectionMode, children };
}

function graphPaths(node, paths = []) {
    if (!node) return paths;
    if (node.path) paths.push(node.path);
    if (node.primary) graphPaths(node.primary, paths);
    if (node.fallback) graphPaths(node.fallback, paths);
    for (const child of node.children || []) graphPaths(child, paths);
    for (const variation of node.variations || []) graphPaths(variation.sound, paths);
    return [...new Set(paths)];
}

await mkdir(outputDir, { recursive: true });
run('dotnet', ['build', exporterProject, '--no-restore']);
const tempRoot = await mkdtemp(join(tmpdir(), 'webglgta-demo-audio-'));
const graphPath = join(tempRoot, 'gameplay-graph.json');
run('dotnet', [exporterDll, 'inspect-gameplay', '--game-path', gamePath, '--output', graphPath,
    ...Object.values(SETTINGS).flatMap((hash) => ['--hash', hash]), '--sound', DEFAULT_PED_PUNCH]);
const source = JSON.parse(await readFile(graphPath, 'utf8'));
const pistol = source.weapons.find((entry) => entry.hash === SETTINGS.pistol);
const trainers = source.shoes.find((entry) => entry.hash === SETTINGS.trainers);
const sultan = source.cars.find((entry) => entry.hash === SETTINGS.sultan);
const collision = source.vehicleCollisions.find((entry) => entry.hash === SETTINGS.sultanCollision);
const defaultPedPunch = source.requestedSounds.find((entry) => entry.hash === DEFAULT_PED_PUNCH);
if (!pistol || !trainers || !sultan || !collision || !defaultPedPunch) throw new Error('One or more authoritative demo audio settings were not resolved.');

const reload = role(pistol, 'reload');
const graphEvents = {
    pistol_fire: multitrackNode([role(pistol, 'fire'), role(pistol, 'report'), role(pistol, 'echo')]),
    footstep_walk: role(trainers, 'walk'),
    footstep_run: role(trainers, 'run'),
    landing: role(trainers, 'land'),
    weapon_reload_clip_out: soundSetEntry(reload, '0x42488321'),
    weapon_reload_clip_in: soundSetEntry(reload, '0xB8F361C5'),
    melee_hit: defaultPedPunch,
    vehicle_door_open: role(sultan, 'doorOpen'),
    vehicle_door_close: role(sultan, 'doorClose'),
    vehicle_collision_low: role(collision, 'smallScrapeImpact'),
    vehicle_collision_high: multitrackNode([role(collision, 'highImpactSweetener'), role(collision, 'deformation'), role(collision, 'impactDebris')]),
    vehicle_suspension: randomNode([role(sultan, 'suspensionUp'), role(sultan, 'suspensionDown')]),
    vehicle_jump_land: role(sultan, 'jumpLand'),
    vehicle_handbrake: role(sultan, 'handbrake'),
};

const simpleSounds = new Map();
for (const graph of Object.values(graphEvents)) collectSimpleSounds(graph, simpleSounds);
const rawBanks = new Map();
for (const [containerHash, bank] of Object.entries(BANKS)) {
    if (![...simpleSounds.values()].some((sound) => sound.containerHash === containerHash)) continue;
    const rawDir = join(tempRoot, containerHash.slice(2));
    await mkdir(rawDir, { recursive: true });
    run('dotnet', [exporterDll, 'export', '--rpf', resolve(gamePath, 'x64/audio/sfx', bank.archive), '--file', bank.bank, '--output', rawDir, '--game-path', gamePath, '--limit', '0']);
    rawBanks.set(containerHash, (await readdir(rawDir)).filter((file) => file.endsWith('.wav')).sort((a, b) => streamIndex(a) - streamIndex(b)).map((file) => join(rawDir, file)));
}

const samplePaths = new Map();
for (const [key, sound] of simpleSounds) {
    const files = rawBanks.get(sound.containerHash) || [];
    const wav = glockWav && sound.containerHash === '0x731286CE' && sound.fileHash === '0x908FBF4A'
        ? glockWav
        : files.find((file) => file.toUpperCase().includes(`_${awcHash(sound.fileHash)}_`));
    if (!wav || (await stat(wav)).size <= 1024) throw new Error(`Missing ${sound.containerHash}/${sound.fileHash} AWC stream.`);
    const filename = `rel_${sound.containerHash.slice(2).toLowerCase()}_${sound.fileHash.slice(2).toLowerCase()}.opus`;
    run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '48k', '-vbr', 'on', '-application', 'audio', join(outputDir, filename)]);
    samplePaths.set(key, `gta_audio/${filename}`);
}

const manifest = { schema: 'webglgta-gta-demo-audio-graph-v2', source: 'GTA V Dat151/Dat54 graph resolved to local AWC streams', settings: SETTINGS, events: {} };
for (const [name, sourceGraph] of Object.entries(graphEvents)) {
    const graph = compactGraph(sourceGraph, samplePaths);
    manifest.events[name] = { graph, layers: graphPaths(graph), source: 'Dat151 -> Dat54 -> AWC' };
}

for (const event of PURPOSE_EVENTS) {
    const rawDir = join(tempRoot, event.name);
    await mkdir(rawDir, { recursive: true });
    run('dotnet', [exporterDll, 'export', '--rpf', resolve(gamePath, 'x64/audio/sfx', event.archive), '--file', event.bank, '--output', rawDir, '--game-path', gamePath, '--limit', String(event.limit || 0)]);
    const wavs = (await readdir(rawDir)).filter((file) => file.endsWith('.wav')).sort((a, b) => streamIndex(a) - streamIndex(b));
    const layers = [];
    for (const [index, selected] of event.streams.entries()) {
        const wav = wavs[selected];
        if (!wav) throw new Error(`${event.name} stream ${selected} was not exported.`);
        const filename = `${event.name}_${index}.opus`;
        run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', join(rawDir, wav), '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '48k', '-vbr', 'on', '-application', 'audio', join(outputDir, filename)]);
        layers.push(`gta_audio/${filename}`);
    }
    manifest.events[event.name] = { archive: event.archive, bank: event.bank, layers, graph: { type: 'random', children: layers.map((path) => ({ type: 'sample', path })) }, source: 'purpose-specific AWC bank' };
}

await writeFile(resolve(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ outputDir, events: Object.keys(manifest.events).length, uniqueRelSamples: samplePaths.size, referencedAssets: Object.values(manifest.events).reduce((count, event) => count + event.layers.length, 0) }, null, 2));
