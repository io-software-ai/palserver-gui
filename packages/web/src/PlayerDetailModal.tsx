import { useCallback, useEffect, useMemo, useState } from "react";
import { FiX, FiCpu, FiLock, FiPackage, FiRefreshCw, FiTrendingUp, FiZap, FiShield } from "react-icons/fi";
import { GiShield } from "react-icons/gi";
import {
  hasFeature,
  type PlayerDetail,
  type PdRestStatus,
  type SavePalRow,
  type SavePlayerProfile,
} from "@palserver/shared";
import type { AgentClient } from "./api";
import { useGameData, displayName, palIconUrl, itemIconUrl, type GameData } from "./gameData";
import { maskSteamId } from "./SteamId";
import { t, useI18n } from "./i18n";
import { Overlay, card, btn, btnGhost, errorCls } from "./ui";

/**
 * 玩家詳情 — 兩個資料來源「合併成同一個視圖」,不分區:
 *  - PalDefender REST(即時):線上狀態、隊伍/帕魯箱分組、背包、進度
 *  - 存檔快照(save-tools 掃描,手動刷新):離線也查得到,補上個體值/詞條/
 *    星級/幸運/頭目與最後上線 —— 兩邊的帕魯用 InstanceId 對上,同一張卡呈現
 * 任一來源不可用時,另一邊仍完整運作;各種失敗狀態(平台不支援、agent 過舊、
 * 掃描失敗)都顯式呈現,不會出現「按了沒反應」的死按鈕。
 */
export function PlayerDetailModal({
  client,
  instanceId,
  identifier,
  displayLabel,
  onClose,
  onGoToPalDefender,
}: {
  client: AgentClient;
  instanceId: string;
  identifier: string;
  displayLabel: string;
  onClose: () => void;
  /** Jump to the PalDefender tab so the user can enable REST + set a token. */
  onGoToPalDefender?: () => void;
}) {
  useI18n();
  const gameData = useGameData();
  const [detail, setDetail] = useState<PlayerDetail | null>(null);
  const [rest, setRest] = useState<PdRestStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── 存檔快照側 ──
  const [entitled, setEntitled] = useState<boolean | null>(null);
  const [worldGuid, setWorldGuid] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [profile, setProfile] = useState<SavePlayerProfile | null>(null);
  const [snapNote, setSnapNote] = useState<string | null>(null); // 平台不支援/agent 過舊/找不到玩家
  const [canScan, setCanScan] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  useEffect(() => {
    client
      .playerDetail(instanceId, identifier)
      .then((d) => {
        setDetail(d);
        if (!d.available) client.palDefenderRest(instanceId).then(setRest).catch(() => {});
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        client.palDefenderRest(instanceId).then(setRest).catch(() => {});
      });
  }, [client, instanceId, identifier]);

  useEffect(() => {
    client
      .license()
      .then((l) => setEntitled(hasFeature("save-slim", l)))
      .catch(() => setEntitled(false));
  }, [client, instanceId]);

  const norm = (s: string) => s.replace(/-/g, "").toLowerCase();
  const restUid = detail?.available ? detail.playerUid : null;

  /** 讀快照 + 比對出這位玩家;失敗原因寫進 snapNote(顯式,不做死按鈕)。 */
  const loadSnapshot = useCallback(async () => {
    try {
      const summary = await client.playersSnapshot(instanceId);
      setWorldGuid(summary.worldGuid);
      setGeneratedAt(summary.generatedAt);
      // 平台支不支援掃描,問一次健檢狀態(它回 supported + reason)
      try {
        const health = await client.saveHealth(instanceId, summary.worldGuid);
        setCanScan(health.supported);
        if (!health.supported) setSnapNote(health.reason ?? t("此主機不支援存檔掃描"));
      } catch {
        setCanScan(false);
      }
      if (!summary.generatedAt) {
        setProfile(null);
        return;
      }
      const match =
        (restUid && summary.players.find((p) => norm(p.uid) === norm(restUid))) ||
        summary.players.find((p) => p.name === displayLabel);
      if (!match) {
        setProfile(null);
        setSnapNote(t("快照裡找不到這位玩家(名稱或 UID 對不上)。掃描一次最新存檔試試。"));
        return;
      }
      const { profile: full } = await client.playerSnapshotProfile(instanceId, summary.worldGuid, match.uid);
      setProfile(full);
      setSnapNote(null);
    } catch (err) {
      // 舊版 agent 沒有快照端點、或世界解析失敗 → 把原因講清楚,不留死按鈕
      setCanScan(false);
      setSnapNote(
        t("無法取得存檔快照:{reason}", {
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }, [client, instanceId, restUid, displayLabel]);

  useEffect(() => {
    if (entitled) void loadSnapshot();
  }, [entitled, loadSnapshot]);

  const scan = async () => {
    if (!worldGuid) return;
    setScanError(null);
    setScanning(true);
    try {
      await client.startSaveHealth(instanceId, worldGuid);
      await new Promise<void>((resolve) => {
        const timer = setInterval(async () => {
          try {
            const s = await client.saveHealth(instanceId, worldGuid);
            if (s.phase === "idle") {
              clearInterval(timer);
              if (s.error) setScanError(s.error);
              resolve();
            }
          } catch {
            /* 暫時性網路錯誤:下一輪再試 */
          }
        }, 2000);
      });
      await loadSnapshot();
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  };

  // ── 合併:存檔帕魯依 InstanceId 建索引,REST 卡片就地補個體值/詞條 ──
  const saveByInstance = useMemo(() => {
    const m = new Map<string, SavePalRow>();
    for (const p of profile?.pals ?? []) if (p.instanceId) m.set(norm(p.instanceId), p);
    return m;
  }, [profile]);

  const restAvailable = !!detail?.available;
  const needsRestSetup = !!rest?.installed && !(rest.enabled && rest.hasToken);

  return (
    <Overlay onClose={onClose}>
      <div
        className={`${card} flex max-h-[85vh] w-[720px] max-w-full flex-col gap-4 overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-lg font-extrabold">{displayLabel}</h2>
          <div className="flex items-center gap-2">
            {entitled && canScan && (
              <button
                className={`${btnGhost} inline-flex items-center gap-1.5`}
                onClick={() => void scan()}
                disabled={scanning}
              >
                <FiRefreshCw className={`size-3.5 ${scanning ? "animate-spin" : ""}`} />
                {scanning ? t("掃描存檔中…(依存檔大小可能需要幾分鐘)") : t("從存檔刷新")}
              </button>
            )}
            <button className={btnGhost} onClick={onClose}>
              <FiX className="inline size-4" /> {t("關閉")}
            </button>
          </div>
        </div>

        {generatedAt && (
          <p className="-mt-2 text-xs text-ink-muted">
            {t("存檔資料掃描於 {when};即時資料(在線/背包)來自 PalDefender。", {
              when: new Date(generatedAt).toLocaleString(),
            })}
          </p>
        )}

        {error && <p className={errorCls}>{error}</p>}
        {scanError && <p className={errorCls}>{t("存檔掃描失敗:{reason}", { reason: scanError })}</p>}
        {entitled === false && (
          <div className="inline-flex items-center gap-2 rounded-cute border-2 border-sun/40 bg-sun/10 px-3 py-2 text-xs font-bold text-sun">
            <FiLock className="size-4 shrink-0" />
            {t("個體值、詞條與離線玩家資料是贊助者功能。到「設定 → 贊助者識別碼」輸入識別碼即可使用。")}
          </div>
        )}
        {entitled && snapNote && !scanning && (
          <p className="text-[13px] text-ink-muted">{snapNote}</p>
        )}
        {entitled && canScan && !generatedAt && !scanning && !snapNote && (
          <p className="text-[13px] text-ink-muted">
            {t("尚未掃描過存檔。點「從存檔刷新」建立快照:不依賴 PalDefender,離線玩家也查得到,並包含個體值與詞條。")}
          </p>
        )}

        {!detail && !error && <p className="text-ink-muted">{t("載入中…")}</p>}

        {detail && !restAvailable && !profile && (
          <div className="rounded-(--radius-cute) border-2 border-dashed border-line px-6 py-8 text-center text-ink-muted">
            <GiShield className="mx-auto mb-2 size-11" />
            <p className="font-bold">{t("無法讀取玩家細節")}</p>
            <p className="mt-1 text-[13px]">{detail.reason}</p>

            {needsRestSetup ? (
              <div className="mt-4 flex flex-col items-center gap-3">
                <p className="text-[13px]">
                  {t("玩家細節需要 PalDefender 的 REST API。請到 PalDefender 分頁啟用 REST API 並建立存取權杖。")}
                </p>
                <p className="text-xs text-sun">{t("啟用或變更後,需要重啟伺服器一次才會生效。")}</p>
                {onGoToPalDefender && (
                  <button
                    className={`${btn} inline-flex items-center gap-1.5`}
                    onClick={() => {
                      onClose();
                      onGoToPalDefender();
                    }}
                  >
                    <FiShield className="size-4" /> {t("前往 PalDefender 設定")}
                  </button>
                )}
              </div>
            ) : rest && !rest.installed ? (
              <p className="mt-2 text-xs">
                {t("即時玩家細節需要安裝 PalDefender 並啟用其 REST API;或用上方「從存檔刷新」改讀存檔資料。")}
              </p>
            ) : null}
          </div>
        )}

        {(restAvailable || profile) && (
          <MergedBody
            detail={restAvailable ? detail : null}
            profile={profile}
            saveByInstance={saveByInstance}
            gameData={gameData}
            fallbackName={displayLabel}
          />
        )}
      </div>
    </Overlay>
  );
}

/** REST + 存檔的單一合併視圖。任一來源缺席時,另一邊獨立成立。 */
function MergedBody({
  detail,
  profile,
  saveByInstance,
  gameData,
  fallbackName,
}: {
  detail: PlayerDetail | null;
  profile: SavePlayerProfile | null;
  saveByInstance: Map<string, SavePalRow>;
  gameData: GameData | null;
  fallbackName: string;
}) {
  const norm = (s: string) => s.replace(/-/g, "").toLowerCase();
  const prog = detail?.available ? detail.progression : null;
  const team = detail?.available ? detail.pals.filter((p) => p.location === "team") : [];
  const palbox = detail?.available ? detail.pals.filter((p) => p.location === "palbox") : [];
  const restHasPals = team.length + palbox.length > 0;

  // REST 沒帕魯資料(未裝/離線)時,退回存檔清單
  const savePals = profile?.pals ?? [];

  const lastOnline =
    profile?.lastOnlineDaysAgo === null || profile?.lastOnlineDaysAgo === undefined
      ? null
      : profile.lastOnlineDaysAgo === 0
        ? t("今天")
        : t("{n} 天前", { n: profile.lastOnlineDaysAgo });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <Info label={t("名稱")} value={(detail?.available && detail.name) || profile?.name || fallbackName} />
        <Info label={t("公會")} value={(detail?.available && detail.guildName) || profile?.guildName || t("無")} />
        {detail?.available && <Info label="UserId" value={detail.userId ? maskSteamId(detail.userId) : "—"} />}
        <Info
          label={t("等級")}
          value={prog ? `Lv.${prog.level}` : profile?.level !== null && profile ? `Lv.${profile.level}` : "—"}
        />
        {lastOnline !== null && <Info label={t("最後上線")} value={lastOnline} />}
        {detail?.available ? (
          <>
            <Info label={t("隊伍帕魯")} value={String(detail.teamCount)} />
            <Info label={t("帕魯箱")} value={String(detail.palboxCount)} />
          </>
        ) : (
          profile && <Info label={t("名下帕魯")} value={String(profile.palCount)} />
        )}
      </div>

      {prog && <Progression prog={prog} />}
      {detail?.available && detail.techs && (
        <div>
          <h3 className="mb-1 inline-flex items-center gap-1.5 text-sm font-extrabold text-ink-muted">
            <FiCpu className="size-4 text-pal" /> {t("已解鎖科技")}
          </h3>
          <p className="text-[13px]">
            {t("{n} / {total} 項", { n: detail.techs.unlockedCount, total: detail.techs.totalCount })}
          </p>
        </div>
      )}

      {restHasPals ? (
        <>
          {team.length > 0 && (
            <PalGroup
              title={t("隊伍")}
              pals={team.map((p) => mergePal(p, saveByInstance.get(norm(p.instanceId))))}
              gameData={gameData}
            />
          )}
          {palbox.length > 0 && (
            <PalGroup
              title={t("帕魯箱")}
              pals={palbox.map((p) => mergePal(p, saveByInstance.get(norm(p.instanceId))))}
              gameData={gameData}
            />
          )}
        </>
      ) : savePals.length > 0 ? (
        <PalGroup
          title={t("名下帕魯")}
          pals={savePals.map((s) => mergePal(null, s))}
          total={profile?.palCount}
          gameData={gameData}
        />
      ) : detail?.available && detail.palsUnavailable ? (
        <p className="rounded-xl bg-sun/10 px-3 py-2 text-[13px] font-bold text-sun">
          {t("PalDefender 讀不到離線玩家的帕魯;可用「從存檔刷新」改讀存檔資料。")}
        </p>
      ) : null}

      {detail?.available && (
        <ItemList items={detail.items} gameData={gameData} unavailable={!!detail.itemsUnavailable} />
      )}
    </div>
  );
}

/** 合併後的帕魯卡資料:REST 給即時面(暱稱/等級/位置),存檔補深度面(IV/詞條/星級)。 */
interface MergedPal {
  key: string;
  speciesId: string;
  nickname?: string;
  level: number | null;
  shiny: boolean;
  isBoss: boolean;
  gender: "male" | "female" | null;
  rank: number;
  save: SavePalRow | null;
}

function mergePal(
  restPal: { instanceId: string; palId: string; nickname: string; gender: string; level: number; shiny: boolean } | null,
  save: SavePalRow | undefined | null,
): MergedPal {
  const s = save ?? null;
  const speciesId = restPal?.palId ?? s?.characterId ?? "?";
  return {
    key: restPal?.instanceId ?? s?.instanceId ?? speciesId,
    speciesId: speciesId.replace(/^BOSS_/i, ""),
    nickname: restPal?.nickname || s?.nickname || undefined,
    level: restPal?.level ?? s?.level ?? null,
    shiny: restPal?.shiny || s?.isLucky || false,
    isBoss: s?.isBoss || /^BOSS_/i.test(speciesId),
    gender: s?.gender ?? (restPal?.gender === "Female" ? "female" : restPal?.gender === "Male" ? "male" : null),
    rank: s?.rank ?? 0,
    save: s,
  };
}

/** 進度概要:等級/經驗、科技點、頭目、捕捉(PalDefender /progression)。 */
function Progression({ prog }: { prog: NonNullable<PlayerDetail["progression"]> }) {
  const rows: [string, string][] = [
    [t("經驗值"), prog.exp.toLocaleString()],
    [t("未分配狀態點"), String(prog.unusedStatusPoints)],
    [t("科技點數"), String(prog.technologyPoints)],
    [t("古代科技點數"), String(prog.ancientTechnologyPoints)],
    [t("擊敗頭目"), String(prog.bossesDefeated)],
    [t("捕捉帕魯種類"), String(prog.palsCaptured)],
  ];
  return (
    <div>
      <h3 className="mb-2 inline-flex items-center gap-1.5 text-sm font-extrabold text-ink-muted">
        <FiTrendingUp className="size-4 text-pal" /> {t("進度")}
      </h3>
      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
        {rows.map(([k, v]) => (
          <Info key={k} label={k} value={v} />
        ))}
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="font-bold break-all">{value}</p>
    </div>
  );
}

const SHOWN_PALS = 60;

function PalGroup({
  title,
  pals,
  total,
  gameData,
}: {
  title: string;
  pals: MergedPal[];
  /** 存檔明細有上限,真實總數可能更大 */
  total?: number;
  gameData: GameData | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? pals : pals.slice(0, SHOWN_PALS);
  return (
    <div>
      <h3 className="mb-2 inline-flex items-center gap-1.5 text-sm font-extrabold text-ink-muted">
        <FiZap className="size-4 text-pal" /> {title}({total ?? pals.length})
      </h3>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
        {shown.map((p) => {
          const entity = gameData?.palById.get(p.speciesId) ?? gameData?.palById.get(`BOSS_${p.speciesId}`);
          return (
            <div key={p.key} className="rounded-xl border-2 border-line p-2">
              <div className="flex items-center gap-2">
                {entity?.icon ? (
                  <img src={palIconUrl(entity.icon)} alt="" className="size-9 shrink-0" />
                ) : (
                  <span className="size-9 shrink-0 rounded bg-card-soft" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-bold">
                    {p.nickname || (entity ? displayName(entity) : p.speciesId)}
                    {p.shiny && <span className="ml-1 text-amber-500">✦</span>}
                    {p.isBoss && (
                      <span className="ml-1 rounded bg-berry/15 px-1 text-[10px] font-extrabold text-berry">
                        {t("頭目")}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {p.level !== null ? `Lv.${p.level}` : "—"}
                    {p.gender === "female" ? " ♀" : p.gender === "male" ? " ♂" : ""}
                    {p.rank > 1 && ` ★${p.rank - 1}`}
                  </p>
                </div>
              </div>
              {p.save && (p.save.talentHp !== null || p.save.passives.length > 0) && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  {p.save.talentHp !== null && (
                    <span
                      className="rounded bg-card-soft px-1 py-0.5 text-[10px] font-bold text-ink-muted"
                      title={t("個體值:血量 / 攻擊 / 防禦(0-100)")}
                    >
                      IV {p.save.talentHp}/{p.save.talentShot ?? "?"}/{p.save.talentDefense ?? "?"}
                    </span>
                  )}
                  {p.save.passives.map((id) => {
                    const meta = gameData?.passiveById.get(id);
                    const bad = (meta?.rank ?? 0) < 0;
                    return (
                      <span
                        key={id}
                        className={`rounded px-1 py-0.5 text-[10px] font-bold ${
                          bad ? "bg-berry/10 text-berry" : "bg-grass/10 text-grass"
                        }`}
                      >
                        {meta ? displayName(meta) : id}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {pals.length > SHOWN_PALS && !showAll && (
        <button className={`${btnGhost} mt-2`} onClick={() => setShowAll(true)}>
          {t("顯示全部 {n} 隻", { n: pals.length })}
        </button>
      )}
    </div>
  );
}

function ItemList({
  items,
  gameData,
  unavailable,
}: {
  items: PlayerDetail["items"];
  gameData: GameData | null;
  unavailable?: boolean;
}) {
  if (items.length === 0) {
    return (
      <p className="text-[13px] text-ink-muted">
        {unavailable ? t("離線玩家的背包資料無法讀取(同上)。") : t("沒有讀取到背包資料。")}
      </p>
    );
  }
  // Merge same item across containers for a cleaner overview.
  const merged = new Map<string, number>();
  for (const s of items) merged.set(s.itemId, (merged.get(s.itemId) ?? 0) + s.count);
  const rows = [...merged.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <div>
      <h3 className="mb-2 inline-flex items-center gap-1.5 text-sm font-extrabold text-ink-muted">
        <FiPackage className="size-4 text-pal" /> {t("背包({n} 種)", { n: rows.length })}
      </h3>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
        {rows.map(([itemId, count]) => {
          const entity = gameData?.itemById.get(itemId);
          return (
            <div key={itemId} className="flex items-center gap-2 rounded-xl border-2 border-line p-2">
              {entity?.icon ? (
                <img src={itemIconUrl(entity.icon)} alt="" className="size-8 shrink-0" />
              ) : (
                <span className="size-8 shrink-0 rounded bg-card-soft" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-bold">{entity ? displayName(entity) : itemId}</p>
              </div>
              <span className="shrink-0 text-sm font-extrabold text-pal">×{count}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
