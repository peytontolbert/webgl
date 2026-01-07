# AI bot bridge (HTTP → FXServer → client) for a lightweight CLI controller

This repo does **not** implement a custom FiveM network client (auth + ENet + OneSync clone streams).
Instead, it provides a small bridge so you can control a **real** FiveM client from an external AI/CLI
process without graphics on the control side:

**CLI** → `POST /aibot` → **FXServer** → `TriggerClientEvent("aibot:cmd")` → **client natives/tasks**

## What you get

- A FiveM resource: `fivem_resources/ai_bot_bridge`
  - server: exposes `POST /aibot`
  - client: receives commands and applies movement/tasks to `PlayerPedId()`
  - client also sends a periodic heartbeat so the server can answer `get_state`
- A Python CLI: `tools/aibot_cli.py`

## Install (server)

1. Copy/link `fivem_resources/ai_bot_bridge` into your FXServer `resources/` folder.
2. Add to `server.cfg`:

```cfg
ensure ai_bot_bridge

# Optional: protect the HTTP endpoint
set aibot_token "change-me"
```

## Use (CLI)

List players:

```bash
python3 tools/aibot_cli.py --server http://127.0.0.1:30120 list
```

Get state for a player (server id `3`):

```bash
python3 tools/aibot_cli.py --server http://127.0.0.1:30120 --player 3 state
```

Walk:

```bash
python3 tools/aibot_cli.py --server http://127.0.0.1:30120 --player 3 walk --x -80 --y -820 --z 326 --speed 1.0
```

Stop:

```bash
python3 tools/aibot_cli.py --server http://127.0.0.1:30120 --player 3 stop
```

If you set `aibot_token`, pass:

```bash
python3 tools/aibot_cli.py --server http://127.0.0.1:30120 --token change-me --player 3 state
```

## Endpoint contract (`POST /aibot`)

All requests are JSON.

- `{"action":"list"}`
- `{"action":"get_state","player":3}`
- `{"action":"stop","player":3}`
- `{"action":"teleport","player":3,"x":0,"y":0,"z":72,"heading":90}`
- `{"action":"walk_to","player":3,"x":0,"y":0,"z":72,"speed":1.0,"timeoutMs":-1,"heading":0,"distToStop":0.25}`


