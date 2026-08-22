import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolDir = dirname(fileURLToPath(import.meta.url));
const viewerDir = resolve(toolDir, '..');
const workspaceDir = resolve(viewerDir, '..');
const gameArg = process.argv.indexOf('--game-path');
const gamePath = resolve(gameArg >= 0 ? process.argv[gameArg + 1] : 'K:/steam/steamapps/common/Grand Theft Auto V');
const rpfPath = resolve(gamePath, 'x64/audio/sfx/STREAMED_VEHICLES_GRANULAR.rpf');
const exporterProject = resolve(toolDir, 'awc_exporter/AwcExporter.csproj');
const exporterDll = resolve(toolDir, 'awc_exporter/bin/Debug/net8.0/AwcExporter.dll');
const outputDir = resolve(viewerDir, 'assets/vehicle_audio/granular');
const manifestPath = resolve(viewerDir, 'assets/vehicle_audio/manifest.json');

// GTA's granular banks expose named engine/exhaust clips. Unlike the ordinary
// vehicle archive, these contain the source material the game uses for RPM
// granular playback rather than unordered supporting streams.
const fallbackBanks = Object.freeze({
    hybrid: 'saloon_3_jp_v6_hybrid.awc',
    rig_1: 'truck_medium_us_6cyl.awc',
    supercar_1: 'supercar_1_eur_flat6.awc',
    muscle_car_1: 'musclecar_1_us_v8.awc',
    '4_cylinder_sport_1': 'sportscar_1_eur_4cyl.awc',
    v8_luxury_1: 'saloon_2_eur_v6.awc',
    regular_saloon_1: 'saloon_1_eur_4cyl.awc',
});
const clipNames = ['engine_idle', 'engine_accel', 'engine_decel', 'exhaust_idle', 'exhaust_accel', 'exhaust_decel'];

function jenkinsHash(value) {
    let hash = 0;
    for (const character of String(value || '').toLowerCase()) {
        hash = (hash + character.charCodeAt(0)) >>> 0;
        hash = (hash + (hash << 10)) >>> 0;
        hash ^= hash >>> 6;
    }
    hash = (hash + (hash << 3)) >>> 0;
    hash ^= hash >>> 11;
    hash = (hash + (hash << 15)) >>> 0;
    return `0x${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

async function exportedAudioNames() {
    const names = new Set(['SULTAN']);
    const directory = resolve(viewerDir, 'assets/custom_vehicles');
    for (const file of await readdir(directory)) {
        if (!file.endsWith('.json') || file === 'index.json') continue;
        try {
            const data = JSON.parse(await readFile(join(directory, file), 'utf8'));
            const audioNameHash = String(data?.vehicle?.audioNameHash || '').trim().toUpperCase();
            if (audioNameHash) names.add(audioNameHash);
        } catch { /* Ignore incomplete optional vehicle exports. */ }
    }
    return [...names].sort();
}

function copySoundController(sound) {
    if (!sound) return null;
    return {
        granularClock: sound.granularClock || [],
        loopRandomisationChangeRate: Number(sound.loopRandomisationChangeRate) || 0,
        loopRandomisationPitchFraction: Number(sound.loopRandomisationPitchFraction) || 0,
        channels: (sound.channels || []).map((channel, index) => ({
            granularClockIndex: Number(channel.granularClockIndex) || 0,
            stretchToMinPitch: Number(channel.stretchToMinPitch) || 0,
            stretchToMaxPitch: Number(channel.stretchToMaxPitch) || 0,
            maxLoopProportion: Number(channel.maxLoopProportion) || 0,
            volume: Number(sound.channelVolumes?.[index]) || 0,
        })),
    };
}

function relControllers(rel, audioNames) {
    const cars = new Map((rel.car || []).map((entry) => [entry.hash, entry]));
    const granular = new Map((rel.granular || []).map((entry) => [entry.hash, entry]));
    const sounds = new Map((rel.granularSounds || []).map((entry) => [entry.hash, entry]));
    const controllers = {};
    for (const audioNameHash of audioNames) {
        const car = cars.get(jenkinsHash(audioNameHash));
        const engine = car && granular.get(car.granularEngine);
        if (!car || !engine) continue;
        const engineSound = sounds.get(engine.engineAccel);
        const exhaustSound = sounds.get(engine.exhaustAccel);
        if (!engineSound && !exhaustSound) continue;
        const container = engineSound?.channels?.[0]?.container || exhaustSound?.channels?.[0]?.container || '';
        controllers[audioNameHash] = {
            source: 'GTA base/update/DLC audio REL',
            car: {
                openness: Number(car.openness) || 0,
                interiorViewEngineOpenness: Number(car.interiorViewEngineOpenness) || 0,
                maxRollOffScalePlayer: Number(car.maxRollOffScalePlayer) || 0,
            },
            granular: {
                masterVolume: Number(engine.masterVolume) || 0,
                engineVolumePreSubmix: Number(engine.engineVolumePreSubmix) || 0,
                exhaustVolumePreSubmix: Number(engine.exhaustVolumePreSubmix) || 0,
                engineVolumePostSubmix: Number(engine.engineVolumePostSubmix) || 0,
                exhaustVolumePostSubmix: Number(engine.exhaustVolumePostSubmix) || 0,
                accelVolumePreSubmix: Number(engine.accelVolumePreSubmix) || 0,
                decelVolumePreSubmix: Number(engine.decelVolumePreSubmix) || 0,
                idleVolumePreSubmix: Number(engine.idleVolumePreSubmix) || 0,
                engineRevsVolumePreSubmix: Number(engine.engineRevsVolumePreSubmix) || 0,
                exhaustRevsVolumePreSubmix: Number(engine.exhaustRevsVolumePreSubmix) || 0,
                engineThrottleVolumePreSubmix: Number(engine.engineThrottleVolumePreSubmix) || 0,
                exhaustThrottleVolumePreSubmix: Number(engine.exhaustThrottleVolumePreSubmix) || 0,
                engineMaxConeAttenuation: Number(engine.engineMaxConeAttenuation) || 0,
                exhaustMaxConeAttenuation: Number(engine.exhaustMaxConeAttenuation) || 0,
                engineRevsVolumePostSubmix: Number(engine.engineRevsVolumePostSubmix) || 0,
                exhaustRevsVolumePostSubmix: Number(engine.exhaustRevsVolumePostSubmix) || 0,
                engineThrottleVolumePostSubmix: Number(engine.engineThrottleVolumePostSubmix) || 0,
                exhaustThrottleVolumePostSubmix: Number(engine.exhaustThrottleVolumePostSubmix) || 0,
                engineIdleVolumePostSubmix: Number(engine.engineIdleVolumePostSubmix) || 0,
                exhaustIdleVolumePostSubmix: Number(engine.exhaustIdleVolumePostSubmix) || 0,
                gearChangeWobbleLength: Number(engine.gearChangeWobbleLength) || 0,
                gearChangeWobbleSpeed: Number(engine.gearChangeWobbleSpeed) || 0,
                gearChangeWobblePitch: Number(engine.gearChangeWobblePitch) || 0,
                gearChangeWobbleVolume: Number(engine.gearChangeWobbleVolume) || 0,
                engineClutchAttenuationPostSubmix: Number(engine.engineClutchAttenuationPostSubmix) || 0,
                exhaustClutchAttenuationPostSubmix: Number(engine.exhaustClutchAttenuationPostSubmix) || 0,
                exhaustProximityVolumePostSubmix: Number(engine.exhaustProximityVolumePostSubmix) || 0,
                startupRevsVolumeBoostEnginePostSubmix: Number(engine.startupRevsVolumeBoostEnginePostSubmix) || 0,
                startupRevsVolumeBoostExhaustPostSubmix: Number(engine.startupRevsVolumeBoostExhaustPostSubmix) || 0,
                revLimiterGrainsToPlay: Number(engine.revLimiterGrainsToPlay) || 0,
                revLimiterGrainsToSkip: Number(engine.revLimiterGrainsToSkip) || 0,
                revLimiterApplyType: Number(engine.revLimiterApplyType) || 0,
                revLimiterVolumeCut: Number(engine.revLimiterVolumeCut) || 0,
            },
            engine: copySoundController(engineSound),
            exhaust: copySoundController(exhaustSound),
            container,
        };
    }
    return controllers;
}

function addExactBanks(controllers, containerMap) {
    const bankSources = new Map(Object.entries(fallbackBanks).map(([bank, sourceBank]) => [bank, {
        rpf: rpfPath,
        file: sourceBank,
        sourceBank,
    }]));
    const sourceByContainer = new Map((containerMap?.containers || []).map((source) => [source.container, source]));
    for (const controller of Object.values(controllers)) {
        const source = sourceByContainer.get(controller.container);
        if (!source) continue;
        const bank = `rel_${String(source.container).replace(/^0x/i, '').toLowerCase()}`;
        controller.bank = bank;
        bankSources.set(bank, source);
    }
    return bankSources;
}

function run(command, args) {
    const result = spawnSync(command, args, { cwd: workspaceDir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${command} failed:\n${result.stderr || result.stdout || 'no output'}`);
    return result.stdout || '';
}

function exportedStreams(log) {
    const streams = new Map();
    for (const line of String(log || '').split(/\r?\n/)) {
        const [file, streamName] = line.split('\t');
        if (file?.endsWith('.wav') && streamName) streams.set(streamName.trim().toLowerCase(), file.trim());
    }
    return streams;
}

function compactGranularMetadata(model) {
    const streams = new Map((model?.streams || []).map((stream) => [String(stream?.name || '').toLowerCase(), stream]));
    const metadata = {};
    for (const clipName of clipNames) {
        const stream = streams.get(clipName);
        const grains = Array.isArray(stream?.grains) ? stream.grains : [];
        const sampleCount = Math.max(1, Math.trunc(Number(stream?.sampleCount) || 0));
        if (!stream || !grains.length || sampleCount <= 1) continue;
        const compactGrains = grains.map((grain) => [
            Math.max(0, Math.min(sampleCount - 1, Math.trunc(Number(grain?.offset) || 0))),
            Math.max(0.001, Number(grain?.nativeRate ?? grain?.duration) || 0.001),
        ]);
        const loops = (Array.isArray(stream.loops) ? stream.loops : [])
            .map((loop) => (Array.isArray(loop?.grains) ? loop.grains : [])
                .map((index) => Math.trunc(Number(index)))
                .filter((index) => index >= 0 && index < compactGrains.length))
            .filter((loop) => loop.length);
        // Idle clips carry grain markers but no explicit loop table. Their
        // marker order is the authored sequence and is therefore the loop.
        metadata[clipName] = {
            sampleCount,
            grains: compactGrains,
            loops: loops.length ? loops : [compactGrains.map((_, index) => index)],
        };
    }
    return metadata;
}

run('dotnet', ['build', exporterProject, '--no-restore']);
await mkdir(outputDir, { recursive: true });
const tempRoot = await mkdtemp(join(tmpdir(), 'webglgta-awc-'));
const relPath = join(tempRoot, 'vehicle_audio_rel.json');
run('dotnet', [exporterDll, 'inspect-rel-all', '--output', relPath, '--game-path', gamePath]);
const rel = JSON.parse(await readFile(relPath, 'utf8'));
const audioNames = await exportedAudioNames();
const controllers = relControllers(rel, audioNames);
const containerHashes = [...new Set(Object.values(controllers).map((controller) => controller.container).filter(Boolean))];
const containerMapPath = join(tempRoot, 'vehicle_audio_containers.json');
run('dotnet', [exporterDll, 'find-containers', '--hashes', containerHashes.join(','), '--output', containerMapPath, '--game-path', gamePath]);
const containerMap = JSON.parse(await readFile(containerMapPath, 'utf8'));
const bankSources = addExactBanks(controllers, containerMap);
const manifest = {
    schema: 'webglgta-gta-vehicle-rel-granular-v5',
    source: 'local GTA V granular AWC grains/loops plus base/update/DLC audio REL via CodeWalker',
    banks: {},
    controllers,
};

for (const [bank, source] of bankSources) {
    const rawDir = join(tempRoot, bank);
    await mkdir(rawDir, { recursive: true });
    const exportLog = run('dotnet', [exporterDll, 'export', '--rpf', source.rpf, '--file', source.file, '--output', rawDir, '--game-path', gamePath]);
    const granularPath = join(rawDir, 'granular.json');
    run('dotnet', [exporterDll, 'inspect-granular', '--rpf', source.rpf, '--file', source.file, '--output', granularPath, '--game-path', gamePath]);
    const granular = compactGranularMetadata(JSON.parse(await readFile(granularPath, 'utf8')));
    const streams = exportedStreams(exportLog);
    const clips = {};
    for (const clipName of clipNames) {
        const wav = streams.get(clipName);
        if (!wav || (await stat(join(rawDir, wav))).size <= 1_024) throw new Error(`${bank} is missing granular ${clipName}.`);
        const target = `${bank}_${clipName}.opus`;
        run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', join(rawDir, wav), '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '48k', '-vbr', 'on', '-application', 'audio', join(outputDir, target)]);
        clips[clipName] = `vehicle_audio/granular/${target}`;
    }
    manifest.banks[bank] = { sourceBank: source.sourceBank, clips, granular };
}

await mkdir(dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
console.log(JSON.stringify({
    outputDir,
    banks: Object.keys(manifest.banks),
    clipCount: Object.values(manifest.banks).reduce((count, bank) => count + Object.keys(bank.clips).length, 0),
    relControllerCount: Object.keys(controllers).length,
    exactBankCount: [...new Set(Object.values(controllers).map((controller) => controller.bank).filter(Boolean))].length,
    unresolvedControllerBanks: Object.entries(controllers).filter(([, controller]) => !controller.bank).map(([audioNameHash]) => audioNameHash),
    unprofiledAudioNames: audioNames.filter((name) => !controllers[name]),
}, null, 2));
