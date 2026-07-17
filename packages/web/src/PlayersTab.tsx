import { useCallback, useEffect, useState } from "react";
import {
  FiUsers,
  FiSlash,
  FiLogOut,
  FiLogIn,
  FiUserCheck,
  FiUserX,
} from "react-icons/fi";
import { SteamId, maskSteamId } from "./SteamId";
import { useGameData, palIconUrl, type GameData } from "./gameData";
import { PlayerDetailModal } from "./PlayerDetailModal";
import { PlayerActionsMenu } from "./PlayerActionsMenu";

/** A stable avatar per player: hash the id to pick a Pal, so the same player
 * always shows the same face. Palworld has no player portraits, so a Pal
 * mugshot is the friendly stand-in. */
function PlayerAvatar({ seed, gameData, size = 40 }: { seed: string; gameData: GameData | null; size?: number }) {
  const withIcons = gameData?.pals.filter((p) => p.icon) ?? [];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const pal = withIcons.length ? withIcons[hash % withIcons.length] : null;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-line bg-card-soft"
      style={{ width: size, height: size }}
    >
      {pal?.icon ? (
        <img src={palIconUrl(pal.icon)} alt="" className="size-full object-cover" />
      ) : null}
    </span>
  );
}
import {
  savToMap,
  type KnownPlayer,
  type LiveStatus,
  type ModerationLists,
  type PresenceEvent,
  type RestPlayer,
} from "@palserver/shared";
import type { AgentClient } from "./api";
import { t, useI18n } from "./i18n";
import { EmptyState, btnGhost, card, errorCls } from "./ui";

const fmtUptime = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? t("{h} 小時 {m} 分", { h, m }) : t("{m} 分", { m });
};

const EMPTY_MODERATION: ModerationLists = {
  supported: false,
  whitelistEnabled: false,
  whitelist: [],
  bans: [],
};

export function PlayersTab({
  client,
  instanceId,
  onGoToPalDefender,
  onShowOnMap,
}: {
  client: AgentClient;
  instanceId: string;
  /** Jump to the PalDefender tab (for setting up the REST API from a modal). */
  onGoToPalDefender?: () => void;
  /** 切到地圖分頁並聚焦(地圖座標)— 玩家詳情的據點按鈕用。 */
  onShowOnMap?: (x: number, y: number) => void;
}) {
  useI18n(); // 語言切換時重繪(含 fmtUptime 等模組層字串)
  const gameData = useGameData();
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [known, setKnown] = useState<KnownPlayer[]>([]);
  const [events, setEvents] = useState<PresenceEvent[]>([]);
  const [moderation, setModeration] = useState<ModerationLists>(EMPTY_MODERATION);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailFor, setDetailFor] = useState<{ id: string; label: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [liveStatus, knownPlayers, presenceEvents, mod] = await Promise.all([
        client.live(instanceId),
        client.knownPlayers(instanceId).catch(() => []),
        client.presenceEvents(instanceId, 50).catch(() => []),
        client.moderation(instanceId).catch(() => EMPTY_MODERATION),
      ]);
      setLive(liveStatus);
      setKnown(knownPlayers);
      setEvents(presenceEvents);
      setModeration(mod);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, instanceId]);

  const bannedIds = new Set(moderation.bans.map((b) => b.userId).filter((x): x is string => !!x));
  const whitelistedIds = new Set(moderation.whitelist.filter((w) => !w.isIp).map((w) => w.value));

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(null), 3000);
  };

  const act = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      flash(success);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const playerAction = async (player: RestPlayer, action: "kick" | "ban") => {
    const verb = action === "kick" ? t("踢出") : t("封鎖");
    const explain =
      action === "kick"
        ? t("踢出只是把他請出伺服器,他可以立刻重新加入(適合請人重連/暫時處置)。")
        : t("封鎖會把他加入封鎖名單,在你到下方「封鎖名單」按「解除」之前都無法加入。");
    if (!confirm(explain + "\n\n" + t("確定要{verb}「{name}」嗎?", { verb, name: player.name }))) return;
    await act(
      () => client.playerAction(instanceId, player.userId, action, t("你已被{verb}", { verb })),
      t("已{verb} {name}", { verb, name: player.name }),
    );
  };

  const moderate = (
    action: "whitelist_add" | "whitelist_remove" | "ban" | "unban",
    value: string,
    name: string,
    verb: string,
  ) => {
    if (
      action === "ban" &&
      !confirm(
        t("封鎖會把他加入封鎖名單,在你到下方「封鎖名單」按「解除」之前都無法加入。") +
          "\n\n" +
          t("確定要封鎖「{name}」嗎?", { name }),
      )
    )
      return;
    void act(() => client.moderate(instanceId, action, value), t("已{verb} {name}", { verb: t(verb), name }));
  };

  if (!live) return <p className="text-ink-muted">{error ?? t("載入中…")}</p>;

  // The server may be down, but the roster and history are recorded by the
  // agent and stay useful — that's when you look someone up to unban them.
  if (!live.available) {
    return (
      <div className="flex flex-col gap-4">
        <EmptyState icon={<FiUsers />} title={t("目前無法連線到伺服器的 REST API")}>{live.reason}</EmptyState>
        <KnownPlayersCard
          known={known}
          gameData={gameData}
          client={client}
          instanceId={instanceId}
          onOpen={(id, label) => setDetailFor({ id, label })}
          bannedIds={moderation.supported ? bannedIds : undefined}
          onBan={(id, name) => moderate("ban", id, name, "封鎖")}
          onUnban={(id, name) => moderate("unban", id, name, "解除封鎖")}
        />
        <PresenceTimeline events={events} />
        {detailFor && (
          <PlayerDetailModal
            client={client}
            instanceId={instanceId}
            identifier={detailFor.id}
            displayLabel={detailFor.label}
            onClose={() => setDetailFor(null)}
            onGoToPalDefender={onGoToPalDefender}
            onShowOnMap={onShowOnMap}
          />
        )}
      </div>
    );
  }

  const { metrics, players } = live;

  return (
    <div className="flex flex-col gap-4">
      {error && <p className={errorCls}>{error}</p>}
      {notice && (
        <p className="rounded-xl bg-grass/10 px-3 py-2 text-[13px] font-bold text-grass">{notice}</p>
      )}

      {metrics && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label={t("在線玩家")} value={`${metrics.currentplayernum} / ${metrics.maxplayernum}`} />
          <Stat label={t("伺服器 FPS")} value={String(metrics.serverfps)} />
          <Stat label={t("運行時間")} value={fmtUptime(metrics.uptime)} />
          <Stat label={t("遊戲天數")} value={t("第 {n} 天", { n: metrics.days })} />
        </div>
      )}

      <div className={`${card} p-0`}>
        <h3 className="border-b-2 border-line px-5 py-3 text-sm font-extrabold text-ink-muted">
          {t("在線玩家")}({players.length})
        </h3>
        {players.length === 0 ? (
          <p className="px-5 py-8 text-center text-[13px] text-ink-muted">{t("目前沒有玩家在線上。")}</p>
        ) : (
          <div className="flex flex-col divide-y divide-line">
            {players.map((p) => {
              const loc = savToMap(p.location_x, p.location_y);
              return (
              <div key={p.userId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                <button
                  className="flex items-center gap-4 text-left transition hover:opacity-80"
                  onClick={() => setDetailFor({ id: p.userId, label: p.name })}
                  title={t("查看帕魯與背包")}
                >
                  <PlayerAvatar seed={p.userId} gameData={gameData} />
                </button>
                <div className="min-w-40 flex-1">
                  <button
                    className="text-sm font-extrabold transition hover:text-pal"
                    onClick={() => setDetailFor({ id: p.userId, label: p.name })}
                  >
                    {p.name}
                  </button>
                  <p className="text-xs text-ink-muted">
                    Lv.{p.level} · Ping {Math.round(p.ping)} ms · {t("建築")} {p.building_count} · {t("座標")}{" "}
                    {Math.round(loc.x)}, {Math.round(loc.y)}
                  </p>
                  <p className="mt-0.5">
                    <SteamId userId={p.userId} />
                  </p>
                </div>
                <p className="hidden text-xs text-ink-muted sm:block">{p.ip}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <PlayerActionsMenu
                    client={client}
                    instanceId={instanceId}
                    userId={p.userId}
                    displayLabel={p.name}
                  />
                  <button
                    className={`${btnGhost} inline-flex items-center gap-1.5`}
                    onClick={() => playerAction(p, "kick")}
                    disabled={busy}
                  >
                    <FiLogOut className="size-3.5" /> {t("踢出")}
                  </button>
                  <button
                    className={`${btnGhost} inline-flex items-center gap-1.5 text-berry hover:border-berry`}
                    onClick={() => playerAction(p, "ban")}
                    disabled={busy}
                  >
                    <FiSlash className="size-3.5" /> {t("封鎖")}
                  </button>
                  {moderation.supported &&
                    (whitelistedIds.has(p.userId) ? (
                      <button
                        className={`${btnGhost} inline-flex items-center gap-1.5`}
                        onClick={() => moderate("whitelist_remove", p.userId, p.name, "移出白名單")}
                        disabled={busy}
                      >
                        <FiUserX className="size-3.5" /> {t("移出白名單")}
                      </button>
                    ) : (
                      <button
                        className={`${btnGhost} inline-flex items-center gap-1.5 text-grass hover:border-grass`}
                        onClick={() => moderate("whitelist_add", p.userId, p.name, "加入白名單")}
                        disabled={busy}
                      >
                        <FiUserCheck className="size-3.5" /> {t("白名單")}
                      </button>
                    ))}
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>

      <KnownPlayersCard
        known={known}
        gameData={gameData}
        client={client}
        instanceId={instanceId}
        onOpen={(id, label) => setDetailFor({ id, label })}
        bannedIds={moderation.supported ? bannedIds : undefined}
        onBan={(id, name) => moderate("ban", id, name, "封鎖")}
        onUnban={(id, name) => moderate("unban", id, name, "解除封鎖")}
      />
      <ModerationCard
        moderation={moderation}
        busy={busy}
        onUnban={(userId) => moderate("unban", userId, userId, "解除封鎖")}
        onWhitelistRemove={(value) => moderate("whitelist_remove", value, value, "移出白名單")}
      />
      <PresenceTimeline events={events} />

      {detailFor && (
        <PlayerDetailModal
          client={client}
          instanceId={instanceId}
          identifier={detailFor.id}
          displayLabel={detailFor.label}
          onClose={() => setDetailFor(null)}
          onGoToPalDefender={onGoToPalDefender}
          onShowOnMap={onShowOnMap}
        />
      )}
    </div>
  );
}

const fmtPlaytime = (seconds: number) => {
  if (seconds < 60) return t("不到 1 分");
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? t("{h} 小時 {m} 分", { h, m }) : t("{m} 分", { m });
};

const fmtWhen = (iso: string) => new Date(iso).toLocaleString();

/** 離線玩家名冊:在線玩家已經有獨立的「在線玩家」卡片,這裡只列離線的,不重複。
 * 名單來源:agent 有開 PalDefender REST 時走它的名冊(含存檔內所有離線玩家),否則用
 * agent 自己記錄的。有 agent 歷史(首見時間)的才顯示等級 / 遊玩時長等統計。 */
function KnownPlayersCard({
  known,
  gameData,
  client,
  instanceId,
  onOpen,
  bannedIds,
  onBan,
  onUnban,
}: {
  known: KnownPlayer[];
  gameData: GameData | null;
  client: AgentClient;
  instanceId: string;
  onOpen: (id: string, label: string) => void;
  /** 封鎖名單中的 userId(PalDefender 未裝時為 undefined → 不顯示封鎖鈕)。 */
  bannedIds?: Set<string>;
  onBan?: (userId: string, name: string) => void;
  onUnban?: (userId: string, name: string) => void;
}) {
  const offline = known.filter((p) => !p.online);
  return (
    <div className={`${card} p-0`}>
      <h3 className="border-b-2 border-line px-5 py-3 text-sm font-extrabold text-ink-muted">
        {t("離線玩家")}({offline.length})
      </h3>
      {offline.length === 0 ? (
        <p className="px-5 py-8 text-center text-[13px] text-ink-muted">
          {t("目前沒有離線玩家。agent 每 15 秒會記錄一次在線狀態。")}
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-line">
          {offline.map((p) => {
            const hasHistory = !!p.firstSeen; // agent 記錄過(PalDefender-only 玩家沒有)
            return (
              <div key={p.userId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                <button onClick={() => onOpen(p.userId, p.name)} title={t("查看帕魯與背包")} className="transition hover:opacity-80">
                  <PlayerAvatar seed={p.userId} gameData={gameData} size={36} />
                </button>
                <div className="min-w-40 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-extrabold">
                    <button className="transition hover:text-pal" onClick={() => onOpen(p.userId, p.name)}>
                      {p.name || "—"}
                    </button>
                    {p.guildName && <span className="text-xs font-normal text-ink-muted">· {p.guildName}</span>}
                  </p>
                  {hasHistory && (
                    <p className="text-xs text-ink-muted">
                      Lv.{p.lastLevel} · {t("遊玩")} {fmtPlaytime(p.playtimeSeconds)} · {t("{n} 次連線", { n: p.sessions })}
                    </p>
                  )}
                  <p className="mt-0.5">
                    <SteamId userId={p.userId} />
                  </p>
                </div>
                {hasHistory && (
                  <div className="text-right text-xs text-ink-muted">
                    <p>{t("最後上線")} {fmtWhen(p.lastSeen)}</p>
                    <p>{t("首次出現")} {fmtWhen(p.firstSeen)}</p>
                  </div>
                )}
                {bannedIds && (
                  bannedIds.has(p.userId) ? (
                    <button
                      className="shrink-0 rounded-full border-[1.5px] border-line px-3 py-1 text-xs font-bold text-grass transition hover:border-grass"
                      onClick={() => onUnban?.(p.userId, p.name || p.userId)}
                    >
                      {t("解除封鎖")}
                    </button>
                  ) : (
                    <button
                      className="shrink-0 rounded-full border-[1.5px] border-line px-3 py-1 text-xs font-bold text-berry transition hover:border-berry"
                      onClick={() => onBan?.(p.userId, p.name || p.userId)}
                      title={t("離線也能封鎖:加入封鎖名單後,他再嘗試加入會被擋下")}
                    >
                      {t("封鎖")}
                    </button>
                  )
                )}
                <PlayerActionsMenu
                  client={client}
                  instanceId={instanceId}
                  userId={p.userId}
                  displayLabel={p.name || maskSteamId(p.userId)}
                />
              </div>
            );
          })}
        </div>
      )}
      {offline.length > 0 && (
        <p className="border-t-2 border-line px-5 py-2.5 text-xs text-ink-muted">
          {t("解除封鎖就在下方「封鎖名單」卡按「解除」;進階指令可到「指令台」對離線玩家操作。")}
        </p>
      )}
    </div>
  );
}

/** PalDefender whitelist and banlist, when the plugin is installed. */
function ModerationCard({
  moderation,
  busy,
  onUnban,
  onWhitelistRemove,
}: {
  moderation: ModerationLists;
  busy: boolean;
  onUnban: (userId: string) => void;
  onWhitelistRemove: (value: string) => void;
}) {
  if (!moderation.supported) return null;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className={`${card} p-0`}>
        <h3 className="flex items-center justify-between border-b-2 border-line px-5 py-3 text-sm font-extrabold text-ink-muted">
          <span>{t("白名單")}({moderation.whitelist.length})</span>
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${moderation.whitelistEnabled ? "bg-grass/15 text-grass" : "bg-card-soft text-ink-muted"}`}
          >
            {moderation.whitelistEnabled ? t("已啟用") : t("未啟用")}
          </span>
        </h3>
        {!moderation.whitelistEnabled && (
          <p className="mx-4 mt-3 rounded-xl bg-sun/10 px-3 py-2 text-xs font-bold text-sun">
            {t("白名單目前未啟用 — 名單不會生效,任何人都能加入。要啟用到「PalDefender」分頁開啟「啟用白名單」。")}
          </p>
        )}
        {moderation.whitelist.length === 0 ? (
          <p className="px-5 py-6 text-center text-[13px] text-ink-muted">{t("白名單是空的。")}</p>
        ) : (
          <div className="flex flex-col divide-y divide-line">
            {moderation.whitelist.map((w) => (
              <div key={w.value} className="flex flex-wrap items-center justify-between gap-3 px-5 py-2.5">
                {w.isIp ? (
                  <span className="min-w-0 font-mono text-xs break-all">IP {w.value}</span>
                ) : (
                  <SteamId userId={w.value} />
                )}
                {!w.isIp && (
                  <button
                    className="shrink-0 rounded-full border-[1.5px] border-line px-3 py-1 text-xs font-bold text-berry transition hover:border-berry"
                    onClick={() => onWhitelistRemove(w.value)}
                    disabled={busy}
                  >
                    {t("移除")}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={`${card} p-0`}>
        <h3 className="border-b-2 border-line px-5 py-3 text-sm font-extrabold text-ink-muted">
          {t("封鎖名單")}({moderation.bans.length})
        </h3>
        {moderation.bans.length === 0 ? (
          <p className="px-5 py-6 text-center text-[13px] text-ink-muted">{t("沒有被封鎖的玩家。")}</p>
        ) : (
          <div className="flex flex-col divide-y divide-line">
            {moderation.bans.map((b, i) => (
              <div key={`${b.userId ?? b.ip}-${i}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-2.5">
                <div className="min-w-0">
                  {b.userId ? (
                    <SteamId userId={b.userId} />
                  ) : (
                    <p className="font-mono text-xs break-all">IP {b.ip}</p>
                  )}
                  {b.reason && <p className="text-xs text-ink-muted">{t("原因:")}{b.reason}</p>}
                </div>
                {b.userId && (
                  <button
                    className="shrink-0 rounded-full border-[1.5px] border-line px-3 py-1 text-xs font-bold text-grass transition hover:border-grass"
                    onClick={() => onUnban(b.userId!)}
                    disabled={busy}
                  >
                    {t("解除")}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PresenceTimeline({ events }: { events: PresenceEvent[] }) {
  return (
    <div className={`${card} p-0`}>
      <h3 className="border-b-2 border-line px-5 py-3 text-sm font-extrabold text-ink-muted">
        {t("上下線紀錄")}
      </h3>
      {events.length === 0 ? (
        <EmptyState compact className="m-4">{t("尚無紀錄。")}</EmptyState>
      ) : (
        <div className="max-h-72 overflow-y-auto">
          <div className="flex flex-col divide-y divide-line">
            {events.map((e, i) => (
              <div key={`${e.at}-${e.userId}-${i}`} className="flex items-center gap-3 px-5 py-2">
                {e.type === "join" ? (
                  <FiLogIn className="size-4 shrink-0 text-grass" />
                ) : (
                  <FiLogOut className="size-4 shrink-0 text-ink-muted" />
                )}
                <span className="flex-1 text-sm font-bold">{e.name}</span>
                <span className="text-xs text-ink-muted">
                  {e.type === "join" ? t("上線") : t("離線")} · {fmtWhen(e.at)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={card}>
      <p className="text-xs font-bold text-ink-muted">{label}</p>
      <p className="mt-1 text-lg font-extrabold">{value}</p>
    </div>
  );
}
