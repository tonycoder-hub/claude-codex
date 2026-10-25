# 重新定向：接缝换到 app-server，并先打通端到端

写于 2026-10-22。起因：前九个提交里有四个花在绕开一个本可以不碰的私有接缝上，
而始终没有一条端到端跑通的链路。这份文档换掉接缝，给出**已实测**的协议切片，
并把保真这件事收敛成一个可测的数字。

## 1. 目标（端到端表述）

一个人在手机浏览器里打开一个网址，用通行密钥登录，然后和常驻 Mac 上的 Claude Code
对话——发指令、看流式输出、批准工具调用、切换线程。

四段，每段有明确判据：

| 段 | 判据 | 状态 |
|---|---|---|
| 入口 | 手机在异网能连上常驻 Mac，TLS 不终结在第三方 | 见 `04-ingress.md` |
| 身份 | 通行密钥完成注册与登录，签出带签名的会话 | **已完成**（`src/auth/*`，68 测试） |
| 协议 | 客户端能发起一轮对话并收到流式 item/turn 事件 | **已实测打通**（见第 3 节） |
| 执行 | 这一轮真的跑在常驻 Mac 的 Claude Code 上 | **已实测打通**（见第 3 节） |

## 2. 为什么偏了

前一版把问题读成「如何复用 Codex App 的 renderer 以获得像素级保真」，于是接缝选在
**最深、最私有的那一层**：Electron 主进程与 renderer 之间的 capnweb 桥。接缝定在那里，
后面一长串成本就都是被迫的——反汇编 fuses、找不破坏 asar 完整性的注入点、
证明自建窗口会被静默忽略、为每客户端铸 MessageChannel 端口、为 CDP 的 lossy
序列化写结构化克隆编解码器、克隆隔离 lab 实例。

这些结论都是实测出来的、都对。问题是它们服务的是一个**可以绕开的**接缝。

## 3. 真正的接缝：app-server（已实测）

Codex App 自己不执行对话。它启动 `CODEX_CLI_PATH app-server` 子进程，用
**JSON-RPC 2.0（换行分隔）** 和它说话。本机上这个子进程就是
`claude-codex-adapter`，协议面方法数先前记为 **139**，但主 `switch` 实测只分发
**109 个唯一方法（104 个带命名空间）**（见 6.5，差额未核对），并且已经支持
`--listen stdio:// | unix:// | ws://host:port` 三种传输、多 peer；生产环境本来就是
unix socket 常驻守护进程。**「常驻机器执行」这个需求，现有架构已经解决了。**

### 实测结果

`tools/probe/appserver-slice.mjs` 用一个**纯 WebSocket 客户端**（Node 内置
`WebSocket`，无依赖，在 App 之外）走通了完整一轮：

```
initialize → thread/start → turn/start → item/started → item/*/delta → item/completed → turn/completed
```

两次运行，同一个隔离实例：

| 运行 | runtime | 耗时 | 流式 delta | 结果 |
|---|---|---|---|---|
| mock | `CLAUDE_CODEX_MOCK=1` | 255 ms | `item/agentMessage/delta` ×67 | `turn/completed` |
| 真实 | `agent-sdk-sidecar`，模型 `cc-opus-5-5` | 5,393 ms | ×1 | `turn/completed`，24,036 tokens，正确答案 |

握手与载荷的实际形状（已核实，不要再推测）：

- `initialize` ← `{clientInfo:{name,version}, capabilities:{}}`
  → `{userAgent, codexHome, platformFamily, platformOs}`；
  握手后适配器会主动推 `account/updated` 和 `mcpServer/startupStatus/updated`。
- `thread/start` ← `{model?, cwd?}` → `{thread:{id,…}, model, cwd, approvalPolicy,
  sandbox, permissionProfile, permissions, reasoningEffort, …}`，并推 `thread/started`。
- `turn/start` ← `{threadId, input:[{type:'text',text}], cwd?, model?, effort?}`
  → `{turn:{id,status:'inProgress',…}}`。`input` 项的类型是
  `text | mention | localImage | image | skill`。
- 服务端会**反向发起请求**（带 `id`，等回复）来要审批：
  `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、
  `item/tool/requestUserInput`。不回复就会把整轮挂住——客户端必须实现这条反向通道。
- 另有 `thread/status/changed`、`thread/tokenUsage/updated` 两条常驻通知。

### 复现配方（含必须的隔离）

适配器**每次启动**都会执行 `store.recoverStaleInProgressTurns()`，`ws://` 模式也一样。
所以实验实例必须有自己的 store，否则它会把生产里所有 `inProgress` 的轮次标成
`interrupted`——2026-10-19 真的因此中断了三个在跑的线程。

隔离链路（读 `util.mjs` 得到）：
`CODEX_HOME` → `codexHome()`；`CLAUDE_CODEX_HOME` → `adapterHome()`；
`SessionStore` 默认落在 `adapterHome()/state.sqlite`。**设 `CLAUDE_CODEX_HOME` 即可隔离
store、debug log 和默认 socket 路径。**

```sh
SLICE=/path/to/scratch
set -a; . ~/.codex-cc/claude-codex/runtime.env; set +a   # 取 model profile 等配置
unset CLAUDE_CODEX_SOCKET_PATH                           # 关键：别连生产 socket
export CODEX_HOME="$SLICE/codex-home"
export CLAUDE_CODEX_HOME="$SLICE/adapter-home"           # 关键：隔离 store
export CLAUDE_CODEX_DEBUG_LOG="$SLICE/debug.jsonl"
node ~/.codex-cc/claude-codex/runtime/dist/src/adapter.mjs \
  app-server --listen ws://127.0.0.1:8899
```

`CLAUDE_CODEX_MOCK=1` 走 `MockRuntime`，不碰 Claude Code、不耗额度——先用它验协议形状，
再去掉它验执行。store 用 Node 内置 `node:sqlite`，没有 native 模块，系统 node 直接能跑。

**绝不直接执行 bundle 里的 `Contents/Resources/codex`**：它会回落到生产 runtime.env，
启动一个针对生产存储的 app-server。

## 4. 架构

```
手机浏览器 ──HTTPS+WSS──▶ surface（Node）──JSON-RPC 2.0──▶ claude-codex-adapter ──▶ Claude Code
                            · 通行密钥 → 签名会话（已建成）
                            · 伺服前端资源
                            · 逐帧原样转发，不做翻译
```

**浏览器自己就是一个 app-server 客户端**，surface 只是一个带鉴权的中继。这是整条链路
最省事的契约：没有协议翻译层，没有 Electron、CDP、asar、克隆实例。

## 5. 前一版里还能用的东西

| 资产 | 判断 |
|---|---|
| `src/auth/*` + 68 测试（CBOR/COSE/WebAuthn、凭证库、密钥环、签名会话、两个 ceremony） | **全部可用**，与接缝无关 |
| `src/tunnel/frames.mjs` 序号与断口检测 | **可用**，WSS 重连仍需要（但不再「断口即销毁窗口」） |
| `src/tunnel/codec.mjs` 结构化克隆编解码 | **不再承重**。它存在的理由是 CDP 的 lossy 序列化；JSON-RPC 本来就是 JSON |
| `src/cdp/client.mjs`、`tools/probe/*`、`tools/instance/*` | **降级为知识**，但若最终走路线 A 则重新承重 |
| `docs/01-bundle-facts.md`、`docs/02-fork-mechanism.md` | **保留**。要用真 renderer 字节时它们是唯一事实来源 |

## 6. 保真这件事，收敛成一个数字——而这个数字是 0

端点是接近保真，所以路线之争只剩一个量化问题：**复用真 renderer 字节要付多少。**

答案：**capnweb 的 129 个 service，一个都不用实现。** 对话路径根本不经过 capnweb。

### 6.1 已核实的事实

- **renderer 自己持有 JSON-RPC 客户端。** `app-shared.js` 里的
  `AppServerRequestClient` 在 renderer 侧，自己铸请求 id、自己维护 promise 表
  （`requestPromises` / `inFlightRequests` / `queuedRequests`）、自己算 priority 与
  timeout，连 `thread/resume` 的指数退避都在 renderer 里
  （`timeoutMs: n.timeoutMs ?? 12e4 * 2 ** o`）。
- **对话流量走的是 legacy postMessage 总线**，消息类型
  `mcp-request` / `mcp-response` / `mcp-notification` / `mcp-request-delivery`，
  出口是 `codex_desktop:message-from-view`，入口是 `codex_desktop:message-for-view`
  被 preload 重新派发成 DOM `MessageEvent`。**与 capnweb 无关。**
- **主进程只补封装再转发。** main 直接消费 renderer 交来的 `t.request`
  （已带 `.id` / `.method` / `.trace`），调
  `handleClientRequest(…, {coalesce, priority, source, timeoutMs, expiresAtMs, widget},
  t.retainResponse, …)`；失败时回 `{id, error:{code:-32000, …}}`。
- **renderer 全量语料（asar 中 14,531 个 chunk）里：** `jsonrpc` 字面量在
  app-server 路径上 0 次命中，`CODEX_APP_SERVER_WS_URL` 0 次，
  `getLocalWebsocketUrl` 0 次。renderer 既不写 JSON-RPC 封装，也拿不到一条 WS URL
  ——但它不需要，因为它本来就在总线上说这套协议。
  （`main.js` 的 `E5()`/`getLocalWebsocketUrl` 是主进程侧为自己那条连接选传输，
  这个判断经对抗性复核仍然成立。）
- **空的 `services` 对象就能启动 renderer。** `app-shared.js`：

  ```js
  function lei(e){let{port1:t,port2:n}=new MessageChannel;
    return window.postMessage({type:`connect-app-host`,port:n},window.location.origin,[n]),vVt(t,e)}
  async function dei(){r6=lei(sei),i6=await r6.services,
    i6.threadReadState!=null&&await sei.threadReadState.initialize(i6.threadReadState),
    i6.statsig!=null&&await Fzt(i6.statsig),
    i6.clientCoordination!=null&&S6r(i6.clientCoordination),
    i6.terminal!=null&&rBt(i6.terminal),
    i6.devboxService}
  ```

  5 个成员全部 `!= null` 保护，最后一句是裸属性读——而且 `devboxService` 这个键在
  主进程的集合里**根本不存在**（主进程给的是 `devboxVncService`），所以那是一次
  死读。握手**必须**被应答，否则 boot 的 `await` 永久挂起；但应答内容可以是 `{}`。
- capnweb 一共 **129 个键**（125 个具名 + 两个展开各贡献 2 和 2）。按来源分类：
  30 个真·转发 app-server、68 个宿主/OS 能力、29 个主进程本地状态、
  2 个恒为 `void 0`。我此前"约十来个转发"是低估。
  **但这整片都不在对话路径上，所以这个数字不影响选路。**

### 6.2 剩下的两项义务，实测都不贵

- **浏览器侧 `electronBridge` shim：恰好 22 个成员。** 其中 4 个是模块求值期的
  同步取值（sentry init options、build flavor、shared-object 快照、theme variant），
  外加一个懒取的 `getInitialSidebarBootstrap`。浏览器里没有 `sendSync`，但 surface
  在伺服时就已经知道这四个值，页面加载前注入即可——**这件事在浏览器里比在
  Electron 里更容易，不是更难。** 其余多为可退化成空操作的宿主能力
  （拖拽、右键菜单、worker 消息、sentry 自测）。
- **分片协议 `codex-host-chunked-message-v1` 是发送侧可选的。** preload 不解包，
  解包发生在 renderer 的 `jre(t).receive(i)`；非分片消息直接穿过校验
  （只要求 `typeof e.type === 'string'`）。**中间层不分片，就不欠这一项**，
  `acknowledgeChunkedMessage` 可以是空操作。
- 另外一个意外的便宜处：`connect-app-host` 在 Electron 里要把 `MessagePort`
  转交主进程（`ipcRenderer.postMessage`）；在浏览器里**端口留在页面内**，
  就地回 `{}` 即可，连进程边界都不用跨。
- 容错余量：宿主消息的大 switch 有 **188 个 case 且没有 `default:`**——未处理的类型
  被静默忽略。中间层只需发它真正需要的那几种。

于是中间层的真实义务是：**1 次握手回 `{}` + 总线两个方向 + 约 6 种消息类型 +
生命周期三件事**（`codex-app-server-initialized` /
`codex-app-server-connection-changed` / `codex-app-server-fatal-error`）**+ 22 个
成员的 `electronBridge` shim。**

### 6.3 路线

- **C — 基于 app-server 方法做朴素 Web UI**。已验证可行（第 3 节），**先做**，
  它合上端到端四段。
- **B — 中间层 + 真 renderer 字节**。**保真阶段的主选项。** 不碰 Electron、
  不碰 CDP、不碰 asar 完整性、不碰真 App 进程。
- **A — CDP 注入真 App**。**不需要了。** 前一版那四个提交回到「知识」的位置，
  而不是「地基」。

B 仍存的未知项不再是协议面，而是：**这份 renderer 包能否在普通浏览器里跑起来**
（Vite 产物是否触达 Electron-only 全局 / `node:` 导入），以及触控交互。
这是实现问题，不是路线问题。

### 6.4 记录两次反转，以及值得留下的方法论

本文初稿倾向 B；2026-10-22 我基于「127 个 service 都要补」判定 B 比 A 贵、改推 A；
同日的对抗性复核把**决定成本的那半边**证伪，B 回到主选项。

值得留下的不是结论，而是那个错误的形状：**我先去数了那一层有多大，而没有先问
"这条路径真的经过那一层吗"。** 数出 127 是一次精确、可复现、但与决策无关的测量。
顺序反了，精度就不值钱。

### 6.5 数字校正

- capnweb：**129**（此前记 127），`new Fce({` 起始位置按字符偏移计。
- `electronBridge`：**22** 个成员（此前记 23）。
- 适配器的 server→client 请求 id 是 **UUID 字符串**，不是整数
  （`sendServerRequest` 用 `randomUUID()`）。客户端必须原样回传，且不要和自己的
  整数 id 空间混用。
- **没有通用 cancel**：协议里不存在 `$/cancelRequest`，只有 `turn/interrupt` 与
  `account/login/cancel`。所以客户端侧的 `AbortSignal` 只能是本地语义。
- 方法总数待澄清：`server.mjs` 的主 `switch` 只分发 **109 个唯一方法
  （104 个带命名空间）**，与此前记录的 139 有差额。两者可能分别统计了
  「可被调用的方法」与「含服务端主动发出的通知」，尚未核对，先记差额不下结论。

本节所有事实均来自只读文本分析：未执行 Codex 二进制、未启动 App、未附加调试器，
未触碰 `~/.codex-cc`、适配器守护进程及其 socket。

## 7. 顺序

1. **M1 协议打通** —— **已完成**，见第 3 节。
2. **M2 surface 进程** —— HTTP/WSS + 已有通行密钥门禁 + 原样转发到适配器；朴素 UI。合上「身份」。
3. **M3 ingress** —— 合上「入口」。见 `04-ingress.md`。
4. **M4 保真升级（路线 B）** —— 第 6 节已定稿：B，不走 A。拆成四步，依赖递增：
   1. **可跑性探针**：把 asar 里的 `/webview` 资源原样伺服到普通浏览器，
      只看它能不能加载到调用 `connect-app-host` 那一刻——这是 B 唯一剩下的真未知。
   2. **`electronBridge` shim**（22 个成员）+ 四个同步值在页面加载前注入。
   3. **握手应答 `{}`** + 总线两个方向（`mcp-request` / `mcp-response` /
      `mcp-notification` / `mcp-request-delivery`）+ 生命周期三件事。
   4. **触控适配**：桌面端交互在手机上的落地，范围待定。

## 8. 仍然成立的约束

- 不碰生产 `Codex cc.app`、`~/.codex-cc` 状态、在跑的适配器守护进程与其 socket。
- 绝不直接执行 bundle 的 `Contents/Resources/codex`（第 3 节已说明后果）。
- 私有内容不出本机，入口不能默认选在第三方终结 TLS 的方案上。
- Mac 不是构建机：代码在 `.21` 上编写与测试，只有需要本机服务的探针在 Mac 上执行。
- 密钥、令牌、会话标识不进输出、不落盘。
- bundle 是 minified 且用**反引号**字符串字面量：grep `` `thread/start` ``，不要 grep `"thread/start"`。

## 9. 外部参考（来自地狱焚诀 Agent 交流群，均为群内实测口径）

- app-server 是群里公认稳定的接入点，时间跨度几个月的多人独立反馈：
  「底层有没有基于 app-server 做？」「app-server 真的很丝滑顺畅稳定」（罗焜，07-23）；
  「codex 客户端，一样能连 app server」（贺鹏程，09-08）；
  「我不用反代，编排的 codex app server」（李久旸，09-15）。
- 同一个需求在群里活跃但没人做出来：「我来看看怎么打通我家里的 macmini 上的 codex」
  （高鹏洋，10-21 20:14）；「我准备找时间莲花一个 codex 手机端」（接彤宁，同时段）。
- `riba2534/herdrx` —— 群内项目，自带 p2p 内网穿透，M3 的现成参考。
- `amontlabs/lcu`（Shengtao，10-22 02:57）—— 把 Codex 的 computer-use 运行时从 App 里
  解耦，再用适配器层接到 Claude Code / Pi Agent / Codex CLI。
  和本文第 3 节是同一种姿势：**不要注入 App，去接它下面那条已经定义好的协议。**
