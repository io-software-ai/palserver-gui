import { useCallback, useEffect, useState } from "react";
import {
  FiUsers,
  FiSend,
  FiSave,
  FiSlash,
  FiLogOut,
  FiRefreshCw,
  FiEye,
  FiEyeOff,
  FiCopy,
  FiCheck,
} from "react-icons/fi";
import { savToMap, type LiveStatus, type RestPlayer } from "@palserver/shared";
import type { AgentClient } from "./api";
import { btn, btnGhost, card, errorCls, inputCls } from "./ui";

const fmtUptime = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h} 小時 ${m} 分` : `${m} 分`;
};

/** Steam IDs identify a real person, so show them masked by default —
 * enough to tell players apart, not enough to paste into a lookup site. */
function maskSteamId(userId: string): string {
  const digits = userId.replace(/^steam_/, "");
  if (digits.length <= 8) return digits;
  return `${digits.slice(0, 4)}${"•".repeat(6)}${digits.slice(-4)}`;
}

function SteamId({ userId }: { userId: string }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const raw = userId.replace(/^steam_/, "");

  const copy = async () => {
    await navigator.clipboard.writeText(raw).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs text-ink-muted">
      {revealed ? raw : maskSteamId(userId)}
      <button
        onClick={() => setRevealed((v) => !v)}
        className="text-ink-muted transition hover:text-pal"
        aria-label={revealed ? "隱藏 Steam ID" : "顯示 Steam ID"}
        title={revealed ? "隱藏" : "顯示完整 Steam ID"}
      >
        {revealed ? <FiEyeOff className="size-3.5" /> : <FiEye className="size-3.5" />}
      </button>
      <button
        onClick={copy}
        className="text-ink-muted transition hover:text-pal"
        aria-label="複製 Steam ID"
        title="複製"
      >
        {copied ? <FiCheck className="size-3.5 text-grass" /> : <FiCopy className="size-3.5" />}
      </button>
    </span>
  );
}

export function PlayersTab({ client, instanceId }: { client: AgentClient; instanceId: string }) {
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setLive(await client.live(instanceId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, instanceId]);

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

  const announce = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    await act(() => client.announce(instanceId, message.trim()), "已廣播訊息");
    setMessage("");
  };

  const playerAction = async (player: RestPlayer, action: "kick" | "ban") => {
    const verb = action === "kick" ? "踢出" : "封鎖";
    if (!confirm(`確定要${verb}「${player.name}」嗎?此舉動會將他從伺服器移除。`)) return;
    await act(
      () => client.playerAction(instanceId, player.userId, action, `你已被${verb}`),
      `已${verb} ${player.name}`,
    );
  };

  if (!live) return <p className="text-ink-muted">{error ?? "載入中…"}</p>;

  if (!live.available) {
    return (
      <div className="rounded-(--radius-cute) border-2 border-dashed border-line px-6 py-12 text-center text-ink-muted">
        <FiUsers className="mx-auto mb-2 size-11" />
        <p className="font-bold">無法連線到伺服器的 REST API</p>
        <p className="mt-1 text-[13px]">{live.reason}</p>
      </div>
    );
  }

  const { info, metrics, players } = live;

  return (
    <div className="flex flex-col gap-4">
      {error && <p className={errorCls}>{error}</p>}
      {notice && (
        <p className="rounded-xl bg-grass/10 px-3 py-2 text-[13px] font-bold text-grass">{notice}</p>
      )}

      {metrics && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="在線玩家" value={`${metrics.currentplayernum} / ${metrics.maxplayernum}`} />
          <Stat label="伺服器 FPS" value={String(metrics.serverfps)} />
          <Stat label="運行時間" value={fmtUptime(metrics.uptime)} />
          <Stat label="遊戲天數" value={`第 ${metrics.days} 天`} />
        </div>
      )}

      <div className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-extrabold">{info?.servername ?? "伺服器"}</h3>
            <p className="text-[13px] text-ink-muted">
              版本 {info?.version ?? "—"} · 據點 {metrics?.basecampnum ?? 0} 個 · 幀時間{" "}
              {metrics ? `${metrics.serverframetime.toFixed(1)} ms` : "—"}
            </p>
          </div>
          <div className="flex gap-2">
            <button className={btnGhost} onClick={refresh} disabled={busy} aria-label="重新整理">
              <FiRefreshCw className="size-4" />
            </button>
            <button
              className={`${btnGhost} inline-flex items-center gap-1.5`}
              onClick={() => act(() => client.saveWorld(instanceId), "世界已存檔")}
              disabled={busy}
            >
              <FiSave className="size-4" /> 立即存檔
            </button>
          </div>
        </div>
      </div>

      <form className={`${card} flex flex-wrap items-center gap-2`} onSubmit={announce}>
        <input
          className={`${inputCls} min-w-52 flex-1`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="輸入要廣播給所有玩家的訊息…"
          maxLength={500}
        />
        <button className={`${btn} inline-flex items-center gap-1.5`} disabled={busy || !message.trim()}>
          <FiSend className="size-4" /> 廣播
        </button>
      </form>

      <div className={`${card} p-0`}>
        <h3 className="border-b-2 border-line px-5 py-3 text-sm font-extrabold text-ink-muted">
          在線玩家({players.length})
        </h3>
        {players.length === 0 ? (
          <p className="px-5 py-8 text-center text-[13px] text-ink-muted">目前沒有玩家在線上。</p>
        ) : (
          <div className="flex flex-col divide-y divide-line">
            {players.map((p) => {
              const loc = savToMap(p.location_x, p.location_y);
              return (
              <div key={p.userId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                <div className="min-w-40 flex-1">
                  <p className="text-sm font-extrabold">{p.name}</p>
                  <p className="text-xs text-ink-muted">
                    Lv.{p.level} · Ping {Math.round(p.ping)} ms · 建築 {p.building_count} · 座標{" "}
                    {Math.round(loc.x)}, {Math.round(loc.y)}
                  </p>
                  <p className="mt-0.5">
                    <SteamId userId={p.userId} />
                  </p>
                </div>
                <p className="hidden text-xs text-ink-muted sm:block">{p.ip}</p>
                <div className="flex gap-2">
                  <button
                    className={`${btnGhost} inline-flex items-center gap-1.5`}
                    onClick={() => playerAction(p, "kick")}
                    disabled={busy}
                  >
                    <FiLogOut className="size-3.5" /> 踢出
                  </button>
                  <button
                    className={`${btnGhost} inline-flex items-center gap-1.5 text-berry hover:border-berry`}
                    onClick={() => playerAction(p, "ban")}
                    disabled={busy}
                  >
                    <FiSlash className="size-3.5" /> 封鎖
                  </button>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>
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
