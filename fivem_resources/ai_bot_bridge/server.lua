-- ai_bot_bridge (server)
-- Minimal HTTP control plane for a real FiveM client.
--
-- Design:
-- - External CLI sends HTTP POST /aibot with JSON payload.
-- - Server forwards the command to a specific player via TriggerClientEvent.
-- - Client executes movement/tasks locally (so OneSync replication works normally).
--
-- Security:
-- - Optional bearer token via convar `aibot_token`.
--   If set non-empty, request must include header: Authorization: Bearer <token>

local AI_BOT_PATH = "/aibot"
local token = GetConvar("aibot_token", "")

local lastStateByPlayer = {}

local function nowMs()
    return GetGameTimer()
end

local function jsonResponse(res, status, obj)
    local body = json.encode(obj or {})
    res.writeHead(status or 200, {
        ["Content-Type"] = "application/json; charset=utf-8",
        ["Cache-Control"] = "no-store",
    })
    res.send(body)
end

local function unauthorized(res, msg)
    jsonResponse(res, 401, { ok = false, error = msg or "unauthorized" })
end

local function badRequest(res, msg)
    jsonResponse(res, 400, { ok = false, error = msg or "bad_request" })
end

local function getAuthHeader(req)
    -- FiveM http handler request headers are lowercased.
    if not req.headers then
        return nil
    end
    return req.headers["authorization"]
end

local function checkAuth(req)
    if token == nil or token == "" then
        return true
    end
    local auth = getAuthHeader(req)
    if not auth then
        return false
    end
    return auth == ("Bearer " .. token)
end

local function toNumber(x)
    local n = tonumber(x)
    return n
end

RegisterNetEvent("aibot:state")
AddEventHandler("aibot:state", function(state)
    local src = source
    if type(state) ~= "table" then
        return
    end
    state._serverReceivedAtMs = nowMs()
    lastStateByPlayer[src] = state
end)

AddEventHandler("playerDropped", function()
    local src = source
    lastStateByPlayer[src] = nil
end)

SetHttpHandler(function(req, res)
    if req.path ~= AI_BOT_PATH then
        -- Let other resources handle other paths.
        return
    end

    if req.method ~= "POST" then
        jsonResponse(res, 405, { ok = false, error = "method_not_allowed" })
        return
    end

    if not checkAuth(req) then
        unauthorized(res, "invalid_token")
        return
    end

    req.setDataHandler(function(body)
        local ok, payload = pcall(function()
            return json.decode(body or "")
        end)
        if not ok or type(payload) ~= "table" then
            badRequest(res, "invalid_json")
            return
        end

        local action = payload.action
        if type(action) ~= "string" or action == "" then
            badRequest(res, "missing_action")
            return
        end

        -- `player` is the server ID to target (source id). Required for all actions except "list".
        local target = payload.player
        if action == "list" then
            -- Small introspection helper: list player ids and whether we have recent state.
            local out = {}
            for _, pid in ipairs(GetPlayers()) do
                local id = toNumber(pid)
                local st = lastStateByPlayer[id]
                out[#out + 1] = {
                    player = id,
                    hasState = st ~= nil,
                    lastStateAgeMs = st and (nowMs() - (st._serverReceivedAtMs or nowMs())) or nil,
                    name = GetPlayerName(id),
                }
            end
            jsonResponse(res, 200, { ok = true, players = out })
            return
        end

        local targetNum = toNumber(target)
        if not targetNum then
            badRequest(res, "missing_player")
            return
        end

        if action == "get_state" then
            local st = lastStateByPlayer[targetNum]
            jsonResponse(res, 200, { ok = true, player = targetNum, state = st })
            return
        end

        -- Forward everything else to the target client.
        TriggerClientEvent("aibot:cmd", targetNum, payload)
        jsonResponse(res, 200, { ok = true })
    end)
end)


