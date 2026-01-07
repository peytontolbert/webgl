# Engine-level player data (identity, permissions, HTTP surfaces, metrics)

This doc is **engine-level**: what FXServer/FiveM stores about a player connection and how that data flows through the engine.

> Related:
> - `docs/server_client_pipeline_official.md` (auth/connect overview)
> - `docs/in-session-pipeline.md` (post-connect packet lanes)
> - `docs/player-state.md` (player state replication)
> - `docs/onesync.md` (OneSync replication internals)

## 1) The `Client` object: the canonical per-player data container

Server-side “player data” is mostly attached to `fx::Client`:

- **Identity**
  - `guid` (primary stable GUID)
  - `identifiers[]` (license/steam/etc strings)
  - `tokens[]` (additional token strings)
- **Connection**
  - `peer address` (UDP peer) and `tcp endpoint` (used by some APIs)
  - `connectionToken` (ties HTTP handshake to ENet connect)
  - `firstSeen/lastSeen` (activity/timeout)
- **Permissions**
  - `Client` is a `se::PrincipalSource`
  - cached principals derived from identifiers and `player.<netId>`
- **Arbitrary engine data**
  - `SetData/GetData` using typed `Any` entries (used for entitlement hash/json, deferrals, etc.)

Identifiers/tokens + principal scope:

```245:282:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/include/Client.h
inline const std::vector<std::string>& GetIdentifiers()
{
  return m_identifiers;
}

inline const std::vector<std::string>& GetTokens()
{
  return m_tokens;
}

inline void AddIdentifier(const std::string& identifier)
{
  m_identifiers.emplace_back(identifier);
  UpdateCachedPrincipalValues();
}

inline void AddToken(const std::string& token)
{
  m_tokens.emplace_back(token);
}

inline auto EnterPrincipalScope()
{
  auto principal = std::make_unique<se::ScopedPrincipal>(this);
  return std::move(principal);
}
```

Typed data attachment (`SetData`) and cached principal derivation:

```349:402:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/include/Client.h
template<typename TAny>
inline void SetData(const std::string& key, const TAny& data)
{
  if constexpr (std::is_same_v<TAny, std::nullptr_t>)
  {
    SetDataRaw(key, {});
    return;
  }

  SetDataRaw(key, MakeAny(data));
}

inline void UpdateCachedPrincipalValues()
{
  m_principals = {};
  for (auto& identifier : this->GetIdentifiers())
  {
    m_principals.emplace_back(se::Principal{ fmt::sprintf("identifier.%s", identifier) });
  }

  m_principals.emplace_back(se::Principal{ fmt::sprintf("player.%d", m_netId) });
}
```

## 2) Identity providers (where identifiers come from)

FXServer uses “identity providers” that can add identifiers during the HTTP handshake.

### Steam identifier (`steam:...`)

Steam provider consumes `authTicket` from the client and (if server has a Web API key) adds a `steam:` identifier:

```65:116:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/SteamIdentityProvider.cpp
virtual void RunAuthentication(const fx::ClientSharedPtr& clientPtr, const std::map<std::string, std::string>& postMap, const std::function<void(boost::optional<std::string>)>& cb) override
{
  auto it = postMap.find("authTicket");
  if (it == postMap.end())
  {
    cb({});
    return;
  }
  // ... call Steam Web API ...
  uint64_t steamId = strtoull(object["params"]["steamid"].get<std::string>().c_str(), nullptr, 10);
  clientPtr->AddIdentifier(fmt::sprintf("steam:%015llx", steamId));
}
```

### License + tokens (`license:...` and `tk`/`hw`)

The license provider reads:
- `entitlementHash` → adds `license:<hash>`
- `entitlementJson` → adds identifiers from `tk[]` and tokens from `hw[]`

```34:67:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/LicenseIdentityProvider.cpp
auto any = clientPtr->GetData("entitlementHash");
if (any)
{
  clientPtr->AddIdentifier(fmt::sprintf("license:%s", fx::AnyCast<std::string>(any)));
}

auto jsonAny = clientPtr->GetData("entitlementJson");
if (jsonAny)
{
  auto jsonStr = fx::AnyCast<std::string>(jsonAny);
  json json = json::parse(jsonStr);

  if (json["tk"].is_array())
  {
    for (auto& entry : json["tk"])
    {
      clientPtr->AddIdentifier(entry.get<std::string>());
    }
  }

  if (json["hw"].is_array())
  {
    for (auto& entry : json["hw"])
    {
      clientPtr->AddToken(entry.get<std::string>());
    }
  }
}
```

### Where entitlement fields get attached

During the HTTP `initConnect` handshake, the server sets `entitlementHash` and `entitlementJson` on the client object:

```776:809:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/InitConnectMethod.cpp
if (ticketData.entitlementHash)
{
  client->SetData("entitlementHash", fmt::sprintf("%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x",
    hash[0], hash[1], hash[2], hash[3], hash[4], hash[5], hash[6], hash[7], hash[8], hash[9],
    hash[10], hash[11], hash[12], hash[13], hash[14], hash[15], hash[16], hash[17], hash[18], hash[19]));
}

if (ticketData.extraJson)
{
  client->SetData("entitlementJson", *ticketData.extraJson);
}
```

## 3) Permissions: principals and ACE checks

The engine uses a “principal scope” when executing privileged operations for a player.

### Packet processing runs inside a principal scope

When the server processes a packet for a client, it enters the client’s principal scope:

```773:785:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/GameServer.cpp
auto principalScope = client->EnterPrincipalScope();

if (client->GetNetworkMetricsRecvCallback())
{
  client->GetNetworkMetricsRecvCallback()(client.get(), msgType, msg);
}

if (m_packetHandler)
{
  m_packetHandler(msgType, client, msg, packet);
}
```

### Script API: `IS_PLAYER_ACE_ALLOWED`

Server scripts can query privileges using `IS_PLAYER_ACE_ALLOWED`, which checks under the player’s principal scope:

```180:188:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/PlayerScriptFunctions.cpp
fx::ScriptEngine::RegisterNativeHandler("IS_PLAYER_ACE_ALLOWED", MakeClientFunction([](fx::ScriptContext& context, const fx::ClientSharedPtr& client)
{
  const char* object = context.CheckArgument<const char*>(1);
  se::ScopedPrincipalReset reset;
  auto principalScope = client->EnterPrincipalScope();
  return seCheckPrivilege(object);
}));
```

## 4) Engine HTTP “player data” surface: `/players.json`

FXServer builds two JSON blobs each second:
- **private**: includes identifiers
- **public**: hides identifiers if configured

And serves:
- `GET /players.json` (public blob)
- `GET /players.json?token=...` or header `X-Players-Token` (private blob)

```339:473:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/InfoHttpHandler.cpp
instance->GetComponent<fx::HttpServerManager>()->AddEndpoint("/players.json", ...);
// token check: X-Players-Token header or ?token=
// builds JSON objects with {endpoint,id,identifiers,name,ping}
// chooses playerBlob vs publicPlayerBlob depending on auth and exposePlayerIdentifiersInHttpEndpoint
```

The server-side token used here is controlled via `sv_playersToken`:

```116:118:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/GameServer.cpp
m_playersToken = instance->AddVariable<std::string>("sv_playersToken", ConVar_None, "");
m_profileDataToken = instance->AddVariable<std::string>("sv_profileDataToken", ConVar_None, "");
```

## 5) Engine player introspection APIs (server scripting)

FXServer exposes “engine player data” to scripts via natives:

- identifiers: `GET_NUM_PLAYER_IDENTIFIERS`, `GET_PLAYER_IDENTIFIER`, `GET_PLAYER_IDENTIFIER_BY_TYPE`
- tokens: `GET_NUM_PLAYER_TOKENS`, `GET_PLAYER_TOKEN`
- ping/endpoint: `GET_PLAYER_PING`, `GET_PLAYER_ENDPOINT`
- last msg age: `GET_PLAYER_LAST_MSG`

These all read from `fx::Client` and/or the underlying ENet peer:

```47:117:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/PlayerScriptFunctions.cpp
GET_NUM_PLAYER_IDENTIFIERS → client->GetIdentifiers().size()
GET_PLAYER_TOKEN → client->GetTokens()[idx]
GET_PLAYER_PING → peer->GetPing()
```

## 6) Metrics: what the engine can observe per player

There are two major layers:

- **Net metrics sink (client-side NetLibrary)**: packet sizes, command types, route packets, ping, packet loss.

```16:38:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/net/include/INetMetricSink.h
virtual void OnPingResult(int msec) = 0;
virtual void OnPacketLossResult(int plPercent) = 0;
virtual void OnIncomingCommand(uint32_t type, size_t size, bool reliable = false) = 0;
virtual void OnOutgoingCommand(uint32_t type, size_t size, bool reliable = false) = 0;
```

- **Server-side peer stats** exposed to scripts via `GET_PLAYER_PEER_STATISTICS` (ENet-level counters).

## 7) Drop reasons (engine-level)

The engine classifies drops with a structured reason enum:

```5:31:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/include/ClientDropReasons.h
enum class ClientDropReason: uint32_t
{
  RESOURCE = 1,
  CLIENT,
  SERVER,
  CLIENT_REPLACED,
  CLIENT_CONNECTION_TIMED_OUT,
  CLIENT_CONNECTION_TIMED_OUT_WITH_PENDING_COMMANDS,
  SERVER_SHUTDOWN,
  STATE_BAG_RATE_LIMIT,
  NET_EVENT_RATE_LIMIT,
  LATENT_NET_EVENT_RATE_LIMIT,
  COMMAND_RATE_LIMIT,
  ONE_SYNC_TOO_MANY_MISSED_FRAMES
};
```

## 8) Engine-level rate limiting (why players get dropped)

Three high-signal examples (all server-side):

- **Network events** rate/size limits:

```20:56:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/packethandlers/ServerEventPacketHandler.cpp
netEvent rate limit → DropClientWithReason(... NET_EVENT_RATE_LIMIT, "Reliable network event overflow.")
netEventSize limit → DropClientWithReason(... NET_EVENT_RATE_LIMIT, "Reliable network event size overflow: %s", eventName)
```

- **Server commands** rate/size limits:

```63:92:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/citizen-server-impl/src/packethandlers/ServerCommandPacketHandler.cpp
netCommandFlood → DropClientWithReason(... COMMAND_RATE_LIMIT, "Reliable server command overflow.")
netCommandSize  → DropClientWithReason(... COMMAND_RATE_LIMIT, "Reliable server command size overflow: %s", ...)
```

- **State bag updates** rate/size limits:
  - See `.../packethandlers/StateBagPacketHandler.cpp` (documented in `docs/in-session-pipeline.md` and `docs/player-state.md`)


