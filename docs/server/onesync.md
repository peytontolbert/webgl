# OneSync: code map + data flow (server + client)

> **Scope**: just the OneSync implementation (entity replication, scope/routing buckets, packed clones/acks, object IDs, state bags integration).
>
> **Related docs**:
> - `docs/server_client_pipeline_official.md` (auth/connect)
> - `docs/in-session-pipeline.md` (post-connect transport + routing overview)
> - `docs/player-state.md` (player-specific state propagation)

## What OneSync is (in this codebase’s terms)

In “OneSync mode”, the server runs a **full replicated entity world** and decides:
- which entities exist and who owns them
- which clients should receive which entities (scope/relevancy)
- how to serialize/stream entity state (sync trees → “clones”)

Clients:
- receive **packed clone streams** and create/update/delete local net objects
- send **acked frame/object information** back to the server
- send their own local entity updates and state bag updates to the server, which then routes/replicates them.

## 1) Enabling OneSync & key convars

OneSync is governed primarily by `onesync` (read-only enum), and `onesync_enabled` (deprecated).

```7849:7925:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
fx::SetOneSyncGetCallback([]()
{
  return g_oneSyncEnabledVar->GetValue() || g_oneSyncVar->GetValue() != fx::OneSyncState::Off;
});

g_oneSyncVar = instance->AddVariable<fx::OneSyncState>("onesync", ConVar_ReadOnly, fx::OneSyncState::Off);
g_oneSyncPopulation = instance->AddVariable<bool>("onesync_population", ConVar_ReadOnly, true);
g_oneSyncARQ = instance->AddVariable<bool>("onesync_automaticResend", ConVar_None, false);
g_oneSyncBigMode = instance->AddVariable<bool>("onesync_enableInfinity", ConVar_ReadOnly, false);
g_oneSyncLengthHack = instance->AddVariable<bool>("onesync_enableBeyond", ConVar_ReadOnly, false);

g_oneSyncEnabledVar = instance->AddVariable<bool>("onesync_enabled", ConVar_ServerInfo, false);
g_oneSyncCulling = instance->AddVariable<bool>("onesync_distanceCulling", ConVar_None, true);
g_oneSyncVehicleCulling = instance->AddVariable<bool>("onesync_distanceCullVehicles", ConVar_None, false);
g_oneSyncForceMigration = instance->AddVariable<bool>("onesync_forceMigration", ConVar_None, true);
```

Server tick integration (OneSync drives a sync tick):

```7927:7939:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
fwRefContainer<fx::ServerGameState> sgs = new fx::ServerGameState();
instance->SetComponent(sgs);
instance->SetComponent<fx::ServerGameStatePublic>(sgs);

instance->GetComponent<fx::GameServer>()->OnSyncTick.Connect([=]()
{
  if (!fx::IsOneSync())
  {
    return;
  }
  instance->GetComponent<fx::ServerGameState>()->Tick(instance);
});
```

## 2) The OneSync server core: `ServerGameState`

The primary server implementation is:
- `outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp`

This file covers:
- entity list and world grids per routing bucket
- relevancy calculation and culling (`relevantTo` bitsets)
- routing bucket checks
- clone streaming (`msgPackedClones`) and acknowledgements (`msgPackedAcks`)
- object ID management
- integration points for state bags and net game events

## 3) Scope & routing buckets (what gets streamed)

The server decides relevancy based on:
- **routing bucket** equality (instances/dimensions)
- distance culling (if enabled)
- special cases (player-owned/script-owned, vehicles with occupants, etc.)

Routing bucket gate:

```1198:1206:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
// don't route entities that aren't part of the routing bucket
if (clientDataUnlocked->routingBucket != entity->routingBucket)
{
  if (!(entity == playerEntity))
  {
    // ...
  }
}
```

Distance culling gate:

```1068:1089:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
bool isRelevant = (g_oneSyncCulling->GetValue()) ? false : true;
// ...
if (distSquared < entity->GetDistanceCullingRadius(clientDataUnlocked->GetPlayerCullingRadius()))
{
  return true;
}
```

## 4) Object IDs: how entities get IDs the client can instantiate

OneSync uses a server-managed **object ID pool**. Clients request IDs; the server grants batches.

Server handler for sending IDs:

```46:61:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/packethandlers/RequestObjectIdsPacketHandler.cpp
void RequestObjectIdsPacketHandler::SendObjectIds(fx::ServerInstanceBase* instance, const fx::ClientSharedPtr& client, const uint8_t numIds)
{
  std::vector<uint16_t> freeIds;
  auto sgs = instance->GetComponent<fx::ServerGameStatePublic>();
  sgs->GetFreeObjectIds(client, numIds, freeIds);
  // serialize and client->SendPacket(1, ..., NetPacketType_Reliable)
}
```

On initial connectOK, the server proactively sends IDs:

```754:757:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/GameServer.cpp
if (IsOneSync())
{
  RequestObjectIdsPacketHandler::SendObjectIds(m_instance, client, fx::IsBigMode() ? 4 : 64);
}
```

## 5) Clone streaming: `msgPackedClones` (server→client) and `msgPackedAcks` (client→server)

### Server: pack + compress + send

Server writes an end marker, compresses via LZ4, prepends message type and a frame index, then sends on ENet channel 1.

```739:775:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
// end
buffer.Write(3, 7);

// compress and send
std::vector<char> outData(LZ4_compressBound(buffer.GetDataLength()) + 4 + 8);
int len = LZ4_compress_default(...);
*(uint32_t*)(outData.data()) = msgType;     // msgPackedClones / msgPackedAcks
*(uint64_t*)(outData.data() + 4) = newFrame.full; // frame index

client->SendPacket(1, netBuffer, NetPacketType_Unreliable);
```

The two high-level stream types:
- `msgPackedClones`: entity creates/sync/removes
- `msgPackedAcks`: acknowledgement stream (to manage resend/cleanup)

### Server: parse inbound clone/ack packets (`netClones` / `netAcks`)

The server expects routed payloads to contain an LZ4 block and a type:

```3785:3835:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
if (type != HashString("netClones") && type != HashString("netAcks"))
{
  return { type, 0 };
}
// ... LZ4_decompress_safe_usingDict ...
switch (type)
{
  case HashString("netClones"):
    ParseClonePacket(client, reader);
    break;
  case HashString("netAcks"):
    ParseAckPacket(client, reader);
    break;
}
```

### Client: apply clone stream and send acks

Client-side OneSync logic is primarily in:
- `outdated_resources/fivem/code/components/gta-net-five/src/CloneManager.cpp`

The local clone manager:
- maintains per-object state and pending acknowledgements
- handles clone sync and acks

```112:172:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/gta-net-five/src/CloneManager.cpp
class CloneManagerLocal : public CloneManager, public INetObjMgrAbstraction, public fx::StateBagGameInterface
{
  // ...
  void HandleCloneSync(const char* data, size_t len) override;
  void HandleCloneAcks(const char* data, size_t len) override;
  // ...
};
```

Example: client processing “ack stream” payloads:

```604:662:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/gta-net-five/src/CloneManager.cpp
void CloneManagerLocal::HandleCloneAcks(const char* data, size_t len)
{
  net::Buffer buffer(reinterpret_cast<const uint8_t*>(data), len);
  auto frameIndex = buffer.Read<uint64_t>();
  // ... LZ4_decompress_safe, then parse ack items ...
}
```

## 6) State bags integration (replicated key/value state)

OneSync heavily relies on state bags to replicate metadata for:
- players (`player:<netId>`)
- entities (`entity:<id>`)
- global state (`global`)

`ServerGameState` creates a server-side `StateBagComponent` and registers per-client targets:

```4565:4590:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
auto sbac = fx::StateBagComponent::Create(fx::StateBagRole::Server);
// ...
creg->OnConnectedClient.Connect([this](fx::Client* client)
{
  if (!fx::IsOneSync())
  {
    return;
  }
  m_sbac->RegisterTarget(client->GetSlotId());
  client->OnDrop.Connect([this, client]()
  {
    m_sbac->UnregisterTarget(client->GetSlotId());
  }, INT32_MIN);
});
```

For the state bag API itself (routing targets + ownership), see:
- `outdated_resources/fivem/code/components/citizen-resources-core/include/StateBagComponent.h`

## 7) What to read next (if you want deeper detail)

- **Player/ped field-level state schema**
  - `docs/player-state-sync-nodes.md` (GTA5 OneSync: sync-tree nodes + decoded fields)
- **Clone delta transitions (create/sync/remove + resend)**
  - `docs/onesync-clone-delta-transitions.md` (frame fragmentation, ACK/NAK/ARQ, server frameStates)
- **Bots / program-controlled entities**
  - `docs/server-controlled-entities.md` (what “playerEntity control” means, and how to build bot-like actors)
- **Server**
  - `.../state/ServerGameState.cpp`: the heart of OneSync
  - `.../packethandlers/RequestObjectIdsPacketHandler.cpp`: object ID allocation
  - `.../packethandlers/StateBagPacketHandler.cpp`: client→server state bag updates + rate limiting
  - `.../state/ServerGameState_SyncTrees.cpp`: which sync tree types exist
- **Client**
  - `.../gta-net-five/src/CloneManager.cpp`: clone application + ack generation


