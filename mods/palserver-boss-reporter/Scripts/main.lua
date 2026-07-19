-- PalserverBossReporter v1.3
-- v1.3:野外頭目狀態改「黏著」——看過活的就一直記活、擊殺後倒數持續,玩家離開(spawner 卸載)
--       不再退回未知(寫入所有曾觀測過的頭目,不只本 tick 載入的);座標一併記憶。
-- 純伺服器端 UE4SS Lua 模組:每 15 秒輪詢頭目,輸出狀態到
--   Pal/Saved/palserver-boss-state.json 供 palserver-gui agent 讀取。
-- 原理(2026-07-19 實機驗證的遊戲內建 API):
--   野外頭目(bosses[]):
--   - spawner["Is Field Boss or Imprisonment Boss Spawner"](spawner) → 官方頭目判定
--   - spawner.IndividualHandleList(TArray<UPalIndividualCharacterHandle*>)→ 目前生成的個體;
--     逐 handle 讀 TryGetIndividualParameter().SaveParameter.HP.Value 判活(HP>0 活、HP==0 死),
--     讀不到 HP 才退回 TryGetIndividualActor():IsValid()。(tempSpawnedMonster 不可用。)
--   - 活→死 / 死→活 的轉變由本模組記時間戳(擊殺時間、實測重生時間)。
--   地下城頭目(dungeons[]):
--   - FindAllOf("PalDungeonInstanceModelFixedDungeon"):BossState(0 存活 / 1 已擊殺,Replicated)、
--     Level、GetDungeonNameText()(當前語言名稱)、RepFieldWarpPointLocation(入口座標)、
--     CalcRemainSecondsBy(RespawnBossTimeAt)(遊戲自算的重生剩餘秒,免猜 tick 基準)。
-- 不改任何遊戲行為;玩家端不需安裝任何東西。

local MOD = "[BossReporter]"
local INTERVAL_MS = 15000
local STATE_PATH = "../../Saved/palserver-boss-state.json"  -- cwd = Pal/Binaries/Win64
-- 死→活轉變若中間觀測有斷過(spawner 曾從 FindAllOf 消失=區域卸載),算出的
-- 間隔會含卸載空窗而灌水;只有連續觀測(距上次見到 <= 這個秒數)才採信實測冷卻。
local CONTINUITY_SEC = 45  -- 3× 輪詢間隔,容忍偶爾漏掃一次

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
  -- 逐一物件解析(每筆 spawner 是無巢狀的 {...});逐欄位抓,舊版無 respawnInterval 也不整批失敗。
  for obj in body:gmatch('{"name".-}') do
    local name = obj:match('"name":"(.-)"')
    if name then
      local alive = obj:match('"alive":(%a+)')
      local diedAt = obj:match('"diedAt":(-?%d+)')
      local respawnedAt = obj:match('"respawnedAt":(-?%d+)')
      local respawnInterval = obj:match('"respawnInterval":(-?%d+)')  -- 舊格式沒有 → nil
      local x = obj:match('"x":(-?[%d%.]+)')
      local y = obj:match('"y":(-?[%d%.]+)')
      local z = obj:match('"z":(-?[%d%.]+)')
      -- 三態還原:"null" → nil(未知),不可誤標為 false(已擊殺)。
      local av
      if alive == "true" then av = true elseif alive == "false" then av = false end
      track[name] = {
        alive = av,
        diedAt = tonumber(diedAt) or -1,
        respawnedAt = tonumber(respawnedAt) or -1,
        respawnInterval = tonumber(respawnInterval) or -1,
        x = tonumber(x) or 0,
        y = tonumber(y) or 0,
        z = tonumber(z) or 0,
        lastSeen = 0,
      }
      n = n + 1
    end
  end
  log("restored " .. n .. " tracked spawners from previous state")
end

-- 判活:讀 spawner.IndividualHandleList,逐 handle 以 HP 為準(HP>0 活、HP==0 死=遺體 handle
-- 仍在);讀不到 HP 才退回角色是否在場。回傳 true/false/nil(nil=沒有個體 handle,未生成/未載入)。
local function detectAlive(sp)
  local okHL, hl = pcall(function() return sp.IndividualHandleList end)
  if not okHL or not hl then return nil end
  local n = 0
  pcall(function() n = hl:GetArrayNum() end)
  if n == 0 then return nil end
  local hpSeen, bestHp, anyValid = false, 0, false
  for i = 1, n do
    local h = hl[i]
    if h then
      local okP, param = pcall(function() return h:TryGetIndividualParameter() end)
      if okP and param then
        local okHp, hp = pcall(function() return param.SaveParameter.HP.Value end)
        if okHp and type(hp) == "number" then
          hpSeen = true
          if hp > bestHp then bestHp = hp end
        end
      end
      local okA, actor = pcall(function() return h:TryGetIndividualActor() end)
      if okA and actor then
        local okV, valid = pcall(function() return actor:IsValid() end)
        if okV and valid then anyValid = true end
      end
    end
  end
  if hpSeen then return bestHp > 0 end   -- HP 讀到了:>0 活、==0 死
  if anyValid then return true end       -- 讀不到 HP 但角色在場 → 活
  return nil                             -- 都拿不到 → 未知
end

-- 掃地下城頭目:BossState(0 存活/1 已擊殺)、名稱、等級、座標、重生剩餘秒(遊戲自算)。
-- 回傳 JSON 物件字串陣列。地城實例是伺服器端資料(不需玩家貼著),但只列出目前已生成的。
local function scanDungeons()
  local out = {}
  local ok, insts = pcall(function() return FindAllOf("PalDungeonInstanceModelFixedDungeon") end)
  if not ok or not insts then return out end
  local now = os.time()
  for _, inst in ipairs(insts) do
    local bs = 0
    pcall(function() bs = tonumber(inst.BossState) or 0 end)
    local level = -1
    pcall(function() level = inst.Level end)
    local name = "?"
    pcall(function() name = inst:GetDungeonNameText():ToString() end)
    local x, y, z = 0, 0, 0
    pcall(function() local w = inst.RepFieldWarpPointLocation; x, y, z = w.X, w.Y, w.Z end)
    -- 只有已擊殺(BossState==1)才算重生時間:now + 遊戲自算的剩餘秒。
    local respawnAt = -1
    if bs == 1 then
      local remain = 0
      pcall(function() remain = inst:CalcRemainSecondsBy(inst, inst.RespawnBossTimeAt) end)
      if type(remain) == "number" and remain > 0 then respawnAt = now + math.floor(remain) end
    end
    out[#out + 1] = string.format(
      '{"name":"%s","level":%d,"bossState":%d,"respawnAt":%d,"x":%.1f,"y":%.1f,"z":%.1f}',
      jsonEscape(name), level, bs, respawnAt, x, y, z)
  end
  return out
end

local function scanOnce()
  tickCount = tickCount + 1
  local now = os.time()
  local ok, spawners = pcall(function() return FindAllOf("BP_PalSpawner_Standard_C") end)
  if not ok or not spawners then spawners = {} end  -- 沒野外 spawner 也照樣寫地城狀態

  local loadedBosses = 0

  -- Phase 1:用本 tick 載入到的 spawner 更新記憶(track)。detectAlive 只在載入(玩家在附近)時
  -- 有真值;沒載入到的頭目這輪不動它的記憶。
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
      loadedBosses = loadedBosses + 1
      local name = "?"
      pcall(function() name = sp:GetSpawnerName():ToString() end)
      local alive = detectAlive(sp)
      local x, y, z = 0, 0, 0
      pcall(function()
        local loc = sp:K2_GetActorLocation()
        x, y, z = loc.X, loc.Y, loc.Z
      end)

      local t = track[name]
      if not t then
        t = { alive = nil, diedAt = -1, respawnedAt = -1, respawnInterval = -1, x = 0, y = 0, z = 0, lastSeen = 0 }
        track[name] = t
      end
      if alive ~= nil then
        if t.alive == true and alive == false then
          t.diedAt = now
          log("boss DOWN: " .. name .. " at " .. now)
        elseif t.alive == false and alive == true then
          t.respawnedAt = now
          -- 只有「死→活」期間持續觀測(spawner 未卸載)才採信實測冷卻:中間若 spawner
          -- 曾從 FindAllOf 消失(無玩家),lastSeen 會過期,now-diedAt 會含卸載空窗而灌水,
          -- 寧可不記、退回預設倒數。t.lastSeen 此時為「上次見到這隻」的時間。
          if t.diedAt and t.diedAt > 0 and (now - t.lastSeen) <= CONTINUITY_SEC then
            t.respawnInterval = now - t.diedAt
            log("boss RESPAWNED: " .. name .. " after " .. t.respawnInterval .. "s (continuous)")
          else
            log("boss RESPAWNED: " .. name .. " (interval not trusted — observation gap)")
          end
        end
        t.alive = alive
      end
      if x ~= 0 or y ~= 0 or z ~= 0 then t.x, t.y, t.z = x, y, z end  -- 有載入才更新座標
      t.lastSeen = now
    end
  end

  -- Phase 2:寫入「所有曾觀測過」的頭目(不只本 tick 載入的),用記憶裡的最後狀態:
  -- 看過活的就一直記活、擊殺後 diedAt 持續(倒數不停),玩家離開(spawner 卸載)不再退回未知;
  -- 從沒看過的頭目不在 track、仍維持未知(不在清單裡)。
  local entries = {}
  local aliveCount = 0
  for name, t in pairs(track) do
    local aliveStr = t.alive == nil and "null" or tostring(t.alive)
    if t.alive == true then aliveCount = aliveCount + 1 end
    entries[#entries + 1] = string.format(
      '{"name":"%s","alive":%s,"diedAt":%d,"respawnedAt":%d,"respawnInterval":%d,"x":%.1f,"y":%.1f,"z":%.1f}',
      jsonEscape(name), aliveStr, t.diedAt or -1, t.respawnedAt or -1, t.respawnInterval or -1, t.x or 0, t.y or 0, t.z or 0)
  end
  local bossCount = #entries

  local dungeons = {}
  pcall(function() dungeons = scanDungeons() end)
  local body = string.format(
    '{"version":1,"generatedAt":%d,"tick":%d,"spawnerTotal":%d,"bossCount":%d,"aliveCount":%d,"bosses":[%s],"dungeons":[%s]}',
    now, tickCount, #spawners, bossCount, aliveCount, table.concat(entries, ","), table.concat(dungeons, ","))
  local tmp = STATE_PATH .. ".tmp"
  local f = io.open(tmp, "w")
  if f then
    f:write(body)
    f:close()
    os.remove(STATE_PATH)
    os.rename(tmp, STATE_PATH)
  end
  if tickCount <= 3 or tickCount % 40 == 0 then
    log(string.format("tick %d: spawners=%d loaded=%d tracked=%d alive=%d", tickCount, #spawners, loadedBosses, bossCount, aliveCount))
  end
end

log("v1.3 loaded; interval " .. INTERVAL_MS .. "ms")
pcall(loadPrevState)
LoopAsync(INTERVAL_MS, function()
  ExecuteInGameThread(function()
    local ok, err = pcall(scanOnce)
    if not ok then log("scan error: " .. tostring(err)) end
  end)
  return false
end)


