import { useCallback, useEffect, useRef, useState } from "react";
import { FiTerminal, FiPlay, FiSearch, FiTrash2 } from "react-icons/fi";
import { GiShield } from "react-icons/gi";
import {
  COMMAND_CATEGORY_LABELS,
  buildCommand,
  type CommandArg,
  type CommandSpec,
  type RconCommandsResponse,
  type RestPlayer,
} from "@palserver/shared";
import type { AgentClient } from "./api";
import { btn, btnGhost, card, errorCls, inputCls, labelCls } from "./ui";

interface LogEntry {
  command: string;
  output: string;
  failed: boolean;
}

/** A command argument. `userid` arguments get a picker of online players
 * (falling back to free text — the target may be offline, e.g. /unban). */
function ArgField({
  arg,
  players,
  value,
  onChange,
}: {
  arg: CommandArg;
  players: RestPlayer[];
  value: string;
  onChange: (value: string) => void;
}) {
  const isPlayerArg = arg.name === "userid";
  const known = players.some((p) => p.userId === value);

  return (
    <label className={labelCls}>
      {arg.label}
      {!arg.required && <span className="font-normal">(選填)</span>}
      {isPlayerArg && players.length > 0 && (
        <select
          className={inputCls}
          value={known ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">— 從在線玩家選擇 —</option>
          {players.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.name}(Lv.{p.level})
            </option>
          ))}
        </select>
      )}
      <input
        className={inputCls}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          isPlayerArg && players.length > 0 ? "或直接輸入 UserId(離線玩家)" : arg.placeholder
        }
      />
    </label>
  );
}

export function ConsoleTab({ client, instanceId }: { client: AgentClient; instanceId: string }) {
  const [catalog, setCatalog] = useState<RconCommandsResponse | null>(null);
  const [selected, setSelected] = useState<CommandSpec | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [raw, setRaw] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const [players, setPlayers] = useState<RestPlayer[]>([]);

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

  // Online players feed the UserId pickers; the REST API may be off, in which
  // case the fields simply stay free-text.
  useEffect(() => {
    const poll = () =>
      client
        .live(instanceId)
        .then((live) => setPlayers(live.available ? live.players : []))
        .catch(() => setPlayers([]));
    void poll();
    const timer = setInterval(poll, 10000);
    return () => clearInterval(timer);
  }, [client, instanceId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  const run = async (command: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await client.rconExec(instanceId, command);
      setLog((prev) => [...prev.slice(-99), { command, output: res.output || "(無輸出)", failed: false }]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLog((prev) => [...prev.slice(-99), { command, output: message, failed: true }]);
    } finally {
      setBusy(false);
    }
  };

  const submitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    const missing = selected.args.filter((a) => a.required && !values[a.name]?.trim());
    if (missing.length > 0) {
      setError(`缺少必填參數:${missing.map((a) => a.label).join("、")}`);
      return;
    }
    const command = buildCommand(selected, values);
    if (selected.dangerous && !confirm(`「${selected.label}」是不可復原的操作。\n\n確定要執行 ${command} 嗎?`)) {
      return;
    }
    await run(command);
  };

  if (!catalog) return <p className="text-ink-muted">{error ?? "載入中…"}</p>;

  if (!catalog.available) {
    return (
      <div className="rounded-(--radius-cute) border-2 border-dashed border-line px-6 py-12 text-center text-ink-muted">
        <FiTerminal className="mx-auto mb-2 size-11" />
        <p className="font-bold">RCON 無法使用</p>
        <p className="mt-1 text-[13px]">{catalog.reason}</p>
      </div>
    );
  }

  const query = filter.trim().toLowerCase();
  const visible = catalog.commands.filter(
    (c) => !query || c.name.toLowerCase().includes(query) || c.label.includes(filter.trim()),
  );
  const grouped = new Map<string, CommandSpec[]>();
  for (const cmd of visible) {
    const key = COMMAND_CATEGORY_LABELS[cmd.category];
    grouped.set(key, [...(grouped.get(key) ?? []), cmd]);
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <p className={errorCls}>{error}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-bold text-ink-muted">
          {catalog.commands.length} 個可用指令
        </p>
        {catalog.paldefender ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-grass/40 bg-grass/15 px-3 py-1 text-xs font-bold text-grass">
            <GiShield className="size-3.5" /> PalDefender 指令已啟用
          </span>
        ) : (
          <span className="text-xs text-ink-muted">安裝 PalDefender 可解鎖更多指令</span>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className={`${card} flex max-h-[520px] flex-col gap-2 overflow-y-auto`}>
          <div className="relative">
            <FiSearch className="absolute top-2.5 left-3 size-4 text-ink-muted" />
            <input
              className={`${inputCls} w-full pl-9`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="搜尋指令…"
            />
          </div>
          {[...grouped.entries()].map(([category, cmds]) => (
            <div key={category}>
              <p className="mt-2 mb-1 text-xs font-extrabold text-ink-muted">{category}</p>
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
                    {cmd.dangerous && <span className="ml-1.5 text-berry">危險</span>}
                    <span className="block text-xs text-ink-muted">{cmd.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {visible.length === 0 && <p className="text-[13px] text-ink-muted">找不到符合的指令。</p>}
        </div>

        <div className="flex flex-col gap-4">
          {selected ? (
            <form className={`${card} flex flex-col gap-3`} onSubmit={submitForm}>
              <div>
                <h3 className="font-mono text-base font-extrabold">
                  {selected.name}
                  <span className="ml-2 rounded-full bg-card-soft px-2 py-0.5 font-sans text-xs text-ink-muted">
                    {selected.source === "builtin" ? "內建" : "PalDefender"}
                  </span>
                </h3>
                <p className="mt-1 text-[13px] text-ink-muted">{selected.label}</p>
              </div>
              {selected.args.map((arg) => (
                <ArgField
                  key={arg.name}
                  arg={arg}
                  players={players}
                  value={values[arg.name] ?? ""}
                  onChange={(value) => setValues((v) => ({ ...v, [arg.name]: value }))}
                />
              ))}
              <div className="flex items-center gap-3">
                <button className={`${btn} inline-flex items-center gap-1.5`} disabled={busy}>
                  <FiPlay className="size-4" /> {busy ? "執行中…" : "執行"}
                </button>
                <code className="truncate rounded-lg bg-card-soft px-2 py-1 text-xs text-ink-muted">
                  {buildCommand(selected, values)}
                </code>
              </div>
            </form>
          ) : (
            <div className={`${card} text-[13px] text-ink-muted`}>
              從左側選一個指令,或直接在下方輸入原始指令。
            </div>
          )}

          <form
            className={`${card} flex flex-wrap items-center gap-2`}
            onSubmit={(e) => {
              e.preventDefault();
              if (!raw.trim()) return;
              void run(raw.trim());
              setRaw("");
            }}
          >
            <FiTerminal className="size-4 text-ink-muted" />
            <input
              className={`${inputCls} min-w-52 flex-1 font-mono`}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="輸入原始 RCON 指令,例如 ShowPlayers"
            />
            <button className={btn} disabled={busy || !raw.trim()}>
              送出
            </button>
          </form>

          <div className={`${card} flex flex-col gap-2 p-3`}>
            <div className="flex items-center justify-between px-2">
              <h3 className="text-sm font-extrabold text-ink-muted">輸出</h3>
              {log.length > 0 && (
                <button className={btnGhost} onClick={() => setLog([])} aria-label="清除輸出">
                  <FiTrash2 className="size-4" />
                </button>
              )}
            </div>
            <pre className="h-72 overflow-auto rounded-xl bg-[#1c1927] p-3 font-mono text-xs whitespace-pre-wrap break-all text-[#cfd6df]">
              {log.length === 0
                ? "(尚未執行任何指令)"
                : log.map((entry, i) => (
                    <span key={i}>
                      <span className="text-[#7ec8f0]">&gt; {entry.command}</span>
                      {"\n"}
                      <span className={entry.failed ? "text-[#ef6a6a]" : undefined}>{entry.output}</span>
                      {"\n\n"}
                    </span>
                  ))}
              <div ref={bottomRef} />
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
