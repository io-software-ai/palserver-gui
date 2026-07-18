# palserver GUI

**简体中文** | [繁體中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

<p align="center"><a href="https://palserver-GUI.iosoftware.ai"><b>官方网站 palserver-GUI.iosoftware.ai</b></a> —— 下载、教程、常见问题</p>

**幻兽帕鲁(Palworld)专用服务器的图形化管理工具。**
在你的主机上运行一个 agent,然后用浏览器管理服务器 —— 开服、改设置、看玩家、备份存档、装模组,全都不用碰命令行。

手机、平板、另一台电脑都能连进来管理;朋友也可以用一条链接加入管理。

```
浏览器(React Web UI)
        │  HTTP / WebSocket(Bearer token)
        ▼
   agent(Node/TypeScript,Fastify)
        ├── native 后端(默认):直接在主机上启动 PalServer,不需要 Docker
        └── docker 后端(beta):把 PalServer 跑在容器里
```

---

## 界面预览

> 界面支持繁体中文 / 简体中文 / English / 日本語,六套主题(帕鲁原色 / 白银 / 极光翡翠 / 午夜紫 / 樱花粉 / 橘色猫猫)分别有深色 / 浅色可切换;截图中的玩家与数据为展示用途。

![玩家管理](docs/screenshots/players.png)

| 仪表板 | 世界设置 |
| --- | --- |
| ![仪表板](docs/screenshots/dashboard.png) | ![世界设置](docs/screenshots/settings.png) |
| **引擎微调** | **存档备份** |
| ![引擎微调](docs/screenshots/engine.png) | ![存档备份](docs/screenshots/saves.png) |
| **模组管理** | **实例总览** |
| ![模组管理](docs/screenshots/mods.png) | ![实例总览](docs/screenshots/overview.png) |

---

## 这份文档怎么看

| 你是… | 从这里开始 |
| --- | --- |
| **玩家 / 开服的人** —— 只想把服务器开起来 | [给玩家:五分钟开服](#给玩家五分钟开服) |
| **服务器管理员** —— 要长期运营、在意安全与自动化 | [给管理员:运营指南](#给管理员运营指南) |
| **开发者** —— 想改程序、送 PR | [给开发者:开发指南](#给开发者开发指南) |

遇到问题先看 **[常见问题 FAQ](https://faq.toc.icu/)**,或到 [Discord](https://discord.gg/sgMMdUZd3V) 问。

---

## 功能总览

**开服与管理**
- 创建多个服务器实例,各自独立的世界、端口号与设置;一键启动 / 停止 / 重启 / 删除(删除保留存档)
- 自动下载安装 Palworld 服务器文件(通过 DepotDownloader),显示**实时安装进度条**;也可以**直接接管现有安装目录**
- 游戏版本检查:比对已安装版本与 Steam 上的最新版,一键更新服务器
- 实时日志流(agent / 游戏 / PalDefender 三种来源可切换)
- 启动参数面板:Steam 查询端口(queryport)**可自行设置**(并检查与其他服务器不重复);`publiclobby` / `logformat` 等启动标志集成进设置
- **Docker 自定义容器镜像**:可沿用你已在用的其他帕鲁镜像;docker / k8s 后端不再被平台锁死(macOS/Windows 装了 Docker Desktop 也能用,k8s 一律可选)

**世界与性能设置**
- 80+ 项世界设置的图形化编辑器,按分类显示在不同标签页,含类型、范围与默认值;也可以直接编辑原始 `PalWorldSettings.ini`
- `Engine.ini` 性能微调(tick rate、网络速率、超时、GC 间隔、性能标志 `useperfthreads` / `NoAsyncLoadingThread` / `UseMultithreadForDS`、工作线程数…)附一键性能默认设置;玩家带宽上限可调至 1 Gbps,并实时换算为 Mbps
- 配置文件损坏时自动检测,并提供“重建干净配置文件”(损坏文件会先备份,不会直接删除)

**玩家管理**
- 在线玩家列表:等级、延迟、坐标、建筑数,点进去可看**他的帕鲁与背包**(需 PalDefender)
- 踢出、封锁、白名单 —— **离线玩家也能操作**(例如帮人解封)
- 历史玩家名册:agent 每 15 秒记录一次,留下游玩时数、上线次数、首次/最后上线;上下线时间轴
- 全服广播、立即存档

**地图**
- **内置完整世界地图**(帕鲁岛 + 樱岛 + Feybreak,高分辨率),不用再自备底图
- **在线玩家实时标记** + **离线玩家最后已知位置**;公会据点、**野外首领(Alpha 帕鲁)图层**、地标(快速旅行点 / 高塔 / 地城,名称随界面语言)
- **全屏地图**(`/map`),可从主界面一键打开新标签页
- **地图描点选坐标**:传送、生成等需要坐标的命令,直接点地图放图钉即可,不用手动输入坐标

**控制台**
- 完整的 RCON 控制台,命令支持搜索、分类与参数表单;危险命令需二次确认
- 需要玩家 ID 的参数会跳出玩家选择器(含离线玩家);道具 / 帕鲁 / 蛋的 ID 有图标搜索
- 装了 PalDefender 会自动把它的命令加进来
- 帕鲁 / 道具数据更新到 **Palworld 1.0(药师岛)**;主动技 / 词条多语(繁中 / 日文)

**存档迁移(内置,无需命令)**
- **导入存档**:“创建服务器”旁的按钮,可在创建新服务器时导入旧世界。支持三种来源:**其他专用服务器**、**本机联机存档**(四人邀请码)、**旧版 1.0 GUI**。粘贴文件夹路径 → 扫描 → 选择世界,导入前自动备份并设为当前世界
- **修复主机角色**(内置 palworld-host-save-fix):联机存档迁移到专用服务器后,主机玩家会被要求重建角色。“存档备份”标签页检测到联机主机角色文件后会提供一键迁移,无需安装 Python;支持新版 **PlM(Oodle)存档格式**,修复前强制自动备份
- 导入后新生成的角色文件会自动标记为“**导入后新增**”并预选,无需猜测哪个是主机玩家的新角色
- 完整迁移教程:[docs/MIGRATION.zh-CN.md](docs/MIGRATION.zh-CN.md)

**存档与备份**
- 定时自动备份:间隔、保留份数、没人在线时跳过
- 手动备份 / 恢复 / 下载;恢复前会自动备份当前世界
- 多世界管理:列出所有世界、切换“当前世界”、删除单个玩家存档;玩家角色文件列表实时刷新
- 存档迁移教程(从其他服务器、v1 或本机联机存档迁移):[docs/MIGRATION.zh-CN.md](docs/MIGRATION.zh-CN.md)

**模组**
- 一键安装 / 更新 / 移除 **PalDefender**(反外挂,前身 Palguard)与 **UE4SS**(Lua/蓝图模组加载器),各有稳定版与测试版通道
- PalDefender 设置面板、Lua 模组开关、pak 模组管理;**PalDefender REST API 端口可改**
- **MOTD 登录公告**做进设置 UI
- 文件管理器:浏览、上传、编辑、删除服务器目录下的文件

**稳定性**
- 自动重启:定时计划(固定间隔或每日指定时间)、内存超标、崩溃自动恢复(有每小时上限,避免无限重启循环)
- 重启前会先广播倒数并存档;手动停止不会被当成崩溃

**赞助者专属功能**(有效赞助者解锁)
- **帕鲁数值编辑器**(通过 PalSchema):修改物种基础数值 HP / 攻防 / 捕获率等,**首领版可单独调整**;一键安装 PalSchema、修改记录列表、一键恢复全部
- **传送玩家**:把玩家传送到另一位玩家身边,或传送到**地图描点的坐标**
- **批量给予道具**:物品图标菜单 + 数量,一次发多个
- **配种计算**:读取存档扫描的全服帕鲁,按目标物种与被动词条计算最短配种路线,树状图显示每一步的双亲个体、主人与位置(配方数据来自 MIT 许可的 Pal Calc)
- 自定义帕鲁 / 帕鲁蛋、公会据点详情、地标名称

**其他**
- 四种语言:繁体中文 / 简体中文 / English / 日本語;**六套主题**(帕鲁原色 / 白银 / 极光翡翠 / 午夜紫 / 樱花粉 / 橘色猫猫)× 深色 / 浅色,部分主题为赞助者专属
- 首页服务器卡片支持**拖动排序**;标签页可**自定义显示 / 隐藏**;总览卡片可关闭
- 连接诊断:检测公网 IP 及 NAT/CGNAT 状态,并提供 VPN(Tailscale / Radmin)开服教程
- GUI 自我更新(可选):从 GitHub Releases 检查新版本,验证 SHA256 后替换文件并重启

---

## 系统需求

| 项目 | 说明 |
| --- | --- |
| **操作系统** | **Windows 10+ 或 Linux(x86_64)**。macOS 可以跑 agent,但**跑不了 Palworld 服务器**(SteamCMD/PalServer 不支持),只能拿来开发或管理远程主机。 |
| **硬件** | 依 Palworld 官方需求;服务器文件本身数十 GB,首次安装要等一段时间 |
| **Node.js** | **不需要**(免安装可执行文件已内含)。从源代码跑才需要 Node 20+ 与 pnpm |
| **Docker** | 不需要。只有选用 docker 后端(beta)时才要 |

---

## 给玩家:五分钟开服

> 完整的图文教程(含邀请朋友、VPN 设置):**[官方网站](https://palserver-GUI.iosoftware.ai)** 与 **[常见问题](https://faq.toc.icu/)**

1. 到 [Releases](https://github.com/io-software-ai/palserver-gui/releases) 下载你系统对应的压缩包
   (`palserver-agent-windows.zip` / `-linux.zip`),解压缩。
2. 运行里面的 `palserver-agent`(Windows 是 `palserver-agent.exe`)。不用先装 Node 或 Docker。
3. 窗口会印出一段说明,照着打开 **`http://localhost:8250`** —— 本机管理**不需要密码**。
4. 点击“创建服务器”。第一次会下载 Palworld 服务器文件(**数十 GB,请耐心等待**),界面会显示实时进度条。
5. 装好后按「启动」就开服了。

**已经有旧世界?** 点击“创建服务器”旁的“**导入存档**”,将其他服务器、本机联机存档(四人邀请码)或 v1 GUI 的世界导入新服务器,详见[存档迁移教程](docs/MIGRATION.zh-CN.md)。

**邀请朋友一起管理:** 启动窗口里有一条 `?setup=XXXX-XXXX` 的链接,传给对方在他的浏览器打开就能连进来
(需要在同一个局域网或 VPN 内)。也可以请他打开你的 agent 地址后输入**配对码**。

**让朋友连进游戏:** 最简单的方式是 VPN(Tailscale 或 Radmin),GUI 的「连接」卡片会检测你的网络环境并给出对应教程。
如果你有公网 IP,也可以走传统的连接端口转发(UDP 8211)。

> **关于地图:** GUI 内置完整世界地图(帕鲁岛 / 樱岛 / Feybreak),不用自备底图 —— 打开「地图」标签页或 `/map` 全屏查看,就能看到在线玩家实时位置、离线玩家最后位置、公会据点与野外首领。

---

## 给管理员:运营指南

### 安全模型

agent 只有一道门:**本机(loopback)免验证,其他一律要 token。**

- **本机管理**(`127.0.0.1`)不需要任何凭证 —— 单机自用零摩擦。
- **其他设备**要么携带 API token(`Authorization: Bearer <token>`),要么用**配对码**换取 token。
  配对码是易读的 `XXXX-XXXX`(去掉了易混淆的字符),可随时重新生成,旧码与旧链接会立刻失效。
- token 保存在文件夹里(权限 `0600`),第一次启动时生成并显示在窗口中。
- 多人共用的主机请设 `PALSERVER_REQUIRE_TOKEN=1`,连 loopback 也要 token。
- **SteamID 全面屏蔽**:名册、日志、玩家选择器、命令输出等处一律显示中间码(可点击显示 / 复制);配对码与一键登录链接默认**马赛克屏蔽**,防止截图外流。

> agent 会直接操作主机上的文件与进程,**不要把 `:8250` 直接曝露在公网上**。要远程管理,请走 VPN(Tailscale/WireGuard)或放在反向代理后面并开 TLS。

### 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PALSERVER_DATA_DIR` | `~/.palserver-agent` | 所有状态的存放位置 |
| `PALSERVER_AGENT_PORT` | `8250` | 监听端口 |
| `PALSERVER_AGENT_HOST` | `0.0.0.0` | 绑定地址 |
| `PALSERVER_REQUIRE_TOKEN` | 未设 | `=1` 时连本机也要 token |
| `PALSERVER_TLS` | 未设 | `=1` 以 HTTPS 监听(自签凭证自动生成于 `<data-dir>/tls`,也可放自己的) |
| `PALSERVER_WEB_ORIGINS` | 空 | 允许跨源连接的网站来源(逗号分隔),给独立部署的公开 web 站用 |
| `PALSERVER_AUTO_UPDATE` | 未设 | `=0` 完全禁用 GUI 自我更新(连检查都不做) |
| `PALSERVER_TELEMETRY` | 未设 | `=0` 强制禁用匿名使用统计 |
| `PALSERVER_STATS_URL` | 官方统计端点 | 改成自架的统计后端 |
| `PALSERVER_GITHUB_REPO` | `io-software-ai/palserver-gui` | 自我更新要看哪个 repo 的 Releases |
| `PALSERVER_IMAGE_VANILLA` | `palserver/vanilla:latest` | docker 后端用的映像 |

### 数据放在哪

```
~/.palserver-agent/
├── token                 API token(0600)
├── pair-code             配对码(0600)
├── instances.json        所有实例的设置(设置的唯一真相来源)
├── tools/                缓存的 DepotDownloader
├── tls/                  自签凭证(PALSERVER_TLS=1 时)
└── instances/<id>/
    ├── server/           agent 自己安装的服务器文件(接管现有安装时不会有)
    ├── server.pid        游戏进程 pid
    ├── server.log        agent 抓到的服务器输出
    └── backups/          tar.gz 备份
```

服务器进程是 **detached** 生成的,agent 重启(或自我更新)**不会**把游戏服务器一起关掉;pid 档让 agent 重新接上。

### 部署方式

**免安装可执行文件(推荐)** —— 就是玩家那条路,适合绝大多数人。

**用 Docker 跑 agent 本身**(Linux 主机):

```sh
docker compose up -d          # 见 docker-compose.yml
```

需要挂载 `docker.sock`,而且 host 上的文件夹路径要与容器内一致(实例目录会被 bind-mount 进游戏容器)。

**纯 Web 站点 + 远程 agent** —— Release 里的 `palserver-web.zip` 是可独立部署的前端;将网站地址添加到 agent 的
`PALSERVER_WEB_ORIGINS`,玩家就能从公开站台连回自己家里的 agent。

**从源代码** —— 见下方[开发指南](#给开发者开发指南);`pnpm release:exe` 可以自己产出免安装可执行文件。

### 自我更新

在「设置 → GUI 更新」。默认**只检查、不安装**(每 6 小时),查到新版会显示更新卡片,点击后才开始更新:
下载对应平台的 `.tar.gz` → **比对 `SHA256SUMS.txt`** → 换掉可执行文件与前端 → 重启自己。也可以打开「自动安装」。

安全设计:没有校验档就拒绝更新;非免安装可执行文件(例如开发模式)拒绝自我更新;有服务器正在安装文件时拒绝更新
(下载器是 agent 的子进程,重启会中断它);换档失败会把旧可执行文件搬回去。

### 隐私与匿名统计

GUI 会回报**匿名**的使用计数(安装数、服务器创建/启动数、不重复玩家数),用来了解使用规模。
不含个人信息、IP、服务器名称或存档内容;玩家识别码只发送单向哈希。
可在「设置」关闭,或 `PALSERVER_TELEMETRY=0` 强制禁用。完整说明:**[PRIVACY.md](PRIVACY.md)**。

---

## 给开发者:开发指南

### 架构

前端**永远不直接碰**游戏的 REST API、RCON 或 PalDefender 的 API —— 那些凭证只留在 agent 里,浏览器只跟 agent 说话。

| 套件 | 内容 |
| --- | --- |
| `packages/agent` | Fastify daemon:REST + WebSocket API、进程管理、RCON、备份、模组安装、自我更新 |
| `packages/web` | React 18 + Vite + Tailwind 4 的 Web UI |
| `packages/shared` | 共用的 zod schema 与 API 类型(世界设置、实例契约) |
| `packages/stats` | Cloudflare Worker + D1,匿名统计收集端 |
| `images/vanilla` | docker 后端用的 Linux PalServer 映像(内含 DepotDownloader) |
| `images/dev-stub` | 假的 PalServer,给 Apple Silicon 开发用 |
| `deperated/` | v1 的 Electron 版,只留作 UX/i18n 参考,不属于这个 workspace |

### 开始开发

需要 Node 20+ 与 pnpm 11。

```sh
pnpm install
pnpm build

pnpm dev:agent    # 终端机 1 — agent(第一次会印出 API token)
pnpm dev:web      # 终端机 2 — Web UI on http://localhost:5173
```

agent 默认监听 `:8250`。当 `packages/web/dist` 存在时,agent 会自己 serve 前端(合一版)。

| 命令 | 用途 |
| --- | --- |
| `pnpm typecheck` | 全 workspace 类型检查(CI 会跑) |
| `pnpm build` | 构建全部项目 |
| `pnpm bundle:agent` | esbuild 打包成单一 CJS |
| `pnpm release:exe` | 产出当前平台的免安装可执行文件到 `release/` |

### 世界设置是 schema 驱动的

`packages/shared/src/options.ts` 是**唯一的真相来源**:每个选项的类型、默认值、范围与分类都在那里
(依[官方文档](https://docs.palworldgame.com/)校对)。zod schema、agent 的 ini 串行化、前端的设置编辑器全部由它衍生 ——
**在那里加一个选项,整条路就通了**。中文标签在 `packages/web/src/labels.ts`。

`Engine.ini` 与 PalDefender 的 `Config.json` 也是同样做法,而且**写入时采用合并策略**:GUI 不管理的区段、键与注释都会原样保留。

### i18n

代码中的字符串统一使用**繁中原文**,`t("中文")` 以原文作为键查询字典。
`packages/web/public/i18n/{zh-CN,en,ja}.json` 是“繁中 → 译文”对照表;找不到译文时显示繁中原文,因此**漏翻不会破坏页面**。
简中字典始终读取同源的人工校对文件;英文和日文字典会在后台从 GitHub raw 获取最新版本。

### 在 Apple Silicon 上开发

真实服务器在 Rosetta 下无法运行(SteamCMD 是 32-bit;PalServer 保存存档时会 segfault)。UI/agent 开发请使用模拟服务器:

```sh
docker build -t palserver/dev-stub:latest images/dev-stub
PALSERVER_IMAGE_VANILLA=palserver/dev-stub:latest pnpm dev:agent
```

真服务器的验证需要一台 x86_64 的 Windows 或 Linux。

### 发版

推一个 `v*` tag,[release workflow](.github/workflows/release.yml) 会在三种 OS 上各自产出:

- `palserver-agent-<os>.zip` —— 给人手动下载
- `palserver-agent-<os>.tar.gz` —— 给自我更新用
- `palserver-web.zip` —— 可独立部署的前端
- `SHA256SUMS.txt` —— 自我更新一定会验证它

---

## 当前状态

**v2 目前版本为 v2.1.0**,已可直接到 [Releases](https://github.com/io-software-ai/palserver-gui/releases) 下载使用,
上面列的功能都已经上线。

尚未完成:多主机聚合管理;Docker 后端仍标示 beta(`images/modded` 尚未提供);PalDefender 的帕鲁导入规则等高级功能。

## 授权与链接

**[PolyForm Noncommercial 1.0.0](LICENSE.md)** —— 源代码公开,个人与非商业用途可自由使用、
修改与分发;**禁止任何商业/盈利用途**(销售本软件、或将其集成进付费服务等)。
如需商业授权,请联系 <contact@iosoftware.ai>。

> *License: source-available under PolyForm Noncommercial 1.0.0 — free for personal and
> noncommercial use; **commercial use is not permitted**. Contact us for commercial licensing.*

- **官方网站:** <https://palserver-GUI.iosoftware.ai>
- **常见问题:** <https://faq.toc.icu/>
- **Discord:** <https://discord.gg/sgMMdUZd3V>
- **存档迁移:** [docs/MIGRATION.zh-CN.md](docs/MIGRATION.zh-CN.md)
- **隐私权政策:** [PRIVACY.md](PRIVACY.md)
- **v1(已停止维护):** <https://github.com/Dalufishe/palserver-GUI>

由 [Dalufish](https://github.com/Dalufishe) 与核心团队用爱制作。
