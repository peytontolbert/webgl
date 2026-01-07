# Server-controlled “player entities” (bots) vs real players (OneSync)

This doc explains what it means to “make a `playerEntity` controlled through programs” in this codebase, and what is and isn’t possible in FXServer/OneSync.

It complements:
- `docs/onesync.md` (OneSync data flow)
- `docs/player-state.md` (player scope/state routing)
- `docs/player-state-sync-nodes.md` (field-level player/ped sync-tree schema)

## Key distinction: **real player entity** vs **script-created entities**

### 1) A real OneSync “player entity” is tied to a connected client

In OneSync, each connected client eventually has a replicated entity of type `NetObjEntityType::Player` (the player ped entity). That entity is **created/synced by the client** through the clone stream (`netClones`) and parsed server-side.

FXServer stores a script-facing handle to that entity on the `fx::Client` as **`playerEntity`**.

What this is used for:
- Let server scripts call “player-state” natives that operate on the player’s entity/sync tree (wanted level, etc.).
- Provide a consistent way to map `player netId → player entity handle`.

Where it’s wired:
- When the server processes a clone packet for an entity of type `Player`, it stores:
  - `clientData->playerEntity = entity;`
  - `client->SetData("playerEntity", MakeScriptHandle(entity));`
  - See `outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp`.

### 2) Script-created entities are **not** real “players”

Server scripts can create replicated entities like **peds, vehicles, objects** using server-side natives (implemented in `ServerSetters.cpp`). These entities:
- **do not** have a player `netId`
- **do not** automatically behave like a human player
- may have **no network owner initially** (until OneSync assigns/migrates ownership)

So: you *can* create a “bot-like ped”, but you *cannot* create a new real `player` (new netId / connection) purely server-side.

## How server-side scripts create replicated entities

The server registers creation natives such as:
- `CREATE_PED`
- `CREATE_AUTOMOBILE`
- `CREATE_VEHICLE_SERVER_SETTER`
- `CREATE_OBJECT_NO_OFFSET`

Implementation overview:
- The native builds a sync tree (e.g. `MakePed(...)` returns a `CPedSyncTree`) and sets initial nodes (position/orientation/script ownership).
- It then calls `ServerGameState::CreateEntityFromTree(type, tree)` to allocate an object ID and insert it into the server’s replicated entity world.
- It returns a script handle from `ServerGameState::MakeScriptHandle(entity)`.

Code pointers:
- `outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerSetters.cpp`
- `outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp` (`CreateEntityFromTree`, `MakeScriptHandle`)

### Script ownership: “created by resource X”

These server-created entities are tagged with a script hash via `CEntityScriptInfoDataNode`:
- `cdn.m_scriptHash = resourceHash;`

That script hash is later used for ownership classification (e.g. “owned by server script” vs “owned by client script”).

## How “control” actually works (important limitation)

OneSync is **network-authoritative** in the sense that:
- The server decides relevancy/scope and routes clone/state-bag data.
- But **simulation** (movement, physics, AI tasks) is **not run by FXServer**.

Practically:
- Entities only meaningfully *move/change* when some **client** is producing updates for them (sending clone syncs), or when server-side code explicitly mutates sync-tree nodes (only done for some nodes/creation paths).
- A “bot” that walks/drives/fights typically requires a **client-side controller** (a real FiveM client, or an embedded/headless bot client) that:
  - owns the bot ped entity
  - runs tasks / AI / movement
  - emits clone updates to the server for replication to others

### What the server can do reliably without a bot client

- **Spawn entities** into the replicated world (they’ll replicate to relevant clients).
- **Attach metadata** via state bags (`entity:<id>` bags) for scripts/clients.
- **Manage lifecycle**: orphan mode, deletion, routing bucket, etc.

### What the server cannot do by itself

- Create a new *real player* (no new `fx::Client`, no netId, no “playerEntity” in the client registry).
- Run full GTA ped AI/physics to “drive” a bot from the server alone.

## Recommended “program-controlled player” patterns

### Pattern A: “Bot ped” + bot-controller client (most realistic)

- Server creates a ped via `CREATE_PED`.
- Server ensures it stays alive (see orphan mode below).
- A dedicated bot client connects and:
  - requests/receives ownership of that ped entity
  - runs tasks (`TASK_*`, combat/drive/wander) and movement

This produces a true “program-controlled actor” that replicates correctly because it’s controlled the same way as other networked entities: by an owning client sending clone updates.

### Pattern B: “Server-owned static actor” (no movement)

If you only need a persistent object/ped that doesn’t move:
- Create the entity server-side.
- Don’t rely on AI/movement; treat it as a replicated placeholder (position set at creation).
- Use state bags for any “logic state”.

### Pattern C: “Delegate ownership to a real player client”

For lightweight NPC control, you can design your gameplay so that:
- the closest player client (or a chosen player) becomes the owner and runs the AI locally
- server scripts coordinate via state bags/events

This is cheaper than a dedicated bot client but less deterministic and depends on player availability/latency.

## Lifecycle controls you’ll want (bots)

### Orphan mode

Scripts can set how the server treats an entity when its owner disconnects:
- `SET_ENTITY_ORPHAN_MODE(entity, mode)`
  - `DeleteWhenNotRelevant`
  - `DeleteOnOwnerDisconnect`
  - `KeepEntity`

This is important for bots so they don’t get automatically deleted when ownership changes or a controller drops.

See:
- `outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState_Scripting.cpp` (`SET_ENTITY_ORPHAN_MODE`)

### Events you can hook

When server scripts create entities via `CreateEntityFromTree`, the server queues:
- `serverEntityCreated(entityHandle)` — entity exists but may not have an owner yet

And when entities are created from clone streams:
- `entityCreating(entityHandle)` (cancelable)
- `entityCreated(entityHandle)`

See `ServerGameState.cpp` around entity creation handling.

## The built-in `playerEntity` handle (for real players)

If your goal is “control an actual player entity programmatically” (i.e. a real player):
- you already have a per-player entity handle exposed via `playerEntity` data stored on `fx::Client`.
- `MakePlayerEntityFunction` retrieves this and resolves it into a `SyncEntityPtr`.

See:
- `outdated_resources/fivem/code/components/citizen-server-impl/include/MakePlayerEntityFunction.h`

But remember: moving/acting as that player still ultimately depends on the client (server scripts can *observe* and *authorize*, not simulate input/physics).


