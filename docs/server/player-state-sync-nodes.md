# OneSync player state data (GTA5): sync-tree nodes + decoded fields

This doc is the **field-level companion** to:
- `docs/player-state.md` (roster/scope/state-bags + “where player state lives”)
- `docs/onesync.md` (OneSync server/client data flow and code map)

It focuses on **GTA5 OneSync** (`STATE_FIVE`) and documents the *decoded* “player state data” that FXServer keeps per replicated entity via **sync trees**.

## What “player state data” means here

In OneSync, gameplay-relevant state (position, camera, wanted level, health, tasks, etc.) is replicated as **entities** (`NetObjEntityType::*`) whose state is serialized into a per-entity **sync tree**.

For “players”, the relevant state is spread across multiple nodes in the **player entity’s sync tree** (plus some nodes that are shared with other entity types, like velocity/orientation).

### Where the schema and parsing live

- **Decoded per-node structs** (“what the server stores/exposes”):
  - `outdated_resources/fivem/code/components/citizen-server-impl/include/state/ServerGameState.h`
  - These are the `*NodeData` structs (e.g. `CPlayerGameStateNodeData`, `CPedHealthNodeData`).
- **Wire parsing** (“what bits/floats get read from clone packets”):
  - `outdated_resources/fivem/code/components/citizen-server-impl/include/state/SyncTrees_Five.h`
  - These are the `*DataNode` parsers (e.g. `CPlayerGameStateDataNode::Parse`).
- **Entity type → sync tree selection**:
  - `outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState_SyncTrees.cpp` (`MakeSyncTree`)

### Build/version conditionals

Many nodes have conditional fields guarded by build checks like `Is2060()`, `Is2699()`, etc. Those helpers are in `ServerGameState.h` and are driven by enforced/default game build logic.

When reading this doc:
- **If a field is guarded by `IsXXXX()`**, it may only exist on that (or newer) game build.
- Some parsed fields are currently read but **not stored** in a `*NodeData` struct (yet). Those are called out as “parsed-only”.

## Access pattern (server-side)

Server-side code reads decoded node data through `SyncTreeBase` accessors like:
- `entity->syncTree->GetPlayerGameState()`
- `entity->syncTree->GetPedHealth()`
- `entity->syncTree->GetPlayerWantedAndLOS()`

The accessor implementations for GTA5 are in `SyncTrees_Five.h` (the `Get*()` methods return pointers to the decoded `data` field inside each node, or `nullptr` if the node is absent).

## Position for player/ped entities

Position is special: it is derived from “sector + offset” nodes and can be adjusted by “standing on” and “in vehicle” logic.

### Inputs used by `SyncTreeBase::GetPosition()`

The GTA5 sync-tree `GetPosition()` implementation combines:
- sector indices (`CSectorDataNode`)
- per-sector offsets (`CSectorPositionDataNode` / `CPlayerSectorPosNode` / `CPedSectorPosMapNode` / `CObjectSectorPosNode`)
- optional “standing on entity” offsets
- optional “if in vehicle, use vehicle position”

Key player/ped nodes involved:

#### `CPlayerSectorPosNode` (player position + standing-on)

Defined in `SyncTrees_Five.h` as `struct CPlayerSectorPosNode` (parsed-only structure, not a `*NodeData` in `ServerGameState.h`).

- **m_posX/m_posY/m_posZ**: per-sector offset components.
- **m_standingOnHandle**: 13-bit handle of the entity the player is “standing on”.
- **m_standingOffsetX/Y/Z**: local offsets from that entity.
- **isStandingOn**: whether standing-on data is present.

#### `CPedSectorPosMapNode` (ped position + standing-on + navmesh flag)

Defined in `SyncTrees_Five.h` as `struct CPedSectorPosMapNode` (serialized, shared across ped-like entities).

- **m_posX/m_posY/m_posZ**: per-sector offset components.
- **isStandingOn**: whether standing-on data is present.
- **isNM**: navmesh-related flag (parsed, semantics not fully documented here).
- **standingOn** and **standingOnOffset[3]**: standing-on handle and offsets.

### Derived world coordinates

The implementation uses the fixed sector scale:
- \(x, y\) sector scale: 54.0
- \(z\) sector scale: 69.0
- \(z\) global offset: -1700.0

And computes:
\[
\text{worldX} = ((sectorX - 512) \cdot 54) + sectorPosX
\]
\[
\text{worldY} = ((sectorY - 512) \cdot 54) + sectorPosY
\]
\[
\text{worldZ} = (sectorZ \cdot 69 + sectorPosZ) - 1700
\]

### Standing-on adjustment

If `CPlayerSectorPosNode::isStandingOn` is set and the standing-on entity exists, `GetPosition()` will add `m_standingOffset*` to the referenced entity’s position.

### “If in a vehicle, use the vehicle’s position”

If `CPedGameStateDataNode` exists and indicates a current vehicle (`curVehicle != -1`), `GetPosition()` will attempt to resolve that vehicle entity and use the vehicle’s position (except for ped/player entities).

## Player camera (`CPlayerCamera*`)

### Storage: `CPlayerCameraNodeData` (`ServerGameState.h`)

Fields:
- **camMode**: integer mode indicator
- **freeCamPosX/Y/Z**: free camera position (when in freecam mode)
- **cameraX/cameraZ**: camera angles (two components)
- **camOffX/camOffY/camOffZ**: camera position offset (when offset mode is active)

### Parsing: `CPlayerCameraDataNode::Parse` (`SyncTrees_Five.h`)

High-level behavior:
- If `freeCamOverride` is set, the node stores:
  - `camMode = 1`
  - `freeCamPos*` + `cameraX/cameraZ`
- Else, if `hasPositionOffset` is set:
  - `camMode = 2`
  - `camOff*` + `cameraX/cameraZ`
- Else:
  - `camMode = 0`
  - `cameraX/cameraZ` still parsed and stored

Notes:
- The parser includes TODOs for additional trailing fields; current decoded shape captures the fields above.

## Wanted / LOS (`CPlayerWantedAndLOS*`)

### Storage: `CPlayerWantedAndLOSNodeData` (`ServerGameState.h`)

Fields:
- **wantedLevel**: integer wanted level
- **fakeWantedLevel**: integer “fake” wanted level (used by some game logic)
- **isWanted**: present in the struct but currently **not assigned** by the parser shown in `SyncTrees_Five.h`
- **isEvading**: set from parsed `isEvading` bit
- **timeInPursuit**: derived from timestamps while wanted; `-1` when not in pursuit
- **timeInPrevPursuit**: previous pursuit duration (snapshotted when leaving wanted state)
- **wantedPositionX/Y/Z**: “wanted” position (only meaningful if wanted)

### Parsing: `CPlayerWantedAndLOSDataNode::Parse` (`SyncTrees_Five.h`)

High-level behavior:
- Reads and stores:
  - `wantedLevel` (3 bits)
  - `fakeWantedLevel` (3 bits)
  - `isEvading` (bit)
- If `isWanted` bit is set:
  - stores `wantedPosition*`
  - reads additional “pos2” (parsed-only)
  - derives `timeInPursuit` from `currentTime - pursuitStartTime`
- Else:
  - clears `wantedPosition*`
  - moves `timeInPursuit → timeInPrevPursuit` once, then resets `timeInPursuit = -1`

## Ped “game state” (`CPedGameState*`)

This node is a compact “what is the ped doing” snapshot used by server logic and convenience natives.

### Storage: `CPedGameStateNodeData` (`ServerGameState.h`)

Fields:
- **curVehicle / curVehicleSeat**: current vehicle entity handle and seat (or `-1`)
- **lastVehicle / lastVehicleSeat**: present in struct; not currently populated by the parser snippet in `SyncTrees_Five.h`
- **lastVehiclePedWasIn**: last vehicle handle (server-side helper)
- **curWeapon**: current weapon hash (32-bit)
- **isHandcuffed**
- **actionModeEnabled**
- **isFlashlightOn**

### Parsing: `CPedGameStateDataNode::Parse` (`SyncTrees_Five.h`)

What the current parser stores into `data`:
- **curWeapon**: set if `hasWeapon`, else left at 0.
- **curVehicle / curVehicleSeat**:
  - set when `inVehicle` and `inSeat`
  - when leaving a vehicle, the code updates `lastVehiclePedWasIn` and clears `curVehicle/curVehicleSeat` to `-1`.
- **isHandcuffed**: set if “custodian/arrest flags” block present.
- **isFlashlightOn**
- **actionModeEnabled**

Parsed-only / ignored (examples):
- weapon visibility flags, tint and components, gadget hashes
- various build-dependent bits
- “killedByStealth / killedByTakedown” bits

## Ped health (`CPedHealth*`)

### Storage: `CPedHealthNodeData` (`ServerGameState.h`)

Fields:
- **maxHealth**
- **health**
- **armour**
- **causeOfDeath**: 32-bit hash/id
- **sourceOfDamage**: entity handle (13-bit on wire; stored as int)

### Parsing: `CPedHealthDataNode::Parse` (`SyncTrees_Five.h`)

High-level behavior:
- If `maxHealthChanged` bit is set, reads and stores `maxHealth` (13 bits).
- If `isFine` bit is **false**, reads and stores `health` (13 bits).
  - Else sets `health = maxHealth`.
- If `noArmour` bit is **false**, reads and stores `armour` (13 bits).
  - Else sets `armour = 0`.
- If `hasSource` bit is set, reads and stores `sourceOfDamage` (13 bits).
  - Else sets `sourceOfDamage = 0`.
- Always reads and stores `causeOfDeath` (32 bits).

Build notes:
- On `Is2060()` there are additional “unknown” conditional reads (currently parsed-only).

## Ped orientation (`CPedOrientation*`)

### Storage: `CPedOrientationNodeData` (`ServerGameState.h`)

Fields:
- **currentHeading**
- **desiredHeading**

### Parsing: `CPedOrientationDataNode::Serialize` (`SyncTrees_Five.h`)

This node uses a generic serializer (read/write) and stores:
- `currentHeading` and `desiredHeading` as signed values with a \(2\pi\) divisor.

## Ped task tree (`CPedTaskTree*`)

This node tracks the current high-level task slots the ped is executing.

### Storage: `CPedTaskTreeDataNodeData` (`ServerGameState.h`)

Fields:
- **scriptCommand**: 32-bit
- **scriptTaskStage**: 3-bit stage on wire (stored as 32-bit)
- **specifics**: 8-bit bitmask controlling which task slots are present
- **tasks[8]**:
  - `type` (10 bits on wire)
  - `active` (bit)
  - `priority` (3 bits)
  - `treeDepth` (3 bits)
  - `sequenceId` (5 bits)

### Parsing: `CPedTaskTreeDataNode::Parse` (`SyncTrees_Five.h`)

High-level behavior:
- Optional script task:
  - if `hasScriptTask`: reads `scriptCommand` and `scriptTaskStage`
  - else sets defaults (`scriptCommand = 0x811E343C`, `scriptTaskStage = 3`)
- Reads `specifics` (8 bits)
- For each slot `i` in 0..7:
  - if `specifics` has bit `i`, reads `type/active/priority/treeDepth/sequenceId`
  - else sets `type` to a build-dependent default (2060+: 531 else 530)

## Player “game state” (`CPlayerGameState*`)

This node holds player-specific modifiers and flags (invincibility, friendly fire, damage modifiers, super jump, voice proximity override, etc.).

### Storage: `CPlayerGameStateNodeData` (`ServerGameState.h`)

Fields that are populated by the current GTA5 parser:
- **playerTeam**
- **airDragMultiplier**
- **maxHealth / maxArmour**
- **neverTarget**
- **spectatorId**
- **randomPedsFlee**
- **everybodyBackOff**
- **voiceProximityOverrideX/Y/Z**
- **isInvincible**
- **isFriendlyFireAllowed**
- **weaponDefenseModifier / weaponDefenseModifier2**
- **weaponDamageModifier**
- **meleeWeaponDamageModifier**
- **isSuperJumpEnabled**

### Parsing: `CPlayerGameStateDataNode::Parse` (`SyncTrees_Five.h`)

Highlights:
- Stores `playerTeam` (6 bits).
- Stores `airDragMultiplier` (optional; defaults to 1.0f).
- Stores `maxHealth/maxArmour` (conditional; else defaults 100/100 in this parser).
- Stores `neverTarget`, `spectatorId` (conditional), `randomPedsFlee`, `everybodyBackOff`.
- Stores `voiceProximityOverride*` when overriding.
- Stores:
  - `isInvincible`
  - `isFriendlyFireAllowed`
  - `weaponDefenseModifier` + `weaponDefenseModifier2`
  - `weaponDamageModifier` (defaults to 1.0f if not set)
  - `meleeWeaponDamageModifier` (defaults to 1.0f if not set)
  - `isSuperJumpEnabled`

Parsed-only / ignored (examples):
- many unknown bits/ints in the middle of the node
- decorator payloads (parsed but not stored into `CPlayerGameStateNodeData`)
- population control sphere values (parsed-only)

## Common “physical” nodes (used by players too)

These aren’t player-only, but are frequently relevant when documenting player state:

- **Velocity**: `CPhysicalVelocityDataNode` → `CPhysicalVelocityNodeData` (`velX/velY/velZ`)
- **Entity orientation**: `CEntityOrientationDataNode` → `CEntityOrientationNodeData` (compressed quaternion)

See:
- `CPhysicalVelocityNodeData` / `CEntityOrientationNodeData` in `ServerGameState.h`
- corresponding parsing/serialization in `SyncTrees_Five.h`

## Practical tip: mapping “what you want” → “which node”

- **Where is the player?** → `GetPosition()` (derived from sector + pos nodes; may be vehicle position)
- **Which vehicle are they in / what weapon?** → `GetPedGameState()`
- **Health/armour + cause of death** → `GetPedHealth()`
- **Wanted level** → `GetPlayerWantedAndLOS()`
- **Camera freecam/offset** → `GetPlayerCamera()`
- **Damage modifiers / invincibility / friendly fire / super jump** → `GetPlayerGameState()`


