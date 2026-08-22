# WebGL GTA demo gameplay

## Live routes

- Demo: `http://192.168.0.85:5173/demo`
- clothingpack5m selector: `http://192.168.0.85:5173/clothing`
- Multiplayer socket: `ws://192.168.0.85:5173/__multiplayer`

The clothing selector catalogs every discovered clothingpack5m drawable and texture. Selecting **Queue selected** writes the exact subset to `data/clothing_selection.json` on the demo server. Cards are metadata previews, not rendered GTA garments. Selected `.ydd` and `.ytd` files still need CodeWalker conversion before a browser can show real 3D previews or equip them.

## Server authority

`multiplayer_server.js` owns and validates:

- Character health, armor, death, five-second respawn, money, pistol ammo, appearance, owned vehicle damage, and reconnect position.
- Pistol cooldown, ammo consumption, ray target selection, damage, melee range, melee damage, event deduplication, and movement-speed corrections.
- Shared NPC state, civilian fleeing, wanted level, police spawning/pursuit/fire, NPC damage, death, corpse timeout, and respawn.
- Armor, ammo, and cash pickup proximity, rewards, availability, and 30-second respawn.

Profiles are stored atomically in `data/multiplayer_profiles.json` and recovered with an opaque browser resume token. This is suitable for the LAN demo. Public internet hosting still needs HTTPS/WSS, authenticated accounts, token rotation, rate limiting at the proxy, and a real database.

## Browser systems

- Replicated players interpolate position, heading, gait, combat pose, health, armor, appearance identifiers, vehicle state, and proximity voice state.
- Remote gunshot, melee, footsteps, and vehicle-damage events feed positional audio.
- The GTA-style HUD contains radar, health, armor, money, wanted level, weapon/ammo, synchronized pickups, and a Tab weapon wheel.
- Vehicle collision damage, body roll, basic suspension response, and player/NPC impact damage are implemented on the current Sultan controller.

## Verification

Run before deployment:

```powershell
node tools/test_multiplayer_authority.mjs
npx.cmd vite build --emptyOutDir=false
```

Test the deployed server with two WebSocket players, authoritative damage, ammo consumption, movement rejection, and pickup collection:

```powershell
node tools/test_deployed_multiplayer.mjs ws://192.168.0.85:5173/__multiplayer
```

## Remaining GTA fidelity

The following are not complete and should not be described as GTA-equivalent yet:

- Actual 3D clothing thumbnails and selected-subset `.ydd`/`.ytd` conversion.
- Multiple converted vehicle models, wheel/contact physics, doors and entry clips, carjacking, traffic, ownership UI, customization, weapons, and destruction visuals.
- Exported navigation meshes, full pathfinding, conversations, cover decisions, groups, road traffic, and GTA police dispatch behavior.
- Additional converted weapon models and animations, weapon pickups beyond ammo, explosives, projectiles, cover, crouched aiming, executions, and takedowns.
- Sampled GTA material/vehicle/weapon/pedestrian audio. Current procedural effects and remote event synchronization are functional substitutes.
- Microphone voice on the HTTP route. Browser microphone access requires HTTPS and voice transport should use a production TURN service.

These items depend on converted assets or larger domain systems. Add them incrementally while retaining the server action validation contract above.
