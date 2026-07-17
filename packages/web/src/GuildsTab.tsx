import { useCallback, useEffect, useState } from "react";
import { FiChevronRight, FiHome, FiRefreshCw } from "react-icons/fi";
import type { SaveGuild } from "@palserver/shared";
import type { AgentClient } from "./api";
import { GuildDetailModal, researchName } from "./GuildDetailModal";
import { useGameData } from "./gameData";
import { t, useI18n } from "./i18n";
import { EmptyState, btnGhost, card, errorCls } from "./ui";

/**
 * 公會分頁 — 存檔快照(save-tools 掃描)驅動的公會總覽。
 * 清單卡片只放基礎資訊,點擊開 GuildDetailModal 看完整資料
 * (成員/據點駐守帕魯/公會倉庫/研究)— 與玩家詳情同一套 UX。
 * 不依賴 PalDefender;贊助者功能(save-slim)。
 */
export function GuildsTab({
  client,
  instanceId,
  onShowOnMap,
}: {
  client: AgentClient;
  instanceId: string;
  /** 切到地圖分頁並聚焦(地圖座標) */
  onShowOnMap?: (x: number, y: number) => void;
}) {
  useI18n();
  const gameData = useGameData();
  const [worldGuid, setWorldGuid] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [guilds, setGuilds] = useState<SaveGuild[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [canScan, setCanScan] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<SaveGuild | null>(null);

  const load = useCallback(async () => {
    try {
      const snap = await client.guildsSnapshot(instanceId);
      setWorldGuid(snap.worldGuid);
      setGeneratedAt(snap.generatedAt);
      setGuilds(snap.guilds);
      setNote(null);
      try {
        const health = await client.saveHealth(instanceId, snap.worldGuid);
        setCanScan(health.supported);
        if (!health.supported) setNote(health.reason ?? t("此主機不支援存檔掃描"));
      } catch {
        setCanScan(false);
      }
    } catch (err) {
      setCanScan(false);
      setNote(t("無法取得存檔快照:{reason}", { reason: err instanceof Error ? err.message : String(err) }));
    }
  }, [client, instanceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const scan = async () => {
    if (!worldGuid) return;
    setError(null);
    setScanning(true);
    try {
      await client.startSaveHealth(instanceId, worldGuid);
      await new Promise<void>((resolve) => {
        const timer = setInterval(async () => {
          try {
            const s = await client.saveHealth(instanceId, worldGuid);
            if (s.phase === "idle") {
              clearInterval(timer);
              if (s.error) setError(s.error);
              resolve();
            }
          } catch {
            /* 暫時性網路錯誤:下一輪再試 */
          }
        }, 2000);
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  };

  const sorted = [...(guilds ?? [])].sort((a, b) => b.members.length - a.members.length);

  return (
    <div className="flex flex-col gap-4">
      {/* 無法取得快照(note)且不能掃描時整列收起,虛線提示框與其他分頁一樣貼齊頂部 */}
      {(generatedAt || !note || canScan) && (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-muted">
          {generatedAt
            ? t("資料來自存檔掃描(掃描於 {when})。", { when: new Date(generatedAt).toLocaleString() })
            : note
              ? "" // 無法取得快照時只顯示下方的提示框,不重複「尚未掃描」
              : t("尚未掃描過存檔。點「從存檔刷新」建立快照。")}
        </p>
        {canScan && (
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={() => void scan()}
            disabled={scanning}
          >
            <FiRefreshCw className={`size-3.5 ${scanning ? "animate-spin" : ""}`} />
            {scanning ? t("掃描存檔中…(依存檔大小可能需要幾分鐘)") : t("從存檔刷新")}
          </button>
        )}
      </div>
      )}

      {error && <p className={errorCls}>{error}</p>}
      {note && !scanning && <EmptyState icon={<FiHome />}>{note}</EmptyState>}

      {!note && !scanning && sorted.length === 0 && (
        <EmptyState icon={<FiHome />}>
          {generatedAt ? t("這個世界還沒有公會。") : t("尚未掃描過存檔。點「從存檔刷新」建立快照。")}
        </EmptyState>
      )}

      {sorted.map((g) => (
        <button
          key={g.id}
          className={`${card} flex w-full flex-wrap items-center justify-between gap-3 text-left transition hover:border-pal/50`}
          onClick={() => setDetailFor(g)}
        >
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-extrabold">
              <FiHome className="size-4 shrink-0 text-pal" />
              <span className="truncate">{g.name}</span>
              {g.baseCampLevel !== null && (
                <span className="rounded-full bg-card-soft px-2 py-0.5 text-xs font-bold text-ink-muted">
                  {t("據點等級 Lv.{n}", { n: g.baseCampLevel })}
                </span>
              )}
            </p>
            <p className="mt-1 text-[13px] text-ink-muted">
              {t("{n} 名成員", { n: g.members.length })} · {t("{n} 個據點", { n: g.bases.length })}
              {g.storage !== null && <> · {t("倉庫 {n} 種物品", { n: g.storage.length })}</>}
              {g.research?.currentId && (
                <> · {t("研究中:{id}", { id: researchName(gameData, g.research.currentId) })}</>
              )}
            </p>
          </div>
          <FiChevronRight className="size-4 shrink-0 text-ink-muted" />
        </button>
      ))}

      {detailFor && (
        <GuildDetailModal
          client={client}
          instanceId={instanceId}
          guild={detailFor}
          generatedAt={generatedAt}
          onRescanned={() => void load()}
          onShowOnMap={
            onShowOnMap
              ? (x, y) => {
                  setDetailFor(null);
                  onShowOnMap(x, y);
                }
              : undefined
          }
          onClose={() => setDetailFor(null)}
        />
      )}
    </div>
  );
}
