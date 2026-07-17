import { useCallback, useEffect, useRef, useState } from "react";
import { FiAlertTriangle, FiAlignLeft, FiArrowLeft, FiCheck, FiFileText, FiPlay, FiPlus, FiRefreshCw, FiSave, FiSend, FiSquare, FiStar, FiTerminal, FiX } from "react-icons/fi";
import type {
  InstanceDetail as Detail,
  LogSource,
  LogSourceId,
  WorldSettings,
} from "@palserver/shared";
import type { AgentClient } from "./api";
import { SettingsEditor } from "./SettingsEditor";
import { ModsTab } from "./ModsTab";
import { PalDefenderTab } from "./PalDefenderTab";
import { PalStatsTab } from "./PalStatsTab";
import { PlayersTab } from "./PlayersTab";
import { GuildsTab } from "./GuildsTab";
import { LeaderboardTab } from "./LeaderboardTab";
import { MapTab } from "./MapTab";
import { ConsoleTab } from "./ConsoleTab";
import { SavesTab } from "./SavesTab";
import { RestartCard } from "./RestartCard";
import { VersionCard } from "./VersionCard";
import { ConnectionCard } from "./ConnectionCard";
import { InstanceSettingsTab } from "./InstanceSettingsTab";
import { SHOW_SPONSOR_FEATURES } from "./flags";
import { PerformanceTab } from "./PerformanceTab";
import { EngineTab } from "./EngineTab";
import { maskSteamIdsInText } from "./SteamId";
import { hasFeature } from "@palserver/shared";
import { classifyLine, categoryColor, formatLine, genericLine, translateTarget, useLogPrefs } from "./logHighlight";
import { STATUS_LABELS } from "./labels";
import { TABS, LOCKED_TABS, useHiddenTabs, useHiddenCards, useTabOrder, type Tab } from "./tabPrefs";
import { t, t as translate, useI18n } from "./i18n";
import { InstallProgress, Overlay, StatusBadge, btn, btnGhost, card, errorCls, inputCls } from "./ui";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { PortConflictModal } from "./PortConflictModal";
import type { PortsCheckResult } from "./api";


export function InstanceDetailPage({
  client,
  instanceId,
  onBack,
  onDeleted,
}: {
  client: AgentClient;
  instanceId: string;
  onBack: () => void;
  onDeleted: () => void;
}) {
  useI18n();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  // 玩家詳情「據點跳地圖」:切到地圖分頁並聚焦座標(n 為 nonce,連點同一點也重觸發)
  const [mapFocus, setMapFocus] = useState<{ x: number; y: number; n: number } | null>(null);
  // 分頁偏好每實例獨立;預設集合只看「建立時選的口味」——事後手動安裝模組
  // 不改變預設可見分頁(避免裝完 PalDefender 分頁自己跳出來),要開去「＋」面板。
  const enhancedMode = detail ? detail.flavor === "modded" : false;
  const [hiddenTabs, setHiddenTabs] = useHiddenTabs(instanceId, enhancedMode);
  const [tabOrder, setTabOrder] = useTabOrder(instanceId);
  // 「＋」快速開啟面板:列出被隱藏(且通過 gating)的分頁,點了立刻顯示並切換過去
  const [morePanel, setMorePanel] = useState(false);
  // 拖曳需移動 6px 才觸發,一般點擊不受影響
  const tabSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  // 面板寬 224px(w-56):＋按鈕靠螢幕右緣時改右對齊,避免小螢幕橫向溢出
  const [moreAlignRight, setMoreAlignRight] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!morePanel) return;
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMorePanel(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMorePanel(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [morePanel]);
  // 若目前分頁被使用者在設定裡藏起來,退回總覽,避免停在看不見的分頁。
  useEffect(() => {
    if (!LOCKED_TABS.includes(tab) && hiddenTabs.includes(tab)) setTab("overview");
  }, [hiddenTabs, tab]);
  const [showConsole, setShowConsole] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingWorld, setSavingWorld] = useState(false);
  const [palDefender, setPalDefender] = useState(false);
  // 非 null 時代表正在倒數(數字為剩餘秒數),用來鎖按鈕與顯示提示。
  const [countdown, setCountdown] = useState<number | null>(null);
  // 啟動前偵測到埠被占用 → 開修改面板(新手最常見的開不起來原因)
  const [portConflict, setPortConflict] = useState<PortsCheckResult | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDetail(await client.getInstance(instanceId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, instanceId]);

  // Gate PalDefender-only tabs on whether the plugin is installed.
  // ModsTab 安裝/移除後呼叫 onModsChanged 重查,分頁即時出現/消失(不用刷新頁面)。
  const checkPalDefender = useCallback(() => {
    client
      .mods(instanceId)
      .then((m) => setPalDefender(m.supported && m.paldefender.installed))
      .catch(() => setPalDefender(false));
  }, [client, instanceId]);
  useEffect(() => checkPalDefender(), [checkPalDefender]);
  // 移除 PalDefender 時人正停在該分頁 → 退回總覽(帕魯數值不依賴 PalDefender,不在此列)
  useEffect(() => {
    if (tab === "paldefender" && !palDefender) setTab("overview");
  }, [tab, palDefender]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = async (action: "start" | "stop" | "restart", skipPortCheck = false) => {
    // 啟動前先檢查五種埠(遊戲/查詢/REST/RCON/PalDefender)有沒有被其他程式占走;
    // 有衝突就開修改面板,而不是讓伺服器啟動失敗留下天書錯誤。
    if (action === "start" && !skipPortCheck && detail?.backend === "native" && detail.status !== "running") {
      const chk = await client.portsCheck(instanceId).catch(() => null);
      if (chk?.supported && chk.anyConflict) {
        setPortConflict(chk);
        return;
      }
    }
    // 手動停止/重啟時,agent 端會依「伺服器重啟設定」裡的倒數秒數,在遊戲聊天室倒數公告
    // 再執行;公告訊息用 GUI 介面語言的模板({n} 由 agent 代入剩餘秒數)。前端只負責把
    // 模板傳過去,並用讀到的秒數跑一個純顯示用的本地倒數。
    const isDowntime = (action === "stop" || action === "restart") && detail?.status === "running";
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const template = !isDowntime
        ? undefined
        : action === "stop"
          ? t("伺服器將在 {n} 秒後停止")
          : t("伺服器將在 {n} 秒後重新啟動");
      if (isDowntime) {
        const seconds = await client
          .restartPolicy(instanceId)
          .then((p) => p.policy.announceSeconds)
          .catch(() => 0);
        if (seconds > 0) {
          const startedAt = Date.now();
          setCountdown(seconds);
          timer = setInterval(() => {
            const left = seconds - Math.floor((Date.now() - startedAt) / 1000);
            setCountdown(left > 0 ? left : 0);
          }, 500);
        }
      }
      await client.action(instanceId, action, template);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (timer) clearInterval(timer);
      setCountdown(null);
    }
  };

  const saveWorld = async () => {
    setSavingWorld(true);
    setError(null);
    try {
      await client.saveWorld(instanceId);
      setNotice(t("世界已存檔"));
      setTimeout(() => setNotice(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingWorld(false);
    }
  };

  const saveSettings = async (patch: Partial<WorldSettings>) => {
    setSaving(true);
    try {
      await client.updateSettings(instanceId, patch);
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  if (!detail) {
    return (
      <div>
        <button className={btnGhost} onClick={onBack}>
          <FiArrowLeft className="inline size-4" /> {t("返回")}
        </button>
        {error ? <p className={`mt-4 ${errorCls}`}>{error}</p> : <p className="mt-4 text-ink-muted">{t("載入中…")}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button className={btnGhost} onClick={onBack} aria-label={t("返回")}>
            <FiArrowLeft className="inline size-4" />
          </button>
          <h2 className="text-xl font-extrabold">{detail.name}</h2>
          <StatusBadge status={detail.status} />
        </div>
        <div className="flex flex-wrap gap-2">
          {detail.status !== "running" ? (
            <button
              className={`${btn} inline-flex items-center gap-1.5`}
              onClick={() => act("start")}
              disabled={detail.status === "installing" || countdown !== null}
            >
              <FiPlay className="size-4" /> {detail.status === "installing" ? t("安裝中…") : t("啟動")}
            </button>
          ) : (
            <button
              className={`${btn} inline-flex items-center gap-1.5`}
              onClick={() => act("stop")}
              disabled={countdown !== null}
            >
              <FiSquare className="size-4" /> {t("停止")}
            </button>
          )}
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={() => act("restart")}
            disabled={countdown !== null}
          >
            <FiRefreshCw className="size-4" /> {t("重啟")}
          </button>
          {detail.status === "running" && (
            <button
              className={`${btnGhost} inline-flex items-center gap-1.5`}
              onClick={saveWorld}
              disabled={savingWorld || countdown !== null}
            >
              <FiSave className="size-4" /> {savingWorld ? t("儲存中…") : t("立即存檔")}
            </button>
          )}
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={() => setShowLogs(true)}
            title={t("日誌")}
            aria-label={t("日誌")}
          >
            <FiFileText className="size-4" />
          </button>
          <button
            className={`${btnGhost} inline-flex items-center gap-1.5`}
            onClick={() => setShowConsole(true)}
            title={t("指令台")}
            aria-label={t("指令台")}
          >
            <FiTerminal className="size-4" />
          </button>
        </div>
      </div>

      {countdown !== null && (
        <p className="rounded-xl bg-sun/15 px-3 py-2 text-[13px] font-bold text-sun">
          {t("已在遊戲聊天室公告,{n} 秒後執行…", { n: countdown })}
        </p>
      )}

      {detail.status === "installing" && (
        <div className="rounded-xl border-2 border-sun/40 bg-sun/10 px-4 py-3">
          <InstallProgress percent={detail.installProgress} />
        </div>
      )}

      {portConflict && (
        <PortConflictModal
          client={client}
          instanceId={instanceId}
          check={portConflict}
          onResolved={() => {
            setPortConflict(null);
            void act("start", true);
          }}
          onClose={() => setPortConflict(null)}
        />
      )}

      {showConsole && (
        <Overlay onClose={() => setShowConsole(false)}>
          <div
            className={`${card} flex h-[82vh] w-240 max-w-full flex-col gap-3 overflow-hidden`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between">
              <h2 className="inline-flex items-center gap-2 text-lg font-extrabold">
                <FiTerminal className="size-5 text-pal" /> {t("指令台")}
              </h2>
              <button className={btnGhost} onClick={() => setShowConsole(false)} aria-label={t("關閉")}>
                <FiX className="size-4" />
              </button>
            </div>
            <ConsoleTab client={client} instanceId={detail.id} />
          </div>
        </Overlay>
      )}

      {showLogs && (
        <Overlay onClose={() => setShowLogs(false)}>
          <div
            className={`${card} flex max-h-[90vh] w-240 max-w-full flex-col gap-3 overflow-y-auto`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between">
              <h2 className="inline-flex items-center gap-2 text-lg font-extrabold">
                <FiFileText className="size-5 text-pal" /> {t("日誌")}
              </h2>
              <button className={btnGhost} onClick={() => setShowLogs(false)} aria-label={t("關閉")}>
                <FiX className="size-4" />
              </button>
            </div>
            <LogsTab client={client} instanceId={detail.id} />
          </div>
        </Overlay>
      )}

      {notice && (
        <p className="rounded-xl bg-grass/10 px-3 py-2 text-[13px] font-bold text-grass">{notice}</p>
      )}
      {error && <p className={errorCls}>{error}</p>}

      {detail.installError && (
        <p className={`${errorCls} inline-flex flex-wrap items-start gap-2`}>
          <FiAlertTriangle className="mt-0.5 size-4 shrink-0" />
          {/* whitespace-pre-wrap:錯誤訊息可能帶「下載器輸出尾段」多行診斷 */}
          <span className="whitespace-pre-wrap">
            {t("安裝失敗")}:{" "}
            {detail.installError.code === "disk-full"
              ? t("磁碟空間不足,請清出更多空間後再試(Palworld 伺服器約需數十 GB)。")
              : detail.installError.message}{" "}
            <button
              className="underline underline-offset-2 hover:opacity-80"
              onClick={() => setShowLogs(true)}
            >
              {t("查看日誌")}
            </button>
          </span>
        </p>
      )}

      {(() => {
        // 依每實例自訂順序排列,再套 gating(PalDefender 裝了才有、贊助旗標)
        const orderedTabs = tabOrder
          .map((id) => TABS.find((tb) => tb.id === id))
          .filter((tb): tb is (typeof TABS)[number] => !!tb)
          .filter((tb) => tb.id !== "paldefender" || palDefender)
          .filter((tb) => tb.id !== "palstats" || SHOW_SPONSOR_FEATURES);
        const visibleTabs = orderedTabs.filter((tb) => LOCKED_TABS.includes(tb.id) || !hiddenTabs.includes(tb.id));
        const manageable = orderedTabs.filter((tb) => !LOCKED_TABS.includes(tb.id));
        const onDragEnd = (e: DragEndEvent) => {
          const { active, over } = e;
          if (!over || active.id === over.id) return;
          const ids = visibleTabs.map((tb) => tb.id);
          const from = ids.indexOf(active.id as Tab);
          const to = ids.indexOf(over.id as Tab);
          if (from < 0 || to < 0) return;
          // 只重排可見分頁,隱藏分頁保持原本的相對位置
          const moved = arrayMove(ids, from, to);
          let vi = 0;
          setTabOrder(tabOrder.map((id) => (ids.includes(id) ? moved[vi++] : id)));
        };
        return (
          <div className="flex flex-wrap gap-x-2 gap-y-1 border-b-2 border-line">
            <DndContext sensors={tabSensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={visibleTabs.map((tb) => tb.id)} strategy={rectSortingStrategy}>
                {visibleTabs.map((tb) => (
                  <SortableTabButton
                    key={tb.id}
                    id={tb.id}
                    active={tb.id === tab}
                    label={translate(tb.label)}
                    onSelect={() => setTab(tb.id)}
                  />
                ))}
              </SortableContext>
            </DndContext>
            <div ref={moreRef} className="relative">
              <button
                type="button"
                className="inline-flex items-center px-3 py-2 text-sm font-extrabold text-ink-muted transition hover:text-ink"
                onClick={() => {
                  const r = moreRef.current?.getBoundingClientRect();
                  setMoreAlignRight(!!r && r.left + 224 > window.innerWidth - 16);
                  setMorePanel((v) => !v);
                }}
                title={translate("管理分頁")}
                aria-label={translate("管理分頁")}
              >
                <FiPlus className="size-4" />
              </button>
              {morePanel && (
                <div className={`absolute top-full z-30 mt-1 w-56 max-w-[calc(100vw-2rem)] rounded-xl border-2 border-line bg-card p-2 shadow-lg ${moreAlignRight ? "right-0" : "left-0"}`}>
                  <p className="px-2 py-1 text-xs font-extrabold text-ink-muted">{translate("管理分頁")}</p>
                  {manageable.map((tb) => {
                    const shown = !hiddenTabs.includes(tb.id);
                    return (
                      <button
                        key={tb.id}
                        type="button"
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-bold transition hover:bg-card-soft ${shown ? "" : "text-ink-muted"}`}
                        onClick={() => {
                          if (shown) {
                            setHiddenTabs([...hiddenTabs, tb.id]);
                          } else {
                            setHiddenTabs(hiddenTabs.filter((id) => id !== tb.id));
                            setTab(tb.id);
                            setMorePanel(false);
                          }
                        }}
                      >
                        {shown ? (
                          <FiCheck className="size-3.5 shrink-0 text-pal" />
                        ) : (
                          <FiPlus className="size-3.5 shrink-0" />
                        )}
                        {translate(tb.label)}
                      </button>
                    );
                  })}
                  <p className="border-t-2 border-line px-2 pb-0.5 pt-1.5 text-[11px] text-ink-muted">
                    {translate("點一下切換顯示;分頁標籤可直接拖曳排序。")}
                  </p>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {tab === "overview" && <OverviewTab client={client} detail={detail} onRefresh={refresh} />}
      {tab === "performance" && (
        <PerformanceTab client={client} instanceId={detail.id} running={detail.status === "running"} />
      )}
      {tab === "players" && (
        <PlayersTab
          client={client}
          instanceId={detail.id}
          onGoToPalDefender={palDefender ? () => setTab("paldefender") : undefined}
          onShowOnMap={(x, y) => {
            setMapFocus({ x, y, n: Date.now() });
            setTab("map");
          }}
        />
      )}
      {tab === "guilds" && (
        <GuildsTab
          client={client}
          instanceId={detail.id}
          onShowOnMap={(x, y) => {
            setMapFocus({ x, y, n: Date.now() });
            setTab("map");
          }}
        />
      )}
      {tab === "leaderboard" && <LeaderboardTab client={client} instanceId={detail.id} />}
      {tab === "map" && <MapTab client={client} instanceId={detail.id} externalFocus={mapFocus} />}
      {tab === "settings" && (
        <SettingsEditor
          settings={detail.settings}
          saving={saving}
          onSave={saveSettings}
          client={client}
          instanceId={detail.id}
          canEditRaw={true}
          running={detail.status === "running" && detail.backend === "native"}
          onSynced={() => void refresh()}
        />
      )}
      {tab === "engine" && (
        <EngineTab client={client} instanceId={detail.id} running={detail.status === "running"} />
      )}
      {tab === "mods" && (
        <ModsTab
          client={client}
          instanceId={detail.id}
          running={detail.status === "running"}
          onModsChanged={checkPalDefender}
          onOpenPalDefender={() => {
            setPalDefender(true); // 按鈕只在已安裝時出現;搶在重查完成前放行 gating
            setHiddenTabs(hiddenTabs.filter((id) => id !== "paldefender"));
            setTab("paldefender");
          }}
        />
      )}
      {tab === "paldefender" && (
        <PalDefenderTab client={client} instanceId={detail.id} running={detail.status === "running"} />
      )}
      {tab === "palstats" && <PalStatsTab client={client} instanceId={detail.id} />}
      {tab === "saves" && (
        <SavesTab client={client} instanceId={detail.id} running={detail.status === "running"} />
      )}
      {tab === "restart" && <RestartCard client={client} instanceId={detail.id} />}
      {tab === "instance" && (
        <InstanceSettingsTab client={client} detail={detail} onChanged={refresh} onDeleted={onDeleted} />
      )}
    </div>
  );
}

function OverviewTab({
  client,
  detail,
  onRefresh,
}: {
  client: AgentClient;
  detail: Detail;
  onRefresh: () => void;
}) {
  useI18n();
  const [enhancements, setEnhancements] = useState<string[] | null>(null);
  const [hiddenCards, setHiddenCards] = useHiddenCards();

  useEffect(() => {
    client
      .mods(detail.id)
      .then((m) => {
        const on: string[] = [];
        if (m.paldefender.installed) on.push("PalDefender");
        if (m.ue4ss.installed) on.push("UE4SS");
        setEnhancements(on);
      })
      .catch(() => setEnhancements(null));
  }, [client, detail.id]);

  const rows: [string, React.ReactNode][] = [
    [t("狀態"), t(STATUS_LABELS[detail.status])],
    [t("運行方式"), detail.backend === "native" ? t("原生") : detail.backend === "docker" ? t("Docker 容器") : t("Kubernetes Pod")],
    [
      t("類型"),
      enhancements && enhancements.length > 0 ? t("強化({list})", { list: enhancements.join(" + ") }) : t("原味"),
    ],
    [t("遊戲埠(UDP)"), String(detail.gamePort)],
    ["REST API", detail.settings.RESTAPIEnabled ? t("啟用({port})", { port: Number(detail.settings.RESTAPIPort) }) : t("停用")],
    ["RCON", detail.settings.RCONEnabled ? t("啟用({port})", { port: Number(detail.settings.RCONPort) }) : t("停用")],
    [detail.backend === "native" ? t("行程 PID") : detail.backend === "docker" ? t("容器 ID") : t("Pod 名稱"), detail.runtimeId ? detail.runtimeId.slice(0, 12) : "—"],
    // 伺服器目錄刻意不放總覽(截圖/直播容易外洩本機路徑);要看去實例「設定」分頁,那裡有遮蔽。
    [t("建立時間"), new Date(detail.createdAt).toLocaleString()],
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* 邀請卡顯示時:左欄「伺服器資訊+遊戲版本」疊放,右欄邀請卡(內容高度);
          關掉邀請卡後:回到資訊左、版本右的兩欄並排。 */}
      {(() => {
        const infoCard = (
          <div className={card}>
            <h3 className="mb-3 text-sm font-extrabold text-ink-muted">{t("伺服器資訊")}</h3>
            <dl className="flex flex-col gap-2">
              {rows.map(([k, v], i) => (
                <div key={i} className="flex items-center justify-between gap-4 text-sm">
                  <dt className="shrink-0 text-ink-muted">{k}</dt>
                  <dd className="min-w-0 text-right font-bold">
                    {typeof v === "string" ? <span className="break-all">{v}</span> : v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        );
        const versionCard = (
          <VersionCard
            client={client}
            instanceId={detail.id}
            running={detail.status === "running"}
            canReinstall={detail.backend === "native"}
            onUpdateStarted={onRefresh}
          />
        );
        return hiddenCards.includes("invite") ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {infoCard}
            {versionCard}
          </div>
        ) : (
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-4">
              {infoCard}
              {versionCard}
            </div>
            <ConnectionCard
              client={client}
              instanceId={detail.id}
              onDismiss={() => setHiddenCards([...hiddenCards, "invite"])}
            />
          </div>
        );
      })()}
    </div>
  );
}

/** 可拖曳排序的分頁標籤:PointerSensor 距離閾值讓點擊照常運作。 */
function SortableTabButton({
  id,
  active,
  label,
  onSelect,
}: {
  id: Tab;
  active: boolean;
  label: string;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <button
      ref={setNodeRef}
      data-tab={id}
      style={{ transform: DndCSS.Translate.toString(transform), transition, touchAction: "none" }}
      className={`${
        active
          ? "-mb-0.5 border-b-[3px] border-pal px-4 py-2 text-sm font-extrabold whitespace-nowrap text-pal"
          : "px-4 py-2 text-sm font-extrabold whitespace-nowrap text-ink-muted transition hover:text-ink"
      }${isDragging ? " z-10 opacity-60" : ""}`}
      onClick={onSelect}
      {...attributes}
      {...listeners}
    >
      {label}
    </button>
  );
}

/** 小圓角開關(重點標記 / 格式化 / 翻譯)。 */
function LogToggle({
  on,
  onChange,
  icon,
  label,
  disabled,
  title,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  icon?: React.ReactNode;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-extrabold transition ${
        on ? "bg-pal text-white" : "border-2 border-line bg-card-soft text-ink-muted hover:border-pal"
      } ${disabled ? "cursor-not-allowed opacity-50 hover:border-line" : ""}`}
      onClick={() => !disabled && onChange(!on)}
      disabled={disabled}
      title={title}
      aria-pressed={on}
    >
      {icon} {label}
    </button>
  );
}

function LogsTab({ client, instanceId }: { client: AgentClient; instanceId: string }) {
  useI18n();
  const [sources, setSources] = useState<LogSource[]>([]);
  const [source, setSource] = useState<LogSourceId | "">("");
  const [lines, setLines] = useState<string[]>([]);
  const [entitled, setEntitled] = useState<boolean | null>(null);
  const prefs = useLogPrefs();
  const transRef = useRef<Map<string, string>>(new Map());
  const [, bumpTrans] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  // 廣播訊息(從玩家分頁移來):日誌串流就在上方,管理員能邊看聊天邊回話。
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const sendAnnounce = async () => {
    if (!message.trim()) return;
    setSending(true);
    setSendError(null);
    try {
      await client.announce(instanceId, message.trim());
      setMessage("");
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    client.license().then((l) => setEntitled(hasFeature("log-tools", l))).catch(() => setEntitled(false));
  }, [client]);

  useEffect(() => {
    client
      .logSources(instanceId)
      .then((s) => {
        setSources(s);
        // 預設選第一個可用來源(PalDefender 優先,否則原生遊戲);不再寫死已移除的 agent。
        setSource((cur) => (cur && s.some((x) => x.id === cur) ? cur : s[0]?.id ?? ""));
      })
      .catch(() => setSources([]));
  }, [client, instanceId]);

  useEffect(() => {
    if (!source) return;
    setLines([]);
    const socket = client.logsSocket(instanceId, source);
    // Windows 的日誌是 CRLF,切行後每行尾端會留一個 \r;不去掉的話,formatLine 裡收在
    // 行尾的 regex($ 錨點)會匹配失敗(JS 的 $ 不在 \r 前匹配)。進來就正規化掉。
    socket.onmessage = (ev) => setLines((prev) => [...prev.slice(-999), String(ev.data).replace(/\r+$/, "")]);
    socket.onclose = (ev) => {
      if (ev.code !== 1000 && ev.code !== 1005) {
        setLines((prev) => [...prev, t("— 日誌串流已中斷({reason})—", { reason: String(ev.reason || ev.code) })]);
      }
    };
    return () => socket.close();
  }, [client, instanceId, source]);

  // 翻譯(贊助者功能 log-tools):把要翻的行一次「批次」送 agent 代理 Google 翻譯(換行合併,
  // 一個請求翻很多行 → 即時感),結果快取,同句不重複。格式化開著就只翻套不了版的一般行訊息
  // (事件行已中文套版);沒開就整行送翻。英文介面不翻。開著時新行進來會再補翻。
  useEffect(() => {
    if (entitled !== true || !prefs.translate) return;
    const tlv = translateTarget();
    if (tlv === "en") return;
    // 收集近 300 行裡還沒翻的句子(去重)。
    const need: string[] = [];
    const seen = new Set<string>();
    for (const line of lines.slice(-300)) {
      let q: string;
      if (prefs.format) {
        if (formatLine(line)) continue; // 事件行不翻
        const g = genericLine(line);
        if (!g || !g.message.trim()) continue;
        q = g.message;
      } else {
        q = line.replace(/[\s﻿]+$/, "");
        if (!q.trim()) continue;
      }
      if (transRef.current.has(`${tlv}\n${q}`) || seen.has(q)) continue;
      seen.add(q);
      need.push(q);
    }
    if (!need.length) return;
    need.forEach((q) => transRef.current.set(`${tlv}\n${q}`, "")); // 佔位避免同句重複請求
    // 注意:不要因 effect 重跑(串流每來一行就重跑)而丟棄結果 —— transRef 是持久的 ref,
    // 一律寫回快取才不會讓在途批次的譯文被孤兒化。翻到的寫回;失敗/空的移除佔位讓下次重試。
    (async () => {
      try {
        const r = await client.translateBatch(need, tlv);
        need.forEach((q, i) => {
          const val = r.texts[i] || "";
          if (val) transRef.current.set(`${tlv}\n${q}`, val);
          else transRef.current.delete(`${tlv}\n${q}`);
        });
      } catch {
        need.forEach((q) => transRef.current.delete(`${tlv}\n${q}`));
      }
      bumpTrans((v) => v + 1);
    })();
  }, [entitled, prefs.translate, prefs.format, lines, client]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  const highlight = prefs.highlight; // 免費
  const format = prefs.format; // 免費
  const translate = entitled === true && prefs.translate; // 贊助者限定
  const tl = translateTarget();

  return (
    <div className="flex flex-col gap-3">
      {sources.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {sources.map((s) => (
            <button
              key={s.id}
              className={
                s.id === source
                  ? "rounded-full bg-pal px-4 py-1.5 text-[13px] font-extrabold text-white"
                  : "rounded-full border-2 border-line bg-card-soft px-4 py-1.5 text-[13px] font-extrabold text-ink-muted transition hover:border-pal disabled:opacity-40 disabled:hover:border-line"
              }
              onClick={() => setSource(s.id)}
              disabled={!s.available}
              title={s.available ? undefined : t("此日誌尚未產生")}
            >
              {t(s.label)}
            </button>
          ))}
        </div>
      )}

      {source && (
        <p className="inline-flex w-fit items-center gap-1.5 rounded-full bg-card-soft px-3 py-1 text-[12px] font-bold text-ink-muted">
          <FiFileText className="size-3.5" />
          {t("日誌來源:{src}", { src: t(sources.find((s) => s.id === source)?.label ?? source) })}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <LogToggle on={prefs.highlight} onChange={prefs.setHighlight} label={t("重點標記")} />
        <LogToggle on={prefs.format} onChange={prefs.setFormat} icon={<FiAlignLeft className="size-4" />} label={t("格式化")} />
        {/* 翻譯:贊助者限定,星星標示;未解鎖時停用。 */}
        <LogToggle
          on={translate}
          onChange={(v) => entitled === true && prefs.setTranslate(v)}
          disabled={entitled !== true}
          icon={<FiStar className="size-4 text-pal" />}
          label={t("翻譯")}
          title={entitled === true ? undefined : t("翻譯為贊助者專屬功能")}
        />
      </div>
      {entitled === false && (
        <p className="inline-flex items-center gap-2 rounded-cute border-2 border-sun/40 bg-sun/10 px-3 py-2 text-xs font-bold text-sun">
          <FiStar className="size-4 shrink-0 text-pal" />
          {t("日誌翻譯為贊助者專屬功能,到「設定 → 贊助者識別碼」輸入識別碼即可解鎖。")}
        </p>
      )}

      <div className="h-[440px] overflow-auto rounded-(--radius-cute) bg-[#1c1927] p-4 font-mono text-sm">
        {lines.length ? (
          lines.map((line, i) => {
            const color = highlight ? categoryColor(classifyLine(line)) : "#cfd6df";
            let text = line;
            if (format) {
              const ev = formatLine(line);
              if (ev) {
                text = ev; // 事件行:套版好的
              } else {
                const g = genericLine(line);
                if (g) {
                  // 一般英文行:翻譯開著且有譯文就用譯文,否則用去前綴的原文。
                  const tr = translate && tl !== "en" ? transRef.current.get(`${tl}\n${g.message}`) : "";
                  text = `${g.time}  ${tr || g.message}`;
                }
              }
            } else if (translate && tl !== "en") {
              // 不格式化但開翻譯:整行送翻。
              const q = line.replace(/[\s﻿]+$/, "");
              text = transRef.current.get(`${tl}\n${q}`) || line;
            }
            return (
              <div key={i} className="whitespace-pre-wrap break-all" style={{ color }}>
                {maskSteamIdsInText(text)}
              </div>
            );
          })
        ) : (
          <span className="text-[#cfd6df]">{t("(尚無日誌)")}</span>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 廣播訊息(從玩家分頁移來):貼在日誌下方,聊天訊息在上面滾,回話就在手邊。 */}
      {sendError && <p className={errorCls}>{sendError}</p>}
      <form
        className="flex shrink-0 items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void sendAnnounce();
        }}
      >
        <input
          className={`${inputCls} min-w-0 flex-1`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t("輸入要廣播給所有玩家的訊息…")}
          maxLength={500}
        />
        <button className={`${btn} inline-flex shrink-0 items-center gap-1.5`} disabled={sending || !message.trim()}>
          <FiSend className="size-4" /> {sending ? t("發送中…") : t("廣播")}
        </button>
      </form>
    </div>
  );
}
