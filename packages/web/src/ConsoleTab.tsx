import { useCallback, useEffect, useRef, useState } from "react";
import { FiTerminal, FiPlay, FiSearch, FiTrash2, FiStar } from "react-icons/fi";
import { GiShield } from "react-icons/gi";
import {
  COMMAND_CATEGORY_LABELS,
  buildCommand,
  type CommandArg,
  type CommandSpec,
  type KnownPlayer,
  type RconCommandsResponse,
} from "@palserver/shared";
import type { AgentClient } from "./api";
import { maskSteamIdsInText } from "./SteamId";
import { EntityPicker } from "./EntityPicker";
import { PlayerPicker } from "./PlayerPicker";
import { CustomPalModal } from "./CustomPalModal";
import { GiveItemsModal } from "./GiveItemsModal";
import { SHOW_SPONSOR_FEATURES } from "./flags";
import { useGameData, itemIconUrl, palIconUrl, type GameData } from "./gameData";
import { t, useI18n } from "./i18n";
import { btn, btnGhost, card, errorCls, inputCls, labelCls } from "./ui";

interface LogEntry {
  command: string;
  output: string;
  failed: boolean;
}

/** A command argument. `userid` arguments get a picker listing online players
 * and everyone the agent has seen before — commands like /unban target
 * players who are by definition not connected. Free text still works for
 * anyone the agent has never recorded.
 */
function ArgField({
  arg,
  roster,
  gameData,
  value,
  onChange,
}: {
  arg: CommandArg;
  roster: KnownPlayer[];
  gameData: GameData | null;
  value: string;
  onChange: (value: string) => void;
}) {
  useI18n();
  const isPlayerArg = !!arg.player || arg.name === "userid";

  // Item/Egg/Pal id args get an icon search picker backed by the catalogs.
  // eggid 只列帕魯蛋(不是全部道具),itemid 才是全物品目錄。
  if ((arg.name === "itemid" || arg.name === "eggid") && gameData) {
    const isEgg = arg.name === "eggid";
    return (
      <label className={`${labelCls} min-w-0`}>
        {t(arg.label)}
        {!arg.required && <span className="font-normal">{t("(選填)")}</span>}
        <EntityPicker
          catalog={isEgg ? gameData.eggs : gameData.items}
          iconUrl={itemIconUrl}
          value={value}
          onChange={onChange}
          placeholder={isEgg ? t("搜尋蛋名稱或輸入 ID…") : t("搜尋道具名稱或輸入 ID…")}
        />
      </label>
    );
  }
  if (arg.name === "palid" && gameData) {
    return (
      <label className={`${labelCls} min-w-0`}>
        {t(arg.label)}
        {!arg.required && <span className="font-normal">{t("(選填)")}</span>}
        <EntityPicker
          catalog={gameData.pals}
          iconUrl={palIconUrl}
          value={value}
          onChange={onChange}
          placeholder={t("搜尋帕魯名稱或輸入 ID…")}
        />
      </label>
    );
  }

  // Player args use the shared picker (name-only; never shows the SteamId).
  if (isPlayerArg) {
    return (
      <label className={`${labelCls} min-w-0`}>
        {t(arg.label)}
        {!arg.required && <span className="font-normal">{t("(選填)")}</span>}
        <PlayerPicker roster={roster} value={value} onChange={onChange} placeholder={arg.placeholder} />
      </label>
    );
  }

  return (
    <label className={`${labelCls} min-w-0`}>
      {t(arg.label)}
      {!arg.required && <span className="font-normal">{t("(選填)")}</span>}
      <input
        className={inputCls}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={arg.placeholder}
      />
    </label>
  );
}

export function ConsoleTab({
  client,
  instanceId,
  initialCommandName,
  initialValues,
}: {
  client: AgentClient;
  instanceId: string;
  /** 開啟時預選的指令名稱(例如從玩家詳情「玩家操作」跳來,預選 give / givepal)。 */
  initialCommandName?: string;
  /** 對應的預填參數(例如 { userid: "steam_..." })。 */
  initialValues?: Record<string, string>;
}) {
  useI18n();
  const [catalog, setCatalog] = useState<RconCommandsResponse | null>(null);
  const [selected, setSelected] = useState<CommandSpec | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customPalMode, setCustomPalMode] = useState<null | "pal" | "egg">(null);
  const [showGiveItems, setShowGiveItems] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const [roster, setRoster] = useState<KnownPlayer[]>([]);
  const gameData = useGameData();

  const load = useCallback(async () => {
    try {
      setCatalog(await client.rconCommands(instanceId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, instanceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 若帶了預選指令(從玩家詳情跳來),指令目錄載入後套用一次:選好指令、預填參數。
  const presetApplied = useRef(false);
  useEffect(() => {
    if (presetApplied.current || !catalog?.available || !initialCommandName) return;
    const cmd = catalog.commands.find((c) => c.name === initialCommandName);
    if (cmd) {
      presetApplied.current = true;
      setSelected(cmd);
      if (initialValues) setValues(initialValues);
    }
  }, [catalog, initialCommandName, initialValues]);

  // The agent's roster (online + previously seen) feeds the UserId pickers.
  useEffect(() => {
    const poll = () =>
      client
        .knownPlayers(instanceId)
        .then(setRoster)
        .catch(() => setRoster([]));
    void poll();
    const timer = setInterval(poll, 15000);
    return () => clearInterval(timer);
  }, [client, instanceId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  // 選了指令 / 改了參數,就把組好的指令帶進「唯一」的輸入列(仍可手動改)。
  useEffect(() => {
    if (selected) setRaw(buildCommand(selected, values));
  }, [selected, values]);

  const run = async (command: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await client.rconExec(instanceId, command);
      setLog((prev) => [...prev.slice(-99), { command, output: res.output || t("(無輸出)"), failed: false }]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLog((prev) => [...prev.slice(-99), { command, output: message, failed: true }]);
    } finally {
      setBusy(false);
    }
  };

  // 唯一輸入列的送出:有選指令就先驗必填 / 危險確認,再執行輸入列裡的內容。
  const submitRaw = async (e: React.FormEvent) => {
    e.preventDefault();
    const command = raw.trim();
    if (!command) return;
    if (selected) {
      const missing = selected.args.filter((a) => a.required && !values[a.name]?.trim());
      if (missing.length > 0) {
        setError(t("缺少必填參數:{list}", { list: missing.map((a) => t(a.label)).join("、") }));
        return;
      }
      if (
        selected.dangerous &&
        !confirm(t("「{label}」是不可復原的操作。\n\n確定要執行 {command} 嗎?", { label: t(selected.label), command }))
      ) {
        return;
      }
    }
    await run(command);
  };

  if (!catalog)
    return (
      <div className="grid min-h-0 flex-1 place-items-center text-ink-muted">{error ?? t("載入中…")}</div>
    );

  if (!catalog.available) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center px-6 text-center text-ink-muted">
        <div>
          <FiTerminal className="mx-auto mb-2 size-11" />
          <p className="font-bold">{t("RCON 無法使用")}</p>
          <p className="mt-1 text-[13px]">{catalog.reason}</p>
        </div>
      </div>
    );
  }

  const query = filter.trim().toLowerCase();
  const visible = catalog.commands.filter(
    (c) => !query || c.name.toLowerCase().includes(query) || c.label.includes(filter.trim()),
  );
  const grouped = new Map<string, CommandSpec[]>();
  for (const cmd of visible) {
    const key = t(COMMAND_CATEGORY_LABELS[cmd.category]);
    grouped.set(key, [...(grouped.get(key) ?? []), cmd]);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {error && <p className={`shrink-0 ${errorCls}`}>{error}</p>}

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-bold text-ink-muted">
          {t("{n} 個可用指令", { n: catalog.commands.length })}
        </span>
        {catalog.paldefender ? (
          <span className="inline-flex items-center gap-1 rounded-full border-[1.5px] border-grass/40 bg-grass/15 px-2 py-0.5 font-bold text-grass">
            <GiShield className="size-3" /> {t("PalDefender 指令已啟用")}
          </span>
        ) : (
          <span className="text-ink-muted">{t("安裝 PalDefender 可解鎖更多指令")}</span>
        )}
      </div>

      <div className="grid min-h-0 flex-1 gap-3 sm:grid-cols-[220px_minmax(0,1fr)]">
        {/* 指令選單:搜尋 + 分類清單,自己捲動 */}
        <div className="flex min-h-0 flex-col gap-2 rounded-cute border-2 border-line p-2 max-sm:max-h-52">
          <div className="relative shrink-0">
            <FiSearch className="absolute top-2.5 left-3 size-4 text-ink-muted" />
            <input
              className={`${inputCls} w-full pl-9`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("搜尋指令…")}
            />
          </div>
          {/* 贊助者先行版:自訂帕魯(帕魯 / 帕魯蛋兩條)—— 樣式與下方指令一致,藍色標示贊助。
              未公布前用 SHOW_SPONSOR_FEATURES 整組隱藏;點了跳彈窗,未解鎖時表單不可用。 */}
          {SHOW_SPONSOR_FEATURES && catalog.paldefender && (
            <>
              <button
                type="button"
                className="shrink-0 rounded-lg px-2 py-1.5 text-left text-[13px] transition hover:bg-card-soft"
                onClick={() => setCustomPalMode("pal")}
              >
                <span className="inline-flex items-center gap-1 font-mono text-pal">
                  givepal_j <FiStar className="size-3" />
                </span>
                <span className="block text-xs text-ink-muted">{t("自訂帕魯(詞條 / 體質 / 星星)")}</span>
              </button>
              <button
                type="button"
                className="shrink-0 rounded-lg px-2 py-1.5 text-left text-[13px] transition hover:bg-card-soft"
                onClick={() => setCustomPalMode("egg")}
              >
                <span className="inline-flex items-center gap-1 font-mono text-pal">
                  giveegg_j <FiStar className="size-3" />
                </span>
                <span className="block text-xs text-ink-muted">{t("自訂帕魯蛋(詞條 / 體質 / 星星)")}</span>
              </button>
              <button
                type="button"
                className="shrink-0 rounded-lg px-2 py-1.5 text-left text-[13px] transition hover:bg-card-soft"
                onClick={() => setShowGiveItems(true)}
              >
                <span className="inline-flex items-center gap-1 font-mono text-pal">
                  giveitems <FiStar className="size-3" />
                </span>
                <span className="block text-xs text-ink-muted">{t("批量給予道具(選單 + 數量)")}</span>
              </button>
            </>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {[...grouped.entries()].map(([category, cmds]) => (
              <div key={category}>
                <p className="mt-2 mb-1 px-1 text-xs font-extrabold text-ink-muted">{category}</p>
                <div className="flex flex-col">
                  {cmds.map((cmd) => (
                    <button
                      key={`${cmd.source}-${cmd.name}`}
                      className={`rounded-lg px-2 py-1.5 text-left text-[13px] transition hover:bg-card-soft ${
                        selected?.name === cmd.name ? "bg-card-soft font-extrabold text-pal" : ""
                      }`}
                      onClick={() => {
                        setSelected(cmd);
                        setValues({});
                        setError(null);
                      }}
                    >
                      <span className="font-mono">{cmd.name}</span>
                      {cmd.dangerous && <span className="ml-1.5 text-berry">{t("危險")}</span>}
                      <span className="block text-xs text-ink-muted">{t(cmd.label)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {visible.length === 0 && (
              <p className="px-1 text-[13px] text-ink-muted">{t("找不到符合的指令。")}</p>
            )}
          </div>
        </div>

        {/* 工作區:選定指令的參數 + 唯一輸入列 + 輸出(有內容才出現) */}
        <div className="flex min-h-0 flex-col gap-3">
          {selected && selected.args.length > 0 && (
            <div className="flex shrink-0 flex-col gap-3 rounded-cute border-2 border-line p-3">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <h3 className="font-mono text-sm font-extrabold">{selected.name}</h3>
                <span className="rounded-full bg-card-soft px-2 py-0.5 text-xs text-ink-muted">
                  {selected.source === "builtin" ? t("內建") : "PalDefender"}
                </span>
                <p className="w-full text-[13px] text-ink-muted">{t(selected.label)}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {selected.args.map((arg) => (
                  <ArgField
                    key={arg.name}
                    arg={arg}
                    roster={roster}
                    gameData={gameData}
                    value={values[arg.name] ?? ""}
                    onChange={(value) => setValues((v) => ({ ...v, [arg.name]: value }))}
                  />
                ))}
              </div>
            </div>
          )}

          {/* 唯一的指令輸入列:選了指令會自動帶入,也可自己打 */}
          <form
            className="flex shrink-0 items-center gap-2 rounded-cute border-2 border-line px-3 py-2"
            onSubmit={submitRaw}
          >
            <FiTerminal className="size-4 shrink-0 text-ink-muted" />
            <input
              className="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={t("輸入 RCON 指令,例如 ShowPlayers")}
            />
            <button
              className={`${btn} btn-sm inline-flex shrink-0 items-center gap-1.5`}
              disabled={busy || !raw.trim()}
            >
              <FiPlay className="size-3.5" /> {busy ? t("執行中…") : t("執行")}
            </button>
          </form>

          {/* 輸出:有跑過指令才顯示,撐滿剩餘高度 */}
          {log.length > 0 && (
            <div className="flex min-h-0 flex-1 flex-col gap-1.5">
              <div className="flex shrink-0 items-center justify-between">
                <h3 className="text-xs font-extrabold text-ink-muted">{t("輸出")}</h3>
                <button
                  className="text-ink-muted transition hover:text-berry"
                  onClick={() => setLog([])}
                  aria-label={t("清除輸出")}
                >
                  <FiTrash2 className="size-4" />
                </button>
              </div>
              <pre className="min-h-24 flex-1 overflow-auto rounded-xl bg-[#1c1927] p-3 font-mono text-xs whitespace-pre-wrap break-all text-[#cfd6df]">
                {log.map((entry, i) => (
                  <span key={i}>
                    <span className="text-[#7ec8f0]">&gt; {maskSteamIdsInText(entry.command)}</span>
                    {"\n"}
                    <span className={entry.failed ? "text-[#ef6a6a]" : undefined}>
                      {maskSteamIdsInText(entry.output)}
                    </span>
                    {"\n\n"}
                  </span>
                ))}
                <div ref={bottomRef} />
              </pre>
            </div>
          )}
        </div>
      </div>

      {customPalMode && (
        <CustomPalModal
          client={client}
          instanceId={instanceId}
          mode={customPalMode}
          onClose={() => setCustomPalMode(null)}
        />
      )}
      {showGiveItems && (
        <GiveItemsModal client={client} instanceId={instanceId} onClose={() => setShowGiveItems(false)} />
      )}
    </div>
  );
}
