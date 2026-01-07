# In-Session Pipeline (after `connectOK`)

> **Scope**: what happens **after** the client receives `connectOK` and has mounted/started required resources — i.e. how the client/server keep the session alive and how players/entities/state replicate while playing.
>
> **Pre-req**: see `docs/server-client-pipeline.md` (or your canonical `docs/server_client_pipeline_official.md`) for the preflight/auth/deferral/connect steps.

## The seam: when “connection established” becomes “in session”

On the client, `connectOK` is parsed, then the NetLibrary transitions into an “active” state where it will start processing routed messages, packed clone streams, state bags, etc.

```400:413:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/net/src/NetLibraryImplV2.cpp
m_base->HandleConnected(atoi(clientNetIDStr), atoi(hostIDStr), atoi(hostBaseStr), atoi(slotIDStr), _strtoi64(timeStr, nullptr, 10));

return;
}

if (m_base->GetConnectionState() == NetLibrary::CS_CONNECTED)
{
  m_base->SetConnectionState(NetLibrary::CS_ACTIVE);
}

if (m_base->GetConnectionState() != NetLibrary::CS_ACTIVE)
{
  return;
}
```

From this point onward, the session is basically:
- **client → server**: keepalive + “routed” packets (RPC, events, clone updates/acks, state bag updates)
- **server → client**: player roster/scope + packed clone stream + state bag replication

## Is there “client-to-client” gameplay networking?

For **gameplay state** (players, peds, vehicles, objects, damage, most script events): **it is effectively server-mediated**.

- **Clients do not open direct gameplay sockets to other clients**; they talk to the server over ENet (`NetLibraryImplV2`), and the server decides what to forward/replicate to other clients.
- **“Client-to-client” effects are still typically `client → server → other clients`** using the routed messaging layer (`msgRoute`) and OneSync replication (packed clones/acks, state bags, etc.).

The `msgRoute` framing in `NetLibraryImplV2.cpp` is a good mental model: the client emits routed packets to the server, and the server is the hub that delivers/replicates to other clients.

### What about voice?

Voice is not “gameplay replication”. In modern FiveM setups (like yours, showing Mumble), voice is handled by a **separate VoIP server** (Mumble), not direct peer-to-peer gameplay state replication.

## Transport & message lanes (how packets are framed)

With NetLibrary v2:
- ENet channel **0**: connection control (`connect`, `connectOK`) and some reliable control messages
- ENet channel **1**: realtime traffic (routed packets, packed clones/acks, state bags, keepalives)

### Keepalive (client → server)

The client sends `msgEnd` periodically so the server can “touch” the client and not time it out:

```275:288:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/net/src/NetLibraryImplV2.cpp
// send keepalive every 100ms (server requires an actual received packet in order to call fx::Client::Touch)
if ((timeGetTime() - m_lastKeepaliveSent) > 100)
{
  net::Buffer msg(8);
  msg.Write(0xCA569E63); // msgEnd

  ENetPacket* pingPacket = enet_packet_create(msg.GetBuffer(), msg.GetCurOffset(), ENET_PACKET_FLAG_UNSEQUENCED);
  enet_peer_send(m_serverPeer, 1, pingPacket);
  m_lastKeepaliveSent = timeGetTime();
}
```

### Routed messages (client ↔ server): `msgRoute`

The generic “envelope” for many higher-level messages is `msgRoute`:

```258:266:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/net/src/NetLibraryImplV2.cpp
net::Buffer msg(1300);
msg.Write(HashRageString("msgRoute"));
msg.Write(packet.netID);
msg.Write<uint16_t>(packet.payload.size());
msg.Write(packet.payload.c_str(), packet.payload.size());
enet_peer_send(m_serverPeer, 1, packetCopy);
```

Incoming `msgRoute` is dispatched into a per-netID queue:

```417:429:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/net/src/NetLibraryImplV2.cpp
if (msgType == HashRageString("msgRoute")) // 'msgRoute'
{
  uint16_t netID = msg.Read<uint16_t>();
  uint16_t rlength = msg.Read<uint16_t>();
  // ...
  m_base->EnqueueRoutedPacket(netID, std::string(routeBuffer, rlength));
}
```

## Player presence in-session (join/leave, and “scope”)

### The baseline roster event (`onPlayerJoining`)

After `connectOK`, the server emits a “player roster” signal so clients can create local representations (names/slots).
This still exists even with OneSync; in BigMode it’s used differently, but the idea is the same.

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

### OneSync scope (who you *actually* stream)

In OneSync, each client has a **scope** of other players/entities determined by:
- **routing bucket** (instance/dimension)
- **relevancy**/culling (distance, focus position, etc.)

You can see the server enforcing routing buckets during relevancy decisions:

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

And when players leave each other’s scope, the server:
- tells the client via `onPlayerDropped` (per-target)
- queues `playerLeftScope` for scripts
- clears “players in scope” bookkeeping

```1548:1579:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
sec->TriggerClientEvent("onPlayerDropped", fmt::sprintf("%d", client->GetNetId()), ownerNetId, ownerRef->GetName(), otherSlot);
evMan->QueueEvent2("playerLeftScope", {}, std::map<std::string, std::string>{ { "player", fmt::sprintf("%d", ownerNetId) }, { "for", fmt::sprintf("%d", client->GetNetId()) } });
clientData->playersInScope.reset(otherSlot);
clientData->playersToSlots.erase(ownerNetId);
```

## OneSync replication core: clones + acks

### What “clones” are

The server is authoritative for *which* entities a client should know about.
For each in-scope entity, the server sends:
- **create** (baseline state)
- **sync/update** (deltas)
- **remove** (delete/out-of-scope)

These are packed and sent as `msgPackedClones`. Client responses are packed as `msgPackedAcks`.

On the server:

```739:831:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
static void FlushBuffer(... uint32_t msgType, ...)
{
  // ...
  client->SendPacket(1, netBuffer, NetPacketType_Unreliable);
}

// acks
FlushBuffer(ackBuffer, HashRageString("msgPackedAcks"), 0, clientRef);

// clones
FlushBuffer(scsSelf.cloneBuffer, HashRageString("msgPackedClones"), frameIndex, client, &fragmentIndex, true);
```

And the server parses incoming clone/ack payloads carried inside a routed message:

```3784:3835:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
auto [type, length] = UncompressClonePacket(...);
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

### Ownership/migration (who “owns” an entity)

ServerGameState can reassign entities between clients (or server-owned/unowned) when owners leave or based on candidate selection:

```2846:2865:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
if (candidates.empty())
{
  // no candidates: unowned or delete
  ReassignEntity(entity->handle, {});
}
else
{
  // choose best candidate and migrate
  ReassignEntity(entity->handle, std::get<1>(candidate));
}
```

## State bags (replicated key/value state)

State bags are a major part of “in-session” replication (player state, entity metadata, etc.).

### Server registers a replication target per client slot

When a client is connected (OneSync), the server registers a state-bag “target” for that slot:

```4565:4591:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
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

### Client → server: state bag updates (rate-limited)

The server’s packet handler enforces rate/size limits and applies updates:

```64:100:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/packethandlers/StateBagPacketHandler.cpp
const bool hitRateLimit = !stateBagRateLimiter->Consume(netId);
// ...
if (hitFloodRateLimit)
{
  instance->GetComponent<fx::GameServer>()->DropClientWithReason(..., "Reliable state bag packet overflow.");
  return;
}
// ...
stateBagComponent->HandlePacket(slotId, clientStateBag.data, &bagNameOnFailure);
```

### Routing state bags with entities / players

As entities become “created” for a client, their state bags are routed to that client slot:

```1803:1809:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/state/ServerGameState.cpp
if (syncData.hasCreated && !syncData.hasRoutedStateBag)
{
  if (auto stateBag = entity->GetStateBag())
  {
    syncData.hasRoutedStateBag = true;
    stateBag->AddRoutingTarget(slotId);
  }
}
```

## What you should expect to see in logs after this point

After `connectOK` and resource start, issues tend to show up as:
- **Keepalive/timeouts**: client stops sending `msgEnd` (lag/hang) → server drop.
- **State bag rate drops/kicks**: `sbag-update-dropped` / `sbag-client-flood` (spammy scripts).
- **Scope churn**: repeated `onPlayerDropped`/`onPlayerJoining` as buckets/scope changes.
- **Clone/ack pressure**: too many missed frames or large clone bursts (OneSync timing issues).


