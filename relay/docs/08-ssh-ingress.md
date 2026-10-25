# 入口：ssh 反向隧道（`-R`），以及它唯一的服务端前提

写于 2026-10-22，回答 `05-relay.md` 第 5.1 节留下的那个问题，并把第 7 节「还不知道的」
里排第一的那条划掉一半。判据沿用 `04-ingress.md` 第 1 节的 T1–T4，不重新定义。凡事实
按 **已核实 / 推断 / 未核实** 标注，核实手段一律是读配置与读进程表，全程只读。

## 1. 判定

**这条路成立，而且它是三个候选里唯一「传输层已经装好、并且已经在那台 Mac 上跑着生产
流量」的。** 但它带着两个必须先说的限定，其中第二个是 `05-relay.md` 点名的那个未知，
答案是否定的：

1. **服务端前提：构建机的 `sshd` 是 `GatewayPorts no`（已核实两次）。** 所以 `-R` 只能
   绑在远端回环上，必须由远端上的另一个进程把它重新发布出去。好消息是那个进程现成：
   构建机上有 nginx 1.29.7，编译参数里有 `--with-stream` 和
   `--with-stream_ssl_preread_module`（已核实），正好是「只读 SNI、不握手、不持证书」
   所需要的那一对。socat、haproxy、stunnel 都**没有**（已核实），所以 nginx 不是首选，
   是唯一选项。

2. **公网可达性：没有。** 已核实——构建机的 `eth0` 只有一个 RFC1918 的 IPv4 和一个
   `fd00::/8` 的 ULA IPv6，没有任何全局单播地址，默认路由也指向内网网关。因此
   **把隧道开到构建机上，手机必须先进内网或 VPN 才能用**。这不是「还没测」，是读地址
   表就能定的事。
   需要说清楚的是另一半：常驻 Mac 的 `~/.ssh/config` 里**确实**存在若干条目，其
   `HostName` 是全局可路由地址（两台个人自管的境外主机，其中一台在生产里已被当作
   `ProxyCommand` 跳板使用；另有一条走 DDNS 的 AAAA、只有 IPv6 的家宽入口）。所以
   「有没有我们控制的、公网可达的主机」的答案是**有候选**，但那些主机的 `sshd` 是否
   允许非回环绑定、上面有没有 republisher，**本次一律未核实**——按约束没有探测、没有
   连接、没有扫描。要把这条路做成公网入口，下一步就是去读那台机器的
   `sshd_config` 与 `nginx -V`，而不是再做任何推理。

一句话版本：**机制已经验证可用，密钥保管这一关过得很干净，卡住的是「哪台机器放在
公网上」这个运维/产品决定，不是技术问题。**

## 2. 形状

```
手机 ──TLS──> remote:443            nginx stream + ssl_preread（只读 SNI，不握手，不持证书）
                  │ proxy_pass
                  v
              remote 127.0.0.1:<R>  sshd 为我们的 -R 绑的那个回环端口
                  │ ssh 传输层
                  v
              Mac  127.0.0.1:<S>    surface 自己的监听，TLS 在这里终结
```

左边三跳里没有任何一跳持有浏览器那条 TLS 会话的密钥。这正是 `04-ingress.md` 回退 B
（自有域名 + VPS 只做 `ssl_preread`）的形状，区别只有一处：**不需要 WireGuard**。
回退 B 用 WireGuard 是为了得到一条「Mac 主动外拨、因此家用路由不需要入向规则」的链路，
而 `ssh -R` 本身就是这样一条链路。少一个守护进程、少一套密钥、少一个开机自启项。

## 3. 事实

### 3.1 `GatewayPorts`，以及它失败时的样子

**已核实（读配置）**：构建机 `/etc/ssh/sshd_config` 里**没有** `GatewayPorts` 这一行，
没有 `Include`，`/etc/ssh/sshd_config.d/` 是空目录，两个 `Match` 块只改
`PasswordAuthentication`。因此生效的是编译期默认值。`sshd_config(5)` 原文：

> By default, sshd(8) binds remote port forwardings to the loopback address. …
> The default is **no**.

**已核实（读运行时）**：常驻 Mac 上此刻就有多条指向构建机的 `-R` 长跑，其中一条用的是
**裸端口形式**（`-R <port>:127.0.0.1:<port>`，不写绑定地址）。在构建机上看这些端口，
全部落在 `127.0.0.1` 和 `[::1]` 上。这是对「默认 `no`」的运行时确认，不是推断。

**这条路最该记住的一件事，是它失败时不报错。** `GatewayPorts no` 的语义是「忽略客户端
请求的绑定地址，照样绑回环」，而不是「拒绝该请求」。于是转发请求**成功**，
`ExitOnForwardFailure` 这把抓住了其他所有转发故障的锁，**唯独抓不住这一个**：隧道活着、
日志干净、`ssh` 不退出，端口就是没人能连。`src/relay/providers/ssh.mjs` 因此把
`remoteBindAddress` 默认钉死在 `127.0.0.1`，要绑别的必须显式签
`acknowledgeRemoteGatewayPorts`，且拒绝信息里点名这个静默降级——否则总会有人靠传
waiver 来「修好」它。

顺带：`AllowTcpForwarding` 与 `PermitListen` 也都没写，取默认 `yes` / `any`，所以 `-R`
本身是放行的（这一点同样被上面那些跑着的转发证明了）。`MaxAuthTries 4`（已核实）是后面
「认证失败不重试」那条规则的算术依据。

### 3.2 远端用什么重新发布

构建机上的清单（已核实，`command -v` 逐个查）：

| 工具 | 在不在 | 能做什么 |
|---|---|---|
| nginx 1.29.7（用户态 Homebrew） | **在** | `--with-stream`、`--with-stream_ssl_preread_module` 齐全 → **裸 TCP / SNI 透传**，也能做终结型反代 |
| socat | 不在 | — |
| haproxy | 不在 | — |
| stunnel / ncat / frp / caddy | 不在 | — |
| `nc` / `netcat` | 在 | 不可用：没有并发监听，撑不住多连接 |
| `iptables` / `nft` | 不在 | 走不了内核转发那条路 |

所以 **republisher 只能是 nginx 的 `stream` 块**，而它恰好支持两个变体里更好的那个。
它装在用户态前缀下，意味着**绑高位端口不需要 root**；要绑 443 才需要特权（构建机上
`sudo -n` 可用，**但本次不改任何服务端配置**）。

### 3.3 Mac 侧已经在跑的东西

**已核实（读进程表）**：常驻 Mac 上有十余条长跑 `ssh`，`-L`、`-R`、`-D` 都有。现有 relay
fleet 正是通过它们到达的——Mac 上的 relay 端口与 surface 端口都是 `-L` 转发，也就是说
**中继服务端本来就在 Mac 之外，Mac 一直在主动外拨**。这些进程共用的 flag 组合是
`BatchMode=yes`、`ExitOnForwardFailure=yes`、`ServerAliveInterval`/`ServerAliveCountMax`、
`ConnectTimeout`、`ControlMaster=no`、`StrictHostKeyChecking=yes`，其中承载 `-L`+`-R`
的那一条还加了 `-F /dev/null` 然后把每个选项显式写全。

provider 的 argv 是**照抄**这一组，不是重新设计的。理由很直接：这组参数已经在那台机器上
扛过重启、睡眠和换网，而我们对它一次都没测过。`src/relay/providers/ssh.mjs` 里每个选项
旁边都写了它在干什么，其中三个值得在这里重复：

- `ConnectionAttempts=1`——重试是 provider 的事。让 `ssh` 自己也重试，会把失败对分类器
  藏起来，并且把真实节奏翻倍。
- `ControlMaster=no` / `ControlPath=none` / `ControlPersist=no`——复用别人的 master 之后，
  子进程的寿命就不再等于隧道的寿命，而整个监管逻辑只建立在这一个假设上。
- `ForkAfterAuthentication=no`——自己转后台的子进程会**立刻且成功地**退出。那正是本项目
  里「一个瞬退子进程产出约 35000 个进程、约 500 个/分钟」那次事故的形状。

### 3.4 公网可达性，再说一次

**已核实**：构建机只有内网地址。**未核实（按约束主动不测）**：Mac 配置里那几台全局可
路由的主机上，`sshd` 的 `GatewayPorts`、有没有 nginx `stream`、443 是否空闲。
**推断**：既然它们是个人自管且已在日常使用，取得那两项信息只需要一次只读登录。

如果最终答案是「手机先进内网」，这条路今天就完整可用，而且是**本机唯一能端到端自测**
的入口。那是产品决策，不是技术判定，本文不替它假设——这一句沿用 `05-relay.md` 的措辞，
因为结论没变，只是把「不知道」换成了「构建机上确定不行，别处未查」。

## 4. TLS 与密钥在谁手上

两个变体，差别不是性能，是**谁能解开浏览器那条会话**。

| 变体 | 远端跑什么 | 密钥在哪 | 远端能看到什么 | T1 |
|---|---|---|---|---|
| **强（透传）** | `stream` + `ssl_preread` + `proxy_pass` | **只在 Mac** | TLS 密文、ClientHello 里的 SNI、连接时间与字节数、手机出口 IP | **过** |
| **弱（终结）** | `http` + `ssl_certificate` + `proxy_pass` | **在远端** | 全量明文 | 仅在「远端真归我们」时才谈得上过 |

**强变体是默认，也是唯一应该用的。** `ssl_preread` 按设计不握手、不需要证书，它只从
ClientHello 里读 SNI 然后原样转发字节。provider 的 `TLS_VARIANTS` 把这条判断写成了可
断言的记录，而不是一段会被忘记的散文。

**弱变体的「我们控制那台机器」必须意味着什么，才值一分钱。** 这是本文和
`04-ingress.md` 回退 B 最该对齐的一点：

- 磁盘与内存的管理员访问只有我们；
- **没有第三方的 hypervisor**——云/VPS 厂商可以快照内存、挂载磁盘、接管控制台，这一条
  在**任何租来的机器上都不成立**；
- 我们能审计它的 `sshd_config`、nginx 配置和二进制；
- 证书的备份与轮换由我们掌握。

把这四条摆出来，结论是自己得出的：**在租来的 VPS 上终结 TLS，并没有「自己留着密钥」，
只是把第三方从 Cloudflare 的边缘换成了 VPS 运营方**，而后者的审计与合规面比前者差。
`04-ingress.md` 坚持回退 B 里「VPS 不持任何密钥」不是洁癖，是这四条的直接推论。弱变体
唯一站得住的场景，是那台机器在我们自己的机房或家里。

**强变体的残余风险，必须点名。** 远端是 A 记录指向的那个地址，因此它**有能力**用
HTTP-01 或 TLS-ALPN-01 为我们这个名字向 Let's Encrypt 申到一张合法证书，然后在这个位置
做一次浏览器不会报警的中间人。这是 `04-ingress.md` 第 3 节对 `ts.net` 点名的那条残余
风险的同构版本，只是这次名字归我们，所以**我们有对应的控制项**：在自有域名上写 CAA，
用 RFC 8657 的 `accounturi` 把签发钉死在我们自己的 ACME 账户上，必要时再用
`validationmethods` 限定为 `dns-01`。

```
relay.example.com.  CAA  0 issue "letsencrypt.org; accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/<我们的账户 id>; validationmethods=dns-01"
relay.example.com.  CAA  0 issuewild ";"
```

**未在本次会话核实**：Let's Encrypt 对 `accounturi` 与 `validationmethods` 的现行支持
状态。落地前去厂商文档确认一次，这是开着这条路**之前**要做的事，不是之后。

## 5. T1–T4 判定

沿用 `04-ingress.md` 的表式。本行讲的是「`ssh -R` + 远端 `ssl_preread` 透传 + 自有域名」。

| 候选（模式） | T1 密钥保管 | T2 浏览器信任 | T3 NAT | T4 运维 | 判定 |
|---|---|---|---|---|---|
| **`ssh -R` + 远端透传 + 自有域名（强变体）** | **过**——证书与 ACME 账户私钥只在 Mac，远端跑 `ssl_preread` 不持任何密钥；残余风险是远端可经 HTTP-01 自签我们的名字，用 CAA `accounturi` 钉住 | **过**——自有名字的 Let's Encrypt 证书，与回退 B 同 | **Mac 侧过**（主动外拨，家用路由零入向规则，已核实本机常年在跑）；**手机侧取决于远端**——已核实构建机只有内网地址，故在构建机上**不过** | **部分过**——`ExitOnForwardFailure` + keepalive 的生产配置已在跑，provider 自带有界退避监管；但证书续期、远端 nginx 打补丁、远端 sshd 配置漂移都归我们 | **机制过，公网可达性未解决** |
| `ssh -R` + 远端**终结** TLS（弱变体） | **不过**（租用机器）——见第 4 节四条；自有机房才谈得上过 | 过 | 同上 | 同上，再加远端证书管理 | **按 T1 否决**（除非机器真是自己的） |
| `ssh -R` 直接绑远端 `0.0.0.0` | 同强变体 | 同上 | 同上 | — | **构建机上不可行**：需要服务端 `GatewayPorts clientspecified|yes`，而默认是 `no` 且**我们不改它** |

和 `04-ingress.md` 的推荐方案对照，一句话：**Tailscale Serve 四条全过但那台 Mac 上从没装过（见 `12` §2）；
这条路 T1/T2 过得同样干净、T4 稍差、T3 差在「需要一台公网主机」，但它今天就能跑。**
两者不冲突——provider 接口存在的意义就是这个。

## 6. 实际配置

### 6.1 远端 nginx（透传，不持证书）

```nginx
stream {
    map $ssl_preread_server_name $relay_backend {
        relay.example.com  127.0.0.1:18443;   # sshd 为 -R 绑的那个回环端口
        default            "";                 # 名字不对就不转发，别当默认后端
    }

    server {
        listen 443;
        listen [::]:443;
        ssl_preread on;
        proxy_pass            $relay_backend;
        proxy_connect_timeout 5s;
        proxy_timeout         1h;    # 流式对话是长连接
    }
}
```

和 `04-ingress.md` 回退 B 的那段**只差一行**：后端从 WireGuard 地址换成 `127.0.0.1`，
因为这次把流量送过去的是 sshd 而不是 WireGuard。`default ""` 不是摆设：没有它，任何打到
这个 IP 的 TLS 连接都会被塞进我们的隧道。

**未核实**：流式对话实际需要多大的 `proxy_timeout`（与回退 B 同一条未知）。

### 6.2 Mac 侧那条长跑

provider 会自己拼这条命令并监管它；下面是它等价的手写形式，便于核对：

```sh
ssh -N -T -n -x -F /dev/null \
    -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
    -o ConnectTimeout=10 -o ConnectionAttempts=1 \
    -o ControlMaster=no -o ControlPath=none -o ControlPersist=no \
    -o ForkAfterAuthentication=no -o PermitLocalCommand=no -o ForwardAgent=no \
    -o PreferredAuthentications=publickey -o PasswordAuthentication=no \
    -o KbdInteractiveAuthentication=no -o NumberOfPasswordPrompts=0 \
    -o LogLevel=ERROR \
    -R 127.0.0.1:18443:127.0.0.1:8792 \
    <user>@<remote>
```

**认证只用密钥或 agent。** 口令、passphrase、token 一律不进 argv，也不进 env——argv 在
同主机上人人可读，这就是 provider 里那道筛子存在的理由。`SSH_ASKPASS` 与 `DISPLAY`
被刻意排除在子进程环境之外，于是 `ssh` **没有途径**去问 passphrase；`BatchMode=yes`
从另一侧把同一句话再说一遍。

远端那把公钥建议用**专用密钥**并在 `authorized_keys` 里加限制，让它只能做这一件事：

```
restrict,port-forwarding,permitlisten="127.0.0.1:18443",command="/bin/false" ssh-ed25519 AAAA... relay-ingress
```

`permitlisten` 把这把钥匙能绑的端口钉死，`restrict` 关掉 agent/X11/pty/user-rc。
**未核实**：目标远端的 `sshd` 版本是否支持 `permitlisten`（OpenSSH 7.8+），落地时核对。

### 6.3 surface 侧

强变体下 **surface 自己终结 TLS**，读 `acme.sh` 装好的那对文件，续期方式与
`04-ingress.md` §4.7 完全一致（DNS-01，token 从 keychain 取，不落盘在仓库里）。
监听仍然**只绑 `127.0.0.1`**——隧道的另一端就在本机回环上，没有任何理由绑通配地址。

## 7. provider 的形状，以及它为什么是这个形状

`src/relay/providers/ssh.mjs`，**listener-configuring**。理由不是分类学：这条路上
**provider 一个字节都看不到**。sshd 搬运流，Mac 这端的 `ssh` 客户端把它交给 surface
**自己的**监听，所以没有 socket 可以 `server.emit('connection', socket)`，它不可能是
outbound-multiplexing。`provider.mjs` 的文件头把「一台做 SNI 透传的 VPS」直接点名为这个
形状，而这里的 republisher 就是那台 VPS。

还有一个对得上的细节：`validateTarget` 对这个形状要求 `target.host` 和 `target.port`，
而那**正好**是 `-R` 第二段所需要的四个字段里的后两个。接口要的东西和机制要的东西是同一
件，这是形状选对了的旁证。

运维上真正承重的四条，都写成了测试：

1. **有界指数退避，两档。** `connection`（闪断）从 1 s 起、60 s 封顶、不设次数上限——
   隧道本来就该一直试。`forward`（远端端口被别人占了）从 15 s 起、300 s 封顶，而且**有
   次数上限**：占着端口的是另一个进程，再急也不会让它松手，到次数就停下来报错让人去换
   端口。**地板是承重的那个数**：35000 个进程那次事故折算下来是每 120 ms 一个，而地板
   被施加在**每一次**重启上——包括第一次，也包括一次长时间健康运行之后的那次。只有天花板
   是不够的，因为天花板要到损害发生之后才够得着。
2. **转发失败和连接失败分开。** 两者都以 255 退出，退出码分不开它们，**只有诊断文本能**。
   所以分类器读 stderr，模式串是从构建机上 `ssh(1)` 二进制里抽出来的格式串，不是凭记忆
   写的：`ExitOnForwardFailure=yes` 走的是 `fatal("Error: remote port forwarding failed
   for listen port %d")`，而 `fatal` 在 `LogLevel=ERROR` 下照样打印——这就是为什么可以
   把子进程调安静而不会把分类器弄瞎。
3. **有三类失败根本不重试。** `host-key`（`REMOTE HOST IDENTIFICATION HAS CHANGED`）、
   `auth`（`Permission denied (publickey)`）、`config`（`ENOENT` 等）。前者是安全事件：
   重连到一台认不出来的主机，第 4 节整段 T1 论证当场作废；中者是算术，`MaxAuthTries 4`
   意味着重试只是在打我们自己的账号。
4. **拆除是步数计的，不是墙钟计的。** `sleep` 是注入的、时钟不是，所以用 deadline 写的
   等待在假时钟下不会等待、只会空转。退避中的 `stop()` 也不会把延迟等满——它和停止信号
   赛跑，于是 300 s 的退避不会变成 300 s 的关机。

### 7.1 一处接口缺口，本文**不**动它

`provider.mjs` 明确写着它表达不了「接上了、掉了、正在重试」这个状态，并且说明相信
「发明一个重试循环会把运维最需要的那个事实藏起来」。但反向隧道的子进程死了就等于入口
没了，而进程里没有别的东西在看它，所以这个 provider **必须**监管。折中办法是让监管
**永远不沉默**：每次 spawn、每次分类、每次退避都进 logger，计数器（`restarts`、
`lastExitClass`、`forwardConflicts`、`terminal`）挂在返回的 handle 上。接口将来长出降级
通道时，接上去的就该是这几个。

另外两件需要 `src/relay/provider.mjs` 改动、因而**本文不做**的事：

- `PROVIDERS` 里没有 `ssh`，所以 `selectProvider('ssh')` 现在会抛。注册一行
  `ssh: createSshProvider` 即可，但那个文件归另一处改动所有。

### 7.2 `publicUrl` 为什么是 `null`

因为我们绑的那个端口**在远端的回环上**，连远端自己的局域网都拨不到它。合成一个
`https://<remote>:<port>` 会是一个**构造上就为假**的 URL。只有运维知道前面那台
republisher 把它发布成了什么名字，所以只有运维能提供——`publicUrl` 是个可选项，不传就
是 `null`。这和 `provider.mjs` 里「不要把 public 读进这个字段名」是同一条纪律。

## 8. 成本

**拉进来的依赖：零。** 没有新二进制、没有 npm 包、没有 macOS 应用、没有手机应用。
`package.json` 继续零依赖。Mac 上要装的东西是**空集**——这恰好是 Tailscale 方案在那台
机器上卡住的那一点。

**谁在信任路径上。** Let's Encrypt（名字进 CT 日志）；我们的 DNS 服务商；那台远端主机的
运营方——强变体下它只拿到 TLS 密文、SNI 和流量元数据，**拿不到明文**，但它**在路径上**，
因此 CAA 钉死 ACME 账户这一条是必须做的，不是可选项。除 Mac 之外没有任何一方持有能解开
浏览器那条 TLS 会话的密钥。

**Mac 重启。** `ssh` 这条长跑需要有人拉起来，和 surface 一样进 LaunchAgent（约定沿用
`04-ingress.md` §4.5 的 `local.codexrelay.*`）。这比 `tailscale serve --bg` 差一点：
Tailscale 自己管持久化，这里要我们管。但 provider 的监管循环覆盖了启动之后的全部故障，
LaunchAgent 只需要负责「开机把它拉起来」这一件事。

**IP 变化。** 家宽换公网 IP、局域网换 IP 都不影响——Mac 是主动外拨的那一端。远端换 IP
要改 A 记录，和回退 B 一样。

**放弃了什么。** 需要一台公网主机，以及一个自有域名。换来的是不需要手机装 VPN 客户端，
也不需要 Mac 上装任何东西。

## 9. 还不知道的

- **哪台公网主机。** 第 1 节第 2 条。读两份配置就能定：那台机器的 `sshd_config`
  （`GatewayPorts`、`PermitListen`、`AllowTcpForwarding`）和 `nginx -V`（有没有
  `stream` 与 `ssl_preread`）、443 是否空闲。
- **Let's Encrypt 对 CAA `accounturi` / `validationmethods` 的现行支持**（第 4 节）。
- **流式对话需要多大的 `proxy_timeout`**（与 `04-ingress.md` 回退 B 同一条未知）。
- **远端 `sshd` 是否支持 `permitlisten`**（§6.2）。
- **端到端没跑过。** provider 与它的测试完整，但没有任何一个测试 spawn 过真的 `ssh`、
  绑过监听或连过主机——这是刻意的约束。第一次真跑应该在内网、对构建机做，那是今天就能
  做的事。

## 10. 核实手段

全部为只读操作，未修改任何主机上的任何配置，未创建隧道，未绑定监听，未探测任何外部地址。

- 构建机 `sshd`：读 `/etc/ssh/sshd_config` 与 `/etc/ssh/sshd_config.d/`；`man 5 sshd_config`
  的 `GatewayPorts` 段（「The default is no.」）。
- `GatewayPorts` 的运行时确认：读进程表看到常驻 Mac 上已有的 `-R` 长跑，在构建机上用
  `ss -ltn` 看到对应端口落在 `127.0.0.1` / `[::1]`。
- republisher 清单：逐个 `command -v`；`nginx -V` 的编译参数。
- 公网可达性：构建机 `ip addr`（只有 RFC1918 与 `fd00::/8` ULA）、`ip route`；
  常驻 Mac 的 `~/.ssh/config`（只读其中的 `HostName`，未连接任何一台）。
- 失败诊断串：在构建机的 `ssh(1)` 二进制上 `strings`，OpenSSH 9.2p1。
- Mac 侧生产配置：`ps` 读进程表，未向任何进程发信号。
