# 部署：到底怎么配才能直接起来

写于 2026-10-23。这篇回答一个具体问题：「我怎么配置可以直接弄起来」。`04` 排了候选、`08`
设计了 ssh `-R` 的强配置 —— 但没有一篇给出一份能照着抄的清单。这篇给。

结论先行：**推荐 一台自有 VPS + ssh `-R` + socat 裸转发，Mac 终结 TLS**，并且这条路
**不需要改那台 VPS 的 sshd 任何一行**。理由见第 3 节，它比听起来更要紧。

> **本次公开导入已删除第 1、2、6 节。** 它们是对具体主机的侦察记录（候选 VPS 的端口占用、
> 现网 WireGuard 的地址与防火墙规则、以及受管设备的载荷读数），属于私有基础设施信息，
> 不适合进公开仓库。保留下来的第 3–5 节不依赖那些内容。小节编号沿用原文，没有重排。

## 3. 为什么不用改 sshd —— 这一条值得单独说

`08` 记过一个坑：`GatewayPorts no` 面对客户端请求的非回环绑定地址是**忽略**而不是拒绝，所以
`ExitOnForwardFailure` 抓不到，隧道会「成功」地绑在回环上。很多人到这里就去改 sshd。

不用。我们**本来就只要绑回环**：

- `ssh -R 127.0.0.1:18443:…` 绑 VPS 回环 —— `GatewayPorts no` 下合法，这正是它允许的。
- 公网那一侧交给 **socat**，一个普通用户态监听，**不受 sshd 管辖**。

于是那个静默降级的坑**根本不会触发**，因为我们顺着它走而不是跟它对抗。沿途**零配置改动**：
不改 sshd、不改 firewalld 规则、不装任何软件（socat 1.7.4.1 已在，**已核实**）。

安全上这也更好：`-R` 的监听面始终在回环，暴露给公网的是一个只会做裸 TCP 转发的 socat，它
**不解析 TLS、不解析 HTTP**，所以 T1 成立 —— 浏览器所校验证书的私钥只存在于 Mac 上。

## 4. 清单

### 4.1 VPS 侧（两个文件）

```ini
# /etc/systemd/system/relay-443.service
[Unit]
Description=raw TCP republisher for the codex relay (data plane)
After=network-online.target
[Service]
ExecStart=/usr/bin/socat TCP-LISTEN:443,fork,reuseaddr TCP:127.0.0.1:18443
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/relay-80.service
[Unit]
Description=raw TCP republisher for the codex relay (ACME http-01)
After=network-online.target
[Service]
ExecStart=/usr/bin/socat TCP-LISTEN:80,fork,reuseaddr TCP:127.0.0.1:18080
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now relay-443 relay-80
```

`fork` 是必须的（否则只服务一个连接），`reuseaddr` 让重启不被 TIME_WAIT 卡住。80/443 是特权
端口，服务以 root 跑；如果要收紧，给 socat `CAP_NET_BIND_SERVICE` 并降权是**未核实**的下一步。

### 4.2 Mac 侧（隧道）

`ssh` provider 已经实现了这段（`src/relay/providers/ssh.mjs`，46 个测试）。等价的手动命令：

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -R 127.0.0.1:18443:127.0.0.1:8443 \
    -R 127.0.0.1:18080:127.0.0.1:8080 \
    <relay-vps>
```

保活很要紧：VPS 侧 `clientaliveinterval 120` / `clientalivecountmax 3`（**已核实**），所以服务端
最长约 6 分钟才察觉断线。客户端 30 秒探活 + 自动重连才能让端名在网络抖动后及时回收 —— 这正是
中继把「端名可以被它自己收回」列成要求的原因，ssh `-R` 这条也一样需要它。

### 4.3 证书：私钥必须在 Mac 上

这是 T1 和 WebAuthn 的共同要求，不是偏好。两个分支，**取决于域名情况**：

- **只能手动加 A 记录** → 隧道内 **HTTP-01**。80 口已转到 Mac 的 `:8080`，ACME 验证请求会穿
  隧道回来，私钥从不离开 Mac，**不需要任何 DNS 凭据**。推荐这条。
- **DNS 商有 API** → **DNS-01**。连 80 口都不用开，还能签通配符。token 按 `env:` / `file:`
  引用传，不落盘明文。

硬约束：**WebAuthn 的 RP ID 必须是域名，IP 地址不是合法 RP ID**。所以 passkey 这条路绕不开域名。
用自签证书 + 手机装信任描述文件可以先验证数据面，但那不是最终形态。

加固项，**未核实**，上线前确认：RFC 8657 的 `accounturi` CAA 钉死签发账户，需要确认所选 CA 支持。

### 4.4 surface 自己的环境变量

这一节原本整篇都没有，而它是「照着抄」里最该有的一段：**surface 有三个变量不给就起不来**，
其中两个就是域名。换句话说，域名这个卡点不是流程上的客气，是代码里的硬失败。

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `CODEX_RELAY_RP_ID` | **是** | — | WebAuthn RP ID。**必须是域名**：`localhost` 可以，IP 不行 |
| `CODEX_RELAY_RP_ORIGIN` | **是** | — | 浏览器实际访问的 origin，须与 RP ID 相容 |
| `CODEX_RELAY_UPSTREAM` | **是** | — | app-server slot：`ws://127.0.0.1:8899`，或 `unix:/path.sock[:/ws]` |
| `CODEX_RELAY_STATIC` | 否 | **无** | **不设就什么都不伺服**，`/` 直接 404。要设成 `<repo>/web` |
| `CODEX_RELAY_PORT` | 否 | 8787 | 这台 Mac 上 8787 已被一个 Python 进程占用（**已核实**），所以脚本问内核要空口而不是写死 |
| `CODEX_RELAY_HOST` | 否 | 127.0.0.1 | 隧道方案下保持回环即可，公网那一跳由 4.1/4.2 负责 |
| `CODEX_RELAY_STATE` | 否 | `./state` | 凭据与挑战的落盘位置 |
| `CODEX_RELAY_KEY_FILE` | 否 | — | 设了就用文件存会话密钥；**macOS 不设则用 Keychain**，Linux 上不设会直接报错 |
| `CODEX_RELAY_RP_NAME` | 否 | `Codex Relay` | 认证器里显示的名字 |
| `CODEX_RELAY_LOG_LEVEL` | 否 | `info` | |

两个容易踩的默认值：`CODEX_RELAY_STATIC` 不设则 `/` 什么都没有 —— 服务起来了、页面是 404；
密钥存储在 macOS 上默认进 Keychain，这对常驻部署是对的，对一次性试跑是脏的，所以试跑要显式
给 `CODEX_RELAY_KEY_FILE`。

### 4.5 本机一条命令全跑通（已核实）

`04`/`08`/`10`/本篇前面几节讲的都是公网那一跳，而**整条链路不需要公网也能跑**，而且这件事
现在已经在这台 Mac 上跑过了：

```sh
tools/bring-up/local.sh --check     # 两段都验，跑完退出
tools/bring-up/local.sh             # 起着不动，打印 URL 等你开浏览器
```

它做的事就是把 `03` 第 3 节那份隔离配方和 surface 的 4.4 接起来：

```
浏览器 ──http──▶ surface ──ws──▶ claude-codex adapter ──▶ MockRuntime
localhost:PORT    本仓库           app-server --listen      不碰 Claude Code、不耗额度
```

`localhost` 不是图省事：它是浏览器唯一在没有证书时也当安全上下文的主机名，也是**没有域名
时唯一合法的 RP ID**。IP 不是可注册域名，所以 `http://127.0.0.1` 根本承载不了通行密钥 ——
这一条是浏览器拒绝，不是我们拒绝。

2026-10-23 在这台 Mac 上的实测结果（**已核实**）：

- app-server slot：`initialize → thread/start → turn/start → item/* → turn/completed`
  整轮走通，用的是仓库里已有的 `tools/probe/appserver-slice.mjs`。
- surface：10 个浏览器真的会去取的路径全部 200（含 `/hostlink/link.mjs` 与
  `/src/appserver/*`），5 个越界路径全部 404（`/src/surface/server.mjs`、`/src/`、
  `/package.json`、`/../package.json`、`/.git/config`）。
- 跑完不留东西：两个进程都收了，scratch 目录删了，生产 adapter 一个没碰。

**最后一公里 2026-10-23 打通了，而且是自动化的**（见 4.7）。这一段原本写着「需要人站在平台
认证器前面，自动化到不了」—— 那句话对的是人的手指，不是这套仪式本身。

### 4.6 首台设备怎么进来

一个还没注册任何通行密钥的 relay 什么都做不了，而注册需要一个 bootstrap token —— 这个
token 只有 surface 进程自己能发：它存在 `EphemeralStore` 里，也就是这个进程的内存里，旁边
再跑一个 CLI 也放不进去。`issueBootstrapToken()` 的注释从写下来那天就说「bootstrap CLI 把它
渲染成二维码」，而那个 CLI 不可能工作 —— 这是一个一直空着的洞，现在补了：

- **首次启动**（状态目录里还没有凭据时）surface 往 stderr 打一行注册链接：
  `<origin>/#enroll=<token>`。页面从 URL fragment 里取走它，并把它从地址栏擦掉。
- **链接过期或没抄到**：`kill -USR1 <pid>` 现发一个新的，不用重启。授权边界就是「谁能给这个
  进程发信号」，和「谁能读这个终端」是同一个边界 —— 而一个能发注册令牌的 HTTP 端点会是
  「任何人都能往你的 relay 上注册一把通行密钥」。
- 单次使用，10 分钟过期。它会落到 stderr 去的任何地方（systemd 下就是 journal），这一点骗不了
  人；真正约束它的是那两条，不是「打在 stderr 上所以安全」。

`tools/bring-up/local.sh` 直接把链接打出来给你，`--check` 则只断言「这行打出来了」而不回显
token。

### 4.7 最后一公里：已经自动化了（已核实）

`tools/bring-up/last-mile.mjs`：拉起一个**自己的** headless Chrome（一次性 profile、内核分配
的空端口），挂一个 WebAuthn **虚拟认证器**，然后注册 passkey、登录、发一个 turn、读回答案。

虚拟认证器**不是打桩**。凭据、CBOR、ES256 签名、以及我们这边的验签全都是真的，被模拟的只有
「拇指按在传感器上」这一下。所以这条命令证的就是整条链：

```
tools/bring-up/local.sh --check --last-mile          # 快，MockRuntime
tools/bring-up/local.sh --check --last-mile --real   # 慢，真 Claude Code
```

2026-10-23 在这台 Mac 上的实测（**已核实**）：`--real` 跑完，浏览器里问 `19*23`，回来 `437`。

两个细节值得记一笔：

- **只驱动自己起的浏览器。** 脚本先 `Browser.getBrowserCommandLine`，要求命令行里有自己那个
  一次性 `--user-data-dir`，否则直接挂断。这不是洁癖：一个 DevTools 端口号本身**不说明是谁
  的浏览器应答**，而这台 Mac 上就有开着远程调试的日常 Chrome（见 4.9）。顺带一提，这个检查
  必须配 `--enable-automation` 才答得上来，于是它反而更严了 —— 一个正在被人用的浏览器连答都
  答不上。
- **`--real` 需要 `CLAUDE_CODEX_CLI`。** Agent SDK 在这台机器上找不到 darwin-arm64 的原生
  二进制，而 `claude` 是个 shell alias，子进程看不见。脚本按绝对路径找，找不到就明确报错。

### 4.8 手机上验过了，以及它证明了什么、没证明什么（已核实）

Android 15 模拟器 + `adb reverse tcp:8891 tcp:8891`，手机 Chrome 打开 `http://localhost:8891`
—— `localhost` 在 Chrome 里**不论协议都是安全上下文**，所以这条路**不需要域名也不需要证书**
就能把整个数据面放到真手机浏览器里跑。

结果：手机屏幕上 `live` / `turn completed` / token 计数 / thread id 齐全，Claude 的回答渲染
在真手机上。**但通行密钥不是在手机上注册的**，原因要说清楚：

这台模拟器**没有登录 Google 账号**，而 Google Password Manager 是它唯一的凭据提供方，所以
`navigator.credentials.create()` 在 Android 的 Credential Manager 里就失败了，根本没走到
relay。报错原文：`An unknown error occurred while talking to the credential manager`。补一个
锁屏 PIN 也没用 —— 试过了，一样的错，缺的是账号不是锁屏。

所以手机这一程的准确说法是：**浏览器到 Claude 之间的每一段都在手机上证过了，认证器那一段是在
Mac 上证的**。真机有锁屏有账号，自己就能做这套仪式，relay 这边一行都不用改。

### 4.9 DDNS 放在哪一格

DDNS 解决的是「我的 IP 会变」，**不解决「我在 NAT 后面」**。所以：

- **手机和 Mac 同一个局域网** → DDNS 有用。把一个真域名的 A 记录指到 Mac 的内网地址，再用
  **DNS-01** 签证书（HTTP-01 不行，外面进不来），就拿到了 4.3 要求的「私钥在 Mac 上」+ 一个
  合法的 RP ID。这是目前**最省事的一条真域名路径**。
- **手机在蜂窝网** → DDNS 没用，Mac 没有可达的公网地址。这正是 `05`/`11`/`06` 三个 relay
  实现存在的理由：出站隧道，不需要入站可达性。

换句话说 DDNS 不是第 5 节那个「域名」决定的替代品，它是那个决定**落地后**省掉手工改 A 记录
的那一步。仍然需要你定：用哪个域名、DNS 商是谁（决定 DNS-01 怎么签）。

脚本里有三处是刻意的拒绝，不是保守：adapter 路径指向 bundle 的
`Contents/Resources/codex` 时直接退出（它会回落到生产 runtime.env）、`CLAUDE_CODEX_SOCKET_PATH`
显式 unset（否则连到正在跑的生产 adapter）、`CODEX_HOME` / `CLAUDE_CODEX_HOME` 各自独立
（adapter 每次启动都跑 `recoverStaleInProgressTurns()`，共享 store 就会把生产里
`inProgress` 的轮次标成 `interrupted` —— 2026-10-19 真的因此断了三个线程）。

## 5. 需要你定的两件事

> 2026-10-23：这两件仍然成立，但**不再卡住验证**了 —— 4.7 和 4.8 已经把端到端跑通，用的是
> `localhost`，不需要域名。域名卡的是「从别的网络访问」，不是「能不能跑」。

1. **域名。** 第 4.3 节两个分支取决于它，第 4.4 节说明它是代码里的硬失败，WebAuthn 绕不开。
2. **VPS 侧谁动手。** 第 4.1 节会在你的机器上绑公网 80/443，是对外可见的改动。

这两件之外**已经没有代码缺口了**。上一版这里写着 `AppServerClient` 接线是「清单上唯一的
代码缺口」，那一段已经并了（`src/hostlink/` → `web/hostlink/`），而 app-server slot 一直都不
需要我们写 —— `03` 第 3 节的 `app-server --listen` 就是它。所以顺序是：先按 4.5 在本机把
通行密钥和一个 turn 跑通，再回来接公网。先端到端、后公网，本来就是更稳的顺序。
