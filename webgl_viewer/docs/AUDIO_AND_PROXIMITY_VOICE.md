# Audio and proximity voice

## Runtime design

- `js/gameplay/audio_system.js` owns browser audio.
- Environment audio is procedural and does not redistribute GTA audio files.
- Multiplayer microphone audio uses peer-to-peer WebRTC.
- `multiplayer_server.js` relays only targeted WebRTC descriptions and ICE candidates between peers in the same demo room.
- Microphone media is never sent through the Node/WebSocket server.

## Gameplay sound matrix

Gameplay effects are synthesized from controller events and routed through a dedicated effects bus. This avoids redistributing GTA sound files while keeping sound timing tied to the simulation.

| System | Sounds |
| --- | --- |
| Player | Walk and sprint footsteps, jump, landing |
| Weapons | Draw, holster, reload, attachment install, empty trigger, layered gunshot and tail |
| Melee | Swing, body impact, knockdown/death landing |
| Vehicle | Engine RPM, road/tire noise, skid, door enter/exit, pedestrian strike and crash impact |
| Environment | Low city bed, wind, birds, distant horns and sirens |

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
