import { useCallback, useEffect, useRef, useState } from "react";
import { GiSheep, GiEggClutch } from "react-icons/gi";
import { FiPlus } from "react-icons/fi";
import type { InstanceSummary } from "@palserver/shared";
import { AgentClient, loadConnection, saveConnection, type Connection } from "./api";
import { InstanceDetailPage } from "./InstanceDetail";
import { Overlay, StatusBadge, btn, btnGhost, card, errorCls, inputCls, labelCls } from "./ui";

export default function App() {
  const [conn, setConn] = useState<Connection | null>(loadConnection);
  if (!conn) {
    return (
      <ConnectScreen
        onConnect={(c) => {
          saveConnection(c);
          setConn(c);
        }}
      />
    );
  }
  return (
    <Shell
      conn={conn}
      onDisconnect={() => {
        saveConnection(null);
        setConn(null);
      }}
    />
  );
}

function ConnectScreen({ onConnect }: { onConnect: (c: Connection) => void }) {
  const [url, setUrl] = useState("http://localhost:8250");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const conn = { url: url.replace(/\/$/, ""), token: token.trim() };
    try {
      await new AgentClient(conn).info();
      onConnect(conn);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <form className={`${card} flex w-[380px] flex-col gap-4 text-center`} onSubmit={submit}>
        <img src="/logo.png" alt="palserver GUI" className="mx-auto size-18 rounded-[22px]" />
        <div>
          <h1 className="text-[22px] font-extrabold tracking-wide">palserver GUI</h1>
          <p className="mt-1 text-[13px] text-ink-muted">連線到你的 palserver agent</p>
        </div>
        <label className={labelCls}>
          Agent 位址
          <input
            className={inputCls}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://host:8250"
          />
        </label>
        <label className={labelCls}>
          API Token
          <input
            className={inputCls}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type="password"
            placeholder="agent 首次啟動時印在終端機"
          />
        </label>
        {error && <p className={errorCls}>{error}</p>}
        <button className={btn} disabled={busy || !token.trim()}>
          {busy ? "連線中…" : "連線"}
        </button>
      </form>
    </div>
  );
}

function Shell({ conn, onDisconnect }: { conn: Connection; onDisconnect: () => void }) {
  const client = useRef(new AgentClient(conn)).current;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-[1000px] p-6">
      <header className="mb-6 flex items-center justify-between">
        <button className="flex items-center gap-2.5" onClick={() => setSelectedId(null)}>
          <img src="/logo.png" alt="" className="size-10 rounded-xl" />
          <h1 className="text-[22px] font-extrabold tracking-wide">palserver GUI</h1>
        </button>
        <div className="flex items-center gap-2.5">
          <span className="hidden text-[13px] text-ink-muted sm:inline">{conn.url}</span>
          <button className={btnGhost} onClick={onDisconnect}>
            中斷連線
          </button>
        </div>
      </header>
      {selectedId ? (
        <InstanceDetailPage
          client={client}
          instanceId={selectedId}
          onBack={() => setSelectedId(null)}
          onDeleted={() => setSelectedId(null)}
        />
      ) : (
        <Dashboard client={client} onOpen={(id) => setSelectedId(id)} />
      )}
    </div>
  );
}

function Dashboard({ client, onOpen }: { client: AgentClient; onOpen: (id: string) => void }) {
  const [instances, setInstances] = useState<InstanceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setInstances(await client.listInstances());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <>
      {error && <p className={errorCls}>{error}</p>}
      <div className="flex items-center justify-between">
        <h2 className="my-3.5 text-[17px] font-extrabold">伺服器</h2>
        <button className={`${btn} inline-flex items-center gap-1.5`} onClick={() => setShowCreate(true)}>
          <FiPlus className="size-4" /> 建立伺服器
        </button>
      </div>
      {instances === null ? (
        <div className="rounded-(--radius-cute) border-2 border-dashed border-line px-6 py-12 text-center text-ink-muted">
          <GiEggClutch className="mx-auto mb-2 size-11 animate-bounce" />
          載入中…
        </div>
      ) : instances.length === 0 ? (
        <div className="rounded-(--radius-cute) border-2 border-dashed border-line px-6 py-12 text-center text-ink-muted">
          <GiSheep className="mx-auto mb-2 size-11" />
          還沒有伺服器,建立第一個吧!
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-3.5">
          {instances.map((inst) => (
            <button
              className={`${card} text-left transition hover:-translate-y-0.5 hover:shadow-(--shadow-cute-hover)`}
              key={inst.id}
              onClick={() => onOpen(inst.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <strong className="text-base font-extrabold">{inst.name}</strong>
                <StatusBadge status={inst.status} />
              </div>
              <p className="mt-1 text-[13px] text-ink-muted">
                {inst.flavor === "vanilla" ? "原味" : "模組版"} · UDP {inst.gamePort}
              </p>
            </button>
          ))}
        </div>
      )}
      {showCreate && (
        <CreateDialog
          client={client}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void refresh();
          }}
        />
      )}
    </>
  );
}

function CreateDialog({
  client,
  onClose,
  onCreated,
}: {
  client: AgentClient;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [backend, setBackend] = useState<"native" | "docker">("native");
  const [serverDir, setServerDir] = useState("");
  const [gamePort, setGamePort] = useState(8211);
  const [maxPlayers, setMaxPlayers] = useState(32);
  const [serverPassword, setServerPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.createInstance({
        name,
        backend,
        flavor: "vanilla",
        gamePort,
        serverDir: backend === "native" && serverDir.trim() ? serverDir.trim() : undefined,
        settings: { ServerPlayerMaxNum: maxPlayers, ServerPassword: serverPassword },
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Overlay onClose={onClose}>
      <form
        className={`${card} flex w-[430px] max-w-full flex-col gap-3`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 className="inline-flex items-center gap-2 text-lg font-extrabold">
          <GiEggClutch className="size-5 text-pal" /> 建立伺服器
        </h2>
        <label className={labelCls}>
          名稱
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-server"
            pattern="[a-z0-9][a-z0-9-]*"
            required
          />
        </label>
        <label className={labelCls}>
          運行方式
          <select
            className={inputCls}
            value={backend}
            onChange={(e) => setBackend(e.target.value as "native" | "docker")}
          >
            <option value="native">原生(直接在這台主機上運行,推薦)</option>
            <option value="docker">Docker 容器</option>
          </select>
        </label>
        {backend === "native" && (
          <label className={labelCls}>
            既有伺服器路徑(選填)
            <input
              className={inputCls}
              value={serverDir}
              onChange={(e) => setServerDir(e.target.value)}
              placeholder="留空 = 自動下載;或填入現有 PalServer 安裝目錄"
            />
          </label>
        )}
        <label className={labelCls}>
          遊戲埠(UDP)
          <input
            className={inputCls}
            type="number"
            value={gamePort}
            onChange={(e) => setGamePort(Number(e.target.value))}
          />
        </label>
        <label className={labelCls}>
          最大玩家數
          <input
            className={inputCls}
            type="number"
            value={maxPlayers}
            onChange={(e) => setMaxPlayers(Number(e.target.value))}
            min={1}
            max={32}
          />
        </label>
        <label className={labelCls}>
          伺服器密碼(選填)
          <input
            className={inputCls}
            value={serverPassword}
            onChange={(e) => setServerPassword(e.target.value)}
          />
        </label>
        {error && <p className={errorCls}>{error}</p>}
        <div className="mt-1 flex gap-2">
          <button className={btn} disabled={busy}>
            {busy ? "建立中…" : "建立"}
          </button>
          <button type="button" className={btnGhost} onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </Overlay>
  );
}
