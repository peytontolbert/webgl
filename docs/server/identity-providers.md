# Identity providers (server identifiers vs client profiles)

This repo contains **two different “identity provider” concepts** that are easy to confuse:

- **Server identity providers**: populate a connecting player’s `fx::Client` **identifiers/tokens** (used by ACL/ACE, scripts, `/players.json`, etc.).
- **Client profile identity providers**: authenticate a *local FiveM profile* (NUI/launcher side), not the server connection.

## 1) Server identity providers (FXServer)

### What they are

They implement `fx::ServerIdentityProviderBase` and run during the HTTP `initConnect` handshake to add:
- `identifier:<type>:...` strings into `fx::Client::m_identifiers`
- optional extra `tokens[]`

These become visible to scripts via natives like `GET_PLAYER_IDENTIFIER*` and used for permissions via principals (e.g. `identifier.license:...`).

### Examples in this repo

- **Steam**: `outdated_resources/fivem/code/components/citizen-server-impl/src/SteamIdentityProvider.cpp`
  - Uses the client-sent `authTicket` and server convars `steam_webApiKey`/`steam_webApiDomain`
  - Adds `steam:<hexid>` to the player’s identifiers

- **License**: `outdated_resources/fivem/code/components/citizen-server-impl/src/LicenseIdentityProvider.cpp`
  - Uses `entitlementHash`/`entitlementJson` produced during `initConnect`
  - Adds `license:<hash>` plus any `tk[]` identifiers and `hw[]` tokens

The “engine-level” writeup of these is in `docs/player-engine-data.md` (section “Identity providers”).

## 2) Client profile identity providers (FiveM client)

### What they are

They implement `ProfileIdentityProvider` and are used by the FiveM client’s **profile manager** to sign in to a *local profile identity* (e.g. Steam, Rockstar).

This is **not** the same as server-side identifiers used by FXServer for player permissions.

### Steam profile identity provider (your file)

`outdated_resources/fivem/code/components/profiles/src/IdentityProviderSteam.cpp`:

- Checks Steam is running and that the current SteamID matches the profile’s stored identifiers
- Generates an **auth session ticket**, base64-encodes it, and returns it as a `ProfileIdentityResult`

```14:108:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/profiles/src/IdentityProviderSteam.cpp
class SteamIdentityProvider : public ProfileIdentityProvider
{
public:
  virtual const char* GetIdentifierKey() override;
  virtual bool RequiresCredentials() override;
  virtual concurrency::task<ProfileIdentityResult> ProcessIdentity(fwRefContainer<Profile> profile, const std::map<std::string, std::string>& parameters) override;
};

concurrency::task<ProfileIdentityResult> SteamIdentityProvider::ProcessIdentity(...)
{
  // ensure Steam running + get SteamID
  // verify profile contains this SteamID
  // GetAuthSessionTicket(...)
  // base64_encode(ticketBuffer, ticketLength + 10)
  // return ProfileIdentityResult(...)
}
```

Registration into the profile manager:

```111:116:/data/NexusAI/fivem_server/outdated_resources/fivem/code/components/profiles/src/IdentityProviderSteam.cpp
static InitFunction initFunction([] ()
{
  ProfileManagerImpl* ourProfileManager = static_cast<ProfileManagerImpl*>(Instance<ProfileManager>::Get());
  ourProfileManager->AddIdentityProvider(new SteamIdentityProvider());
});
```

### Related client profile providers

- `outdated_resources/fivem/code/components/profiles/src/IdentityProviderROS.cpp` (Rockstar/Social Club profile identity)

## 3) How these two concepts relate (practically)

- The **client profile identity provider** helps the local FiveM client prove it is signed into Steam/ROS for profile purposes.
- The **server identity provider** helps FXServer attach stable identifiers (like `steam:` / `license:`) to the connecting `fx::Client`.

They may both use “Steam tickets”, but they are used in different subsystems and formats.


