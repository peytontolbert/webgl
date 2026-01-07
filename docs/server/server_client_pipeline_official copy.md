# Server ↔ Client Connection Pipeline (Official / Canonical)

This is the **canonical** document in this repo describing how a FiveM/CitizenFX client authenticates and connects to an FxServer, from initial discovery through **`connectOK`** and the start of OneSync replication.

If you’re looking at older docs:
- `server_client.md` (handshake/connectOK focused)
- `docs/server-client-pipeline.md` (end-to-end focused)

…they are now **superseded** by this file.

---

## Scope & artifacts in this repo

This repo contains:
- A **client connection log** example: `CitizenFX_log_2025-12-29T201242.log`
- An (outdated, but very useful) **FiveM/FxServer source drop**: `outdated_resources/fivem/`

This doc focuses on the pipeline as implemented in that source drop.

---

## Key concepts

- **Control-plane (HTTP)**: server info, authentication, deferrals, endpoints/permissions/feature-policy, resource manifest + downloads, configuration fetch.
- **Data-plane (ENet/NetLibrary)**: realtime session (`connect` → `connectOK`) and subsequent replication (OneSync).
- **Connection token**: issued during `initConnect`, then reused for:
  - ENet connect handshake (`guid` + `token`)
  - Post-connect HTTP header: `X-CitizenFX-Token: <token>`
- **`passedValidation`**: server-side boolean that gates *both* realtime join and token-gated HTTP calls. It is set only after deferrals succeed.

---

## Pipeline overview (high level)

1. **Client discovers server**:
   - UDP out-of-band `getinfo` (and/or HTTP server variables) to populate basic server info.
2. **Client fetches server variables**:
   - `GET /info.json` (+ `GET /dynamic.json`) to learn server configuration.
3. **Client builds authentication material**:
   - **Cfx ticket** (`cfxTicket2`) required unless `sv_lan 1`.
   - Optional **Steam ticket** (`authTicket`) depending on server config.
4. **HTTP handshake: `POST /client` with `method=initConnect`**:
   - Server verifies ticket(s), creates a temporary client record, issues a **connection token**.
   - Server triggers `playerConnecting` with **deferrals**; when done, sets `passedValidation = true`.
5. **Additional HTTP calls**:
   - `getEndpoints`, permissions, feature policy (client progress messages come from `NetLibrary.cpp`).
6. **Resource manifest + downloads**:
   - Client fetches manifest and downloads/verifies/mounts required resources.
7. **Realtime join (ENet)**:
   - Client connects and sends **handshake message type `1`** containing form-data `token=...&guid=...`.
   - Server validates `(guid, token)` and `passedValidation`, binds peer, assigns NetID/SlotID, sends **`connectOK`** (also message type `1`).
8. **Server announces player presence**:
   - `playerJoining` and client event `onPlayerJoining` to introduce players to each other.
9. **OneSync replication begins**:
   - Initial object ID allocations, clone creation/updates, state bags, etc.

---

## Stage A — Discovery (UDP out-of-band `getinfo`)

While in `CS_FETCHING`, the client periodically sends a UDP OOB query like:
- `SendOutOfBand(m_currentServer, "getinfo xyz");`

This is not the actual realtime handshake, but it precedes it in the user-visible “Connecting…” flow.

**Code pointer**
- Client: `outdated_resources/fivem/code/components/net/src/NetLibrary.cpp`

---

## Stage B — Server variables (`/info.json`, `/dynamic.json`)

The server exposes:
- `GET /info.json`
- `GET /dynamic.json`

The client prints: “Requesting server variables…” while doing this.

**Code pointers**
- Server: `outdated_resources/fivem/code/components/citizen-server-impl/src/InfoHttpHandler.cpp`
- Client: `outdated_resources/fivem/code/components/net/src/NetLibrary.cpp`

---

## Stage C — HTTP handshake: `initConnect` (ticket validation + token issuance + deferrals)

### C1) Client sends `initConnect`

The client assembles a POST map including at least:
- `method=initConnect`
- `name=<player name>`
- `protocol=<NETWORK_PROTOCOL>`
- `guid=<client GUID>`
- plus other fields (build, game, etc.)

**Code pointer**
- Client: `outdated_resources/fivem/code/components/net/src/NetLibrary.cpp`

### C2) Server verifies authentication ticket(s)

If not LAN (`sv_lan 1`), the server requires a **Cfx ticket** (`cfxTicket2`) and verifies it using a public key.

**Code pointer**
- Server: `outdated_resources/fivem/code/components/citizen-server-impl/src/InitConnectMethod.cpp`

### C3) Server creates a temporary client record + issues a token

On success, the server:
- Creates a `fx::Client` in the `ClientRegistry`
- Generates a **connection token**
- Stores it on the client (`client->SetConnectionToken(token)`)
- Returns JSON including `token`

It also assigns a **temporary NetID** (`0x10000 + tempId`) before realtime join.

**Code pointer**
- Server: `outdated_resources/fivem/code/components/citizen-server-impl/src/InitConnectMethod.cpp`

### C4) Deferrals (`playerConnecting`) and `passedValidation`

The server triggers the `playerConnecting` event (txAdmin and/or resources can defer/deny). Only after deferrals succeed does the server set:
- `client->SetData("passedValidation", true);`

This flag is later **required** by the ENet handshake and token-gated HTTP methods.

**Code pointer**
- Server: `outdated_resources/fivem/code/components/citizen-server-impl/src/InitConnectMethod.cpp`

### C5) Client token parsing during streaming response

The client parses streamed JSON chunks and captures:
- `m_token = node["token"]`
- also stores it into `ICoreGameInit` as `"connectionToken"`

Deferral progress/cards are surfaced via `OnConnectionProgress(...)` and `OnConnectionCardPresent(card, token)`.

**Code pointers**
- Client: `outdated_resources/fivem/code/components/net/src/NetLibrary.cpp`
- UI glue: `outdated_resources/fivem/code/components/glue/src/ConnectToNative.cpp`

---

## Stage D — Additional control-plane calls (still HTTP)

After `initConnect` begins, the client performs additional HTTP calls (progress strings are emitted from `NetLibrary.cpp`), typically including:

### D1) Endpoints (`getEndpoints`)

Returns `sv_endpoints` list (or `[]`) based on token.

**Code pointer**
- Server: `outdated_resources/fivem/code/components/citizen-server-impl/src/InitConnectMethod.cpp`

### D2) Permissions + feature policy

Client progress strings include:
- “Requesting server permissions…”
- “Requesting server feature policy…”

**Code pointer**
- Client: `outdated_resources/fivem/code/components/net/src/NetLibrary.cpp`

---

## Stage E — Resource manifest + downloads

After the control-plane steps, the client downloads/verifies/mounts required resources (the long “Required resources … Verifying … Mounted … Downloading completed” phase in the log).

This stage is conceptually part of the control-plane because it is HTTP/content distribution, but it gates when the client is ready to join realtime.

---

## Stage F — Realtime join: ENet connect + handshake (`msgType == 1`)

Once the client has a token and is ready to join realtime, it transitions to `CS_CONNECTING` and performs the ENet connect attempt.

### F1) Client builds the connect form-data

Client constructs URL-encoded form data:
- `token=<token>&guid=<guid>`

**Code pointers**
- Client orchestration: `outdated_resources/fivem/code/components/net/src/NetLibrary.cpp`
- ENet implementation (v2): `outdated_resources/fivem/code/components/net/src/NetLibraryImplV2.cpp`

### F2) Client sends the ENet handshake packet

After ENet reports `ENET_EVENT_TYPE_CONNECT`, the client sends a reliable packet on channel `0` containing:
- `uint32 msgType = 1`
- payload bytes: `"token=<token>&guid=<guid>"`

**Handshake packet format (client → server)**
- `uint32 msgType = 1`
- `bytes payload = "token=<token>&guid=<guid>"`

**Code pointer**
- Client: `outdated_resources/fivem/code/components/net/src/NetLibraryImplV2.cpp`

---

## Stage G — Server validates handshake and replies `connectOK` (`msgType == 1`)

### G1) Server entry point: `GameServer::ProcessPacket`

Server reads the first field as `msgType`. If `msgType == 1`, it treats it as the connection handshake message.

**Code pointer**
- Server: `outdated_resources/fivem/code/components/citizen-server-impl/src/GameServer.cpp`

### G2) Server parses the form-data payload

The remaining bytes are decoded as `application/x-www-form-urlencoded` form data.
Expected keys:
- `guid`
- `token`

**Code pointer**
- Decoder: `outdated_resources/fivem/code/components/net-base/src/FormData.cpp`

### G3) Server validation rules

After parsing, the server:
- Looks up the pending client by `guid`
- Verifies `token == client->GetConnectionToken()`
  - on mismatch: sends OOB error `"Invalid connection token received."` and removes the client
- Verifies `client->GetData("passedValidation")` is true
  - on failure: sends OOB error `"Invalid connection."` and removes the client
- Binds the ENet peer to the client (`client->SetPeer(peerId, addr)`)
- Assigns/validates OneSync SlotID (if enabled)

**Code pointer**
- Server: `outdated_resources/fivem/code/components/citizen-server-impl/src/GameServer.cpp`

### G4) Server sends `connectOK`

If validation passes, the server sends a reliable packet back to the client containing:
- `msgType = 1`
- ASCII payload string containing:
  - `clientNetId hostNetId hostBase slotId serverTime`

**connectOK packet format (server → client)**
- `uint32 msgType = 1`
- `bytes payload = " <clientNetId> <hostNetId> <hostBase> <slotId> <time>"`
  - Note: payload begins with a leading space.

**ENet tuning**
- ConnectOK path disables throttling and sets a hard timeout (30s in this source drop).

**Code pointers**
- Server handshake + connectOK: `outdated_resources/fivem/code/components/citizen-server-impl/src/GameServer.cpp`
- ENet tuning: `outdated_resources/fivem/code/components/citizen-server-impl/src/GameServerNet.ENet.cpp`

---

## Stage H — Client parses `connectOK` and becomes connected

On the client, incoming ENet packets are parsed in `NetLibraryImplV2::ProcessPacket(...)`.

If the received `msgType == 1`, it is treated as `connectOK`, parsed by splitting the ASCII payload into fields, and forwarded to:
- `HandleConnected(clientNetId, hostId, hostBase, slotId, time)`

After this, subsequent packets are only processed once the connection state reaches `CS_ACTIVE`.

**Code pointers**
- Client parse: `outdated_resources/fivem/code/components/net/src/NetLibraryImplV2.cpp`
- Client connected handler: `outdated_resources/fivem/code/components/net/src/NetLibrary.cpp`

---

## Stage I — Post-connect HTTP: token-gated configuration/resources

After connect, the client reuses the token for HTTP requests by attaching:
- `X-CitizenFX-Token: <connectionToken>`

On the server, token-gated HTTP methods (example: `getConfiguration`) typically:
- Resolve client by token header (or endpoint fallback)
- Require `passedValidation == true`
- Rate-limit by token

**Code pointers**
- Client header usage examples:
  - `outdated_resources/fivem/code/components/citizen-resources-client/src/ResourceCacheDeviceV2.cpp`
  - `outdated_resources/fivem/code/components/citizen-resources-client/src/ResourceCacheDevice.cpp`
- Server enforcement example:
  - `outdated_resources/fivem/code/components/citizen-server-impl/src/GetConfigurationMethod.cpp`

---

## Stage J — “Other players”: server introduces everyone to everyone

Once the client is fully connected, the server introduces players using:
- Server event: `playerJoining`
- Client event: `onPlayerJoining`
  - Sent to everyone about the joining client
  - Sent to the joining client about everyone else

**Code pointer**
- Server: `outdated_resources/fivem/code/components/citizen-server-impl/src/ClientRegistry.cpp` (`ClientRegistry::HandleConnectedClient`)

---

## Stage K — OneSync: replication starts

After `connectOK` and joining events, OneSync starts streaming:
- object ID allocations
- clone create + incremental updates
- state bags (key/value replication)

In this source drop, the server sends initial object IDs right after `connectOK`.

**Code pointer**
- Server: `outdated_resources/fivem/code/components/citizen-server-impl/src/GameServer.cpp`

---

## Mapping to `CitizenFX_log_2025-12-29T201242.log`

Your log contains client progress markers from `NetLibrary.cpp`, including:
- “Requesting server variables…”
- “Obtaining Steam ticket…”
- “Handshaking with server…”
- “Requesting server endpoints…”
- “Requesting server permissions…”
- “Requesting server feature policy…”
- resource download/verify/mount phase
- “Received connectOK… Network connected…”

---

## Troubleshooting checklist (common failure points)

- **Stuck on deferrals**: something in `playerConnecting` never calls `deferrals.done()` (txAdmin or a resource).
- **“No authentication ticket was specified.”**: missing/invalid `cfxTicket2` (or client/server mismatch).
- **“Invalid connection token received.”**: realtime ENet connect attempted with a stale token (reconnect/race).
- **“Invalid connection.”**: `passedValidation` was never set true (handshake didn’t complete).
- **OneSync slot exhaustion**: “Not enough client slot IDs.” (rare; slot pool full).

---

## Quick “what to cite” list (best entry points)

- **Client server variables + handshake orchestration**: `outdated_resources/fivem/code/components/net/src/NetLibrary.cpp`
- **Client ENet connect + handshake packet send/receive**: `outdated_resources/fivem/code/components/net/src/NetLibraryImplV2.cpp`
- **Server initConnect + tickets + deferrals + passedValidation**: `outdated_resources/fivem/code/components/citizen-server-impl/src/InitConnectMethod.cpp`
- **Server handshake validation + connectOK send**: `outdated_resources/fivem/code/components/citizen-server-impl/src/GameServer.cpp`
- **Form-data decode**: `outdated_resources/fivem/code/components/net-base/src/FormData.cpp`
- **Token-gated configuration**: `outdated_resources/fivem/code/components/citizen-server-impl/src/GetConfigurationMethod.cpp`


