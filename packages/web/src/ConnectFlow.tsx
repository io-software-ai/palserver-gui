import { useEffect, useRef, useState } from "react";
import { FiArrowRight, FiLock, FiWifi } from "react-icons/fi";
import { probeAgent, pairAgent, type Connection } from "./api";
import { btn, btnGhost, card, errorCls, inputCls, labelCls } from "./ui";
import { LangSelect, useI18n } from "./i18n";
import { ThemeToggle } from "./theme";

/**
 * 新手友善的連線流程。核心洞察:合一版的 web 是 agent 自己 serve 的(same-origin),
 * 所以位址不用玩家填;本機(loopback)更是免 token 直接進。流程:
 *
 *  1. probing —— 先偵測 same-origin 有沒有 agent。
 *     - 有(合一版):?setup=配對碼 → 自動配對進場;loopback → 直接進;
 *       否則(遠端未授權)→ 顯示配對畫面(位址已知)。
 *     - 沒有(這是純 web 站)→ manual,請玩家輸入自己的 agent 位址。
 *  2. pair —— 輸入配對碼(或貼整條設定連結)換發 token;附進階 API token 選項。
 *  3. manual —— 輸入 agent 位址,偵測後轉 pair(或本機直接進)。
 */
const LAST_URL_KEY = "palserver.lastAgentUrl";

type Mode = "probing" | "pair" | "manual";

export function ConnectFlow({ onConnect }: { onConnect: (c: Connection) => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>("probing");
  const [agentUrl, setAgentUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // 嚴格模式下 effect 會跑兩次,自動偵測只做一次。
    ran.current = true;
    void (async () => {
      const origin = window.location.origin;
      const setup = new URLSearchParams(window.location.search).get("setup");
      const info = await probeAgent(origin);
      if (info) {
        // 合一版:這個頁面就是某台 agent serve 的。
        if (setup) {
          try {
            const token = await pairAgent(origin, setup);
            clearSetupParam();
            return onConnect({ url: origin, token });
          } catch {
            clearSetupParam();
            setAgentUrl(origin);
            setError("這條設定連結的配對碼無效或已過期,請重新輸入。");
            setMode("pair");
            return;
          }
        }
        if (info.authenticated) return onConnect({ url: origin, token: "" }); // 本機免驗證
        setAgentUrl(origin);
        setMode("pair");
        return;
      }
      // 純 web 站:請玩家輸入自己的 agent 位址。
      setAgentUrl(localStorage.getItem(LAST_URL_KEY) ?? "http://localhost:8250");
      setMode("manual");
    })();
  }, [onConnect]);

  if (mode === "probing") {
    return (
      <Screen subtitle={t("正在尋找你的 agent…")}>
        <div className="flex justify-center py-2 text-ink-muted">
          <FiWifi className="size-6 animate-pulse" />
        </div>
      </Screen>
    );
  }

  if (mode === "manual") {
    return (
      <ManualStep
        initialUrl={agentUrl}
        onConnected={onConnect}
        onNeedPair={(url) => {
          setAgentUrl(url);
          setError(null);
          setMode("pair");
        }}
      />
    );
  }

  return <PairStep agentUrl={agentUrl} initialError={error} onConnect={onConnect} onBack={() => setMode("manual")} />;
}

/** 共用外框:logo + 標題;右上角放語言/主題切換(這畫面沒有 header)。 */
function Screen({ subtitle, children }: { subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="fixed right-4 top-4 flex items-center gap-2">
        <LangSelect />
        <ThemeToggle />
      </div>
      <div className={`${card} flex max-h-[90vh] w-[400px] max-w-full flex-col gap-4 overflow-y-auto text-center`}>
        <img src="/logo.png" alt="palserver GUI" className="mx-auto size-18 rounded-[22px]" />
        <div>
          <h1 className="text-[22px] font-extrabold tracking-wide">palserver GUI</h1>
          <p className="mt-1 text-[13px] text-ink-muted">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

/** manual:輸入 agent 位址。 */
function ManualStep({
  initialUrl,
  onConnected,
  onNeedPair,
}: {
  initialUrl: string;
  onConnected: (c: Connection) => void;
  onNeedPair: (url: string) => void;
}) {
  const { t } = useI18n();
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const next = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = url.trim().replace(/\/$/, "");
    setBusy(true);
    setError(null);
    // 常見陷阱:https 頁面連 http agent 會被瀏覽器 mixed-content 擋死。
    if (window.location.protocol === "https:" && clean.startsWith("http://")) {
      setBusy(false);
      setError("你正透過 https 網站連到 http 的 agent,瀏覽器會封鎖。請改用區網/VPN 直連(合一版),或用 http 版網頁。");
      return;
    }
    const info = await probeAgent(clean);
    setBusy(false);
    if (!info) {
      setError("連不到這個位址的 agent。確認 agent 正在執行、位址與連接埠正確,且你和它在同一區網或 VPN 內。");
      return;
    }
    localStorage.setItem(LAST_URL_KEY, clean);
    if (info.authenticated) return onConnected({ url: clean, token: "" });
    onNeedPair(clean);
  };

  return (
    <Screen subtitle={t("連線到你的 agent")}>
      <form className="flex flex-col gap-4 text-left" onSubmit={next}>
        <label className={labelCls}>
          {t("Agent 位址")}
          <input
            className={inputCls}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://100.x.x.x:8250"
            autoFocus
          />
          <span className="mt-1 text-xs text-ink-muted">
            {t("在 agent 的視窗裡有列出可用位址;遠端請填 VPN 位址(如 Tailscale 的 100.x)。")}
          </span>
        </label>
        {error && <p className={errorCls}>{t(error)}</p>}
        <button className={`${btn} inline-flex items-center justify-center gap-1.5`} disabled={busy || !url.trim()}>
          {busy ? t("偵測中…") : t("下一步")}
          {!busy && <FiArrowRight className="size-4" />}
        </button>
      </form>
    </Screen>
  );
}

/** pair:輸入配對碼(或貼設定連結)換發 token;附進階 API token。 */
function PairStep({
  agentUrl,
  initialError,
  onConnect,
  onBack,
}: {
  agentUrl: string;
  initialError: string | null;
  onConnect: (c: Connection) => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [token, setToken] = useState("");
  const sameOrigin = agentUrl === window.location.origin;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // 允許直接貼「整條設定連結」,自動抽出配對碼。
      const t = await pairAgent(agentUrl, extractCode(code));
      onConnect({ url: agentUrl, token: t });
    } catch {
      setError("配對碼無效或已過期。請確認和 agent 視窗上顯示的一致。");
      setBusy(false);
    }
  };

  const connectWithToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const info = await probeAgent(agentUrl, token.trim());
    setBusy(false);
    if (info?.authenticated) return onConnect({ url: agentUrl, token: token.trim() });
    setError("這個 API token 無效。");
  };

  return (
    <Screen subtitle={sameOrigin ? t("快完成了!輸入配對碼") : t("連線到 {url}", { url: agentUrl })}>
      <form className="flex flex-col gap-4 text-left" onSubmit={submit}>
        <p className="flex items-start gap-2 rounded-xl bg-card-soft px-3 py-2 text-xs text-ink-muted">
          <FiLock className="mt-0.5 size-4 shrink-0 text-pal" />
          <span>
            {t("在 agent 的視窗上找到配對碼(像")} <b>8F3K-2QP7</b>
            {t("),或直接貼上朋友給你的設定連結。")}
          </span>
        </p>
        <label className={labelCls}>
          {t("配對碼")}
          <input
            className={`${inputCls} text-center font-mono text-lg tracking-widest`}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="XXXX-XXXX"
            autoFocus
          />
        </label>
        {error && <p className={errorCls}>{t(error)}</p>}
        <button className={btn} disabled={busy || !code.trim()}>
          {busy ? t("連線中…") : t("連線")}
        </button>
      </form>

      <div className="text-xs text-ink-muted">
        <button className="underline underline-offset-2 hover:text-ink" onClick={() => setShowToken((v) => !v)}>
          {t("進階:改用 API token 連線")}
        </button>
        {showToken && (
          <form className="mt-2 flex flex-col gap-2 text-left" onSubmit={connectWithToken}>
            <input
              className={inputCls}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              type="password"
              placeholder={t("agent 視窗上的 API token")}
            />
            <button className={btnGhost} disabled={busy || !token.trim()}>
              {t("用 token 連線")}
            </button>
          </form>
        )}
      </div>

      {!sameOrigin && (
        <button className="text-xs text-ink-muted underline underline-offset-2 hover:text-ink" onClick={onBack}>
          {t("← 改用別的位址")}
        </button>
      )}
    </Screen>
  );
}

/** 從輸入抽出配對碼:若貼的是含 ?setup= 的連結就取出,否則原樣。 */
function extractCode(input: string): string {
  const trimmed = input.trim();
  const m = trimmed.match(/[?&]setup=([^&\s]+)/);
  return (m ? decodeURIComponent(m[1]) : trimmed).trim();
}

/** 配對成功後把 ?setup= 從網址列清掉,避免配對碼留在網址/歷史。 */
function clearSetupParam(): void {
  try {
    window.history.replaceState(null, "", window.location.pathname);
  } catch {
    /* 忽略 */
  }
}
