# Server ↔ Client Authentication & Connection Pipeline (CitizenFX/FiveM)

> **Canonical doc**: this file is now superseded by `docs/server_client_pipeline_official.md` (recommended starting point).

This repo contains:
- A **client connection log** example: `CitizenFX_log_2025-12-29T201242.log`
- An (outdated, but very useful) **FiveM/FxServer source drop**: `outdated_resources/fivem/`

This document explains the **end-to-end pipeline** of how a FiveM client authenticates and joins a server, and how the server then initializes the player and syncs other players/entities (OneSync).

## Key concepts

- **Control-plane (HTTP)**: preflight, authentication, deferrals, endpoints/permissions, feature policy, resource manifest.
- **Data-plane (ENet/NetLibrary)**: the realtime network session (`connect` → `connectOK`) and subsequent game-state replication (OneSync).

## Pipeline overview (high level)

1. **Client fetches server info** (`/info.json`) → server variables.
2. **Client builds authentication material**:
   - **Cfx ticket** (`cfxTicket2`) is required (unless `sv_lan 1`).
   - Optional **Steam ticket** (`authTicket`) depending on server config.
3. **Client performs handshake** via HTTP `POST /client` (method `initConnect`).
4. **Server verifies ticket(s)**, creates a temporary client record, and runs `playerConnecting` with **deferrals**.
5. **Client asks for endpoints** (`getEndpoints`) and permissions/feature policy.
6. **Client downloads required resources** (content manifest) and verifies/mounts them.
7. **Client connects on the realtime transport** (ENet) and sends the **ENet “connect” packet** with `(guid, token)`.
8. **Server validates token + passedValidation**, assigns final NetID/SlotID, and replies **`connectOK`**.
9. **Server publishes player presence** (`playerJoining` + `onPlayerJoining`), then OneSync starts streaming entities/players.

## 1) Server info: `/info.json` (client “Requesting server variables…”)

The server exposes `GET /info.json` and `GET /dynamic.json`:

```284:337:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/InfoHttpHandler.cpp
instance->GetComponent<fx::HttpServerManager>()->AddEndpoint("/info.json", [=](const fwRefContainer<net::HttpRequest>& request, fwRefContainer<net::HttpResponse> response)
{
  // ... paranoia + rate limit ...
  infoData->Update();
  {
    std::shared_lock<std::shared_mutex> lock(infoData->infoJsonStrMutex);
    response->End(infoData->infoJsonStr);
  }
});

instance->GetComponent<fx::HttpServerManager>()->AddEndpoint("/dynamic.json", [=](const fwRefContainer<net::HttpRequest>& request, fwRefContainer<net::HttpResponse> response)
{
  // ...
  auto json = GetDynamicJson();
  response->End(json.dump(-1, ' ', false, json::error_handler_t::replace));
});
```

Client-side, this corresponds to:

```1780:1787:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/net/src/NetLibrary.cpp
OnConnectionProgress("Requesting server variables...", 0, 100, true);
auto request = m_httpClient->Get(fmt::sprintf("%sinfo.json", url));
request->OnCompletion([=](bool success, std::string_view data)
{
  // parse server variables and continue handshake...
});
```

## 2) HTTP handshake: `initConnect` (Cfx ticket validation + deferrals)

The client sends an HTTP request (via `POST /client`) that is routed to the handler named `initConnect` on the server:

```532:646:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/InitConnectMethod.cpp
instance->GetComponent<fx::ClientMethodRegistry>()->AddHandler("initConnect", [=](const std::map<std::string, std::string>& postMap, const fwRefContainer<net::HttpRequest>& request, const std::function<void(const json&)>& cb)
{
  // ... field checks ...
  if (!lanVar->GetValue())
  {
    auto ticketIt = postMap.find("cfxTicket2");
    if (ticketIt == postMap.end())
    {
      sendError("No authentication ticket was specified.");
      return;
    }
    auto requestedPublicKey = GetPublicKey();
    // VerifyTicket / VerifyTicketEx
  }
  // ...
});
```

### Ticket verification (what “auth” means here)

- The **Cfx ticket** (`cfxTicket2`) is verified server-side using a public key:

```637:689:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/InitConnectMethod.cpp
auto ticketIt = postMap.find("cfxTicket2");
if (ticketIt == postMap.end())
{
  sendError("No authentication ticket was specified.");
  return;
}
auto requestedPublicKey = GetPublicKey();
VerifyTicketResult verifyResult = VerifyTicket(guid, ticketIt->second, requestedPublicKey.value());
// ...
auto optionalTicket = VerifyTicketEx(ticketIt->second, requestedPublicKey.value());
```

### Temporary client object + “passedValidation”

Once ticket checks pass, the server creates a **temporary client record** with:
- **Connection token** (`client->SetConnectionToken(token)`)
- A **temporary NetID** (`0x10000 + tempId`)

```765:783:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/InitConnectMethod.cpp
auto client = clientRegistry->MakeClient(guid);
client->SetName(name);
client->SetConnectionToken(token);
client->SetTcpEndPoint(ra.substr(0, ra.find_last_of(':')));
client->SetNetId(0x10000 + tempId);
```

Then, after deferrals succeed, the server marks the client as allowed to proceed:

```871:882:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/InitConnectMethod.cpp
client->SetData("deferralPtr", nullptr);
client->SetData("passedValidation", true);
client->SetData("canBeDead", false);
```

### Deferrals (`playerConnecting`)

This is where txAdmin (and any resource) can pause/deny the connection:

```1088:1110:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/InitConnectMethod.cpp
/*NETEV playerConnecting SERVER
 * @param deferrals - An object to control deferrals.
 */
declare function playerConnecting(playerName: string, setKickReason: (reason: string) => void, deferrals: {
  defer(): void,
  update(message: string): void,
  presentCard(card: object | string, cb?: (data: any, rawData: string) => void): void,
  done(failureReason?: string): void,
  handover(data: object): void,
}, source: string): void;
```

On the client, these show up as “monitor: Deferring connection…” and progress messages/cards.

## 3) Endpoints + permissions + feature-policy (still HTTP)

After the handshake starts, the client does a few additional control-plane calls.

### Endpoints (`getEndpoints`)

Server handler:

```469:524:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/InitConnectMethod.cpp
instance->GetComponent<fx::ClientMethodRegistry>()->AddHandler("getEndpoints", [instance, srvEndpoints](..., const std::function<void(const json&)>& cb)
{
  auto client = clientRegistry->GetClientByConnectionToken(tokenIt->second);
  // returns sv_endpoints list or [] ...
});
```

Client-side progress strings:

```1649:1671:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/net/src/NetLibrary.cpp
OnConnectionProgress("Requesting server endpoints...", 0, 100, false);
m_httpClient->DoPostRequest(fmt::sprintf("%sclient", url), m_httpClient->BuildPostString(epMap), ...);
```

### Permissions + feature policy

Client-side progress strings (what you saw in the log):

```1612:1688:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/net/src/NetLibrary.cpp
OnConnectionProgress("Requesting server permissions...", 0, 100, false);
// ...
OnConnectionProgress("Requesting server feature policy...", 0, 100, false);
trace("Server feature policy is %s\n", policy);
```

## 4) Resource manifest + downloads

After HTTP handshake steps finish, the client downloads/verifies/mounts required resources before joining realtime.
In your log, this is the long “Required resources: … Verifying … Mounted … Downloading completed” phase.

## 5) Realtime join: ENet `connect` → `connectOK`

Once the client is ready to join realtime, it connects via ENet and performs a tiny handshake:
- Client sends message type `1` containing at least: **`guid`** + **`token`**
- Server validates and replies with `connectOK`

### Server: validate `(guid, token)` + `passedValidation`, assign slot, send `connectOK`

```653:757:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/GameServer.cpp
auto client = m_clientRegistry->GetClientByPeer(peerId);

// handle connection handshake message
if (msgType == 1)
{
  // ... DecodeFormData ...
  auto guid = postMap["guid"];
  auto token = postMap["token"];

  client = m_clientRegistry->GetClientByGuid(guid);

  if (client)
  {
    if (token != client->GetConnectionToken())
    {
      SendOutOfBand(peer->GetAddress(), "error Invalid connection token received.");
      m_clientRegistry->RemoveClient(client);
      return;
    }

    if (!client->GetData("passedValidation"))
    {
      SendOutOfBand(peer->GetAddress(), "error Invalid connection.");
      m_clientRegistry->RemoveClient(client);
      return;
    }

    client->SetPeer(peerId, peer->GetAddress());
    // assign slot id in OneSync, etc.

    if (!client->HasConnected())
    {
      m_clientRegistry->HandleConnectingClient(client);
    }

    // send a connectOK
    net::Buffer outMsg;
    outMsg.Write(1);
    // outStr: clientNetId hostNetId hostBase slotId serverTime
    client->SendPacket(0, outMsg, NetPacketType_Reliable);
    // ...
    if (IsOneSync())
    {
      RequestObjectIdsPacketHandler::SendObjectIds(...);
    }
  }
  return;
}
```

### Client: parse `connectOK` and flip to “connected”

`connectOK` is handled by `NetLibrary::HandleConnected()`, which prints the exact line you saw:

```173:196:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/net/src/NetLibrary.cpp
void NetLibrary::HandleConnected(int serverNetID, int hostNetID, int hostBase, int slotID, uint64_t serverTime)
{
  m_serverNetID = serverNetID;
  m_hostNetID = hostNetID;
  m_hostBase = hostBase;
  m_serverSlotID = slotID;
  m_serverTime = serverTime;

  trace("^2Received connectOK: ServerID %d, SlotID %d, HostID %d\n", m_serverNetID, m_serverSlotID, m_hostNetID);
  OnConnectOKReceived(m_currentServer);
  // ...
}
```

## 6) “Other players”: when the server introduces everyone to everyone

This is primarily `ClientRegistry::HandleConnectedClient()`:

- Triggers server event **`playerJoining`**
- Sends client event **`onPlayerJoining`** to:
  - Everyone (about the new client)
  - The new client (about everyone else)

```191:241:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/ClientRegistry.cpp
void ClientRegistry::HandleConnectedClient(const fx::ClientSharedPtr& client, uint32_t oldNetID)
{
  eventManager->TriggerEvent2("playerJoining", { fmt::sprintf("internal-net:%d", client->GetNetId()) }, fmt::sprintf("%d", oldNetID));

  // send every player information about the joining client
  events->TriggerClientEvent("onPlayerJoining", std::optional<std::string_view>(), client->GetNetId(), client->GetName(), client->GetSlotId());

  // send the JOINING CLIENT information about EVERY OTHER CLIENT
  std::string target = fmt::sprintf("%d", client->GetNetId());
  ForAllClients([&](const fx::ClientSharedPtr& otherClient)
  {
    events->TriggerClientEvent("onPlayerJoining", target, otherClient->GetNetId(), otherClient->GetName(), otherClient->GetSlotId());
  });
}
```

## 7) OneSync: entity replication and “seeing other players”

Once `connectOK` + `playerJoining` occurs, OneSync starts streaming:
- object ID allocations (so clients can create entities)
- clone creation + incremental updates
- state bags (key/value state replication)

The server sends initial object IDs right after `connectOK`:

```754:757:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/GameServer.cpp
if (IsOneSync())
{
  RequestObjectIdsPacketHandler::SendObjectIds(m_instance, client, fx::IsBigMode() ? 4 : 64);
}
```

## Mapping to your `CitizenFX_log_2025-12-29T201242.log`

Your log contains the exact client progress markers from `NetLibrary.cpp`:
- “Requesting server variables…”
- “Obtaining Steam ticket…”
- “Handshaking with server…”
- “Requesting server endpoints…”
- “Requesting server permissions…”
- “Requesting server feature policy…”
- Resource downloads
- “Received connectOK… Network connected…”

## Troubleshooting checklist (common failure points)

- **Stuck on deferrals**: something in `playerConnecting` never calls `deferrals.done()` or txAdmin is deferring.
- **“No authentication ticket was specified.”**: missing/invalid `cfxTicket2` (or client/server mismatch).
- **“Invalid connection token received.”**: ENet connect was attempted with a stale token (often reconnect/race).
- **“Invalid connection.”**: `passedValidation` was never set true (handshake didn’t complete).
- **OneSync slot exhaustion**: server says “Not enough client slot IDs.” (rare; slot pool full).


