# Client spawn: how the “world map” streams in + where the player ped is placed

This doc explains the **client-side** flow (in this repo) from:

- connecting → character selection
- choosing/creating a character
- selecting a spawn (or skipping selection)
- **loading/streaming the world around the spawn** (“world map build”)
- placing the **real player ped** in the world and releasing camera/control

It’s a companion to:
- `docs/onesync.md` (OneSync clone streaming: entities, scope, packed clones/acks)
- `docs/player-state.md` (player scope + state bags + OneSync player ped replication)

## Key idea: “world map build” is mostly implicit streaming

In GTA/FiveM, the map, collision, props, and interiors stream in based on the **current streaming focus** (camera/player position).

In these NX resources, the client typically “builds the world” at spawn by:
- placing a scripted camera (often high above the spawn)
- temporarily moving the player ped to the target coords during the spawn UI

This implicitly triggers world streaming around those coordinates without explicitly calling streaming natives like `NewLoadSceneStart()` / `LoadScene()` / `RequestCollisionAtCoord()` in the spawn resources.

## Files you’ll care about

- `resources/[nx]/nx-mod-multicharacter/client/main.lua`
  - character selection scene: hides player ped, spawns preview ped, creates preview camera
  - handles “spawn at last location” and “default spawn” teleports
- `resources/[nx]/nx-mod-multicharacter/server/main.lua`
  - decides whether to: spawn default, spawn last location, open spawn UI, or open apartments UI
- `resources/[nx]/nx-mod-multicharacter/config.lua`
  - preview ped coords, preview camera coords, “hidden coords”, default spawn coords
- `resources/[nx]/nx-mod-spawn/client.lua`
  - spawn selection UI camera transitions + final spawn placement
- `resources/[nx]/nx-mod-apartments/client/main.lua`
  - apartment entry coords (used by spawn selection / last-location re-entry)

## Phase 0: client network session starts → multicharacter kicks off

`nx-mod-multicharacter` starts the character flow once the session is active:
- waits for `NetworkIsSessionStarted()`
- then calls `chooseChar()`

This is the earliest point where it is safe(ish) to start doing scripted cameras, NUI, and ped repositioning.

## Phase 1: character selection “preview scene”

### 1.1 Hide the real player ped (so selection happens off-screen)

On the client, `chooseChar()`:
- fades out
- loads an interior (if configured)
- freezes the real player ped
- moves the real player ped to `Config.HiddenCoords`

Purpose:
- keep the real player ped somewhere harmless while the user is in the selection UI

### 1.2 Spawn the preview ped

The “character preview ped” is created via `CreatePed(...)` at:
- `Config.PedCoords` (a `vector4`)

This preview ped is not your actual player ped; it’s just what the selection UI renders.

### 1.3 Create the preview camera

The selection camera is created from:
- `Config.CamCoords` (a `vector4`)

The camera is activated via `RenderScriptCams(true, ...)`.

Important:
- This is **only** a client-side scripted camera.
- It is not “replicated” by OneSync; it’s purely local view control.

## Phase 2: user chooses a character → server loads it

When the user picks a character, the client triggers server-side character load.

On the server, after login/preload completes, `nx-mod-multicharacter/server/main.lua` decides which spawn path to take:

- **SkipSelection path**: directly spawn the player (usually to default or last known position)
- **Spawn UI path**: open `nx-mod-spawn` UI so the player can choose a location
- **Apartments path**: open apartments spawn flow (when configured/started)

## Phase 3: spawn decision → where spawn coords come from

There are a few distinct coordinate sources used by the client spawn flow:

- **Default spawn**: `nx-mod-multicharacter/config.lua` `Config.DefaultSpawn` (vector3)
- **Last location**: a `{x,y,z,w}` table sent by the server event `...:client:spawnLastLocation`
- **Spawn selector “normal” locations**: `NX.Spawns[location].coords` (vector4) in `nx-mod-spawn`
- **House spawns**: `Houses[house].coords.enter` (from housing config)
- **Apartment spawns**: `Apartments.Locations[name].coords.enter`
- **Current location**: `PlayerData.position` via `NxBridge:GetPlayerData(...)`

## Phase 4A: SkipSelection / direct spawn (`nx-mod-multicharacter`)

### Default spawn teleport (new character path)

On the client, `closeNUIdefault()` teleports the **real** player ped to:
- `Config.DefaultSpawn`

It also ensures scripted cameras are torn down:
- disables/destroys `cam`
- `RenderScriptCams(false, ...)`
- calls `skyCam(false)` as a defensive cleanup

### Last location spawn teleport (existing character path)

On the client, `spawnLastLocation(coords, cData)` teleports the real player ped to:
- `coords.x, coords.y, coords.z`
- sets heading from `coords.w`

Then it may re-enter an interior if the player disconnected “inside”:
- housing last location
- apartments last location

## Phase 4B: Spawn selector UI (`nx-mod-spawn`)

This is the path when multicharacter decides to open the spawn UI:
- server triggers `nx-spawn:client:setupSpawns`
- server triggers `nx-spawn:client:openUI`

### 4B.1 Open UI = create an initial “high altitude” camera

`nx-spawn:client:openUI`:
- hides the real player ped (`SetEntityVisible(PlayerPedId(), false)`)
- creates a camera at `PlayerData.position` but **far above** (z + 1500)
- activates `RenderScriptCams(true, ...)`

This effectively “builds” the map around the player’s stored position by forcing a streamed view.

### 4B.2 Hover camera over candidate spawns + move player ped to those coords

When the user highlights a spawn option, the UI calls `setCam`:
- `SetCam(campos)` creates an interpolated camera sequence:
  - first from very high altitude (z + 1500), pointing at the spawn
  - then closer (z + 50)
- **also moves the real player ped** to `campos`:
  - `SetEntityCoords(PlayerPedId(), campos.x, campos.y, campos.z)`

Why move the ped during the UI?
- Even if the ped is invisible, moving it helps the engine stream the correct area (world/collision) around the candidate location.

### 4B.3 Confirm spawn = final placement + cleanup

When the player confirms, `spawnplayer`:
- fades out
- places the player ped at the final coords + heading
- calls `NxBridge:EmitPlayerLoaded()`
- destroys scripted cameras and re-shows the player ped
- fades in

If “inside” metadata indicates the player was in a house/apartment, it triggers the appropriate “LastLocationHouse” client event to re-enter the interior.

## Where OneSync fits (what’s actually replicated)

Everything above is local client orchestration: camera, NUI, teleporting the local player ped.

The “real world” (networked entities) arrives through OneSync:
- server decides scope and streams entities as packed clones
- client’s clone manager instantiates/updates entities

See:
- `docs/onesync.md` (clone packets / scope / streaming)
- `docs/player-state.md` (player scope events + state bags + player ped replication)

## Debugging tips (practical)

- If you see a “black screen”, it’s often because a scripted camera is still active:
  - check `RenderScriptCams(false, ...)` cleanup paths
- If you spawn into void/no-collision temporarily:
  - it’s likely streaming lag; in this repo the spawn code does not explicitly wait for collision to load
  - the spawn UI mitigates by hovering cams and moving the ped to the target coords before confirm


