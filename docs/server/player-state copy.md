# Player state data: all “connections” (events, state bags, scope, and sync)

This document is the “player state” companion to:
- `docs/server-client-pipeline.md` / `docs/server_client_pipeline_official.md` (auth/connect)
- `docs/in-session-pipeline.md` (general in-session networking)

## What “player state” means in FiveM/OneSync

Player-related state is carried through **three main channels**, all server-mediated:

1. **Player roster / visibility signals** (who exists, who is in scope)
2. **OneSync entity replication** (the actual *player ped* and other entities)
3. **State bags** (replicated key/value metadata for players/entities/global)

## 1) Player roster + scope signals

### Baseline roster: `onPlayerJoining` / `onPlayerDropped`

These events tell clients about player identity (netId, name, slot) and are used for presence/UI.

**On join** (`ClientRegistry::HandleConnectedClient`):

```191:227:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/ClientRegistry.cpp
// send every player information about the joining client
events->TriggerClientEvent("onPlayerJoining", std::optional<std::string_view>(), client->GetNetId(), client->GetName(), client->GetSlotId());

// send the JOINING CLIENT information about EVERY OTHER CLIENT
std::string target = fmt::sprintf("%d", client->GetNetId());
ForAllClients([&](const fx::ClientSharedPtr& otherClient)
{
  events->TriggerClientEvent("onPlayerJoining", target, otherClient->GetNetId(), otherClient->GetName(), otherClient->GetSlotId());
});
```

**On drop** (server broadcasts similarly; OneSync additionally uses per-scope drops):

```1172:1175:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/GameServer.cpp
// send every player information about the dropping client
events->TriggerClientEvent("onPlayerDropped", std::optional<std::string_view>(), client->GetNetId(), client->GetName(), client->GetSlotId());
```

### Scope-based visibility (OneSync): `playerEnteredScope` / `playerLeftScope`

In OneSync, “being connected” != “being streamed”. The server maintains **scope** and signals transitions.

When a player leaves scope, the server:
- sends `onPlayerDropped` *to the specific client losing scope*
- queues `playerLeftScope` for scripts
- removes routing targets for that player’s player-bag (see state bags below)

```1548:1579:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
sec->TriggerClientEvent("onPlayerDropped", fmt::sprintf("%d", client->GetNetId()), ownerNetId, ownerRef->GetName(), otherSlot);
evMan->QueueEvent2("playerLeftScope", {}, std::map<std::string, std::string>{ { "player", fmt::sprintf("%d", ownerNetId) }, { "for", fmt::sprintf("%d", client->GetNetId()) } });
clientData->playersInScope.reset(otherSlot);
clientData->playersToSlots.erase(ownerNetId);
```

When a player enters scope, the server:
- sends `onPlayerJoining` *to the specific client gaining scope*
- queues `playerEnteredScope` for scripts
- adds routing targets for that player’s player-bag

```1688:1719:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
clientData->playersInScope[slotId] = entityClient->GetNetId();
clientData->playersToSlots[entityClient->GetNetId()] = slotId;
sec->TriggerClientEvent("onPlayerJoining", fmt::sprintf("%d", client->GetNetId()), entityClient->GetNetId(), entityClient->GetName(), slotId);
evMan->QueueEvent2("playerEnteredScope", {}, std::map<std::string, std::string>{ { "player", fmt::sprintf("%d", entityClient->GetNetId()) }, { "for", fmt::sprintf("%d", client->GetNetId()) } });
```

## 2) “Real” gameplay player state: OneSync replication (player ped + sync tree)

The actual gameplay-relevant state (position, velocity, health, tasks, etc.) is replicated as **OneSync entities**.
For players, that means the **player ped entity** and its **sync tree nodes**.

For the **field-level schema** of what actually exists in those nodes (camera, wanted, ped health, ped task tree, player modifiers, etc.), see:
- `docs/player-state-sync-nodes.md`

On the server, this lives in `ServerGameState` (entity lists, relevancy/scope, clone create/sync/remove).

On the server, clone streams are packed and sent as:
- `msgPackedClones` (server → client)
- `msgPackedAcks` (client → server)

```823:831:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
// clones
FlushBuffer(scsSelf.cloneBuffer, HashRageString("msgPackedClones"), frameIndex, client, &fragmentIndex, true);

// acks
FlushBuffer(ackBuffer, HashRageString("msgPackedAcks"), 0, clientRef);
```

Server-side parsing of `netClones` / `netAcks` is part of in-session sync:

```3808:3835:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
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

### Script/native access to “player state” (server)

Some server natives read player state from the player’s sync tree (example: wanted level):

```35:60:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/PlayerStateScriptFunctions.cpp
fx::ScriptEngine::RegisterNativeHandler("GET_PLAYER_WANTED_LEVEL", MakePlayerEntityFunction([](fx::ScriptContext& context, const fx::sync::SyncEntityPtr& entity)
{
  auto node = entity->syncTree->GetPlayerWantedAndLOS();
  return node ? node->wantedLevel : 0;
}));
```

## 3) State bags: replicated key/value state for players/entities

State bags are the “metadata bus” for player/entity/global state. They replicate as:
- `msgStateBag` (legacy)
- `msgStateBagV2` (newer key/value wire format)

```9:88:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/net-packet/include/StateBag.h
class StateBagPacket : public SerializableComponent
{
public:
  SerializableProperty<uint32_t> type{ net::force_consteval<uint32_t, HashRageString("msgStateBag")> };
  StateBag data;
};

class StateBagV2Packet : public SerializableComponent
{
public:
  SerializableProperty<uint32_t> type{ net::force_consteval<uint32_t, HashRageString("msgStateBagV2")> };
  StateBagV2 data;
};
```

### Global bag

Server creates a `global` bag, server-owned:

```4571:4574:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
m_globalBag = sbac->RegisterStateBag("global", true);
m_globalBag->SetOwningPeer(-1);
```

### Per-player bag: `player:<netId>`

For each client, the server creates a `player:<netId>` state bag and sets ownership to the client’s slot.

```301:311:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
data->playerBag = state->GetStateBags()->RegisterStateBag(fmt::sprintf("player:%d", client->GetNetId()));
data->playerBag->SetOwningPeer(client->GetSlotId());
```

Then, as players enter/leave scope, the server adds/removes routing targets so only relevant clients receive updates:

```1693:1698:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
if (ecData->playerBag)
{
  ecData->playerBag->AddRoutingTarget(client->GetSlotId());
}
```

```1572:1575:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
if (oldClientData->playerBag)
{
  oldClientData->playerBag->RemoveRoutingTarget(client->GetSlotId());
}
```

### Per-entity bags: `entity:<id>` (created when needed)

Clients are only allowed to auto-create entity state bags, enforced server-side:

```154:174:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/packethandlers/StateBagPacketHandler.cpp
// state bag isn't present, apply conditions for automatic creation
if (!bagNameOnFailure.empty())
{
  // only allow clients to create entity state bags
  if (bagNameOnFailure.rfind("entity:", 0) == 0)
  {
    // ... parse entity id, register bag, retry HandlePacket ...
  }
}
```

### Server-side “state bag change” hook (for scripts)

State bag changes can trigger `OnStateBagChange` before replication is applied:

```122:160:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-resources-core/src/StateBagComponent.cpp
const auto& sbce = m_parent->OnStateBagChange;
// ... msgpack decode ...
if (parent->OnStateBagChange(source, id, key, up.get(), replicated))
{
  continuation(key, data);
}
```

## Client-side: local state bags vs replicated state bags

Clients can create **local-only** entity state bags too (not replicated) for script GUID entities:

```15:23:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-resources-gta/src/EntityStateBags.cpp
m_stateBag = sbac->RegisterStateBag(fmt::sprintf("localEntity:%d", scriptGuid), false);
```

## Practical mapping: “Where do I look for player state?”

- **Presence + scope**: `ServerGameState.cpp` (`playerEnteredScope` / `playerLeftScope`, `onPlayerJoining` / `onPlayerDropped`)
- **Player metadata**: state bag `player:<netId>` (routing targets are the “connections”)
- **Gameplay movement/health/etc.**: OneSync entity replication (player ped sync tree)
- **Script layer**:
  - state bag events: `StateBagComponent::OnStateBagChange`
  - player state natives: `PlayerStateScriptFunctions.cpp` (example shown)


