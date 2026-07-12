import { useEffect, useState } from "react";
import { FiStar, FiLock, FiX, FiPlus, FiTrash2, FiPackage } from "react-icons/fi";
import { hasFeature, type KnownPlayer } from "@palserver/shared";
import type { AgentClient } from "./api";
import { EntityPicker } from "./EntityPicker";
import { PlayerPicker } from "./PlayerPicker";
import { useGameData, itemIconUrl } from "./gameData";
import { t, useI18n } from "./i18n";
import { Overlay, btn, btnGhost, card, errorCls, inputCls } from "./ui";

interface ItemRow {
  itemId: string;
  amount: string;
}

/**
 * 批量給予道具(贊助者先行版 bulk-items):一次發多個道具給玩家。
 * 每一列用道具選單(圖示搜尋)選道具、填數量,可加減列。透過 PalDefender
 * RCON `giveitems <UserId> item:qty …` 送出,立即生效、不需重啟。
 */
export function GiveItemsModal({
  client,
  instanceId,
  initialUserId,
  onClose,
}: {
  client: AgentClient;
  instanceId: string;
  initialUserId?: string;
  onClose: () => void;
}) {
  useI18n();
  const gameData = useGameData();
  const [entitled, setEntitled] = useState<boolean | null>(null);
  const [players, setPlayers] = useState<KnownPlayer[]>([]);
  const [userId, setUserId] = useState(initialUserId ?? "");
  const [rows, setRows] = useState<ItemRow[]>([{ itemId: "", amount: "1" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    client
      .license()
      .then((l) => setEntitled(hasFeature("bulk-items", l)))
      .catch(() => setEntitled(false));
    client.knownPlayers(instanceId).then(setPlayers).catch(() => setPlayers([]));
  }, [client, instanceId]);

  const locked = entitled === false;
  const validRows = rows.filter((r) => r.itemId.trim() !== "");
  const canSubmit = !locked && userId.trim() !== "" && validRows.length > 0 && !busy;

  const setRow = (i: number, patch: Partial<ItemRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => [...rs, { itemId: "", amount: "1" }]);
  const removeRow = (i: number) => setRows((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : rs));

  const submit = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    const items = validRows.map((r) => ({
      itemId: r.itemId.trim(),
      amount: Math.min(99999, Math.max(1, Math.trunc(Number(r.amount) || 1))),
    }));
    try {
      const res = await client.giveItems(instanceId, userId.trim(), items);
      setResult(res.output || t("已送出"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay onClose={onClose}>
      <div
        className={`${card} flex max-h-[86vh] w-160 max-w-full flex-col gap-3 overflow-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between">
          <h2 className="inline-flex items-center gap-2 text-lg font-extrabold">
            <FiPackage className="size-5 text-pal" /> {t("批量給予道具")}
            <span className="inline-flex items-center gap-1 rounded-full bg-pal/10 px-2 py-0.5 text-xs font-bold text-pal">
              <FiStar className="size-3" /> {t("贊助者")}
            </span>
          </h2>
          <button className="text-ink-muted transition hover:text-ink" onClick={onClose} aria-label={t("關閉")}>
            <FiX className="size-5" />
          </button>
        </div>

        {locked && (
          <div className="inline-flex items-center gap-2 rounded-cute border-2 border-sun/40 bg-sun/10 px-3 py-2 text-xs font-bold text-sun">
            <FiLock className="size-4 shrink-0" />
            {t("這是贊助者先行版功能。到「設定 → 贊助者識別碼」輸入識別碼即可使用。")}
          </div>
        )}

        <p className="text-xs text-ink-muted">
          {t("一次發多個道具給指定玩家(透過 PalDefender),立即生效、不需重啟。")}
        </p>

        <div className={locked ? "pointer-events-none flex flex-col gap-3 opacity-55" : "flex flex-col gap-3"}>
          <label className="flex min-w-0 flex-col gap-1 text-xs font-bold text-ink-muted">
            {t("目標玩家")}
            <PlayerPicker roster={players} value={userId} onChange={setUserId} />
          </label>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-bold text-ink-muted">{t("道具清單")}</span>
            {rows.map((row, i) => (
              <div key={i} className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  {gameData ? (
                    <EntityPicker
                      catalog={gameData.items}
                      iconUrl={itemIconUrl}
                      value={row.itemId}
                      onChange={(v) => setRow(i, { itemId: v })}
                      placeholder={t("搜尋道具名稱或輸入 ID…")}
                    />
                  ) : (
                    <input
                      className={inputCls}
                      value={row.itemId}
                      placeholder="Wood"
                      onChange={(e) => setRow(i, { itemId: e.target.value })}
                    />
                  )}
                </div>
                <input
                  className={`${inputCls} w-24 text-right`}
                  type="number"
                  min={1}
                  max={99999}
                  value={row.amount}
                  onChange={(e) => setRow(i, { amount: e.target.value })}
                  aria-label={t("數量")}
                />
                <button
                  type="button"
                  className="grid size-9 shrink-0 place-items-center rounded-xl border-2 border-line text-ink-muted transition hover:border-berry hover:text-berry disabled:opacity-40"
                  onClick={() => removeRow(i)}
                  disabled={rows.length === 1}
                  aria-label={t("移除")}
                >
                  <FiTrash2 className="size-4" />
                </button>
              </div>
            ))}
            <button
              type="button"
              className={`${btnGhost} btn-sm inline-flex w-fit items-center gap-1.5`}
              onClick={addRow}
            >
              <FiPlus className="size-4" /> {t("新增道具")}
            </button>
          </div>
        </div>

        {error && <p className={errorCls}>{error}</p>}
        {result && (
          <p className="rounded-xl bg-grass/10 px-3 py-2 text-[13px] font-bold text-grass">{result}</p>
        )}

        <button
          className={`${btn} inline-flex items-center justify-center gap-1.5`}
          onClick={submit}
          disabled={!canSubmit}
        >
          <FiPackage className="size-4" /> {busy ? t("發送中…") : t("給予道具")}
        </button>
      </div>
    </Overlay>
  );
}
