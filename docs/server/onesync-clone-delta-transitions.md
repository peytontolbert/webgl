# OneSync clone delta transitions (create/sync/remove) + frame ACK/NAK/ARQ

This doc describes the **delta/transition model** used by OneSync clone replication in this repo:

- how clone streams are packed (`msgPackedClones`) and unpacked
- the per-frame/per-client state the server keeps to support resend
- how the client detects missing frames/fragments and requests resend (NAK)
- how the ARQ-style ACK path differs
- where the player’s `playerEntity` handle is latched during creation

Related:
- `docs/onesync.md` (high-level OneSync map)
- `docs/player-state.md` (player scope + how player ped state is replicated)
- `docs/player-state-sync-nodes.md` (field-level “what data is inside the sync tree nodes”)
- `docs/server-controlled-entities.md` (bots vs real player entities)

## Big picture

OneSync replication is an **entity delta stream**:
- Each tick, the server builds a per-client stream of entity operations:
  - **create** (a new entity appears for that client)
  - **sync/update** (existing entity has node deltas)
  - **remove** (entity disappears for that client)
- The server sends this stream as `msgPackedClones` over ENet channel 1 (unreliable).
- Clients apply the stream and send back acknowledgements (`netAcks`) / resend requests (`ClientGameStateNAck`).

Important: these “deltas” are about **network replication**. The **movement simulation** that produces ped/vehicle deltas happens on the owning client (the server is not running GTA physics/AI).

## Message types and wrapping

### Server → client: `msgPackedClones`

The server writes a series of 3-bit “items” into a `rl::MessageBuffer`, then:
- appends an **end marker** (type `7`)
- compresses with **LZ4**
- prepends:
  - 4 bytes: message hash (`msgPackedClones`)
  - 8 bytes: a packed **FrameIndex** (frame number + fragmentation metadata)

See `FlushBuffer(...)` in:
- `outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp`

### Client → server: `netClones` and `netAcks`

The client sends routed packets:
- `netClones`: the client’s own clone create/sync/remove updates (for entities it owns)
- `netAcks`: acknowledgements for the server’s clone stream (ARQ mode), and/or other ack bookkeeping

The server uncompresses incoming routed packets and dispatches:
- `ParseClonePacket(...)` for `netClones`
- `ParseAckPacket(...)` for `netAcks`

See:
- `ServerGameState::ParseGameStatePacket(...)` in `ServerGameState.cpp`

## FrameIndex + fragmentation

Large clone streams can be split into fragments. The server uses a packed 64-bit `FrameIndex` with fields:
- `frameIndex` (56 bits)
- `currentFragment` (7 bits)
- `lastFragment` (1 bit)

Clients track the last received `FrameIndex` and can detect:
- missing frames
- missing fragments within a frame
- missing “last fragment”

Client logic (NAK path) lives in:
- `outdated_resources/fivem/code/components/gta-net-five/src/CloneManager.cpp` (`CloneManagerLocal::HandleCloneSync`)

## The clone “item” types (delta transitions)

On the wire, the clone message buffer uses 3-bit item tags:

- **1**: clone create
- **2**: clone sync/update
- **3**: clone remove
- **4**: clone takeover/migration request
- **5**: set timestamp (client→server `netClones` only; see below)
- **6**: set index (client→server `netClones` only; see below)
- **7**: end

### Server receives client-originated deltas (`netClones`)

When the server parses a `netClones` buffer it loops items and calls:
- `ProcessCloneCreate(...)` (type 1)
- `ProcessCloneSync(...)` (type 2)
- `ProcessCloneRemove(...)` (type 3)
- `ProcessCloneTakeover(...)` (type 4)

And it also handles:
- `set timestamp` (type 5): updates per-client `ackTs`/`syncTs`
- `set index` (type 6): updates per-client `fidx` used for ack flushing semantics

See:
- `ServerGameState::ParseClonePacket(...)` in `ServerGameState.cpp`

### Per-item ACKs back to the client (server → client `msgPackedAcks`)

While parsing `netClones`, the server builds an acknowledgement stream (`msgPackedAcks`) containing items:
- type 1: create ack (objectId + uniqifier)
- type 2: sync ack
- type 3: remove ack
- type 5: timestamp ack (timestamp)
- type 7: end

Client-side parsing of `msgPackedAcks` is in:
- `CloneManagerLocal::HandleCloneAcks(...)` (`CloneManager.cpp`)

## Server-side state: what gets tracked to support delta resend

The server maintains per-client state in `GameStateClientData`, notably:
- `syncedEntities`: per-object tracking including `hasCreated` and resend flags
- `pendingCreates`: “this object create was queued/sent but not fully acknowledged”
- `frameStates`: a bounded map from `frameIndex → ClientEntityState snapshot`
  - each snapshot includes:
    - `syncedEntities` (object id → `ClientEntityData` with `lastSent` and `isCreated`)
    - `deletions` (object removals sent that frame)

These snapshots are what enable the server to rewind/resend when a client reports missing frames.

See:
- `GameStateClientData` in `ServerGameState.h`
- `ServerGameState::Tick(...)` and the resend handlers in `ServerGameState.cpp`

## NAK mode: missing-frame resend (default in this codebase)

In **NAK** mode (`SyncStyle::NAK`), the client detects missing frames/fragments and sends a `ClientGameStateNAck` packet identifying:
- missing frame range (`firstMissingFrame..lastMissingFrame`)
- optional ignore list (per-object “last good frame”)
- optional recreate list (ask server to resend create for specific object IDs)

Server handling:
- `ServerGameState::HandleGameStateNAck(...)`
  - rewinds per-entity `lastFramesSent[slotId]` so the next tick will resend
  - flips `hasCreated/hasNAckedCreate` to force recreate when needed
  - re-populates `entitiesToDestroy` for deletions that must be re-sent

If the requested frame is too old / missing from `frameStates`, the server drops the client (`ONE_SYNC_TOO_MANY_MISSED_FRAMES`).

## ARQ mode: explicit ACKs

In **ARQ** mode (`SyncStyle::ARQ`), the client sends explicit acknowledgements (`ClientGameStateAck`), and the server processes:
- `ServerGameState::HandleGameStateAck(...)`
  - applies ignore list corrections to `lastFramesSent`/`lastFramesPreSent`
  - triggers recreate behavior for requested object IDs

This mode is controlled by `onesync_automaticResend` (`g_oneSyncARQ`).

## Where `playerEntity` is created/latches (real players)

The player’s “real” player ped entity (`NetObjEntityType::Player`) is created by the client and arrives via a **clone create** (parsing type 1) in `ProcessClonePacket(...)`.

When the server processes the player entity create/sync, it:
- stores a weak ref in `GameStateClientData::playerEntity`
- stores the script-facing handle on the `fx::Client` as `playerEntity`

This is the handle retrieved by `MakePlayerEntityFunction(...)` for “player state” natives.

Code pointers:
- `ServerGameState::ProcessClonePacket(...)` (`case NetObjEntityType::Player`) in `ServerGameState.cpp`
- `MakePlayerEntityFunction.h`

## What you can and can’t document about “movement control”

### We *can* document (in this repo)
- The **delta transitions** and resend protocol above.
- Exactly which **sync-tree nodes** carry position/orientation/velocity/etc. (see `docs/player-state-sync-nodes.md`).
- Server-side “setter” creation paths that initialize position/heading for script-created entities.

### We *cannot fully* document from server code alone
- A true “server drives movement” pipeline, because the authoritative movement deltas come from the owning client’s GTA simulation and the client-side clone manager + game engine internals.

The best we can do is document how the server **relays** those movement deltas (parse → mark entity dirty → re-stream to other clients) and how ownership/migration determines *which client* produces them.


