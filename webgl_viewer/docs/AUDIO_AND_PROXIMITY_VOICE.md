# Audio and proximity voice

## Runtime design

- `js/gameplay/audio_system.js` owns browser audio.
- Demo gameplay events use locally extracted AWC one-shots selected through GTA's Dat151/Dat54 graph. Vehicle engines use decoded granular AWC banks plus REL controller values.
- Procedural layers remain for the continuous city/wind bed and wheel contact because those are mixed continuously from simulation state.
- Multiplayer microphone audio uses peer-to-peer WebRTC.
- `multiplayer_server.js` relays only targeted WebRTC descriptions and ICE candidates between peers in the same demo room.
- Microphone media is never sent through the Node/WebSocket server.

## Gameplay sound matrix

Gameplay effects are routed from controller events through a dedicated effects bus. The runtime preloads the event manifest after Web Audio is unlocked. The v2 manifest preserves Dat54 multitracks, weighted randomization, wrappers, volume/pitch variance, pre-delay, and volume envelopes instead of flattening every event to a random clip.

| System | Sounds |
| --- | --- |
| Player | Verified trainer walk/run variants and landing; jump-off is silent because the active shoe graph has no verified jump event |
| Weapons | Layered pistol fire/report/echo graph, FiveM Glock core layer, and GTA pistol `clipout`/`clipin`; unverified dry-fire and handling events are silent |
| Melee | Verified default collision-material punch graph on contact; air swings are silent |
| Vehicle | REL/granular engine RPM, Sultan doors, suspension, jump landing, handbrake, and low/high collision graphs; continuous road/tire/skid remains simulation-driven |
| Environment | Low city bed, wind, birds, distant horns and sirens |

`assets/gta_audio/manifest.json` records the executable graph, setting hashes, AWC stream hashes, and deployed Opus paths. Run `node tools/export_gta_demo_audio.mjs --game-path <gta-dir> --glock-wav <override>` to regenerate it. Run `node tools/test_gta_demo_audio_assets.mjs` after extraction; the test rejects missing events, missing graph roots, invalid public paths, and absent or undersized files. `dotnet ... AwcExporter.dll inspect-gameplay --hash ... --sound ...` regenerates the focused diagnostic graph used to prove mappings.

Vehicle coverage is validated separately with `node tools/test_gta_vehicle_audio_assets.mjs`: the current catalog has 85 REL controllers, 65 granular banks, and 390 clips with no unresolved controller-to-bank links.

`Gameplay sounds` and `Effects volume` are available under Settings > Audio. The audio status shows the most recently triggered effect for diagnostics. Browsers start Web Audio suspended; the first gameplay click resumes it.

## FiveM voice contract

The source server runs `pma-voice` with native audio disabled. The browser mirrors its default modes:

| Mode | GTA units |
| --- | ---: |
| Whisper | 3 |
| Normal | 7 |
| Shouting | 15 |

Normal is the default. `F11` cycles the range and `N` is push-to-talk after microphone access is enabled.

## Browser security

Web Audio ambience works over HTTP. Browser microphone capture does not: `getUserMedia` requires a trusted HTTPS origin or localhost. The current `http://192.168.0.85:5173/demo` deployment therefore reports `Microphone requires HTTPS or localhost` instead of silently failing.

For online voice, place the demo behind a domain with a trusted TLS certificate and proxy both `/demo` and the `/__multiplayer` WebSocket endpoint. A TURN server may also be required when peers cannot establish a direct WebRTC path across restrictive NAT or firewalls.

This browser room mirrors `pma-voice` proximity behavior; it is not a Mumble client and does not directly join the FiveM server's Mumble voice channel.
