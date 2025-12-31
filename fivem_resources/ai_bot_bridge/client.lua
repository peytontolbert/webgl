-- ai_bot_bridge (client)
-- Receives commands from server and applies movement/tasks to the local player ped.

local function num(x)
    return tonumber(x)
end

local function getPed()
    return PlayerPedId()
end

local function sendState()
    local ped = getPed()
    if not ped or ped == 0 then
        return
    end
    local x, y, z = table.unpack(GetEntityCoords(ped))
    local heading = GetEntityHeading(ped)
    local health = GetEntityHealth(ped)
    local armour = GetPedArmour(ped)
    local inVeh = IsPedInAnyVehicle(ped, false)
    local veh = inVeh and GetVehiclePedIsIn(ped, false) or 0

    TriggerServerEvent("aibot:state", {
        coords = { x = x, y = y, z = z },
        heading = heading,
        health = health,
        armour = armour,
        inVehicle = inVeh,
        vehicle = veh,
        gameTimer = GetGameTimer(),
    })
end

-- Periodic state heartbeat for server-side HTTP `get_state`
CreateThread(function()
    while true do
        sendState()
        Wait(500)
    end
end)

RegisterNetEvent("aibot:cmd")
AddEventHandler("aibot:cmd", function(payload)
    if type(payload) ~= "table" then
        return
    end

    local action = payload.action
    if type(action) ~= "string" then
        return
    end

    local ped = getPed()
    if not ped or ped == 0 then
        return
    end

    if action == "stop" then
        ClearPedTasks(ped)
        return
    end

    if action == "teleport" then
        local x = num(payload.x)
        local y = num(payload.y)
        local z = num(payload.z)
        if not x or not y or not z then
            return
        end
        SetEntityCoordsNoOffset(ped, x + 0.0, y + 0.0, z + 0.0, false, false, false)
        if payload.heading ~= nil then
            local h = num(payload.heading)
            if h then
                SetEntityHeading(ped, h + 0.0)
            end
        end
        return
    end

    if action == "set_heading" then
        local h = num(payload.heading)
        if not h then
            return
        end
        SetEntityHeading(ped, h + 0.0)
        return
    end

    if action == "walk_to" then
        local x = num(payload.x)
        local y = num(payload.y)
        local z = num(payload.z)
        if not x or not y or not z then
            return
        end

        local speed = num(payload.speed) or 1.0
        local timeoutMs = num(payload.timeoutMs) or -1
        local heading = num(payload.heading) or 0.0
        local distToStop = num(payload.distToStop) or 0.25

        TaskGoStraightToCoord(ped, x + 0.0, y + 0.0, z + 0.0, speed + 0.0, timeoutMs, heading + 0.0, distToStop + 0.0)
        return
    end

    if action == "run_to" then
        local x = num(payload.x)
        local y = num(payload.y)
        local z = num(payload.z)
        if not x or not y or not z then
            return
        end

        -- TASK_GO_STRAIGHT_TO_COORD doesn't have explicit "run" - speed controls it, and the game decides gait.
        local speed = num(payload.speed) or 3.0
        local timeoutMs = num(payload.timeoutMs) or -1
        local heading = num(payload.heading) or 0.0
        local distToStop = num(payload.distToStop) or 0.25

        TaskGoStraightToCoord(ped, x + 0.0, y + 0.0, z + 0.0, speed + 0.0, timeoutMs, heading + 0.0, distToStop + 0.0)
        return
    end

    if action == "wander" then
        local heading = num(payload.heading) or 0.0
        local delayMs = num(payload.delayMs) or 0
        local unknown = num(payload.unknown) or 0
        TaskWanderStandard(ped, heading + 0.0, delayMs, unknown)
        return
    end
end)


