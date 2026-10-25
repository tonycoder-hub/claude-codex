# Tailscale Funnel：唯一自带域名的那条，也是唯一还没装过的那条

写于 2026-10-23。本机**未验证** —— 这不是脚注，而是 `VERIFIED_ON_RESIDENT = false`
一个常量加一条测试。谁把它改成 `true`，应该是在真的端到端跑通之后。

这篇的结论有点别扭，所以先说清楚：**Funnel 在技术上是全部候选里最干净的一条，而它在这台机器上
不可用。**两件事都是真的，不要因为后者就不记录前者 —— 它只差一张 IT 工单。

## 1. 为什么值得写：它把域名问题一起解决了

`12` §5 列了两个卡点，第一个是域名。WebAuthn 的 RP ID 必须是域名，IP 不是合法 RP ID，所以
**没有域名就没有 passkey，就没有鉴权**。其他每条路都把这个问题留给你。

Funnel 不留：它给出 `<node>.<tailnet>.ts.net`，一个真实名字 + 真实证书，不需要任何 DNS 操作。
provider 因此返回 `webauthnRpId`，这是整条路线存在的理由。**一次安装关掉两个卡点。**

## 2. T1：通过，而且两句话都来自厂商文档

`04` §T1 要求：浏览器的 TLS 必须由本地进程终结，且该证书私钥不得存在于第三方机器上；只转发
它读不了的密文的第三方**通过**。

> "Funnel relay servers do not decrypt the traffic between public devices and your device.
> This ensures that Tailscale cannot access or read any content."

> "Your certificate's private key and your Let's Encrypt (ACME) account's private key are
> generated and stored locally on your machine and Tailscale never sees them."

**中继是 SNI 路由的字节管道，私钥是我们的，连 ACME 账户私钥都是本地的** —— 和
ssh+socat 成立的理由同一条。
**已核实（对厂商文档），未核实（对本机）。**

### 2.1 残余信任：一条真实的代价，不是理论上的

没人会替我们说这句，所以写在这里：**`ts.net` 这个 zone 不是我们的。** 我们节点回答 DNS-01
挑战用的 TXT 记录是 Tailscale 写的。它读不了我们的流量，但它**能用自己的账户为我们的名字再签
一张合法证书**。

标准缓解手段是 RFC 8657 CAA `accounturi`，把签发钉死在我们的 ACME 账户上 —— 而**这个手段在这里
用不了**，因为在 `ts.net` 上设 CAA 记录需要控制 `ts.net`。

> 用自己的域名可以钉，用 `ts.net` 名字不能钉。**这就是「不必拥有域名」的价格。**

所以 `FUNNEL_MODES` 的每一项都有 `tlsResidual` 字段，三种模式各写一遍 —— 让它在被快速浏览时
也活得下来。

## 3. 三种模式，终结点各不相同

| 模式 | 参数 | TLS 由谁终结 | surface 收到 | 证书归谁 |
| --- | --- | --- | --- | --- |
| `https` | `--https=443` | tailscaled | 回环上的明文 HTTP | tailscaled |
| `tcp` | `--tls-terminated-tcp=443` | tailscaled | 回环上的明文 TCP | tailscaled |
| `raw` | `--tcp=443` | **surface** | 原封不动的 TLS 流 | **我们**（`tailscale cert`） |

三种都通过 T1，但理由不同：前两种是「本地进程终结 + 本地私钥」，第三种是最严格的读法 ——
tailscaled 完全不碰 TLS。代价是证书续期变成我们自己的事。

**一个容易搞反的点，我自己就先写反了一次：** CLI 文档把 `--tcp` 描述成 "forwarding unencrypted
TCP packets"，别读成「浏览器的 TLS 没了」。它说的是**本地那一段** —— tailscaled 不做 TLS 工作，
所以递给我们的就是客户端发来的东西，在 443 口上那是一个 TLS ClientHello。
`--tls-terminated-tcp` 则在名字里就写明了谁终结。测试里专门有一条断言盯住这组关系：
`needsOwnCertificate` 必须等价于 `tlsTerminatedBy === 'surface'`，三行不能互相矛盾。

## 4. 两条设计决定

**形态是 listener-configuring，和 `ssh.mjs` 同理。** tailscaled 持有公网监听者，我们保留自己的
本地监听者并把它指过去；没有任何 socket 交到这个模块手里，所以没有东西可以 emit 到
`target.server`。

**拒绝 `--bg`，这是安全属性而不是口味。** 后台 funnel 把暴露注册进 tailscaled 状态然后返回 ——
文档明说它**还能跨重启存活**。于是暴露的寿命长过我们的进程：崩了之后，这台 Mac 上一个端口仍在
对公网开放、无人看管，直到有人想起来跑 `funnel off`。前台运行把暴露绑在子进程生命周期上，最坏
情况是「入口没了」而不是「入口没人管」。所以是**拒绝**，不是「默认不用」。

`stop()` 里刻意**不**发 `funnel off`：那会连带清掉别人在这个节点上配的 funnel。

## 5. 它需要什么，以及为什么本机不行

本地配置无法替代的两项（admin console 里）：**funnel 节点属性**、**HTTPS 证书已启用**。
`TAILSCALE_CAPABILITIES.requiresTailnetPolicy` 把它们列成数组，有测试盯着。

本机的阻塞项，诚实版（2026-10-26 更正）：**这是一次客户端安装，而这台 Mac 上从来没试过。**
原先这里写的是「在纳管的 Mac 上这就是卡点，受管载荷含 `com.apple.applicationaccess`」——
那条推断已被实读载荷推翻，见 `12` §2：该载荷里没有任何应用安装限制，真正相关的
`com.apple.system-extension-policy` 还是 `AllowUserOverrides = 1`。所以
`requiresNewSoftwareOnResident` 仍然是整张能力表里最要紧的 `true`，但它的含义是
**「要装东西」**，不是「装不上」。

## 6. 这份测试证明了什么，没证明什么

21 条测试，全是接缝与拒绝。**它们证明了 argv、状态解析和每一条拒绝；它们完全没有证明 Funnel
能用。** 这是弱点，而且是诚实的那种弱点 —— `VERIFIED_ON_RESIDENT` 让这个区别待在代码里，而不是
待在谁对这段注释的记忆里。`start()` 每次都会 `logger.warn('provider.tailscale.unverified')`，
handle 上也带着这个字段，有测试盯着。

**未核实清单：** Funnel 上的 WebSocket upgrade（厂商称支持）；`https` 模式下 tailscaled 作为
HTTP 反向代理是否干扰我们的 bus；Funnel 能否用自有域名而非 `ts.net` 名字；以及最要紧的一条 ——
这台机器能不能装。
