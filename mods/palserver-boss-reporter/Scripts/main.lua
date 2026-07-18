-- PalserverBossReporter v0.5
-- 純伺服器端 UE4SS Lua 模組:每 15 秒輪詢頭目 spawner,輸出狀態到
--   Pal/Saved/palserver-boss-state.json 供 palserver-gui agent 讀取。
-- 原理(2026-07-18 實測 dump 取得的遊戲內建 API):
--   - spawner["Is Field Boss or Imprisonment Boss Spawner"](spawner) → 官方頭目判定
--   - spawner:ExistAliveCharacter() → 頭目當前是否存活
--   - 活→死 / 死→活 的轉變由本模組記時間戳(擊殺時間、實測重生時間)
-- 不改任何遊戲行為;玩家端不需安裝任何東西。

local MOD = "[BossReporter]"
local INTERVAL_MS = 15000
local STATE_PATH = "../../Saved/palserver-boss-state.json"  -- cwd = Pal/Binaries/Win64

local tickCount = 0
local track = {}   -- name -> { alive, diedAt, respawnedAt, lastSeen }

local function log(msg) print(MOD .. " " .. tostring(msg) .. "\n") end

local function jsonEscape(s)
  return tostring(s):gsub("\\", "\\\\"):gsub('"', '\\"'):gsub("\n", "\\n"):gsub("\r", "")
end

-- 開機時把上次的狀態讀回來(輕量解析自己寫的固定格式,重啟不失憶)
local function loadPrevState()
  local f = io.open(STATE_PATH, "r")
  if not f then return end
  local body = f:read("*a")
  f:close()
  local n = 0
  for name, alive, diedAt, respawnedAt in
    body:gmatch('{"name":"(.-)","alive":(%a+),"diedAt":(-?%d+),"respawnedAt":(-?%d+)') do
    track[name] = {
      alive = (alive == "true"),
      diedAt = tonumber(diedAt),
      respawnedAt = tonumber(respawnedAt),
      lastSeen = 0,
    }
    n = n + 1
  end
  log("restored " .. n .. " tracked spawners from previous state")
end

local function scanOnce()
  tickCount = tickCount + 1
  local ok, spawners = pcall(function() return FindAllOf("BP_PalSpawner_Standard_C") end)
  if not ok or not spawners then
    if tickCount % 20 == 1 then log("no spawners loaded (tick " .. tickCount .. ")") end
    return
  end

  local now = os.time()
  local entries = {}
  local bossCount, aliveCount = 0, 0

  for _, sp in ipairs(spawners) do
    -- 官方頭目判定;失敗時退回名稱啟發式
    local isBoss = false
    local okB, vB = pcall(function()
      return sp["Is Field Boss or Imprisonment Boss Spawner"](sp)
    end)
    if okB and type(vB) == "boolean" then
      isBoss = vB
    else
      local okN, nm = pcall(function() return sp:GetSpawnerName():ToString() end)
      isBoss = okN and nm and nm:upper():find("BOSS") ~= nil
    end

    if isBoss then
      bossCount = bossCount + 1
      local name = "?"
      pcall(function() name = sp:GetSpawnerName():ToString() end)
      -- 屬性判活(BP 函式經 UE4SS 呼叫會 setup 失敗,屬性讀取才可靠):
      -- tempSpawnedMonster 指向當前生成的頭目個體,有效=活著。
      local alive = nil
      do
        local okM, m = pcall(function() return sp.tempSpawnedMonster end)
        if okM and m then
          local okV, valid = pcall(function() return m:IsValid() end)
          if okV then alive = valid and true or false end
        end
      end
      if tickCount == 1 then
        pcall(function()
          local m = sp.tempSpawnedMonster
          log("diag tempSpawnedMonster valid=" .. tostring(m and m:IsValid()) ..
              " full=" .. tostring(m and m:IsValid() and m:GetFullName() or "-"))
        end)
        pcall(function()
          local hl = sp.IndividualHandleList
          log("diag HandleList class=" .. tostring(hl and hl:GetClass():GetFName():ToString() or "nil"))
        end)
      end
      local x, y, z = 0, 0, 0
      pcall(function()
        local loc = sp:K2_GetActorLocation()
        x, y, z = loc.X, loc.Y, loc.Z
      end)

      local t = track[name]
      if not t then
        t = { alive = alive, diedAt = -1, respawnedAt = -1, lastSeen = now }
        track[name] = t
      end
      if alive ~= nil then
        if t.alive == true and alive == false then
          t.diedAt = now
          log("boss DOWN: " .. name .. " at " .. now)
        elseif t.alive == false and alive == true then
          t.respawnedAt = now
          if t.diedAt and t.diedAt > 0 then
            log("boss RESPAWNED: " .. name .. " after " .. (now - t.diedAt) .. "s")
          end
        end
        t.alive = alive
      end
      t.lastSeen = now

      local aliveStr = alive == nil and "null" or tostring(alive)
      entries[#entries + 1] = string.format(
        '{"name":"%s","alive":%s,"diedAt":%d,"respawnedAt":%d,"x":%.1f,"y":%.1f,"z":%.1f}',
        jsonEscape(name), aliveStr, t.diedAt or -1, t.respawnedAt or -1, x, y, z)
      if alive then aliveCount = aliveCount + 1 end
    end
  end

  local body = string.format(
    '{"version":1,"generatedAt":%d,"tick":%d,"spawnerTotal":%d,"bossCount":%d,"aliveCount":%d,"bosses":[%s]}',
    now, tickCount, #spawners, bossCount, aliveCount, table.concat(entries, ","))
  local tmp = STATE_PATH .. ".tmp"
  local f = io.open(tmp, "w")
  if f then
    f:write(body)
    f:close()
    os.remove(STATE_PATH)
    os.rename(tmp, STATE_PATH)
  end
  if tickCount <= 3 or tickCount % 40 == 0 then
    log(string.format("tick %d: spawners=%d bosses=%d alive=%d", tickCount, #spawners, bossCount, aliveCount))
  end
end

log("v0.4 loaded; interval " .. INTERVAL_MS .. "ms")
pcall(loadPrevState)
LoopAsync(INTERVAL_MS, function()
  ExecuteInGameThread(function()
    local ok, err = pcall(scanOnce)
    if not ok then log("scan error: " .. tostring(err)) end
  end)
  return false
end)
