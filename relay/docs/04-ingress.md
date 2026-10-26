# 入口：手机在异网连上常驻 Mac，且 TLS 不终结在第三方

写于 2026-10-22，合上 `03-reframe.md` 第 7 节的 **M3**。这份文档只做一个决定，不做选项
综述：surface 进程只监听回环，手机在移动网络、两端都在 NAT 后面，怎么连进来。
凡引自厂商文档的说法在第 6 节给出出处；其余按 **已核实 / 假设 / 未核实** 标注，不混在一起。

## 1. 四条约束，写成可判定的测试

**T1 — TLS 不终结在第三方。** 浏览器那条 TLS 会话必须由本机上的进程终结，浏览器所校验
证书的私钥**不得存在于第三方机器上**。只转发它读不懂的密文的第三方算通过；持有或能推导
会话密钥的第三方算不通过。这是 brief 里「私有内容不出本机」收敛成的一个密钥保管问题。

**T2 — 手机上零信任提示。** 移动端 Safari / Chrome 首访即接受证书：不装配置描述文件、
不点「继续访问」、不侧载根证书。等价表述是证书链到设备信任库里已有的 CA，且 SAN 覆盖
地址栏里那个名字。自签名与 `mkcert` 按定义不过。另外 WebAuthn 要求 secure context，
所以 T2 不过不只是观感问题，是直接废掉 `src/auth/*` 那 68 个测试撑起来的整条身份段。

**T3 — 从运营商网络穿两端 NAT。** 两端都没有可入向的公网地址：Mac 在家用路由后面，
手机在运营商 NAT（常是 CGNAT，且常为对称型）后面。通过的条件是不做端口映射、不要
静态 IP 就能连通。**偏好而非判据**：打洞直连优于租用中继；满足 T1 的中继可作回退。

**T4 — 低运维负担。** Mac 重启后无人工干预自愈，家宽公网 IP 变化、局域网 IP 变化都不
影响，证书自动续期。需要人手动续的 90 天证书算不过；需要自己托管的自动续期算部分通过。

## 2. 候选逐项对照

| 候选（模式） | T1 密钥保管 | T2 浏览器信任 | T3 NAT | T4 运维 | 判定 |
|---|---|---|---|---|---|
| `riba2534/herdrx` — Tailcat 内网穿透 | 不适用（不是浏览器侧入口） | **不过** —— 默认 HTTP，README 写明 HTTPS 要「自己配反向代理」 | 过，但解决的是工作台→受控主机 | 过 | **层级不对** |
| `riba2534/herdrx` — 工作台挂自建反代 | 取决于你自己搭的那层 | 同左 | 同左 | 同左 | **把问题原样退回** |
| Tailscale **Serve** + 手机入 tailnet | **过** —— 证书私钥与 ACME 账户私钥在本机生成并保存，官方表述「Tailscale 永远看不到它们」 | **过** —— `<host>.<tailnet>.ts.net` 的 Let's Encrypt 证书 | **过**，且偏好满足：WireGuard 打洞直连，失败才回落 DERP，中继只见密文 | **过** —— `--bg` 重启自恢复；身份基于密钥而非 IP；守护进程自己续期 | **推荐** |
| Tailscale **Funnel** | **过** —— 官方表述「Funnel 中继服务器不解密……Tailscale 无法访问或读取任何内容」，TLS 在本机终结 | **过** —— 同一张 `ts.net` 证书 | 过，但**恒走中继**（浏览器不是 tailnet 成员，永远不可能直连） | 部分 —— 仅 443/8443/10000；带宽限额不可配；macOS 上只有开源 `tailscaled` 支持 | **回退** |
| Cloudflare Tunnel — 默认（代理主机名 + CF 边缘证书） | **不过** —— 边缘持私钥并看到明文 | 过 | 过 | 过 | **T1 否决** |
| Cloudflare Tunnel — Origin CA / Full (strict) | **不过** —— 只加固第二跳；官方写明 Origin CA 证书「只加密 Cloudflare 到源站的流量，不包括浏览器到源站」 | 过 | 过 | 过 | **T1 否决** |
| Cloudflare Spectrum，TCP 应用，`tls: off`（passthrough） | 过 —— L4 代理，载荷原样转发 | 过（证书你自己提供） | 过 | 不过 —— **Enterprise 专属**；且是纯租用中继，无直连 | **按成本/档位否决** |
| 自有域名 + Mac 上 DNS-01 ACME + VPS 只做 SNI 透传（`ssl_preread`），WireGuard 打到 VPS | **过** —— 私钥只在 Mac，VPS 不持任何密钥，按 SNI 选路 | **过** —— 自有名字的 Let's Encrypt 证书 | 过，但**恒走中继**（VPS 就是那个中继） | 部分 —— 续期、VPS 打补丁、keepalive 都归你 | **可行，留作逃生口** |
| 自签名 / `mkcert` / IP-SAN 证书，配任何传输 | 过 | **不过** —— 手机上要手动装信任 | — | — | **T2 否决** |

几格不显然的，说明如下。

**herdrx 解的是另一个问题。** 它的 Tailcat 是「工作台 → 受控主机」方向：在**远程 Linux
主机**（CLI 只有 x86_64 / ARM64）上装一个 CLI，把一次性绑定凭据粘回网页，让工作台能够到
它 SSH 不到的主机。它不给工作台自己提供浏览器可达的 HTTPS 前门——README 明确是「默认使用
HTTP，无需域名或证书」，要 HTTPS 就「自己配反向代理」并打开 `HERDRX_COOKIE_SECURE=true`。
它的中继选择甚至**反过来依赖**你已经解决了公网 HTTPS：先探工作台自带中继，「工作台具有
公网 HTTPS 且中继握手成功时优先使用，连不通则回退公共中继」。部署侧还要求 Linux + Docker，
macOS 一侧有已知缺口（issue #10：`terminalgeometry.ReadPID` 当时没有 darwin 实现）。
所以对本文这个问题它是层级不对——用了它，下面这些行里还得再选一个。（已核实：读 README
与 release notes。）

**Serve 与 Funnel 的差别是可达性，不是 TLS。** 两者都在本机终结 TLS，都用同一张
`<host>.<tailnet>.ts.net` 的 Let's Encrypt 证书，签发走 DNS-01：Tailscale 在 `ts.net` 区里
写 TXT 记录，而密钥对在本机生成。差别只在 Serve 是「仅 tailnet 内可达」，手机必须是
tailnet 成员；Funnel 是公网可达，由 Tailscale 的入口节点按 SNI 把连接代理到本机而不解密。

**Cloudflare Tunnel 没有任何一种模式能过 T1。** `cloudflared` 的主机名必须处于代理状态
隧道才会选路，而代理状态就意味着浏览器那条 TLS 在边缘结束。Origin CA、Authenticated
Origin Pulls、Full (strict) 讲的都是第二跳，边缘明文照旧。Spectrum 的 `tls: off` 确实不
终结，但那是 Enterprise 功能。

## 3. 推荐

**选 Tailscale Serve，手机加入 tailnet**：Mac 上一条
`tailscale serve --bg --tls-terminated-tcp=443 tcp://127.0.0.1:<surface 端口>`，手机装
Tailscale 客户端，浏览器开 `https://<host>.<tailnet>.ts.net`。它是唯一不需要租中继、不需要
自有域名、不需要 Enterprise 合同就四条全过的候选：TLS 私钥与 ACME 账户私钥都只在 Mac 上
生成并留在 Mac，证书是公共 Let's Encrypt 证书所以手机什么都不问，WireGuard 在运营商允许
时打洞直连、不行才回落 DERP 中继而中继只见 WireGuard 密文，节点身份基于密钥所以任何一端
换 IP 都无感。Funnel 在这里严格更差，只作为「手机装不了 VPN 客户端」的回退：它恒走中继，
且会把 surface 变成公网可拨——那样通行密钥门禁就是唯一一道门。**唯一能让我改主意的事**：
`ts.net` 这个 DNS 区由 Tailscale 掌握，因此它**有能力**不经 Mac 同意就为
`<host>.<tailnet>.ts.net` 签出一张 Let's Encrypt 证书。在 Serve 模式下这件事是惰性的
（还需要同时在路径上，而直连成功时 Tailscale 不在路径上，回落 DERP 时它只拿到密文）；但
如果威胁模型必须排除「名字的所有者可以在拿到路径的同时铸出该名字的有效证书」这一条，那么
任何 `ts.net` 名字都不可接受，答案就变成表格最后一行——自有域名、Mac 上 DNS-01、VPS 只做
SNI 透传。如果另一条红线是「第三方协调服务器不得有能力把一台设备加进 tailnet」，先开
**Tailnet Lock**，不要直接升级到 VPS 方案。

## 4. 实际配置

### 4.1 一次性前置

Mac 上装 Tailscale，**优先用官方 Standalone 版，而不是 Mac App Store 版**：端口代理型 Serve
在三个 macOS 变体上都能用，但 App Store 版整体处于沙箱内、状态存在用户 keychain、官方表
明与「屏幕使用时间」不兼容。Funnel 在两个 GUI 变体上都被官方对照表标为不支持（只有开源
`tailscaled` 支持）——但 Tailscale 自己的文档在这一点上**自相矛盾**（功能页说 macOS 必须用
开源变体，CLI 提示文本说只有 App Store/Standalone 能用），所以「GUI 版能跑 Funnel」按
**未核实**处理，并按不能用来规划。装 GUI 应用属于普通应用安装，不触犯「Mac 不是构建机」
那条约束；为了 Funnel 去 Homebrew 装 `tailscaled` 则有争议。

CLI 在应用包里：

```sh
alias tailscale="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
tailscale status
```

管理后台 **DNS** 页：打开 **MagicDNS**，再打开 **HTTPS Certificates**。Serve 要求后者
（官方原文：「Tailscale Serve requires you to enable HTTPS certificates in your tailnet」）。
附带后果要知道：打开之后 `<host>.<tailnet>.ts.net` 会进入 Certificate Transparency 日志。
名字是可被发现的；但没有 tailnet 成员身份，名字后面的东西依然不可达。

手机上从 App Store / 应用商店装 Tailscale，登录同一个 tailnet。不需要手动配描述文件、
证书或 DNS——MagicDNS 负责解析，隧道负责承载。

### 4.2 入口就是这一条命令

surface 的回环端口按实际配置填；现有 fleet 占了 8790（relay）和 8792（surface 页面），
下面用 `8792` 当占位。

```sh
# TLS 由本机 tailscaled 终结，之后以裸 TCP 交给回环监听。
tailscale serve --bg --tls-terminated-tcp=443 tcp://127.0.0.1:8792
tailscale serve status
```

`--bg` 是承重的那个 flag：官方说明它「持续在后台运行直到你关闭它」，且设备重启或
Tailscale 重启后 Serve「会自动恢复共享」。不加它，每次重启都得重跑一遍。

**本仓库要用 `--tls-terminated-tcp`，不要用 HTTP 反代形式**（`tailscale serve --bg 8792`）。
反代会在浏览器和 surface 之间插一层 HTTP：上游 issue 报告称经 Serve/Funnel 的 HTTP 代理时
**WebSocket upgrade 请求的 query 参数会被吃掉**（`/stream?token=…` 到后端变成 `/stream`）
——**上游报告，未在本机验证**。而 TLS-terminated-TCP 形式把解密后的字节原样交给 surface，
请求行、query、`Upgrade` 握手、`Sec-WebSocket-Protocol` 全部不动。这对 `03-reframe.md`
第 3 节那条链路是刚需：surface 做的是 JSON-RPC 逐帧原样转发，而服务端会**反向发起**
`item/commandExecution/requestApproval` 这类带 `id` 的请求等回复，不回就把整轮挂住——
这条通道经不起中间多一层 HTTP 语义改写。代价是 **surface 必须在 `127.0.0.1:8792` 上说
明文 HTTP/1.1，自己不要再做 TLS**。需要客户端地址就加 `--proxy-protocol=2`，并在
surface 侧解析 PROXY v2 头：

```sh
tailscale serve --bg --proxy-protocol=2 --tls-terminated-tcp=443 tcp://127.0.0.1:8792
```

撤销：`tailscale serve --tls-terminated-tcp=443 off`，或 `tailscale serve reset`。

### 4.3 通行密钥的接线

origin 是 `https://<host>.<tailnet>.ts.net`（端口 443，所以 origin 里不带端口）。
`ts.net` **在 Public Suffix List 上**——已核实：抓
`https://publicsuffix.org/list/public_suffix_list.dat`，里面有 Tailscale 提交的 `ts.net`
与 `*.c.ts.net` 两条。因此 `<tailnet>.ts.net` 是可注册域，下面两个都是合法 RP ID：

- `<host>.<tailnet>.ts.net` —— 最窄，凭据绑在这一台 Mac 的名字上；
- `<tailnet>.ts.net` —— tailnet 内多设备共享，cookie 也可以挂在这一层。

除非打算把 surface 在机器间搬，就用 host 那个。在 `src/auth/ceremony.mjs` 里把期望 origin
**写死**，不要从 `Host` 头推。`ts.net` 名字是 secure context，`navigator.credentials` 直接
可用，不需要额外处理。

### 4.4 访问控制

Serve 受 tailnet ACL 约束。不要让 tailnet 里每个节点都能摸到 surface：在 policy 文件里只
放通手机（以及你确实会用的设备）访问 Mac 的 443，其余拒绝。同时**保持 Tailnet Lock 开启**
——它正是阻止协调服务器悄悄塞进一台「已在 ACL 内」的设备的那个控制项。（具体 grant 语法
随 policy 版本而异，此处**未核实**，请在管理后台的 policy 编辑器里写，它会校验。）

### 4.5 让 surface 自己活着

Tailscale 自己管持久化，surface 不管。沿用现有 fleet 的 `local.codexrelay.*` 约定，
放一个用户级 LaunchAgent 到 `~/Library/LaunchAgents/local.codexrelay.web.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.codexrelay.web</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/USER/.codex-relay/web/server.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_RELAY_WEB_HOST</key><string>127.0.0.1</string>
    <key>CODEX_RELAY_WEB_PORT</key><string>8792</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/Users/USER/.codex-relay/log/web.err</string>
  <key>StandardOutPath</key><string>/Users/USER/.codex-relay/log/web.out</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.codexrelay.web.plist
launchctl print gui/$(id -u)/local.codexrelay.web | head -20
```

**只绑 `127.0.0.1`，绝不绑 `0.0.0.0`**：用了 `--tls-terminated-tcp` 之后这个监听说的是明文
HTTP，通配绑定等于把它明文暴露在局域网和 tailnet 网卡上。

### 4.6 回退 A —— Funnel，用于手机无法运行 VPN 客户端

需要 Mac 上有开源 `tailscaled`（`brew install tailscale` 加
`sudo brew services start tailscale`）——这是在 Mac 上装东西，而且会和 GUI 应用自带的
CLI 在 `PATH` 上冲突，用绝对路径调用其中一个来消歧。然后在 tailnet policy 文件里：

```json
"nodeAttrs": [
  {
    "target": ["autogroup:member"],
    "attr":   ["funnel"]
  }
]
```

```sh
tailscale funnel --bg --tls-terminated-tcp=443 tcp://127.0.0.1:8792
tailscale funnel status
```

随之而来的限制：只能用 **443、8443、10000**；只走 TLS（没有裸 `ws://`）；名字只能在
`<tailnet>.ts.net` 内；带宽限额不可配，且 Tailscale 自己把 Funnel 定位为小流量、偶发场景
（webhook、demo、OAuth 回调），而不是长连接高吞吐的 WebSocket 扇出——对一个流式 agent UI
这是真实风险，且在**本工作负载下未核实**。同一个端口不能同时处于 Serve 和 Funnel，后执行
的命令生效。最要紧的是 surface 变成公网可拨：通行密钥门禁加一个请求限速，是互联网与那条
JSON-RPC 通道之间的全部东西。

### 4.7 回退 B —— 自有域名、VPS 只透传、名字不归第三方

仅当第 3 节那条「改主意」条件触发时才用。形状是：Mac 持证书并终结 TLS；VPS 按 SNI 选路
且不持任何密钥；WireGuard 承载这一跳，所以 Mac 不需要任何入向可达性。

DNS（在注册商 / DNS 服务商处）：

```
relay.example.com.   A      <VPS 公网 IPv4>
relay.example.com.   AAAA   <VPS 公网 IPv6>     # 可选
```

**不要手工建 `_acme-challenge` 记录**——ACME 客户端通过服务商 API 写入并删除那条 TXT。
需要的凭据：**一个仅限在 `example.com` 上写 TXT 的 DNS 服务商 API token**（只点名，值不
进本仓库、不进 plist、不进 shell history；从 keychain 或仓库外的 0600 文件读）。

Mac 上签发并自动续期：

```sh
# 以 acme.sh + Cloudflare DNS 为例，换服务商就换 --dns 插件。
export CF_Token="<从 keychain 取，不落盘在此>"
acme.sh --issue --dns dns_cf -d relay.example.com --keylength ec-256
acme.sh --install-cert -d relay.example.com --ecc \
  --key-file       ~/.codex-relay/tls/relay.key \
  --fullchain-file ~/.codex-relay/tls/relay.crt \
  --reloadcmd      "launchctl kickstart -k gui/$(id -u)/local.codexrelay.web"
```

`acme.sh` 安装时会自己装续期 cron，用 `acme.sh --list` 与 `crontab -l` 核对。这个模式下
surface **要自己终结 TLS**，读上面那对文件。

WireGuard，由 Mac 主动外拨，家用路由不需要任何入向规则。VPS 侧 `/etc/wireguard/wg0.conf`：

```ini
[Interface]
Address    = 10.8.0.1/24
ListenPort = 51820
PrivateKey = <VPS 私钥>

[Peer]
PublicKey  = <Mac 公钥>
AllowedIPs = 10.8.0.2/32
```

Mac 侧（`wg-quick` 配置或 WireGuard.app 的 tunnel）：

```ini
[Interface]
Address    = 10.8.0.2/24
PrivateKey = <Mac 私钥>

[Peer]
PublicKey           = <VPS 公钥>
Endpoint            = <VPS 公网 IPv4>:51820
AllowedIPs          = 10.8.0.1/32
PersistentKeepalive = 25
```

`PersistentKeepalive = 25` 是让家用 NAT 映射不过期的那一行；没有它，VPS 在空闲一段时间后
就无法朝 Mac 发起连接。

VPS 上 nginx 做 SNI 透传，需要编译带 `--with-stream --with-stream_ssl_preread_module`
（用 `nginx -V` 核对）。这个模块只从 ClientHello 里读 SNI 然后原样转发字节，**不做握手、
不需要证书**：

```nginx
stream {
    map $ssl_preread_server_name $relay_backend {
        relay.example.com  10.8.0.2:8443;
        default            "";
    }

    server {
        listen 443;
        listen [::]:443;
        ssl_preread on;
        proxy_pass            $relay_backend;
        proxy_connect_timeout 5s;
        proxy_timeout         1h;      # 长连接的流式对话
    }
}
```

Mac 上 surface 监听 `10.8.0.2:8443`，用 acme.sh 那对证书做 TLS。VPS 防火墙入向只留 443 与
51820。已核实：`ssl_preread` 按设计就不终结 TLS。**未核实**：流式对话实际需要多大的
`proxy_timeout`。

## 5. 这件事的成本

**拉进来的依赖（推荐方案）。** 一个第三方 macOS 应用加一个手机应用，没有工具链、没有编译
器、没有 npm 依赖——`package.json` 继续保持零依赖。不买域名、不租 VPS、不自管 ACME 账户。
整个入口配置就是一条 CLI 命令，且 `tailscale serve reset` 可完全回退。

**谁在信任路径上。** Let's Encrypt 签发证书（名字因此进入 CT 日志）。Tailscale 的协调服务
器持有节点公钥与 tailnet 成员关系，原则上能授权一台新节点入网——Tailnet Lock 是对应的
缓解项，也是这里最重要的那个非默认设置。Tailscale 同时掌握 `ts.net` 区，因而有能力为这台
Mac 的名字铸证书，这就是第 3 节点名的残余风险。Tailscale 的 DERP 中继承载的是 WireGuard
密文、读不懂内容，且 Serve 模式下只在打洞失败时才用到。客户端应用经由 Apple 与 Google。
**除 Mac 之外，没有任何一方持有能解开浏览器那条 TLS 会话的密钥。** 对照一下：Cloudflare
Tunnel 默认模式把全量明文放在边缘；回退 B 则是把 Tailscale 换成「你的 DNS 服务商 + 一个
VPS 运营方 + 你自己的续期 cron」。

**Mac 重启。** `tailscale serve --bg` 自动恢复，Tailscale 应用登录时自动连回；surface 只有
在 LaunchAgent 已加载（§4.5）时才会回来。真正的重启后故障点不在入口，而在它后面那段：
按 `03-reframe.md` 的架构，`claude-codex-adapter` 守护进程与它的 socket 要重新就位，
而 surface 必须能忍受「对端暂时不在」而不是自己退出。重启自愈是 fleet 监管问题，不是入口问题；入口恰好是唯一会自己
恢复的那一块。

**IP 变化。** 什么都不坏。名字解析到 Mac 稳定的 `100.x` tailnet 地址，WireGuard 自己重新
发现 endpoint；家宽换公网 IP、局域网换 IP、甚至把 Mac 搬到另一个网络，代价只是重新打一次
洞，期间由 DERP 中继兜住。这正是其他方案更差的地方：回退 B 把 A 记录钉在 VPS（这没问题），
但任何依赖 Mac 自身地址的设计都需要一套改号方案，家用路由端口映射的方案还要加动态 DNS。
这条性质是推荐方案在运维上胜出的主要理由。

**放弃了什么。** 手机必须运行一个会接管其流量的 VPN 客户端——这是用户看得见的开关，在被
别人 MDM 管的设备上直接不可行。要把 surface 分享给一个无法加入 tailnet 的人，就只能用
Funnel（§4.6）并接受公网暴露。此外 surface 只对已入网设备可达：这在本项目里是优点，但也
意味着没有「发个链接给人点开」这条路。

## 6. 外部出处

厂商文档，均于 2026-10-22 读取：

- Tailscale Serve — <https://tailscale.com/kb/1312/serve>（「requires you to enable HTTPS
  certificates in your tailnet」；仅 tailnet 内可达；文件/目录型 Serve 限开源变体，端口代理
  型不限）
- Tailscale Funnel — <https://tailscale.com/kb/1223/funnel>（「The Tailscale server running
  on your device … terminates the TLS connection」、「Funnel relay servers do not decrypt the
  traffic … Tailscale cannot access or read any content」；仅 443/8443/10000；`funnel`
  nodeAttr；带宽限额不可配）
- Tailscale HTTPS 证书 — <https://tailscale.com/kb/1153/enabling-https>（「Your certificate's
  private key and your Let's Encrypt (ACME) account's private key are generated and stored
  locally on your machine and Tailscale never sees them」；DNS-01 TXT 由 Tailscale 写在
  `ts.net` 区；`tailscale cert` 导出的文件型证书须自行续期）
- macOS 三个变体对照表 — <https://tailscale.com/kb/1065/macos-variants>（Funnel 一行：
  App Store 否、Standalone 否、`tailscaled` 是；与 Funnel 功能页措辞冲突，故本文按未核实处理）
- macOS 上 CLI 位置 — <https://tailscale.com/kb/1080/cli>
- `serve` / `funnel` CLI 参考 — <https://tailscale.com/docs/reference/tailscale-cli/serve>
  （`--bg`、`--tcp`、`--tls-terminated-tcp`、`--proxy-protocol`、`serve status|reset`；
  `--bg` 下重启自动恢复）
- WebSocket upgrade 的 query 被吃掉 — <https://github.com/tailscale/tailscale/issues/18651>
  （上游报告，未在本机验证）
- Cloudflare 加密模式与 Origin CA — <https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/>、
  <https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/>（Origin CA 证书
  「only encrypt traffic between Cloudflare and your origin server, not traffic from client
  browsers to your origin」）
- Cloudflare Spectrum 配置项与档位 — <https://developers.cloudflare.com/spectrum/reference/configuration-options/>、
  <https://developers.cloudflare.com/spectrum/reference/settings-by-plan/>（`tls: off` 即
  passthrough；Enterprise 专属）
- Public Suffix List — <https://publicsuffix.org/list/public_suffix_list.dat>（含 Tailscale
  提交的 `ts.net` 与 `*.c.ts.net`；已核实：直接抓取比对）
- `riba2534/herdrx` — <https://github.com/riba2534/herdrx>（README 的「Tailcat 内网穿透」
  与「快速开始」两节；issue #10）
