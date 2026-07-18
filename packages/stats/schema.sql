-- 匿名安裝(= 管理者):同一個 installId 重複回報只算一列。
CREATE TABLE IF NOT EXISTS installs (
  id TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  version TEXT,
  platform TEXT
);

-- 不重複玩家:只存單向雜湊(見 PRIVACY.md),不存原始識別碼。
CREATE TABLE IF NOT EXISTS players (
  hash TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL
);

-- 累計計數器:instance_created / server_started。
CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- 雜項快取(GitHub 下載數等)。
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 贊助者識別碼(先行版授權)。一碼綁一台:第一次啟用時把 bound_to 設成該機器碼,
-- 之後只有同一台能再驗證通過。features 是解鎖的功能 id JSON 陣列。
CREATE TABLE IF NOT EXISTS licenses (
  code TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'sponsor',
  features TEXT NOT NULL DEFAULT '[]',
  sponsor TEXT,               -- 備註:發給誰
  created_at TEXT NOT NULL,
  expires_at TEXT,            -- null = 永久
  bound_to TEXT,              -- 機器碼,首次啟用前為 null
  activated_at TEXT,
  email TEXT,                 -- BMC 會員的 email(月費續訂靠它找同一張碼)
  source TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'bmc' | 'campaign'
  trial_days INTEGER          -- 試用碼:啟用當下才起算 N 天(activate 時寫入 expires_at);null=非試用
);
-- 已建好舊表的話,補欄位(第一次沒有這些欄時執行;已存在會報錯可忽略):
--   ALTER TABLE licenses ADD COLUMN email TEXT;
--   ALTER TABLE licenses ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
--   ALTER TABLE licenses ADD COLUMN trial_days INTEGER;

-- email 部分唯一索引:同一個 BMC email 永遠只有一張碼。這是 webhook 防重複發碼的
-- 依靠(BMC 對同一次訂閱會連發多個事件,INSERT 走 ON CONFLICT(email) 變續期)。
-- 舊庫升級:若已有重複 email 會建索引失敗,先看重複再去重(留已綁定的,其次最早的;
-- 落選的碼 email 清空 → 保持可用但不再續期):
--   SELECT email, COUNT(*) n, GROUP_CONCAT(code) codes FROM licenses
--     WHERE email IS NOT NULL GROUP BY email HAVING n > 1;
--   UPDATE licenses SET email = NULL
--   WHERE email IS NOT NULL AND code NOT IN (
--     SELECT code FROM licenses l WHERE l.email = licenses.email
--     ORDER BY (l.bound_to IS NOT NULL) DESC, l.created_at ASC, l.code ASC LIMIT 1);
DROP INDEX IF EXISTS idx_licenses_email;
CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_email_unique ON licenses(email) WHERE email IS NOT NULL;

-- 公開地圖快照:服主一鍵把伺服器地圖公開到全網,agent 每 60 秒推送最新快照,
-- 公開 viewer 頁用 id(shareId)讀取。key_hash 只存 SHA-256 雜湊,不存明碼,
-- 用於 publish/unpublish 時證明擁有權(誰能覆寫/下架這個 id)。
-- revoked:unpublish 留下的墓碑(1 = 已下架,snapshot 同時清空),擋住舊 key 之後
-- 重新 publish 同一個 id 時被當「首次註冊」復活(見 src/index.ts 的 handleMapPublish)。
CREATE TABLE IF NOT EXISTS map_shares (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

-- 新 id 註冊的 per-IP 節流紀錄(只在「新 id」首次註冊時寫入一筆,更新既有 id 不算)。
-- 24 小時內同一 ip_hash 超過門檻就拒絕新註冊,擋濫用把 D1 灌爆;48 小時前的舊紀錄
-- 在下一次新註冊時順手清掉,不需要另外排程。ip_hash 是 CF-Connecting-IP 的 SHA-256。
CREATE TABLE IF NOT EXISTS map_reg (
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_map_reg_ip_created ON map_reg(ip_hash, created_at);
